// Read-only check that each departmental mailbox actually receives mail (Owner, 2026-11-13): the domain's MX points to
// Cloudflare Email Routing, so support@, sales@, billing@ and legal@ each need an enabled routing rule (or an enabled
// catch-all) that forwards to a VERIFIED destination. Destinations are the Owner's private inboxes: they are never
// printed, only whether they are verified. Uses the environment's Cloudflare token; with no Email Routing read
// permission it says so (exit 2) instead of guessing.
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/email-routing-check.mjs
const DOMAIN = "crestmontwebsitedevelopment.com";
const MAILBOXES = ["support", "sales", "billing", "legal"].map((m) => `${m}@${DOMAIN}`);
const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) { console.error("CLOUDFLARE_API_TOKEN is required"); process.exit(2); }
const cf = async (path) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, status: r.status, result: j.result, errors: (j.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") };
};
const zone = await cf(`/zones?name=${DOMAIN}`);
const zoneId = Array.isArray(zone.result) ? zone.result[0]?.id : null;
if (!zoneId) { console.log(`NOT CHECKED Email Routing — the token cannot read the zone (${zone.status} ${zone.errors})`); process.exit(2); }
const settings = await cf(`/zones/${zoneId}/email/routing`);
const rules = await cf(`/zones/${zoneId}/email/routing/rules?per_page=50`);
const catchAll = await cf(`/zones/${zoneId}/email/routing/rules/catch_all`);
const dests = account ? await cf(`/accounts/${account}/email/routing/addresses?per_page=50`) : { ok: false, result: [] };
if (!rules.ok) { console.log(`NOT CHECKED Email Routing — the token has no Email Routing read permission (${rules.status} ${rules.errors}). Delivery is shown by the mailbox check's Resend events instead.`); process.exit(2); }
const verified = new Set((dests.result ?? []).filter((d) => d.verified).map((d) => String(d.email).toLowerCase()));
const destState = (a) => a.type === "worker" ? "a Worker" : a.type === "drop" ? "DROPPED" : (a.value ?? []).every((v) => !dests.ok || verified.has(String(v).toLowerCase())) ? `${(a.value ?? []).length} verified destination(s)` : "an UNVERIFIED destination";
console.log(`Email Routing on ${DOMAIN}: ${settings.result?.enabled ? "enabled" : settings.ok ? "DISABLED" : "status unknown"}`);
let failed = 0;
for (const addr of MAILBOXES) {
  const rule = (rules.result ?? []).find((r) => r.enabled && (r.matchers ?? []).some((m) => m.type === "literal" && m.field === "to" && String(m.value).toLowerCase() === addr));
  const viaCatchAll = !rule && catchAll.ok && catchAll.result?.enabled;
  const action = rule ? rule.actions?.[0] : viaCatchAll ? catchAll.result.actions?.[0] : null;
  const ok = !!action && (action.type === "forward" || action.type === "worker") && !/DROPPED|UNVERIFIED/.test(destState(action));
  console.log(`${ok ? "PASS" : "FAIL"} ${addr} — ${rule ? "own rule" : viaCatchAll ? "catch-all rule" : "no enabled rule"}${action ? ` → ${action.type} to ${destState(action)}` : ""}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
