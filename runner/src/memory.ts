// Durable project memory for one build lineage (a job and every attempt/segment that resumes it).
//
// Written ONLY by the runner, from authoritative sources: the platform's requirement list, the runner's own
// acceptance checks, review verdicts, the integration broker, git commits and the token counters. Model output is
// never recorded as fact; the builder's own finish summaries are kept as labelled, bounded notes ("model-reported").
// The source of truth stays the repository (code, BRIEF.json, SPEC.json, .crestmont/*), the control plane's database
// and the durable records here; after a context reset the model is told to re-read those files.
//
// Storage: <job dir>/agent/project-memory.json, outside the agent's repository (the agent cannot edit it), written
// atomically (tmp + rename), and carried in every checkpoint archive with the transcript ("local-agent"), so it
// survives context resets, model switches, container/runner/Windows restarts and resumption on another host.
// Tenant isolation: the file is bound to one projectId + jobId; a file for anything else is ignored, never merged.
// No credentials: every string passes through redact() plus credential-shape scrubbing before it is stored.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { redact } from "./log.ts";

export const MEMORY_SCHEMA = "crestmont.project-memory/1";
export const MEMORY_FILE = "project-memory.json";

export interface SegmentRecord {
  /** Platform attempt number of the claim (a released segment keeps the same attempt number). */
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  /** How the segment ended: completed, continuation (segment limit), released, stopped, failed, interrupted (crash). */
  end: string | null;
  startCommit: string | null;
  endCommit: string | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  /** Measurable progress during the segment (new commit, phase completed, requirement or check improved). */
  progress: boolean | null;
}

export interface DefectRecord {
  /** Short hash of the outstanding-items signature (same failure ⇒ same id). */
  id: string;
  summary: string[];
  firstCycle: number;
  lastCycle: number;
  occurrences: number;
  resolved: boolean;
  repairs: { cycle: number; model: string; task: string; commitBefore: string | null; commitAfter: string | null; resolved: boolean | null }[];
}

export interface InFlight { kind: "phase" | "acceptance" | "review_cycle" | "repair" | "integration_operations" | "preview" | "final"; label: string; startedAt: string }

export interface ProjectMemory {
  schema: typeof MEMORY_SCHEMA;
  projectId: string;
  jobId: string;
  kind: string;
  revision: number;
  /** Brief identity (the brief itself stays in BRIEF.json / the platform; never copied here). */
  brief: { id: string | null; version: number | null; sha256: string | null; business: string | null; packageId: string | null };
  spec: { present: boolean; version: number | null };
  requirements: { key: string; label: string; status: string }[];
  phasesCompleted: string[];
  cyclesCompleted: number;
  cycles: { cycle: number; decision: string; outstanding: number; defect: string | null; reviewer: string; at: string }[];
  checks: { id: string; ok: boolean; at: string }[];
  defects: DefectRecord[];
  integrations: { key: string; codeStatus?: string; mockStatus?: string; operation?: string; status?: string }[];
  approvalsPending: string[];
  preview: { url: string | null; note: string | null; at: string | null };
  /** Builder's own finish summaries: model-reported, bounded, never authoritative. */
  notes: { at: string; phase: string; text: string; source: "model-reported" }[];
  /** Operational metrics only (local inference has no per-token billing and no cumulative ceiling). */
  totals: { modelCalls: number; inputTokens: number; outputTokens: number; compactions: number; segments: number; continuations: number };
  segments: SegmentRecord[];
  /** Consecutive segments that ended at a segment limit without measurable progress (stall guard). */
  idleSegments: number;
  /**
   * Consecutive continuation segments without a milestone (a phase completed, a requirement or check improved, a
   * defect resolved). New commits alone keep a build alive for a while, but not forever (thrashing guard).
   */
  segmentsSinceMilestone: number;
  /** The major operation running right now; still set on load ⇒ the previous runner was interrupted during it. */
  inFlight: InFlight | null;
  recovered: { at: string; interrupted: InFlight | null; note: string }[];
  updatedAt: string;
}

const MAX = { notes: 20, cycles: 60, defects: 40, repairs: 10, segments: 200, recovered: 20, checks: 60 };

/** Strip anything credential-like (registered secrets and common key shapes) and bound the length. */
export function scrub(text: unknown, max = 300): string {
  let t = redact(String(text ?? ""));
  t = t.replace(/\b(sk|rk)_(test|live)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/\b(re|key|tok|secret)_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]");
  return t.replace(/\s+/g, " ").trim().slice(0, max);
}

export const defectId = (outstanding: string[]): string => createHash("sha256").update([...outstanding].sort().join("\n")).digest("hex").slice(0, 12);

export function memoryPath(jobDir: string): string { return path.join(jobDir, "agent", MEMORY_FILE); }

export interface MemoryIdentity {
  projectId: string; jobId: string; kind: string; revision: number;
  brief?: { id: string; version: number; sha256: string; content?: { customerData?: { business?: { name?: string } } } } | null;
  packageId?: string | null;
}

export function newMemory(id: MemoryIdentity): ProjectMemory {
  return {
    schema: MEMORY_SCHEMA, projectId: id.projectId, jobId: id.jobId, kind: id.kind, revision: id.revision,
    brief: { id: id.brief?.id ?? null, version: id.brief?.version ?? null, sha256: id.brief?.sha256 ?? null, business: id.brief?.content?.customerData?.business?.name ? scrub(id.brief.content.customerData.business.name, 120) : null, packageId: id.packageId ?? null },
    spec: { present: false, version: null },
    requirements: [], phasesCompleted: [], cyclesCompleted: 0, cycles: [], checks: [], defects: [], integrations: [], approvalsPending: [],
    preview: { url: null, note: null, at: null }, notes: [],
    totals: { modelCalls: 0, inputTokens: 0, outputTokens: 0, compactions: 0, segments: 0, continuations: 0 },
    segments: [], idleSegments: 0, segmentsSinceMilestone: 0, inFlight: null, recovered: [], updatedAt: new Date().toISOString(),
  };
}

export interface LoadResult { memory: ProjectMemory; status: "new" | "loaded" | "foreign" | "corrupt" }

/**
 * Load the memory for this job, or start a new one. A file bound to another project or job (or for another build
 * kind/revision) is never used: tenant isolation is by identity, not by directory alone.
 */
export function loadMemory(jobDir: string, id: MemoryIdentity): LoadResult {
  const f = memoryPath(jobDir);
  if (!existsSync(f)) return { memory: newMemory(id), status: "new" };
  let m: ProjectMemory;
  try { m = JSON.parse(readFileSync(f, "utf8")) as ProjectMemory; } catch { return { memory: newMemory(id), status: "corrupt" }; }
  if (!m || m.schema !== MEMORY_SCHEMA || !Array.isArray(m.segments)) return { memory: newMemory(id), status: "corrupt" };
  if (m.projectId !== id.projectId || m.jobId !== id.jobId || m.kind !== id.kind || m.revision !== id.revision) return { memory: newMemory(id), status: "foreign" };
  // The brief may have a newer version (owner edit): keep the record, update the identity.
  if (id.brief?.sha256 && m.brief.sha256 !== id.brief.sha256) m.brief = newMemory(id).brief;
  return { memory: m, status: "loaded" };
}

export function saveMemory(jobDir: string, m: ProjectMemory): void {
  const dir = path.join(jobDir, "agent");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  m.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, `.${MEMORY_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  renameSync(tmp, memoryPath(jobDir));
}

/** Runner-side updates. Every helper bounds what it keeps. */
export const remember = {
  /** Open a new segment. Returns the recovery record when the previous segment never closed (crash, lease loss, restart). */
  segmentStart(m: ProjectMemory, attempt: number, commit: string | null): ProjectMemory["recovered"][number] | null {
    const interrupted = m.inFlight;
    const open = m.segments.at(-1);
    const crashed = !!open && open.endedAt === null;
    if (open && crashed) { open.endedAt = new Date().toISOString(); open.end = "interrupted"; open.progress = null; }
    let rec: ProjectMemory["recovered"][number] | null = null;
    if (interrupted || crashed) {
      rec = { at: new Date().toISOString(), interrupted, note: interrupted ? `the previous runner stopped during ${interrupted.kind} (${interrupted.label})` : "the previous segment ended without a recorded end (runner restart, crash or lost lease)" };
      m.recovered.push(rec);
      if (m.recovered.length > MAX.recovered) m.recovered.splice(0, m.recovered.length - MAX.recovered);
    }
    m.inFlight = null;
    m.segments.push({ attempt, startedAt: new Date().toISOString(), endedAt: null, end: null, startCommit: commit, endCommit: null, modelCalls: 0, inputTokens: 0, outputTokens: 0, compactions: 0, progress: null });
    if (m.segments.length > MAX.segments) m.segments.splice(0, m.segments.length - MAX.segments);
    m.totals.segments++;
    return rec;
  },
  /**
   * Close the current segment. `milestone`: a phase completed, a requirement or check improved, or a defect was
   * resolved during the segment. Progress = a milestone or a new commit. Returns whether it made progress.
   */
  segmentEnd(m: ProjectMemory, end: string, commit: string | null, usage: { modelCalls: number; inputTokens: number; outputTokens: number }, milestone: boolean): boolean {
    const s = m.segments.at(-1);
    if (!s || s.endedAt) return milestone;
    s.endedAt = new Date().toISOString();
    s.end = end;
    s.endCommit = commit;
    s.modelCalls = usage.modelCalls; s.inputTokens = usage.inputTokens; s.outputTokens = usage.outputTokens;
    s.progress = milestone || (!!commit && !!s.startCommit && commit !== s.startCommit) || (!!commit && !s.startCommit);
    m.segmentsSinceMilestone = milestone ? 0 : (m.segmentsSinceMilestone ?? 0) + (end === "continuation" ? 1 : 0);
    if (end === "continuation") { m.totals.continuations++; m.idleSegments = s.progress ? 0 : m.idleSegments + 1; }
    else if (s.progress) m.idleSegments = 0;
    m.inFlight = null;
    return s.progress;
  },
  isOpen(m: ProjectMemory): boolean { const s = m.segments.at(-1); return !!s && !s.endedAt; },
  usage(m: ProjectMemory, d: { modelCalls?: number; inputTokens?: number; outputTokens?: number; compactions?: number }): void {
    m.totals.modelCalls += d.modelCalls ?? 0; m.totals.inputTokens += d.inputTokens ?? 0; m.totals.outputTokens += d.outputTokens ?? 0; m.totals.compactions += d.compactions ?? 0;
    const s = m.segments.at(-1);
    if (s && !s.endedAt) s.compactions += d.compactions ?? 0;
  },
  begin(m: ProjectMemory, kind: InFlight["kind"], label: string): void { m.inFlight = { kind, label: scrub(label, 120), startedAt: new Date().toISOString() }; },
  done(m: ProjectMemory): void { m.inFlight = null; },
  phase(m: ProjectMemory, phase: string, status: string, summary: string | null): void {
    if (status === "success" && !m.phasesCompleted.includes(phase) && phase !== "repair") m.phasesCompleted.push(phase);
    if (summary) { m.notes.push({ at: new Date().toISOString(), phase, text: scrub(summary, 300), source: "model-reported" }); if (m.notes.length > MAX.notes) m.notes.splice(0, m.notes.length - MAX.notes); }
  },
  requirements(m: ProjectMemory, items: { key: string; label?: string; status: string }[]): boolean {
    const before = new Map(m.requirements.map((r) => [r.key, r.status]));
    m.requirements = items.slice(0, 300).map((r) => ({ key: scrub(r.key, 80), label: scrub(r.label ?? "", 160), status: scrub(r.status, 40) }));
    return m.requirements.some((r) => before.get(r.key) !== r.status && /verified|implemented/.test(r.status));
  },
  checks(m: ProjectMemory, checks: { id: string; ok: boolean }[]): boolean {
    const failedBefore = m.checks.filter((c) => !c.ok).length;
    const at = new Date().toISOString();
    m.checks = checks.slice(0, MAX.checks).map((c) => ({ id: scrub(c.id, 80), ok: !!c.ok, at }));
    const failedNow = m.checks.filter((c) => !c.ok).length;
    return m.checks.length > 0 && failedNow < failedBefore;
  },
  cycle(m: ProjectMemory, c: { cycle: number; decision: string; outstanding: string[]; reviewer: string }): DefectRecord | null {
    m.cyclesCompleted = Math.max(m.cyclesCompleted, c.cycle);
    let defect: DefectRecord | null = null;
    if (c.outstanding.length) {
      const id = defectId(c.outstanding);
      defect = m.defects.find((d) => d.id === id) ?? null;
      if (defect) { defect.lastCycle = c.cycle; defect.occurrences++; defect.resolved = false; }
      else { defect = { id, summary: c.outstanding.slice(0, 8).map((s) => scrub(s, 160)), firstCycle: c.cycle, lastCycle: c.cycle, occurrences: 1, resolved: false, repairs: [] }; m.defects.push(defect); }
    }
    // Every other open defect that is no longer reported is resolved; its last repair worked.
    for (const d of m.defects) if (!d.resolved && d !== defect) { d.resolved = true; const r = d.repairs.at(-1); if (r && r.resolved === null) r.resolved = true; }
    if (defect) { const r = defect.repairs.at(-1); if (r && r.resolved === null && r.cycle < c.cycle) r.resolved = false; }
    if (m.defects.length > MAX.defects) m.defects.splice(0, m.defects.length - MAX.defects);
    m.cycles.push({ cycle: c.cycle, decision: scrub(c.decision, 60), outstanding: c.outstanding.length, defect: defect?.id ?? null, reviewer: scrub(c.reviewer, 80), at: new Date().toISOString() });
    if (m.cycles.length > MAX.cycles) m.cycles.splice(0, m.cycles.length - MAX.cycles);
    return defect;
  },
  repair(m: ProjectMemory, defect: DefectRecord | null, r: { cycle: number; model: string; task: string; commitBefore: string | null }): void {
    if (!defect) return;
    defect.repairs.push({ ...r, model: scrub(r.model, 80), task: scrub(r.task, 40), commitAfter: null, resolved: null });
    if (defect.repairs.length > MAX.repairs) defect.repairs.splice(0, defect.repairs.length - MAX.repairs);
  },
  repairDone(m: ProjectMemory, defect: DefectRecord | null, commitAfter: string | null): void {
    const r = defect?.repairs.at(-1);
    if (r) r.commitAfter = commitAfter;
  },
  integrations(m: ProjectMemory, items: { key: string; codeStatus?: string; mockStatus?: string; operation?: string; status?: string }[]): void {
    const byKey = new Map(m.integrations.map((i) => [i.operation ?? i.key, i]));
    for (const it of items.slice(0, 50)) {
      const clean = Object.fromEntries(Object.entries(it).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, scrub(v, 80)])) as ProjectMemory["integrations"][number];
      byKey.set(clean.operation ?? clean.key, { ...(byKey.get(clean.operation ?? clean.key) ?? {}), ...clean });
    }
    m.integrations = [...byKey.values()].slice(0, 60);
    m.approvalsPending = m.integrations.filter((i) => i.status === "awaiting_approval" || i.status === "missing_credentials").map((i) => `${i.operation ?? i.key}: ${i.status}`).slice(0, 30);
  },
  preview(m: ProjectMemory, p: { url: string | null; note: string | null }): void { m.preview = { url: p.url ? scrub(p.url, 300) : null, note: p.note ? scrub(p.note, 300) : null, at: new Date().toISOString() }; },
};

/** Whether the same defect has already been "repaired" without effect at least `n` times (stall / repeated-fix guard). */
export function ineffectiveRepairs(d: DefectRecord | null): number {
  if (!d) return 0;
  return d.repairs.filter((r) => r.resolved === false).length;
}

/**
 * Model-facing digest of the memory: what is done, what is open, what to re-read. Bounded to `maxChars`; the most
 * important sections come first so truncation drops the least important. It carries no customer brief text (the
 * brief is in its own untrusted block) and no credentials.
 */
export function memoryDigest(m: ProjectMemory, maxChars: number): string {
  const lines: string[] = [];
  lines.push("DURABLE PROJECT MEMORY (kept by the runner from the repository, the platform's records and the runner's own checks; authoritative over anything you remember).");
  lines.push(`Build: ${m.kind}${m.revision ? ` revision ${m.revision}` : ""}; segment ${m.totals.segments}; context resets so far ${m.totals.compactions}.`);
  lines.push("Authoritative sources to re-read before continuing (those that exist): BRIEF.json (customer requirements), SPEC.json (architecture), .crestmont/plan.md, .crestmont/requirements.json, .crestmont/runner-checks.json, the latest .crestmont/review-NN.md, and the source files themselves.");
  if (m.phasesCompleted.length) lines.push(`Phases completed: ${m.phasesCompleted.join(", ")}.`);
  const open = m.requirements.filter((r) => !/^verified$|^not_applicable$|^excluded$/.test(r.status));
  const done = m.requirements.length - open.length;
  if (m.requirements.length) {
    lines.push(`Requirements: ${done} of ${m.requirements.length} verified or not applicable. Open:`);
    for (const r of open.slice(0, 40)) lines.push(`  - ${r.key} (${r.status}): ${r.label}`);
    if (open.length > 40) lines.push(`  - ... ${open.length - 40} more in .crestmont/requirements.json`);
  }
  const failing = m.checks.filter((c) => !c.ok);
  if (m.checks.length) lines.push(failing.length ? `Runner acceptance checks failing: ${failing.map((c) => c.id).join(", ")} (details: .crestmont/runner-checks.json).` : "Runner acceptance checks: all passed at the last run.");
  const unresolved = m.defects.filter((d) => !d.resolved);
  for (const d of unresolved.slice(0, 8)) {
    const failed = d.repairs.filter((r) => r.resolved === false).length;
    lines.push(`Unresolved defect ${d.id} (seen ${d.occurrences}x since cycle ${d.firstCycle}${failed ? `; ${failed} earlier repair(s) did NOT fix it: use a different approach` : ""}):`);
    for (const s of d.summary.slice(0, 5)) lines.push(`  - ${s}`);
  }
  if (m.approvalsPending.length) lines.push(`Waiting on people (do not fake these; build and mock-test around them): ${m.approvalsPending.join("; ")}.`);
  const ints = m.integrations.filter((i) => i.codeStatus || i.mockStatus);
  if (ints.length) lines.push(`Integrations: ${ints.map((i) => `${i.key} code=${i.codeStatus ?? "?"} mock=${i.mockStatus ?? "?"}`).join("; ")}.`);
  if (m.recovered.length) lines.push(`Recovered after an interruption: ${m.recovered.at(-1)!.note}. Verify the files touched by that step before relying on them.`);
  if (m.notes.length) {
    lines.push("Your own earlier phase summaries (model-reported; verify against the files):");
    for (const n of m.notes.slice(-6)) lines.push(`  - [${n.phase}] ${n.text}`);
  }
  let out = "";
  for (const l of lines) { if (out.length + l.length + 1 > maxChars) { out += "\n[memory digest truncated]"; break; } out += (out ? "\n" : "") + l; }
  return out;
}
