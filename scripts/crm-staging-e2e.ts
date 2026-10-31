// CRM duplicate protection — live staging E2E (PR #50). Runs in .github/workflows/deploy-staging.yml after the deploy,
// against the deployed Worker AND the real staging D1 (wrangler d1 execute --remote, read-only queries except the
// synthetic suppression fixtures noted below). All data is SYNTHETIC: names "CRM E2E …", domains <run>.example,
// phone numbers in the fictional 555-01xx range. Synthetic identifiers are erased through the Owner route at the end.
//
//   env: E2E_BASE_URL, E2E_ACCOUNTS_FILE (demo-accounts.md), CRM_IMPORT_SECRET, CLOUDFLARE_API_TOKEN/ACCOUNT_ID (wrangler)
//   node --no-warnings scripts/crm-staging-e2e.ts
// Output: one line per check, ::error annotations for failures, a ::notice summary, evidence/crm-staging-e2e.json,
// exit 1 if any check failed. Never prints secrets, passwords, TOTP keys or session cookies.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { wranglerOps } from "./staging-access.ts";
import { hmacSha256Hex } from "../src/lib/crypto.ts";
import { totpCode } from "../src/lib/auth-crypto.ts";
import { IMPORT_API_VERSION } from "../src/services/crm-import.ts";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.CRM_IMPORT_SECRET ?? "";
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE ?? "";
if (!BASE) { console.error("::error::E2E_BASE_URL is required"); process.exit(2); }
const d1 = wranglerOps();
const q = async <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Result = { id: string; ok: boolean; detail: string };
const results: Result[] = [];
async function check(id: string, f: () => Promise<string | void>) {
  try { const d = (await f()) ?? ""; results.push({ id, ok: true, detail: d }); console.log(`PASS ${id}${d ? ` — ${d}` : ""}`); }
  catch (e) { const d = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300); results.push({ id, ok: false, detail: d }); console.log(`FAIL ${id} — ${d}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

// ── synthetic data for this run ──
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const areas = [202, 212, 248, 303, 312, 313, 404, 415, 517, 586, 616, 617, 702, 713, 734, 810, 818, 906, 919, 989];
const usedPhones = new Set<string>();
const phone = () => { for (;;) { const p = `+1${areas[Math.floor(Math.random() * areas.length)]}55501${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`; if (!usedPhones.has(p)) { usedPhones.add(p); return p; } } };
const fmt = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
const dom = (s: string) => `${s}-${RUN}.example`;
/** Synthetic names carry the run id, so a record left by an earlier run never looks like the same business. */
const nm = (s: string) => `CRM E2E ${RUN} ${s}`;
const erase = { phones: new Set<string>(), emails: new Set<string>() };

// ── signed import client ──
async function signedImport(body: unknown, key: string, opts: { sign?: "good" | "bad" | "none" } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  const ts = Math.floor(Date.now() / 1000);
  if ((opts.sign ?? "good") === "good") headers["x-crestmont-signature"] = `t=${ts},v1=${await hmacSha256Hex(SECRET, `${ts}.${raw}`)}`;
  if (opts.sign === "bad") headers["x-crestmont-signature"] = `t=${ts},v1=${"0".repeat(64)}`;
  const res = await fetch(`${BASE}/api/crm/v1/imports`, { method: "POST", headers, body: raw });
  let json: any = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const rec = (externalId: string, r: Record<string, unknown>) => ({ externalId: `crm-e2e:${RUN}:${externalId}`, ...r });
const batch = (records: unknown[], extra: Record<string, unknown> = {}) => ({ apiVersion: IMPORT_API_VERSION, client: "crm-e2e", records, ...extra });

// ── browser-less staff session (cookie jar + CSRF), for the Owner routes ──
class Session {
  cookies = new Map<string, string>();
  private absorb(res: Response) { for (const c of res.headers.getSetCookie()) { const [pair, ...attrs] = c.split(";"); const i = pair.indexOf("="); const k = pair.slice(0, i).trim(); if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(k); else this.cookies.set(k, decodeURIComponent(pair.slice(i + 1))); } }
  async req(method: string, path: string, form?: Record<string, string>) {
    // Over HTTPS the CSRF cookie is "__Host-cm_csrf" (CREST-GAP-086); plain "cm_csrf" only on http://localhost.
    const csrf = () => this.cookies.get("__Host-cm_csrf") ?? this.cookies.get("cm_csrf");
    if (form && !csrf()) await this.req("GET", "/login");
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    let body: string | undefined;
    if (form) { const sp = new URLSearchParams({ _csrf: csrf() ?? "", ...form }); body = sp.toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    this.absorb(res);
    return res;
  }
  /**
   * Signs a demo account in ONCE. Two-factor attempts are limited to 8 per user per clock-aligned 15-minute window
   * (src/services/auth.ts assertMfaRate, successes included) and the platform's own access check and browser journeys
   * use the same demo accounts: this check must never use up their budget. So it reads the account's current window
   * count from staging D1 and waits for the next window unless at least 3 attempts remain, and makes one attempt
   * (a second only if the code was refused as a replay).
   */
  async login(email: string, password: string, totp: string | null) {
    const userId = (await q<{ id: string }>(`SELECT id FROM users WHERE email = ${lit(email)}`))[0]?.id;
    // Same arithmetic as src/services/security.ts rateLimit (sliding window: current + previous × overlap).
    const effective = async () => {
      const now = Date.now() / 1000, ws = Math.floor(now / 900) * 900;
      const rows = await q<{ window_start: number; count: number }>(`SELECT window_start, count FROM rate_limits WHERE key = ${lit(`mfa:${userId}`)} AND window_start IN (${ws}, ${ws - 900})`);
      const cur = Number(rows.find((r) => Number(r.window_start) === ws)?.count ?? 0), prev = Number(rows.find((r) => Number(r.window_start) === ws - 900)?.count ?? 0);
      return cur + prev * (1 - (now - ws) / 900);
    };
    // Sign in only if this attempt leaves at least two of the 8 attempts for the platform's own checks.
    for (let waited = 0; userId && (await effective()) + 1 > 6; waited += 60) {
      if (waited === 0) console.log("two-factor budget for this demo account is in use by the platform's own checks; waiting for it to free up");
      if (waited >= 1800) throw new Error("two-factor budget did not free up within 30 minutes");
      await new Promise((ok) => setTimeout(ok, 60_000));
    }
    const r = await this.req("POST", "/login", { email, password });
    assert(r.status === 303, `login returned ${r.status}`);
    if (!(r.headers.get("location") ?? "").includes("/mfa")) return;
    assert(totp, "account needs a TOTP key");
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      // Start in a fresh 30 s step: the same code is accepted only once (replay protection).
      await new Promise((ok) => setTimeout(ok, 30_000 - (Date.now() % 30_000) + 1_500));
      const m = await this.req("POST", "/mfa", { code: await totpCode(totp) });
      const loc = m.headers.get("location") ?? "";
      if (m.status === 303 && new URL(loc, BASE).pathname !== "/mfa") return;
      const page = m.status === 303 ? "" : await m.text();
      const msg = (page.match(/<li>([^<]{3,200})<\/li>/)?.[1] ?? page.match(/class="form-errors[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      last = `HTTP ${m.status}${msg ? `: ${msg}` : ""}`;
      // Retry only a plain refusal (likely a replay); never on the rate limit (rendered as 401 "Too many codes") or a lockout.
      if (/too many/i.test(msg) || m.status === 429 || m.status === 503) break;
    }
    throw new Error(`two-factor sign-in failed (${last})`);
  }
}
function accounts(): { role: string; email: string; password: string; totp: string | null }[] {
  if (!ACCOUNTS) return [];
  return [...readFileSync(ACCOUNTS, "utf8").matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] ?? null }));
}

const leadsForPhone = async (e164: string) => Number((await q<{ n: number }>(`SELECT COUNT(DISTINCT l.id) AS n FROM contact_identities ci JOIN contact_identity_links k ON k.identity_id = ci.id AND k.removed_at IS NULL JOIN leads l ON l.contact_id = k.contact_id WHERE ci.kind = 'phone' AND ci.value_norm = ${lit(e164)}`))[0]?.n ?? 0);
const traces = async (e164: string | null, email: string | null) => Number((await q<{ n: number }>(`SELECT
  (SELECT COUNT(*) FROM contact_identities WHERE value_norm IN (${lit(e164 ?? "-")}, ${lit(email ?? "-")})) +
  (SELECT COUNT(*) FROM contacts WHERE lower(COALESCE(email,'')) = ${lit(email ?? "-")} OR replace(replace(replace(replace(COALESCE(phone,''),' ',''),'-',''),'(',''),')','') LIKE '%' || ${lit((e164 ?? "-").slice(-10))}) +
  (SELECT COUNT(*) FROM crm_identity_reviews WHERE lower(COALESCE(candidate_json,'') || COALESCE(proposed_value,'')) LIKE '%' || ${lit(email ?? "-")} || '%') AS n`))[0]?.n ?? 0);

async function main() {
  // ── 0. Owner session, and cleanup of synthetic data earlier runs could not erase ──
  const all = accounts();
  const owner = all.find((a) => a.role === "owner"), sales = all.find((a) => a.role === "sales");
  if (!owner) { results.push({ id: "owner.session", ok: false, detail: "no owner demo account in E2E_ACCOUNTS_FILE" }); return; }
  // Never reuse a fictional number that already exists in staging (e.g. a synthetic shared line kept by design).
  for (const r of await q<{ value_norm: string }>(`SELECT value_norm FROM contact_identities WHERE kind = 'phone' AND value_norm LIKE '%55501__'`)) usedPhones.add(r.value_norm);
  const os = new Session();
  await check("owner.sign_in", async () => {
    try { await os.login(owner.email, owner.password, owner.totp); }
    catch (e) {
      const f = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM security_events WHERE kind IN ('mfa_failed','mfa_locked') AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AND user_id = (SELECT id FROM users WHERE email = ${lit(owner.email)})`).catch(() => [{ n: -1 }]))[0]?.n;
      throw new Error(`${(e as Error).message}; owner two-factor failures in the last 24 h: ${f}`);
    }
  });
  await check("cleanup.earlier_runs", async () => {
    // Synthetic records an earlier (failed) run could not erase: erase their identifiers through the Owner route.
    const rows = await q<{ kind: string; value_norm: string }>(`SELECT DISTINCT ci.kind, ci.value_norm FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
        JOIN contact_identity_links l ON l.contact_id = c.id AND l.removed_at IS NULL JOIN contact_identities ci ON ci.id = l.identity_id
        WHERE (c.name LIKE 'CRM E2E %' OR co.name LIKE 'CRM E2E %') AND (ci.value_norm LIKE '%55501__' OR ci.value_norm LIKE '%.example') LIMIT 200`);
    const phones = rows.filter((r) => r.kind === "phone").map((r) => r.value_norm), emails = rows.filter((r) => r.kind === "email").map((r) => r.value_norm);
    for (let i = 0; i < Math.max(phones.length, emails.length); i += 10) {
      const r = await os.req("POST", "/staff/crm/identity-erasure", { phones: phones.slice(i, i + 10).join("\n"), emails: emails.slice(i, i + 10).join("\n"), note: `CRM E2E ${RUN} cleanup of earlier synthetic runs`, allow_reimport: "1" });
      assert(r.status === 303, `cleanup returned ${r.status}`);
    }
    return `${phones.length} phone(s), ${emails.length} email(s) from earlier runs`;
  });
  // ── 1. Migrations and schema on the real staging D1 ──
  await check("d1.migrations_applied", async () => {
    const names = (await q<{ name: string }>(`SELECT name FROM d1_migrations WHERE name IN ('0047_sales_optimization.sql','0048_contact_identity.sql','0049_crm_identity_erasure.sql') ORDER BY name`)).map((r) => r.name);
    assert(names.length === 3, `applied: ${names.join(", ") || "none"}`);
    return names.join(", ");
  });
  await check("d1.schema_objects", async () => {
    const want = ["contact_identities", "contact_identity_links", "phone_outreach_ledger", "phone_outreach_events", "email_outreach_enrollments", "crm_intake_decisions", "crm_identity_reviews", "crm_field_changes", "crm_import_batches", "crm_write_guard", "crm_erasure_tombstones",
      "contacts_identity_ai", "contacts_identity_au", "contacts_identity_erased", "companies_domain_ai", "companies_domain_au", "contact_identity_norm_v", "company_domain_v"];
    const have = new Set((await q<{ name: string }>(`SELECT name FROM sqlite_master WHERE name IN (${want.map(lit).join(",")})`)).map((r) => r.name));
    const missing = want.filter((w) => !have.has(w));
    assert(!missing.length, `missing: ${missing.join(", ")}`);
    return `${want.length} objects present`;
  });
  await check("d1.backfill_complete", async () => {
    const r = (await q<{ contacts: number; unlinked: number; identities: number }>(`SELECT (SELECT COUNT(*) FROM contacts) AS contacts,
      (SELECT COUNT(*) FROM contact_identity_norm_v v WHERE (v.email_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id WHERE l.contact_id = v.id AND ci.kind = 'email' AND ci.value_norm = v.email_key AND l.removed_at IS NULL))
         OR (v.phone_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id WHERE l.contact_id = v.id AND ci.kind = 'phone' AND ci.value_norm = v.phone_key AND l.removed_at IS NULL))) AS unlinked,
      (SELECT COUNT(*) FROM contact_identities) AS identities`))[0];
    assert(Number(r.unlinked) === 0, `${r.unlinked} contacts with an identifier but no identity link`);
    return `${r.contacts} contacts, ${r.identities} canonical identities, 0 unlinked`;
  });
  await check("d1.integrity", async () => {
    const fk = await q(`PRAGMA foreign_key_check`).catch(() => null);
    if (fk === null) return "PRAGMA foreign_key_check not permitted by D1 here (skipped)";
    assert(fk.length === 0, `${fk.length} foreign-key violations`);
    return "foreign_key_check clean";
  });

  // ── 2. Signed import API ──
  const pA = phone(), eA = `owner@${dom("harbor")}`;
  await check("api.unsigned_401", async () => { const r = await signedImport(batch([rec("u", { business: { name: nm("Unsigned") }, phones: [{ value: phone() }] })]), `e2e-${RUN}-u`, { sign: "none" }); assert(r.status === 401, `got ${r.status}`); });
  await check("api.bad_signature_401", async () => { const r = await signedImport(batch([rec("b", { business: { name: nm("Bad") }, phones: [{ value: phone() }] })]), `e2e-${RUN}-b`, { sign: "bad" }); assert(r.status === 401, `got ${r.status}`); });
  if (!SECRET) { results.push({ id: "api.signed", ok: false, detail: "CRM_IMPORT_SECRET not available to the E2E step" }); }
  await check("api.missing_idempotency_400", async () => { const r = await signedImport(batch([rec("k", { business: { name: nm("NoKey") }, phones: [{ value: phone() }] })]), ""); assert(r.status === 400, `got ${r.status}`); });
  await check("api.dry_run_writes_nothing", async () => {
    const before = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_intake_decisions`))[0].n);
    const r = await signedImport(batch([rec("dry", { business: { name: nm("Dry") }, phones: [{ value: pA }] })], { dryRun: true }), `e2e-${RUN}-dry`);
    assert(r.status === 200 && r.json?.dryRun === true, `got ${r.status}`);
    const after = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_intake_decisions`))[0].n);
    assert(after === before, "a dry run wrote a decision");
  });
  let leadA = "";
  await check("api.create_research_prospect", async () => {
    const r = await signedImport(batch([rec("a", { business: { name: nm("Harbor"), website: `https://${dom("harbor")}` }, contact: { name: nm("Person A") }, phones: [{ value: fmt(pA) }], emails: [{ value: eA.toUpperCase() }], evidence: { sourceUrl: `https://${dom("harbor")}/contact` } })]), `e2e-${RUN}-a`);
    assert(r.status === 200 && r.json.results[0].outcome === "CREATED", `got ${r.status} ${r.json?.results?.[0]?.outcome}`);
    leadA = r.json.results[0].leadId;
    const row = (await q<{ origin: string; source: string }>(`SELECT origin, source FROM leads WHERE id = ${lit(leadA)}`))[0];
    assert(row?.origin === "research_agent", "lead origin not recorded in D1");
    const ids = await q(`SELECT 1 FROM contact_identities WHERE (kind = 'phone' AND value_norm = ${lit(pA)}) OR (kind = 'email' AND value_norm = ${lit(eA)})`);
    assert(ids.length === 2, `expected phone and email identities in D1, found ${ids.length}`);
    erase.phones.add(pA); erase.emails.add(eA);
    return `lead ${leadA}`;
  });
  await check("api.idempotent_replay", async () => {
    const body = batch([rec("a", { business: { name: nm("Harbor"), website: `https://${dom("harbor")}` }, contact: { name: nm("Person A") }, phones: [{ value: fmt(pA) }], emails: [{ value: eA.toUpperCase() }], evidence: { sourceUrl: `https://${dom("harbor")}/contact` } })]);
    const r = await signedImport(body, `e2e-${RUN}-a`);
    assert(r.status === 200 && r.json.replayed === true && r.json.results[0].leadId === leadA, `replay gave ${r.json?.results?.[0]?.leadId}`);
    const conflict = await signedImport({ ...body, records: [{ ...(body.records[0] as object), business: { name: "Different" } }] }, `e2e-${RUN}-a`);
    assert(conflict.status === 409, `key reuse with a different body gave ${conflict.status}`);
  });
  await check("api.same_phone_other_format_links", async () => {
    const r = await signedImport(batch([rec("a2", { business: { name: nm("Harbor"), website: `https://www.${dom("harbor")}/menu` }, phones: [{ value: `${pA.slice(2, 5)}.${pA.slice(5, 8)}.${pA.slice(8)}` }] })]), `e2e-${RUN}-a2`);
    assert(r.status === 200 && ["NO_CHANGE", "EXISTING_CONTACT_LINKED", "EXISTING_BUSINESS_UPDATED"].includes(r.json.results[0].outcome), `outcome ${r.json?.results?.[0]?.outcome}`);
    assert(await leadsForPhone(pA) === 1, "a second lead exists for the number");
    return r.json.results[0].outcome;
  });
  await check("api.concurrent_duplicate_imports", async () => {
    const pC = phone(); erase.phones.add(pC);
    const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => signedImport(batch([rec(`c${i}`, { business: { name: nm("Concurrent"), website: `https://${dom("concurrent")}` }, phones: [{ value: i % 2 ? fmt(pC) : pC }] })]), `e2e-${RUN}-c${i}`)));
    assert(rs.every((r) => r.status === 200), `statuses ${rs.map((r) => r.status).join(",")}`);
    const outcomes = rs.map((r) => r.json.results[0].outcome);
    assert(outcomes.filter((o) => o === "CREATED").length === 1, `outcomes ${outcomes.join(",")}`);
    const n = await leadsForPhone(pC);
    assert(n === 1, `${n} leads in D1 for one number`);
    return outcomes.join(",");
  });
  await check("api.shared_line_two_businesses", async () => {
    const pS = phone(); erase.phones.add(pS);
    const a = await signedImport(batch([rec("s1", { business: { name: nm("Lakeside Dental"), website: `https://${dom("lakeside")}` }, phones: [{ value: pS, label: "shared_line" }] })]), `e2e-${RUN}-s1`);
    const b = await signedImport(batch([rec("s2", { business: { name: nm("Maple Orthodontics"), website: `https://${dom("maple")}` }, phones: [{ value: fmt(pS) }] })]), `e2e-${RUN}-s2`);
    assert(a.json.results[0].outcome === "CREATED" && b.json.results[0].outcome === "CREATED", `outcomes ${a.json?.results?.[0]?.outcome}/${b.json?.results?.[0]?.outcome}`);
    const r = (await q<{ shared: number; contacts: number }>(`SELECT ci.shared, (SELECT COUNT(*) FROM contact_identity_links l WHERE l.identity_id = ci.id AND l.removed_at IS NULL) AS contacts FROM contact_identities ci WHERE ci.kind = 'phone' AND ci.value_norm = ${lit(pS)}`))[0];
    assert(Number(r?.shared) === 1 && Number(r.contacts) === 2, `shared=${r?.shared} contacts=${r?.contacts}`);
    return "one canonical identity, shared, two businesses";
  });
  await check("api.ambiguous_held_for_review", async () => {
    const pH = phone(); erase.phones.add(pH);
    await signedImport(batch([rec("h1", { business: { name: nm("Pine Studio"), website: `https://${dom("pine")}` }, phones: [{ value: pH }] })]), `e2e-${RUN}-h1`);
    const r = await signedImport(batch([rec("h2", { business: { name: nm("Pine Studio"), website: `https://${dom("pinestudio")}` }, phones: [{ value: pH }] })]), `e2e-${RUN}-h2`);
    assert(r.json.results[0].outcome === "POSSIBLE_DUPLICATE_REVIEW" && r.json.results[0].reviewIds.length >= 1, `outcome ${r.json?.results?.[0]?.outcome}`);
  });
  await check("api.suppressed_email_refused", async () => {
    // Synthetic fixture written directly to staging D1: an active suppression for a fictional address of this run.
    const eS = `bounced@${dom("suppressed")}`; erase.emails.add(eS);
    await q(`INSERT INTO email_suppressions (id, email, reason, detail, created_at) VALUES ('sup_e2e_${RUN}', ${lit(eS)}, 'hard_bounce', 'CRM E2E synthetic', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    const r = await signedImport(batch([rec("sup", { business: { name: nm("Suppressed") }, emails: [{ value: eS.toUpperCase() }] })]), `e2e-${RUN}-sup`);
    assert(r.json.results[0].outcome === "SUPPRESSED" && !r.json.results[0].leadId, `outcome ${r.json?.results?.[0]?.outcome}`);
  });

  // ── 3. Owner routes: do-not-call, manual duplicate warning, privacy erasure ──
  await check("api.do_not_call_refused", async () => {
    const pD = phone(); erase.phones.add(pD);
    const r = await os.req("POST", "/staff/voice/dnc", { phone: pD, detail: `CRM E2E ${RUN} synthetic opt-out` });
    assert(r.status === 303, `adding do-not-call returned ${r.status}`);
    const imp = await signedImport(batch([rec("dnc", { business: { name: nm("Quiet Co") }, phones: [{ value: fmt(pD) }] })]), `e2e-${RUN}-dnc`);
    assert(imp.json.results[0].outcome === "SUPPRESSED", `outcome ${imp.json?.results?.[0]?.outcome}`);
  });
  await check("ui.manual_duplicate_warning", async () => {
    const r = await os.req("POST", "/staff/crm/new", { name: nm("Person A2"), email: eA, phone: "", company: "", website: "", interest: "custom", message: "", source: "manual" });
    const h = await r.text();
    assert(r.status === 409 && h.includes("data-duplicate-warning"), `status ${r.status}`);
    assert(await leadsForPhone(pA) === 1, "the warning wrote a lead");
  });
  await check("auth.erasure_unauthorized", async () => {
    const anon = await new Session().req("POST", "/staff/crm/identity-erasure", { emails: eA, note: "anonymous attempt" });
    assert(anon.status !== 200 && (anon.status === 303 || anon.status === 401 || anon.status === 403), `anonymous got ${anon.status}`);
    if (sales) {
      const ss = new Session(); await ss.login(sales.email, sales.password, sales.totp);
      const r = await ss.req("POST", "/staff/crm/identity-erasure", { emails: eA, note: "sales attempt" });
      assert(r.status === 403, `sales got ${r.status}`);
    }
    assert(await traces(pA, eA) > 0, "a refused attempt erased data");
  });
  await check("erasure.owner_erases_person", async () => {
    const r = await os.req("POST", "/staff/crm/identity-erasure", { phones: pA, emails: eA, note: `CRM E2E ${RUN} synthetic erasure request` });
    assert(r.status === 303, `got ${r.status}`);
    const left = await traces(pA, eA);
    assert(left === 0, `${left} traces left in D1`);
    const tomb = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_erasure_tombstones WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')`))[0].n);
    assert(tomb >= 2, `expected keyed tombstones (CRM_ERASURE_HMAC_KEY configured), found ${tomb}`);
    const bad = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_erasure_tombstones WHERE length(key_hash) <> 64 OR key_hash GLOB '*[^0-9a-f]*' OR key_id IS NULL`))[0].n);
    assert(bad === 0, `${bad} tombstone(s) are not keyed 64-hex HMACs with a key id`);
    return `${tomb} tombstone(s)`;
  });
  await check("erasure.reimport_refused", async () => {
    const r = await signedImport(batch([rec("re", { business: { name: nm("Harbor") }, phones: [{ value: pA }] })]), `e2e-${RUN}-re`);
    assert(r.json.results[0].outcome === "SUPPRESSED" && r.json.results[0].suppressed?.erased === true, `outcome ${r.json?.results?.[0]?.outcome}`);
  });
  await check("erasure.repeat_is_safe", async () => {
    const before = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_erasure_tombstones`))[0].n);
    const r = await os.req("POST", "/staff/crm/identity-erasure", { phones: fmt(pA), emails: eA.toUpperCase(), note: `CRM E2E ${RUN} repeated request` });
    assert(r.status === 303, `got ${r.status}`);
    const after = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM crm_erasure_tombstones`))[0].n);
    assert(after === before, `tombstones changed ${before} → ${after}`);
  });

  // ── 4. Cleanup: erase every other synthetic identifier of this run (leaves only anonymised rows and tombstones). ──
  erase.phones.delete(pA); erase.emails.delete(eA);
  await check("cleanup.synthetic_data_erased", async () => {
    const phones = [...erase.phones], emails = [...erase.emails];
    for (let i = 0; i < Math.max(phones.length, emails.length); i += 10) {
      const r = await os.req("POST", "/staff/crm/identity-erasure", { phones: phones.slice(i, i + 10).join("\n"), emails: emails.slice(i, i + 10).join("\n"), note: `CRM E2E ${RUN} cleanup of synthetic data`, allow_reimport: "1" });
      assert(r.status === 303, `cleanup returned ${r.status}`);
    }
    const left = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts WHERE name LIKE ${lit(`CRM E2E ${RUN}%`)}`))[0].n);
    // Shared-line businesses keep their identifier by design until both are erased; the cleanup erases all of them.
    return `${left} synthetic contact name(s) left (anonymised rows read 'Deleted contact')`;
  });
}

await main().catch((e) => results.push({ id: "runner", ok: false, detail: String((e as Error).message ?? e).slice(0, 300) }));
const passed = results.filter((r) => r.ok).length, failed = results.length - passed;
for (const r of results.filter((x) => !x.ok).slice(0, 9)) console.log(`::error title=CRM staging E2E ${r.id}::${r.detail}`);
console.log(`::notice title=CRM staging E2E::${passed} passed, ${failed} failed (run ${RUN})${failed ? ` — failed: ${results.filter((x) => !x.ok).map((x) => x.id).join(", ")}` : ""}`);
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/crm-staging-e2e.json", JSON.stringify({ run: RUN, passed, failed, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### CRM duplicate protection — staging E2E\n\n${passed} passed, ${failed} failed (run ${RUN})\n\n${results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.id}${r.detail ? ` — ${r.detail}` : ""}`).join("\n")}\n`);
process.exit(failed ? 1 : 0);
