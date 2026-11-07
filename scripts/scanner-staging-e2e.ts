// Malware scanning lifecycle — live staging E2E (SEC-003, F-02). Runs in deploy-staging.yml after the deploy.
//
// The deployed Worker, staging D1 and R2, the REAL scanner code (scanner/src) and a REAL ClamAV daemon (the same
// pinned clamav/clamav image Node 1 runs, started by the workflow on 127.0.0.1:3310 with its bundled signatures):
//   1. a demo customer uploads two harmless files (text, PDF) and the standard EICAR antivirus test file through
//      the portal, i.e. the real upload validation path;
//   2. a share link exists for the EICAR file before it is scanned (synthetic row, token known only to this run);
//   3. the scanner pulls work over the signed /api/scan/* surface, fetches each file's bytes, verifies their SHA-256,
//      streams them to clamd and reports verdicts; the queue it sees is narrowed to THIS run's files so the other
//      files on staging are left exactly as they are;
//   4. checks: harmless → "Scanned clean" and still downloadable byte for byte; EICAR → infected with a named
//      detection, download refused to the customer, the share link revoked and refused to an outsider; the
//      verdicts appended to file_scans; infected is terminal (a second pass changes nothing);
//   5. the real scanner process (`node scanner/src/main.ts --preflight`) sends a signed heartbeat that staging
//      records, so the malware-scan feed shows the engine and its signature date;
//   6. cleanup: the run's files are removed through the portal and the synthetic share link row is deleted.
//
// Synthetic data only. The EICAR string is assembled at run time and is the industry-standard harmless test file.
//   env: E2E_BASE_URL, E2E_ACCOUNTS_FILE, FILE_SCANNER_SECRET, CLOUDFLARE_API_TOKEN/ACCOUNT_ID (wrangler), CLAMD_PORT (3310)
// Output: one line per check, ::error annotations, evidence/scanner-staging-e2e.json, exit 1 if any check failed.
// Never prints secrets, passwords, tokens or cookies.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { wranglerOps } from "./staging-access.ts";
import { platform } from "../scanner/src/platform.ts";
import { Scanner } from "../scanner/src/scanner.ts";
import { ping } from "../scanner/src/clamd.ts";
import { totpCode } from "../src/lib/auth-crypto.ts";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.FILE_SCANNER_SECRET ?? "";
const ACCOUNTS = process.env.E2E_ACCOUNTS_FILE ?? "";
const CLAMD = { host: "127.0.0.1", port: Number(process.env.CLAMD_PORT ?? 3310), timeoutMs: 60_000 };
// E2E_REMOTE_SCANNER=1 leaves the scanning to whatever scanner is already serving this platform -- the operational
// one on Node 1 -- instead of running one here. A scanner that passes its own tests in CI proves the code; only this
// proves the DEPLOYMENT: real portal upload, the platform's own queue, that scanner's signed verdict, the row it
// writes. It costs a wait, because that scanner polls on its own schedule.
const REMOTE = process.env.E2E_REMOTE_SCANNER === "1";
const REMOTE_WAIT_MS = Number(process.env.E2E_REMOTE_WAIT_SECONDS ?? 420) * 1000;
if (!BASE || !SECRET || !ACCOUNTS) { console.error("::error::E2E_BASE_URL, FILE_SCANNER_SECRET and E2E_ACCOUNTS_FILE are required"); process.exit(2); }
// E2E_LOCAL_DB: run the same checks against `npm run dev` and its SQLite file, to rehearse this script before staging.
const d1 = process.env.E2E_LOCAL_DB
  ? await (async () => { const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(process.env.E2E_LOCAL_DB!);
      return { query: async <T>(sql: string) => db.prepare(sql).all() as T[] }; })()
  : wranglerOps();
const q = async <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Result = { id: string; ok: boolean; detail: string };
const results: Result[] = [];
async function check(id: string, f: () => Promise<string | void>) {
  try { const d = (await f()) ?? ""; results.push({ id, ok: true, detail: d }); console.log(`PASS ${id}${d ? ` — ${d}` : ""}`); }
  catch (e) { const d = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300); results.push({ id, ok: false, detail: d }); console.log(`FAIL ${id} — ${d}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const RUN = `scan-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
const FILES = {
  text: { name: `${RUN}-brief.txt`, type: "text/plain", bytes: new TextEncoder().encode(`Scanner E2E ${RUN}: a harmless project brief.\n`) },
  pdf: { name: `${RUN}-scope.pdf`, type: "application/pdf", bytes: new TextEncoder().encode(`%PDF-1.4\n% Scanner E2E ${RUN}: harmless\n%%EOF\n`) },
  eicar: { name: `${RUN}-eicar.txt`, type: "text/plain", bytes: new TextEncoder().encode(EICAR) },
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Customer session: cookie jar + CSRF, urlencoded and multipart forms. */
class Session {
  cookies = new Map<string, string>();
  private absorb(res: Response) { for (const c of res.headers.getSetCookie()) { const [pair, ...attrs] = c.split(";"); const i = pair.indexOf("="); const k = pair.slice(0, i).trim(); if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(k); else this.cookies.set(k, decodeURIComponent(pair.slice(i + 1))); } }
  private csrf() { return this.cookies.get("__Host-cm_csrf") ?? this.cookies.get("cm_csrf"); }
  async req(method: string, path: string, form?: Record<string, string> | FormData) {
    if (form && !this.csrf()) await this.req("GET", "/login");
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    let body: string | FormData | undefined;
    if (form instanceof FormData) { form.set("_csrf", this.csrf() ?? ""); body = form; }
    else if (form) { body = new URLSearchParams({ _csrf: this.csrf() ?? "", ...form }).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    this.absorb(res);
    return res;
  }
}
function customerAccount() {
  const rows = [...readFileSync(ACCOUNTS, "utf8").matchAll(/^\| (\w+) \| (\S+) \| `([^`]+)` \| (?:`([A-Z2-7]+)`|—) \|/gm)].map((m) => ({ role: m[1], email: m[2], password: m[3], totp: m[4] ?? null }));
  // A customer the browser journeys do not use (they use customer.harbor), so this run never spends their two-factor
  // attempts. Since FD-30 every customer administrator has two-factor; staging access issues their setup keys.
  return rows.find((r) => r.role === "customer_admin" && !r.email.startsWith("customer.harbor@")) ?? rows.find((r) => r.role === "customer_admin");
}

const ids: Record<keyof typeof FILES, string> = { text: "", pdf: "", eicar: "" };
const shareToken = randomBytes(32).toString("hex");
const shareId = `shr_${RUN.replace(/-/g, "")}`;
const cust = new Session();

await check("clamd answers (pinned clamav/clamav image, bundled signatures)", async () => {
  for (let i = 0; i < 60; i++) { try { if (await ping(CLAMD)) return `127.0.0.1:${CLAMD.port}`; } catch { /* still loading */ } await new Promise((r) => setTimeout(r, 5_000)); }
  throw new Error("clamd did not answer PING within 5 minutes");
});

await check("customer signs in and uploads two harmless files and the EICAR test file through the portal", async () => {
  const acct = customerAccount();
  assert(acct, "no customer_admin demo account in the accounts file");
  const r = await cust.req("POST", "/login", { email: acct.email, password: acct.password });
  assert(r.status === 303, `login returned ${r.status}`);
  if ((r.headers.get("location") ?? "").includes("/mfa")) {
    assert(acct.totp, "the customer needs two-factor (FD-30) but the accounts file has no setup key for it");
    // A code is accepted once per 30-second step (replay protection): start in a fresh step, one retry at most.
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      await new Promise((res) => setTimeout(res, 30_000 - (Date.now() % 30_000) + 1_500));
      const m = await cust.req("POST", "/mfa", { code: await totpCode(acct.totp) });
      ok = m.status === 303 && new URL(m.headers.get("location") ?? "/mfa", BASE).pathname !== "/mfa";
    }
    assert(ok, "two-factor sign-in was refused");
  }
  for (const [k, f] of Object.entries(FILES) as [keyof typeof FILES, (typeof FILES)[keyof typeof FILES]][]) {
    const fd = new FormData();
    fd.set("file", new File([f.bytes], f.name, { type: f.type }));
    fd.set("folder", "Scanner E2E");
    const up = await cust.req("POST", "/portal/files", fd);
    assert(up.status === 303, `upload ${k} returned ${up.status}: ${(await up.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}`);
    const row = (await q<{ id: string; sha256: string; scan_status: string }>(`SELECT id, sha256, scan_status FROM files WHERE filename = ${lit(f.name)} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`))[0];
    assert(row, `${k} not found in D1 after upload`);
    assert(row.sha256 === sha(f.bytes), `${k}: stored SHA-256 differs from the uploaded bytes`);
    assert(row.scan_status === "pending", `${k} starts as ${row.scan_status}, expected pending`);
    ids[k] = row.id;
  }
  return "3 files pending";
});

await check("a share link for the EICAR file works before it is scanned", async () => {
  assert(ids.eicar, "no EICAR file");
  const f = (await q<{ organization_id: string; uploaded_by: string }>(`SELECT organization_id, uploaded_by FROM files WHERE id = ${lit(ids.eicar)}`))[0];
  await q(`INSERT INTO share_links (id, token_hash, file_id, organization_id, created_by, created_at, expires_at, unscanned_acknowledged, note)
           VALUES (${lit(shareId)}, ${lit(sha(new TextEncoder().encode(shareToken)))}, ${lit(ids.eicar)}, ${lit(f.organization_id)}, ${lit(f.uploaded_by)}, ${lit(new Date().toISOString())}, ${lit(new Date(Date.now() + 3_600_000).toISOString())}, 1, ${lit(`Scanner E2E ${RUN}`)})`);
  const r = await fetch(`${BASE}/share/${shareToken}`, { redirect: "manual" });
  if (REMOTE && r.status !== 200) {
    const st = (await q<{ scan_status: string }>(`SELECT scan_status FROM files WHERE id = ${lit(ids.eicar)}`))[0]?.scan_status;
    return `the remote scanner reached it first (${st}); the revocation check below still applies`;
  }
  assert(r.status === 200, `share link answered ${r.status} before the scan`);
  assert(/has not been scanned for malware/.test(await r.text()), "the unscanned warning is shown");
});

// The real scanner, against the real endpoints, with the queue narrowed to this run's files.
const real = platform({ url: BASE, secret: SECRET, timeoutMs: 60_000 });
const mine = new Set<string>();
const api = { ...real, queue: async (limit: number) => { const qq = await real.queue(100); return { ...qq, files: qq.files.filter((f) => mine.has(f.fileId)).slice(0, limit) }; } };
const scanner = new Scanner({ scannerId: "staging-ci-clamav", batch: 10, maxBytes: 26_214_400, clamd: CLAMD }, api);

await check(REMOTE
  ? "the scanner already serving this platform reports a verdict for each file (its own poll, its own signed result)"
  : "the scanner reports a verdict for each file (queue → bytes → SHA-256 → clamd → signed result)", async () => {
  for (const v of Object.values(ids)) if (v) mine.add(v);
  assert(mine.size === 3, "uploads missing");

  if (REMOTE) {
    // No local scan. Wait for the rows, then read the engine the remote scanner actually reported with. A file still
    // pending at the deadline is a failure, never a pass: nothing here may label an unscanned file clean.
    const idList = [...mine].map((i) => lit(i)).join(",");
    const deadline = Date.now() + REMOTE_WAIT_MS;
    // files.scan_status is the state the platform acts on; file_scans is the append-only record of who reported it
    // and with which engine (0040_security_readiness.sql). Reading both is how the engine gets named here.
    let rows: { id: string; scan_status: string; engine: string | null }[] = [];
    for (;;) {
      rows = await q<{ id: string; scan_status: string; engine: string | null }>(
        `SELECT f.id, f.scan_status, (SELECT s.engine FROM file_scans s WHERE s.file_id = f.id ORDER BY s.recorded_at DESC LIMIT 1) AS engine
           FROM files f WHERE f.id IN (${idList})`);
      if (rows.length === 3 && rows.every((r) => r.scan_status !== "pending")) break;
      const left = Math.round((deadline - Date.now()) / 1000);
      assert(left > 0, `still pending after ${Math.round(REMOTE_WAIT_MS / 1000)}s: ${rows.map((r) => `${r.id}=${r.scan_status}`).join(", ")}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const clean = rows.filter((r) => r.scan_status === "clean").length;
    const infected = rows.filter((r) => r.scan_status === "infected").length;
    assert(clean === 2 && infected === 1, `clean ${clean}, infected ${infected} (${rows.map((r) => `${r.id}=${r.scan_status}`).join(", ")})`);
    return `engine ${rows.find((r) => r.engine)?.engine ?? "not recorded"} (remote scanner)`;
  }

  const queued = (await real.queue(100)).files.filter((f) => mine.has(f.fileId)).length;
  assert(queued === 3, `the platform's queue offers ${queued} of this run's 3 files`);
  const r = await scanner.cycle();
  assert(!r.error, r.error ?? "");
  assert(r.clean === 2 && r.infected === 1 && r.failed === 0, `clean ${r.clean}, infected ${r.infected}, failed ${r.failed}, deferred ${r.deferred}`);
  return `engine ${r.engine}`;
});

await check("harmless files are scanned clean and still download byte for byte", async () => {
  for (const k of ["text", "pdf"] as const) {
    const s = (await q<{ scan_status: string }>(`SELECT scan_status FROM files WHERE id = ${lit(ids[k])}`))[0]?.scan_status;
    assert(s === "clean", `${k} is ${s}`);
    const d = await cust.req("GET", `/files/${ids[k]}`);
    assert(d.status === 200, `${k} download answered ${d.status}`);
    assert(sha(new Uint8Array(await d.arrayBuffer())) === sha(FILES[k].bytes), `${k} downloaded bytes differ`);
  }
  const page = await cust.req("GET", `/portal/files/${ids.text}`);
  assert(/Scanned clean/.test(await page.text()), "the portal shows 'Scanned clean'");
});

await check("EICAR is quarantined: infected with a named detection, download refused, share link revoked", async () => {
  const s = (await q<{ scan_status: string }>(`SELECT scan_status FROM files WHERE id = ${lit(ids.eicar)}`))[0]?.scan_status;
  assert(s === "infected", `EICAR is ${s}`);
  const scan = (await q<{ verdict: string; signature: string; engine: string; scanned_sha256: string }>(`SELECT verdict, signature, engine, scanned_sha256 FROM file_scans WHERE file_id = ${lit(ids.eicar)} ORDER BY recorded_at DESC LIMIT 1`))[0];
  assert(scan?.verdict === "infected" && /eicar/i.test(scan.signature ?? ""), `file_scans: ${JSON.stringify(scan ?? null)}`);
  assert(scan.scanned_sha256 === sha(FILES.eicar.bytes), "the verdict is bound to the stored bytes' SHA-256");
  const d = await cust.req("GET", `/files/${ids.eicar}`);
  assert(d.status >= 400, `customer download of the infected file answered ${d.status}`);
  await d.arrayBuffer();
  const link = (await q<{ revoked_at: string | null }>(`SELECT revoked_at FROM share_links WHERE id = ${lit(shareId)}`))[0];
  assert(link?.revoked_at, "the share link was not revoked");
  const out = await fetch(`${BASE}/share/${shareToken}`, { redirect: "manual" });
  assert(out.status === 410, `the share link answered ${out.status} to an outsider after the verdict`);
  const audit = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'file.quarantined' AND subject_id = ${lit(ids.eicar)}`))[0]?.n;
  assert(Number(audit) >= 1, "no file.quarantined audit entry");
  return scan.signature;
});

await check("infected is terminal: a second pass reports nothing, and the scanner can no longer read the file", async () => {
  const r = await scanner.cycle();
  assert(!r.error && r.scanned === 0, `second pass: ${JSON.stringify(r)}`);
  await real.file(ids.eicar).then(() => { throw new Error("the scanner credential could still read the quarantined file"); }, (e: Error & { status?: number }) => assert(e.status === 409, `expected 409, got ${e.status}: ${e.message}`));
});

await check("the scanner process sends a signed heartbeat; staging records engine and signature date", async () => {
  const p = spawnSync(process.execPath, ["--no-warnings", "scanner/src/main.ts", "--preflight"], {
    env: { PATH: process.env.PATH, PLATFORM_URL: BASE, FILE_SCANNER_SECRET: SECRET, SCANNER_ID: "staging-ci-clamav", CLAMD_HOST: CLAMD.host, CLAMD_PORT: String(CLAMD.port), HEALTH_PORT: "0" },
    encoding: "utf8", timeout: 120_000,
  });
  assert(p.status === 0, `preflight exited ${p.status}: ${(p.stdout + p.stderr).slice(-300)}`);
  // Exit 0 alone proves nothing (a process that never ran its main also exits 0): it must say what it checked.
  assert(/preflight: clamd ok .*platform accepted the signed heartbeat/.test(p.stdout), `preflight said: ${(p.stdout + p.stderr).slice(-300) || "nothing"}`);
  const hb = (await q<{ engine: string; signatures_at: string | null; daemon_ok: number; seen_at: string }>(`SELECT engine, signatures_at, daemon_ok, seen_at FROM scanner_heartbeats WHERE scanner_id = 'staging-ci-clamav'`))[0];
  assert(hb && hb.daemon_ok === 1, `heartbeat row: ${JSON.stringify(hb ?? null)}`);
  assert(Date.now() - Date.parse(hb.seen_at) < 10 * 60_000, "heartbeat is not recent");
  return `${hb.engine}; signatures ${hb.signatures_at ?? "date unreadable"}`;
});

await check("cleanup: the run's files are removed through the portal and the synthetic share link row deleted", async () => {
  for (const id of Object.values(ids).filter(Boolean)) {
    const r = await cust.req("POST", `/portal/files/${id}/delete`, {});
    assert(r.status === 303, `delete ${id} answered ${r.status}`);
  }
  await q(`DELETE FROM share_links WHERE id = ${lit(shareId)}`);
  const left = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM files WHERE filename LIKE ${lit(`${RUN}-%`)} AND deleted_at IS NULL`))[0]?.n;
  assert(Number(left) === 0, `${left} file(s) of this run still listed`);
});

mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/scanner-staging-e2e.json", JSON.stringify({ run: RUN, at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
for (const f of failed) console.log(`::error title=Malware scan E2E: ${f.id}::${f.detail}`);
const summary = `Malware scanning lifecycle on staging: ${results.length - failed.length}/${results.length} checks passed`;
console.log(failed.length ? `::error title=Malware scan E2E::${summary}` : `::notice title=Malware scan E2E::${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n${results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.id}${r.detail ? ` — ${r.detail}` : ""}`).join("\n")}\n`);
process.exit(failed.length ? 1 : 0);
