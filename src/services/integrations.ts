// Integration health (§36, §61, INFRA-002, EMAIL-001). Status is derived from real configuration
// checks of the running environment and, for "verified", from a successful read-only probe call
// to the provider. Nothing is ever marked verified without a successful call; a probe failure is
// recorded as "failing" with the provider's error. Secrets are never stored or displayed — only
// a short SHA-256 fingerprint, used to notice when a key changes so stale verification is dropped.
import { STRIPE_API_VERSION } from "../adapters/payments.ts";
import { paymentsMode, keyMode } from "../domain/payments-mode.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Env } from "../app/context.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { audit } from "./security.ts";

export const INTEGRATIONS = [
  { id: "stripe", label: "Stripe (payments)", blocker: "BLK-004" },
  { id: "resend", label: "Resend (email + domain authentication)", blocker: "BLK-005" },
  { id: "auth", label: "Authentication (in-platform)", blocker: null },
  { id: "database", label: "Database (D1 / SQLite)", blocker: "BLK-003" },
  { id: "object_storage", label: "Object storage (R2)", blocker: "BLK-003" },
  { id: "ai", label: "AI provider (Anthropic)", blocker: null },
  { id: "voice", label: "Voice receptionist provider", blocker: "BLK-009" },
  { id: "telephony", label: "Telephony (phone number)", blocker: "BLK-009" },
  { id: "monitoring", label: "External monitoring & alerting", blocker: "BLK-003" },
  { id: "dns", label: "DNS (crestmontwebsitedevelopment.com)", blocker: "BLK-011" },
  { id: "github", label: "GitHub repository", blocker: null },
  { id: "turnstile", label: "Cloudflare Turnstile (bot defence)", blocker: "BLK-003" },
  { id: "retell", label: "Retell AI webhooks (voice receptionist)", blocker: "BLK-009" },
  { id: "resend_webhooks", label: "Resend delivery webhooks (bounces, complaints)", blocker: "BLK-005" },
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
    case "ai":
      if (!e.ANTHROPIC_API_KEY) return { status: "not_configured", detail: "ANTHROPIC_API_KEY is not set. AI drafting jobs fail with not_configured; nothing is generated.", fingerprint: null, probe: false };
      return { status: "configured_unverified", detail: `API key set; model ${e.AI_MODEL ?? "default"}. ${e.AI_PROVIDER === "anthropic" ? "Selected as the AI backend (AI_PROVIDER=anthropic); paid calls also need the Owner's monthly AI budget." : `Not used: AI_PROVIDER is ${e.AI_PROVIDER ? `"${e.AI_PROVIDER}"` : "unset"}, so paid AI stays off.`} Probe lists models.`, fingerprint: await fp(e.ANTHROPIC_API_KEY), probe: true };
    case "voice":
      if (!e.VOICE_WEBHOOK_SECRET) return { status: "not_configured", detail: "No voice provider selected (BLK-009) and VOICE_WEBHOOK_SECRET is not set; the voice webhook rejects every request.", fingerprint: null, probe: false };
      return { status: "configured_unverified", detail: "VOICE_WEBHOOK_SECRET set, so signed events are accepted. No provider account is connected (BLK-009); there is no provider API to probe.", fingerprint: await fp(e.VOICE_WEBHOOK_SECRET), probe: false };
    case "telephony":
      return { status: "not_configured", detail: "No phone number has been purchased. Purchase requires Founder approval of the provider recommendation (BLK-009).", fingerprint: null, probe: false };
    case "monitoring":
      return { status: "not_configured", detail: "Errors are recorded in the in-app error log only. No external uptime monitor or alert routing (email/SMS/pager) is configured; nobody is notified automatically.", fingerprint: null, probe: false };
    case "dns":
      return { status: "not_configured", detail: `No DNS provider access is configured (BLK-011). The probe can check public resolution of ${OFFICIAL_DOMAIN}, which does not prove control.`, fingerprint: null, probe: true };
    case "github":
      if (!e.GITHUB_TOKEN || !e.GITHUB_REPO) return { status: "not_configured", detail: "GITHUB_TOKEN and/or GITHUB_REPO not set; the readiness dashboard cannot read repository data.", fingerprint: null, probe: false };
      return { status: "configured_unverified", detail: `Repository ${e.GITHUB_REPO}. Probe reads repository metadata.`, fingerprint: await fp(e.GITHUB_TOKEN + "|" + e.GITHUB_REPO), probe: true };
    case "turnstile":
      if (!e.TURNSTILE_SECRET || !e.TURNSTILE_SITE_KEY) {
        const dev = e.ENVIRONMENT === "development" ? " Development accepts public forms without a challenge; other environments fail closed." : " Public forms fail closed (bot check refused).";
        return { status: "not_configured", detail: `TURNSTILE_SECRET / TURNSTILE_SITE_KEY not set.${dev}`, fingerprint: null, probe: false };
      }
      return { status: "configured_unverified", detail: "Turnstile keys set. Probe confirms the secret is accepted by siteverify.", fingerprint: await fp(e.TURNSTILE_SECRET), probe: true };
    case "retell":
      if (!e.RETELL_API_KEY) return { status: "not_configured", detail: "RETELL_API_KEY is not set; /api/webhooks/retell and /api/webhooks/retell/functions reject every request. No Retell workspace exists for Crestmont yet (BLK-009).", fingerprint: null, probe: false };
      return { status: "configured_unverified", detail: "Retell webhook key set, so signed Retell events are accepted. Unverified until a test call from the Crestmont workspace is received; there is no read-only probe.", fingerprint: await fp(e.RETELL_API_KEY), probe: false };
    case "resend_webhooks":
      if (!e.RESEND_WEBHOOK_SECRET) return { status: "not_configured", detail: "RESEND_WEBHOOK_SECRET is not set; /api/webhooks/resend rejects every request, so bounces and complaints are not recorded.", fingerprint: null, probe: false };
      return { status: "configured_unverified", detail: "Svix signing secret set; signed Resend delivery events are accepted. Unverified until Resend delivers a real event.", fingerprint: await fp(e.RESEND_WEBHOOK_SECRET), probe: false };
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
        status = "verified"; detail = `GET /v1/balance succeeded in ${live ? "live" : "test"} mode.`;
        break;
      }
      case "resend": {
        const r = await f("https://api.resend.com/domains", { headers: { authorization: `Bearer ${d.env.RESEND_API_KEY}` } });
        const b = await jsonOrNull(r);
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
        const r = await f("https://api.anthropic.com/v1/models?limit=5", { headers: { "x-api-key": d.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" } });
        const b = await jsonOrNull(r);
        if (!r.ok) { detail = providerError("Anthropic", r, b); break; }
        status = "verified"; detail = "Models list returned successfully.";
        break;
      }
      case "github": {
        const repo = d.env.GITHUB_REPO!;
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
  "GITHUB_TOKEN", "TURNSTILE_SECRET", "VOICE_WEBHOOK_SECRET", "RETELL_API_KEY", "RESEND_WEBHOOK_SECRET", "MFA_ENCRYPTION_KEY"] as const;

export function secretPresence(env: Env): { name: string; present: boolean }[] {
  const e = env as unknown as Record<string, unknown>;
  return SECRET_NAMES.map((name) => ({ name, present: typeof e[name] === "string" && (e[name] as string).length > 0 }));
}
