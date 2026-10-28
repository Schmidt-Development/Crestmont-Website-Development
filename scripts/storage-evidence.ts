// Publishes whether staging has R2 file storage bound (FILE-001, PORTAL-004) as the public `file-storage:staging` feed:
// healthy = bucket bound; unavailable = R2 not enabled on the Cloudflare account (uploads honestly disabled). R2 is a
// separate Cloudflare product: a Workers Paid plan does not by itself enable it.
//   node --no-warnings scripts/storage-evidence.ts --state bound|unavailable --commit <sha> --run-id <id> --out <file>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const STORAGE_TEST = "file storage (R2) bucket bound to the staging Worker";
export function storageEvidence(o: { state: string; commit: string; runId: string; at?: string; reason?: string }) {
  const at = o.at ?? new Date().toISOString();
  return { runId: o.runId, source: "ci", environment: "staging", commitSha: o.commit, startedAt: at, finishedAt: at,
    results: [{ requirementId: "FILE-001", testName: STORAGE_TEST, outcome: o.state === "bound" ? "passed" : "skipped",
      ...(o.state === "bound" ? {} : { message: `R2 bucket crestmont-files-staging not usable by the deploy token; uploads are disabled on staging. ${(o.reason ?? "").trim()}`.slice(0, 400) }) }] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg("--out") ?? "evidence/r2.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(storageEvidence({ state: arg("--state") ?? "unavailable", commit: arg("--commit") ?? "0".repeat(40), runId: arg("--run-id") ?? `local-r2-${Date.now()}`, reason: arg("--reason") })));
}
