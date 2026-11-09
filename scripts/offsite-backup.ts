// Off-Cloudflare production backups (CREST-GAP-016, INFRA-006, docs/BACKUP-RECOVERY.md §3.2). Used by
// .github/workflows/production-backup.yml. Node built-ins only (no AWS CLI / SDK): objects are written to any
// S3-compatible store (Backblaze B2, Wasabi, AWS S3, a second Cloudflare account's R2, MinIO…) with AWS Signature V4.
//
//   node --no-warnings scripts/offsite-backup.ts check                      → exit 0 when the destination is configured
//   node --no-warnings scripts/offsite-backup.ts put  <file> <key>          → PUT, records sha256 as x-amz-meta-sha256
//   node --no-warnings scripts/offsite-backup.ts get  <key> <out>           → GET to <out>
//   node --no-warnings scripts/offsite-backup.ts counts <f1,f2,…> <out.json> → {table: rows} from wrangler --json outputs
//   node --no-warnings scripts/offsite-backup.ts compare <source.json> <f1,f2,…> --commit <sha> --run-id <id> --started <iso>
//        --object <key> --sha256 <hex> --out <evidence.json>                → restore verification evidence (exit 1 on mismatch)
//
// Destination, one of:
//   · off-Cloudflare (preferred; GitHub environment secrets): BACKUP_S3_ENDPOINT (https://…), BACKUP_S3_BUCKET,
//     BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY; optional BACKUP_S3_REGION (default: the region in a B2/AWS/Wasabi endpoint, else us-east-1).
//   · an R2 bucket in the SAME Cloudflare account (BACKUP_R2_BUCKET, written with wrangler and the Cloudflare token the
//     job already holds — no new credential). It protects against losing or corrupting the database, NOT against losing
//     the Cloudflare account, so it is never described as off-Cloudflare (storeKind()).
// The S3 destination wins when both are set. The object is the SEALED export (scripts/seal.ts, AES-256-GCM): the store
// never sees plaintext. Nothing here prints a key, a secret or the export's contents.
//   node --no-warnings scripts/offsite-backup.ts delete <key>                → remove an object (rehearsal clean-up)
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { compareCounts, rowsOfAll } from "./restore-drill.ts";

export type StoreKind = "off-cloudflare" | "same-account-r2";
export interface Store {
  kind: StoreKind; describe: string;
  put(key: string, body: Buffer): Promise<{ sha256: string }>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** wrangler refuses `r2 object put` above 300 MiB ("Wrangler only supports uploading files up to 300 MiB in size"); the
 *  staging export passed that in backup rehearsal #1. Parts stay well below it. */
export const R2_PART_BYTES = 128 * 1024 * 1024;
export const CHUNKED_FORMAT = "crestmont-chunked/1";
interface ChunkIndex { format: typeof CHUNKED_FORMAT; size: number; sha256: string; parts: { key: string; size: number; sha256: string }[] }

/**
 * An R2 bucket in the account the job's Cloudflare token belongs to, through wrangler (`r2 object … --remote`).
 * An object larger than one part is stored as `<key>.part-0000`, `-0001`, … with a small JSON index at `<key>` that
 * is written LAST: until every part has landed there is no index, so a half-finished upload is never mistaken for
 * a backup. get() follows the index, checks every part's SHA-256 and the whole object's, and returns the joined
 * bytes; callers (production-backup.yml, the rehearsal) see one object either way. Each part is retried a bounded
 * number of times.
 */
export function r2Store(bucket: string, run: (args: string[]) => Buffer | string = wranglerRun, o: { partBytes?: number; attempts?: number } = {}): Store {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("BACKUP_R2_BUCKET is not a valid R2 bucket name");
  const partBytes = o.partBytes ?? R2_PART_BYTES, attempts = o.attempts ?? 3;
  const tmp = () => `${process.env.RUNNER_TEMP ?? "/tmp"}/r2-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const retry = <T>(what: string, f: () => T): T => {
    let last: unknown;
    for (let i = 0; i < attempts; i++) { try { return f(); } catch (e) { last = e; } }
    throw new Error(`${what}: ${(last as Error).message} (after ${attempts} attempts)`);
  };
  const putOne = (key: string, body: Buffer) => {
    const f = tmp(); writeFileSync(f, body, { mode: 0o600 });
    try { retry(`upload ${key}`, () => run(["r2", "object", "put", `${bucket}/${key}`, "--file", f, "--content-type", "application/octet-stream", "--remote"])); }
    finally { rmSync(f, { force: true }); }
  };
  const getOne = (key: string): Buffer => {
    const f = tmp();
    try { retry(`download ${key}`, () => run(["r2", "object", "get", `${bucket}/${key}`, "--file", f, "--remote"])); return readFileSync(f); }
    finally { rmSync(f, { force: true }); }
  };
  const asIndex = (b: Buffer): ChunkIndex | null => {
    if (b.length > 1_000_000 || b[0] !== 0x7b) return null;   // an index is small JSON; a sealed object is neither
    try { const j = JSON.parse(b.toString("utf8")) as ChunkIndex; return j.format === CHUNKED_FORMAT && Array.isArray(j.parts) ? j : null; } catch { return null; }
  };
  return {
    kind: "same-account-r2", describe: `r2://${bucket} (same Cloudflare account — not an off-Cloudflare copy)`,
    async put(key, body) {
      objectKey(key);
      const whole = sha256(body);
      if (body.length <= partBytes) { putOne(key, body); return { sha256: whole }; }
      const parts: ChunkIndex["parts"] = [];
      try {
        for (let i = 0, off = 0; off < body.length; i++, off += partBytes) {
          const part = body.subarray(off, Math.min(off + partBytes, body.length));
          const pk = `${key}.part-${String(i).padStart(4, "0")}`;
          putOne(pk, part);
          parts.push({ key: pk, size: part.length, sha256: sha256(part) });
        }
      } catch (e) {
        // No index was written, so nothing can mistake these for a backup; remove them anyway.
        for (const p of parts) { try { run(["r2", "object", "delete", `${bucket}/${p.key}`, "--remote"]); } catch { /* best effort */ } }
        throw e;
      }
      const index: ChunkIndex = { format: CHUNKED_FORMAT, size: body.length, sha256: whole, parts };
      putOne(key, Buffer.from(JSON.stringify(index)));
      return { sha256: whole };
    },
    async get(key) {
      objectKey(key);
      const first = getOne(key);
      const index = asIndex(first);
      if (!index) return first;
      const out: Buffer[] = [];
      for (const p of index.parts) {
        const b = getOne(p.key);
        if (b.length !== p.size || sha256(b) !== p.sha256) throw new Error(`part ${p.key} does not match its recorded size/SHA-256`);
        out.push(b);
      }
      const joined = Buffer.concat(out);
      if (joined.length !== index.size || sha256(joined) !== index.sha256) throw new Error(`reassembled ${key} does not match its recorded SHA-256`);
      return joined;
    },
    async delete(key) {
      objectKey(key);
      let index: ChunkIndex | null = null;
      try { index = asIndex(getOne(key)); } catch { /* missing: nothing to follow */ }
      for (const p of index?.parts ?? []) run(["r2", "object", "delete", `${bucket}/${p.key}`, "--remote"]);
      run(["r2", "object", "delete", `${bucket}/${key}`, "--remote"]);
    },
  };
}

function wranglerRun(args: string[]): Buffer {
  const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
  try { return execFileSync(cmd, [...base, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) {
    // wrangler's own complaint, without colour codes or the account id; never the object's content.
    const err = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).replace(/\x1b\[[0-9;]*m/g, "").replace(/\/accounts\/[^/\s]+\//g, "/accounts/…/");
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${err.split("\n").filter((l) => /error|✘|code/i.test(l)).slice(0, 2).join(" ").slice(0, 240) || "no message"}`);
  }
}

/** The configured destination: off-Cloudflare S3 first, else a same-account R2 bucket, else none. */
export function storeFromEnv(env: Record<string, string | undefined>, f: typeof fetch = fetch): { store: Store | null; problem: string | null; missing: string[] } {
  const s3 = s3Config(env);
  if (s3.problem) return { store: null, problem: s3.problem, missing: [] };
  if (s3.config) {
    const c = s3.config;
    return { store: { kind: "off-cloudflare", describe: `${c.endpoint}/${c.bucket} (region ${c.region})`,
      put: (k, b) => putObject(c, k, b, f), get: (k) => getObject(c, k, f), delete: (k) => deleteObject(c, k, f) }, problem: null, missing: [] };
  }
  const r2 = env.BACKUP_R2_BUCKET?.trim();
  if (r2) { try { return { store: r2Store(r2), problem: null, missing: [] }; } catch (e) { return { store: null, problem: (e as Error).message, missing: [] }; } }
  return { store: null, problem: null, missing: [...s3.missing, "or BACKUP_R2_BUCKET"] };
}

function objectKey(key: string) {
  if (!/^[A-Za-z0-9._\/-]{1,512}$/.test(key) || key.includes("..")) throw new Error("object key may contain only letters, digits, . _ - /");
}

/**
 * The signing region when BACKUP_S3_REGION is not set. Backblaze B2, AWS S3 and Wasabi put the region in the endpoint
 * (https://s3.us-west-004.backblazeb2.com), and B2 refuses a Signature V4 scoped to any other region; the old default,
 * us-east-1, would have failed every upload to a B2 bucket outside that region. Other stores keep us-east-1.
 */
export function regionFromEndpoint(endpoint: string): string {
  const m = /^https:\/\/s3[.-]([a-z0-9-]+)\.(backblazeb2\.com|amazonaws\.com|wasabisys\.com)(:\d+)?$/i.exec(endpoint.trim().replace(/\/+$/, ""));
  return m ? m[1].toLowerCase() : "us-east-1";
}

export interface S3Config { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }
export const S3_VARS = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"] as const;

export function s3Config(env: Record<string, string | undefined>): { config: S3Config | null; missing: string[]; problem: string | null } {
  const missing = S3_VARS.filter((k) => !env[k]?.trim());
  if (missing.length) return { config: null, missing, problem: null };
  const endpoint = env.BACKUP_S3_ENDPOINT!.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(endpoint)) return { config: null, missing: [], problem: "BACKUP_S3_ENDPOINT must be a bare https origin, e.g. https://s3.us-west-004.backblazeb2.com" };
  const bucket = env.BACKUP_S3_BUCKET!.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { config: null, missing: [], problem: "BACKUP_S3_BUCKET is not a valid bucket name" };
  return { config: { endpoint, bucket, accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!.trim(), secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!.trim(), region: env.BACKUP_S3_REGION?.trim() || regionFromEndpoint(endpoint) }, missing: [], problem: null };
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s, "utf8").digest();
/** RFC 3986 encoding as SigV4 requires; "/" kept in object keys. */
const enc = (s: string, keepSlash = true) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, "/") : e;
};

/** AWS Signature Version 4 for one S3 request (path-style URL). Returns the headers to send, including Authorization. */
export function signV4(o: { method: string; url: URL; headers: Record<string, string>; payloadSha256: string; accessKeyId: string; secretAccessKey: string; region: string; service?: string; now: Date }): Record<string, string> {
  const service = o.service ?? "s3";
  const amzDate = o.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")])), host: o.url.host, "x-amz-content-sha256": o.payloadSha256, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const query = [...o.url.searchParams.entries()].map(([k, v]) => `${enc(k, false)}=${enc(v, false)}`).sort().join("&");
  const canonical = [o.method, o.url.pathname.split("/").map((p) => enc(decodeURIComponent(p), false)).join("/"), query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), o.payloadSha256].join("\n");
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export function objectUrl(c: S3Config, key: string): URL {
  if (!/^[A-Za-z0-9._\/-]{1,512}$/.test(key) || key.includes("..")) throw new Error("object key may contain only letters, digits, . _ - /");
  return new URL(`${c.endpoint}/${c.bucket}/${key}`);
}

export async function putObject(c: S3Config, key: string, body: Buffer, f: typeof fetch = fetch, now = new Date()): Promise<{ sha256: string }> {
  const digest = sha256(body);
  const url = objectUrl(c, key);
  const headers = signV4({ method: "PUT", url, headers: { "content-type": "application/octet-stream", "x-amz-meta-sha256": digest }, payloadSha256: digest, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, now });
  const { host: _host, ...send } = headers;
  const res = await f(url, { method: "PUT", headers: send, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  return { sha256: digest };
}

export async function deleteObject(c: S3Config, key: string, f: typeof fetch = fetch, now = new Date()): Promise<void> {
  const url = objectUrl(c, key);
  const headers = signV4({ method: "DELETE", url, headers: {}, payloadSha256: sha256(""), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, now });
  const { host: _host, ...send } = headers;
  const res = await f(url, { method: "DELETE", headers: send });
  if (!res.ok && res.status !== 404) throw new Error(`delete failed: HTTP ${res.status}`);
}

export async function getObject(c: S3Config, key: string, f: typeof fetch = fetch, now = new Date()): Promise<Buffer> {
  const url = objectUrl(c, key);
  const headers = signV4({ method: "GET", url, headers: {}, payloadSha256: sha256(""), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, now });
  const { host: _host, ...send } = headers;
  const res = await f(url, { method: "GET", headers: send });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** {table: rows} from the counting queries' wrangler JSON outputs (scripts/restore-drill.ts countQueries). */
export function countsMap(outputs: string[]): Record<string, number> {
  return Object.fromEntries(rowsOfAll(outputs).map((r) => [String(r.t), Number(r.n)]).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function backupEvidence(o: { passed: boolean; tables: number; rows: number; problems: string[]; commit: string; runId: string; startedAt: string; object: string; sha256: string; store?: StoreKind; environment?: "production" | "staging" }) {
  const where = (o.store ?? "off-cloudflare") === "off-cloudflare" ? "sealed off-Cloudflare" : "sealed to an R2 bucket in the same Cloudflare account (not off-Cloudflare)";
  const env = o.environment ?? "production";
  const name = `${env} D1 export ${where} and restored into a scratch database: ${o.tables} tables, ${o.rows} rows${o.passed ? " identical" : ""}`;
  return {
    runId: o.runId, source: "ci", environment: env, commitSha: o.commit, startedAt: o.startedAt, finishedAt: new Date().toISOString(),
    results: [{ requirementId: "INFRA-006", testName: name, outcome: o.passed ? "passed" : "failed",
      message: `${o.passed ? "" : `${o.problems.slice(0, 10).join("; ")} · `}object ${o.object} sha256 ${o.sha256}`.slice(0, 1000) }],
  };
}

const entry = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, a, b] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    if (mode === "counts") { writeFileSync(b, JSON.stringify(countsMap(a.split(",").map((f) => readFileSync(f, "utf8"))))); }
    else if (mode === "compare") {
      const source = Object.entries(JSON.parse(readFileSync(a, "utf8")) as Record<string, number>).map(([t, n]) => ({ t, n }));
      const r = compareCounts(source, rowsOfAll(b.split(",").map((f) => readFileSync(f, "utf8"))));
      const store = (arg("--store") ?? "off-cloudflare") as StoreKind, environment = (arg("--environment") ?? "production") as "production" | "staging";
      if (!["off-cloudflare", "same-account-r2"].includes(store) || !["production", "staging"].includes(environment)) throw new Error("--store must be off-cloudflare|same-account-r2 and --environment production|staging");
      writeFileSync(arg("--out") ?? "evidence/production-backup.json", JSON.stringify(backupEvidence({ ...r, commit: arg("--commit") ?? "0".repeat(40), runId: arg("--run-id") ?? `local-backup-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString(), object: arg("--object") ?? "?", sha256: arg("--sha256") ?? "?", store, environment })));
      console.log(`${r.passed ? "PASSED" : "FAILED"}: ${r.tables} tables, ${r.rows} rows${r.problems.length ? `; ${r.problems.slice(0, 10).join("; ")}` : ""}`);
      if (!r.passed) process.exit(1);
    } else {
      const { store, missing, problem } = storeFromEnv(process.env);
      if (mode === "check") {
        if (problem) { console.error(problem); process.exit(1); }
        if (!store) { console.error(`not configured: ${missing.join(", ")}`); process.exit(1); }
        console.log(`destination: ${store.describe}`);
        // For the workflow: which kind of copy this is, so the summary and the evidence never overstate it.
        if (process.env.GITHUB_OUTPUT) (await import("node:fs")).appendFileSync(process.env.GITHUB_OUTPUT, `store=${store.kind}\n`);
      } else if (!store) { console.error(problem ?? `not configured: ${missing.join(", ")}`); process.exit(1); }
      else if (mode === "put" && a && b) { const r = await store.put(b, readFileSync(a)); console.log(`uploaded ${b} sha256 ${r.sha256}`); }
      else if (mode === "get" && a && b) { writeFileSync(b, await store.get(a), { mode: 0o600 }); console.log(`downloaded ${a}`); }
      else if (mode === "delete" && a) { await store.delete(a); console.log(`deleted ${a}`); }
      else { console.error("usage: check | put <file> <key> | get <key> <out> | delete <key> | counts <files> <out.json> | compare <source.json> <files> [--out …]"); process.exit(2); }
    }
  } catch (e) {
    console.error(String((e as Error).message ?? e).split("\n")[0].slice(0, 300));
    process.exit(1);
  }
}
