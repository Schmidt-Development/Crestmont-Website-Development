// Staging Worker rollback rehearsal (TEST-004, INFRA-005). Used by .github/workflows/staging-rollback-rehearsal.yml.
//   node --no-warnings scripts/rollback-rehearsal.ts pick <deployments-status.json> <versions-list.json>
//       → prints "<currentVersionId> <previousVersionId>" (previous = newest uploaded version that is not current)
//   node --no-warnings scripts/rollback-rehearsal.ts evidence --commit <sha> --run-id <id> --started <iso>
//       --rollback passed|failed --rollforward passed|failed [--detail "…"] --out evidence/rollback.json
// Wrangler's JSON shapes for these commands are not documented, so parsing is defensive: it looks for version ids
// (UUIDs) and creation timestamps anywhere in the objects, and fails loudly instead of guessing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Obj = Record<string, unknown>;
const parse = (raw: string): unknown => JSON.parse(raw.slice(Math.min(...["[", "{"].map((c) => { const i = raw.indexOf(c); return i < 0 ? Infinity : i; }))));
function walk(v: unknown, f: (o: Obj) => void) { if (Array.isArray(v)) v.forEach((x) => walk(x, f)); else if (v && typeof v === "object") { f(v as Obj); Object.values(v).forEach((x) => walk(x, f)); } }

/** Version ids currently serving traffic (deployments status). */
export function currentVersionIds(statusJson: string): string[] {
  const ids = new Set<string>();
  walk(parse(statusJson), (o) => {
    for (const k of ["version_id", "versionId"]) if (typeof o[k] === "string" && UUID.test(o[k] as string)) ids.add(o[k] as string);
    if (Array.isArray(o.versions)) for (const v of o.versions as Obj[]) { const id = v.version_id ?? v.versionId ?? v.id; if (typeof id === "string" && UUID.test(id)) ids.add(id); }
  });
  return [...ids];
}

/** Uploaded versions, newest first. */
export function versionsNewestFirst(listJson: string): { id: string; createdOn: string }[] {
  const out = new Map<string, string>();
  walk(parse(listJson), (o) => {
    const id = o.id;
    const created = (o.created_on ?? (o.metadata as Obj | undefined)?.created_on ?? o.createdOn) as unknown;
    if (typeof id === "string" && UUID.test(id) && typeof created === "string" && !Number.isNaN(Date.parse(created))) out.set(id, created);
  });
  return [...out].map(([id, createdOn]) => ({ id, createdOn })).sort((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn));
}

export function pickRollback(statusJson: string, listJson: string): { current: string; previous: string } {
  const current = currentVersionIds(statusJson);
  if (current.length !== 1) throw new Error(`expected exactly one version serving 100% of traffic, found ${current.length}`);
  const prev = versionsNewestFirst(listJson).find((v) => v.id !== current[0]);
  if (!prev) throw new Error("no earlier uploaded version to roll back to");
  return { current: current[0], previous: prev.id };
}

export function rehearsalEvidence(o: { commit: string; runId: string; startedAt: string; rollback: boolean; rollforward: boolean; detail?: string }) {
  const ok = o.rollback && o.rollforward;
  const msg = (o.detail ?? "").slice(0, 1000);
  const name = `staging Worker rolled back to the previous version (health verified) and forward again (health verified)`;
  return {
    runId: o.runId, source: "ci", environment: "staging", commitSha: o.commit, startedAt: o.startedAt, finishedAt: new Date().toISOString(),
    results: [
      { requirementId: "TEST-004", testName: `rollback rehearsal: ${name}`, outcome: ok ? "passed" : "failed", ...(ok ? {} : { message: msg || `rollback ${o.rollback ? "ok" : "failed"}, roll-forward ${o.rollforward ? "ok" : "failed"}` }) },
      { requirementId: "INFRA-005", testName: `rollback automation exercised on staging: ${name}`, outcome: ok ? "passed" : "failed", ...(ok ? {} : { message: msg || "rehearsal failed" }) },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (mode === "pick") { const r = pickRollback(readFileSync(a, "utf8"), readFileSync(b, "utf8")); process.stdout.write(`${r.current} ${r.previous}`); }
  else if (mode === "evidence") {
    writeFileSync(arg("--out") ?? "evidence/rollback.json", JSON.stringify(rehearsalEvidence({ commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-rollback-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString(),
      rollback: arg("--rollback") === "passed", rollforward: arg("--rollforward") === "passed", detail: arg("--detail") })));
  } else { console.error("usage: rollback-rehearsal.ts pick <status.json> <versions.json> | evidence …"); process.exit(2); }
}
