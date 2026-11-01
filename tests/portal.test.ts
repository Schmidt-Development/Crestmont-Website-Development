// Customer portal: tenant isolation, onboarding, files, messaging, revisions/change orders, approvals, handoff, team.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, TEST_PASSWORD } from "./support/app.ts";
import { provisionProject } from "../src/services/commerce.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Db } from "../src/lib/db.ts";

// Test data only: package orders inserted directly, then provisioned through the real service.
async function makeProject(db: Db, organizationId: string, productId: "starter" | "business" | "premium" = "business", total = 249_900) {
  const orderId = newId("ord");
  await db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?,?,?, 'paid', 'package', ?)`).bind(orderId, organizationId, productId, total, nowIso()).run();
  await db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at, paid_at) VALUES (?,?,?, 'full', ?, 'paid', ?, ?)`).bind(newId("inv"), organizationId, orderId, total, nowIso(), nowIso()).run();
  return provisionProject(db, orderId);
}
const setStatus = (db: Db, id: string, status: string) => db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).bind(status, id).run();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%test fixture\n");

async function twoTenants() {
  const app = await createTestApp();
  const a = await createCustomer(app.db, "alice@a.example", "Org A");
  const b = await createCustomer(app.db, "bob@b.example", "Org B");
  const pa = await makeProject(app.db, a.organizationId);
  const pb = await makeProject(app.db, b.organizationId);
  const ca = await app.client().login(a.email), cb = await app.client().login(b.email);
  return { ...app, a, b, pa, pb, ca, cb };
}

test("[AUTH-008] customer from org A cannot see org B's project, messages, files or downloads", async () => {
  const { db, ca, cb, pb, b } = await twoTenants();
  // Org B uploads a file and posts a message.
  const up = await cb.post(`/portal/projects/${pb}/files`, { file: new File([PDF], "contract.pdf", { type: "application/pdf" }), folder: "Legal" });
  assert.equal(up.status, 303);
  const fileId = (await db.prepare(`SELECT id FROM files WHERE organization_id = ?`).bind(b.organizationId).first<{ id: string }>())!.id;
  assert.equal((await cb.post(`/portal/projects/${pb}/messages`, { body: "Private message for org B" })).status, 303);

  for (const path of [`/portal/projects/${pb}`, `/portal/projects/${pb}/messages`, `/portal/projects/${pb}/files`, `/portal/projects/${pb}/onboarding`,
    `/portal/projects/${pb}/revisions`, `/portal/projects/${pb}/approvals`, `/portal/projects/${pb}/handoff`, `/portal/files/${fileId}`, `/files/${fileId}`, `/files/${fileId}/preview`]) {
    const res = await ca.get(path);
    assert.equal(res.status, 404, `GET ${path} must be denied across tenants`);
    assert.doesNotMatch(await res.text(), /Private message for org B|contract\.pdf/);
  }
  for (const [path, fields] of [
    [`/portal/projects/${pb}/messages`, { body: "intrusion" }],
    [`/portal/projects/${pb}/revisions`, { request: "Please change everything on this site" }],
    [`/portal/projects/${pb}/approvals`, { kind: "scope", decision: "approved" }],
    [`/portal/projects/${pb}/onboarding`, { intent: "draft", business_name: "x" }],
    [`/portal/files/${fileId}/delete`, {}],
    [`/portal/files/${fileId}/move`, { folder: "x" }],
  ] as const) {
    assert.equal((await ca.post(path, fields as Record<string, string>)).status, 404, `POST ${path} must be denied across tenants`);
  }
  // Uploading into org B's project via the general form's project_id is refused too.
  const sneaky = await ca.post(`/portal/files`, { project_id: pb, file: new File([PDF], "x.pdf") });
  assert.equal(sneaky.status, 404);
  // Lists do not leak.
  assert.doesNotMatch(await (await ca.get("/portal/files")).text(), /contract\.pdf/);
  assert.doesNotMatch(await (await ca.get("/portal/messages")).text(), /Org B/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM messages WHERE body = 'intrusion'`).first<{ n: number }>())!.n, 0);
  assert.ok((await db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'file.download_denied' AND subject_id = ?`).bind(fileId).first<{ n: number }>())!.n >= 1);
  // The owner of the file can still download it.
  assert.equal((await cb.get(`/files/${fileId}`)).status, 200);
});

test("[PORTAL-001] dashboard shows real counts and an empty state for customers without projects", async () => {
  const { db, client } = await createTestApp();
  const fresh = await createCustomer(db, "new@x.example", "Fresh Co");
  const c = await client().login(fresh.email);
  const empty = await (await c.get("/portal")).text();
  assert.match(empty, /You have no projects yet/);
  assert.match(empty, /href="\/pricing"/);
  assert.match(empty, /href="\/quote"/);
  const pid = await makeProject(db, fresh.organizationId);
  await db.prepare(`INSERT INTO invoices (id, organization_id, project_id, milestone_kind, amount_cents, status, created_at) VALUES (?,?,?, 'change_order', 5000, 'open', ?)`).bind(newId("inv"), fresh.organizationId, pid, nowIso()).run();
  await db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?, 'Help', 'technical', 'normal', 'open', ?, ?, ?)`).bind(newId("tkt"), fresh.organizationId, fresh.id, nowIso(), nowIso()).run();
  const dash = await (await c.get("/portal")).text();
  assert.match(dash, /Complete onboarding for/);
  assert.match(dash, /1 open invoice totalling \$50/);
  assert.match(dash, /1 open support ticket/);
  assert.match(dash, /No maintenance subscription/);
});

test("[PORTAL-002] conditional onboarding: drafts save, hidden fields are not required, submit moves to scope review and notifies the PM", async () => {
  const { db, ca, pa, client } = await twoTenants();
  const pm = await createStaff(db, "project_manager", "pm@crestmont.test");
  await db.prepare(`UPDATE projects SET project_manager_id = ? WHERE id = ?`).bind(pm.id, pa).run();
  const form = await (await ca.get(`/portal/projects/${pa}/onboarding`)).text();
  assert.match(form, /data-show-when="domain_status=own"/);
  assert.match(form, /data-show-when="has_branding=yes"/);

  const draft = await ca.post(`/portal/projects/${pa}/onboarding`, { intent: "draft", business_name: "Org A LLC", goals: "More leads" });
  assert.equal(draft.status, 303);
  const saved = await db.prepare(`SELECT answers_json, completed_at FROM onboarding_responses WHERE project_id = ?`).bind(pa).first<{ answers_json: string; completed_at: string | null }>();
  assert.equal(JSON.parse(saved!.answers_json).business_name, "Org A LLC");
  assert.equal(saved!.completed_at, null);

  const base = { intent: "submit", business_name: "Org A LLC", contact_name: "Alice", contact_email: "alice@a.example", industry: "Plumbing", goals: "More leads",
    target_audience: "Homeowners", has_branding: "no", brand_style: "Classic", pages: "Home, About, Contact", content_source: "crestmont_draft", images_source: "licensed", hosting: "crestmont" };
  // Owning a domain makes domain name + DNS choice required.
  const missing = await ca.post(`/portal/projects/${pa}/onboarding`, { ...base, domain_status: "own" });
  assert.equal(missing.status, 422);
  const t = await missing.text();
  assert.match(t, /Domain name is required/);
  assert.match(t, /Who should manage DNS\? is required/);
  assert.equal((await db.prepare(`SELECT status FROM projects WHERE id = ?`).bind(pa).first<{ status: string }>())!.status, "awaiting_onboarding");
  // Choosing booking makes booking details required.
  const booking = await ca.post(`/portal/projects/${pa}/onboarding`, { ...base, domain_status: "own", domain_name: "orga.example", dns_management: "agency", functionality: ["contact_form", "booking"] });
  assert.equal(booking.status, 422);
  assert.match(await booking.text(), /Booking details is required/);

  // "need" a domain: the own-domain fields are hidden and not required; hidden values are dropped.
  const ok = await ca.post(`/portal/projects/${pa}/onboarding`, { ...base, domain_status: "need", domain_wishes: "orga.com", domain_name: "should-be-dropped.example", functionality: ["contact_form"],
    logo: new File([PNG], "logo.png", { type: "image/png" }) });
  assert.equal(ok.status, 303);
  const proj = await db.prepare(`SELECT status FROM projects WHERE id = ?`).bind(pa).first<{ status: string }>();
  assert.equal(proj!.status, "scope_review");
  const rec = await db.prepare(`SELECT answers_json, completed_at FROM onboarding_responses WHERE project_id = ?`).bind(pa).first<{ answers_json: string; completed_at: string }>();
  assert.ok(rec!.completed_at);
  const ans = JSON.parse(rec!.answers_json);
  assert.equal(ans.domain_name, undefined, "hidden conditional answers are not stored");
  assert.equal(ans.logo.length, 1, "logo stored via file service");
  assert.ok(await db.prepare(`SELECT 1 FROM files WHERE id = ? AND folder = 'Onboarding/Logo'`).bind(ans.logo[0]).first());
  assert.ok(await db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'onboarding_completed'`).bind(pm.id).first());
  assert.equal((await lastEmail(db, pm.email))?.template, "onboarding");
  assert.ok(await db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'project.status_changed' AND subject_id = ? AND details_json LIKE '%scope_review%'`).bind(pa).first());
  // Cannot resubmit.
  assert.equal((await ca.post(`/portal/projects/${pa}/onboarding`, { ...base, intent: "submit", domain_status: "need", domain_wishes: "x.com" })).status, 422);
  void client;
});

test("[PORTAL-004] [FILE-001] [SEC-003] uploads validate type, magic bytes and size; records sha256 and 'pending' scan", async () => {
  const { db, ca, pa, a, storage } = await twoTenants();
  const bad: [string, Uint8Array][] = [
    ["page.html", new TextEncoder().encode("<html><script>alert(1)</script></html>")],
    ["logo.svg", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")],
    ["fake.png", new TextEncoder().encode("this is not a png")],
    ["tool.exe", new Uint8Array([0x4d, 0x5a, 0, 0])],
  ];
  for (const [name, bytes] of bad) {
    const res = await ca.post(`/portal/projects/${pa}/files`, { file: new File([bytes as Uint8Array<ArrayBuffer>], name) });
    assert.equal(res.status, 422, `${name} must be rejected`);
  }
  const big = new Uint8Array(25 * 1024 * 1024 + 10); big.set([0x25, 0x50, 0x44, 0x46]);
  const tooBig = await ca.post(`/portal/projects/${pa}/files`, { file: new File([big], "huge.pdf") });
  assert.equal(tooBig.status, 422);
  assert.match(await tooBig.text(), /25 MB/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM files`).first<{ n: number }>())!.n, 0);
  assert.equal(storage.objects.size, 0);

  const ok = await ca.post(`/portal/projects/${pa}/files`, { file: new File([PNG], "../../etc/My Logo<1>.png"), folder: "Branding/../Logos" });
  assert.equal(ok.status, 303);
  const f = await db.prepare(`SELECT * FROM files WHERE organization_id = ?`).bind(a.organizationId).first<{ id: string; filename: string; sha256: string; scan_status: string; folder: string; r2_key: string; content_type: string }>();
  assert.equal(f!.filename, "My Logo_1_.png");
  assert.equal(f!.scan_status, "pending");
  assert.equal(f!.content_type, "image/png");
  assert.equal(f!.folder, "Branding/Logos");
  assert.match(f!.sha256, /^[0-9a-f]{64}$/);
  assert.ok(storage.objects.has(f!.r2_key));
  const list = await (await ca.get(`/portal/projects/${pa}/files`)).text();
  assert.match(list, /Not yet scanned/);
});

test("[PORTAL-004] [SEC-003] downloads are access-checked and audited; preview is inline only for images/PDF", async () => {
  const { db, ca, pa, a, client } = await twoTenants();
  await ca.post(`/portal/projects/${pa}/files`, { file: new File([PNG], "logo.png") });
  await ca.post(`/portal/projects/${pa}/files`, { file: new File([new TextEncoder().encode("a,b\n1,2\n")], "data.csv") });
  const png = (await db.prepare(`SELECT id FROM files WHERE filename = 'logo.png'`).first<{ id: string }>())!.id;
  const csv = (await db.prepare(`SELECT id FROM files WHERE filename = 'data.csv'`).first<{ id: string }>())!.id;
  const dl = await ca.get(`/files/${png}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition")!, /^attachment/);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), PNG);
  const pv = await ca.get(`/files/${png}/preview`);
  assert.match(pv.headers.get("content-disposition")!, /^inline/);
  const csvPv = await ca.get(`/files/${csv}/preview`);
  assert.match(csvPv.headers.get("content-disposition")!, /^attachment/, "non-image/PDF never served inline");
  const audits = await db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'file.downloaded' AND subject_id = ? AND actor_user_id = ?`).bind(png, a.id).first<{ n: number }>();
  assert.equal(audits!.n, 2);
  // Anonymous users are sent to sign in.
  assert.equal((await client().get(`/files/${png}`)).status, 303);
  // Staff: a developer not assigned to the project is denied; a PM (project.read_all) is allowed.
  const dev = await createStaff(db, "developer", "dev@crestmont.test");
  const pm = await createStaff(db, "project_manager", "pm@crestmont.test");
  const sales = await createStaff(db, "sales", "sales@crestmont.test");
  assert.equal((await (await client().login(dev.email, TEST_PASSWORD, dev.secret)).get(`/files/${png}`)).status, 404);
  assert.equal((await (await client().login(sales.email, TEST_PASSWORD, sales.secret)).get(`/files/${png}`)).status, 404);
  assert.equal((await (await client().login(pm.email, TEST_PASSWORD, pm.secret)).get(`/files/${png}`)).status, 200);
});

test("[PORTAL-004] replace keeps version history, organize moves folders, delete is soft", async () => {
  const { db, ca, pa } = await twoTenants();
  await ca.post(`/portal/projects/${pa}/files`, { file: new File([PDF], "brief.pdf"), folder: "Docs" });
  const v1 = (await db.prepare(`SELECT id FROM files WHERE filename = 'brief.pdf'`).first<{ id: string }>())!.id;
  const rep = await ca.post(`/portal/files/${v1}/replace`, { file: new File([PDF], "brief-v2.pdf") });
  assert.equal(rep.status, 303);
  const v2 = (await db.prepare(`SELECT id, folder FROM files WHERE filename = 'brief-v2.pdf'`).first<{ id: string; folder: string }>())!;
  assert.equal(v2.folder, "Docs");
  assert.equal((await db.prepare(`SELECT replaced_by FROM files WHERE id = ?`).bind(v1).first<{ replaced_by: string }>())!.replaced_by, v2.id);
  assert.match(await (await ca.get(`/portal/files/${v2.id}`)).text(), /Earlier versions[\s\S]*brief\.pdf/);
  assert.equal((await ca.post(`/portal/files/${v1}/replace`, { file: new File([PDF], "x.pdf") })).status, 409, "only latest version can be replaced");
  assert.equal((await ca.post(`/portal/files/${v2.id}/move`, { folder: "Archive" })).status, 303);
  assert.equal((await db.prepare(`SELECT folder FROM files WHERE id = ?`).bind(v2.id).first<{ folder: string }>())!.folder, "Archive");
  assert.equal((await ca.post(`/portal/files/${v2.id}/delete`)).status, 303);
  assert.ok((await db.prepare(`SELECT deleted_at FROM files WHERE id = ?`).bind(v2.id).first<{ deleted_at: string }>())!.deleted_at);
  assert.equal((await ca.get(`/files/${v2.id}`)).status, 404);
  assert.doesNotMatch(await (await ca.get(`/portal/files`)).text(), /brief-v2\.pdf/);
});

test("[PORTAL-004] without storage the portal says file storage is not configured", async () => {
  const { db, env, client } = await createTestApp();
  env.overrides = { ...env.overrides, storage: null };
  const a = await createCustomer(db, "nostore@x.example");
  const pid = await makeProject(db, a.organizationId);
  const c = await client().login(a.email);
  assert.match(await (await c.get("/portal/files")).text(), /File storage is not configured yet/);
  const res = await c.post(`/portal/projects/${pid}/files`, { file: new File([PDF], "a.pdf") });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /not configured/);
});

test("[PORTAL-005] messaging: attachments, read status, internal notes hidden, notification email to the other side", async () => {
  const { db, ca, pa, a, client } = await twoTenants();
  const pm = await createStaff(db, "project_manager", "pm@crestmont.test");
  await db.prepare(`UPDATE projects SET project_manager_id = ? WHERE id = ?`).bind(pm.id, pa).run();
  const sent = await ca.post(`/portal/projects/${pa}/messages`, { body: "Here is our logo", attachment: new File([PNG], "logo.png") });
  assert.equal(sent.status, 303);
  const msg = await db.prepare(`SELECT id, attachment_file_id FROM messages WHERE project_id = ?`).bind(pa).first<{ id: string; attachment_file_id: string }>();
  assert.ok(msg!.attachment_file_id);
  assert.equal((await lastEmail(db, pm.email))?.template, "project_update");
  assert.ok(await db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'message'`).bind(pm.id).first());
  assert.match(await (await ca.get(`/portal/projects/${pa}/messages`)).text(), /Not yet read/);

  const sc = await client().login(pm.email, TEST_PASSWORD, pm.secret);
  const thread = await (await sc.get(`/staff/projects/${pa}?tab=messages`)).text();
  assert.match(thread, /Here is our logo/);
  assert.ok(await db.prepare(`SELECT 1 FROM message_reads WHERE message_id = ? AND user_id = ?`).bind(msg!.id, pm.id).first(), "staff view marks read");
  assert.match(await (await ca.get(`/portal/projects/${pa}/messages`)).text(), /Seen by team/);

  assert.equal((await sc.post(`/staff/projects/${pa}/messages`, { body: "Internal: customer seems unsure about colors", internal: "1" })).status, 303);
  assert.equal((await sc.post(`/staff/projects/${pa}/messages`, { body: "Thanks! We will start design next week." })).status, 303);
  const cust = await (await ca.get(`/portal/projects/${pa}/messages`)).text();
  assert.doesNotMatch(cust, /customer seems unsure/, "internal notes are never shown to customers");
  assert.match(cust, /We will start design next week/);
  const mail = await lastEmail(db, a.email);
  assert.equal(mail?.template, "project_update");
  assert.match(mail!.text_body, /We will start design next week/);
  assert.doesNotMatch(mail!.text_body, /unsure/);
  // Customers cannot forge internal notes.
  await ca.post(`/portal/projects/${pa}/messages`, { body: "sneaky", internal: "1" });
  assert.equal((await db.prepare(`SELECT internal FROM messages WHERE body = 'sneaky'`).first<{ internal: number }>())!.internal, 0);
});

test("[PORTAL-006] [PM-002] [PM-003] revisions count against the allowance, then require a change order whose approval creates an open invoice", async () => {
  const { db, ca, pa, a, client } = await twoTenants();
  const pm = await createStaff(db, "project_manager", "pm@crestmont.test");
  await db.prepare(`UPDATE projects SET project_manager_id = ?, revision_allowance = 3 WHERE id = ?`).bind(pm.id, pa).run();
  assert.equal((await db.prepare(`SELECT revision_allowance FROM projects WHERE id = ?`).bind(pa).first<{ revision_allowance: number }>())!.revision_allowance, 3, "Business = 3 rounds");
  assert.equal((await ca.post(`/portal/projects/${pa}/revisions`, { request: "Change the hero image please" })).status, 409, "no revisions before design");
  await setStatus(db, pa, "customer_review");
  const sc = await client().login(pm.email, TEST_PASSWORD, pm.secret);
  for (let i = 1; i <= 3; i++) {
    const res = await ca.post(`/portal/projects/${pa}/revisions`, { request: `Round ${i}: adjust spacing and colors` });
    assert.equal(res.status, 303);
    const rev = await db.prepare(`SELECT id, round, included FROM revisions WHERE project_id = ? AND round = ?`).bind(pa, i).first<{ id: string; round: number; included: number }>();
    assert.equal(rev!.included, 1);
    await sc.post(`/staff/revisions/${rev!.id}/status`, { status: "delivered", notes: "Done" });
    await ca.post(`/portal/projects/${pa}/approvals`, { kind: "revision", decision: "approved", subject_id: rev!.id });
    assert.equal((await db.prepare(`SELECT status FROM revisions WHERE id = ?`).bind(rev!.id).first<{ status: string }>())!.status, "approved");
  }
  assert.match(await (await ca.get(`/portal/projects/${pa}/revisions`)).text(), /Further changes need a change order/);
  // Fourth request: recorded as billable, needs a change order.
  assert.equal((await ca.post(`/portal/projects/${pa}/revisions`, { request: "Round 4: add a new services page" })).status, 303);
  const r4 = await db.prepare(`SELECT id, included, status FROM revisions WHERE project_id = ? AND round = 4`).bind(pa).first<{ id: string; included: number; status: string }>();
  assert.equal(r4!.included, 0);
  assert.equal((await ca.post(`/portal/projects/${pa}/revisions`, { request: "Round 5: yet another request" })).status, 409, "only one unpriced billable request at a time");
  // Staff cannot deliver work on it before a change order is approved.
  assert.equal((await sc.post(`/staff/revisions/${r4!.id}/status`, { status: "in_progress" })).status, 409);
  assert.equal((await sc.post(`/staff/projects/${pa}/change-orders`, { revision_id: r4!.id, scope: "Add a services page with 3 sections", price: "450" })).status, 303);
  const co = await db.prepare(`SELECT id, status, price_cents FROM change_orders WHERE project_id = ?`).bind(pa).first<{ id: string; status: string; price_cents: number }>();
  assert.equal(co!.price_cents, 45_000);
  assert.equal((await lastEmail(db, a.email))?.template, "change_order");
  // A customer_member cannot approve; the admin can.
  const approve = await ca.post(`/portal/change-orders/${co!.id}/decide`, { decision: "approved" });
  assert.equal(approve.status, 303);
  const after = await db.prepare(`SELECT c.status, c.task_id, i.status AS inv_status, i.milestone_kind, i.amount_cents, i.organization_id FROM change_orders c JOIN invoices i ON i.id = c.invoice_id WHERE c.id = ?`).bind(co!.id)
    .first<{ status: string; task_id: string; inv_status: string; milestone_kind: string; amount_cents: number; organization_id: string }>();
  assert.deepEqual({ s: after!.status, i: after!.inv_status, k: after!.milestone_kind, amt: after!.amount_cents, org: after!.organization_id }, { s: "approved", i: "open", k: "change_order", amt: 45_000, org: a.organizationId });
  assert.ok(after!.task_id, "assigned task created for the change order");
  // The "Pay invoice" link opens the invoice page (which holds the POST pay form); /pay itself is POST-only.
  const payHref = /href="(\/portal\/billing\/invoices\/inv_[0-9a-f]+)">Pay invoice/.exec(await (await ca.get(`/portal/projects/${pa}/revisions`)).text())?.[1];
  assert.ok(payHref, "pay link present");
  assert.equal((await ca.get(payHref!)).status, 200, "pay link resolves");
  assert.equal((await ca.post(`/portal/change-orders/${co!.id}/decide`, { decision: "approved" })).status, 409, "no double decision");
  assert.equal((await sc.post(`/staff/revisions/${r4!.id}/status`, { status: "in_progress" })).status, 303, "work can start once approved");
});

test("[PORTAL-007] approvals: admins approve/reject with notes; members cannot; decisions are audited", async () => {
  const { db, ca, pa, a, client } = await twoTenants();
  const pm = await createStaff(db, "project_manager", "pm@crestmont.test");
  await setStatus(db, pa, "scope_review");
  const sc = await client().login(pm.email, TEST_PASSWORD, pm.secret);
  assert.equal((await sc.post(`/staff/projects/${pa}/request-approval`, { kind: "scope", note: "Please review the scope" })).status, 303);
  assert.equal((await lastEmail(db, a.email))?.template, "approval_request");
  assert.match(await (await ca.get("/portal")).text(), /Scope approval awaiting your decision/);
  // Member (invited) cannot approve.
  const { createInvitation, acceptInvitation } = await import("../src/services/auth.ts");
  const tok = await createInvitation(db, a.id, "member@a.example", "customer_member", a.organizationId);
  await acceptInvitation(db, tok, "Mem Ber", TEST_PASSWORD);
  const mem = await client().login("member@a.example");
  assert.match(await (await mem.get(`/portal/projects/${pa}/approvals`)).text(), /Only an account administrator/);
  assert.equal((await mem.post(`/portal/projects/${pa}/approvals`, { kind: "scope", decision: "approved" })).status, 403);
  // Reject requires notes.
  assert.equal((await ca.post(`/portal/projects/${pa}/approvals`, { kind: "scope", decision: "rejected" })).status, 422);
  assert.equal((await ca.post(`/portal/projects/${pa}/approvals`, { kind: "scope", decision: "rejected", notes: "Add a booking page" })).status, 303);
  assert.equal((await db.prepare(`SELECT approved_at FROM project_scopes WHERE project_id = ?`).bind(pa).first<{ approved_at: string | null }>())!.approved_at, null);
  await sc.post(`/staff/projects/${pa}/request-approval`, { kind: "scope", note: "Updated" });
  assert.equal((await ca.post(`/portal/projects/${pa}/approvals`, { kind: "scope", decision: "approved", notes: "Looks good" })).status, 303);
  assert.ok((await db.prepare(`SELECT approved_at FROM project_scopes WHERE project_id = ?`).bind(pa).first<{ approved_at: string | null }>())!.approved_at);
  const audits = (await db.prepare(`SELECT action FROM audit_logs WHERE subject_id = ? AND action LIKE 'approval.%' ORDER BY id`).bind(pa).all<{ action: string }>()).results.map((r) => r.action);
  assert.deepEqual(audits, ["approval.requested", "approval.rejected", "approval.requested", "approval.approved"]);
  // Customers cannot record staff-only checks.
  assert.equal((await ca.post(`/portal/projects/${pa}/approvals`, { kind: "internal_qa", decision: "approved" })).status, 422);
  assert.match(await (await ca.get(`/portal/projects/${pa}`)).text(), /Scope approval approved/);
});

test("[PORTAL-010] handoff is visible once published and the customer records final acceptance", async () => {
  const { db, ca, pa, client } = await twoTenants();
  const pm = await createStaff(db, "project_manager", "pm@crestmont.test");
  const sc = await client().login(pm.email, TEST_PASSWORD, pm.secret);
  assert.match(await (await ca.get(`/portal/projects/${pa}/handoff`)).text(), /Handoff not published yet/);
  assert.equal((await sc.post(`/staff/projects/${pa}/handoff`, { intent: "publish", website_url: "https://orga.example" })).status, 422, "all sections required to publish");
  const draft = await sc.post(`/staff/projects/${pa}/handoff`, { intent: "draft", website_url: "https://orga.example", documentation: "Editing guide" });
  assert.equal(draft.status, 303);
  assert.match(await (await ca.get(`/portal/projects/${pa}/handoff`)).text(), /Handoff not published yet/, "drafts stay hidden");
  assert.equal((await sc.post(`/staff/projects/${pa}/handoff`, { intent: "publish", website_url: "https://orga.example", documentation: "Editing guide", access_instructions: "We will send a secure invite to your CMS account.", ownership_notes: "Domain registered to Org A.", training_notes: "30-minute walkthrough recording." })).status, 303);
  const page = await (await ca.get(`/portal/projects/${pa}/handoff`)).text();
  assert.match(page, /https:\/\/orga\.example/);
  assert.match(page, /secure invite/);
  assert.match(page, /Accept the website/);
  assert.equal((await ca.post(`/portal/projects/${pa}/approvals`, { kind: "final_acceptance", decision: "approved", notes: "Thank you" })).status, 303);
  assert.ok((await db.prepare(`SELECT accepted_at FROM handoffs WHERE project_id = ?`).bind(pa).first<{ accepted_at: string }>())!.accepted_at);
  assert.match(await (await ca.get(`/portal/projects/${pa}/handoff`)).text(), /Final acceptance recorded/);
});

test("[PORTAL-003] project overview shows milestones, customer-visible task counts, blockers and history", async () => {
  const { db, ca, pa } = await twoTenants();
  await db.prepare(`UPDATE milestones SET due_at = '2026-12-15', status = 'blocked' WHERE project_id = ? AND name = 'Design'`).bind(pa).run();
  await db.prepare(`INSERT INTO tasks (id, project_id, title, status, created_at) VALUES (?,?, 'Secret internal task name', 'done', ?), (?,?, 'Another', 'blocked', ?)`).bind(newId("task"), pa, nowIso(), newId("task"), pa, nowIso()).run();
  const t = await (await ca.get(`/portal/projects/${pa}`)).text();
  assert.match(t, /1 \/ 2/);
  assert.match(t, /Milestone blocked: Design/);
  assert.match(t, /Dec 15, 2026/);
  assert.match(t, /Project created/);
  assert.doesNotMatch(t, /Secret internal task name/, "only counts are shown to customers");
});

test("[AUTH-006] customer admin invites colleagues as customer_member; members cannot invite", async () => {
  const { db, ca, a, client } = await twoTenants();
  const res = await ca.post("/portal/team", { email: "colleague@a.example" });
  assert.equal(res.status, 303);
  const inv = await db.prepare(`SELECT role_id, organization_id FROM invitations WHERE email = 'colleague@a.example'`).first<{ role_id: string; organization_id: string }>();
  assert.deepEqual({ ...inv }, { role_id: "customer_member", organization_id: a.organizationId });
  assert.match((await lastEmail(db, "colleague@a.example"))!.text_body, /\/invite\?token=/);
  assert.equal((await ca.post("/portal/team", { email: "not-an-email" })).status, 422);
  const { createInvitation, acceptInvitation } = await import("../src/services/auth.ts");
  await acceptInvitation(db, await createInvitation(db, a.id, "m2@a.example", "customer_member", a.organizationId), "M Two", TEST_PASSWORD);
  const m = await client().login("m2@a.example");
  assert.equal((await m.post("/portal/team", { email: "x@a.example" })).status, 403);
  assert.match(await (await m.get("/portal/team")).text(), /Only an account administrator can invite/);
});

test("[PORTAL-002] onboarding with more uploaded images than D1's 100 bound parameters still renders, listing only this customer's files", async () => {
  const { db, a, b, pa, ca } = await twoTenants();
  const file = (org: string, uploader: string, name: string) => {
    const id = newId("fil");
    return { id, stmt: db.prepare(`INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, folder, uploaded_by, created_at) VALUES (?,?,?,?,?, 'image/png', 12, 'x', 'clean', 'Onboarding/Images', ?, ?)`)
      .bind(id, org, org === a.organizationId ? pa : null, `k/${id}`, name, uploader, nowIso()) };
  };
  // Uploads accumulate across draft saves with no cap; 120 ids is past D1's per-query limit when bound one by one.
  const mine = Array.from({ length: 120 }, (_, i) => file(a.organizationId, a.id, `image-${String(i).padStart(3, "0")}.png`));
  const theirs = file(b.organizationId, b.id, "other-tenant-secret.png");
  await db.batch([...mine.map((f) => f.stmt), theirs.stmt]);
  const ids = [...mine.map((f) => f.id), theirs.id];   // a foreign id smuggled into the answers must not be listed
  await db.prepare(`INSERT INTO onboarding_responses (project_id, answers_json, updated_at) VALUES (?,?,?)`).bind(pa, JSON.stringify({ images_source: "customer", images: ids }), nowIso()).run();
  const res = await ca.get(`/portal/projects/${pa}/onboarding`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /image-000\.png/);
  assert.match(page, /image-119\.png/);
  assert.doesNotMatch(page, /other-tenant-secret/, "tenant isolation holds for file ids taken from stored answers");
  // The local D1 stand-in enforces the same limit, so a per-id query would have failed here exactly as on Cloudflare.
  assert.throws(() => db.prepare(`SELECT id FROM files WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids), /D1 limit: 121 bound parameters \(maximum 100\)/);
});

test("[AIB-QUALITY] [PORTAL-006] Crestmont's defects never use a revision round; problem reports wait for triage; scope changes need a change order; every classification is audited", async () => {
  const { db, ca, pa, client } = await twoTenants();
  const pm = await createStaff(db, "project_manager", "pm2@crestmont.test");
  await db.prepare(`UPDATE projects SET project_manager_id = ?, revision_allowance = 2 WHERE id = ?`).bind(pm.id, pa).run();
  await setStatus(db, pa, "customer_review");
  const sc = await client().login(pm.email, TEST_PASSWORD, pm.secret);
  const rev = async (round: number) => (await db.prepare(`SELECT * FROM revisions WHERE project_id = ? AND round = ?`).bind(pa, round).first<Record<string, unknown>>())!;
  const { revisionUsage } = await import("../src/services/projects.ts");

  // 1. A problem report uses no round while staff triage it.
  assert.equal((await ca.post(`/portal/projects/${pa}/revisions`, { kind: "problem", request: "The booking form shows an error when I pick Saturday." })).status, 303);
  const p1 = await rev(1);
  assert.equal((await sc.post(`/staff/revisions/${p1.id}/status`, { status: "in_progress" })).status, 409, "no work on an untriaged problem report");
  assert.equal(p1.customer_kind, "problem");
  assert.equal((await revisionUsage(db, pa)).used, 0, "untriaged problem report uses no round");
  assert.match(await (await ca.get(`/portal/projects/${pa}/revisions`)).text(), /Problem report: we are checking it/);

  // Classification needs a reason; customers cannot classify.
  assert.equal((await ca.post(`/staff/revisions/${p1.id}/classify`, { category: "builder_defect", reason: "customer tries to self-classify" })).status >= 400, true);
  await sc.post(`/staff/revisions/${p1.id}/classify`, { category: "builder_defect", reason: "x" });
  assert.equal((await rev(1)).category_at, null, "no reason, no classification");

  // 2. Staff confirm it is Crestmont's defect: it never uses a round.
  assert.equal((await sc.post(`/staff/revisions/${p1.id}/classify`, { category: "builder_defect", reason: "Saturday slots were generated in UTC; our defect against the approved booking scope." })).status, 303);
  assert.deepEqual([(await rev(1)).category, (await rev(1)).included, (await revisionUsage(db, pa)).used], ["builder_defect", 1, 0]);
  assert.match(await (await ca.get(`/portal/projects/${pa}/revisions`)).text(), /Our fix: no round used/);

  // 3. A customer change uses a round; a builder-defect reclassification gives it back.
  await ca.post(`/portal/projects/${pa}/revisions`, { kind: "change", request: "Please make the logo a little larger in the header." });
  assert.equal((await revisionUsage(db, pa)).used, 1);
  const c2 = await rev(2);
  await sc.post(`/staff/revisions/${c2.id}/classify`, { category: "builder_defect", reason: "The approved design specified the larger logo; we shipped the wrong size." });
  assert.equal((await revisionUsage(db, pa)).used, 0, "Crestmont's mistake does not consume the customer's round");

  // Work already started becomes billable only under a change order the customer APPROVED (a proposal is not enough).
  await ca.post(`/portal/projects/${pa}/revisions`, { request: "Please swap the footer photo for the team photo." });
  const w3 = await rev(3);
  assert.equal((await sc.post(`/staff/revisions/${w3.id}/status`, { status: "in_progress" })).status, 303);
  await sc.post(`/staff/projects/${pa}/change-orders`, { revision_id: w3.id, scope: "Footer photo swap", price: "50" });
  assert.equal((await rev(3)).billable_change_order_id !== null, true);
  await sc.post(`/staff/revisions/${w3.id}/classify`, { category: "scope_change", reason: "Trying to make started work billable with only a proposal." });
  assert.deepEqual([(await rev(3)).category, (await rev(3)).included], ["customer_revision", 1], "refused: the change order is only proposed");

  // 4. A scope change is never included and cannot start before an approved change order.
  await ca.post(`/portal/projects/${pa}/revisions`, { request: "Add an online shop with 40 products and shipping rates." });
  const s3 = await rev(4);
  assert.equal(s3.included, 1, "within the allowance until classified");
  assert.equal((await sc.post(`/staff/revisions/${s3.id}/classify`, { category: "scope_change", reason: "An online shop is not part of the approved Business scope; it needs a change order." })).status, 303);
  assert.deepEqual([(await rev(4)).category, (await rev(4)).included], ["scope_change", 0]);
  assert.equal((await sc.post(`/staff/revisions/${s3.id}/status`, { status: "in_progress" })).status, 409, "no work before an approved change order");
  assert.equal((await revisionUsage(db, pa)).used, 1, "only the footer-photo change uses a round");

  // 5. Audit trail with the reason.
  const audits = (await db.prepare(`SELECT details_json FROM audit_logs WHERE action = 'revision.classified' ORDER BY rowid`).all<{ details_json: string }>()).results.map((r) => JSON.parse(r.details_json));
  assert.equal(audits.length, 3, "the refused classification wrote nothing");
  assert.equal(audits[0].from, "untriaged problem");
  assert.match(audits[2].reason, /not part of the approved Business scope/);
});
