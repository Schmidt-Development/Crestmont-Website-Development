// Phase 1 release boundary (docs/PHASED-LAUNCH.md), proven on a PRODUCTION-configured app wherever possible:
// a live-mode payment, the scheduled entry point, every public page, the human project workflow, fresh MFA for scope
// changes, and the configuration digest. No agent, model, network call or real payment is involved.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createTestApp, createCustomer, createStaff, MemoryStorage, TEST_PASSWORD } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import { createPackageOrder } from "../src/services/commerce.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { runJobs } from "../src/app/scheduled.ts";
import { configureAiBuildGateFromEnv, currentAiBuildGate } from "../src/domain/ai-build-gate.ts";
import { PACKAGES } from "../src/domain/catalog.ts";
import { liveAiGateProblem, missingSecrets } from "../scripts/phase-check.ts";
import type { Env } from "../src/app/context.ts";

afterEach(() => { configureAiBuildGateFromEnv({ ENVIRONMENT: "development" }); });

const WHSEC = "whsec_phase1";
const MFA_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
/** Production as committed: AI generation off, live payments authorised (fixture key; FakePayments, no network). */
const PRODUCTION: Partial<Env> = { ENVIRONMENT: "production", AI_BUILD_AUTOMATION: "off", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_live_fixture", PAYMENTS_LIVE_AUTHORIZED: "yes", MFA_ENCRYPTION_KEY: MFA_KEY };
type App = Awaited<ReturnType<typeof createTestApp>>;
const prodApp = (extra: Partial<Env> = {}) => createTestApp({ ...PRODUCTION, overrides: { storage: new MemoryStorage(), payments: new FakePayments() }, ...extra });

let evt = 0;
async function livePayment(t: App, orgId: string, inv: { orderId: string; invoiceId: string; amountCents: number }) {
  const pi = `pi_live_${++evt}`;
  const body = JSON.stringify({ id: `evt_live_${evt}_${Date.now()}`, type: "checkout.session.completed", livemode: true, created: Math.floor(Date.now() / 1000),
    data: { object: { id: `cs_${pi}`, livemode: true, mode: "payment", payment_status: "paid", amount_total: inv.amountCents, payment_intent: pi, metadata: { organization_id: orgId, invoice_id: inv.invoiceId, order_id: inv.orderId, kind: "package" } } } });
  const ts = Math.floor(Date.now() / 1000);
  return t.client().request("POST", "/api/webhooks/stripe", { body, headers: { "stripe-signature": `t=${ts},v1=${await hmacSha256Hex(WHSEC, `${ts}.${body}`)}` } });
}
const INTAKE = { intent: "submit", business_name: "Harbor Bakery", contact_name: "Dana", contact_email: "hello@harbor.example", industry: "Bakery", goals: "More catering orders",
  target_audience: "Local offices", has_branding: "no", brand_style: "Warm and simple", pages: "Home\nMenu\nContact", content_source: "crestmont_draft", images_source: "licensed",
  domain_status: "need", domain_wishes: "harborbakery.example", hosting: "crestmont", functionality: ["contact_form"], competitors: "" };

async function paidProject(t: App) {
  const cu = await createCustomer(t.db, `c${Math.random().toString(16).slice(2, 8)}@ex.example`, "Harbor Bakery");
  const c = await t.client().login(cu.email, TEST_PASSWORD);
  const order = await createPackageOrder(t.db, cu.organizationId, "business", cu.id);
  assert.equal((await livePayment(t, cu.organizationId, order)).status, 200);
  const pid = (await t.db.prepare(`SELECT id FROM projects WHERE order_id = ?`).bind(order.orderId).first<{ id: string }>())!.id;
  assert.equal((await c.post(`/portal/projects/${pid}/onboarding`, INTAKE)).status, 303);
  return { pid, order, c };
}
const buildJobs = async (t: App) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM build_jobs`).first<{ n: number }>())!.n;

test("phase 1 boundary: a verified LIVE-mode payment and submitted intake on production provision the project and start no AI build", async () => {
  const t = await prodApp();
  const { pid, order } = await paidProject(t);
  assert.equal((await t.db.prepare(`SELECT status FROM invoices WHERE id = ?`).bind(order.invoiceId).first<{ status: string }>())!.status, "paid", "the payment itself was accepted");
  assert.equal((await t.db.prepare(`SELECT status FROM projects WHERE id = ?`).bind(pid).first<{ status: string }>())!.status, "scope_review");
  assert.equal(await buildJobs(t), 0);
  t.close();
});

test("phase 1 boundary: the scheduled entry point configures the gate from the production environment itself (no state leaks in from an earlier request)", async () => {
  const t = await prodApp();
  await paidProject(t);
  // Force the isolate's gate OPEN, as if the last request had come from an open environment, then run the real
  // scheduled job runner with the production environment: it must close the gate before the sweep runs.
  configureAiBuildGateFromEnv({ ENVIRONMENT: "development" });
  assert.equal(currentAiBuildGate().open, true);
  const out = await runJobs(t.env, ["build_sweep"]);
  assert.equal(out.build_sweep.ok, true, out.build_sweep.detail);
  assert.equal(currentAiBuildGate().open, false);
  assert.equal(await buildJobs(t), 0, "the cron sweep must not enqueue the paid project");
  t.close();
});

test("phase 1 boundary: /api/health reports the running gate, and the live check catches a secret that overrides the committed \"off\"", async () => {
  const toml = readFileSync("wrangler.toml", "utf8");
  const off = await prodApp();
  const health = await (await off.client().get("/api/health")).json() as Record<string, unknown>;
  assert.equal(health.aiBuildAutomation, "off");
  assert.equal(liveAiGateProblem(toml, health, true), null);
  off.close();
  // A Worker secret AI_BUILD_AUTOMATION = "on" (no deploy) is exactly what the running Worker would then see.
  const overridden = await prodApp({ AI_BUILD_AUTOMATION: "on" });
  const h2 = await (await overridden.client().get("/api/health")).json() as Record<string, unknown>;
  assert.equal(h2.aiBuildAutomation, "on");
  assert.match(liveAiGateProblem(toml, h2, false) ?? "", /ON in the running production Worker/);
  assert.match(liveAiGateProblem(toml, h2, true) ?? "", /ON in the running production Worker/);
  assert.match(liveAiGateProblem(toml, { status: "ok" }, false) ?? "", /does not report aiBuildAutomation/, "an old or foreign Worker is not mistaken for a closed gate");
  // A reviewed reopening (committed "on") deployed later: the monitor stays quiet in between; the post-deploy check does not.
  const reopened = toml.replace('AI_BUILD_AUTOMATION = "off"', 'AI_BUILD_AUTOMATION = "on"');
  assert.equal(liveAiGateProblem(reopened, health, false), null);
  assert.match(liveAiGateProblem(reopened, health, true) ?? "", /committed configuration says "on"/);
  overridden.close();
});

test("phase 1 boundary: the deploy refuses a production Worker without its required secrets, MFA_ENCRYPTION_KEY included", () => {
  const required = ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "EVIDENCE_INGEST_SECRET", "MFA_ENCRYPTION_KEY"];
  // Exactly what provisioning run 1 installed (it predates the MFA step).
  const today = JSON.stringify([{ name: "TURNSTILE_SITE_KEY", type: "secret_text" }, { name: "TURNSTILE_SECRET", type: "secret_text" }, { name: "EVIDENCE_INGEST_SECRET", type: "secret_text" }]);
  assert.deepEqual(missingSecrets(required, today), ["MFA_ENCRYPTION_KEY"]);
  assert.deepEqual(missingSecrets(required, JSON.stringify([...JSON.parse(today), { name: "MFA_ENCRYPTION_KEY" }])), []);
  const wf = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const required_ = /REQUIRED_SECRETS: '(\[[^']*\])'/.exec(wf)?.[1];
  assert.deepEqual(JSON.parse(required_ ?? "[]"), required, "the deploy workflow requires exactly these");
  const step = wf.slice(wf.indexOf("Production Worker secrets — required present"));
  assert.doesNotMatch(step.slice(0, step.indexOf("run:")), /\n\s+if:/, "the secrets preflight is unconditional");
  assert.ok(wf.indexOf("Production Worker secrets — required present") < wf.indexOf("Apply D1 migrations"), "checked before any change");
  assert.ok(wf.indexOf("phase-check.ts live wrangler.toml health.json --exact") > wf.indexOf("Deploy Worker (production)"), "the running Worker is compared after deploy");
});

test("phase 1 boundary: no public page promises automated or AI-built websites, and package prices are the approved ones", async () => {
  const t = await prodApp();
  const sitemap = await (await t.client().get("/sitemap.xml")).text();
  const paths = [...new Set([...sitemap.matchAll(/<loc>https?:\/\/[^/<]+(\/[^<]*)<\/loc>/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 15, `sitemap lists the public site (${paths.length})`);
  const PROMISE = /AI[- ]built|built (?:automatically|by AI)|automatically (?:built|generated|designed)|AI website builder|AI-generated (?:website|site)|instant(?:ly)? (?:website|site)|(?:website|site) in (?:minutes|hours)|autonomous(?:ly)? (?:build|develop)/i;
  // Visible text only. End tags are matched with any whitespace or attributes before ">" (`</script >`), which a
  // browser also accepts, so no script or style body leaks into (or hides from) the scan.
  const strip = (h: string) => h.replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ").replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ").replace(/<[^>]+>/g, " ");
  for (const p of [...paths, "/pricing", "/quote", "/register"]) {
    const res = await t.client().get(p);
    assert.equal(res.status, 200, p);
    const text = strip(await res.text());
    assert.doesNotMatch(text, PROMISE, `${p} must not promise automated delivery`);
  }
  const pricing = strip(await (await t.client().get("/pricing")).text());
  for (const price of ["$999", "$2,499", "$4,999"]) assert.ok(pricing.includes(price), `pricing shows ${price}`);
  assert.deepEqual(Object.keys(PACKAGES).sort(), ["business", "premium", "starter"]);
  t.close();
});

test("phase 1 boundary: with the gate closed, staff deliver the paid project through the existing workflow to customer review", async () => {
  const t = await prodApp();
  const { pid, c } = await paidProject(t);
  const owner = await createStaff(t.db, "owner", "owner@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  // The existing scope control applies: design cannot start until the customer approves the written scope.
  assert.equal((await oc.post(`/staff/projects/${pid}/status`, { to: "design" })).status, 409);
  assert.equal((await oc.post(`/staff/projects/${pid}/scope`, { scope: "Business package: 3 pages (Home, Menu, Contact), contact form, 2 revision rounds." })).status, 303);
  assert.equal((await oc.post(`/staff/projects/${pid}/request-approval`, { kind: "scope", note: "Please confirm the scope" })).status, 303);
  assert.equal((await c.post(`/portal/projects/${pid}/approvals`, { kind: "scope", decision: "approved", notes: "" })).status, 303);
  for (const to of ["design", "development", "internal_qa", "customer_review"]) {
    assert.equal((await oc.post(`/staff/projects/${pid}/status`, { to })).status, 303, to);
    assert.equal((await t.db.prepare(`SELECT status FROM projects WHERE id = ?`).bind(pid).first<{ status: string }>())!.status, to);
  }
  assert.equal(await buildJobs(t), 0, "people did the work; nothing was generated");
  assert.match(await (await oc.get("/staff/projects")).text(), /Delivered by the Crestmont team/);
  t.close();
});

test("phase 1 boundary: flipping AI_BUILD_AUTOMATION changes the release configuration digest, so an approval for \"off\" never authorizes \"on\"", async () => {
  const digest = (s: string) => createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("hex"); // scripts/release-candidate.ts
  const toml = readFileSync("wrangler.toml", "utf8");
  const off = digest(toml), on = digest(toml.replace('AI_BUILD_AUTOMATION = "off"', 'AI_BUILD_AUTOMATION = "on"'));
  assert.notEqual(off, on);
  const t = await createTestApp();
  const owner = await createStaff(t.db, "owner", "founder@crestmont.test");
  const oc = await t.client().login(owner.email, undefined, owner.secret);
  const commit = "abc1234def5678abc1234def5678abc1234def56";
  assert.equal((await oc.post("/staff/readiness/releases", { commit_sha: commit, config_sha256: off, notes: "Phase 1 candidate", rollback_plan: "wrangler rollback to the previous version" })).status, 303);
  const evSet = /name="evidence_set" value="([0-9a-f]{64})"/.exec(await (await oc.get("/staff/readiness/approve")).text())![1];
  assert.equal((await oc.post("/staff/readiness/approve", { decision: "approved", confirm_commit: commit, evidence_set: evSet, notes: "phase 1" })).status, 303);
  const ask = async (config: string) => await (await oc.get(`/api/readiness/release-authorization?commit=${commit}&config=${config}`)).json() as { authorized: boolean; reason: string };
  assert.equal((await ask(off)).authorized, true);
  const reopened = await ask(on);
  assert.equal(reopened.authorized, false);
  assert.match(reopened.reason, /configuration differs/);
  t.close();
});

test("production workflows: provisioning fails closed when an existing Worker's secrets cannot be listed, and never replaces a generated key", () => {
  const wf = readFileSync(".github/workflows/provision-production.yml", "utf8");
  assert.doesNotMatch(wf, /secret list[^\n]*\|\| echo "\[\]" > secrets\.json/, "a listing failure must not read as 'no secrets'");
  assert.match(wf, /workers\/scripts\/\$WORKER\/settings/);
  assert.match(wf, /\[ "\$code" = "404" \]; then echo "\[\]" > secrets\.json/, "only a Worker that does not exist yet starts from an empty list");
  for (const name of ["EVIDENCE_INGEST_SECRET", "CRM_ERASURE_HMAC_KEY", "MFA_ENCRYPTION_KEY"]) {
    assert.match(wf, new RegExp(`grep -qx ${name}; then\\s+echo "${name} already set on \\$WORKER: kept`), `${name} is kept when present`);
  }
  assert.match(wf, /for n in TURNSTILE_SITE_KEY TURNSTILE_SECRET EVIDENCE_INGEST_SECRET CRM_ERASURE_HMAC_KEY; do/);
  assert.match(wf, /"enabled":false,"previews_enabled":false/, "provisioning still forces the draft Worker off the public internet");
});

test("production workflows: scheduled backups and monitoring wait for the first real DEPLOYMENT, not for the URL variable", () => {
  // PRODUCTION_URL is the wrong signal and cannot be made into the right one: deploy-production.yml refuses to start
  // without it, so it is necessarily set BEFORE the first deployment. Both scheduled workflows therefore ask whether
  // deploy-production.yml has ever succeeded. Nothing here is a flag someone has to remember to flip.
  // Normalised: a Windows checkout stores these CRLF, and then a `\n` in any of the patterns below silently never
  // matches, so the test would pass in CI and fail on the machine of whoever edits the workflow.
  const read = (n: string) => readFileSync(`.github/workflows/${n}`, "utf8").replace(/\r\n/g, "\n");
  const backup = read("production-backup.yml");
  const monitor = read("production-health-monitor.yml");

  for (const [name, wf] of [["production-backup.yml", backup], ["production-health-monitor.yml", monitor]] as const) {
    assert.match(wf, /actions: read/, `${name} can read its own Actions history`);
    assert.match(wf, /GH_TOKEN: \$\{\{ github\.token \}\}/, `${name} uses the run's own token, not a secret`);
    assert.match(
      wf,
      /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$DEPLOY_WORKFLOW\/runs\?status=success&per_page=1" --jq "\.total_count"/,
      `${name} asks for successful deploy-production runs`,
    );
    assert.match(wf, /DEPLOY_WORKFLOW: deploy-production\.yml/, `${name} names the deploy workflow once, as data`);
    // A lookup that failed must never be read as "not launched": that is how monitoring and backups go quiet.
    assert.match(wf, /Could not confirm a production deployment/, `${name} treats a failed lookup as a warning, not as a verdict`);
    assert.match(wf, /grep -Eq '\^\[0-9\]\+\$'/, `${name} requires the answer to be a number before comparing it`);
  }

  // The backup decides in a job that names no environment, so deciding never costs an approval.
  assert.match(backup, /\n  gate:\n(?:\s+#[^\n]*\n)*\s+if: github\.ref == 'refs\/heads\/main'\n/, "the gate job is main-only");
  const gate = /\n  gate:\n([\s\S]*?)\n  backup:\n/.exec(backup)?.[1] ?? "";
  assert.ok(gate.length > 0, "the gate job comes before the backup job");
  assert.doesNotMatch(gate, /^\s+environment:/m, "the gate names no environment: deciding must not request a review");
  assert.match(gate, /MANUAL: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/, "a manual backup is still always allowed");
  assert.match(backup, /\n  backup:\n\s+needs: gate\n(?:\s+#[^\n]*\n)*\s+if: needs\.gate\.outputs\.go == 'true'/, "the backup runs only when the gate says so");
  assert.match(backup, /restore-verify:\n\s+needs: backup/, "restore-verify only follows a backup that ran");

  assert.doesNotMatch(monitor.replace(/#.*$/gm, ""), /^\s+environment:/m, "the monitor never names the production environment (no approval prompts)");
  assert.match(monitor, /phase-check\.ts live wrangler\.toml \/tmp\/app\.json\n/, "the monitor compares the running gate with the committed one (not --exact)");
});
