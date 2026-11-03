// AI Website Builder — live staging certification driver for the "Junk in the Trunk" Business-package test
// (Founder directive 2026-11-01). Runs in .github/workflows/builder-staging-e2e.yml against the deployed staging Worker.
//
// It drives the REAL customer workflow: registration, email verification, sign-in, the $2,499 Business package
// checkout, Stripe TEST-mode payment with Stripe's published test card, the signed Stripe webhook, project provisioning
// and the real onboarding form — which queues the AI build that Node 1 must claim. Nothing is simulated: no payment
// is forged, no webhook is synthesised, no row is written to D1 by this script, and no runner is impersonated.
//
// Secret separation (tests/workflow-security.test.ts, F-24): commands that read staging D1 hold the Cloudflare token
// and never load package code; the browser commands load Playwright and receive no secret at all.
//
//   prepare        [token] D1 SELECT only: current state of the test customer; derives its password (never printed).
//   verify-link    [token] D1 SELECT only: the newest verification email in the staging outbox (.test is never mailed).
//   register       [browser, no secret] /register as the fictional customer.
//   purchase       [browser, no secret] verify, sign in, Business checkout, Stripe test payment, onboarding.
//   status         [token] D1 SELECT only: certification evidence; --wait-minutes N polls until the build settles.
//
// Output: PASS/PENDING/FAIL lines, evidence/builder-staging-e2e.json, a GitHub step summary. Only fictional test data,
// ids and runner metadata are printed; never a password, token, key or email body.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JITT_BUSINESS as C } from "../tests/fixtures/junk-in-the-trunk-business.ts";

const cmd = process.argv[2] ?? "";
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg("dir", "jitt")!;
const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const read = <T>(f: string): T | null => (existsSync(join(DIR, f)) ? (JSON.parse(readFileSync(join(DIR, f), "utf8")) as T) : null);
const write = (f: string, v: unknown, mode = 0o644) => { mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, f), JSON.stringify(v, null, 2), { mode }); };
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const clip = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

/** Password for the fictional customer: derived from the staging root key (like scripts/staging-access.ts), so every
 *  run signs in as the same customer without any credential stored anywhere. Exported for the unit test. */
export function customerPassword(rootKey: string): string {
  if (!rootKey) throw new Error("CLOUDFLARE_API_TOKEN is required to derive the test customer's password");
  const h = createHmac("sha256", rootKey).update("crestmont:builder-staging-e2e:junk-in-the-trunk:v1").digest("base64url");
  return `Jt-${h.slice(0, 28)}-9z`;
}

/** The verification link path in a verification email body (re-based on staging by the caller). */
export function verificationPath(body: string): string | null {
  const m = /https?:\/\/[^\s/]+(\/verify-email\?token=[A-Za-z0-9_-]+)/.exec(body);
  return m ? m[1] : null;
}

// ─────────────── D1 (read-only) ───────────────
type Query = <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
/** Only single SELECT statements reach D1. */
export function readOnly(q: Query): Query {
  return (sql) => {
    if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error("builder-staging-e2e only runs single SELECT statements");
    return q(sql);
  };
}
async function d1(): Promise<Query> {
  const { wranglerOps } = await import("./staging-access.ts");
  const ops = wranglerOps();
  return readOnly((sql) => ops.query(sql));
}
const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };

interface CustomerState { userId: string | null; verified: boolean; orgId: string | null; projectId: string | null; paidOrderId: string | null; onboarded: boolean }
async function customerState(q: Query): Promise<CustomerState> {
  const u = (await q<{ id: string; email_verified_at: string | null }>(`SELECT id, email_verified_at FROM users WHERE email = ${lit(C.email)}`))[0];
  if (!u) return { userId: null, verified: false, orgId: null, projectId: null, paidOrderId: null, onboarded: false };
  const org = (await q<{ organization_id: string }>(`SELECT m.organization_id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ${lit(u.id)} AND o.kind = 'customer' ORDER BY m.created_at LIMIT 1`))[0]?.organization_id ?? null;
  const paid = org ? (await q<{ id: string }>(`SELECT id FROM orders WHERE organization_id = ${lit(org)} AND status = 'paid' AND total_cents = ${C.packageCents} ORDER BY created_at LIMIT 1`))[0]?.id ?? null : null;
  const prj = paid ? (await q<{ id: string }>(`SELECT id FROM projects WHERE order_id = ${lit(paid)} LIMIT 1`))[0]?.id ?? null : null;
  const onb = prj ? Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM onboarding_responses WHERE project_id = ${lit(prj)} AND completed_at IS NOT NULL`))[0]?.n ?? 0) > 0 : false;
  return { userId: u.id, verified: !!u.email_verified_at, orgId: org, projectId: prj, paidOrderId: paid, onboarded: onb };
}

// ─────────────── certification report ───────────────
type Verdict = "PASS" | "PENDING" | "FAIL" | "BLOCKED";
interface Step { step: string; verdict: Verdict; evidence: string }
const ageMin = (iso: string | null | undefined) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 60_000) : null);

export async function report(q: Query): Promise<{ steps: Step[]; data: Record<string, unknown> }> {
  const s = await customerState(q);
  const steps: Step[] = [];
  const add = (step: string, verdict: Verdict, evidence: string) => steps.push({ step, verdict, evidence: clip(evidence, 400) });
  const data: Record<string, unknown> = { customer: s };

  add("Customer registration", s.userId ? "PASS" : "PENDING", s.userId ? `user ${s.userId}, organization ${s.orgId ?? "—"}, email verified: ${s.verified}` : "the test customer has not registered yet");

  const orders = s.orgId ? await q<{ id: string; status: string; total_cents: number; created_at: string }>(`SELECT id, status, total_cents, created_at FROM orders WHERE organization_id = ${lit(s.orgId)} ORDER BY created_at`) : [];
  const plan = s.orgId ? await safe(() => q<{ id: string; maintenance_plan_id: string | null; maintenance_plan_source: string | null }>(`SELECT id, maintenance_plan_id, maintenance_plan_source FROM orders WHERE organization_id = ${lit(s.orgId!)} ORDER BY created_at`), null) : null;
  data.orders = orders; data.orderPlans = plan;
  const business = orders.find((o) => o.total_cents === C.packageCents);
  add("Package selection", business ? "PASS" : "PENDING", business ? `order ${business.id}: ${business.total_cents / 100} USD, ${business.status}` : "no $2,499 Business order yet");
  const committed = plan?.find((o) => o.id === business?.id);
  add("Maintenance selection", plan === null ? "BLOCKED" : committed?.maintenance_plan_id === C.maintenancePlanId ? "PASS" : business ? "FAIL" : "PENDING",
    plan === null ? "staging has no orders.maintenance_plan_id: the plan picker (FD-26, PR #108) is not deployed, so no plan can be recorded at checkout"
      : committed ? `plan on order: ${committed.maintenance_plan_id ?? "none"} (${committed.maintenance_plan_source ?? "—"})` : "no Business order yet");

  const pays = s.orgId ? await q<{ id: string; amount_cents: number; status: string; stripe_payment_intent_id: string | null; created_at: string }>(`SELECT id, amount_cents, status, stripe_payment_intent_id, created_at FROM payments WHERE organization_id = ${lit(s.orgId)} ORDER BY created_at`) : [];
  data.payments = pays;
  const pay = pays.find((p) => p.amount_cents === C.packageCents && p.status === "succeeded" && p.stripe_payment_intent_id);
  const events = business ? await safe(() => q<{ type: string; status: string; received_at: string }>(`SELECT type, status, received_at FROM stripe_events WHERE payload LIKE ${lit(`%${business.id}%`)} ORDER BY received_at`), []) : [];
  data.stripeEvents = events;
  add("Payment", pay ? "PASS" : "PENDING", pay ? `payment ${pay.id}, Stripe test PaymentIntent ${pay.stripe_payment_intent_id}, ${pay.amount_cents / 100} USD; signed webhook events: ${events.map((e) => `${e.type}=${e.status}`).join(", ") || "not matched by order id"}` : "no succeeded $2,499 Stripe payment yet");
  const recurring = pays.filter((p) => p.amount_cents === C.maintenanceMonthlyCents);
  data.prelaunchMaintenanceCharges = recurring.length;

  const prj = s.projectId ? (await q<{ id: string; status: string; revision_allowance: number; payment_schedule: string; product_id: string | null }>(`SELECT id, status, revision_allowance, payment_schedule, product_id FROM projects WHERE id = ${lit(s.projectId)}`))[0] : undefined;
  data.project = prj ?? null;
  add("Project creation", prj ? "PASS" : "PENDING", prj ? `project ${prj.id}: ${prj.status}, ${prj.revision_allowance} revision rounds, ${prj.payment_schedule}; onboarding submitted: ${s.onboarded}` : "no project yet");

  const jobs = s.projectId ? await q<{ id: string; kind: string; revision: number; state: string; state_reason: string | null; strategy: string; package_id: string | null; attempts: number; lease_runner: string | null; preview_url: string | null; created_at: string; started_at: string | null; finished_at: string | null; customer_revision_id?: string | null }>(`SELECT * FROM build_jobs WHERE project_id = ${lit(s.projectId)} ORDER BY created_at`) : [];
  data.buildJobs = jobs.map((j) => ({ id: j.id, kind: j.kind, revision: j.revision, state: j.state, reason: clip(j.state_reason), strategy: j.strategy, package: j.package_id, attempts: j.attempts, runner: j.lease_runner, preview: j.preview_url, created: j.created_at, started: j.started_at, finished: j.finished_at }));
  const first = jobs.find((j) => j.kind === "first_build");
  add("Build dispatch", first && first.state !== "awaiting_intake" && first.state !== "awaiting_payment" ? "PASS" : "PENDING", first ? `job ${first.id}: ${first.state}${first.state_reason ? ` (${clip(first.state_reason, 120)})` : ""}, strategy ${first.strategy}, package ${first.package_id}` : "no build job yet");

  const runs = first ? await q<{ job_id: string; attempt: number; runner_id: string; started_at: string; ended_at: string | null; outcome: string | null; provider?: string | null; model?: string | null; error: string | null }>(`SELECT * FROM build_runs WHERE job_id IN (${jobs.map((j) => lit(j.id)).join(",")}) ORDER BY started_at`) : [];
  data.buildRuns = runs.map((r) => ({ attempt: r.attempt, runner: r.runner_id, provider: r.provider ?? null, model: r.model ?? null, started: r.started_at, ended: r.ended_at, outcome: r.outcome, error: clip(r.error) }));
  const firstRuns = runs.filter((r) => r.job_id === first?.id);
  const claimed = firstRuns[0];
  add("Node 1 execution", claimed ? (claimed.provider === "local" || claimed.provider === null ? "PASS" : "FAIL") : "PENDING",
    claimed ? `runner ${claimed.runner_id} claimed attempt ${claimed.attempt} at ${claimed.started_at}; provider ${claimed.provider ?? "not reported"}, model ${claimed.model ?? "not reported"}` : "no runner has claimed the build");
  const done = first && ["ready_for_review", "approved"].includes(first.state);
  add("AI generation", done ? "PASS" : first?.state === "failed" ? "FAIL" : "PENDING", first ? `state ${first.state}; source ${clip((first as unknown as { source_commit?: string }).source_commit ?? "—", 60)}` : "—");
  const reqs = first ? await q<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM build_requirements WHERE job_id = ${lit(first.id)} GROUP BY status`) : [];
  data.requirements = reqs;
  const quality = first ? await safe(() => q<Record<string, unknown>>(`SELECT * FROM build_quality WHERE job_id = ${lit(first.id)} ORDER BY created_at DESC LIMIT 1`), []) : [];
  data.quality = quality[0] ?? null;
  add("Build validation", done ? "PASS" : "PENDING", `requirements ${reqs.map((r) => `${r.status}=${r.n}`).join(", ") || "—"}`);
  add("Preview", first?.preview_url ? "PASS" : "PENDING", first?.preview_url ? `preview ${first.preview_url}` : "no preview URL recorded");

  const revs = jobs.filter((j) => j.kind === "revision");
  add("Revision request", "PENDING", "driven after the first preview is shared (not yet automated by this driver)");
  add("AI revision", revs.some((r) => ["ready_for_review", "approved"].includes(r.state)) ? "PASS" : "PENDING", revs.length ? revs.map((r) => `${r.id}: ${r.state}`).join("; ") : "no revision job");
  add("Revised preview", revs.some((r) => r.preview_url) ? "PASS" : "PENDING", revs.find((r) => r.preview_url)?.preview_url ?? "—");
  add("Customer approval", first?.state === "approved" ? "PASS" : "PENDING", first?.state === "approved" ? "build approved" : "not approved");
  add("Staging launch", "BLOCKED", "no deploy-capable runner (PRODUCTION_DEPLOY_COMMAND) or staging launch destination exists (docs/ai-builds/DELIVERY.md)");

  const subs = s.orgId ? await q<{ id: string; product_id: string; status: string; stripe_subscription_id: string | null }>(`SELECT id, product_id, status, stripe_subscription_id FROM subscriptions WHERE organization_id = ${lit(s.orgId)}`) : [];
  const activation = s.projectId ? await safe(() => q<Record<string, unknown>>(`SELECT * FROM maintenance_activations WHERE project_id = ${lit(s.projectId!)}`), null) : null;
  data.subscriptions = subs; data.maintenanceActivations = activation;
  add("Subscription", subs.length > 1 ? "FAIL" : recurring.length ? "FAIL" : "PENDING",
    `subscriptions ${subs.length}; maintenance charges before launch: ${recurring.length}; activation rows: ${activation === null ? "table absent (FD-27, PR #110, not deployed)" : activation.length}`);

  // Runner / Node 1 health (platform view; written by the runner's signed polls)
  const runners = await q<{ runner_id: string; version: string | null; capabilities: string | null; last_seen_at: string }>(`SELECT runner_id, version, capabilities, last_seen_at FROM build_runners ORDER BY last_seen_at DESC LIMIT 5`);
  data.runners = runners.map((r) => ({ id: r.runner_id, version: r.version, zeroCost: /zero-token-cost/.test(r.capabilities ?? ""), lastSeen: r.last_seen_at, ageMinutes: ageMin(r.last_seen_at) }));
  const workers = await safe(() => q<{ id: string; label: string; enabled: number; dispatch_paused: number; runner_id: string | null; last_seen_at: string | null; model_state: string | null; loaded_models_json: string | null; last_error: string | null }>(`SELECT id, label, enabled, dispatch_paused, runner_id, last_seen_at, model_state, loaded_models_json, last_error FROM build_workers`), []);
  data.workers = workers.map((w) => ({ id: w.id, label: w.label, enabled: !!w.enabled, paused: !!w.dispatch_paused, runner: w.runner_id, lastSeen: w.last_seen_at, ageMinutes: ageMin(w.last_seen_at), modelState: w.model_state, models: clip(w.loaded_models_json, 200), lastError: clip(w.last_error) }));
  const diag = await safe(() => q<{ id: string; created_at: string }>(`SELECT id, created_at FROM runner_diagnostics ORDER BY created_at DESC LIMIT 1`), []);
  const cps = diag[0] ? await q<{ code: string; ok: number; worker: string | null; error: string | null }>(`SELECT code, ok, worker, error FROM runner_diagnostic_checkpoints WHERE diagnostic_id = ${lit(diag[0].id)} ORDER BY code, id`) : [];
  data.latestDiagnostic = diag[0] ? { id: diag[0].id, created: diag[0].created_at, checkpoints: cps.map((c) => `${c.code}:${c.ok ? "ok" : `FAIL ${clip(c.error, 80)}`}`) } : null;
  const fresh = runners.find((r) => (ageMin(r.last_seen_at) ?? 1e9) <= 5);
  data.node1Online = !!fresh;

  const ev = jobs.length ? await q<{ at: string; kind: string; to_state: string | null; message: string; actor_kind: string }>(`SELECT at, kind, to_state, message, actor_kind FROM build_events WHERE job_id IN (${jobs.map((j) => lit(j.id)).join(",")}) ORDER BY id DESC LIMIT 25`) : [];
  data.buildEvents = ev.reverse().map((e) => `${e.at} ${e.actor_kind}/${e.kind}${e.to_state ? `→${e.to_state}` : ""}: ${clip(e.message, 140)}`);
  return { steps, data };
}

function emit(steps: Step[], data: Record<string, unknown>) {
  mkdirSync("evidence", { recursive: true });
  writeFileSync("evidence/builder-staging-e2e.json", JSON.stringify({ at: new Date().toISOString(), steps, data }, null, 2));
  for (const st of steps) console.log(`${st.verdict.padEnd(7)} ${st.step} — ${st.evidence}`);
  const runners = (data.runners as { id: string; version: string | null; ageMinutes: number | null }[]) ?? [];
  console.log(`Runners: ${runners.map((r) => `${r.id} v${r.version ?? "?"} last seen ${r.ageMinutes ?? "?"} min ago`).join("; ") || "none has ever authenticated"}`);
  console.log(`Node 1 online (a runner polled within 5 min): ${data.node1Online}`);
  if (data.latestDiagnostic) console.log(`Latest diagnostic: ${JSON.stringify(data.latestDiagnostic)}`);
  for (const e of (data.buildEvents as string[]) ?? []) console.log(`  event ${e}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = steps.map((st) => `| ${st.step} | ${st.verdict} | ${st.evidence.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`);
    appendFileSync(summary, [`### Junk in the Trunk — AI website builder staging certification`, "", "| Step | Result | Evidence |", "|---|---|---|", ...rows, "",
      `Node 1 online (a runner polled within 5 min): **${data.node1Online}** · runners: ${runners.map((r) => `${r.id} (${r.ageMinutes ?? "?"} min)`).join(", ") || "none"}`, ""].join("\n"));
  }
}

// ─────────────── browser (no secrets in this process) ───────────────
type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Playwright is loaded at runtime (zero-dependency repo)
async function browserPage(): Promise<{ page: Page; close: () => Promise<void>; issues: string[] }> {
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.ACCESS_ROOT_KEY) throw new Error("browser commands must not hold the Cloudflare token (F-24)");
  const { launchBrowser } = await import("../tests/e2e/support.ts");
  const browser = await launchBrowser();
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  const issues: string[] = [];
  page.on("pageerror", (e: Error) => issues.push(`JS error: ${clip(e.message)}`));
  page.on("response", (r: { status(): number; url(): string }) => { if (r.status() >= 500 && r.url().startsWith(BASE)) issues.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  return { page, issues, close: async () => { await ctx.close(); await browser.close(); } };
}
const nav = async (page: Page, sel: string | { click(): Promise<void> }) => {
  const loc = typeof sel === "string" ? page.locator(sel) : sel;
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), loc.click()]);
};
const main = async (page: Page) => clip(await page.locator("main").first().innerText(), 2000);
const alerts = async (page: Page) => (await page.locator(".alert, .toast").allInnerTexts().catch(() => [])).join(" | ");
async function awaitTurnstile(page: Page) {
  if (!(await page.locator(".cf-turnstile").count())) return;
  const token = page.locator("[name='cf-turnstile-response']").first();
  for (const until = Date.now() + 30_000; ; await page.waitForTimeout(250)) {
    if ((await token.count()) && (await token.inputValue())) return;
    if (Date.now() > until) throw new Error("Turnstile produced no token within 30s");
  }
}
function customer(): { email: string; password: string } {
  const c = read<{ email: string; password: string }>("customer.json");
  if (!c) throw new Error(`${DIR}/customer.json missing: run prepare first`);
  return c;
}
async function signIn(page: Page) {
  const c = customer();
  await page.goto(BASE + "/login");
  await page.fill("#f-email", c.email);
  await page.fill("#f-password", c.password);
  await nav(page, "button[type=submit]");
  const path = new URL(page.url()).pathname;
  if (path.startsWith("/mfa")) throw new Error("the customer account now requires two-factor authentication (FD-30); enrol the test customer's TOTP in this driver before continuing");
  if (path.startsWith("/login")) throw new Error(`customer sign-in refused: ${await alerts(page)}`);
}

/** Stripe-hosted Checkout in TEST mode with Stripe's published test card (same procedure as staging journey 5). */
async function payOnStripeCheckout(page: Page) {
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
  if (!/\/c\/pay\/cs_test_/.test(page.url())) throw new Error("refusing: not a Stripe TEST-mode checkout session");
  const cardNumber = page.locator("#cardNumber");
  const cardButton = page.locator('[data-testid="card-accordion-item-button"]').first();
  await Promise.any([cardNumber.waitFor({ state: "visible", timeout: 30_000 }), cardButton.waitFor({ state: "attached", timeout: 30_000 })]).catch(() => undefined);
  if (!(await cardNumber.isVisible()) && (await cardButton.count())) await cardButton.dispatchEvent("click");
  await cardNumber.waitFor({ state: "visible", timeout: 30_000 });
  await cardNumber.fill("4242 4242 4242 4242");
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  if (await page.locator("#billingName").count()) await page.locator("#billingName").fill("Casey Trunkwell");
  if (await page.locator("#billingPostalCode").isVisible().catch(() => false)) await page.locator("#billingPostalCode").fill("48933");
  if (await page.locator("#email").isEditable().catch(() => false)) await page.locator("#email").fill(C.email);
  const link = page.locator("#enableStripePass");
  if ((await link.count()) && (await link.isChecked())) await link.dispatchEvent("click");
  if ((await link.count()) && (await link.isChecked())) await link.setChecked(false, { force: true });
  await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
  await page.waitForURL((u: URL) => u.href.startsWith(BASE), { timeout: 90_000 });
}

async function register() {
  const st = read<CustomerState>("state.json");
  if (st?.userId) { console.log(`SKIP register — the test customer already exists (${st.userId})`); return; }
  const { page, close, issues } = await browserPage();
  try {
    const c = customer();
    await page.goto(BASE + "/register");
    await page.fill("#f-name", "Casey Trunkwell");
    await page.fill("#f-organization", C.business);
    await page.fill("#f-email", c.email);
    await page.fill("#f-password", c.password);
    await page.check("input[name=terms]");
    await awaitTurnstile(page);
    await nav(page, "button[type=submit]");
    const h1 = await page.locator("h1").first().innerText();
    if (!/Check your email/i.test(h1)) throw new Error(`registration did not complete: ${h1} ${await alerts(page)}`);
    console.log("PASS register — the fictional customer registered; staging recorded the verification email in its outbox (.test is never mailed)");
    if (issues.length) console.log(`WARN page issues: ${issues.join("; ")}`);
  } finally { await close(); }
}

async function fillOnboarding(page: Page) {
  const a = C.intake as Record<string, string | readonly string[]>;
  // Radios first: they reveal the conditional fields (showWhen).
  for (const [k, v] of Object.entries(a)) if (typeof v === "string" && (await page.locator(`input[type=radio][name="${k}"]`).count())) await page.check(`input[type=radio][name="${k}"][value="${v}"]`);
  for (const v of a.functionality as readonly string[]) await page.check(`input[type=checkbox][name="functionality"][value="${v}"]`);
  for (const [k, v] of Object.entries(a)) {
    if (typeof v !== "string") continue;
    const f = page.locator(`input[type=text][name="${k}"], input[type=email][name="${k}"], input[type=tel][name="${k}"], textarea[name="${k}"]`).first();
    if (await f.count()) await f.fill(v);
  }
}

async function purchase() {
  const st = read<CustomerState>("state.json");
  const v = read<{ path: string }>("verify.json");
  const { page, close, issues } = await browserPage();
  const out: Record<string, unknown> = {};
  try {
    if (st && !st.verified) {
      if (!v?.path) throw new Error("no verification link was found in the staging outbox");
      await page.goto(BASE + v.path);
      console.log(`PASS email verification — ${clip(await alerts(page), 120)}`);
    }
    await signIn(page);
    console.log("PASS sign-in as the fictional customer");
    let projectId = st?.projectId ?? null;
    if (!st?.paidOrderId) {
      await page.goto(BASE + "/checkout/business");
      const body = await main(page);
      if (!/\$2,499\.00/.test(body)) throw new Error(`the Business checkout does not show $2,499.00: ${clip(body, 200)}`);
      const picker = page.locator(`select[name="maintenance_plan_id"], input[name="maintenance_plan_id"]`);
      out.planPicker = (await picker.count()) > 0;
      if (out.planPicker) {
        if (await page.locator(`select[name="maintenance_plan_id"]`).count()) await page.selectOption(`select[name="maintenance_plan_id"]`, C.maintenancePlanId);
        else await page.check(`input[name="maintenance_plan_id"][value="${C.maintenancePlanId}"]`);
        console.log(`PASS maintenance plan selected at checkout: ${C.maintenancePlanId}`);
      } else console.log("NOTE the Business checkout has no maintenance plan picker on this deployment (FD-26 / PR #108 not deployed)");
      out.recurringAtCheckout = /\$199(\.00)?\s*\/\s*mo/i.test(body) && !/(launch|launched|approved)/i.test(body);
      await page.check("input[name=terms]");
      const pay = page.getByRole("button", { name: /^Pay \$2,499\.00$/ }).first();
      await nav(page, pay);
      await payOnStripeCheckout(page);
      console.log("PASS Stripe TEST-mode checkout completed with the published test card; returned to staging");
      // The signed webhook provisions the project asynchronously.
      for (const end = Date.now() + 180_000; !projectId; await page.waitForTimeout(5_000)) {
        await page.goto(BASE + "/portal/projects");
        const href = await page.locator(`main a[href^="/portal/projects/prj_"]`).first().getAttribute("href").catch(() => null);
        if (href) projectId = href.split("/")[3];
        if (Date.now() > end) throw new Error("the project was not provisioned within 180 s of the Stripe payment (webhook not processed?)");
      }
      console.log(`PASS the signed Stripe webhook provisioned project ${projectId}`);
    }
    out.projectId = projectId;
    if (!st?.onboarded) {
      await page.goto(`${BASE}/portal/projects/${projectId}/onboarding`);
      await fillOnboarding(page);
      await nav(page, page.getByRole("button", { name: /^Submit onboarding$/ }).first());
      const after = `${await alerts(page)} ${await main(page)}`;
      if (/is required|invalid choice|must /i.test(await alerts(page))) throw new Error(`onboarding refused: ${clip(after, 300)}`);
      console.log(`PASS onboarding submitted — ${clip(await alerts(page), 160)}`);
    } else console.log("SKIP onboarding — already submitted");
    out.pageIssues = issues;
    if (issues.length) console.log(`WARN page issues: ${issues.join("; ")}`);
  } finally {
    write("browser-result.json", out);
    await close();
  }
}

// ─────────────── CLI ───────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (cmd === "prepare") {
      const pw = customerPassword(process.env.CLOUDFLARE_API_TOKEN ?? "");
      console.log(`::add-mask::${pw}`);
      const { passwordProblems } = await import("../src/lib/auth-crypto.ts");
      const problems = passwordProblems(pw, C.email);
      if (problems.length) throw new Error(`derived password rejected by the platform's policy: ${problems.join("; ")}`);
      write("customer.json", { email: C.email, password: pw }, 0o600);
      const st = await customerState(await d1());
      write("state.json", st);
      console.log(`Test customer state: ${JSON.stringify(st)}`);
    } else if (cmd === "verify-link") {
      const q = await d1();
      const st = await customerState(q);
      if (st.verified || !st.userId) { console.log(st.verified ? "SKIP verify-link — already verified" : "verify-link: the customer has not registered"); process.exit(st.userId ? 0 : 1); }
      const body = (await q<{ text_body: string }>(`SELECT m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = ${lit(C.email)} AND d.template = 'verification' ORDER BY d.created_at DESC LIMIT 1`))[0]?.text_body ?? "";
      const path = verificationPath(body);
      if (!path) throw new Error("no verification email for the test customer in the staging outbox");
      console.log(`::add-mask::${path.split("=")[1]}`);
      write("verify.json", { path }, 0o600);
      console.log("PASS verification link read from the staging outbox (D1, read-only)");
    } else if (cmd === "register") await register();
    else if (cmd === "purchase") await purchase();
    else if (cmd === "status") {
      const q = await d1();
      const wait = Math.min(Number(arg("wait-minutes", "0")) || 0, 330);
      const end = Date.now() + wait * 60_000;
      for (;;) {
        const r = await report(q);
        const job = (r.data.buildJobs as { kind: string; state: string }[] | undefined)?.find((j) => j.kind === "first_build");
        const settled = !job || ["ready_for_review", "approved", "failed", "canceled", "needs_information", "budget_paused", "paused"].includes(job.state);
        if (settled || Date.now() >= end) { emit(r.steps, r.data); break; }
        console.log(`… ${new Date().toISOString()} build ${job.state}; node1Online=${r.data.node1Online}; waiting`);
        await new Promise((res) => setTimeout(res, 120_000));
      }
    } else { console.error("usage: builder-staging-e2e.ts prepare|verify-link|register|purchase|status [--dir jitt] [--wait-minutes N]"); process.exit(2); }
  } catch (e) {
    console.log(`::error title=Builder staging E2E (${cmd})::${clip((e as Error).message, 400)}`);
    process.exit(1);
  }
}
