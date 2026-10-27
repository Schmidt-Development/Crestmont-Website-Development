// Route security matrix, part 4: input validation and output encoding on EVERY route (SEC-001).
// Every POST route receives missing fields, wrong types, oversized strings, control characters and
// XSS / SQL-injection payloads in every field it reads (field names are discovered by observing which
// form keys the handler actually reads); every GET route receives the same payloads in every query
// parameter it reads; signed JSON endpoints receive malformed and hostile JSON with VALID signatures.
// No request may produce a 5xx, and no payload may come back unescaped in HTML — neither in the
// immediate response nor afterwards on any page (stored XSS sweep). Every record created here is TEST DATA.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, SECRETS, type World } from "./support/security-world.ts";
import { classified, pathFor, appErrors, toLogin, type RouteEntry } from "./support/security-helpers.ts";
import { customerPostFields, auditScenarios, withFakeAi } from "./support/security-scenarios.ts";
import { createCustomer, TEST_PASSWORD, type TestClient } from "./support/app.ts";
import { signEvidence } from "../src/readiness/ingest.ts";
import { signVoiceEvent } from "../src/services/voice.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { signSvix } from "../src/services/email-events.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

let w: World;
const raw0 = () => (w.db as SqliteDb).raw;
let restoreFetch: () => void;
let fuzzUser: { c: TestClient; id: string };
before(async () => {
  w = await buildWorld();
  restoreFetch = withFakeAi(w);
  const cu = await createCustomer(w.db, "fuzz-account@matrix.example", "Fuzz Account Co");
  fuzzUser = { c: await w.app.client().login(cu.email), id: cu.id };
});
after(() => restoreFetch?.());

const XSS = ["<script>x</script>", `"><img src=x onerror=1>`, `'><svg onload=alert(1)>`];
const RAW_MARKERS = ["<script>x</script>", "<img src=x onerror=1>", "<svg onload=alert(1)>"];
const PAYLOADS: Record<string, (k: string) => string | string[] | File> = {
  xss: () => XSS[0],
  attr: () => XSS[1],
  attr2: () => XSS[2],
  sqli: () => "' OR 1=1-- ; DROP TABLE users; --",
  oversized: () => "A".repeat(60_000) + XSS[0],
  wrongTypeArray: () => ["1", XSS[1]],
  wrongTypeNumber: () => "-1e309",
  control: () => "\u0000‮\u0007 🙂 javascript:alert(1)",
  file: (k) => new File([XSS[0]], `${XSS[1]}.pdf`, { type: k.includes("file") || k.includes("screenshot") || k === "attachment" ? "application/pdf" : "text/html" }),
};

/** Which form / query keys a handler reads: observed by instrumenting FormData and URLSearchParams. */
const seen = { form: new Set<string>(), query: new Set<string>() };
function instrument() {
  const fd = FormData.prototype, sp = URLSearchParams.prototype;
  const orig = { fdGet: fd.get, fdAll: fd.getAll, fdHas: fd.has, spGet: sp.get, spAll: sp.getAll, spHas: sp.has };
  fd.get = function (k: string) { seen.form.add(k); return orig.fdGet.call(this, k); };
  fd.getAll = function (k: string) { seen.form.add(k); return orig.fdAll.call(this, k); };
  fd.has = function (this: FormData, k: string) { seen.form.add(k); return orig.fdHas.call(this, k); } as typeof fd.has;
  sp.get = function (k: string) { seen.query.add(k); return orig.spGet.call(this, k); };
  sp.getAll = function (k: string) { seen.query.add(k); return orig.spAll.call(this, k); };
  sp.has = function (this: URLSearchParams, k: string) { seen.query.add(k); return orig.spHas.call(this, k); } as typeof sp.has;
  return () => { fd.get = orig.fdGet; fd.getAll = orig.fdAll; fd.has = orig.fdHas; sp.get = orig.spGet; sp.getAll = orig.spAll; sp.has = orig.spHas; };
}
const IGNORED_FORM = new Set(["_csrf"]);
const IGNORED_QUERY = new Set(["token", "next"]); // capability tokens / redirect targets are validated separately (safeNext)

function clientFor(r: RouteEntry): TestClient {
  switch (r.spec.access.kind) {
    case "public": case "token": case "signed": case "webhook": return w.anon();
    case "session": return fuzzUser.c;
    case "customer": case "authflow": return w.a.admin.c;
    case "staff": return w.staff.owner.c;
  }
}

/** A 5xx that is not the readiness health endpoint deliberately reporting a degraded feed (503 by design, READY-012). */
const serverError = (r: RouteEntry, res: Response) => res.status >= 500 && !(r.key === "GET /api/readiness/health" && res.status === 503);

/** Unescaped payload markers in an HTML response. */
async function rawPayloads(res: Response): Promise<string[]> {
  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return [];
  const body = await res.clone().text();
  const hits = RAW_MARKERS.filter((m) => body.includes(m));
  // Escaping alone does not neutralise a javascript: URL placed in a link or image target.
  const js = /(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.exec(body);
  if (js) hits.push(`${js[0]} (unsafe URL scheme)`);
  return hits;
}

test("[SEC-001] every POST route: missing fields, wrong types, oversized and hostile input never cause a 5xx, and reflected input is HTML-escaped", async () => {
  const restore = instrument();
  const errors0 = appErrors(w.db);
  const problems: string[] = [];
  let requests = 0;
  // Valid bodies (customer bodies and the audit scenarios' staff bodies) let hostile values reach deep code paths.
  const customerBodies = customerPostFields(w, w.a);
  const staffBodies = new Map(auditScenarios(w).filter((s) => s.fields).map((s) => [s.key, s.fields!]));
  type Body = Record<string, string | string[] | File>;
  const baseFor = (key: string): Body => {
    try {
      const f = customerBodies[key]?.() ?? staffBodies.get(key)?.(w) ?? {};
      return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Body;
    } catch { return {}; }
  };
  const send = async (r: RouteEntry, c: TestClient, path: string, variant: string, fields: Body) => {
    const e0 = appErrors(w.db);
    const res = await c.post(path, fields); requests++;
    if (res.status >= 500 || appErrors(w.db) !== e0) problems.push(`${r.key} [${variant}] → ${res.status}`);
    for (const m of await rawPayloads(res)) problems.push(`${r.key} [${variant}] reflected unescaped ${m}`);
    const loc = res.headers.get("location");
    if (res.status === 303 && loc && loc.startsWith("/") && !toLogin(res)) {
      const next = await c.get(loc); requests++;
      if (next.status >= 500) problems.push(`${r.key} [${variant}] → ${loc} → ${next.status}`);
      for (const m of await rawPayloads(next)) problems.push(`${r.key} [${variant}] → ${loc} shows unescaped ${m}`);
    }
  };
  try {
    const posts = classified().filter((r) => r.method === "POST" && r.spec.access.kind !== "signed" && r.spec.access.kind !== "webhook" && !r.spec.api);
    for (const r of posts) {
      const c = clientFor(r);
      const path = pathFor(w, r, w.a);
      // Discover the fields the handler reads: start from a valid body when one is known, then add whatever it asked for.
      const keys = new Set<string>(Object.keys(baseFor(r.key)));
      for (let round = 0; round < 3; round++) {
        seen.form.clear();
        const body: Body = baseFor(r.key);
        for (const k of keys) if (!(k in body)) body[k] = "x";
        const res = await c.post(path, body); requests++;
        if (res.status >= 500) problems.push(`${r.key} discovery → ${res.status}`);
        const before = keys.size;
        for (const k of seen.form) if (!IGNORED_FORM.has(k)) keys.add(k);
        if (keys.size === before) break;
      }
      // Every field at once, for each payload class.
      for (const [variant, make] of Object.entries(PAYLOADS)) {
        const fields: Body = {};
        for (const k of keys) fields[k] = make(k);
        if (variant === "file" && !keys.size) fields.file = make("file");
        await send(r, c, path, variant, fields);
      }
      // One hostile field at a time inside an otherwise valid body, so validation of the other fields does not stop it early.
      for (const k of keys) {
        for (const variant of ["xss", "attr", "oversized", "wrongTypeArray"]) await send(r, c, path, `${variant}:${k}`, { ...baseFor(r.key), [k]: PAYLOADS[variant](k) });
      }
      await send(r, c, path, "missing fields", {});
    }
  } finally { restore(); }
  assert.deepEqual(problems, []);
  assert.ok(requests > 2000, `${requests} requests`);
  assert.equal(appErrors(w.db), errors0, "no server error was recorded");
});

test("[SEC-001] every GET route: hostile values in every query parameter it reads never cause a 5xx and are HTML-escaped", async () => {
  const restore = instrument();
  const problems: string[] = [];
  let withParams = 0;
  try {
    for (const r of classified().filter((x) => x.method === "GET")) {
      const c = clientFor(r);
      const path = pathFor(w, r, w.a);
      seen.query.clear();
      const first = await c.get(path);
      if (serverError(r, first)) problems.push(`${r.key} → ${first.status}`);
      const keys = [...seen.query].filter((k) => !IGNORED_QUERY.has(k));
      if (!keys.length) continue;
      withParams++;
      for (const value of [...XSS, "' OR 1=1--", "A".repeat(5000), "-1", "9999999999999999999999", "2026-13-45", "javascript:alert(1)"]) {
        const u = new URL(path, "http://crestmont.test");
        for (const k of keys) u.searchParams.set(k, value);
        const res = await c.get(u.pathname + u.search);
        if (serverError(r, res)) problems.push(`${r.key} ?${keys.join(",")}=${value.slice(0, 20)} → ${res.status}`);
        for (const m of await rawPayloads(res)) problems.push(`${r.key} ?${keys.join(",")} reflected unescaped ${m}`);
      }
    }
  } finally { restore(); }
  assert.deepEqual(problems, []);
  assert.ok(withParams >= 15, `${withParams} GET routes read query parameters`);
});

test("[SEC-001] signed JSON endpoints: malformed and hostile JSON with valid signatures never cause a 5xx; unsigned bodies are rejected", async () => {
  const anon = w.anon();
  const ts = () => Math.floor(Date.now() / 1000);
  const sign: Record<string, (body: string) => Promise<Record<string, string>>> = {
    "POST /api/readiness/evidence": async (b) => ({ "x-crestmont-signature": await signEvidence(SECRETS.evidence, b) }),
    "POST /api/readiness/deployments": async (b) => ({ "x-crestmont-signature": await signEvidence(SECRETS.evidence, b) }),
    "POST /api/readiness/release-candidates": async (b) => ({ "x-crestmont-signature": await signEvidence(SECRETS.evidence, b) }),
    "POST /api/webhooks/stripe": async (b) => { const t = ts(); return { "stripe-signature": `t=${t},v1=${await hmacSha256Hex(SECRETS.stripe, `${t}.${b}`)}` }; },
    "POST /api/webhooks/voice": async (b) => ({ "x-crestmont-voice-signature": await signVoiceEvent(SECRETS.voice, b) }),
    "POST /api/webhooks/retell": async (b) => ({ "x-retell-signature": await signRetell(SECRETS.retell, b) }),
    "POST /api/webhooks/retell/functions": async (b) => ({ "x-retell-signature": await signRetell(SECRETS.retell, b) }),
    "POST /api/webhooks/resend": async (b) => signSvix(SECRETS.resend, `msg_${Math.random().toString(16).slice(2)}`, b),
    "POST /api/leads": async () => ({}),
    ...Object.fromEntries(["claim", "heartbeat", "checkpoint", "checkpoint/fetch", "requirements", "files", "complete"].map((x) => [`POST /api/builds/runner/${x}`, async (b: string) => ({ "x-crestmont-runner-signature": await signEvidence(SECRETS.runner, b) })])),
  };
  const jsonPosts = classified().filter((r) => r.method === "POST" && (r.spec.access.kind === "signed" || r.spec.access.kind === "webhook" || r.spec.api));
  assert.deepEqual(jsonPosts.map((r) => r.key).filter((k) => !sign[k]), [], "every JSON POST route has a signer");
  const hostile = { id: XSS[0], type: XSS[1], event: XSS[0], call_id: XSS[1], runId: XSS[0], commitSha: "' OR 1=1--", name: XSS[0], email: XSS[1], message: XSS[0], results: [{ requirementId: XSS[0], outcome: XSS[1], testName: XSS[0] }], data: { object: { id: XSS[0], metadata: { invoice_id: "' OR 1=1--" } } } };
  const wrongTypes = { id: 1, type: ["x"], event: { a: 1 }, call_id: null, runId: 7, results: "nope", data: [], name: 42, email: true, tag: {}, status: [] };
  const bodies: Record<string, string> = {
    empty: "", notJson: "<script>x</script>", truncated: '{"id": "evt_1", "type": ', array: "[1,2,3]", nullBody: "null", number: "42",
    hostile: JSON.stringify(hostile), wrongTypes: JSON.stringify(wrongTypes), deep: "[".repeat(5000) + "]".repeat(5000),
    oversized: JSON.stringify({ id: "A".repeat(900_000) }), tooLarge: JSON.stringify({ id: "A".repeat(1_100_000) }),
  };
  const errors0 = appErrors(w.db);
  const problems: string[] = [];
  for (const r of jsonPosts) {
    // Unsigned: rejected before parsing (lead capture is the one public JSON endpoint).
    const unsigned = await anon.request("POST", r.pattern, { body: bodies.hostile, headers: { "content-type": "application/json" } });
    if (r.key !== "POST /api/leads" && unsigned.status !== 401) problems.push(`${r.key} unsigned → ${unsigned.status}`);
    for (const [variant, body] of Object.entries(bodies)) {
      const e0 = appErrors(w.db);
      const res = await anon.request("POST", r.pattern, { body, headers: { "content-type": "application/json", ...(await sign[r.key](body)) } });
      if (res.status >= 500 || appErrors(w.db) !== e0) problems.push(`${r.key} [${variant}] → ${res.status} ${(await res.text()).slice(0, 120)}`);
      if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) problems.push(`${r.key} [${variant}] answered ${res.headers.get("content-type")}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(appErrors(w.db), errors0);
});

test("[SEC-001] stored-XSS sweep: after the fuzz runs, no page anywhere renders a payload unescaped (staff, customer and public views; hostile headers included)", async () => {
  // Hostile request headers are stored too (session user agent, IP on audit rows).
  const hdrs = { "user-agent": XSS[0], "x-forwarded-for": XSS[1] };
  // A fresh account (the fuzz account above may have had its password changed by the fuzzing).
  const hdrUser = await createCustomer(w.db, "header-fuzz@matrix.example", "Header Fuzz Co");
  const body = new URLSearchParams({ email: hdrUser.email, password: TEST_PASSWORD });
  const tmp = w.app.client();
  await tmp.get("/login");
  body.set("_csrf", tmp.cookies.get("cm_csrf")!);
  await tmp.request("POST", "/login", { body: body.toString(), headers: { ...hdrs, "content-type": "application/x-www-form-urlencoded", origin: "http://crestmont.test" } });
  await w.a.admin.c.request("GET", `/files/${w.a.ids.file}`, { headers: hdrs });
  // A file whose NAME is a payload, uploaded through the portal.
  await w.a.admin.c.post("/portal/files", { file: new File(["%PDF-1.4\n"], `${XSS[1]}.pdf`, { type: "application/pdf" }), folder: XSS[0] });

  const problems: string[] = [];
  let pages = 0;
  const views: [string, TestClient, (r: RouteEntry) => boolean][] = [
    ["owner", w.staff.owner.c, (r) => r.spec.access.kind === "staff" || (r.spec.access.kind === "customer" && !!r.spec.access.staffToo)],
    ["customer A", w.a.admin.c, (r) => r.spec.access.kind === "customer" || r.spec.access.kind === "session"],
    ["fuzz user", fuzzUser.c, (r) => r.spec.access.kind === "session"],
    ["anonymous", w.anon(), (r) => r.spec.access.kind === "public" || r.spec.access.kind === "token"],
  ];
  for (const [who, c, applies] of views) {
    for (const r of classified().filter((x) => x.method === "GET" && applies(x))) {
      const res = await c.get(pathFor(w, r, w.a)); pages++;
      if (serverError(r, res)) problems.push(`${who}: ${r.key} → ${res.status}`);
      for (const m of await rawPayloads(res)) problems.push(`${who}: ${r.key} renders unescaped ${m}`);
    }
  }
  // Pages that list the fuzzed records with filters applied.
  for (const p of ["/staff/audit?action=", "/staff/security", "/staff/monitoring", "/staff/email", "/staff/crm?view=list", "/staff/support?status=all", "/staff/projects?status=all", "/staff/tasks?status=all", "/account"]) {
    const res = await (p === "/account" ? tmp : w.staff.owner.c).get(p); pages++;
    for (const m of await rawPayloads(res)) problems.push(`${p} renders unescaped ${m}`);
  }
  // Every email the fuzzing caused to be rendered (registration, invitations, notifications, tickets...): HTML bodies escape input.
  const deliveries = ((w.db as SqliteDb).raw.prepare(`SELECT delivery_id AS id FROM email_messages`).all() as { id: string }[]).map((d) => d.id);
  for (const id of deliveries) {
    const res = await w.staff.owner.c.get(`/staff/email/${id}/html`); pages++;
    for (const m of await rawPayloads(res)) problems.push(`email ${id} HTML body contains unescaped ${m}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(deliveries.length >= 30, `${deliveries.length} rendered emails checked`);
  assert.ok((raw0().prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE html_body LIKE '%&lt;script&gt;x&lt;/script&gt;%'`).get() as { n: number }).n >= 1, "fuzzed input reached rendered emails (escaped)");
  assert.ok(pages >= 150, `${pages} pages swept`);
  // The payloads really are stored (so the sweep above is meaningful), only ever escaped on output.
  const raw = (w.db as SqliteDb).raw;
  assert.ok((raw.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_agent = ?`).get(XSS[0]) as { n: number }).n >= 1);
  assert.ok((raw.prepare(`SELECT COUNT(*) AS n FROM files WHERE filename LIKE '%onerror%'`).get() as { n: number }).n >= 1);
  assert.ok((raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%<script>x</script>%'`).get() as { n: number }).n >= 1);
});

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, CRLF or LF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test("[SEC-001] CSV exports neutralise spreadsheet formulas in every cell, including hostile values entered through the forms", async () => {
  // Formula payloads entered through real forms (lead contact, refund reason, project cost description).
  const formula = ["=HYPERLINK(\"https://evil.example\",\"x\")", "+SUM(1,1)", "-2+3", "@cmd|' /C calc'!A0", "\t=1+1"];
  for (const [i, f] of formula.entries()) {
    await w.staff.owner.c.post("/staff/crm/new", { name: f, email: `formula${i}@matrix.example`, phone: "", company: f, website: "", interest: "business", message: f, source: "referral" });
    await w.staff.owner.c.post("/staff/finance/costs", { project_id: w.b.ids.project!, category: "hosting", amount: "1", description: f, incurred_on: "2026-10-01" });
  }
  const exports = classified().filter((r) => r.method === "GET" && /\.csv$/.test(r.pattern) || r.key === "GET /staff/reports/:file");
  const problems: string[] = [];
  let cells = 0;
  for (const r of exports) {
    const paths = r.key === "GET /staff/reports/:file"
      ? ["transactions", "invoices", "refunds", "subscriptions", "profitability"].map((k) => `/staff/reports/${k}.csv?from=2020-01-01&to=2030-12-31`)
      : [pathFor(w, r, w.a)];
    for (const p of paths) {
      const res = await w.staff.owner.c.get(p);
      if (res.status !== 200) { problems.push(`${p} → ${res.status}`); continue; }
      for (const row of parseCsv(await res.text())) for (const c of row) { cells++; if (/^[=+\-@\t\r]/.test(c)) problems.push(`${p}: cell starts a formula: ${c.slice(0, 40)}`); }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(exports.length >= 5 && cells > 100, `${exports.length} exports, ${cells} cells`);
  // The hostile values really are in the exports, neutralised with a leading apostrophe.
  const leads = await (await w.staff.owner.c.get("/staff/crm/export.csv")).text();
  assert.ok(leads.includes("'=HYPERLINK"), "lead export contains the neutralised formula");
});

test("[SEC-001] invoice and receipt PDFs encode hostile text: PDF string delimiters are escaped and nothing can break out of a text operator", async () => {
  // A customer name and invoice description that try to close the PDF string and inject operators.
  const evil = "ZZPDF) Tj ET BT /F1 99 Tf (pwned\\";
  await w.db.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).bind(evil, w.b.orgId).run();
  await w.db.prepare(`UPDATE invoices SET description = ? WHERE id = ?`).bind(evil, w.b.ids.paidInvoice!).run();
  const docs = [
    [w.staff.owner.c, `/staff/finance/invoices/${w.b.ids.paidInvoice}/pdf`], [w.staff.owner.c, `/staff/finance/receipts/${w.b.ids.payment}/pdf`],
    [w.b.admin.c, `/portal/billing/invoices/${w.b.ids.paidInvoice}/pdf`], [w.b.admin.c, `/portal/billing/receipts/${w.b.ids.payment}/pdf`],
  ] as const;
  for (const [c, p] of docs) {
    const res = await c.get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type") ?? "", /application\/pdf/);
    const text = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
    assert.ok(text.includes("ZZPDF\\) Tj ET BT"), `${p}: the hostile name is present, escaped`);
    assert.ok(!/ZZPDF\) Tj/.test(text), `${p}: the hostile name does not close its string`);
    assert.ok(!text.includes("(pwned\\)"), `${p}: a trailing backslash cannot escape the closing delimiter`);
  }
});
