// Live purchase-flow probe for production (Founder, 2026-11-12): proves that a new customer can go from a package to a
// genuine LIVE Stripe Checkout session, without paying.
//
// It creates one clearly labelled probe customer directly in the production database (verified email, random password
// known only to this run; organization "[Purchase probe] …"), then, over HTTPS against the real site, exactly as a
// browser does: signs in → /checkout/<package> → completes the intake → the review page (server-side price, required
// maintenance plan, agreements) → presses Pay. It requires a 303 to checkout.stripe.com with a live session id
// (cs_live_…), opens that Stripe page, and checks the order the site recorded (amount, plan). Nothing is paid; Stripe
// expires the unpaid session (the checkout.session.expired webhook then voids the invoice and cancels the order).
// Finally the probe user is disabled and its sessions removed.
//
//   BASE=https://… WRANGLER="npx --yes wrangler@4.149.0" node scripts/production-purchase-probe.ts [starter,business,premium]
// Output: one line per check; no secret, no password, no session URL (only its id prefix). Exit 1 on any failure.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/lib/auth-crypto.ts";
import { PACKAGES } from "../src/domain/catalog.ts";
import { MINIMUM_PLAN_FOR_PACKAGE } from "../src/domain/catalog.ts";

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(BASE)) { console.error("BASE must be the production https origin"); process.exit(2); }
const pkgs = (process.argv[2] ?? "starter,business,premium").split(",").map((s) => s.trim()).filter(Boolean);
const [cmd, ...wbase] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
// Staging rehearsal: D1_ENV=staging and EXPECT_MODE=test (staging uses Stripe test mode); production expects live.
const D1_ENV = process.env.D1_ENV === "staging" ? "staging" : "production";
const MODE = process.env.EXPECT_MODE === "test" ? "test" : "live";
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const wr = (args: string[]) => execFileSync(cmd, [...wbase, "d1", "execute", `crestmont-${D1_ENV}`, "--remote", "--env", D1_ENV, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
/** Writes: a SQL file (wrangler prints progress, not JSON, for --file). */
const d1Write = (sql: string) => {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  try { writeFileSync(join(dir, "q.sql"), sql, { mode: 0o600 }); wr(["--file", join(dir, "q.sql"), "--yes"]); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
/** One read query: --command --json returns clean JSON. */
const d1 = (sql: string) => {
  const out = wr(["--json", "--command", sql]);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results?: Record<string, unknown>[] }[];
  return parsed.flatMap((p) => p.results ?? []);
};

let failed = 0;
const check = (ok: boolean, what: string, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; return ok; };

// A minimal browser: cookie jar, CSRF from the double-submit cookie, manual redirects.
class Browser {
  jar = new Map<string, string>();
  async req(method: string, path: string, body?: URLSearchParams): Promise<Response> {
    const headers: Record<string, string> = { "user-agent": "CrestmontPurchaseProbe/1.0", accept: "text/html" };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; headers.origin = BASE; const t = [...this.jar].find(([k]) => /cm_csrf$/.test(k))?.[1]; if (t) body.set("_csrf", decodeURIComponent(t)); }
    const r = await fetch(new URL(path, BASE), { method, headers, body: body?.toString(), redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [pair] = c.split(";"); const i = pair.indexOf("="); const k = pair.slice(0, i).trim(), v = pair.slice(i + 1); if (/max-age=0/i.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    return r;
  }
  async follow(path: string) { let r = await this.req("GET", path); let n = 0; while (r.status >= 300 && r.status < 400 && n++ < 5) { const loc = r.headers.get("location")!; await r.text(); r = await this.req("GET", new URL(loc, BASE).pathname + new URL(loc, BASE).search); } return r; }
}

const run = randomBytes(4).toString("hex");
const email = `purchase-probe-${run}@example.com`;
const password = randomBytes(24).toString("base64url");
const userId = `usr_probe_${run}`, orgId = `org_probe_${run}`, now = new Date().toISOString();
d1Write(`UPDATE users SET disabled_at = ${q(now)} WHERE id LIKE 'usr_probe_%' AND disabled_at IS NULL;
INSERT INTO users (id, email, display_name, password_hash, email_verified_at, mfa_enabled, created_at) VALUES (${q(userId)}, ${q(email)}, 'Purchase Probe', ${q(await hashPassword(password))}, ${q(now)}, 0, ${q(now)});
INSERT INTO organizations (id, name, kind, created_at) VALUES (${q(orgId)}, ${q(`[Purchase probe ${run}] Crestmont live checkout check`)}, 'customer', ${q(now)});
INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (${q(`mbr_probe_${run}`)}, ${q(userId)}, ${q(orgId)}, 'customer_admin', ${q(now)});
INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system', 'ops.purchase_probe_started', 'organization', ${q(orgId)}, '{"note":"live checkout session check; nothing is paid"}', ${q(now)});`);
console.log(`probe customer ${orgId} created (verified email; random password)`);

try {
  const b = new Browser();
  await (await b.req("GET", "/login")).text();
  const login = await b.req("POST", "/login", new URLSearchParams({ email, password }));
  await login.text();
  check(login.status === 303 && !/\/login/.test(login.headers.get("location") ?? ""), "a new customer signs in", `HTTP ${login.status} → ${login.headers.get("location")}`);
  for (const id of pkgs) {
    const pkg = (PACKAGES as Record<string, (typeof PACKAGES)[keyof typeof PACKAGES]>)[id];
    if (!pkg) { check(false, `${id}: known package`); continue; }
    const price = `$${(pkg.basePriceCents / 100).toLocaleString("en-US")}`;
    const entry = await b.req("GET", `/checkout/${id}`); await entry.text();
    check(entry.status === 303 && (entry.headers.get("location") ?? "").includes(`/checkout/${id}/intake`), `${id}: the package button opens its intake`, `HTTP ${entry.status} → ${entry.headers.get("location")}`);
    const intake = await b.follow(`/checkout/${id}/intake`); const ih = await intake.text();
    check(intake.status === 200 && /Tell us about your website/.test(ih) && !/We are opening soon/.test(ih), `${id}: intake form renders for a new customer`, `HTTP ${intake.status}`);
    const answers = new URLSearchParams({ business_name: `[Purchase probe ${run}]`, contact_name: "Purchase Probe", contact_email: email, industry: "Automated live checkout check",
      business_description: "Automated check of the purchase flow; not a real order.", goals: "Verify the purchase flow.", target_audience: "None (automated check).",
      has_branding: "no", brand_style: "None", pages: "Home", content_source: "crestmont_draft", images_source: "licensed", domain_status: "need", domain_wishes: "none.example",
      hosting: "crestmont", special_instructions: "AUTOMATED PROBE — not a real order. Do not start work.", intent: "submit" });
    const saved = await b.req("POST", `/checkout/${id}/intake`, answers); await saved.text();
    check(saved.status === 303 && (saved.headers.get("location") ?? "").includes(`/checkout/${id}/review`), `${id}: intake saves and continues to review`, `HTTP ${saved.status} → ${saved.headers.get("location")}`);
    const review = await b.follow(`/checkout/${id}/review`); const rh = await review.text();
    check(review.status === 200 && rh.includes(price), `${id}: review shows the server-side price ${price}`);
    // The live review page's HTML for the phone-width layout check (scripts/live-layout-check.mjs); stays on the runner.
    if (process.env.SAVE_REVIEW_DIR) writeFileSync(join(process.env.SAVE_REVIEW_DIR, `review-${id}.html`), rh.replace(/name="_csrf" value="[^"]*"/g, 'name="_csrf" value=""'), { mode: 0o600 });
    const plan = MINIMUM_PLAN_FOR_PACKAGE[id as keyof typeof MINIMUM_PLAN_FOR_PACKAGE];
    check(new RegExp(`name="maintenance_plan" value="${plan}"`).test(rh) && /data-testid="checkout-maintenance-plan"/.test(rh), `${id}: required maintenance plan offered (minimum ${plan})`);
    check(/name="terms"/.test(rh) && /Development Agreement/.test(rh) && /Pay \$/.test(rh) && !/checkout-payment-closed/.test(rh), `${id}: agreement and Pay button present (checkout open)`);
    const pay = await b.req("POST", `/checkout/${id}`, new URLSearchParams({ maintenance_plan: plan, terms: "on", price: "1", amount_cents: "100" }));
    await pay.text();
    const loc = pay.headers.get("location") ?? "";
    const live = /^https:\/\/checkout\.stripe\.com\//.test(loc) && new RegExp(`cs_${MODE}_`).test(loc);
    check(pay.status === 303 && live, `${id}: Pay creates a ${MODE}-mode Stripe Checkout session`, `HTTP ${pay.status} → ${loc ? `${new URL(loc).host} ${(/cs_(live|test)_[A-Za-z0-9]{0,6}/.exec(loc) ?? ["?"])[0]}…` : "no redirect"}`);
    if (live) { const s = await fetch(loc, { redirect: "follow" }); await s.text(); check(s.status === 200, `${id}: the Stripe-hosted checkout page opens`, `HTTP ${s.status}`); }
    const order = d1(`SELECT o.total_cents AS amount, o.maintenance_plan_id AS plan, o.status AS status FROM orders o WHERE o.organization_id = ${q(orgId)} AND o.product_id = ${q(id)} ORDER BY o.created_at DESC LIMIT 1`)[0] as { amount?: number; plan?: string; status?: string } | undefined;
    check(order?.amount === pkg.basePriceCents && order?.plan === plan, `${id}: order recorded with the trusted amount and plan (client-sent price ignored)`, JSON.stringify(order ?? null));
  }
} finally {
  const end = new Date().toISOString();
  d1Write(`UPDATE users SET disabled_at = ${q(end)} WHERE id = ${q(userId)};
DELETE FROM sessions WHERE user_id = ${q(userId)};
INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system', 'ops.purchase_probe_finished', 'organization', ${q(orgId)}, ${q(JSON.stringify({ failed }))}, ${q(end)});`);
  console.log(`probe customer disabled; its unpaid Stripe sessions expire on their own (the expiry webhook voids the invoices).`);
}
console.log(failed ? `${failed} check(s) failed` : "live purchase flow verified up to Stripe Checkout (nothing paid)");
process.exit(failed ? 1 : 0);
