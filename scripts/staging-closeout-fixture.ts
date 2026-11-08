// Staging-only fixture for the production-closeout verification (.github/workflows/staging-closeout-verify.yml).
//
// It creates, per run, ONE dedicated test customer and ONE website project waiting at the launch gate, so the launch
// gate can be proven against real Stripe test-mode Checkout and the real signed webhooks without touching any demo
// customer's data:
//   - an organisation "Launch Gate E2E <run> (TEST DATA)" and its customer administrator, signed in with a password
//     and a fresh TOTP key (customer administrators need two-factor before any portal write), email verified (payment
//     requires it), at an @example.com address: reserved, so the platform never sends it mail (no bounce, no stranger);
//   - a project in customer review with its maintenance activation due on the Essential plan -- exactly what
//     changeProjectStatus(customer_review) opens for a real project (src/services/maintenance-lifecycle.ts).
// The webhook matches a subscription to the OLDEST due activation of its organisation, which is why each run has its
// own organisation: nothing here can be confused with another customer's subscription.
//
// Nothing is deleted and no existing row is changed. Refuses any environment or URL but staging. The credentials are
// written to the git-ignored access/ directory (removed by the workflow when it ends) and never printed.
import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { wranglerOps } from "./staging-access.ts";
import { hashPassword, newTotpSecret } from "../src/lib/auth-crypto.ts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const url = arg("url") ?? "", environment = arg("environment") ?? "", out = arg("out") ?? "access/closeout-fixture.json";
if (environment !== "staging" || !/staging/.test(url)) { console.error("Refusing: this fixture is for the staging Worker only (--environment staging --url <staging url>)."); process.exit(2); }

const d1 = wranglerOps();
const lit = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);
const run = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const at = new Date().toISOString();
const orgId = `org_e2elg${run}`, userId = `usr_e2elg${run}`, projectId = `prj_e2elg${run}`, actId = `mact_e2elg${run}`;
const email = `launch-gate-${run}@example.com`;
const password = randomBytes(18).toString("base64url");
const totp = newTotpSecret();

const sql = [
  `INSERT INTO organizations (id, name, kind, created_at) VALUES (${lit(orgId)}, ${lit(`Launch Gate E2E ${run} (TEST DATA)`)}, 'customer', ${lit(at)})`,
  `INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (${lit(userId)}, ${lit(email)}, 'Launch Gate Tester (TEST DATA)', ${lit(await hashPassword(password))}, ${lit(at)}, ${lit(totp)}, 1, ${lit(at)})`,
  `INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (${lit(`mbr_e2elg${run}`)}, ${lit(userId)}, ${lit(orgId)}, 'customer_admin', ${lit(at)})`,
  `INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at) VALUES (${lit(projectId)}, ${lit(orgId)}, ${lit(`Launch gate website ${run} (TEST DATA)`)}, 'customer_review', 2, 'upfront', ${lit(at)}, ${lit(at)})`,
  `INSERT INTO maintenance_activations (id, organization_id, project_id, order_id, plan_id, status, trigger, opened_at, created_at, updated_at) VALUES (${lit(actId)}, ${lit(orgId)}, ${lit(projectId)}, NULL, 'essential', 'due', 'ready_for_review', ${lit(at)}, ${lit(at)}, ${lit(at)})`,
];
for (const s of sql) await d1.query(s);
const check = await d1.query<{ status: string }>(`SELECT p.status FROM projects p JOIN maintenance_activations a ON a.project_id = p.id WHERE p.id = ${lit(projectId)} AND a.status = 'due'`);
if (check[0]?.status !== "customer_review") { console.error("The fixture was not written as expected."); process.exit(1); }

mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(out, JSON.stringify({ run, orgId, userId, projectId, activationId: actId, email, password, totp, createdAt: at }, null, 2), { mode: 0o600 });
console.log(`Launch-gate fixture ${run}: organisation ${orgId}, project ${projectId} in customer review, Essential activation due (credentials in ${out}, not printed).`);
