// Integration health (§36, §61, INFRA-002, EMAIL-001). Status is derived from real configuration
// checks of the running environment and, for "verified", from a successful read-only probe call
// to the provider. Nothing is ever marked verified without a successful call; a probe failure is
// recorded as "failing" with the provider's error. Secrets are never stored or displayed — only
// a short SHA-256 fingerprint, used to notice when a key changes so stale verification is dropped.
import { retellKey, keysAmbiguous } from "../adapters/retell-workspaces.ts";
import { STRIPE_API_VERSION, SUPPORTED_WEBHOOK_API_VERSIONS } from "../adapters/payments.ts";
import { paymentsMode, keyMode } from "../domain/payments-mode.ts";
import { STRIPE_WEBHOOK_EVENTS } from "../domain/stripe-events.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Env } from "../app/context.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { audit } from "./security.ts";
import { aiProviderFromEnv, LOCAL_RUNNER } from "./ai.ts";
import { receptionistStatus } from "./receptionist-status.ts";

export const INTEGRATIONS = [
  { id: "stripe", label: "Stripe (payments)", blocker: "BLK-004" },
  { id: "resend", label: "Resend (email + domain authentication)", blocker: "BLK-005" },
  { id: "auth", label: "Authentication (in-platform)", blocker: null },
  { id: "database", label: "Database (D1 / SQLite)", blocker: "BLK-003" },
  { id: "object_storage", label: "Object storage (R2)", blocker: "BLK-003" },
  { id: "ai", label: "AI provider (self-hosted or Anthropic)", blocker: null },
  { id: "voice", label: "AI receptionist (Retell inbound)", blocker: "BLK-009" },
  { id: "telephony", label: "Receptionist phone number", blocker: "BLK-009" },
  { id: "monitoring", label: "External monitoring & alerting", blocker: "BLK-003" },
  { id: "dns", label: "DNS (crestmontwebsitedevelopment.com)", blocker: "BLK-011" },
  { id: "github", label: "GitHub repository", blocker: null },
  { id: "turnstile", label: "Cloudflare Turnstile (bot defence)", blocker: "BLK-003" },
  { id: "retell", label: "Retell AI webhooks (voice receptionist)", blocker: "BLK-009" },
  { id: "retell_outbound", label: "Retell outbound (AI sales calls)", blocker: "BLK-009" },
  { id: "resend_webhooks", label: "Resend delivery webhooks (bounces, complaints)", blocker: "BLK-005" },
  { id: "bindings", label: "Environment bindings and secrets (this environment)", blocker: null },
] as const;
export type IntegrationId = (typeof INTEGRATIONS)[number]["id"];
export type HealthStatus = "not_configured" | "configured_unverified" | "verified" | "degraded" | "failing" | "blocked";
export const ENVIRONMENTS = ["development", "staging", "production"] as const;

export interface HealthRow { integration: string; environment: string; status: HealthStatus; detail: string | null; checked_at: string }
export interface Assessment { status: HealthStatus; detail: string; fingerprint: string | null; probe: boolean }

export const OFFICIAL_DOMAIN = "crestmontwebsitedevelopment.com";

export interface IntegrationDeps { db: Db; env: Env; storage: StorageAdapter | null; fetchImpl?: typeof fetch }

const fp = async (s: string | undefined) => (s ? (await sha256Hex(s)).slice(0, 12) : null);

export function isIntegrationId(s: string): s is IntegrationId {
  return INTEGRATIONS.some((i) => i.id === s);
}

/** Configuration-only assessment (no network). `probe` = a verification probe exists for this state. */
export async function assessConfiguration(d: IntegrationDeps, id: IntegrationId): Promise<Assessment> {
  const e = d.env;
  switch (id) {
    case "stripe": {
      const k = e.STRIPE_SECRET_KEY;
      if (!k) return { status: "not_configured", detail: "STRIPE_SECRET_KEY is not set. Online payment is not available.", fingerprint: null, probe: false };
      // CREST-GAP-007/008: the key must match this environment's expected mode (production: live behind the Founder flag).
      const pm = paymentsMode(e);
      if (pm.mode === "none") return { status: "blocked", detail: `${keyMode(k) === "test" ? "A test-mode" : "A non-test"} Stripe key is set and refused here: ${pm.reason} Live payments are not authorised (PAY-010) unless this is production with the Founder flag.`, fingerprint: await fp(k), probe: false };
      const wh = e.STRIPE_WEBHOOK_SECRET ? "Webhook secret set." : "STRIPE_WEBHOOK_SECRET is not set — webhooks will be rejected.";
      return { status: "configured_unverified", detail: `${pm.mode === "live" ? "Live-mode key set (Founder-authorised)." : "Test-mode key set."} ${wh} Run the probe to verify.`, fingerprint: await fp(k + "|" + (e.STRIPE_WEBHOOK_SECRET ?? "")), probe: true };
    }
    case "resend": {
      if (!e.RESEND_API_KEY) return { status: "not_configured", detail: "RESEND_API_KEY is not set. Email is captured in the development outbox only; nothing is delivered and no sending domain is authenticated.", fingerprint: null, probe: false };
      const note = e.ENVIRONMENT === "development" ? " (development still uses the outbox adapter)" : "";
      return { status: "configured_unverified", detail: `API key set${note}. Domain authentication unknown until the probe lists a verified domain.`, fingerprint: await fp(e.RESEND_API_KEY), probe: true };
    }
    case "auth":
      return { status: "configured_unverified", detail: "In-platform password + TOTP authentication. Run the check to confirm an Owner account with MFA exists.", fingerprint: "in-platform", probe: true };
    case "database":
      return { status: "configured_unverified", detail: "Database binding present. Run the check (SELECT 1).", fingerprint: "db", probe: true };
    case "object_storage": {
      if (!d.storage) return { status: "not_configured", detail: "No FILES bucket binding. File uploads are unavailable.", fingerprint: null, probe: false };
      if (d.storage.kind === "local-disk") return { status: "configured_unverified", detail: "Development local-disk adapter (not R2). Probe writes, reads and deletes a small health object.", fingerprint: "local-disk", probe: true };
      return { status: "configured_unverified", detail: "R2 bucket bound. Probe writes, reads and deletes a small health object.", fingerprint: "r2", probe: true };
    }
    case "ai": {
      // ENV-06: report the backend that is actually SELECTED (aiProviderFromEnv), not Anthropic by default.
      // Crestmont runs a self-hosted model on Node 1, so demanding ANTHROPIC_API_KEY would report a healthy
      // platform as broken — and would invite paying for inference nobody asked for.
      if (e.AI_PROVIDER === LOCAL_RUNNER) {
        if (!e.BUILD_RUNNER_SECRET) return { status: "not_configured", detail: "AI_PROVIDER=local-runner is selected but BUILD_RUNNER_SECRET is not set, so the runner cannot authenticate and no draft can be produced.", fingerprint: null, probe: false };
        return { status: "configured_unverified", detail: `Self-hosted runner selected (AI_PROVIDER=local-runner); no paid API is used. Probe reads the runner's last heartbeat — it never starts a build.`, fingerprint: await fp(`local-runner|${e.BUILD_RUNNER_SECRET}`), probe: true };
      }
      if (e.AI_PROVIDER === "anthropic") {
        if (!e.ANTHROPIC_API_KEY) return { status: "not_configured", detail: "AI_PROVIDER=anthropic is selected but ANTHROPIC_API_KEY is not set; AI drafting jobs fail with not_configured.", fingerprint: null, probe: false };
        return { status: "configured_unverified", detail: `Anthropic selected (AI_PROVIDER=anthropic); model ${e.AI_MODEL ?? "default"}. Paid calls also need the Owner's monthly AI budget. Probe lists models.`, fingerprint: await fp(e.ANTHROPIC_API_KEY), probe: true };
      }
      const key = e.ANTHROPIC_API_KEY ? " An ANTHROPIC_API_KEY is present but unused, so no paid call can be made." : "";
      return { status: "not_configured", detail: `No AI backend is selected: AI_PROVIDER is ${e.AI_PROVIDER ? `"${e.AI_PROVIDER}"` : "unset"}. AI drafting is off.${key}`, fingerprint: null, probe: false };
    }
    case "voice": {
      // The receptionist runs on Retell (Founder decision). Status from its real sources: src/services/receptionist-status.ts.
      const r = await receptionistStatus(d.db, e);
      return { status: r.provider.state, detail: r.provider.detail, fingerprint: `voice:${r.provider.state}:${r.lastRealCallAt ?? ""}`, probe: false };
    }
    case "telephony": {
      const r = await receptionistStatus(d.db, e);
      return { status: r.phone.state, detail: r.phone.detail, fingerprint: `phone:${r.phone.state}:${r.lastRealCallAt ?? ""}`, probe: false };
    }
    case "monitoring": {
      // Alert routing exists: the ops_alerts job (every 15 minutes) emails the internal operations mailbox about
      // dead-lettered payment events, new payment discrepancies, a stuck email queue and failing feeds. What does not
      // exist is an EXTERNAL uptime monitor: if the whole platform is down, nothing inside it can send an alert.
      const job = await d.db.prepare(`SELECT last_success_at, last_attempt_at, last_error FROM ingestion_status WHERE source = 'job:ops_alerts'`).first<{ last_success_at: string | null; last_attempt_at: string | null; last_error: string | null }>();
      const noExternal = "No external uptime monitor is configured, so a full outage of the platform would not alert anyone.";
      if (e.ENVIRONMENT === "development") return { status: "configured_unverified", detail: `Operations alerts are built in (scheduled job ops_alerts, emailed to the internal mailbox); development runs no scheduler. ${noExternal}`, fingerprint: "monitoring:dev", probe: false };
      if (!job?.last_attempt_at) return { status: "failing", detail: `The scheduled operations-alert job has never run in ${e.ENVIRONMENT}: check the cron trigger. ${noExternal}`, fingerprint: "monitoring:never", probe: false };
      const ageMin = Math.round((Date.now() - Date.parse(job.last_attempt_at)) / 60_000);
      if (job.last_error) return { status: "failing", detail: `The last operations-alert run failed (${job.last_error.slice(0, 160)}). ${noExternal}`, fingerprint: `monitoring:err:${job.last_attempt_at}`, probe: false };
      if (ageMin > 60) return { status: "failing", detail: `The operations-alert job last ran ${ageMin} minutes ago (it should run every 15): the scheduler may have stopped. ${noExternal}`, fingerprint: `monitoring:stale:${job.last_attempt_at}`, probe: false };
      return { status: "configured_unverified", detail: `Operations alerts run every 15 minutes and email the internal mailbox (last run ${ageMin} minute${ageMin === 1 ? "" : "s"} ago). ${noExternal}`, fingerprint: `monitoring:ok`, probe: false };
    }
    case "dns":
      return { status: "not_configured", detail: `No DNS provider access is configured (BLK-011). The probe can check public resolution of ${OFFICIAL_DOMAIN}, which does not prove control.`, fingerprint: null, probe: true };
    case "github": {
      if (e.GITHUB_TOKEN && e.GITHUB_REPO) return { status: "configured_unverified", detail: `Repository ${e.GITHUB_REPO}. Probe reads repository metadata with the Worker's read-only token.`, fingerprint: await fp(e.GITHUB_TOKEN + "|" + e.GITHUB_REPO), probe: true };
      // The staging Worker deliberately holds no GitHub token: the deploy workflow PUSHES a snapshot with its own
      // read-only token instead. A recent successful push is real, current repository access, so report it as such
      // rather than claiming the source is not configured (ENV-07).
      const push = await d.db.prepare(`SELECT repo, fetched_at FROM github_sync WHERE ok = 1 AND source = 'push' ORDER BY fetched_at DESC LIMIT 1`)
        .first<{ repo: string; fetched_at: string }>().catch(() => null);
      if (push) {
        const ageH = (Date.now() - Date.parse(push.fetched_at)) / 3_600_000;
        return ageH <= 72
          ? { status: "verified", detail: `Repository ${push.repo} read by GitHub Actions with its read-only workflow token; snapshot pushed ${push.fetched_at}. No token is held by this Worker.`, fingerprint: await fp(`push|${push.repo}`), probe: false }
          : { status: "degraded", detail: `The last pushed snapshot of ${push.repo} is ${Math.round(ageH)} h old (${push.fetched_at}); it refreshes on each staging deploy. No GITHUB_TOKEN on this Worker for a server-side pull.`, fingerprint: await fp(`push|${push.repo}`), probe: false };
      }
      return { status: "not_configured", detail: "No GITHUB_TOKEN/GITHUB_REPO on this Worker and no snapshot has been pushed by GitHub Actions, so the readiness dashboard cannot read repository data.", fingerprint: null, probe: false };
    }
    case "turnstile":
      if (!e.TURNSTILE_SECRET || !e.TURNSTILE_SITE_KEY) {
        const dev = e.ENVIRONMENT === "development" ? " Development accepts public forms without a challenge; other environments fail closed." : " Public forms fail closed (bot check refused).";
        return { status: "not_configured", detail: `TURNSTILE_SECRET / TURNSTILE_SITE_KEY not set.${dev}`, fingerprint: null, probe: false };
      }
      return { status: "configured_unverified", detail: "Turnstile keys set. Probe confirms the secret is accepted by siteverify.", fingerprint: await fp(e.TURNSTILE_SECRET), probe: true };
    case "retell":
    {
      // Two workspaces (src/adapters/retell-workspaces.ts). This row is the receptionist's (inbound) key; the sales
      // workspace key is reported alongside. Only names and presence are shown, never values.
      const inb = retellKey(e, "inbound"), out = retellKey(e, "outbound");
      const legacy = e.RETELL_API_KEY ? " RETELL_API_KEY is also set but is no longer read; remove it to avoid confusion." : "";
      const sales = `Sales workspace key (RETELL_OUTBOUND_API_KEY): ${out ? "set" : "not set"}.`;
      if (keysAmbiguous(e)) return { status: "not_configured", detail: "RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical, so the workspace of a request cannot be told apart: every Retell request is refused. Set each to its own workspace's key.", fingerprint: null, probe: false };
      if (!inb) return { status: "not_configured", detail: `RETELL_INBOUND_API_KEY is not set; the receptionist's Retell routes (/api/webhooks/retell/functions, /api/webhooks/retell/inbound) reject every request. ${sales}${legacy}`, fingerprint: null, probe: false };
      const rs = await receptionistStatus(d.db, e);
      const follow = ` Follow-up calling: ${e.RETELL_OUTBOUND === "on" ? "environment switch on (the Owner setting must also be on)" : "off (RETELL_OUTBOUND not on)"}.`;
      return { status: rs.webhooks.state === "not_configured" ? "configured_unverified" : rs.webhooks.state, detail: `Receptionist workspace key (RETELL_INBOUND_API_KEY) set. ${rs.webhooks.detail} ${sales}${follow}${legacy}`, fingerprint: `${await fp(inb)}:${rs.webhooks.state}`, probe: false };
    }
    case "retell_outbound": {
      // The sales workspace (src/services/sales-outbound.ts). Verified only by a passing read-only audit of the live
      // sales agent or a real signed sales call recorded in this environment.
      if (keysAmbiguous(e)) return { status: "failing", detail: "RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical: the sales and receptionist workspaces cannot be told apart, so every Retell request is refused.", fingerprint: null, probe: false };
      const out = retellKey(e, "outbound");
      if (!out) return { status: "not_configured", detail: "RETELL_OUTBOUND_API_KEY (the sales workspace key) is not set: AI sales calls and scheduled AI callbacks cannot be placed or verified here.", fingerprint: null, probe: false };
      const audit = await d.db.prepare(`SELECT created_at, details_json FROM audit_logs WHERE action = 'sales_outbound.retell_audit' ORDER BY created_at DESC LIMIT 1`).first<{ created_at: string; details_json: string | null }>();
      let st: string | null = null;
      try { st = audit ? String((JSON.parse(audit.details_json ?? "{}") as { status?: string }).status ?? "") : null; } catch { st = null; }
      const env = e.ENVIRONMENT === "production" ? "production" : e.ENVIRONMENT === "staging" ? "staging" : "development";
      const calls = (await d.db.prepare(`SELECT COUNT(*) AS n FROM sales_calls WHERE provider_call_id IS NOT NULL AND is_test = 0 AND finalized_at >= ?`).bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).first<{ n: number }>())?.n ?? 0;
      const fpv = `${await fp(out)}:${st ?? ""}:${calls}`;
      if (st === "issues" || st === "failed") return { status: "failing", detail: `The last read-only audit of the live sales agent (${audit!.created_at.slice(0, 10)}) found problems. Calls are still re-checked by the compliance gate before every dial.`, fingerprint: fpv, probe: false };
      if (st === "ok") return { status: "verified", detail: `Sales workspace key set; the live sales agent passed the read-only audit on ${audit!.created_at.slice(0, 10)} in ${env}.`, fingerprint: fpv, probe: false };
      if (calls) return { status: "verified", detail: `Sales workspace key set; ${calls} real sales call(s) completed with signed Retell events in the last 30 days.`, fingerprint: fpv, probe: false };
      return { status: "configured_unverified", detail: `Sales workspace key set in ${env}, but no live audit has passed and no real sales call has completed here. Run the outbound Retell audit to verify.`, fingerprint: fpv, probe: false };
    }
    case "bindings": {
      // What THIS Worker has bound, read from its own environment (presence only; each integration row checks its value).
      const env = e.ENVIRONMENT;
      if (env === "development") return { status: "configured_unverified", detail: "Development uses local adapters (SQLite, local disk, development outbox); production bindings are not expected here.", fingerprint: "bindings:dev", probe: false };
      const need: [string, boolean][] = [
        ["D1 database (DB)", !!d.db], ["R2 file storage (FILES)", !!d.storage && d.storage.kind !== "local-disk"],
        ["APP_URL (https)", !!e.APP_URL && /^https:\/\//.test(e.APP_URL)], ["SCHEDULER_TRIGGER_SECRET", !!e.SCHEDULER_TRIGGER_SECRET],
        ["STRIPE_SECRET_KEY", !!e.STRIPE_SECRET_KEY], ["STRIPE_WEBHOOK_SECRET", !!e.STRIPE_WEBHOOK_SECRET],
        ["RESEND_API_KEY", !!e.RESEND_API_KEY], ["RESEND_WEBHOOK_SECRET", !!e.RESEND_WEBHOOK_SECRET],
        ["RETELL_INBOUND_API_KEY", !!retellKey(e, "inbound")], ["TURNSTILE_SECRET and TURNSTILE_SITE_KEY", !!e.TURNSTILE_SECRET && !!e.TURNSTILE_SITE_KEY],
      ];
      const missing = need.filter(([, ok]) => !ok).map(([n]) => n);
      const fpb = `bindings:${missing.join(",")}`;
      if (!missing.length) return { status: "verified", detail: `All ${need.length} required bindings and secrets are present in this ${env} Worker (presence read from the Worker itself; values are checked by each integration's own row). Staging results never prove production.`, fingerprint: fpb, probe: false };
      return { status: "degraded", detail: `Missing in this ${env} Worker: ${missing.join(", ")}. Present: ${need.filter(([, ok]) => ok).map(([n]) => n).join(", ") || "none"}. Staging and production are configured separately.`, fingerprint: fpb, probe: false };
    }
    case "resend_webhooks":
      if (!e.RESEND_WEBHOOK_SECRET) return { status: "not_configured", detail: "RESEND_WEBHOOK_SECRET is not set; /api/webhooks/resend rejects every request, so bounces and complaints are not recorded.", fingerprint: null, probe: false };
    {
      // Rows are written only after the Svix signature verified (routes/hooks.ts), so a recent event for THIS
      // environment ("ignored" = another environment's mail) is proof the webhook path works end to end. This row used
      // to stay "unverified" forever while the Resend row counted the very deliveries these events confirmed.
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const ev = await d.db.prepare(`SELECT COUNT(*) AS n, MAX(received_at) AS last FROM email_webhook_events WHERE outcome <> 'ignored' AND received_at >= ?`).bind(since)
        .first<{ n: number; last: string | null }>().catch(() => null);
      const fpw = `${await fp(e.RESEND_WEBHOOK_SECRET)}:${ev?.n ?? 0}`;
      if (ev && ev.n > 0) return { status: "verified", detail: `Svix signing secret set; ${ev.n} signed Resend delivery event(s) received for this environment in the last 30 days (latest ${ev.last}). Bounces and complaints are recorded.`, fingerprint: fpw, probe: false };
      return { status: "configured_unverified", detail: "Svix signing secret set; signed Resend delivery events are accepted. Unverified until Resend delivers a real event.", fingerprint: fpw, probe: false };
    }
  }
}

async function readRow(db: Db, id: string, env: string) {
  return db.prepare(`SELECT integration, environment, status, detail, checked_at, config_fingerprint, verified_at FROM integration_health WHERE integration = ? AND environment = ?`)
    .bind(id, env).first<HealthRow & { config_fingerprint: string | null; verified_at: string | null }>();
}

async function writeRow(db: Db, id: string, env: string, status: HealthStatus, detail: string, fingerprint: string | null, verifiedAt: string | null) {
  await db.prepare(`INSERT INTO integration_health (integration, environment, status, detail, checked_at, config_fingerprint, verified_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(integration, environment) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at,
      config_fingerprint = excluded.config_fingerprint, verified_at = excluded.verified_at`)
    .bind(id, env, status, detail.slice(0, 1000), nowIso(), fingerprint, verifiedAt).run();
}

/**
 * Recompute configuration status for every integration in the current environment. A previous
 * probe result (verified/failing/degraded) is kept only while the configuration fingerprint is
 * unchanged; otherwise the row falls back to the configuration status.
 */
export async function refreshIntegrationHealth(d: IntegrationDeps): Promise<HealthRow[]> {
  const env = d.env.ENVIRONMENT;
  for (const i of INTEGRATIONS) {
    const a = await assessConfiguration(d, i.id);
    const prev = await readRow(d.db, i.id, env);
    const probed = prev && ["verified", "failing", "degraded"].includes(prev.status);
    if (probed && a.status === "configured_unverified" && prev!.config_fingerprint === a.fingerprint) continue;
    await writeRow(d.db, i.id, env, a.status, a.detail, a.fingerprint, null);
  }
  return listIntegrationHealth(d.db);
}

export async function listIntegrationHealth(db: Db): Promise<HealthRow[]> {
  return (await db.prepare(`SELECT integration, environment, status, detail, checked_at FROM integration_health ORDER BY integration, environment`).all<HealthRow>()).results;
}

export class ProbeUnavailable extends Error {}

async function jsonOrNull(r: Response): Promise<Record<string, unknown> | null> {
  try { return (await r.json()) as Record<string, unknown>; } catch { return null; }
}
/** What Resend actually did in the last 30 days, from the platform's own delivery records (real sends only). */
async function resendEvidence(db: IntegrationDeps["db"]): Promise<{ sent: number; delivered: number; lastError: string | null }> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const r = await db.prepare(`SELECT COALESCE(SUM(d.status = 'sent'), 0) AS sent, COALESCE(SUM(d.status IN ('delivered','bounced')), 0) AS delivered
      FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE m.provider = 'resend' AND d.updated_at >= ?`).bind(since).first<{ sent: number; delivered: number }>();
  const err = await db.prepare(`SELECT d.last_error FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE m.provider = 'resend' AND d.last_error LIKE 'Resend %' ORDER BY d.updated_at DESC LIMIT 1`).first<{ last_error: string }>();
  return { sent: r?.sent ?? 0, delivered: r?.delivered ?? 0, lastError: err?.last_error?.slice(0, 200) ?? null };
}

const providerError = (name: string, r: Response, body: Record<string, unknown> | null) => {
  const err = body?.error as { message?: string } | string | undefined;
  const msg = typeof err === "string" ? err : err?.message ?? (body?.message as string | undefined) ?? r.statusText ?? "error";
  return `${name} responded ${r.status}: ${String(msg).slice(0, 300)}`;
};

/**
 * Run a harmless, read-only verification call against the provider and record the result.
 * Returns the stored status. Throws ProbeUnavailable when the integration cannot be probed in its
 * current configuration (nothing is recorded in that case beyond the configuration status).
 */
export async function verifyIntegration(d: IntegrationDeps, id: IntegrationId, actorUserId: string | null): Promise<{ status: HealthStatus; detail: string }> {
  const f = d.fetchImpl ?? fetch;
  const env = d.env.ENVIRONMENT;
  const a = await assessConfiguration(d, id);
  if (!a.probe) {
    await writeRow(d.db, id, env, a.status, a.detail, a.fingerprint, null);
    throw new ProbeUnavailable(`${id}: no verification probe is available — ${a.detail}`);
  }
  let status: HealthStatus = "failing";
  let detail = "";
  try {
    switch (id) {
      case "stripe": {
        const r = await f("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${d.env.STRIPE_SECRET_KEY}`, "stripe-version": STRIPE_API_VERSION } });
        const b = await jsonOrNull(r);
        if (!r.ok) { detail = providerError("Stripe", r, b); break; }
        const live = paymentsMode(d.env).mode === "live";
        if (typeof b?.livemode === "boolean" && b.livemode !== live) { status = "blocked"; detail = b.livemode ? "Stripe reports livemode=true for this key; live payments are not authorised." : "Stripe reports livemode=false where live mode is expected."; break; }
        const modeLabel = live ? "live" : "test";
        // CREST-GAP-017: the webhook endpoint is registered by hand in the Stripe Dashboard; check it (read-only).
        const w = await f("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: { authorization: `Bearer ${d.env.STRIPE_SECRET_KEY}`, "stripe-version": STRIPE_API_VERSION } });
        const wb = await jsonOrNull(w);
        if (!w.ok) { detail = providerError("Stripe webhook endpoints", w, wb); break; }
        const v1 = (Array.isArray(wb?.data) ? wb!.data : []) as StripeWebhookEndpoint[];
        const problem = webhookEndpointProblem(v1, d.env.APP_URL);
        if (problem) {
          // Read-only context so a mismatch can be found without touching anything: which account this key belongs to,
          // every webhook endpoint it has, and its Workbench event destinations (thin-payload destinations are not
          // webhook endpoints, and this handler needs snapshot payloads).
          const key = d.env.STRIPE_SECRET_KEY!;
          const acctRes = await f("https://api.stripe.com/v1/account", { headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION } }).catch(() => null);
          const acct = acctRes?.ok ? await jsonOrNull(acctRes) : null;
          const dest = await f("https://api.stripe.com/v2/core/event_destinations?limit=20", { headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_V2_VERSION } }).catch(() => null);
          const destBody = dest ? await jsonOrNull(dest) : null;
          const destinations = dest?.ok && Array.isArray(destBody?.data) ? destBody!.data as StripeEventDestination[] : null;
          if (destinations && !eventDestinationProblem(destinations, d.env.APP_URL)) {
            status = "verified"; detail = `GET /v1/balance succeeded in ${modeLabel} mode; the event destination for ${webhookTarget(d.env.APP_URL)} is enabled with snapshot payloads at a supported API version and every handled event (requests pinned to ${STRIPE_API_VERSION}).`;
            break;
          }
          status = "degraded";
          detail = `GET /v1/balance succeeded in ${modeLabel} mode${typeof acct?.id === "string" ? ` for Stripe account ${acct.id}` : ""}, but ${problem} ${endpointInventory(v1, destinations, dest ? dest.status : null)}`;
          break;
        }
        const epVersion = webhookEndpointFor((Array.isArray(wb?.data) ? wb!.data : []) as StripeWebhookEndpoint[], d.env.APP_URL)?.api_version;
        status = "verified"; detail = `GET /v1/balance succeeded in ${modeLabel} mode; the webhook endpoint is enabled at API version ${epVersion} with every handled event (requests pinned to ${STRIPE_API_VERSION}).`;
        break;
      }
      case "resend": {
        const r = await f("https://api.resend.com/domains", { headers: { authorization: `Bearer ${d.env.RESEND_API_KEY}` } });
        const b = await jsonOrNull(r);
        // A key with "Sending access" only (least privilege, recommended) is refused on /domains with 401
        // restricted_api_key although it sends normally. That is not a failure: judge it by what Resend actually did.
        if (r.status === 401 && b?.name === "restricted_api_key") {
          const ev = await resendEvidence(d.db);
          if (ev.delivered > 0) { status = "verified"; detail = `Send-only API key (it cannot list domains, which is expected). Resend accepted ${ev.sent + ev.delivered} email(s) in the last 30 days and confirmed delivery of ${ev.delivered} through its delivery webhooks.`; }
          else if (ev.sent > 0) { status = "configured_unverified"; detail = `Send-only API key (it cannot list domains, which is expected). Resend accepted ${ev.sent} email(s) in the last 30 days, but no delivery has been confirmed yet: check that Resend delivery webhooks are set up.`; }
          else if (ev.lastError) { status = "degraded"; detail = `Send-only API key, but the last send attempt failed: ${ev.lastError}`; }
          else { status = "configured_unverified"; detail = "Send-only API key (it cannot list domains, which is expected). No email has been accepted by Resend in the last 30 days, so sending is not proven yet: send a permitted test email to the internal mailbox."; }
          break;
        }
        if (r.status === 401 || r.status === 403) { status = "failing"; detail = `Resend refused the API key (HTTP ${r.status}${typeof b?.message === "string" ? `: ${b.message.slice(0, 160)}` : ""}). The key is wrong, revoked, or from another Resend account: create a new key in Resend and update RESEND_API_KEY.`; break; }
        if (!r.ok) { detail = providerError("Resend", r, b); break; }
        const domains = (Array.isArray(b?.data) ? b!.data : []) as { name?: string; status?: string }[];
        const ok = domains.filter((x) => x.status === "verified").map((x) => x.name);
        const official = ok.includes(OFFICIAL_DOMAIN);
        if (official) { status = "verified"; detail = `API key valid; sending domain ${OFFICIAL_DOMAIN} is verified.`; }
        else {
          status = "degraded";
          detail = `API key valid, but ${OFFICIAL_DOMAIN} is not a verified sending domain (${domains.length ? domains.map((x) => `${x.name}: ${x.status}`).join(", ") : "no domains added"}).`;
        }
        break;
      }
      case "auth": {
        const owner = await d.db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN u.totp_secret IS NOT NULL THEN 1 ELSE 0 END) AS mfa FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL`).first<{ n: number; mfa: number | null }>();
        if (!owner?.n) { status = "configured_unverified"; detail = "No Owner account exists yet — run scripts/bootstrap-owner.ts and accept the invitation."; break; }
        if (!owner.mfa) { status = "degraded"; detail = "Owner account exists but has not enrolled MFA."; break; }
        status = "verified"; detail = "Owner account with MFA exists; sessions, lockout and TOTP are served in-platform.";
        break;
      }
      case "database": {
        const t0 = Date.now();
        const r = await d.db.prepare(`SELECT 1 AS ok`).first<{ ok: number }>();
        if (r?.ok !== 1) { detail = "SELECT 1 returned an unexpected result."; break; }
        status = "verified"; detail = `SELECT 1 succeeded in ${Date.now() - t0} ms (${env}).`;
        break;
      }
      case "object_storage": {
        const s = d.storage!;
        const key = `_health/probe-${Date.now()}.txt`;
        const payload = new TextEncoder().encode(`crestmont storage probe ${nowIso()}`);
        await s.put(key, payload, "text/plain");
        const got = await s.get(key);
        await s.delete(key);
        if (!got) { detail = "Wrote a probe object but could not read it back."; break; }
        status = "verified"; detail = `Write/read/delete probe succeeded (${s.kind}).`;
        break;
      }
      case "ai": {
        // ENV-06: the self-hosted runner is verified by its own heartbeat, never by starting a build and never by
        // a paid API call. build_runners.last_seen_at is written by Node 1 each time it polls for work.
        if (d.env.AI_PROVIDER === LOCAL_RUNNER) {
          const seen = await d.db.prepare(`SELECT runner_id, version, last_seen_at FROM build_runners ORDER BY last_seen_at DESC LIMIT 1`)
            .first<{ runner_id: string; version: string | null; last_seen_at: string }>().catch(() => null);
          if (!seen) { status = "configured_unverified"; detail = "No runner has ever polled this environment, so the self-hosted model is unproven here. Install and start the runner on Node 1; it then appears automatically."; break; }
          const ageMin = Math.round((Date.now() - Date.parse(seen.last_seen_at)) / 60_000);
          if (ageMin > 60) { status = "degraded"; detail = `Runner ${seen.runner_id} last polled ${ageMin} min ago (${seen.last_seen_at}); it is not currently connected.`; break; }
          status = "verified"; detail = `Self-hosted runner ${seen.runner_id}${seen.version ? ` (${seen.version})` : ""} polled ${ageMin} min ago. No paid API is used.`;
          break;
        }
        if (d.env.AI_PROVIDER !== "anthropic" || !d.env.ANTHROPIC_API_KEY) { detail = "No AI backend is selected, so there is nothing to probe."; break; }
        const r = await f("https://api.anthropic.com/v1/models?limit=5", { headers: { "x-api-key": d.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
        const b = await jsonOrNull(r);
        if (!r.ok) { detail = providerError("Anthropic", r, b); break; }
        status = "verified"; detail = "Models list returned successfully.";
        break;
      }
      case "github": {
        if (!d.env.GITHUB_TOKEN || !d.env.GITHUB_REPO) { detail = "No Worker token: repository access is evidenced by the snapshot GitHub Actions pushes, not by a probe from here."; break; }
        const repo = d.env.GITHUB_REPO;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { detail = "GITHUB_REPO must be owner/name."; break; }
        const r = await f(`https://api.github.com/repos/${repo}`, { headers: { authorization: `Bearer ${d.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "crestmont-platform" } });
        const b = await jsonOrNull(r);
        if (!r.ok) { detail = providerError("GitHub", r, b); break; }
        status = "verified"; detail = `Repository ${String(b?.full_name ?? repo)} readable${b?.private ? " (private)" : ""}.`;
        break;
      }
      case "turnstile": {
        const form = new FormData();
        form.set("secret", d.env.TURNSTILE_SECRET!);
        form.set("response", "crestmont-health-probe");
        const r = await f("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
        const b = await jsonOrNull(r);
        const codes = (b?.["error-codes"] ?? []) as string[];
        if (!r.ok) { detail = providerError("Turnstile", r, b); break; }
        if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) { detail = `Turnstile rejected the secret (${codes.join(", ")}).`; break; }
        status = "verified"; detail = "siteverify accepted the secret (probe token correctly rejected).";
        break;
      }
      case "dns": {
        const r = await f(`https://cloudflare-dns.com/dns-query?name=${OFFICIAL_DOMAIN}&type=NS`, { headers: { accept: "application/dns-json" } });
        const b = await jsonOrNull(r);
        if (!r.ok) { detail = providerError("DNS-over-HTTPS", r, b); break; }
        const answers = ((b?.Answer ?? []) as { data?: string }[]).map((x) => x.data).filter(Boolean);
        if (b?.Status !== 0 || !answers.length) { detail = `${OFFICIAL_DOMAIN} did not resolve (DNS status ${String(b?.Status)}).`; break; }
        // Resolution is public information; it does not prove that Crestmont controls the zone.
        status = "configured_unverified"; detail = `Resolves; nameservers ${answers.join(", ")}. DNS control is not verified (BLK-011).`;
        break;
      }
      default:
        throw new ProbeUnavailable(`${id}: no probe`);
    }
  } catch (e) {
    if (e instanceof ProbeUnavailable) throw e;
    status = "failing";
    detail = `Probe error: ${(e as Error).message.slice(0, 300)}`;
  }
  if (!detail) detail = "Probe failed.";
  await writeRow(d.db, id, env, status, detail, a.fingerprint, status === "verified" ? nowIso() : null);
  await audit(d.db, { actorUserId: actorUserId, action: "integration.verified_probe", subjectType: "integration", subjectId: `${id}:${env}`, details: { status } });
  return { status, detail };
}

/** Environment variable names the platform reads as secrets. Values are never displayed. */
export const SECRET_NAMES = ["EVIDENCE_INGEST_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN", "TURNSTILE_SECRET", "VOICE_WEBHOOK_SECRET", "RETELL_INBOUND_API_KEY", "RETELL_OUTBOUND_API_KEY", "RESEND_WEBHOOK_SECRET", "MFA_ENCRYPTION_KEY"] as const;

export function secretPresence(env: Env): { name: string; present: boolean }[] {
  const e = env as unknown as Record<string, unknown>;
  return SECRET_NAMES.map((name) => ({ name, present: typeof e[name] === "string" && (e[name] as string).length > 0 }));
}

export interface StripeWebhookEndpoint { url?: string; status?: string; api_version?: string | null; enabled_events?: string[] }

/** Stripe-Version for the read-only v2 event-destination listing (v2 endpoints take the current release). */
export const STRIPE_V2_VERSION = "2026-10-28.endive";
export interface StripeEventDestination { id?: string; type?: string; status?: string; event_payload?: string; snapshot_api_version?: string | null; enabled_events?: string[]; webhook_endpoint?: { url?: string } | null }

/** Why the account's v2 event destinations cannot deliver every handled event to APP_URL as snapshot events (null = fine). */
export function eventDestinationProblem(destinations: StripeEventDestination[], appUrl: string | undefined): string | null {
  const target = webhookTarget(appUrl);
  const d = destinations.find((x) => x.webhook_endpoint?.url === target);
  if (!d) return `no event destination is registered for ${target}.`;
  if (d.status !== "enabled") return `the event destination for ${target} is ${d.status ?? "not enabled"}.`;
  if (d.event_payload !== "snapshot") return `the event destination for ${target} sends ${d.event_payload ?? "unknown"} payloads; the handler needs snapshot payloads.`;
  if (!d.snapshot_api_version || !SUPPORTED_WEBHOOK_API_VERSIONS.includes(d.snapshot_api_version)) return `the event destination uses API version ${d.snapshot_api_version ?? "default"}, expected ${SUPPORTED_WEBHOOK_API_VERSIONS.join(" or ")}.`;
  const enabled = new Set(d.enabled_events ?? []);
  if (enabled.has("*")) return null;
  const missing = STRIPE_WEBHOOK_EVENTS.filter((e) => !enabled.has(e));
  return missing.length ? `the event destination does not send: ${missing.join(", ")}.` : null;
}

/** What the account has, for the operator (URLs, status, payload style, version, event count; never secrets). */
export function endpointInventory(v1: StripeWebhookEndpoint[], destinations: StripeEventDestination[] | null, destHttpStatus: number | null): string {
  const ep = v1.slice(0, 5).map((e) => `${e.url ?? "?"} (${e.status ?? "?"}, ${e.api_version ?? "default"}, ${e.enabled_events?.includes("*") ? "all" : e.enabled_events?.length ?? 0} events)`);
  const ds = destinations?.slice(0, 5).map((x) => `${x.webhook_endpoint?.url ?? x.type ?? "?"} (${x.status ?? "?"}, ${x.event_payload ?? "?"} payloads, ${x.snapshot_api_version ?? "no snapshot version"}, ${x.enabled_events?.length ?? 0} events)`);
  return `Webhook endpoints in this account: ${ep.length ? ep.join("; ") : "none"}${v1.length > 5 ? ` (+${v1.length - 5} more)` : ""}. Event destinations: ${destinations === null ? `unavailable${destHttpStatus ? ` (HTTP ${destHttpStatus})` : ""}` : ds!.length ? ds!.join("; ") : "none"}.`;
}

const webhookTarget = (appUrl: string | undefined) => `${(appUrl ?? "").replace(/\/$/, "")}/api/webhooks/stripe`;
function webhookEndpointFor(endpoints: StripeWebhookEndpoint[], appUrl: string | undefined): StripeWebhookEndpoint | undefined {
  const target = webhookTarget(appUrl);
  return endpoints.find((e) => e.url === target);
}

/** Why the registered Stripe webhook endpoints cannot deliver every event the platform handles (null = fine). */
export function webhookEndpointProblem(endpoints: StripeWebhookEndpoint[], appUrl: string | undefined): string | null {
  const target = webhookTarget(appUrl);
  const ep = webhookEndpointFor(endpoints, appUrl);
  if (!ep) return `no webhook endpoint is registered for ${target}.`;
  if (ep.status !== "enabled") return `the webhook endpoint for ${target} is ${ep.status ?? "not enabled"}.`;
  // The payload shape follows the endpoint's version; only versions whose shapes are tested are accepted.
  if (!ep.api_version || !SUPPORTED_WEBHOOK_API_VERSIONS.includes(ep.api_version)) return `the webhook endpoint uses API version ${ep.api_version ?? "default"}, expected ${SUPPORTED_WEBHOOK_API_VERSIONS.join(" or ")}.`;
  const enabled = new Set(ep.enabled_events ?? []);
  if (enabled.has("*")) return null;
  const missing = STRIPE_WEBHOOK_EVENTS.filter((e) => !enabled.has(e));
  return missing.length ? `the webhook endpoint does not send: ${missing.join(", ")}.` : null;
}
