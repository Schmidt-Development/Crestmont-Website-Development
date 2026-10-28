// Rollback-safe secret handling for staging (TEST-004, INFRA-005). Cloudflare refuses to roll back to a version when a
// secret changed since it was active (error 10220, observed on staging 2026-10-28 for EVIDENCE_INGEST_SECRET).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { putSecretIfChanged, deriveStagingKey, secretFingerprint } from "../scripts/staging-secrets.ts";
import { deriveSchedulerKey } from "../scripts/trigger-scheduler.ts";
import type { D1Ops } from "../scripts/staging-access.ts";

function fakeOps() {
  const fps = new Map<string, string>(); const puts: [string, string][] = [];
  const ops: D1Ops = {
    async query(sql: string) {
      const sel = /WHERE name = '([A-Z_]+)'/.exec(sql);
      if (sql.startsWith("SELECT") && sel) return (fps.has(sel[1]) ? [{ fingerprint: fps.get(sel[1]) }] : []) as never;
      const ins = /VALUES \('([A-Z_]+)', '([0-9a-f]{64})'/.exec(sql);
      if (ins) fps.set(ins[1], ins[2]);
      return [] as never;
    },
    async execFile() {},
    async putSecret(name, value) { puts.push([name, value]); },
  };
  return { ops, fps, puts };
}

test("[TEST-004] [INFRA-005] staging secrets are put only when their value changes, so deploys no longer block Worker rollbacks", async () => {
  const f = fakeOps();
  assert.equal(await putSecretIfChanged(f.ops, "root", "EVIDENCE_INGEST_SECRET", "v1"), "updated");
  assert.equal(await putSecretIfChanged(f.ops, "root", "EVIDENCE_INGEST_SECRET", "v1"), "unchanged");
  assert.equal(await putSecretIfChanged(f.ops, "root", "EVIDENCE_INGEST_SECRET", "v2"), "updated");
  assert.deepEqual(f.puts, [["EVIDENCE_INGEST_SECRET", "v1"], ["EVIDENCE_INGEST_SECRET", "v2"]]);
  assert.equal(f.fps.get("EVIDENCE_INGEST_SECRET"), secretFingerprint("root", "EVIDENCE_INGEST_SECRET", "v2"));
  assert.notEqual(secretFingerprint("root", "A_B", "v"), secretFingerprint("other-root", "A_B", "v"), "fingerprints are keyed");
  await assert.rejects(putSecretIfChanged(f.ops, "root", "bad name'; DROP", "v"), /invalid secret name/);
  await assert.rejects(putSecretIfChanged(f.ops, "root", "X_Y_Z", ""), /empty value/);
  // Derived machine keys are stable and match what the scheduler client uses.
  assert.equal(deriveStagingKey("root", "evidence"), deriveStagingKey("root", "evidence"));
  assert.equal(deriveStagingKey("root", "scheduler"), deriveSchedulerKey("root"));
  // No staging workflow rotates or blindly re-puts a secret any more.
  for (const f of readdirSync(".github/workflows").filter((n) => /^(deploy-staging|staging-)/.test(n))) {
    const s = readFileSync(`.github/workflows/${f}`, "utf8");
    assert.doesNotMatch(s, /secret put/, `${f} puts secrets only through scripts/staging-secrets.ts`);
    assert.doesNotMatch(s, /randomBytes/, `${f} does not rotate secrets`);
  }
});
