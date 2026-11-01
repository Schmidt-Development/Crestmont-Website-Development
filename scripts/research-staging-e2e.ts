// Lead research — live staging E2E. Runs in .github/workflows/deploy-staging.yml after the deploy, against the deployed
// Worker and the real staging D1 (wrangler d1 execute --remote; read-only queries). Real businesses: Overture places
// from research-worker/live/staging-e2e-request.json (extracted in a previous, credential-free step), their live
// websites (robots.txt honoured), researched by the real worker code and delivered to the real staging API, then a
// handful promoted into the real staging CRM through the Owner route (CRM intake engine). Nothing is dialled.
//
//   env: E2E_BASE_URL, E2E_ACCOUNTS_FILE (demo-accounts.md), RESEARCH_RUNNER_SECRET, CLOUDFLARE_API_TOKEN/ACCOUNT_ID
//   node --no-warnings scripts/research-staging-e2e.ts --candidates e2e/candidates.jsonl --request research-worker/live/staging-e2e-request.json
// Output: aggregate PASS/FAIL lines only (the repository is public: no business names, numbers or URLs), ::error
// annotations, a ::notice summary, evidence/research-staging-e2e.json, exit 1 if any check failed. Research is left in
// the pause state it had before the run.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { wranglerOps } from "./staging-access.ts";
import { totpCode } from "../src/lib/auth-crypto.ts";
import { State } from "../research-worker/src/state.ts";
import { loadConfig } from "../research-worker/src/config.ts";
import { Http } from "../research-worker/src/http.ts";
import { Platform, PlatformError, signBody, SIGNATURE_HEADER } from "../research-worker/src/crm-client.ts";
import { ResearchWorker } from "../research-worker/src/orchestrator.ts";
import { silentLogger } from "../research-worker/src/log.ts";
import type { Candidate } from "../research-worker/src/sources/types.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.RESEARCH_RUNNER_SECRET ?? "";
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE ?? "";
if (!BASE || !SECRET) { console.error("::error::E2E_BASE_URL and RESEARCH_RUNNER_SECRET are required"); process.exit(2); }
const req = JSON.parse(readFileSync(arg("request", "research-worker/live/staging-e2e-request.json")!, "utf8")) as { maxPromotions: number };
const candidates = readFileSync(arg("candidates", "e2e/candidates.jsonl")!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Candidate);
const d1 = wranglerOps();
const q = async <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const n = async (sql: string) => Number((await q<{ n: number }>(sql))[0]?.n ?? 0);
const RUNNER = `staging-e2e-${Date.now().toString(36)}`;

type Result = { id: string; ok: boolean; detail: string };
const results: Result[] = [];
async function check(id: string, f: () => Promise<string | void>) {
  try { const d = (await f()) ?? ""; results.push({ id, ok: true, detail: d }); console.log(`PASS ${id}${d ? ` — ${d}` : ""}`); }
  catch (e) { const d = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300); results.push({ id, ok: false, detail: d }); console.log(`FAIL ${id} — ${d}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

// ── browser-less staff session (same rules as scripts/crm-staging-e2e.ts: shared two-factor budget respected) ──
class Session {
  cookies = new Map<string, string>();
  private absorb(res: Response) { for (const c of res.headers.getSetCookie()) { const [pair, ...attrs] = c.split(";"); const i = pair.indexOf("="); const k = pair.slice(0, i).trim(); if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(k); else this.cookies.set(k, decodeURIComponent(pair.slice(i + 1))); } }
  async req(method: string, path: string, form?: Record<string, string>) {
    const csrf = () => this.cookies.get("__Host-cm_csrf") ?? this.cookies.get("cm_csrf");
    if (form && !csrf()) await this.req("GET", "/login");
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    let body: string | undefined;
    if (form) { body = new URLSearchParams({ _csrf: csrf() ?? "", ...form }).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    this.absorb(res);
    return res;
  }
  async login(email: string, password: string, totp: string | null) {
    const userId = (await q<{ id: string }>(`SELECT id FROM users WHERE email = ${lit(email)}`))[0]?.id;
    const effective = async () => {
      const now = Date.now() / 1000, ws = Math.floor(now / 900) * 900;
      const rows = await q<{ window_start: number; count: number }>(`SELECT window_start, count FROM rate_limits WHERE key = ${lit(`mfa:${userId}`)} AND window_start IN (${ws}, ${ws - 900})`);
      const cur = Number(rows.find((r) => Number(r.window_start) === ws)?.count ?? 0), prev = Number(rows.find((r) => Number(r.window_start) === ws - 900)?.count ?? 0);
      return cur + prev * (1 - (now - ws) / 900);
    };
    for (let waited = 0; userId && (await effective()) + 1 > 6; waited += 60) {
      if (waited >= 1800) throw new Error("two-factor budget did not free up within 30 minutes");
      await new Promise((ok) => setTimeout(ok, 60_000));
    }
    const r = await this.req("POST", "/login", { email, password });
    assert(r.status === 303, `login returned ${r.status}`);
    if (!(r.headers.get("location") ?? "").includes("/mfa")) return;
    assert(totp, "account needs a TOTP key");
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise((ok) => setTimeout(ok, 30_000 - (Date.now() % 30_000) + 1_500));
      const m = await this.req("POST", "/mfa", { code: await totpCode(totp) });
      if (m.status === 303 && new URL(m.headers.get("location") ?? "", BASE).pathname !== "/mfa") return;
      if (m.status === 429 || m.status === 503) break;
    }
    throw new Error("two-factor sign-in failed");
  }
}
function accounts(): { role: string; email: string; password: string; totp: string | null }[] {
  if (!ACCOUNTS) return [];
  return [...readFileSync(ACCOUNTS, "utf8").matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] ?? null }));
}

const platform = new Platform(BASE, SECRET);
async function signedRaw(path: string, body: Record<string, unknown>, opts: { secret?: string; nonce?: string | null } = {}) {
  const raw = JSON.stringify({ ...body, ...(opts.nonce === null ? {} : { _nonce: opts.nonce ?? randomBytes(16).toString("hex") }) });
  const res = await fetch(`${BASE}${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(opts.secret ?? SECRET, raw, Math.floor(Date.now() / 1000)) } });
  return res.status;
}
const settingsForm = (paused: boolean, s: { qualify_threshold: number; max_batch: number }) => ({ ...(paused ? { paused: "1", reason: "Research staging E2E finished: paused until the Owner resumes" } : {}), threshold: String(s.qualify_threshold), max_batch: String(s.max_batch) });

async function main() {
  const keys = candidates.map((c) => c.businessKey);
  const inKeys = `(${keys.map(lit).join(",")})`;
  // ── 1. migration and channel security ──
  await check("research.migration_applied", async () => {
    const m = await n(`SELECT COUNT(*) AS n FROM d1_migrations WHERE name LIKE '%_lead_research.sql'`);
    const t = await n(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('research_settings','research_sources','research_runners','research_runner_days','research_batches','research_prospects')`);
    assert(m === 1 && t === 6, `migration rows ${m}, tables ${t}/6`);
    return "6 research tables";
  });
  await check("research.unsigned_refused", async () => {
    const r = await fetch(`${BASE}/api/research/runner/heartbeat`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert(r.status === 401, `unsigned heartbeat → ${r.status}`);
    assert((await signedRaw("/api/research/runner/heartbeat", { runnerId: RUNNER }, { secret: "wrong-" + SECRET })) === 401, "wrong signature not refused");
  });
  let signedOk = false;
  await check("research.replay_refused", async () => {
    const nonce = randomBytes(16).toString("hex");
    const first = await signedRaw("/api/research/runner/heartbeat", { runnerId: RUNNER }, { nonce });
    assert(first === 200, `first signed heartbeat refused (${first}): the staging Worker does not hold this run's research key (RESEARCH_E2E_RUNNER_SECRET)`);
    signedOk = true;
    assert((await signedRaw("/api/research/runner/heartbeat", { runnerId: RUNNER }, { nonce })) === 409, "replayed nonce accepted");
  });
  const initial = (await q<{ paused: number; qualify_threshold: number; max_batch: number }>(`SELECT paused, qualify_threshold, max_batch FROM research_settings WHERE id = 1`))[0];
  const all = accounts();
  const owner = all.find((a) => a.role === "owner"), sales = all.find((a) => a.role === "sales");
  if (!owner || !initial) { results.push({ id: "owner.session", ok: false, detail: !initial ? "research_settings missing" : "no owner demo account" }); return; }
  const os = new Session();
  await check("owner.sign_in", async () => { await os.login(owner.email, owner.password, owner.totp); });
  await check("research.dashboard_owner_only", async () => {
    const r = await os.req("GET", "/staff/research");
    assert(r.status === 200 && /Lead research/.test(await r.text()), `owner dashboard → ${r.status}`);
    const anon = await new Session().req("GET", "/staff/research");
    assert(anon.status === 303 || anon.status === 401, `anonymous → ${anon.status}`);
    if (sales) { const ss = new Session(); await ss.login(sales.email, sales.password, sales.totp); const s = await ss.req("GET", "/staff/research"); assert(s.status === 403, `sales → ${s.status}`); }
  });
  // ── 2. pause gate, then resume ──
  if (initial.paused) await check("research.paused_refuses_batches", async () => {
    const s = await signedRaw("/api/research/runner/batch", { runnerId: RUNNER, batchId: `rb_e2e_paused_${randomBytes(6).toString("hex")}`, prospects: [] });
    assert(s === 409, `batch while paused → ${s}`);
  });
  await check("research.resume", async () => {
    const r = await os.req("POST", "/staff/research/settings", settingsForm(false, initial));
    assert(r.status === 303, `settings → ${r.status}`);
    const c = await platform.heartbeat(RUNNER, "e2e", { day: new Date().toISOString().slice(0, 10) });
    assert(!c.paused, "heartbeat still reports paused");
  });
  // ── 3. real research → staging D1 ──
  const before = { prospects: await n(`SELECT COUNT(*) AS n FROM research_prospects`), batches: await n(`SELECT COUNT(*) AS n FROM research_batches`),
    otherLeads: await n(`SELECT COUNT(*) AS n FROM leads WHERE COALESCE(origin,'') <> 'research_agent'`), researchLeads: await n(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`) };
  const cfg = loadConfig({ CRESTMONT_URL: BASE, RESEARCH_RUNNER_SECRET: SECRET, RESEARCH_RUNNER_ID: RUNNER, COMMON_CRAWL: "off", PLAYWRIGHT: "off", HTTP_CONCURRENCY: "16" });
  const http = new Http({ userAgent: cfg.http.userAgent, robotsToken: "CrestmontResearchBot", timeoutMs: 15_000, perHostIntervalMs: 5_000, concurrency: 16, maxBytes: 3_000_000 });
  const state = new State(":memory:");
  const worker = new ResearchWorker({ cfg: { ...cfg, http: { ...cfg.http, brokenAttempts: 2, brokenRecheckAfterMs: 3 * 60_000 } }, state, http, platform, sources: [], cc: null, browser: null, model: null, log: silentLogger });
  let sent = 0;
  await check("research.real_batch_to_staging_d1", async () => {
    // Without a working key every delivery is refused: fail now instead of waiting out the 20-minute research window.
    assert(signedOk, "not attempted: the signed heartbeat was refused (see research.replay_refused)");
    await worker.heartbeat();
    for (const c of candidates) state.upsertCandidate(c, c.address.state ?? "MI", new Date(), 30);
    const ac = new AbortController();
    const loop = worker.workLoop(ac.signal);
    const deadline = Date.now() + 20 * 60_000;
    while (state.backlog() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
    ac.abort(); await loop;
    for (let i = 0; i < 10 && (state.stages().ready ?? 0) + state.outboxDepth() > 0; i++) sent += (await worker.deliverOnce()).sent;
    const stored = await n(`SELECT COUNT(*) AS n FROM research_prospects WHERE business_key IN ${inKeys}`);
    const classes = worker.status().classCounts;
    assert(state.backlog() === 0, `${state.backlog()} candidates unfinished`);
    assert(stored >= sent && stored > 0, `${stored} of the batch stored in staging D1 (sent ${sent})`);
    return `${candidates.length} real businesses researched, ${sent} sent, ${stored} in staging D1; classes ${JSON.stringify(classes)}`;
  });
  await check("research.evidence_and_provenance_stored", async () => {
    const bad = await n(`SELECT COUNT(*) AS n FROM research_prospects WHERE business_key IN ${inKeys} AND (sources_json NOT LIKE '%"license"%' OR website_json NOT LIKE '%"checks"%' OR last_verified_at IS NULL)`);
    assert(bad === 0, `${bad} prospects without provenance or checks`);
  });
  await check("research.batch_retry_idempotent", async () => {
    const id = `rb_e2e_${randomBytes(8).toString("hex")}`;
    const rows = (state.db.prepare(`SELECT result FROM candidates WHERE stage = 'sent' LIMIT 20`).all() as { result: string }[]).map((r) => r.result);
    assert(rows.length > 0, "no sent results to replay");
    const a = await platform.batch(RUNNER, id, `[${rows.join(",")}]`);
    const b = await platform.batch(RUNNER, id, `[${rows.join(",")}]`);
    assert(b.replay === true && a.created === 0 && b.created === 0, `retry created records (first ${a.created}, retry ${b.created}, replay ${b.replay})`);
  });
  // ── 4. promotion into the real staging CRM (intake engine) ──
  // Only records not yet decided: the same public candidates are researched on every deploy, so earlier runs' promotions
  // are already in staging and must not be counted (or promoted again) as this run's.
  const promotable = await q<{ id: string }>(`SELECT id FROM research_prospects WHERE business_key IN ${inKeys} AND status = 'qualified' ORDER BY score DESC, id LIMIT ${Math.max(1, Math.min(10, req.maxPromotions))}`);
  const ids = `(${promotable.map((p) => lit(p.id)).join(",") || "''"})`;
  let created = 0;
  await check("research.promote_into_staging_crm", async () => {
    if (!promotable.length) return "no qualified prospect in this batch (nothing to promote)";
    const outcomes: Record<string, number> = {};
    for (const p of promotable) {
      const r = await os.req("POST", "/staff/research/promote", { prospect_id: p.id });
      const loc = r.headers.get("location") ?? "";
      const k = r.status === 303 && loc.startsWith("/staff/crm/leads/") ? "lead" : r.status === 303 ? "held_or_existing" : `http_${r.status}`;
      outcomes[k] = (outcomes[k] ?? 0) + 1;
    }
    created = await n(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`) - before.researchLeads;
    assert(!Object.keys(outcomes).some((k) => k.startsWith("http_")), `unexpected responses ${JSON.stringify(outcomes)}`);
    const linked = await n(`SELECT COUNT(*) AS n FROM research_prospects p JOIN leads l ON l.id = p.crm_lead_id WHERE p.id IN ${ids} AND p.status = 'promoted' AND l.origin = 'research_agent' AND l.intake_decision_id IN (SELECT id FROM crm_intake_decisions) AND l.utm_source = 'crestmont-research'`);
    assert(linked === created, `${linked} promoted prospects linked to research leads with an intake decision, ${created} leads created`);
    const audited = await n(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'research.prospect_promoted' AND subject_id IN (${promotable.map((p) => lit(p.id)).join(",")})`);
    assert(audited === created, `${audited} audit rows for ${created} promotions`);
    return `${promotable.length} promoted: ${JSON.stringify(outcomes)}; ${created} new staging CRM leads with intake decision, evidence text and audit entry`;
  });
  await check("research.no_duplicate_lead_on_repeat_promotion", async () => {
    if (!promotable.length) return "nothing promoted";
    const leads0 = await n(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`);
    for (const p of promotable) await os.req("POST", "/staff/research/promote", { prospect_id: p.id });
    const leads1 = await n(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent'`);
    assert(leads1 === leads0, `repeat promotion created ${leads1 - leads0} lead(s)`);
  });
  await check("research.existing_crm_preserved", async () => {
    const other = await n(`SELECT COUNT(*) AS n FROM leads WHERE COALESCE(origin,'') <> 'research_agent'`);
    assert(other === before.otherLeads, `non-research leads changed ${before.otherLeads} → ${other}`);
  });
  await check("research.no_automated_calling", async () => {
    const eligible = await n(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible'`);
    const queued = await n(`SELECT COUNT(*) AS n FROM voice_outbound_requests WHERE phone_e164 IN (SELECT phone_e164 FROM research_prospects WHERE business_key IN ${inKeys} AND phone_e164 IS NOT NULL)`);
    assert(eligible === 0 && queued === 0, `eligible ${eligible}, outbound requests ${queued}`);
  });
  await check("research.dashboard_matches_d1", async () => {
    const total = await n(`SELECT COUNT(*) AS n FROM research_prospects`);
    const html = await (await os.req("GET", "/staff/research")).text();
    const shown = Number(/Businesses on record<\/div><div class="kpi__value">(\d+)/.exec(html)?.[1] ?? -1);
    const callable = Number(/Verified callable today<\/div><div class="kpi__value">(\d+)/.exec(html)?.[1] ?? -1);
    assert(shown === total, `dashboard shows ${shown}, D1 has ${total}`);
    assert(callable === 0, `callable ${callable}`);
    return `${total} businesses on record; callable 0`;
  });
  // ── 5. pause stops new research safely; restore the Owner's original state ──
  await check("research.pause_stops_new_batches", async () => {
    const r = await os.req("POST", "/staff/research/settings", settingsForm(true, initial));
    assert(r.status === 303, `settings → ${r.status}`);
    const c = await platform.heartbeat(RUNNER, "e2e", {});
    assert(c.paused, "heartbeat does not report paused");
    try { await platform.batch(RUNNER, `rb_e2e_after_pause_${randomBytes(6).toString("hex")}`, "[]"); throw new Error("batch accepted while paused"); }
    catch (e) { assert(e instanceof PlatformError && e.status === 409, `batch while paused → ${(e as PlatformError).status ?? (e as Error).message}`); }
  });
  if (!initial.paused) await check("research.restore_resumed_state", async () => { const r = await os.req("POST", "/staff/research/settings", settingsForm(false, initial)); assert(r.status === 303, `settings → ${r.status}`); });
  await check("research.deltas", async () => `prospects +${(await n(`SELECT COUNT(*) AS n FROM research_prospects`)) - before.prospects}, batches +${(await n(`SELECT COUNT(*) AS n FROM research_batches`)) - before.batches}, research leads +${created}`);
}

await main().catch((e) => results.push({ id: "runner", ok: false, detail: String((e as Error).message ?? e).slice(0, 300) }));
const passed = results.filter((r) => r.ok).length, failed = results.length - passed;
for (const r of results.filter((x) => !x.ok).slice(0, 9)) console.log(`::error title=Research staging E2E ${r.id}::${r.detail}`);
console.log(`::notice title=Research staging E2E::${passed} passed, ${failed} failed${failed ? ` — failed: ${results.filter((x) => !x.ok).map((x) => x.id).join(", ")}` : ""}`);
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/research-staging-e2e.json", JSON.stringify({ runner: RUNNER, passed, failed, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lead research — staging E2E\n\n${passed} passed, ${failed} failed\n\n${results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.id}${r.detail ? ` — ${r.detail}` : ""}`).join("\n")}\n`);
process.exit(failed ? 1 : 0);
