// UX workstream: design-system components, safe rich text, UTM attribution, general conversations,
// signed share links and cross-area audit coverage. Every record created here is TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, lastEmail, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { renderMarkdown, markdownIssues, isSafeLink } from "../src/ui/markdown.ts";
import { dateRangePresets, dateRange } from "../src/ui/components.ts";
import { attributionForRequest, sanitizeAttribution, cleanReferrer } from "../src/services/leads.ts";
import { provisionProject } from "../src/services/commerce.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import type { Db } from "../src/lib/db.ts";
import type { Env } from "../src/app/context.ts";
import type { AppContext } from "../src/app/context.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%test fixture\n");
const md = (s: string) => renderMarkdown(s).value;

async function staffClient(t: { db: Env["DB"]; client: () => TestClient }, role: Parameters<typeof createStaff>[1], email?: string) {
  const s = await createStaff(t.db, role, email);
  const c = t.client(); await c.login(s.email, TEST_PASSWORD, s.secret);
  return { ...s, c };
}
async function makeProject(db: Db, organizationId: string) {
  const orderId = newId("ord");
  await db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'business', 249900, 'paid', 'package', ?)`).bind(orderId, organizationId, nowIso()).run();
  await db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, created_at, paid_at) VALUES (?,?,?, 'full', 249900, 'paid', ?, ?)`).bind(newId("inv"), organizationId, orderId, nowIso(), nowIso()).run();
  return provisionProject(db, orderId);
}
const auditRow = (db: Db, action: string, subjectId?: string) =>
  db.prepare(`SELECT actor_user_id, actor_kind, subject_type, subject_id, organization_id, details_json, ip FROM audit_logs WHERE action = ? ${subjectId ? "AND subject_id = ?" : ""} ORDER BY id DESC LIMIT 1`)
    .bind(action, ...(subjectId ? [subjectId] : [])).first<{ actor_user_id: string | null; actor_kind: string; subject_type: string; subject_id: string | null; organization_id: string | null; details_json: string | null; ip: string | null }>();

// ───────────── BRAND-004: safe rich text ─────────────

test("[BRAND-004] markdown renderer: headings, emphasis, links, lists and paragraphs", () => {
  assert.equal(md("Hello world"), "<p>Hello world</p>");
  assert.equal(md("First line\nsame paragraph\n\nSecond"), "<p>First line same paragraph</p>\n<p>Second</p>");
  assert.equal(md("# Top\n## Section\n### Sub"), "<h2>Top</h2>\n<h2>Section</h2>\n<h3>Sub</h3>", "a single # never produces a second h1");
  assert.equal(md("**bold** and *italic* and _also_"), "<p><strong>bold</strong> and <em>italic</em> and <em>also</em></p>");
  assert.equal(md("**bold *nested* text**"), "<p><strong>bold <em>nested</em> text</strong></p>");
  assert.equal(md("snake_case_name stays"), "<p>snake_case_name stays</p>", "intra-word underscores are not emphasis");
  assert.equal(md("[Crestmont](https://crestmont.example/a?b=1&c=2)"), `<p><a href="https://crestmont.example/a?b=1&amp;c=2" rel="noopener noreferrer">Crestmont</a></p>`);
  assert.equal(md("[Email](mailto:hello@crestmont.example)"), `<p><a href="mailto:hello@crestmont.example">Email</a></p>`);
  assert.equal(md("- one\n- two\n  continued\n\n1. first\n2. second"), "<ul><li>one</li><li>two continued</li></ul>\n<ol><li>first</li><li>second</li></ol>");
  assert.equal(md("Intro\n- a\n- b\nOutro"), "<p>Intro</p>\n<ul><li>a</li><li>b</li></ul>\n<p>Outro</p>");
  assert.equal(md(""), "");
});

test("[BRAND-004] markdown renderer never passes raw HTML or unsafe URLs (XSS corpus)", () => {
  const corpus = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<a href=\"javascript:alert(1)\">x</a>",
    "[click](javascript:alert(1))", "[click](JaVaScRiPt:alert(1))", "[click](data:text/html;base64,PHNjcmlwdD4=)", "[click](//evil.example)",
    "[click](/relative)", "[x](vbscript:msgbox)", "[x](https://ok.example\" onmouseover=\"alert(1))", "**<b>bold</b>**", "`<iframe>`",
    "[[nested](https://a.example)](https://b.example)", "\"><svg onload=alert(1)>", "&lt;script&gt;", "[a](mailto:x@y.z?subject=<script>)",
  ];
  for (const s of corpus) {
    const out = md(s);
    assert.doesNotMatch(out, /<(?!\/?(p|h2|h3|strong|em|ul|ol|li|a)\b)[a-z!/]/i, `only renderer-written tags: ${s} → ${out}`);
    assert.doesNotMatch(out, /href="(?!https?:\/\/|mailto:)/i, `no unsafe hrefs: ${s} → ${out}`);
    assert.doesNotMatch(out, /<[^>]*\son\w+=/i, `no event handlers inside a tag: ${s} → ${out}`);
  }
  assert.equal(md("[click](javascript:void0)"), "<p>click</p>", "unsafe link keeps its words, drops its target");
  assert.ok(isSafeLink("https://a.example/x") && isSafeLink("mailto:a@b.example") && !isSafeLink("javascript:x") && !isSafeLink("/x") && !isSafeLink("ftp://x"));
  assert.deepEqual(markdownIssues("[x](javascript:alert(1)) <b>hi</b>"), ['Link "x" must start with https://, http:// or mailto:', "HTML tags are not allowed; use the formatting toolbar (markdown) instead"]);
  assert.deepEqual(markdownIssues("Plain **text** with [a link](https://a.example)."), []);
});

test("[BRAND-004] CMS long-text fields use the rich-text editor; unsafe input is refused; published markdown renders safely on the public page", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "administrator");
  const editor = await (await c.get("/staff/cms/about.page")).text();
  assert.match(editor, /data-richtext="f-body"/, "body field is a rich-text field");
  assert.match(editor, /data-preview-for="f-body"/, "server-rendered preview present without JS");
  assert.match(editor, /aria-describedby="f-body-hint"/, "formatting help is linked to the field");
  const base = { heading: "About Crestmont", lede: "Crestmont designs and builds websites for businesses across the United States." };
  const bad = await c.post("/staff/cms/about.page", { ...base, body: "Read [this](javascript:alert(1)) <script>x</script>" });
  assert.equal(bad.status, 422);
  const badText = await bad.text();
  assert.match(badText, /must start with https:\/\/, http:\/\/ or mailto:/);
  assert.match(badText, /HTML tags are not allowed/);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM cms_revisions`).first<{ n: number }>())!.n, 0, "nothing saved");
  const ok = await c.post("/staff/cms/about.page", { ...base, body: "## How we work\n\nWe keep a **written scope** and *published prices*.\n\n- Recorded approvals\n- A clear handoff\n\nSee the [process](https://crestmont.example/process)." });
  assert.equal(ok.status, 303);
  const rev = (await app.db.prepare(`SELECT id FROM cms_revisions`).first<{ id: string }>())!;
  const revPage = await (await c.get(`/staff/cms/revisions/${rev.id}`)).text();
  assert.match(revPage, /<strong>written scope<\/strong>/, "revision view shows the formatted preview");
  assert.equal((await c.post(`/staff/cms/revisions/${rev.id}/publish`)).status, 303);
  const pub = await (await app.client().get("/about")).text();
  assert.match(pub, /<h2>How we work<\/h2>/);
  assert.match(pub, /<ul><li>Recorded approvals<\/li><li>A clear handoff<\/li><\/ul>/);
  assert.match(pub, /<a href="https:\/\/crestmont\.example\/process" rel="noopener noreferrer">process<\/a>/);
  // Service intros (default plain paragraphs) still render as paragraphs.
  const svc = await (await app.client().get("/services/custom-development")).text();
  assert.match(svc, /<div class="prose"><p>/);
});

// ───────────── BRAND-003 / BRAND-004 / BRAND-005: components ─────────────

test("[BRAND-004] date-range control: presets for this month, last 30 days, quarter and year; keeps from/to params", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  assert.deepEqual(dateRangePresets(now).map((p) => [p.key, p.from, p.to]), [
    ["month", "2026-10-01", "2026-10-27"], ["30d", "2026-09-28", "2026-10-27"], ["quarter", "2026-10-01", "2026-10-27"], ["year", "2026-01-01", "2026-10-27"],
  ]);
  const ctx = { url: new URL("http://crestmont.test/staff/finance/invoices?status=open&from=2026-01-01&to=2026-01-31&page=3"), now: () => now } as unknown as AppContext;
  const out = dateRange(ctx, { from: "2026-01-01", to: "2026-01-31" }).value;
  assert.match(out, /name="from"[^>]*value="2026-01-01"/);
  assert.match(out, /name="to"[^>]*value="2026-01-31"/);
  assert.match(out, /<input type="hidden" name="status" value="open">/, "other filters survive Apply");
  assert.doesNotMatch(out, /name="page"/, "pagination resets");
  assert.match(out, /href="\/staff\/finance\/invoices\?status=open&amp;from=2026-10-01&amp;to=2026-10-27"/, "preset link keeps status, sets from/to");
  assert.match(out, /aria-label="Date range presets"/);
  assert.match(out, /<legend/);
});

test("[BRAND-004] finance, reports and sales filters use the date-range control without changing query parameter names", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "owner");
  for (const path of ["/staff/sales", "/staff/finance", "/staff/reports", "/staff/finance/invoices?from=2026-01-01&to=2026-03-31"]) {
    const page = await (await c.get(path)).text();
    assert.match(page, /class="filters date-range"/, `${path} uses the date-range control`);
    assert.match(page, /Last 30 days/, `${path} presets`);
  }
  const q = await (await c.get("/staff/finance/invoices?from=2026-01-01&to=2026-03-31")).text();
  assert.match(q, /id="range-from"[^>]*value="2026-01-01"/);
});

test("[BRAND-003] CRM board quick view opens the lead in a drawer and degrades to a normal page", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "owner");
  await app.client().post("/contact", { name: "Drawer Person", email: "drawer@example.com", interest: "other", message: "Please call me about a website." });
  const lead = (await app.db.prepare(`SELECT id FROM leads`).first<{ id: string }>())!;
  const board = await (await c.get("/staff/crm")).text();
  assert.match(board, new RegExp(`<a class="kanban__card" href="/staff/crm/leads/${lead.id}">`), "card is a normal link to the full lead");
  assert.match(board, new RegExp(`<a class="kanban__quick" href="/staff/crm/leads/${lead.id}/quick" data-drawer="/staff/crm/leads/${lead.id}/quick" aria-label="Quick view: Drawer Person">`), "quick view: real href + drawer source");
  assert.match(board, /<dialog class="drawer" id="drawer"/, "drawer dialog rendered once by the layout");
  const quick = await c.get(`/staff/crm/leads/${lead.id}/quick`);
  assert.equal(quick.status, 200, "quick view is a complete page on its own");
  const q = await quick.text();
  assert.match(q, /data-drawer-body data-drawer-title="Drawer Person"/);
  assert.match(q, /Open full lead/);
  // Same record-level rules as the full lead page.
  const rep = await staffClient(app, "sales", "rep@crestmont.test");
  assert.equal((await rep.c.get(`/staff/crm/leads/${lead.id}/quick`)).status, 404, "unassigned rep cannot open someone else's lead");
});

test("[BRAND-005] slow staff sections are marked for skeleton loaders; forms link errors via aria-describedby", async () => {
  const app = await createTestApp();
  const { c } = await staffClient(app, "owner");
  const home = await (await c.get("/staff")).text();
  assert.match(home, /<template id="skeleton-tpl">/);
  assert.match(home, /class="skeleton skeleton--line"/);
  assert.match(home, /href="\/staff\/readiness"[^>]*data-slow/, "navigating to the readiness overview shows a skeleton");
  assert.match(home, /<main id="main" class="page" data-slow-target>/, "page stays fully server-rendered");
  // Validation errors are announced and linked to their fields.
  const res = await app.client().post("/contact", { name: "A", email: "nope", interest: "other", message: "short" });
  assert.equal(res.status, 422);
  const page = await res.text();
  for (const f of ["name", "email", "message"]) {
    assert.match(page, new RegExp(`id="f-${f}"[^>]*aria-invalid="true"[^>]*aria-describedby="f-${f}-err`), `${f} linked to its error`);
    assert.match(page, new RegExp(`<span class="error-text" id="f-${f}-err" role="alert">`));
  }
});

// ───────────── CRM-001: UTM attribution ─────────────

test("[CRM-001] attribution helpers: UTM parsing, referrer reduced to origin+path, DNT/GPC drops the referrer", () => {
  const own = "http://crestmont.test";
  const h = (o: Record<string, string>) => new Headers(o);
  const first = attributionForRequest(new URL(`${own}/pricing?utm_source=google&utm_medium=cpc&utm_campaign=fall-2026&utm_term=web+design&utm_content=ad1&x=1`), h({ referer: "https://www.google.com/search?q=private+stuff" }), undefined, own);
  assert.deepEqual(first.value, { utm_source: "google", utm_medium: "cpc", utm_campaign: "fall-2026", utm_term: "web design", utm_content: "ad1", referrer: "https://www.google.com/search", landing_page: "/pricing" });
  assert.equal(first.changed, true);
  // Later internal navigation keeps the stored campaign.
  const later = attributionForRequest(new URL(`${own}/quote`), h({ referer: `${own}/pricing` }), JSON.stringify(first.value), own);
  assert.deepEqual(later.value, first.value);
  assert.equal(later.changed, false);
  // Do-Not-Track / GPC: referrer not stored.
  for (const sig of [{ dnt: "1" }, { "sec-gpc": "1" }] as Record<string, string>[]) {
    const r = attributionForRequest(new URL(`${own}/?utm_source=newsletter`), h({ referer: "https://mail.example/inbox", ...sig }), undefined, own);
    assert.deepEqual(r.value, { utm_source: "newsletter", landing_page: "/" });
  }
  assert.equal(cleanReferrer("javascript:alert(1)"), undefined);
  assert.deepEqual(sanitizeAttribution({ utm_source: "<script>x", landing_page: "//evil.example/x", referrer: "ftp://x" }), { utm_source: "scriptx" });
});

test("[CRM-001] UTM attribution end to end: landing URL → first-party cookie → hidden fields → stored on the lead → lead detail → /staff/sales breakdown", async () => {
  const app = await createTestApp();
  const visitor = app.client();
  const land = await visitor.request("GET", "/services?utm_source=google&utm_medium=cpc&utm_campaign=fall-2026", { headers: { referer: "https://www.google.com/search?q=web+design" } });
  assert.equal(land.status, 200);
  const setCookie = land.headers.getSetCookie().find((c) => c.startsWith("cm_attr="));
  assert.ok(setCookie, "first-party cookie set by the server");
  assert.match(setCookie!, /HttpOnly/); assert.match(setCookie!, /SameSite=Lax/); assert.match(setCookie!, /Max-Age=2592000/);
  const form = await (await visitor.get("/quote")).text();
  assert.match(form, /<input type="hidden" name="utm_source" value="google">/);
  assert.match(form, /<input type="hidden" name="utm_campaign" value="fall-2026">/);
  assert.match(form, /<input type="hidden" name="referrer" value="https:\/\/www.google.com\/search">/);
  assert.match(form, /<input type="hidden" name="landing_page" value="\/services">/);
  assert.doesNotMatch(form, /googletagmanager|google-analytics|facebook\.net|<script[^>]+src="https?:\/\/(?!challenges\.cloudflare\.com)/, "no third-party tracking");
  const hidden = Object.fromEntries([...form.matchAll(/<input type="hidden" name="(utm_\w+|referrer|landing_page)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&#39;/g, "'").replace(/&amp;/g, "&")]));
  const post = await visitor.post("/quote", { ...hidden, name: "Campaign Person", email: "campaign@example.com", interest: "custom", budget: "$5,000–$10,000", timeline: "1–3 months", message: "We need a booking system for three locations." });
  if (post.status !== 303) {
    // budget/timeline option labels are owned by the public area; read them from the form if they differ.
    const budget = /name="budget"[\s\S]*?<option value="([^"]+)"[^>]*>(?!Choose)/.exec(form)![1].replace(/&amp;/g, "&");
    const timeline = /name="timeline"[\s\S]*?<option value="([^"]+)"[^>]*>(?!Choose)/.exec(form)![1].replace(/&amp;/g, "&");
    const again = await visitor.post("/quote", { ...hidden, name: "Campaign Person", email: "campaign@example.com", interest: "custom", budget, timeline, message: "We need a booking system for three locations." });
    assert.equal(again.status, 303, (await again.text()).slice(0, 400));
  }
  const lead = (await app.db.prepare(`SELECT id, utm_source, utm_medium, utm_campaign, utm_term, referrer, landing_page FROM leads WHERE source = 'quote_form'`).first<Record<string, string | null>>())!;
  assert.deepEqual({ ...lead, id: undefined }, { id: undefined, utm_source: "google", utm_medium: "cpc", utm_campaign: "fall-2026", utm_term: null, referrer: "https://www.google.com/search", landing_page: "/services" });
  const a = await auditRow(app.db, "lead.created", lead.id!);
  assert.match(a!.details_json!, /"attribution":\{"utm_source":"google"/);

  // A second, untagged contact lead and a DNT visitor with a campaign.
  await app.client().post("/contact", { name: "Direct Person", email: "direct@example.com", interest: "other", message: "Just saying hello there." });
  const dnt = app.client();
  await dnt.request("GET", "/?utm_source=newsletter&utm_medium=email", { headers: { referer: "https://mail.example/", dnt: "1" } });
  const dntForm = await dnt.request("GET", "/contact", { headers: { dnt: "1" } });
  const dntHidden = Object.fromEntries([...(await dntForm.text()).matchAll(/<input type="hidden" name="(utm_\w+|referrer|landing_page)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  assert.equal(dntHidden.referrer, undefined, "DNT: referrer not stored");
  // Even if a referrer is posted, DNT/GPC drops it server-side.
  if (!dnt.cookies.has("cm_csrf")) await dnt.get("/login");
  const sp = new URLSearchParams({ _csrf: dnt.cookies.get("cm_csrf")!, ...dntHidden, referrer: "https://mail.example/", name: "Private Person", email: "private@example.com", interest: "other", message: "Hello from a private browser." });
  assert.equal((await dnt.request("POST", "/contact", { body: sp.toString(), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test", "sec-gpc": "1" } })).status, 303);
  const priv = (await app.db.prepare(`SELECT utm_source, utm_medium, referrer FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = 'private@example.com'`).first<Record<string, string | null>>())!;
  assert.deepEqual({ ...priv }, { utm_source: "newsletter", utm_medium: "email", referrer: null });

  // Visible on lead detail and in the sales breakdown.
  const { c } = await staffClient(app, "owner");
  const detail = await (await c.get(`/staff/crm/leads/${lead.id}`)).text();
  assert.match(detail, /<div data-attribution><dl class="dl"><dt>Campaign source<\/dt><dd>google<\/dd><dt>Medium<\/dt><dd>cpc<\/dd><dt>Campaign<\/dt><dd>fall-2026<\/dd>/);
  assert.match(detail, /<dt>Landing page<\/dt><dd>\/services<\/dd>/);
  const sales = await (await c.get("/staff/sales")).text();
  assert.match(sales, /data-attribution-report/);
  const section = sales.slice(sales.indexOf("data-attribution-report"));
  assert.match(section, /<td>google<\/td><td class="num">1<\/td>/);
  assert.match(section, /<td>newsletter<\/td><td class="num">1<\/td>/);
  assert.match(section, /<span class="faint">\(none\)<\/span><\/td><td class="num">1<\/td>/, "untagged leads counted as (none)");
  assert.match(section, /<td>google<\/td><td>cpc<\/td><td>fall-2026<\/td><td class="num">1<\/td>/);
  // Sales reps only see attribution for their own leads.
  const rep = await staffClient(app, "sales", "rep2@crestmont.test");
  const repSales = await (await rep.c.get("/staff/sales")).text();
  assert.doesNotMatch(repSales.slice(repSales.indexOf("data-attribution-report")), /google/);
});

// ───────────── PORTAL-005: general conversations ─────────────

test("[PORTAL-005] general (non-project) conversation: customer ↔ Crestmont with read status, notifications and tenant isolation", async () => {
  const app = await createTestApp();
  const a = await createCustomer(app.db, "gen-a@a.example", "Gen A");
  const b = await createCustomer(app.db, "gen-b@b.example", "Gen B");
  const support = await staffClient(app, "support", "support@crestmont.test");
  const ca = await app.client().login(a.email), cb = await app.client().login(b.email);
  // Customer without any project can still start a conversation.
  assert.match(await (await ca.get("/portal/messages")).text(), /General conversation with Crestmont/);
  assert.equal((await ca.post("/portal/messages/general", { body: "" })).status, 422, "empty message refused");
  assert.equal((await ca.post("/portal/messages/general", { body: "Can you also help with our booking system?", project_id: "ignored" })).status, 303);
  const msg = (await app.db.prepare(`SELECT id, organization_id, project_id FROM messages`).first<{ id: string; organization_id: string; project_id: string | null }>())!;
  assert.deepEqual({ org: msg.organization_id, project: msg.project_id }, { org: a.organizationId, project: null });
  // Staff notified in-app and by email; dashboard shows the unread count.
  assert.ok(await app.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'message' AND subject_type = 'conversation' AND subject_id = ?`).bind(support.id, a.organizationId).first());
  assert.equal((await lastEmail(app.db, support.email))?.subject, "New general message from Gen A");
  assert.match(await (await support.c.get("/staff")).text(), /1 unread general customer message/);
  const list = await (await support.c.get("/staff/conversations")).text();
  assert.match(list, /Gen A<\/a><\/td><td class="num">1<\/td><td><span class="badge badge--info">1 unread/);
  // Customer sees "Not yet read" until staff open the thread.
  assert.match(await (await ca.get("/portal/messages/general")).text(), /Not yet read/);
  const thread = await (await support.c.get(`/staff/conversations/${a.organizationId}`)).text();
  assert.match(thread, /Can you also help with our booking system\?/);
  assert.match(await (await ca.get("/portal/messages/general")).text(), /Seen by Crestmont/);
  // Staff reply + internal note; customer is notified of the reply only, never sees the note.
  assert.equal((await support.c.post(`/staff/conversations/${a.organizationId}`, { body: "Internal: check capacity first.", internal: "1" })).status, 303);
  assert.equal((await support.c.post(`/staff/conversations/${a.organizationId}`, { body: "Yes — we can quote that separately." })).status, 303);
  assert.equal((await lastEmail(app.db, a.email))?.subject, "New message from Crestmont");
  const custView = await (await ca.get("/portal/messages/general")).text();
  assert.match(custView, /we can quote that separately/);
  assert.doesNotMatch(custView, /check capacity/);
  assert.ok(await app.db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND subject_type = 'conversation'`).bind(a.id).first());
  assert.ok(await auditRow(app.db, "message.posted", msg.id));
  // Tenant isolation: org B sees nothing of org A's thread and cannot post into it.
  const bView = await (await cb.get("/portal/messages/general")).text();
  assert.doesNotMatch(bView, /booking system|quote that separately/);
  assert.equal((await cb.get(`/staff/conversations/${a.organizationId}`)).status, 403);
  assert.equal((await cb.post(`/staff/conversations/${a.organizationId}`, { body: "spoof" })).status, 403);
  assert.equal((await cb.get(`/portal/messages/general?org=${a.organizationId}`)).status, 200);
  assert.doesNotMatch(await (await cb.get(`/portal/messages/general?org=${a.organizationId}`)).text(), /booking system/, "?org= cannot select a foreign organization");
  // Staff without customers.read cannot open conversations.
  const dev = await staffClient(app, "developer", "dev@crestmont.test");
  assert.equal((await dev.c.get("/staff/conversations")).status, 403);
  assert.equal((await dev.c.post(`/staff/conversations/${a.organizationId}`, { body: "hi" })).status, 403);
  // Project messages are not mixed into the general thread.
  const pid = await makeProject(app.db, a.organizationId);
  await ca.post(`/portal/projects/${pid}/messages`, { body: "Project-only message" });
  assert.doesNotMatch(await (await support.c.get(`/staff/conversations/${a.organizationId}`)).text(), /Project-only message/);
});

// ───────────── SEC-003: signed share links ─────────────

async function shareSetup() {
  const app = await createTestApp();
  const a = await createCustomer(app.db, "share-a@a.example", "Share A");
  const b = await createCustomer(app.db, "share-b@b.example", "Share B");
  const ca = await app.client().login(a.email), cb = await app.client().login(b.email);
  const pid = await makeProject(app.db, a.organizationId);
  await ca.post(`/portal/projects/${pid}/files`, { file: new File([PDF], "brief.pdf", { type: "application/pdf" }) });
  await ca.post(`/portal/projects/${pid}/files`, { file: new File([PNG], "other.png") });
  const fileId = (await app.db.prepare(`SELECT id FROM files WHERE filename = 'brief.pdf'`).first<{ id: string }>())!.id;
  const otherId = (await app.db.prepare(`SELECT id FROM files WHERE filename = 'other.png'`).first<{ id: string }>())!.id;
  return { ...app, a, b, ca, cb, pid, fileId, otherId };
}
const tokenFrom = (html: string) => /data-share-url>http:\/\/crestmont\.test\/share\/([0-9a-f]{64})</.exec(html)?.[1];

test("[SEC-003] share links: unscanned acknowledgement, max 7 days, token hashed, works without login for that file only, audited on every access", async () => {
  const t = await shareSetup();
  const detail = await (await t.ca.get(`/portal/files/${t.fileId}`)).text();
  assert.match(detail, /Not scanned for malware/, "scan warning shown");
  assert.match(detail, /name="acknowledge_unscanned"/);
  const refused = await t.ca.post(`/files/${t.fileId}/share`, { hours: "24" });
  assert.equal(refused.status, 422, "pending scan requires acknowledgement");
  assert.match(await refused.text(), /has not been scanned for malware/);
  assert.equal((await t.ca.post(`/files/${t.fileId}/share`, { hours: String(7 * 24 + 1), acknowledge_unscanned: "1" })).status, 422, "more than 7 days refused");
  assert.equal((await t.ca.post(`/files/${t.fileId}/share`, { hours: "0", acknowledge_unscanned: "1" })).status, 422);
  const created = await t.ca.post(`/files/${t.fileId}/share`, { hours: "24", acknowledge_unscanned: "1", note: "For our designer" });
  assert.equal(created.status, 201);
  const page = await created.text();
  const token = tokenFrom(page);
  assert.ok(token, "token shown once");
  assert.equal(created.headers.get("cache-control"), "no-store");
  const row = (await t.db.prepare(`SELECT * FROM share_links`).first<Record<string, unknown>>())!;
  assert.notEqual(row.token_hash, token, "only the hash is stored");
  assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
  assert.equal(row.unscanned_acknowledged, 1);
  assert.equal(Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at)), 24 * 3600e3);
  assert.doesNotMatch(await (await t.ca.get(`/files/${t.fileId}/share`)).text(), new RegExp(token!), "token never shown again");
  const created1 = await auditRow(t.db, "share_link.created", t.fileId);
  assert.equal(created1?.actor_user_id, t.a.id);

  // Anonymous visitor: landing page + download of exactly this file.
  const anon = t.client();
  const land = await anon.get(`/share/${token}`);
  assert.equal(land.status, 200);
  assert.equal(land.headers.get("referrer-policy"), "no-referrer");
  const landText = await land.text();
  assert.match(landText, /brief\.pdf/);
  assert.match(landText, /has not been scanned for malware/);
  assert.doesNotMatch(landText, /other\.png|Share A/, "no other files or org details exposed");
  const dl = await anon.post(`/share/${token}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "application/pdf");
  assert.match(dl.headers.get("content-disposition")!, /attachment; filename="brief\.pdf"/);
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), PDF);
  for (const action of ["share_link.viewed", "share_link.downloaded"]) {
    const r = await auditRow(t.db, action, t.fileId);
    assert.ok(r && r.subject_type === "file" && r.organization_id === t.a.organizationId && r.ip !== undefined, `${action} audited`);
  }
  assert.equal((await t.db.prepare(`SELECT access_count FROM share_links`).first<{ access_count: number }>())!.access_count, 2);
  // The token cannot be used against other routes or files.
  assert.equal((await anon.get(`/files/${t.otherId}`)).status, 303, "regular file route still needs login");
  assert.equal((await anon.get(`/share/${"0".repeat(64)}`)).status, 404);
  assert.equal((await anon.get(`/share/not-a-token`)).status, 404);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'share_link.access_denied' AND details_json LIKE '%unknown_token%'`).first());
});

test("[SEC-003] share links: revocation, expiry, tenant isolation, permission to create, and rate limiting", async () => {
  const t = await shareSetup();
  // Org B cannot see, create or revoke share links for org A's file.
  assert.equal((await t.cb.get(`/files/${t.fileId}/share`)).status, 404);
  assert.equal((await t.cb.post(`/files/${t.fileId}/share`, { hours: "24", acknowledge_unscanned: "1" })).status, 404);
  // A customer_member (not admin) cannot create links.
  const memberId = newId("usr");
  const { hashPassword } = await import("../src/lib/auth-crypto.ts");
  await t.db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?)`).bind(memberId, "member@a.example", "Mem Ber", await hashPassword(TEST_PASSWORD), nowIso(), nowIso()).run();
  await t.db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_member',?)`).bind(newId("mbr"), memberId, t.a.organizationId, nowIso()).run();
  const member = await t.client().login("member@a.example");
  assert.match(await (await member.get(`/files/${t.fileId}/share`)).text(), /Only an account administrator can create share links/);
  assert.equal((await member.post(`/files/${t.fileId}/share`, { hours: "24", acknowledge_unscanned: "1" })).status, 403);

  const token = tokenFrom(await (await t.ca.post(`/files/${t.fileId}/share`, { hours: "1", acknowledge_unscanned: "1" })).text())!;
  const linkId = (await t.db.prepare(`SELECT id FROM share_links`).first<{ id: string }>())!.id;
  assert.equal((await t.cb.post(`/files/share-links/${linkId}/revoke`)).status, 404, "other tenant cannot revoke");
  assert.equal((await t.ca.post(`/files/share-links/${linkId}/revoke`)).status, 303);
  assert.equal((await t.ca.post(`/files/share-links/${linkId}/revoke`)).status, 409);
  const revoked = await t.client().get(`/share/${token}`);
  assert.equal(revoked.status, 410);
  assert.match(await revoked.text(), /revoked/);
  assert.equal((await t.client().post(`/share/${token}/download`)).status, 410);
  assert.ok(await auditRow(t.db, "share_link.revoked", t.fileId));
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'share_link.access_denied' AND subject_id = ? AND details_json LIKE '%"reason":"revoked"%'`).bind(t.fileId).first());

  // Expiry.
  const token2 = tokenFrom(await (await t.ca.post(`/files/${t.fileId}/share`, { hours: "1", acknowledge_unscanned: "1" })).text())!;
  await t.db.prepare(`UPDATE share_links SET expires_at = ? WHERE revoked_at IS NULL`).bind(new Date(Date.now() - 1000).toISOString()).run();
  assert.equal((await t.client().get(`/share/${token2}`)).status, 410);
  // Deleted or infected files are never served, and infected files cannot be shared.
  const token3 = tokenFrom(await (await t.ca.post(`/files/${t.otherId}/share`, { hours: "24", acknowledge_unscanned: "1" })).text())!;
  await t.db.prepare(`UPDATE files SET scan_status = 'infected' WHERE id = ?`).bind(t.otherId).run();
  assert.equal((await t.client().get(`/share/${token3}`)).status, 410);
  assert.equal((await t.ca.post(`/files/${t.otherId}/share`, { hours: "24", acknowledge_unscanned: "1" })).status, 422);
  // A clean file needs no acknowledgement.
  await t.db.prepare(`UPDATE files SET scan_status = 'clean' WHERE id = ?`).bind(t.fileId).run();
  const cleanTok = tokenFrom(await (await t.ca.post(`/files/${t.fileId}/share`, { hours: "168" })).text());
  assert.ok(cleanTok);

  // Staff who can read the file can create a link from the project's files tab.
  const owner = await staffClient(t, "owner");
  assert.match(await (await owner.c.get(`/staff/projects/${t.pid}?tab=files`)).text(), new RegExp(`href="/files/${t.fileId}/share">Create share link`));
  assert.equal((await owner.c.post(`/files/${t.fileId}/share`, { hours: "24" })).status, 201);
  const devStaff = await staffClient(t, "developer", "dev-unassigned@crestmont.test");
  assert.equal((await devStaff.c.post(`/files/${t.fileId}/share`, { hours: "24" })).status, 404, "staff without access to the project cannot share");

  // Rate limiting: anonymous accesses per IP per hour.
  const ip = { "x-forwarded-for": "203.0.113.9" };
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await t.client().request("GET", `/share/${cleanTok}`, { headers: ip })).status;
  assert.equal(last, 429);
  assert.ok(await t.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'share_link.rate_limited' AND ip = '203.0.113.9'`).first());
  assert.equal((await t.client().request("GET", `/share/${cleanTok}`, { headers: { "x-forwarded-for": "203.0.113.10" } })).status, 200, "other IPs unaffected");
});

// ───────────── EMP-002: cross-area audit coverage ─────────────

test("[EMP-002] every sensitive action across areas writes an audit_logs row with actor and subject (exercised through real routes)", async () => {
  const { FakeStripe } = { FakeStripe: class {
    readonly configured = true; readonly mode = "test" as const;
    async createCheckout() { return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }; }
    async createBillingPortal() { return { url: "https://billing.stripe.com/p/session/test_1" }; }
    async createRefund() { return { id: "re_test_1", status: "succeeded" }; }
  } };
  const app = await createTestApp({ overrides: { storage: undefined, payments: new FakeStripe() } } as Partial<Env>);
  // createTestApp's storage override is replaced above; restore an in-memory store.
  const { MemoryStorage } = await import("./support/app.ts");
  app.env.overrides!.storage = new MemoryStorage();
  const owner = await staffClient(app, "owner", "owner@crestmont.test");
  const admin = await staffClient(app, "administrator", "admin@crestmont.test");
  const support = await staffClient(app, "support", "support@crestmont.test");
  const dev = await createStaff(app.db, "developer", "dev@crestmont.test");
  const cust = await createCustomer(app.db, "audit@cust.example", "Audit Co");
  const cc = await app.client().login(cust.email);
  const expect: { area: string; action: string; subjectType: string; subjectId: string; actor: string }[] = [];

  // Refund decision (Founder-only) — request → review → recommend → decide.
  const ord = newId("ord"), inv = newId("inv"), pay = newId("pay");
  await app.db.batch([
    app.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?, 'starter', 99900, 'paid', 'package', ?)`).bind(ord, cust.organizationId, nowIso()),
    app.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, paid_at) VALUES (?,?,?, 'full', 99900, 'paid', 'Starter', ?, ?)`).bind(inv, cust.organizationId, ord, nowIso(), nowIso()),
    app.db.prepare(`INSERT INTO payments (id, organization_id, invoice_id, order_id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at) VALUES (?,?,?,?, 99900, NULL, 'pi_test_audit', 'succeeded', ?)`).bind(pay, cust.organizationId, inv, ord, nowIso()),
  ]);
  assert.equal((await cc.post("/portal/billing/refund-request", { payment_id: pay, amount: "100", reason: "Project cancelled before kickoff.", evidence: "Email 2026-10-01" })).status, 303);
  const refundId = (await app.db.prepare(`SELECT id FROM refunds`).first<{ id: string }>())!.id;
  assert.equal((await support.c.post(`/staff/refunds/${refundId}/review`, { to: "under_review", notes: "Checking" })).status, 303);
  assert.equal((await support.c.post(`/staff/refunds/${refundId}/review`, { to: "recommended", notes: "No work started" })).status, 303);
  assert.equal((await owner.c.post(`/staff/refunds/${refundId}/decide`, { decision: "approved", notes: "Approved per policy." })).status, 303);
  expect.push({ area: "finance", action: "refund.approved", subjectType: "refund", subjectId: refundId, actor: owner.id });

  // Role change and user disable (platform).
  assert.equal((await admin.c.post(`/staff/employees/${dev.id}/role`, { role: "project_manager" })).status, 303);
  expect.push({ area: "platform", action: "employee.role_changed", subjectType: "user", subjectId: dev.id, actor: admin.id });
  assert.equal((await admin.c.post(`/staff/employees/${dev.id}/disable`, { reason: "Left the company" })).status, 303);
  expect.push({ area: "platform", action: "employee.disabled", subjectType: "user", subjectId: dev.id, actor: admin.id });

  // Price-sensitive CMS publish (pricing presentation needs pricing.change → Owner).
  assert.equal((await admin.c.post("/staff/cms/pricing.presentation", { heading: "Pricing", lede: "Published prices, enforced by our systems.", starter_tagline: "A focused website.", business_tagline: "More pages.", premium_tagline: "Bespoke design.", custom_heading: "Custom development", custom_body: "Larger work is quoted separately." })).status, 303);
  const rev = (await app.db.prepare(`SELECT id FROM cms_revisions WHERE status = 'pending_founder_approval'`).first<{ id: string }>())!.id;
  assert.equal((await admin.c.post(`/staff/cms/revisions/${rev}/publish`)).status, 403, "administrator cannot publish pricing presentation");
  assert.equal((await owner.c.post(`/staff/cms/revisions/${rev}/publish`)).status, 303);
  expect.push({ area: "public/cms", action: "cms.pricing_presentation_approved", subjectType: "cms_revision", subjectId: rev, actor: owner.id });

  // Release approval (Founder-only, readiness).
  const COMMIT = "abc1234def5678abc1234def5678abc1234def56";
  assert.equal((await owner.c.post("/staff/readiness/releases", { commit_sha: COMMIT, config_sha256: "a".repeat(64), notes: "Candidate notes", rollback_plan: "Redeploy previous worker version" })).status, 303);
  const panel = await (await owner.c.get("/staff/readiness/approve")).text();
  const evSet = /name="evidence_set" value="([0-9a-f]{64})"/.exec(panel)![1];
  assert.equal((await owner.c.post("/staff/readiness/approve", { decision: "approved", confirm_commit: COMMIT, evidence_set: evSet, notes: "Approved" })).status, 303);
  const rcId = (await app.db.prepare(`SELECT id FROM releases ORDER BY rowid DESC LIMIT 1`).first<{ id: string }>())!.id;
  expect.push({ area: "readiness", action: "release.founder_approved", subjectType: "release", subjectId: rcId, actor: owner.id });

  // File download (portal files).
  const pid = await makeProject(app.db, cust.organizationId);
  assert.equal((await cc.post(`/portal/projects/${pid}/files`, { file: new File([PDF], "audit.pdf", { type: "application/pdf" }) })).status, 303);
  const fid = (await app.db.prepare(`SELECT id FROM files WHERE filename = 'audit.pdf'`).first<{ id: string }>())!.id;
  assert.equal((await cc.get(`/files/${fid}`)).status, 200);
  expect.push({ area: "files", action: "file.downloaded", subjectType: "file", subjectId: fid, actor: cust.id });

  // Project cancel (Owner, delivery).
  assert.equal((await owner.c.post(`/staff/projects/${pid}/cancel`, { reason: "Customer requested cancellation in writing" })).status, 303);
  expect.push({ area: "delivery", action: "project.cancelled", subjectType: "project", subjectId: pid, actor: owner.id });

  // Settings change (platform).
  assert.equal((await admin.c.post("/staff/settings", { "business.legal_name": "", "business.address": "", "contact.email": "hello@crestmont.test", "contact.phone": "", staffed_hours: "Mon–Fri 9am–5pm ET", first_response_target_hours: "8" })).status, 303);
  const settingsRow = await auditRow(app.db, "settings.updated");
  assert.equal(settingsRow?.actor_user_id, admin.id);
  assert.equal(settingsRow?.subject_type, "business_settings");

  // Share link creation (this workstream).
  assert.equal((await cc.post(`/files/${fid}/share`, { hours: "24", acknowledge_unscanned: "1" })).status, 201);
  expect.push({ area: "files", action: "share_link.created", subjectType: "file", subjectId: fid, actor: cust.id });

  const missing: string[] = [];
  for (const e of expect) {
    const row = await auditRow(app.db, e.action, e.subjectId);
    if (!row) { missing.push(`${e.area}: ${e.action} (${e.subjectType} ${e.subjectId}) not audited`); continue; }
    if (row.actor_user_id !== e.actor) missing.push(`${e.action}: actor ${row.actor_user_id} ≠ ${e.actor}`);
    if (row.subject_type !== e.subjectType) missing.push(`${e.action}: subject type ${row.subject_type} ≠ ${e.subjectType}`);
    if (row.actor_kind !== "user") missing.push(`${e.action}: actor kind ${row.actor_kind}`);
  }
  assert.deepEqual(missing, []);
  // The audit log is append-only.
  await assert.rejects(app.db.prepare(`DELETE FROM audit_logs`).run(), /append-only/);
});
