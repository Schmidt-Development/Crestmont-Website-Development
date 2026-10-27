// Route security matrix, part 1: exhaustive inventory and server-side authorization of EVERY
// registered route (AUTH-007, EMP-002). Routes are enumerated from the router itself
// (src/routes/index.ts#listRoutes), never scraped from source, and each must be classified in
// tests/support/route-inventory.ts. Every record created here is TEST DATA.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { routeTable } from "../src/routes/index.ts";
import { STAFF_ROLES } from "../src/domain/authz.ts";
import { ROUTE_INVENTORY } from "./support/route-inventory.ts";
import { buildWorld, type World } from "./support/security-world.ts";
import { routes, classified, pathFor, call, snapshot, changedTables, appErrors, toLogin, toMfa, loc, type RouteEntry } from "./support/security-helpers.ts";
import { createCustomer, TEST_PASSWORD } from "./support/app.ts";
import { newTotpSecret } from "../src/lib/auth-crypto.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

let w: World;
before(async () => { w = await buildWorld(); });

const isAuthenticatedKind = (r: RouteEntry) => ["session", "customer", "staff", "authflow"].includes(r.spec.access.kind);
const describe = async (res: Response) => `${res.status}${res.headers.get("location") ? ` → ${res.headers.get("location")}` : ""} ${res.status >= 400 ? (await res.clone().text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160) : ""}`;

test("[AUTH-007] route inventory: every registered route is classified, params are typed, and no route is shadowed", () => {
  const all = routes();
  assert.ok(all.length >= 300, `expected the full route table, got ${all.length}`);
  const unclassified = all.filter((r) => !r.spec).map((r) => r.key);
  assert.deepEqual(unclassified, [], "every new route must be added to tests/support/route-inventory.ts with its access class (and audit class when it changes state)");
  const registered = new Set(all.map((r) => r.key));
  assert.deepEqual(Object.keys(ROUTE_INVENTORY).filter((k) => !registered.has(k)), [], "inventory entries must name registered routes");
  assert.equal(new Set(all.map((r) => r.key)).size, all.length, "no duplicate method+pattern registrations");
  const table = routeTable();
  const problems: string[] = [];
  for (const r of classified()) {
    const names = [...r.pattern.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]).sort();
    const typed = Object.keys(r.spec.params ?? {}).sort();
    if (names.join() !== typed.join()) problems.push(`${r.key}: params ${names.join(",")} typed as ${typed.join(",")}`);
    // An authenticated route that changes state (or exports data) must carry an audit classification.
    if (r.method === "POST" && isAuthenticatedKind(r) && r.spec.access.kind !== "authflow" && !r.spec.audit) problems.push(`${r.key}: state-changing route without an audit classification`);
    if (r.spec.access.kind === "staff" && r.spec.access.roles.length === 0) problems.push(`${r.key}: no role may call it`);
    // Shadowing: a concrete path for this route must resolve to this route, not an earlier one.
    const concrete = r.pattern.replace(/:([A-Za-z]+)/g, (_, k) => `zzshadow-${k}`);
    const m = table.match(r.method, concrete);
    if (m?.pattern !== r.pattern) problems.push(`${r.key}: shadowed by ${m?.pattern}`);
  }
  assert.deepEqual(problems, []);
});

test("[AUTH-007] anonymous visitors are denied on every non-public route (redirect to sign-in or 401), never served data, never a 500", async () => {
  const anon = w.anon();
  const errors0 = appErrors(w.db);
  const before = snapshot(w.db);
  const problems: string[] = [];
  let checked = 0;
  for (const r of classified()) {
    const kind = r.spec.access.kind;
    if (kind === "public") continue;
    const path = pathFor(w, r);
    const res = await call(anon, r, path);
    checked++;
    let ok: boolean;
    if (kind === "signed" || kind === "webhook") ok = res.status === 401;
    else if (kind === "token") ok = res.status < 500; // the URL token is the capability; forged tokens are checked below
    else if (r.spec.api) ok = res.status === 401;
    else ok = toLogin(res);
    if (!ok) problems.push(`${r.key} → ${await describe(res)}`);
  }
  // Token routes with a forged token must not resolve.
  for (const p of ["/share/forged-token-000", "/q/forged-token-000"]) {
    const res = await anon.get(p);
    if (res.status !== 404) problems.push(`GET ${p} with a forged token → ${res.status}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 200);
  assert.equal(appErrors(w.db), errors0, "no request produced a server error");
  assert.deepEqual(changedTables(before, snapshot(w.db)).filter((t) => t !== "share_links"), [], "anonymous requests changed no state (share link access counters aside)");
});

test("[AUTH-007] password-only sessions (MFA not completed) reach nothing beyond the sign-in flow — staff and customers with 2FA", async () => {
  // A staff member and a customer with two-factor enabled who have entered only their password.
  const staffClient = w.app.client();
  const res1 = await staffClient.post("/login", { email: w.staff.owner.email, password: TEST_PASSWORD });
  assert.ok(toMfa(res1), "staff sign-in stops at the MFA challenge");
  // The 2FA customer is also an administrator of tenant A, so a missing MFA check would expose A's records.
  const cu = await createCustomer(w.db, "twofactor@matrix.example", "ZZTWOFA Org");
  await w.db.prepare(`UPDATE users SET totp_secret = ?, mfa_enabled = 1 WHERE id = ?`).bind(newTotpSecret(), cu.id).run();
  await w.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?, 'customer_admin', ?)`).bind(`mbr_twofa_${Date.now()}`, cu.id, w.a.orgId, new Date().toISOString()).run();
  const custClient = w.app.client();
  assert.ok(toMfa(await custClient.post("/login", { email: cu.email, password: TEST_PASSWORD })), "customer with 2FA stops at the MFA challenge");
  const errors0 = appErrors(w.db);
  const before = snapshot(w.db);
  const problems: string[] = [];
  for (const [who, c] of [["staff", staffClient], ["customer", custClient]] as const) {
    for (const r of classified()) {
      const kind = r.spec.access.kind;
      if (!["session", "customer", "staff"].includes(kind) && !(r.key === "POST /mfa/setup")) continue;
      const res = await call(c, r, pathFor(w, r, w.a));
      const denied = r.spec.api ? [401, 403].includes(res.status) : toMfa(res) || toLogin(res) || res.status === 401 || res.status === 403;
      if (!denied) problems.push(`${who}: ${r.key} → ${await describe(res)}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(changedTables(before, snapshot(w.db)), [], "half-authenticated sessions changed no state");
});

test("[EMP-002] role matrix: every staff role without the route's permission is denied server-side; permitted roles are served", async () => {
  const errors0 = appErrors(w.db);
  const staffRoutes = classified().filter((r) => r.spec.access.kind === "staff");
  assert.ok(staffRoutes.length > 150);
  const before = snapshot(w.db);
  const problems: string[] = [];
  let denials = 0;
  for (const r of staffRoutes) {
    const allowed = (r.spec.access as { roles: readonly string[] }).roles;
    for (const role of STAFF_ROLES) {
      if (allowed.includes(role)) continue;
      const res = await call(w.staff[role].c, r, pathFor(w, r));
      denials++;
      const denied = r.spec.api ? res.status === 403 : res.status === 403 || res.status === 404;
      if (!denied) problems.push(`${role}: ${r.key} → ${await describe(res)}`);
    }
  }
  assert.deepEqual(problems, [], "roles lacking the permission must get 403 (or 404 when the record is hidden from them)");
  assert.ok(denials > 400, `exercised ${denials} denials`);
  assert.equal(appErrors(w.db), errors0, "no denial produced a server error");
  assert.deepEqual(changedTables(before, snapshot(w.db)), [], "denied requests changed no state");

  // Positive control: every permitted role is served every parameterless staff page, and the Owner every
  // staff page addressed with real record ids (so the denials above are authorization, not missing data).
  const served: string[] = [];
  for (const r of staffRoutes.filter((x) => x.method === "GET")) {
    const roles = (r.spec.access as { roles: readonly string[] }).roles;
    for (const role of r.spec.params ? roles.filter((x) => x === "owner") : roles) {
      const res = await w.staff[role as keyof World["staff"]].c.get(pathFor(w, r));
      if (res.status !== 200) served.push(`${role}: ${r.key} → ${await describe(res)}`);
    }
  }
  assert.deepEqual(served, [], "permitted roles are served");
});

test("[AUTH-007] customers are denied every /staff route; staff are denied customer-only routes; customer members are denied admin-only actions", async () => {
  const errors0 = appErrors(w.db);
  const before = snapshot(w.db);
  const problems: string[] = [];
  for (const r of classified()) {
    const k = r.spec.access;
    if (k.kind === "staff") {
      for (const c of [w.a.admin.c, w.a.member.c]) {
        const res = await call(c, r, pathFor(w, r, w.a));
        if (!(r.spec.api ? res.status === 403 : res.status === 403)) problems.push(`customer: ${r.key} → ${await describe(res)}`);
      }
    }
    if (k.kind === "customer" && !k.staffToo) {
      const res = await call(w.staff.owner.c, r, pathFor(w, r, w.a));
      if (res.status !== 403) problems.push(`staff owner: ${r.key} → ${await describe(res)}`);
    }
    if (k.kind === "customer" && k.admin && r.method === "POST") {
      const res = await call(w.a.member.c, r, pathFor(w, r, w.a));
      const failsClosedForAll = !!(r.spec.audit && "blocked" in r.spec.audit) && res.status === 409;
      if (!(res.status === 403 || res.status === 404 || failsClosedForAll)) problems.push(`customer_member: ${r.key} → ${await describe(res)}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(changedTables(before, snapshot(w.db)), [], "denied requests changed no state");
  assert.ok(loc(await w.a.admin.c.get("/staff")) === "" , "customer receives an error page for /staff, not a redirect");
});

test("[AUTH-007] record-level scoping: a sales rep is denied every lead, lead task, AI draft and quote of leads not assigned to them", async () => {
  const o = w.staff.owner.c, sales = w.staff.sales.c;
  // A lead (with a task, an AI draft and a quote) that belongs to nobody in sales.
  assert.equal((await o.post("/staff/crm/new", { name: "Unassigned Lead", email: "unassigned@matrix.example", phone: "", company: "Other Co", website: "", interest: "business", message: "x", source: "referral" })).status, 303);
  const lead = (await w.db.prepare(`SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = 'unassigned@matrix.example'`).first<{ id: string }>())!.id;
  await o.post(`/staff/crm/leads/${lead}/task`, { body: "Owner follow-up", due: "2027-01-01" });
  const leadTask = (await w.db.prepare(`SELECT id FROM crm_activities WHERE lead_id = ? AND kind = 'task'`).bind(lead).first<{ id: string }>())!.id;
  const aiJob = `ai_unassigned_${Date.now()}`;
  await w.db.prepare(`INSERT INTO ai_jobs (id, workflow, provider, model, status, input_ref, output_ref, created_at, updated_at) VALUES (?, 'lead_qualification', 'anthropic', 'test', 'awaiting_approval', ?, 'Draft', ?, ?)`).bind(aiJob, `lead:${lead}`, new Date().toISOString(), new Date().toISOString()).run();
  assert.equal((await o.post(`/staff/quotes/new?lead=${lead}`, { package: "starter", scope: "Starter package website: five pages with a contact form.", valid_until: "2027-06-01" })).status, 303);
  const quote = (await w.db.prepare(`SELECT id FROM quotes WHERE lead_id = ?`).bind(lead).first<{ id: string }>())!.id;
  const ids: Record<string, string> = { lead, leadTask, aiJob, quote };
  const errors0 = appErrors(w.db);
  const before = snapshot(w.db);
  const problems: string[] = [];
  let n = 0;
  for (const r of classified().filter((x) => x.spec.access.kind === "staff" && (x.spec.access.roles as readonly string[]).includes("sales"))) {
    const kinds = Object.values(r.spec.params ?? {});
    if (!kinds.some((k) => k in ids)) continue;
    const path = r.pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[r.spec.params![name]]);
    const res = await call(sales, r, path); n++;
    if (res.status !== 403 && res.status !== 404) problems.push(`${r.key} → ${await describe(res)}`);
  }
  const newQuote = await sales.get(`/staff/quotes/new?lead=${lead}`);
  if (newQuote.status !== 404) problems.push(`GET /staff/quotes/new?lead=<unassigned> → ${newQuote.status}`);
  if ((await (await sales.get("/staff/crm/export.csv")).text()).includes("unassigned@matrix.example")) problems.push("CRM export includes an unassigned lead");
  if ((await (await sales.get("/staff/crm?view=list")).text()).includes("Unassigned Lead")) problems.push("CRM list shows an unassigned lead");
  assert.ok(n >= 10, `checked ${n} lead-scoped routes`);
  assert.deepEqual(problems, []);
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(changedTables(before, snapshot(w.db)), [], "denied requests changed no state");
  // Positive control: the same rep is served the lead assigned to them.
  assert.equal((await sales.get(`/staff/crm/leads/${w.ids.lead}`)).status, 200);
});

test("[EMP-002] staff email views never reveal single-use secrets (password reset, verification, invitation, proposal links); the links still work", async () => {
  const anon = w.anon();
  assert.equal((await anon.post("/password/forgot", { email: w.a.member.email })).status, 200);
  const raw = (w.db as SqliteDb).raw;
  const rows = raw.prepare(`SELECT d.id, d.template, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id`).all() as { id: string; template: string; text_body: string }[];
  const withSecrets = rows.map((r) => ({ ...r, secrets: [...r.text_body.matchAll(/(?:token=|\/q\/|\/share\/)([A-Za-z0-9_-]{16,})/g)].map((m) => m[1]) })).filter((r) => r.secrets.length);
  const templates = new Set(withSecrets.map((r) => r.template));
  for (const t of ["password_reset", "staff_invitation", "registration", "quote_sent"]) assert.ok(templates.has(t), `fixture has a ${t} email with a secret link`);
  const problems: string[] = [];
  for (const role of ["owner", "administrator"] as const) {
    for (const r of withSecrets) {
      for (const p of [`/staff/email/${r.id}`, `/staff/email/${r.id}/html`]) {
        const res = await w.staff[role].c.get(p);
        const body = await res.text();
        if (res.status !== 200) problems.push(`${role} ${p} → ${res.status}`);
        for (const s of r.secrets) if (body.includes(s)) problems.push(`${role} ${p} (${r.template}) shows a secret`);
      }
    }
  }
  assert.deepEqual(problems, []);
  // Redaction is display-only: the recipient's link is intact and still works.
  const reset = withSecrets.find((r) => r.template === "password_reset")!;
  assert.equal((await anon.get(`/password/reset?token=${reset.secrets[0]}`)).status, 200);
  assert.ok(toLogin(await anon.post("/password/reset", { token: reset.secrets[0], password: "another-long-password-42" })));
});

test("[SEC-002] every state-changing browser route rejects requests without the CSRF token, with a forged token, or from a foreign origin", async () => {
  const errors0 = appErrors(w.db);
  const before = snapshot(w.db);
  const problems: string[] = [];
  const clientFor = (r: RouteEntry) => r.spec.access.kind === "staff" ? w.staff.owner.c : ["customer", "session", "authflow"].includes(r.spec.access.kind) ? w.b.admin.c : w.anon();
  const posts = classified().filter((r) => r.method === "POST" && !r.pattern.startsWith("/api/"));
  for (const r of posts) {
    const c = clientFor(r);
    const path = pathFor(w, r, w.b);
    const attempts: [string, Response][] = [
      ["no token", await c.post(path, {}, { csrf: false })],
      ["forged token", await c.post(path, {}, { csrf: "0".repeat(32) })],
      ["foreign origin", await c.post(path, {}, { origin: "https://evil.example" })],
    ];
    for (const [what, res] of attempts) if (res.status !== 403) problems.push(`${r.key} (${what}) → ${await describe(res)}`);
  }
  assert.ok(posts.length > 140);
  assert.deepEqual(problems, []);
  assert.equal(appErrors(w.db), errors0);
  assert.deepEqual(changedTables(before, snapshot(w.db)), [], "rejected requests changed no state");
});
