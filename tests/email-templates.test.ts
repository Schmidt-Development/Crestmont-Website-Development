// Branded email template registry (EMAIL-002). All sample data is preview/TEST DATA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestApp, createStaff, createCustomer, lastEmail, TEST_PASSWORD } from "./support/app.ts";
import {
  EMAIL_TEMPLATES, REQUIRED_WORKFLOWS, TEMPLATES, PENDING, renderTemplate, renderLayout, identityFrom, sendMail,
  type EmailTemplate, type TemplateDef, type MailIdentity,
} from "../src/services/mailer.ts";
import { OutboxEmail } from "../src/adapters/email.ts";

const NONE: MailIdentity = { legalName: null, address: null, contactEmail: null };
const defOf = (t: EmailTemplate) => TEMPLATES[t] as TemplateDef<EmailTemplate>;

test("[EMAIL-002] every one of the 20 required workflows has exactly one typed template in the registry", () => {
  assert.equal(REQUIRED_WORKFLOWS.length, 20);
  assert.equal(new Set(REQUIRED_WORKFLOWS).size, 20);
  for (const w of REQUIRED_WORKFLOWS) assert.ok(EMAIL_TEMPLATES.includes(w), w);
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [...EMAIL_TEMPLATES].sort(), "one registry entry per template name, no extras");
  for (const t of EMAIL_TEMPLATES) {
    const d = defOf(t);
    assert.equal(d.name, t);
    assert.ok(d.description.length > 10, `${t} description`);
    assert.ok(d.samples.length >= 1, `${t} has preview samples`);
  }
});

test("[EMAIL-002] every template renders branded HTML and plain text; identity shows pending text until recorded, never an invented address", () => {
  for (const t of EMAIL_TEMPLATES) {
    for (const sample of defOf(t).samples) {
      const m = renderTemplate(t, sample as never, NONE);
      assert.ok(m.subject.length > 3 && !/[\r\n]/.test(m.subject), `${t} subject`);
      assert.match(m.html, /^<!doctype html>/, t);
      assert.match(m.html, /CRESTMONT/, `${t} header`);
      assert.match(m.html, /data-footer/, `${t} footer`);
      for (const p of Object.values(PENDING)) { assert.ok(m.html.includes(p), `${t} html pending: ${p}`); assert.ok(m.text.includes(p), `${t} text pending: ${p}`); }
      assert.match(m.text, /Crestmont Website Development/);
      assert.ok(m.text.length > 40, `${t} text body`);
    }
  }
  const id = identityFrom({ "business.legal_name": "Crestmont Test Entity LLC (TEST DATA)", "business.address": "Suite 1, Test Business Center (TEST DATA)", "contact.email": "hello@crestmont.test" });
  const m = renderTemplate("receipt", defOf("receipt").samples[0] as never, id);
  for (const v of ["Crestmont Test Entity LLC (TEST DATA)", "Suite 1, Test Business Center (TEST DATA)", "hello@crestmont.test"]) { assert.ok(m.html.includes(v)); assert.ok(m.text.includes(v)); }
  for (const p of Object.values(PENDING)) assert.ok(!m.html.includes(p), "no pending text once recorded");
});

// Untrusted values: HTML/script injection, attribute breakout, header (CRLF) injection, dangerous URL schemes.
const XSS = [
  `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `'><svg onload=alert(1)>`, `</td></tr></table><iframe src=//evil>`,
  `Name\r\nBcc: victim@evil.example`, `{{7*7}} \${7*7} <% 7*7 %>`, `&lt;script&gt;already-escaped`,
];
const BAD_URLS = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", `https://ok.example/"><script>alert(1)</script>`];
const KEEP = new Set(["event", "kind", "next"]);

function poison(sample: Record<string, unknown>, payload: string, url: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sample)) {
    if (KEEP.has(k) || typeof v !== "string") out[k] = v;
    else out[k] = /url$/i.test(k) ? url : payload;
  }
  return out;
}

test("[EMAIL-002] XSS corpus: no template emits unescaped input, unsafe links or multi-line subjects", () => {
  let checked = 0;
  for (const t of EMAIL_TEMPLATES) {
    for (const sample of defOf(t).samples) {
      for (let i = 0; i < XSS.length; i++) {
        const data = poison(sample as Record<string, unknown>, XSS[i], BAD_URLS[i % BAD_URLS.length]);
        const m = renderTemplate(t, data as never, { legalName: XSS[i], address: XSS[(i + 1) % XSS.length], contactEmail: XSS[(i + 2) % XSS.length] });
        assert.doesNotMatch(m.html, /<script|<img|<svg|<iframe/i, `${t}: markup injected`);
        assert.doesNotMatch(m.html, /<[^>]*\son(error|load)=/i, `${t}: event handler injected into a tag`);
        assert.doesNotMatch(m.html, /href="\s*(javascript|data|vbscript):/i, `${t}: unsafe href`);
        assert.doesNotMatch(m.subject, /[\r\n]/, `${t}: header injection`);
        assert.ok(!/<\/td><\/tr><\/table><iframe/.test(m.html));
        const hrefs = [...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
        for (const h of hrefs) assert.ok(h === "#" || /^https?:\/\//.test(h), `${t}: href ${h}`);
        assert.doesNotMatch(m.text, /(javascript|vbscript|data):/i, `${t}: unsafe URL in text`);
        checked++;
      }
    }
  }
  assert.ok(checked >= EMAIL_TEMPLATES.length * XSS.length);
  // The escaped payload is still visible (content is not silently dropped).
  const m = renderTemplate("support_ticket", { event: "escalated", subject: "<script>alert(1)</script>", ticketRef: "tkt_1", url: "https://example.com/t" }, NONE);
  assert.ok(m.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(m.text.includes("<script>alert(1)</script>"), "plain text keeps the literal characters (text/plain is never rendered as HTML)");
});

test("[EMAIL-002] unsubscribe link only on marketing mail: every workflow is transactional and has none; marketing requires one", () => {
  for (const t of EMAIL_TEMPLATES) {
    assert.equal(defOf(t).category, "transactional", t);
    for (const sample of defOf(t).samples) {
      const m = renderTemplate(t, sample as never, NONE, "https://example.com/unsubscribe?u=1");
      assert.doesNotMatch(m.html, /unsubscribe/i, `${t} html`);
      assert.doesNotMatch(m.text, /unsubscribe/i, `${t} text`);
      assert.match(m.text, /transactional message/);
    }
  }
  const content = { subject: "News", heading: "News", paragraphs: ["Hello"] };
  const mk = renderLayout(content, { category: "marketing", identity: NONE, unsubscribeUrl: "https://example.com/unsubscribe?u=1" });
  assert.match(mk.html, /<a href="https:\/\/example\.com\/unsubscribe\?u=1"[^>]*>Unsubscribe<\/a>/);
  assert.match(mk.text, /Unsubscribe: https:\/\/example\.com\/unsubscribe\?u=1/);
  assert.doesNotMatch(mk.text, /transactional message/);
  assert.throws(() => renderLayout(content, { category: "marketing", identity: NONE }), /unsubscribe/);
});

test("[EMAIL-002] call sites pass data, not copy: no sendMail call in src writes heading/paragraphs/call-to-action copy", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk("src");
  let calls = 0;
  for (const f of files) {
    if (f.endsWith(join("services", "mailer.ts"))) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/sendMail\(ctx, \{/g)) {
      calls++;
      // Inspect the call's object literal (up to its closing "});").
      const body = src.slice(m.index!, src.indexOf("});", m.index!) + 3);
      // (`subject` may legitimately appear as a data field, e.g. a ticket's subject, so the copy markers are these.)
      assert.doesNotMatch(body, /\b(heading|paragraphs|cta):/, `${f}: sendMail call carries copy`);
      assert.match(body, /\bdata\b|\.\.\.spec\b/, `${f}: sendMail call passes data (or a template spec built from data)`);
    }
  }
  assert.ok(calls >= 20, `found ${calls} sendMail call sites`);
});

test("[EMAIL-002] real sends use the registry and the Business settings identity", async () => {
  const t = await createTestApp();
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('business.legal_name', 'Crestmont Test Entity LLC (TEST DATA)', ?)`).bind(new Date().toISOString()).run();
  const cust = await createCustomer(t.db, "reset@email.example");
  assert.equal((await t.client().post("/password/forgot", { email: cust.email })).status, 200);
  const mail = await lastEmail(t.db, cust.email);
  assert.equal(mail?.template, "password_reset");
  assert.equal(mail?.subject, "Reset your Crestmont password");
  assert.match(mail!.text_body, /Crestmont Test Entity LLC \(TEST DATA\)/);
  assert.match(mail!.text_body, new RegExp(PENDING.address));
  // Without a database the identity is pending, never invented.
  const res = await sendMail({ email: new OutboxEmail(t.db) }, { template: "security_notification", to: "sec@email.example", idempotencyKey: "email002:sec", data: { event: "mfa_enabled" } });
  assert.equal(res.status, "queued");
  assert.match((await lastEmail(t.db, "sec@email.example"))!.text_body, new RegExp(PENDING.legalName.replace(/[()]/g, "\\$&")));
});

test("[EMAIL-002] template preview page: Owner/administrator read-only catalogue of every template; everyone else refused", async () => {
  const t = await createTestApp();
  for (const role of ["owner", "administrator"] as const) {
    const s = await createStaff(t.db, role);
    const c = await t.client().login(s.email, TEST_PASSWORD, s.secret);
    const res = await c.get("/staff/email/templates");
    assert.equal(res.status, 200, role);
    const page = await res.text();
    assert.match(page, /20 of 20 required workflows have a template/);
    for (const tpl of EMAIL_TEMPLATES) {
      assert.ok(page.includes(`data-template="${tpl}"`), `${role} sees ${tpl}`);
      for (let i = 0; i < defOf(tpl).samples.length; i++) assert.ok(page.includes(`/staff/email/templates/${tpl}/html?sample=${i}`), `${tpl} sample ${i}`);
    }
    assert.match(page, new RegExp(PENDING.address), "footer shows pending identity");
    assert.doesNotMatch(page, /<form[^>]*method="post"[^>]*action="\/staff\/email\/templates/i, "read-only: no forms");
    const dl = await c.get("/staff/email/templates/support_ticket/html?sample=3");
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
    assert.match(await dl.text(), /first-response target/);
    assert.equal((await c.get("/staff/email/templates/support_ticket/html?sample=99")).status, 404);
    assert.equal((await c.get("/staff/email/templates/support_ticket/html?sample=-1")).status, 404);
    assert.equal((await c.get("/staff/email/templates/nope/html")).status, 404);
    assert.equal((await c.post("/staff/email/templates", {})).status, 404, "no write route");
  }
  for (const role of ["sales", "developer", "project_manager", "support"] as const) {
    const s = await createStaff(t.db, role);
    const c = await t.client().login(s.email, TEST_PASSWORD, s.secret);
    assert.equal((await c.get("/staff/email/templates")).status, 403, role);
    assert.equal((await c.get("/staff/email/templates/invoice/html")).status, 403, role);
  }
  const cu = await createCustomer(t.db, "preview@email.example");
  const cc = await t.client().login(cu.email);
  assert.equal((await cc.get("/staff/email/templates")).status, 403);
  assert.equal((await t.client().get("/staff/email/templates")).status, 303);
});
