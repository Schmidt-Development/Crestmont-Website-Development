// Scheduled jobs (Cloudflare Cron Triggers → worker `scheduled`). Each job is isolated: one failing
// job never stops the others, and every run is recorded in ingestion_status ("job:<name>") so the
// Readiness self-monitoring can show stale or failing automation instead of silently trusting it.
import type { Env } from "./context.ts";
import { buildContext } from "./app.ts";
import { nowIso } from "../lib/db.ts";
import { syncRequirements } from "../readiness/ingest.ts";
import { applySeedBlockerLinks } from "../services/readiness-admin.ts";
import { retryFailedStripeEvents } from "../services/payments.ts";
import { runSupportEscalationSweep } from "../services/support.ts";
import { runInactivitySweep } from "../services/projects.ts";
import { syncGithub } from "../services/github.ts";
import { refreshIntegrationHealth } from "../services/integrations.ts";
import { runCostImport } from "../services/cost-import.ts";
import { runStripeReconciliation } from "../services/stripe-reconcile.ts";
import { probeEnvironments } from "../services/deployments.ts";
import { runRetention } from "../services/retention.ts";

export type JobName = "requirements" | "stripe_reconcile" | "support_escalation" | "github_sync" | "inactivity" | "integration_health"
  | "stripe_side_reconcile" | "cost_import" | "env_probe" | "retention";

/** Cron expression → jobs. Must match [triggers] crons in wrangler.toml. */
export const SCHEDULE: Record<string, JobName[]> = {
  "*/15 * * * *": ["stripe_reconcile", "support_escalation", "github_sync", "env_probe"],
  "17 11 * * *": ["requirements", "inactivity", "integration_health", "stripe_side_reconcile", "cost_import", "retention"],
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
        case "stripe_reconcile": detail = `${await retryFailedStripeEvents(ctx)} stored events retried`; break;
        case "support_escalation": { const r = await runSupportEscalationSweep(ctx); detail = `${r.flagged} of ${r.checked} tickets flagged${r.note ? ` (${r.note})` : ""}`; break; }
        case "github_sync": {
          if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) { detail = "skipped: GitHub source not configured"; break; }
          const r = await syncGithub(ctx, null);
          detail = JSON.stringify(r).slice(0, 300);
          break;
        }
        case "inactivity": detail = `${(await runInactivitySweep(ctx)).length} inactivity actions`; break;
        case "integration_health": detail = `${(await refreshIntegrationHealth({ db: ctx.db, env, storage: ctx.storage })).length} integration rows refreshed`; break;
        // PAY-009: read-only comparison with Stripe; findings for human review, never marks anything paid.
        case "stripe_side_reconcile": detail = (await runStripeReconciliation(ctx.db, env)).detail; break;
        // FIN-002: AI usage + Stripe fees → project_costs, each source imported once.
        case "cost_import": detail = (await runCostImport(ctx.db, env)).detail; break;
        // READY-006 / LAUNCH-003: DNS/TLS/health probe of configured environment URLs (skips when none set).
        case "env_probe": detail = (await probeEnvironments(ctx)).map((o) => `${o.environment}: ${o.detail}`).join("; "); break;
        // SEC-006: always purges expired operational data; personal-data periods only when staff set them.
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
  const jobs = SCHEDULE[controller.cron];
  if (!jobs) { console.error(JSON.stringify({ level: "error", message: `No jobs for cron ${controller.cron}` })); return; }
  const results = await runJobs(env, jobs);
  console.log(JSON.stringify({ level: "info", cron: controller.cron, results }));
}
