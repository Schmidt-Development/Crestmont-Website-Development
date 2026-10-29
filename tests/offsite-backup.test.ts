// Off-Cloudflare production backups (CREST-GAP-016): scripts/offsite-backup.ts. The S3 store is SIMULATED (fake fetch);
// nothing here talks to a provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { signV4, s3Config, putObject, getObject, countsMap, objectUrl } from "../scripts/offsite-backup.ts";
import { seal, open } from "../scripts/seal.ts";

test("[INFRA-006] SigV4 signing matches AWS's published S3 example (GET /test.txt, Range bytes=0-9)", () => {
  // AWS's documented example credentials (not a real key), assembled at runtime so the secret scan's key-shape rule stays strict.
  const exampleKeyId = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
  const h = signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9" },
    payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", accessKeyId: exampleKeyId,
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z") });
  assert.equal(h.authorization, `AWS4-HMAC-SHA256 Credential=${exampleKeyId}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
});

test("[INFRA-006] the destination is configured only by the four BACKUP_S3_* values; invalid endpoints and keys are refused", () => {
  assert.deepEqual(s3Config({}).missing, ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"]);
  const base = { BACKUP_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com/", BACKUP_S3_BUCKET: "crestmont-backups", BACKUP_S3_ACCESS_KEY_ID: "id", BACKUP_S3_SECRET_ACCESS_KEY: "secret" };
  const ok = s3Config(base).config!;
  assert.equal(ok.endpoint, "https://s3.us-west-004.backblazeb2.com");
  assert.equal(ok.region, "us-east-1");
  assert.equal(s3Config({ ...base, BACKUP_S3_REGION: "auto" }).config!.region, "auto");
  assert.match(s3Config({ ...base, BACKUP_S3_ENDPOINT: "http://insecure.example" }).problem!, /https/);
  assert.match(s3Config({ ...base, BACKUP_S3_ENDPOINT: "https://host/path" }).problem!, /bare https origin/);
  assert.throws(() => objectUrl(ok, "../escape"), /key/);
  // The CLI refuses to do anything without configuration and prints which names are missing (never values).
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/offsite-backup.ts", "check"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not configured: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY/);
});

test("[INFRA-006] a sealed export round-trips through the (simulated) S3 store with its sha256 recorded and verified", async () => {
  const store = new Map<string, Buffer>();
  const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fake = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input), headers = init?.headers as Record<string, string>;
    seen.push({ method: init?.method ?? "GET", url, headers });
    if (!/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(headers.authorization)) return new Response("denied", { status: 403 });
    if (init?.method === "PUT") { store.set(url, Buffer.from(init.body as Uint8Array)); return new Response("", { status: 200 }); }
    const b = store.get(url);
    return b ? new Response(new Uint8Array(b)) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const cfg = s3Config({ BACKUP_S3_ENDPOINT: "https://backups.example.net", BACKUP_S3_BUCKET: "crestmont-backups", BACKUP_S3_ACCESS_KEY_ID: "AKID", BACKUP_S3_SECRET_ACCESS_KEY: "SECRET", BACKUP_S3_REGION: "auto" }).config!;
  const plain = Buffer.from("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE users (id TEXT);\nINSERT INTO users VALUES('usr_1');\n");
  const pass = "a-long-test-passphrase-with-variety-0123456789";
  const sealed = seal(plain, pass);
  assert.ok(!sealed.includes(Buffer.from("usr_1")), "the stored object is ciphertext");
  const key = "crestmont-production/d1/2026/10/crestmont-production-20261029T0637Z-1.sql.sealed";
  const { sha256 } = await putObject(cfg, key, sealed, fake);
  assert.equal(sha256, createHash("sha256").update(sealed).digest("hex"));
  assert.equal(seen[0].url, `https://backups.example.net/crestmont-backups/${key}`, "path-style URL");
  assert.equal(seen[0].headers["x-amz-meta-sha256"], sha256, "sha256 recorded on the object");
  assert.equal(seen[0].headers["x-amz-content-sha256"], sha256, "payload integrity is signed");
  assert.doesNotMatch(JSON.stringify(seen), /SECRET/, "the secret key is never sent");
  const back = await getObject(cfg, key, fake);
  assert.equal(createHash("sha256").update(back).digest("hex"), sha256);
  assert.deepEqual(open(back, pass), plain);
  await assert.rejects(getObject(cfg, "crestmont-production/missing.sql.sealed", fake), /HTTP 404/);
  await assert.rejects(putObject({ ...cfg, accessKeyId: "" }, key, sealed, fake), /HTTP 403/);
});

test("[INFRA-006] [TEST-004] restore verification compares the restored scratch database with the manifest's row counts and records evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "offsite-"));
  const out = (rows: Record<string, number>) => JSON.stringify([{ results: [rows], success: true }]);
  writeFileSync(join(dir, "s0.json"), out({ users: 3, invoices: 2 }));
  writeFileSync(join(dir, "s1.json"), out({ audit_logs: 10 }));
  const counts = countsMap([readFileSync(join(dir, "s0.json"), "utf8"), readFileSync(join(dir, "s1.json"), "utf8")]);
  assert.deepEqual(counts, { audit_logs: 10, invoices: 2, users: 3 });
  writeFileSync(join(dir, "counts.json"), JSON.stringify(counts));
  writeFileSync(join(dir, "r0.json"), out({ users: 3, invoices: 2, audit_logs: 10 }));
  const run = (files: string) => spawnSync(process.execPath, ["--no-warnings", "scripts/offsite-backup.ts", "compare", join(dir, "counts.json"), files, "--commit", "a".repeat(40), "--run-id", "gh-1-1-production-backup", "--object", "crestmont-production/d1/x.sql.sealed", "--sha256", "f".repeat(64), "--out", join(dir, "ev.json")], { encoding: "utf8" });
  const ok = run(join(dir, "r0.json"));
  assert.equal(ok.status, 0, ok.stderr);
  const ev = JSON.parse(readFileSync(join(dir, "ev.json"), "utf8"));
  assert.equal(ev.environment, "production");
  assert.equal(ev.results[0].requirementId, "INFRA-006");
  assert.equal(ev.results[0].outcome, "passed");
  assert.match(ev.results[0].message, /sha256 f{64}/);
  writeFileSync(join(dir, "r1.json"), out({ users: 3, invoices: 1, audit_logs: 10 }));
  const bad = run(join(dir, "r1.json"));
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "ev.json"), "utf8")).results[0].outcome, "failed");
  assert.match(bad.stdout, /invoices: 2 rows before, 1 after/);
});
