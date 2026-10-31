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
// Destination (GitHub `production` environment secrets): BACKUP_S3_ENDPOINT (https://…), BACKUP_S3_BUCKET,
// BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY; optional BACKUP_S3_REGION (default us-east-1; "auto" for R2).
// The object is the SEALED export (scripts/seal.ts, AES-256-GCM): the store never sees plaintext.
// Nothing here prints a key, a secret or the export's contents.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareCounts, rowsOfAll } from "./restore-drill.ts";

export interface S3Config { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }
export const S3_VARS = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"] as const;

export function s3Config(env: Record<string, string | undefined>): { config: S3Config | null; missing: string[]; problem: string | null } {
  const missing = S3_VARS.filter((k) => !env[k]?.trim());
  if (missing.length) return { config: null, missing, problem: null };
  const endpoint = env.BACKUP_S3_ENDPOINT!.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(endpoint)) return { config: null, missing: [], problem: "BACKUP_S3_ENDPOINT must be a bare https origin, e.g. https://s3.us-west-004.backblazeb2.com" };
  const bucket = env.BACKUP_S3_BUCKET!.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { config: null, missing: [], problem: "BACKUP_S3_BUCKET is not a valid bucket name" };
  return { config: { endpoint, bucket, accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!.trim(), secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!.trim(), region: env.BACKUP_S3_REGION?.trim() || "us-east-1" }, missing: [], problem: null };
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

export function backupEvidence(o: { passed: boolean; tables: number; rows: number; problems: string[]; commit: string; runId: string; startedAt: string; object: string; sha256: string }) {
  const name = `production D1 export sealed off-Cloudflare and restored into a scratch database: ${o.tables} tables, ${o.rows} rows${o.passed ? " identical" : ""}`;
  return {
    runId: o.runId, source: "ci", environment: "production", commitSha: o.commit, startedAt: o.startedAt, finishedAt: new Date().toISOString(),
    results: [{ requirementId: "INFRA-006", testName: name, outcome: o.passed ? "passed" : "failed",
      message: `${o.passed ? "" : `${o.problems.slice(0, 10).join("; ")} · `}object ${o.object} sha256 ${o.sha256}`.slice(0, 1000) }],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    if (mode === "counts") { writeFileSync(b, JSON.stringify(countsMap(a.split(",").map((f) => readFileSync(f, "utf8"))))); }
    else if (mode === "compare") {
      const source = Object.entries(JSON.parse(readFileSync(a, "utf8")) as Record<string, number>).map(([t, n]) => ({ t, n }));
      const r = compareCounts(source, rowsOfAll(b.split(",").map((f) => readFileSync(f, "utf8"))));
      writeFileSync(arg("--out") ?? "evidence/production-backup.json", JSON.stringify(backupEvidence({ ...r, commit: arg("--commit") ?? "0".repeat(40), runId: arg("--run-id") ?? `local-backup-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString(), object: arg("--object") ?? "?", sha256: arg("--sha256") ?? "?" })));
      console.log(`${r.passed ? "PASSED" : "FAILED"}: ${r.tables} tables, ${r.rows} rows${r.problems.length ? `; ${r.problems.slice(0, 10).join("; ")}` : ""}`);
      if (!r.passed) process.exit(1);
    } else {
      const { config, missing, problem } = s3Config(process.env);
      if (mode === "check") {
        if (problem) { console.error(problem); process.exit(1); }
        if (missing.length) { console.error(`not configured: ${missing.join(", ")}`); process.exit(1); }
        console.log(`destination: ${config!.endpoint}/${config!.bucket} (region ${config!.region})`);
      } else if (!config) { console.error(problem ?? `not configured: ${missing.join(", ")}`); process.exit(1); }
      else if (mode === "put" && a && b) { const r = await putObject(config, b, readFileSync(a)); console.log(`uploaded ${b} sha256 ${r.sha256}`); }
      else if (mode === "get" && a && b) { writeFileSync(b, await getObject(config, a), { mode: 0o600 }); console.log(`downloaded ${a}`); }
      else { console.error("usage: check | put <file> <key> | get <key> <out> | counts <files> <out.json> | compare <source.json> <files> [--out …]"); process.exit(2); }
    }
  } catch (e) {
    console.error(String((e as Error).message ?? e).split("\n")[0].slice(0, 300));
    process.exit(1);
  }
}
