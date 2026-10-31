// Narrow, read-only Stripe staging check (.github/workflows/stripe-staging-check.yml). Answers in about a minute what a
// full staging deploy (45-50 min, results only at the end) answered: is Stripe wired up on staging?
//   - Founder-managed bindings present on the staging Worker (names only; scripts/staging-binding-guard.ts)
//   - the last recorded Stripe integration probe (account, endpoint / event-destination inventory)
//   - whether any Stripe event has ever reached staging (counts by type and status; nothing else)
//   - payments recorded on staging (counts by provider and status)
//   - LIVE: the webhook refuses an unsigned request and a wrongly signed one (401), and stores neither
// It never writes to D1 (only SELECT is accepted), never calls Stripe, and never prints a value.
//   node --no-warnings scripts/stripe-staging-check.ts --url https://<staging host>
//   env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (D1 reads and the binding names), WRANGLER (optional)
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wranglerOps } from "./staging-access.ts";
import { liveBindings, founderReport, tomlScriptName } from "./staging-binding-guard.ts";

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

export async function report(base: string, query: Query, f: typeof fetch = fetch, bindings?: () => Promise<{ present: string[]; absent: string[] } | string>): Promise<{ lines: string[]; ok: boolean }> {
  const q = readOnly(query);
  const lines: string[] = [];
  let ok = true;
  const b = bindings ? await bindings() : "not checked";
  lines.push(typeof b === "string" ? `Founder-managed bindings: ${b}` : `Founder-managed bindings present: ${b.present.join(", ") || "none"}${b.absent.length ? `; ABSENT: ${b.absent.join(", ")} (Founder restores; never recreated by automation)` : ""}`);
  const probe = (await q(`SELECT status, detail, checked_at FROM integration_health WHERE integration = 'stripe' AND environment = 'staging'`))[0];
  lines.push(probe ? `Stripe probe (${probe.checked_at}): ${probe.status} — ${probe.detail}` : "Stripe probe: never run on staging (Owner: Integrations → Stripe → Run check)");
  const events = await q(`SELECT type, status, COUNT(*) AS n, MAX(received_at) AS last FROM stripe_events GROUP BY type, status ORDER BY last DESC LIMIT 40`);
  const total = events.reduce((s, e) => s + Number(e.n), 0);
  lines.push(total ? `Stripe events received on staging: ${total} — ${events.map((e) => `${e.type} ${e.status} ×${e.n} (last ${e.last})`).join("; ")}` : "Stripe events received on staging: NONE — no signed Stripe event has ever been stored (none delivered, or every delivery was refused before storage)");
  const pays = await q(`SELECT provider, status, COUNT(*) AS n FROM payments GROUP BY provider, status`);
  lines.push(`Payments on staging: ${pays.length ? pays.map((p) => `${p.provider} ${p.status} ×${p.n}`).join("; ") : "none"}`);
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
    const { lines, ok } = await report(base, (sql) => ops.query(sql), fetch, bindings);
    const enc = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    for (const l of lines) console.log(`::notice title=Stripe staging check::${enc(l.slice(0, 3000))}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Stripe staging check", "", ...lines.map((l) => `- ${l}`), ""].join("\n"));
    if (!ok) { console.log("::error title=Stripe staging check::the staging webhook accepted an unsigned or forged event"); process.exit(1); }
  } catch (e) {
    console.log(`::error title=Stripe staging check::${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    process.exit(1);
  }
}
