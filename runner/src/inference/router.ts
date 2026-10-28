// Founder V4 §4: which model does a task. Model A (the "intelligent" architect/reviewer, e.g. qwen3.8:27b) plans,
// reviews, and takes complex, repeated or architectural work; Model B (the fast builder, e.g. qwen3.6:35b-a3b) does the
// bulk of development and ordinary fixes. The router only chooses a model: it never skips an approval or a gate (the
// platform referee, the approval queue and the private internal review are outside it).

import type { ModelProfile, RunnerConfig } from "../config.ts";

export const TASKS = ["requirements_analysis", "architecture", "planning", "frontend", "backend", "debugging", "complex_change",
  "repeated_failure", "complex_integration", "review", "final_review", "revision", "difficult_revision"] as const;
export type Task = (typeof TASKS)[number];
export type ModelSlot = "A" | "B";

/** Default routing (V4 §4 table). */
export const ROUTING: Record<Task, ModelSlot> = {
  requirements_analysis: "A", architecture: "A", planning: "A", frontend: "B", backend: "B", debugging: "B",
  complex_change: "A", repeated_failure: "A", complex_integration: "A", review: "A", final_review: "A", revision: "B", difficult_revision: "A",
};

export interface Route { task: Task; slot: ModelSlot; model: ModelProfile; reason: string }

export function route(task: Task, models: RunnerConfig["models"], why?: string): Route {
  const slot = ROUTING[task];
  const model = slot === "A" ? models.a : models.b;
  const label = task.replace(/_/g, " ");
  return { task, slot, model, reason: why ?? `${label} → Model ${slot}${models.mode === "single" ? " (single-model mode: one model serves both roles)" : ""}` };
}

/** Build-phase task from the specification's workstreams (labels the work; both go to Model B). */
export function buildTask(spec: { tasks?: { workstream?: string }[] } | null): Task {
  const ws = (spec?.tasks ?? []).map((t) => (t.workstream ?? "").toLowerCase());
  const backend = ws.filter((w) => /backend|api|data|integration/.test(w)).length;
  return backend > ws.length / 2 ? "backend" : "frontend";
}

const DIFFICULT_REVISION = /\b(architecture|re-?architect|database|schema|migration|payment|checkout|stripe|auth|login|sign[- ]?in|account|integration|api|booking|security|redesign|rebuild|restructure|multi-?language|i18n|e-?commerce)\b/i;

/** Customer or staff revision: routine changes go to Model B; structural ones to Model A. */
export function revisionTask(instruction: string | null): { task: Task; reason: string } {
  const text = (instruction ?? "").trim();
  if (text.length > 1500) return { task: "difficult_revision", reason: "long revision request (over 1500 characters) → Model A" };
  const m = DIFFICULT_REVISION.exec(text);
  if (m) return { task: "difficult_revision", reason: `revision touches "${m[1].toLowerCase()}" → Model A` };
  return { task: "revision", reason: "routine revision → Model B" };
}

export interface RepairContext {
  /** Outstanding items (check:/criterion:/defect:/security:) after this cycle. */
  outstanding: string[];
  /** How many consecutive cycles ended with exactly these outstanding items (1 = first time). */
  sameFailureRepeats: number;
  /** Reviewer findings / decision text, scanned for architectural problems. */
  findings: string[];
  escalateAfterRepeats: number;
}

const ARCHITECTURAL = /\b(architecture|architectural|data model|schema|routing|state management|restructure|refactor the|wrong approach|redesign)\b/i;

/** Corrective work after a review: ordinary defects → B; repeated, architectural or integration-heavy → A. */
export function repairTask(c: RepairContext): { task: Task; reason: string } {
  if (c.sameFailureRepeats >= c.escalateAfterRepeats) return { task: "repeated_failure", reason: `the same failures repeated ${c.sameFailureRepeats} times → Model A` };
  const arch = c.findings.find((f) => ARCHITECTURAL.test(f));
  if (arch) return { task: "complex_change", reason: "the review found an architectural problem → Model A" };
  const integ = c.outstanding.filter((o) => /^criterion:integration|^security:/.test(o));
  if (integ.length && integ.length >= Math.ceil(c.outstanding.length / 2)) return { task: "complex_integration", reason: "integration or security work dominates → Model A" };
  return { task: "debugging", reason: "ordinary defects → Model B" };
}
