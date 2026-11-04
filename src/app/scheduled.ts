// Scheduled jobs (Cloudflare Cron Triggers → worker `scheduled`). Each job is isolated: one failing
// job never stops the others, and every run is recorded in ingestion_status ("job:<name>") so the
// Readiness self-monitoring can show stale or failing automation instead of silently trusting it.
import { configureErasureKeysFromEnv } from "../services/contact-identity.ts";
import type { Env } from "./context.ts";
import { buildContext } from "./app.ts";
import { nowIso } from "../lib/db.ts";
import { syncRequirements } from "../readiness/ingest.ts";
import { applySeedBlockerLinks } from "../services/readiness-admin.ts";
import { retryFailedStripeEvents, stripeEventCtx, repairPaidInvoicesWithoutProject } from "../services/payments.ts";
import { retryQueuedEmails } from "../services/email-retry.ts";
import { runSupportEscalationSweep } from "../services/support.ts";
import { runInactivitySweep, runReviewDeadlineSweep } from "../services/projects.ts";
import { syncGithub } from "../services/github.ts";
import { refreshIntegrationHealth } from "../services/integrations.ts";
import { runCostImport } from "../services/cost-import.ts";
import { runStripeReconciliation, runStripeLedgerReconciliation } from "../services/stripe-reconcile.ts";
import { probeEnvironments } from "../services/deployments.ts";
import { runRetention } from "../services/retention.ts";
import { sweepBuilds } from "../services/builds.ts";
import { processOutboundQueue } from "../services/voice-outbound.ts";
import { runOpsAlerts } from "../services/monitoring.ts";
import { runAutoPromotion } from "../services/research-promote.ts";
import { runSalesOpt } from "../services/sales-opt/monitor.ts";
import { processSalesQueue } from "../services/sales-outbound.ts";

export type JobName = "requirements" | "stripe_reconcile" | "support_escalation" | "github_sync" | "inactivity" | "integration_health"
  | "stripe_side_reconcile" | "stripe_ledger_reconcile" | "cost_import" | "env_probe" | "retention" | "build_sweep" | "payment_repair" | "email_retry" | "voice_outbound" | "sales_outbound" | "sales_opt" | "research_promote" | "ops_alerts";

/**
 * Cron expression → jobs. Must match [triggers] crons in wrangler.toml. ops_alerts runs last so it sees this run's
 * results.
 *
 * `research_promote` has a minute of its own and is the ONLY job on it. It used to sit eleventh of twelve in the
 * quarter-hourly set, which cost it twice: it ran four times an hour, and each time it inherited whatever wall clock
 * the ten jobs before it had left — measured on staging it placed 12-13 leads where the same code placed 20-36 when
 * asked directly. A target stated in leads per minute cannot be met by a job that runs every fifteen minutes behind
 * a queue, so it gets its own tick. Its own lease stops one run overlapping the next
 * (src/services/research-promote.ts), and it is cheap when there is nothing to do: with the Owner's switch off, or
 * the backlog empty, the tick is two queries and no writes.
 *
 * Every other job keeps exactly the frequency it had.
 */
export const SCHEDULE: Record<string, JobName[]> = {
  "* * * * *": ["research_promote"],
  "*/15 * * * *": ["stripe_reconcile", "payment_repair", "email_retry", "support_escalation", "github_sync", "env_probe", "build_sweep", "voice_outbound", "sales_outbound", "sales_opt", "ops_alerts"],
  "17 11 * * *": ["requirements", "inactivity", "integration_health", "stripe_side_reconcile", "stripe_ledger_reconcile", "cost_import", "retention"],
};

export async function runJobs(env: Env, jobs: JobName[]): Promise<Record<string, { ok: boolean; detail: string }>> {
  const ctx = await buildContext(new Request(env.APP_URL ?? "https://scheduled.invalid/"), env);
  const results: Record<string, { ok: boolean; detail: string }> = {};
  for (const job of jobs) {
    const at = nowIso();
    try {
      let detail: string;
      switch (job) {
        case "requirements": { const r = await syncRequirements(ctx.db); const l = await applySeedBlockerLinks(ctx.db); detail = `${r.upserted} requirements synced, ${l} blocker links applied`; break; }
        case "stripe_reconcile": detail = `${await retryFailedStripeEvents(stripeEventCtx(ctx, env))} stored events retried`; break;
        // CREST-GAP-006: paid full/deposit invoices without a project get their idempotent follow-ups.
        case "payment_repair": { const r = await repairPaidInvoicesWithoutProject(ctx); detail = `${r.repaired} of ${r.checked} paid invoices without a project repaired${r.failed ? `, ${r.failed} failed` : ""}`; if (r.failed) throw new Error(detail); break; }
        // CREST-GAP-035: queued Resend deliveries retried with backoff; stuck count reported.
        case "email_retry": { const r = await retryQueuedEmails(ctx); detail = r.detail; break; }
        case "support_escalation": { const r = await runSupportEscalationSweep(ctx); detail = `${r.flagged} of ${r.checked} tickets flagged${r.note ? ` (${r.note})` : ""}`; break; }
        case "github_sync": {
          if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) { detail = "skipped: GitHub source not configured"; break; }
          const r = await syncGithub(ctx, null);
          detail = JSON.stringify(r).slice(0, 300);
          break;
        }
        // FD-14/FD-15: overdue customer reviews are reminded, never approved.
        case "inactivity": detail = `${(await runInactivitySweep(ctx)).length} inactivity actions; ${await runReviewDeadlineSweep(ctx)} overdue reviews reminded`; break;
        case "integration_health": detail = `${(await refreshIntegrationHealth({ db: ctx.db, env, storage: ctx.storage })).length} integration rows refreshed`; break;
        // PAY-009: read-only comparison with Stripe; findings for human review, never marks anything paid.
        case "stripe_side_reconcile": detail = (await runStripeReconciliation(ctx.db, env)).detail; break;
        // PAY-009: Stripe Invoices, balance transactions and payouts vs local records (read-only).
        case "stripe_ledger_reconcile": detail = (await runStripeLedgerReconciliation(ctx.db, env)).detail; break;
        // FIN-002: AI usage + Stripe fees → project_costs, each source imported once.
        case "cost_import": detail = (await runCostImport(ctx.db, env)).detail; break;
        // READY-006 / LAUNCH-003: DNS/TLS/health probe of configured environment URLs (skips when none set).
        case "env_probe": detail = (await probeEnvironments(ctx)).map((o) => `${o.environment}: ${o.detail}`).join("; "); break;
        // SEC-006: always purges expired operational data; personal-data periods only when staff set them.
        // AI Builds: expired runner leases, lost enqueues and newly ineligible orders.
        case "build_sweep": detail = await sweepBuilds(ctx.db); break;
        // Outbound calls (VOICE-003): no-op ("skipped: outbound disabled") until RETELL_OUTBOUND=on AND the Owner enables it.
        case "voice_outbound": detail = (await processOutboundQueue({ db: ctx.db, env, fetch: env.overrides?.fetch ?? fetch, now: env.overrides?.now })).detail; break;
        // Outbound AI sales calls: off unless RETELL_SALES_OUTBOUND, the Owner switch and a compliance approval are all on.
        case "sales_outbound": detail = (await processSalesQueue({ db: ctx.db, env, fetch: env.overrides?.fetch ?? fetch, now: env.overrides?.now })).detail; break;
        // SALESOPT-001..009: attribution, analysis/evaluation/proposal jobs for the self-hosted model, safety monitoring.
        // Never dials and never deploys except an automatic rollback to a previously verified version on a safety breach.
        case "sales_opt": detail = await runSalesOpt({ db: ctx.db, env, fetch: env.overrides?.fetch ?? fetch, now: env.overrides?.now }); break;
        // CREST-GAP-015/-089/-024: Owner emails (critical_incident) for dead-lettered Stripe events, new reconciliation findings,
        // a stuck email queue, failing evidence feeds and security-event bursts; deduplicated per item/window (ops_alerts).
        // Research -> CRM promotion. Bounded and resumable: it promotes one batch of eligible prospects through the
        // CRM intake engine and stops, so the next tick continues a backlog drain rather than one unbounded write. It
        // does nothing until the Owner turns automatic promotion on, and it is deliberately NOT gated on the research
        // pause: pausing stops new research, while prospects already on file still have to reach the CRM.
        case "research_promote": {
          // 40 seconds of a 60-second tick. It is a WALL budget, not a CPU one: a promotion spends its time waiting
          // on D1, and Cloudflare's limit for a sub-hourly Cron Trigger is 30 s of CPU, which this is nowhere near
          // (measured: ~2 ms of compute per promotion). Leaving 20 s spare means a slow minute finishes inside its
          // own tick instead of handing the lease to the next one.
          const r = await runAutoPromotion(ctx.db, { trigger: "scheduled", budgetMs: 40_000 });
          detail = r.stoppedReason === "disabled" ? `off (Owner has not enabled automatic CRM promotion); ${r.remaining} eligible and waiting`
            : r.stoppedReason === "locked" ? `skipped: the previous run still holds the promotion lease; ${r.remaining} remaining`
            : `${r.examined} examined: ${r.promoted} new CRM leads, ${r.existingCrm} existing, ${r.review} to review, ${r.suppressed} suppressed, ${r.rejected} rejected, ${r.failed} failed; ${r.remaining} remaining in ${r.durationMs} ms at concurrency ${r.concurrency} (${r.stoppedReason})`;
          break;
        }
        case "ops_alerts": { const r = await runOpsAlerts(ctx); detail = `${r.raised} new of ${r.checked} alert items; ${r.emailed} emails to ${r.recipients} owner(s)${r.categories.length ? ` (${r.categories.join(", ")})` : ""}`; break; }
        case "retention": detail = (await runRetention({ db: ctx.db, storage: ctx.storage })).map((r) => `${r.category}:${r.mode === "skipped" ? "off" : r.affected}`).join(", "); break;
      }
      results[job] = { ok: true, detail };
      await record(env, job, at, null);
    } catch (e) {
      results[job] = { ok: false, detail: (e as Error).message };
      await record(env, job, at, (e as Error).message);
    }
  }
  return results;
}

async function record(env: Env, job: string, at: string, error: string | null) {
  await env.DB.prepare(
    `INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       last_success_at = COALESCE(excluded.last_success_at, ingestion_status.last_success_at)`,
  ).bind(`job:${job}`, error ? null : at, at, error ? error.slice(0, 1000) : null).run();
}

export async function scheduled(controller: { cron: string }, env: Env): Promise<void> {
  configureErasureKeysFromEnv(env);
  const jobs = SCHEDULE[controller.cron];
  if (!jobs) { console.error(JSON.stringify({ level: "error", message: `No jobs for cron ${controller.cron}` })); return; }
  const at = nowIso();
  try {
    const results = await runJobs(env, jobs);
    await record(env, "_invocation", at, null);
    console.log(JSON.stringify({ level: "info", cron: controller.cron, results }));
  } catch (e) {
    // Setup failed before any job could record itself (e.g. building the context): leave a visible trace.
    await record(env, "_invocation", at, `${controller.cron}: ${(e as Error).message}`).catch(() => {});
    console.error(JSON.stringify({ level: "error", cron: controller.cron, message: (e as Error).message }));
    throw e;
  }
}
