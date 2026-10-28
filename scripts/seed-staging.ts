// Generates the STAGING preview seed: clearly-labelled sample business data built through the real
// services (so every row is valid by construction) plus one demo account per role with RANDOM
// credentials generated on each run. Outputs:
//   --out <file.sql>          INSERT OR IGNORE statements, FK-ordered, safe to apply on top of migrations
//   --credentials <file.md>   demo account emails, passwords and TOTP setup keys (never commit this file)
// Usage: node --no-warnings scripts/seed-staging.ts --out seed.sql --credentials demo-credentials.md
// Staging only. Production is never seeded: there is no code path from this script to production.
import { writeFileSync } from "node:fs";
import { openDb } from "../dev/sqlite-d1.ts";
import { syncRequirements } from "../src/readiness/ingest.ts";
import { applySeedBlockerLinks } from "../src/services/readiness-admin.ts";
import { hashPassword, newTotpSecret, randomToken } from "../src/lib/auth-crypto.ts";
import { newId } from "../src/lib/db.ts";
import { OutboxEmail } from "../src/adapters/email.ts";
import { captureLead, changeLeadStage } from "../src/services/leads.ts";
import { createPackageOrder, provisionProject, markInvoicePaid } from "../src/services/commerce.ts";
import * as P from "../src/services/projects.ts";
import type { Actor, Role } from "../src/domain/authz.ts";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = arg("--out") ?? "seed-staging.sql";
const CREDS = arg("--credentials") ?? "demo-credentials.md";
const DOMAIN = "crestmont-preview.test"; // reserved .test TLD: these addresses can never receive mail

const db = openDb(":memory:");
await syncRequirements(db);
await applySeedBlockerLinks(db);
const email = new OutboxEmail(db);
const ctx = { db, email, baseUrl: "https://staging.invalid", now: () => new Date() } as never;
const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
const day = (daysAhead: number) => new Date(Date.now() + daysAhead * 86400e3).toISOString().slice(0, 10);

// ── Demo accounts (one per role) ──
const creds: { role: string; email: string; password: string; totp: string | null; note: string }[] = [];
db.raw.prepare(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal',?)`).run(iso());
async function staff(role: Role, name: string) {
  const id = newId("usr"), password = randomToken(9), totp = newTotpSecret();
  const em = `${role.replace("_", "-")}@${DOMAIN}`;
  db.raw.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .run(id, em, name, await hashPassword(password), iso(), totp, iso(30));
  db.raw.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?, 'org_crestmont', ?, ?)`).run(newId("mbr"), id, role, iso(30));
  creds.push({ role, email: em, password, totp, note: role === "owner" ? "All 32 Owner modules" : `Staff (${role.replace("_", " ")})` });
  return { id, actor: { kind: "user", userId: id, roles: [{ role, organizationId: "org_crestmont" }], mfaVerified: true } as Actor };
}
const owner = await staff("owner", "Preview Owner");
await staff("administrator", "Preview Administrator");
const sales = await staff("sales", "Preview Sales");
const dev = await staff("developer", "Preview Developer");
const pm = await staff("project_manager", "Preview Project Manager");
const support = await staff("support", "Preview Support");

async function customer(orgName: string, person: string, slug: string) {
  const uid = newId("usr"), org = newId("org"), password = randomToken(9);
  const em = `${slug}@${DOMAIN}`;
  db.raw.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).run(uid, em, person, await hashPassword(password), iso(), iso(20));
  db.raw.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?,?,'customer',?)`).run(org, orgName, iso(20));
  db.raw.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_admin',?)`).run(newId("mbr"), uid, org, iso(20));
  creds.push({ role: "customer_admin", email: em, password, totp: null, note: `Customer portal — ${orgName}` });
  return { uid, org, actor: { kind: "user", userId: uid, roles: [{ role: "customer_admin", organizationId: org }], mfaVerified: true } as Actor };
}
const harbor = await customer("Sample — Harbor Dental Studio", "Dana (sample customer)", "customer.harbor");
const ridge = await customer("Sample — Ridgeline Landscaping", "Sam (sample customer)", "customer.ridgeline");

// ── CRM: leads across stages and sources ──
const leadSpecs = [
  { name: "Morgan Sample", email: `lead1@${DOMAIN}`, company: "Sample — Northside Bakery", interest: "starter", message: "We need a five page site with an online menu and a contact form.", source: "web_form", utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "fall-launch" } },
  { name: "Riley Sample", email: `lead2@${DOMAIN}`, company: "Sample — Lakeside Physio", interest: "business", message: "Looking for a redesign with online booking and better SEO structure.", source: "quote_form", utm: { utm_source: "newsletter", utm_medium: "email" } },
  { name: "Jordan Sample", email: `lead3@${DOMAIN}`, company: "Sample — Summit Legal", interest: "premium", message: "Premium site with client intake forms and a document portal.", source: "quote_form", utm: {} },
  { name: "Casey Sample", email: `lead4@${DOMAIN}`, company: "Sample — Orchard Market", interest: "custom", message: "Custom ordering platform for wholesale customers, integrations with our ERP.", source: "web_form", utm: { utm_source: "linkedin", utm_medium: "social", utm_campaign: "b2b" } },
  { name: "Avery Sample", email: `lead5@${DOMAIN}`, company: "Sample — Pine Street Florist", interest: "maintenance", message: "We have a site already and want ongoing maintenance and updates.", source: "web_form", utm: {} },
];
const leadIds: string[] = [];
for (const l of leadSpecs) {
  const { leadId } = await captureLead(db, { name: l.name, email: l.email, company: l.company, interest: l.interest, message: l.message, source: l.source }, { ip: "198.51.100.10", attribution: { ...l.utm, landing_page: "/pricing" } } as never);
  leadIds.push(leadId);
  db.raw.prepare(`UPDATE leads SET owner_user_id = ? WHERE id = ?`).run(sales.id, leadId);
}
await changeLeadStage(db, owner.actor, leadIds[1], "qualified");
await changeLeadStage(db, owner.actor, leadIds[2], "qualified");
await changeLeadStage(db, owner.actor, leadIds[2], "quote_required");
await changeLeadStage(db, owner.actor, leadIds[4], "lost", { reason: "Sample: chose to stay with current provider" });
db.raw.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, due_at, created_at) VALUES (?,?,?, 'task', 'Sample follow-up: send portfolio and package comparison', ?, ?)`).run(newId("act"), leadIds[0], sales.id, day(2), iso(1));

// ── Paid package orders → provisioned projects at different lifecycle stages ──
async function paidProject(org: string, pkg: "starter" | "business" | "premium", byUser: string) {
  const o = await createPackageOrder(db, org, pkg, byUser);
  await markInvoicePaid(db, o.invoiceId, { amountCents: o.amountCents, paymentIntentId: `pi_sample_${randomToken(6)}`, feeCents: null });
  return provisionProject(db, o.orderId);
}
const p1 = await paidProject(harbor.org, "business", harbor.uid);
const p2 = await paidProject(ridge.org, "starter", ridge.uid);
const pmRef = { actorUserId: pm.id, actorKind: "user" as const };

// Harbor: onboarding done → scope approved → design → development with tasks; one revision used.
await P.setProjectManager(ctx, owner.actor, p1, pm.id);
db.raw.prepare(`INSERT INTO onboarding_responses (project_id, answers_json, completed_at, updated_at) VALUES (?,?,?,?)`)
  .run(p1, JSON.stringify({ business_name: "Sample — Harbor Dental Studio", industry: "Dental care", goals: "More new-patient bookings", sample: true }), iso(10), iso(10));
await P.changeProjectStatus(ctx, p1, "scope_review", pmRef);
await P.recordCustomerApproval(ctx, harbor.actor, { organizationId: harbor.org, projectId: p1, kind: "scope", decision: "approved", notes: "Sample approval", userId: harbor.uid });
await P.changeProjectStatus(ctx, p1, "design", pmRef);
const t1 = await P.createTask(db, pm.actor, p1, { title: "Sample: homepage hero and services layout", estimateMinutes: 240, dueAt: day(3), assigneeId: dev.id });
const t2 = await P.createTask(db, pm.actor, p1, { title: "Sample: booking form integration", estimateMinutes: 360, dueAt: day(7), assigneeId: dev.id });
await P.addDependency(db, pm.actor, t2, t1);
await P.assign(ctx, pm.actor, "task", t1, dev.id);
await P.assign(ctx, pm.actor, "task", t2, dev.id);
await P.setTaskStatus(db, dev.actor, dev.id, t1, "in_progress");
await P.logTime(db, dev.actor, dev.id, t1, { minutes: 90, workedOn: day(-1), hourlyCostCents: null });
await P.requestRevision(ctx, { organizationId: harbor.org, projectId: p1, userId: harbor.uid, text: "Sample revision: please make the booking button more prominent on mobile." });

// Ridgeline: awaiting onboarding (shows the customer's required action).
await P.setProjectManager(ctx, owner.actor, p2, pm.id);

// ── Support and conversations ──
const tk = newId("tkt");
db.raw.prepare(`INSERT INTO tickets (id, organization_id, project_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?,?,?, 'technical', 'normal', 'open', ?, ?, ?)`)
  .run(tk, harbor.org, p1, "Sample ticket: contact form question", harbor.uid, iso(2), iso(2));
db.raw.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,0,?)`).run(newId("tm"), tk, harbor.uid, "Sample: where do contact form submissions go?", iso(2));
db.raw.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,?,?,1,?)`).run(newId("tm"), tk, support.id, "Internal sample note: check the routing address in business settings.", iso(1));
db.raw.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, created_at) VALUES (?,?,?,?,?,?)`).run(newId("msg"), harbor.org, p1, pm.id, "Sample: the first homepage draft will be ready for review on Friday.", iso(1));
db.raw.prepare(`INSERT INTO messages (id, organization_id, project_id, author_user_id, body, created_at) VALUES (?,?,NULL,?,?,?)`).run(newId("msg"), ridge.org, ridge.uid, "Sample general question: can we add a second location later?", iso(1));

// ── Export: INSERT OR IGNORE in foreign-key order ──
// AI Builds rows are never seeded: sample projects must not become automated builds (and settings stay the Owner's).
const SKIP = new Set(["d1_migrations", "sqlite_sequence", "sessions", "rate_limits", "security_events", "auth_tokens", "email_deliveries", "email_messages", "ingestion_status", "_cf_KV",
  "build_settings", "build_project_controls", "build_briefs", "build_jobs", "build_runs", "build_events", "build_requirements", "build_runners"]);
const tables = (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name).filter((t) => !SKIP.has(t));
const deps = new Map(tables.map((t) => [t, new Set((db.raw.prepare(`PRAGMA foreign_key_list("${t}")`).all() as { table: string }[]).map((f) => f.table).filter((x) => x !== t && tables.includes(x)))]));
const ordered: string[] = [];
const visit = (t: string, seen = new Set<string>()) => { if (ordered.includes(t) || seen.has(t)) return; seen.add(t); for (const d of deps.get(t) ?? []) visit(d, seen); ordered.push(t); };
tables.forEach((t) => visit(t));
const lit = (v: unknown) => v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
// Demo users are keyed by their fixed email, but each run generates new random ids. On a re-seed
// (reseed_demo_accounts) the users row is IGNOREd because the email already exists, so every row that pointed at this
// run's id would reference a user that was never inserted: the whole file failed with "FOREIGN KEY constraint
// failed". References to a demo user are therefore emitted as a lookup by email, which resolves to the user just
// inserted on a first seed and to the existing account on a re-seed (its password and 2FA are left untouched).
const demoUserEmail = new Map((db.raw.prepare(`SELECT id, email FROM users`).all() as { id: string; email: string }[]).map((u) => [u.id, u.email]));
const value = (t: string, c: string, v: unknown) =>
  typeof v === "string" && demoUserEmail.has(v) && !(t === "users" && c === "id") ? `(SELECT id FROM users WHERE email = ${lit(demoUserEmail.get(v))})` : lit(v);
const lines = ["-- Crestmont STAGING preview seed (sample data, generated " + new Date().toISOString() + "). Never apply to production.", "PRAGMA defer_foreign_keys = on;"];
let rows = 0;
for (const t of ordered) {
  for (const r of db.raw.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
    const cols = Object.keys(r);
    lines.push(`INSERT OR IGNORE INTO "${t}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => value(t, c, r[c])).join(", ")});`);
    rows++;
  }
}
// Sample projects are created "now": move the automation cutoff past them so the sweep never queues builds for
// sample data (real projects created after this seed still start automatically; the Owner can backfill any project).
lines.push(`UPDATE build_settings SET auto_start_after = '${new Date(Date.now() + 1000).toISOString()}' WHERE id = 1 AND auto_start_after < '${new Date(Date.now() + 1000).toISOString()}';`);
writeFileSync(OUT, lines.join("\n") + "\n");

const md = [
  "# Crestmont staging preview — demo accounts",
  "",
  "Generated " + new Date().toISOString() + ". Valid only on the staging preview. Do not commit or share outside the team.",
  "Staff accounts require two-factor authentication: add the setup key to an authenticator app (1Password, Google Authenticator, Authy), then enter its 6-digit code at sign-in.",
  "",
  "| Role | Email | Password | 2FA setup key | Shows |",
  "|---|---|---|---|---|",
  ...creds.map((c) => `| ${c.role} | ${c.email} | \`${c.password}\` | ${c.totp ? `\`${c.totp}\`` : "—"} | ${c.note} |`),
  "",
  "All business records are sample data labelled “Sample —”. No real payments, emails or calls occur on staging.",
].join("\n");
writeFileSync(CREDS, md + "\n");
console.log(`Seed: ${rows} rows across ${ordered.length} tables → ${OUT}; ${creds.length} demo accounts → ${CREDS}`);
