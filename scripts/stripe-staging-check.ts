// Independent Stripe staging check (.github/workflows/stripe-staging-check.yml), about two minutes instead of a full
// deploy. Every run gets FRESH evidence; nothing is read from a stored probe unless the Worker endpoint is unavailable,
// and then it is labelled stale and the check fails.
//   - Founder-managed bindings present on the staging Worker (names only; scripts/staging-binding-guard.ts)
//   - a FRESH read-only Stripe query by the staging Worker (it holds the key; this script never sees it): account,
//     webhook endpoints, event destinations (POST /api/payments/stripe-staging-check, scheduler-key signed)
//   - LIVE DELIVERY: the Worker creates and immediately expires a $1 TEST-mode Checkout Session; Stripe sends a signed
//     checkout.session.expired to the configured destination; this script waits until staging has stored it (stored
//     only after the signature verified with the configured signing secret) and reports its processing status
//   - whether Stripe events reached staging (counts by type and status), payments by provider and status
//   - LIVE: the webhook refuses an unsigned and a forged request (401) and stores neither
// D1 is read with single SELECT statements only; no secret, variable or webhook destination is written; values never printed.
//   node --no-warnings scripts/stripe-staging-check.ts --url https://<staging host>
//   env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ACCESS_ROOT_KEY (derives the scheduler key), STRIPE_CHECK_DELIVER
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wranglerOps } from "./staging-access.ts";
import { liveBindings, founderReport, tomlScriptName } from "./staging-binding-guard.ts";
import { deriveSchedulerKey, sign } from "./trigger-scheduler.ts";

type Row = Record<string, unknown>;
export type Query = (sql: string) => Promise<Row[]>;

/** Only read-only statements reach D1. */
export function readOnly(query: Query): Query {
  return (sql) => {
    if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error("stripe-staging-check only runs single SELECT statements");
    return query(sql);
  };
}

/** A FIXTURE event that must never be accepted: it carries no valid signature. */
export const PROBE_EVENT_ID = "evt_staging_check_unsigned";
export function probeBody(): string {
  return JSON.stringify({ id: PROBE_EVENT_ID, object: "event", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { id: "cs_test_staging_check", object: "checkout.session", mode: "payment", payment_status: "paid", metadata: {} } } });
}

export async function signatureChecks(base: string, f: typeof fetch = fetch): Promise<{ unsigned: number; forged: number }> {
  const url = `${base.replace(/\/$/, "")}/api/webhooks/stripe`;
  const body = probeBody();
  const post = (headers: Record<string, string>) => f(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }).then((r) => r.status);
  const ts = Math.floor(Date.now() / 1000);
  return { unsigned: await post({}), forged: await post({ "stripe-signature": `t=${ts},v1=${"0".repeat(64)}` }) };
}

export interface FreshCheck { checkedAt: string; probe: { status: string; detail: string }; delivery: { sessionId: string; expired: boolean } | null }

/** Asks the staging Worker for a fresh Stripe probe and (deliver) one genuine test-mode event. */
export async function callWorkerCheck(base: string, key: string, deliver: boolean, f: typeof fetch = fetch): Promise<FreshCheck> {
  const body = JSON.stringify({ check: "stripe", deliver });
  const r = await f(`${base.replace(/\/$/, "")}/api/payments/stripe-staging-check`, { method: "POST", headers: { "content-type": "application/json", "x-crestmont-scheduler-signature": sign(key, body) }, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as FreshCheck;
}

export async function report(base: string, query: Query, f: typeof fetch = fetch, bindings?: () => Promise<{ present: string[]; absent: string[] } | string>, host?: () => Promise<string>,
  live?: () => Promise<FreshCheck>, waitMs = 150_000, pollMs = 5_000): Promise<{ lines: string[]; ok: boolean }> {
  const q = readOnly(query);
  const lines: string[] = [];
  let ok = true;
  const b = bindings ? await bindings() : "not checked";
  lines.push(typeof b === "string" ? `Founder-managed bindings: ${b}` : `Founder-managed bindings present: ${b.present.join(", ") || "none"}${b.absent.length ? `; ABSENT: ${b.absent.join(", ")} (Founder restores; never recreated by automation)` : ""}`);
  // FRESH: the Worker queries Stripe now (it holds the key; this workflow never does). The stored integration_health row
  // is only a fallback, labelled with its age, for when the Worker endpoint is not deployed yet.
  let probe: Row | undefined;
  let sessionId: string | null = null;
  const fresh = live ? await live().catch((e: Error) => ({ error: e.message })) : null;
  if (fresh && !("error" in fresh)) {
    probe = { status: fresh.probe.status, detail: fresh.probe.detail, checked_at: fresh.checkedAt };
    lines.push(`Stripe probe (FRESH, queried by the staging Worker at ${fresh.checkedAt}): ${fresh.probe.status} — ${fresh.probe.detail}`);
    if (fresh.probe.status !== "verified") ok = false;
    sessionId = fresh.delivery?.sessionId ?? null;
    if (fresh.delivery) lines.push(`Test-mode event requested: Checkout Session ${fresh.delivery.sessionId} created and ${fresh.delivery.expired ? "expired" : "NOT expired"} (Stripe sends checkout.session.expired to the destination)`);
  } else {
    probe = (await q(`SELECT status, detail, checked_at FROM integration_health WHERE integration = 'stripe' AND environment = 'staging'`))[0];
    if (fresh) lines.push(`Fresh Stripe probe unavailable: ${fresh.error}`);
    lines.push(probe ? `Stripe probe (STORED, possibly stale, recorded ${probe.checked_at}): ${probe.status} — ${probe.detail}` : "Stripe probe: never run on staging");
    ok = false;
  }
  if (sessionId) {
    // Real delivery: the event is stored only after its Stripe signature verified with the configured signing secret.
    let got: Row | undefined;
    for (const end = Date.now() + waitMs; !got && Date.now() < end; ) {
      got = (await q(`SELECT id, type, status, attempts, last_error, received_at FROM stripe_events WHERE object_id = '${sessionId.replace(/[^A-Za-z0-9_]/g, "")}' ORDER BY received_at DESC LIMIT 1`))[0];
      if (!got) await new Promise((r) => setTimeout(r, pollMs));
    }
    if (got) lines.push(`LIVE DELIVERY: ${got.type} ${got.id} received ${got.received_at}, signature verified with the configured signing secret, status ${got.status}${got.last_error ? ` (${got.last_error})` : ""}`);
    else lines.push(`LIVE DELIVERY: NOT received within ${waitMs / 1000}s — Stripe did not deliver checkout.session.expired for ${sessionId}, or the delivery was refused before storage (signature mismatch). Stripe Dashboard → the destination → Event deliveries shows the HTTP status staging returned.`);
    if (!got || got.status !== "processed") ok = false;
  }
  const events = await q(`SELECT type, status, COUNT(*) AS n, MAX(received_at) AS last FROM stripe_events GROUP BY type, status ORDER BY last DESC LIMIT 40`);
  const total = events.reduce((s, e) => s + Number(e.n), 0);
  lines.push(total ? `Stripe events received on staging: ${total} — ${events.map((e) => `${e.type} ${e.status} ×${e.n} (last ${e.last})`).join("; ")}` : "Stripe events received on staging: NONE — no signed Stripe event has ever been stored (none delivered, or every delivery was refused before storage)");
  const pays = await q(`SELECT provider, status, COUNT(*) AS n FROM payments GROUP BY provider, status`);
  lines.push(`Payments on staging: ${pays.length ? pays.map((p) => `${p.provider} ${p.status} ×${p.n}`).join("; ") : "none"}`);
  // Which host is the staging Worker? The Cloudflare account's workers.dev subdomain, plus a public GET /api/health on
  // every host a registered Stripe endpoint points at (read-only; no Stripe call).
  if (host) lines.push(`Staging Worker host (Cloudflare account workers.dev subdomain): ${await host().catch((e: Error) => `unavailable (${e.message.slice(0, 120)})`)}; this check used ${base}`);
  const urls = [...new Set([...String(probe?.detail ?? "").matchAll(/https:\/\/[^\s(]+\/api\/webhooks\/stripe/g)].map((m) => new URL(m[0]).origin))];
  for (const origin of urls) {
    const r = await f(`${origin}/api/health`).then(async (x) => `HTTP ${x.status}${x.ok ? ` ${(await x.text()).slice(0, 80).replace(/\s+/g, " ")}` : ""}`).catch((e: Error) => `unreachable (${String(e.cause ?? e.message).slice(0, 100)})`);
    lines.push(`Registered webhook host ${origin}: GET /api/health → ${r}${origin === new URL(base).origin ? " (this is the staging URL)" : ""}`);
  }
  const sig = await signatureChecks(base, f);
  const stored = (await q(`SELECT COUNT(*) AS n FROM stripe_events WHERE id = '${PROBE_EVENT_ID}'`))[0];
  const refused = sig.unsigned === 401 && sig.forged === 401 && Number(stored?.n ?? 0) === 0;
  if (!refused) ok = false;
  lines.push(`Webhook signature enforcement (live): unsigned → ${sig.unsigned}, forged signature → ${sig.forged}, stored: ${Number(stored?.n ?? 0)} — ${refused ? "REFUSED as required" : "FAILED: an unsigned or forged event was not refused"}`);
  return { lines, ok };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--url");
  const base = i > 0 ? process.argv[i + 1] : "";
  if (!/^https:\/\//.test(base)) { console.error("::error::--url https://<staging host> is required"); process.exit(2); }
  const ops = wranglerOps();
  const script = tomlScriptName(readFileSync("wrangler.toml", "utf8"), "staging");
  try {
    const bindings = async () => { try { return founderReport(await liveBindings(script)); } catch (e) { return `unavailable (${String((e as Error).message).split("\n")[0].slice(0, 160)})`; } };
    const host = async () => {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
      const b = (await r.json().catch(() => ({}))) as { result?: { subdomain?: string } };
      if (!r.ok || !b.result?.subdomain) throw new Error(`HTTP ${r.status}`);
      return `https://${script}.${b.result.subdomain}.workers.dev`;
    };
    const root = process.env.ACCESS_ROOT_KEY;
    const live = root ? () => callWorkerCheck(base, deriveSchedulerKey(root), process.env.STRIPE_CHECK_DELIVER !== "false") : undefined;
    const { lines, ok } = await report(base, (sql) => ops.query(sql), fetch, bindings, host, live);
    const enc = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    for (const l of lines) console.log(`::notice title=Stripe staging check::${enc(l.slice(0, 3000))}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Stripe staging check", "", ...lines.map((l) => `- ${l}`), ""].join("\n"));
    if (!ok) { console.log("::error title=Stripe staging check::not complete — see the lines above (fresh probe, live delivery, signature enforcement)"); process.exit(1); }
  } catch (e) {
    console.log(`::error title=Stripe staging check::${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    process.exit(1);
  }
}
