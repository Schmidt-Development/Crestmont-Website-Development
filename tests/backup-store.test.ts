// Backup destinations (INFRA-006): off-Cloudflare S3 when configured, otherwise an R2 bucket in the same account, and
// every description and evidence record says which. The rehearsal runs production's pipeline against staging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { r2Store, storeFromEnv, backupEvidence } from "../scripts/offsite-backup.ts";

const S3 = { BACKUP_S3_ENDPOINT: "https://s3.example.com", BACKUP_S3_BUCKET: "crestmont-backups", BACKUP_S3_ACCESS_KEY_ID: "id", BACKUP_S3_SECRET_ACCESS_KEY: "secret" };

test("[INFRA-006] destination: S3 (off-Cloudflare) wins; R2 is labelled same-account; neither is reported as missing", () => {
  assert.equal(storeFromEnv({ ...S3, BACKUP_R2_BUCKET: "crestmont-backups-production" }).store?.kind, "off-cloudflare");
  const r2 = storeFromEnv({ BACKUP_R2_BUCKET: "crestmont-backups-production" }).store!;
  assert.equal(r2.kind, "same-account-r2");
  assert.match(r2.describe, /not an off-Cloudflare copy/);
  const none = storeFromEnv({});
  assert.equal(none.store, null);
  assert.ok(none.missing.includes("or BACKUP_R2_BUCKET"));
  assert.match(storeFromEnv({ BACKUP_R2_BUCKET: "Bad_Name" }).problem ?? "", /not a valid R2 bucket name/);
});

test("[INFRA-006] R2 store: wrangler r2 object put/get/delete against <bucket>/<key>, remote, with key validation", async () => {
  const calls: string[][] = [];
  let stored: Buffer = Buffer.alloc(0);
  const fake = (args: string[]) => {
    calls.push(args);
    const i = args.indexOf("--file");
    if (args[2] === "put") stored = readFileSync(args[i + 1]);
    if (args[2] === "get") writeFileSync(args[i + 1], stored);
    return "";
  };
  const s = r2Store("crestmont-files-staging", fake);
  const body = Buffer.from("sealed bytes");
  const put = await s.put("_backup-rehearsal/1/export.sql.sealed", body);
  assert.equal(put.sha256.length, 64);
  assert.deepEqual((await s.get("_backup-rehearsal/1/export.sql.sealed")).toString(), "sealed bytes");
  await s.delete("_backup-rehearsal/1/export.sql.sealed");
  assert.deepEqual(calls.map((c) => [c[2], c[3], c.at(-1)]), [
    ["put", "crestmont-files-staging/_backup-rehearsal/1/export.sql.sealed", "--remote"],
    ["get", "crestmont-files-staging/_backup-rehearsal/1/export.sql.sealed", "--remote"],
    ["delete", "crestmont-files-staging/_backup-rehearsal/1/export.sql.sealed", "--remote"],
  ]);
  await assert.rejects(s.put("../escape", body), /object key/);
});

test("[INFRA-006] evidence never calls a same-account copy off-Cloudflare, and names the environment", () => {
  const base = { passed: true, tables: 3, rows: 10, problems: [], commit: "a".repeat(40), runId: "r", startedAt: "2026-11-05T00:00:00Z", object: "o", sha256: "f".repeat(64) };
  assert.match(backupEvidence(base).results[0].testName, /^production D1 export sealed off-Cloudflare/);
  const r2 = backupEvidence({ ...base, store: "same-account-r2", environment: "staging" });
  assert.equal(r2.environment, "staging");
  assert.match(r2.results[0].testName, /^staging D1 export sealed to an R2 bucket in the same Cloudflare account \(not off-Cloudflare\)/);
});

test("[INFRA-006] production backup: manifest counts come from the export itself (no race with live writes); R2 only as a labelled interim", () => {
  const b = readFileSync(".github/workflows/production-backup.yml", "utf8");
  assert.match(b, /restore-drill\.ts export-counts backup\/export\.sql > backup\/export-counts\.json\s*\n\s*node --no-warnings scripts\/offsite-backup\.ts counts backup\/export-counts\.json backup\/counts\.json/);
  assert.match(b, /HAS_R2: \$\{\{ vars\.BACKUP_R2_BUCKET != '' \}\}/);
  assert.match(b, /::warning title=Same-account backup only::/);
  assert.match(b, /--store "\$\{STORE:-off-cloudflare\}" --environment production/);
});

test("[INFRA-006] the staging rehearsal runs production's pipeline: export → seal → store → nothing local → download → verify → restore → compare → delete", () => {
  const r = readFileSync(".github/workflows/backup-rehearsal-staging.yml", "utf8");
  const order = ["d1 export crestmont-staging --remote --env staging", "seal.ts seal backup/export.sql", "rm -f backup/export.sql", "offsite-backup.ts put backup/export.sql.sealed",
    "rm -rf backup", "offsite-backup.ts get \"$PREFIX/export.sql.sealed\"", "sealed object sha256 does not match", "seal.ts open", "export sha256 does not match",
    "d1 create \"$SCRATCH\"", "d1 execute \"$SCRATCH\" --remote --file verify/import.sql", "offsite-backup.ts compare", "offsite-backup.ts delete", "d1 delete \"$SCRATCH\""];
  let at = -1;
  for (const s of order) { const i = r.indexOf(s, at + 1); assert.ok(i > at, `in order: ${s}`); at = i; }
  assert.match(r, /BACKUP_R2_BUCKET: crestmont-files-staging/, "an existing bucket; nothing new");
  assert.doesNotMatch(r, /crestmont-production|--env production/, "never touches production");
  assert.doesNotMatch(r, /upload-artifact/);
  assert.match(r, /group: deploy-staging/, "never alongside a staging deploy");
  assert.match(r, /--store same-account-r2 --environment staging/);
});
