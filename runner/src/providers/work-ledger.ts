// The work ledger: deterministic, runner-maintained state about what the model has already done.
//
// Why this exists. The first Design-First V3 build (bld_e65768e6b0853a425095a1f6) spent 567 model calls,
// 16,358,132 input tokens and 106 context resets across three segments and never produced a single screenshot,
// review cycle or stored snapshot. The dominant cost was rediscovery: every context reset told the model to
// "re-read the files you need (BRIEF.json, SPEC.json, .crestmont/plan.md, ... and the source files you were
// working on)", so the model re-read the same unchanged pages, refilled the window and reset again.
//
// The fix is not a bigger window. It is to stop throwing away what the runner already knows. The runner watches
// every tool call, so it can state as FACT which files exist, which the model has read, which it has changed, and
// whether any of them changed since. That statement is deterministic: it is built from observed tool calls and
// real file hashes, never from a model-written summary, so it can be trusted as authoritative after a reset.
//
// Nothing here hides source from the model. The manifest tells it what it already knows and what is still open;
// read_file still returns the real file whenever the model genuinely needs the text.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const WORK_LEDGER_SCHEMA = "crestmont.work-ledger/1" as const;

/** One file the model has touched, with the hash it had when the model last saw or wrote it. */
export interface LedgerFile {
  /** Repo-relative POSIX path. */
  p: string;
  /** sha256 (first 12 hex) of the content the model last saw, or null when the read failed. */
  sha: string | null;
  bytes: number;
  /** The model read this file. */
  read: boolean;
  /** The model wrote this file. */
  wrote: boolean;
}

export interface WorkLedger {
  schema: typeof WORK_LEDGER_SCHEMA;
  files: LedgerFile[];
  /** Commands run and whether they succeeded, newest last, bounded. */
  commands: { cmd: string; ok: boolean }[];
  /** Things the runner observed completed (phase ends, passing checks). */
  done: string[];
  /** Errors the model has already seen, so a reset does not lose the current problem. */
  errors: string[];
  /** Context resets per phase, so thrashing is measurable rather than invisible. */
  resets: Record<string, number>;
  /**
   * Context resets per phase SINCE the last observed progress (a file written, a command that succeeded, or
   * completed work recorded). This, not the raw reset count, is what bounds recovery.
   *
   * The distinction is the whole point. A long legitimate task may reset its context dozens of times while
   * steadily writing files -- that is continuity working, and it must never be interrupted. What must be bounded
   * is resetting over and over while achieving nothing, which is what bld_e65768e6b0853a425095a1f6 did: it
   * re-read the same unchanged pages 106 times and wrote no new work between resets.
   */
  stale: Record<string, number>;
  /** Tool-output characters served per phase: the budget that actually drives resets. */
  served: Record<string, number>;
}

const MAX_FILES = 200;
const MAX_COMMANDS = 12;
const MAX_DONE = 24;
const MAX_ERRORS = 6;

export function newLedger(): WorkLedger {
  return { schema: WORK_LEDGER_SCHEMA, files: [], commands: [], done: [], errors: [], resets: {}, stale: {}, served: {} };
}

/** A ledger from a restored checkpoint, or a fresh one when it is absent or the wrong schema. */
export function adoptLedger(raw: unknown): WorkLedger {
  const l = raw as WorkLedger | undefined;
  if (!l || l.schema !== WORK_LEDGER_SCHEMA || !Array.isArray(l.files)) return newLedger();
  return {
    schema: WORK_LEDGER_SCHEMA,
    files: l.files.filter((f) => f && typeof f.p === "string").slice(0, MAX_FILES),
    commands: Array.isArray(l.commands) ? l.commands.slice(-MAX_COMMANDS) : [],
    done: Array.isArray(l.done) ? l.done.slice(-MAX_DONE) : [],
    errors: Array.isArray(l.errors) ? l.errors.slice(-MAX_ERRORS) : [],
    resets: l.resets && typeof l.resets === "object" ? l.resets : {},
    // Deliberately NOT carried over: the stale-reset counter is a WITHIN-SEGMENT signal.
    //
    // adoptLedger runs once when a session is loaded, which is the start of a segment or a resumed attempt. At that
    // boundary the work is checkpointed and the model gets a fresh context, so a previous segment's unproductive
    // resets say nothing about this one. Carrying the counter over made a resumed build die immediately:
    // bld_10e2c6007686faee0ab64d45 attempt 4 restored a ledger already past the limit, reset once, and the thrash
    // guard stopped the phase after 7 turns -- stopping legitimate progress rather than a loop. The TOTAL in
    // `resets` is kept, so the diagnosis still reports the full history.
    stale: {},
    served: l.served && typeof l.served === "object" ? l.served : {},
  };
}

/**
 * Observed progress: clears every phase's stale-reset counter.
 *
 * Progress anywhere counts, because the phases share one transcript and one repository. Note what does NOT call
 * this: recordRead and recordReset. Reading a file again is not progress, and a context reset is certainly not.
 */
export function noteProgress(l: WorkLedger): void {
  l.stale = {};
}

const rel = (repo: string, p: string) => path.relative(repo, path.resolve(repo, p)).split(path.sep).join("/");

/** sha256-12 of a file on disk now, or null when it cannot be read. */
export function fileSha(repo: string, p: string): { sha: string | null; bytes: number } {
  try {
    const abs = path.resolve(repo, p);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { sha: null, bytes: 0 };
    const buf = readFileSync(abs);
    return { sha: createHash("sha256").update(buf).digest("hex").slice(0, 12), bytes: buf.length };
  } catch { return { sha: null, bytes: 0 }; }
}

function upsert(l: WorkLedger, f: LedgerFile): void {
  const i = l.files.findIndex((x) => x.p === f.p);
  if (i < 0) {
    l.files.push(f);
    if (l.files.length > MAX_FILES) l.files.shift();
    return;
  }
  l.files[i] = { ...l.files[i], ...f, read: l.files[i].read || f.read, wrote: l.files[i].wrote || f.wrote };
}

/** Record that the model read a file: its hash now is what the model has seen. */
export function recordRead(l: WorkLedger, repo: string, p: string): void {
  const r = rel(repo, p);
  if (!r || r.startsWith("..")) return;
  const { sha, bytes } = fileSha(repo, p);
  upsert(l, { p: r, sha, bytes, read: true, wrote: false });
}

/** Record that the model wrote a file. Writing is progress. */
export function recordWrite(l: WorkLedger, repo: string, p: string): void {
  const r = rel(repo, p);
  if (!r || r.startsWith("..")) return;
  const { sha, bytes } = fileSha(repo, p);
  upsert(l, { p: r, sha, bytes, read: true, wrote: true });
  noteProgress(l);
}

/** Record a command. A command that succeeded is progress; one that failed is not. */
export function recordCommand(l: WorkLedger, cmd: string, ok: boolean): void {
  l.commands.push({ cmd: cmd.replace(/\s+/g, " ").slice(0, 100), ok });
  if (l.commands.length > MAX_COMMANDS) l.commands.shift();
  if (ok) noteProgress(l);
}

export function recordDone(l: WorkLedger, what: string): void {
  const s = what.replace(/\s+/g, " ").slice(0, 140);
  noteProgress(l);
  if (l.done.includes(s)) return;
  l.done.push(s);
  if (l.done.length > MAX_DONE) l.done.shift();
}

export function recordError(l: WorkLedger, what: string): void {
  const s = what.replace(/\s+/g, " ").slice(0, 200);
  l.errors = l.errors.filter((e) => e !== s);
  l.errors.push(s);
  if (l.errors.length > MAX_ERRORS) l.errors.shift();
}

/** Record a context reset. Never progress: it increments both the total and the stale counter. */
export function recordReset(l: WorkLedger, phase: string): number {
  l.resets[phase] = (l.resets[phase] ?? 0) + 1;
  l.stale[phase] = (l.stale[phase] ?? 0) + 1;
  return l.resets[phase];
}

/** Context resets in this phase since the last observed progress. */
export function staleResets(l: WorkLedger, phase: string): number {
  return l.stale[phase] ?? 0;
}

export function recordServed(l: WorkLedger, phase: string, chars: number): void {
  l.served[phase] = (l.served[phase] ?? 0) + Math.max(0, chars);
}

/**
 * Files the model read that have NOT changed on disk since: re-reading one of these cannot teach it anything, and
 * saying so is what replaces "re-read the files you need".
 */
export function unchangedSince(l: WorkLedger, repo: string): LedgerFile[] {
  return l.files.filter((f) => f.read && f.sha !== null && fileSha(repo, f.p).sha === f.sha);
}

/** Files whose content on disk differs from what the model last saw: these are worth re-reading. */
export function changedSince(l: WorkLedger, repo: string): LedgerFile[] {
  return l.files.filter((f) => f.read && f.sha !== null && fileSha(repo, f.p).sha !== f.sha);
}

/**
 * The progress manifest: the deterministic replacement for "re-read everything".
 *
 * Every line is a fact the runner observed. It is deliberately compact — the point is to spend a few hundred
 * tokens saying what would otherwise cost tens of thousands of tokens of re-reading.
 */
export function manifest(l: WorkLedger, repo: string, o: { phase: string; objective?: string | null; commit?: string | null; maxChars?: number } = { phase: "" }): string {
  const max = o.maxChars ?? 4000;
  const changed = changedSince(l, repo);
  const changedPaths = new Set(changed.map((f) => f.p));
  const wrote = l.files.filter((f) => f.wrote);
  const readOnly = l.files.filter((f) => f.read && !f.wrote && !changedPaths.has(f.p));
  const lines: string[] = ["PROGRESS MANIFEST (runner-observed facts; authoritative — not a model summary)."];
  if (o.objective) lines.push(`Current objective: ${o.objective}`);
  if (o.commit) lines.push(`Source commit: ${o.commit}`);
  if (wrote.length) lines.push(`Files YOU HAVE WRITTEN (${wrote.length}): ${wrote.map((f) => `${f.p} (${f.bytes}B)`).join(", ")}`);
  if (readOnly.length) lines.push(`Files YOU HAVE ALREADY READ and which are UNCHANGED since — do NOT read these again (${readOnly.length}): ${readOnly.map((f) => f.p).join(", ")}`);
  if (changed.length) lines.push(`Files that CHANGED since you read them — re-read only these if you need them (${changed.length}): ${changed.map((f) => f.p).join(", ")}`);
  if (l.commands.length) lines.push(`Recent commands: ${l.commands.map((c) => `${c.cmd} [${c.ok ? "ok" : "FAILED"}]`).join("; ")}`);
  if (l.done.length) lines.push(`Completed — do NOT repeat: ${l.done.join("; ")}`);
  if (l.errors.length) lines.push(`Open problems: ${l.errors.join(" | ")}`);
  const r = l.resets[o.phase] ?? 0;
  if (r) lines.push(`Context resets in this phase: ${r}. Reading files you have already read is what causes these. Work from the facts above.`);
  const text = lines.join("\n");
  return text.length <= max ? text : text.slice(0, max) + "\n[manifest truncated]";
}

/**
 * Thrash verdict for one phase.
 *
 * `narrow` asks the caller to shrink the working set and keep going; `stop` means recovery itself is no longer
 * productive and the build must end with a diagnosis rather than keep paying for the same loop. Counting resets
 * is deliberate: a reset is never progress, so a phase that only resets must not look busy.
 */
export interface ThrashLimits { narrowAt: number; stopAt: number }
export const DEFAULT_THRASH: ThrashLimits = { narrowAt: 6, stopAt: 14 };

export function thrashVerdict(l: WorkLedger, phase: string, limits: ThrashLimits = DEFAULT_THRASH): "ok" | "narrow" | "stop" {
  // Stale resets, never the total: a session that writes a file between resets is working, however many resets
  // it needs. Only resetting WITHOUT progress is thrashing.
  const r = staleResets(l, phase);
  if (r >= limits.stopAt) return "stop";
  if (r >= limits.narrowAt) return "narrow";
  return "ok";
}
