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

/** Uploaded versions, newest first. `trigger` is Cloudflare's "workers/triggered_by" annotation when present
 *  ("upload" / "version_upload" for new code, "secret" for a secret change on the same code, …). */
export function versionsNewestFirst(listJson: string): { id: string; createdOn: string; trigger: string | null }[] {
  const out = new Map<string, { createdOn: string; trigger: string | null }>();
  walk(parse(listJson), (o) => {
    const id = o.id;
    const created = (o.created_on ?? (o.metadata as Obj | undefined)?.created_on ?? o.createdOn) as unknown;
    const ann = o.annotations as Obj | undefined;
    const trig = ann?.["workers/triggered_by"] ?? (o.metadata as Obj | undefined)?.source;
    if (typeof id === "string" && UUID.test(id) && typeof created === "string" && !Number.isNaN(Date.parse(created))) out.set(id, { createdOn: created, trigger: typeof trig === "string" ? trig : null });
  });
  return [...out].map(([id, v]) => ({ id, ...v })).sort((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn));
}

const isSecretOnly = (t: string | null) => !!t && /secret/i.test(t);

/** Previous = the newest version whose CODE predates the serving build: skip versions that only changed secrets on
 *  top of the serving code, and the serving code's own upload, so the rehearsal really runs older code. Falls back to
 *  the newest other version when Wrangler reports no trigger annotations. */
export function pickRollback(statusJson: string, listJson: string): { current: string; previous: string; previousIsOlderCode: boolean } {
  const current = currentVersionIds(statusJson);
  if (current.length !== 1) throw new Error(`expected exactly one version serving 100% of traffic, found ${current.length}`);
  const all = versionsNewestFirst(listJson);
  const others = all.filter((v) => v.id !== current[0]);
  if (!others.length) throw new Error("no earlier uploaded version to roll back to");
  const idx = all.findIndex((v) => v.id === current[0]);
  if (idx >= 0 && all.some((v) => v.trigger)) {
    let i = idx;
    // Walk back through secret-only versions to the upload that produced the serving code.
    while (i < all.length && isSecretOnly(all[i].trigger)) i++;
    const older = all.slice(i + 1).find((v) => v.trigger && !isSecretOnly(v.trigger));
    if (older) return { current: current[0], previous: older.id, previousIsOlderCode: true };
  }
  return { current: current[0], previous: others[0].id, previousIsOlderCode: false };
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
      { requirementId: "INFRA-005", testName: "rollback step: previous version deployed to 100% and healthy", outcome: o.rollback ? "passed" : "failed", ...(o.rollback ? {} : { message: msg || "rollback step failed" }) },
      { requirementId: "INFRA-005", testName: "roll-forward step: serving version restored and healthy", outcome: o.rollforward ? "passed" : "failed" },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (mode === "pick") { const r = pickRollback(readFileSync(a, "utf8"), readFileSync(b, "utf8")); process.stdout.write(`${r.current} ${r.previous}`); process.stderr.write(r.previousIsOlderCode ? "previous version runs the earlier deployed code\n" : "no trigger annotations: previous version may share the serving code\n"); }
  else if (mode === "evidence") {
    writeFileSync(arg("--out") ?? "evidence/rollback.json", JSON.stringify(rehearsalEvidence({ commit: arg("--commit") ?? "0000000", runId: arg("--run-id") ?? `local-rollback-${Date.now()}`, startedAt: arg("--started") ?? new Date().toISOString(),
      rollback: arg("--rollback") === "passed", rollforward: arg("--rollforward") === "passed", detail: arg("--detail") })));
  } else { console.error("usage: rollback-rehearsal.ts pick <status.json> <versions.json> | evidence …"); process.exit(2); }
}
