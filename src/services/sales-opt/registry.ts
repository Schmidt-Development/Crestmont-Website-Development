// Sales-optimization control row, Retell sales-agent targets and the immutable version registry
// (SALESOPT-001, SALESOPT-006). Content of a version never changes (database trigger); only its status moves,
// along the transitions in TRANSITIONS, each with a compare-and-swap on the previous status.
import type { Db } from "../../lib/db.ts";
import { newId, nowIso } from "../../lib/db.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { audit } from "../security.ts";
import { lineDiff } from "../voice.ts";
import { loadVoiceConfig } from "../voice-settings.ts";
import { composeSalesPrompt, salesPolicyViolations, SALES_POLICY_VERSION } from "../../domain/sales-opt/policy.ts";
import { parseThresholds, type SafetyThresholds } from "../../domain/sales-opt/stats.ts";

export class SalesOptError extends Error {
  status: number;
  constructor(msg: string, status = 422) { super(msg); this.status = status; }
}

export type Stage = "staging" | "production";
export const STAGES: readonly Stage[] = ["staging", "production"];

// ───────────── Control ─────────────

export interface Control { paused: boolean; productionActivated: boolean; autoRollback: boolean; thresholds: SafetyThresholds; lastRunAt: string | null; lastRunDetail: string | null; lastProposalAt: string | null }

export async function loadControl(db: Db): Promise<Control> {
  const r = await db.prepare(`SELECT * FROM so_control WHERE id = 1`).first<{ paused: number; production_activated: number; auto_rollback: number; thresholds_json: string; last_run_at: string | null; last_run_detail: string | null; last_proposal_at: string | null }>();
  if (!r) return { paused: true, productionActivated: false, autoRollback: true, thresholds: parseThresholds(null), lastRunAt: null, lastRunDetail: null, lastProposalAt: null };
  return { paused: r.paused === 1, productionActivated: r.production_activated === 1, autoRollback: r.auto_rollback === 1, thresholds: parseThresholds(r.thresholds_json), lastRunAt: r.last_run_at, lastRunDetail: r.last_run_detail, lastProposalAt: r.last_proposal_at };
}

export async function setControl(db: Db, userId: string, patch: Partial<{ paused: boolean; productionActivated: boolean; autoRollback: boolean; thresholds: SafetyThresholds }>): Promise<Control> {
  const cur = await loadControl(db);
  const next = { ...cur, ...patch };
  await db.prepare(`UPDATE so_control SET paused = ?, production_activated = ?, auto_rollback = ?, thresholds_json = ?, updated_by = ?, updated_at = ? WHERE id = 1`)
    .bind(next.paused ? 1 : 0, next.productionActivated ? 1 : 0, next.autoRollback ? 1 : 0, JSON.stringify(next.thresholds), userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "salesopt.control_changed", subjectType: "so_control", subjectId: "1", details: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === "object" ? "updated" : v])) });
  return loadControl(db);
}

// ───────────── Targets ─────────────

export interface Target { stage: Stage; agent_id: string; llm_id: string | null; engine_type: string | null; verified_at: string | null; updated_at: string }

const AGENT_ID = /^[A-Za-z0-9_-]{4,80}$/;

export async function listTargets(db: Db): Promise<Record<Stage, Target | null>> {
  const rows = (await db.prepare(`SELECT * FROM so_targets`).all<Target>()).results;
  return { staging: rows.find((r) => r.stage === "staging") ?? null, production: rows.find((r) => r.stage === "production") ?? null };
}

/** The receptionist's agent ids: the engine must never write to them (brief: do not modify the inbound receptionist). */
export async function receptionistAgentIds(db: Db): Promise<Set<string>> {
  const cfg = await loadVoiceConfig(db);
  return new Set([cfg.inbound.agent_id, cfg.outbound.agent_id].filter((x): x is string => !!x));
}

export async function setTarget(db: Db, userId: string, stage: Stage, agentId: string): Promise<void> {
  const id = agentId.trim();
  if (!AGENT_ID.test(id)) throw new SalesOptError("Enter the Retell agent id (letters, digits, _ or -).");
  if ((await receptionistAgentIds(db)).has(id)) throw new SalesOptError("That agent id is the AI receptionist's. The sales optimizer only works on a separate sales agent.", 409);
  const other = (await listTargets(db))[stage === "staging" ? "production" : "staging"];
  if (other && other.agent_id === id) throw new SalesOptError("Staging and production must be different Retell agents, so validation never touches the live agent.", 409);
  await db.prepare(`INSERT INTO so_targets (stage, agent_id, llm_id, engine_type, verified_at, updated_by, updated_at) VALUES (?,?,NULL,NULL,NULL,?,?)
      ON CONFLICT(stage) DO UPDATE SET agent_id = excluded.agent_id, llm_id = NULL, engine_type = NULL, verified_at = NULL, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(stage, id, userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "salesopt.target_set", subjectType: "so_target", subjectId: stage, details: { agent: id.slice(0, 12) } });
}

export async function stageForAgent(db: Db, agentId: string | null | undefined): Promise<Stage | null> {
  if (!agentId) return null;
  const t = await listTargets(db);
  return t.production?.agent_id === agentId ? "production" : t.staging?.agent_id === agentId ? "staging" : null;
}

// ───────────── Versions ─────────────

export type VersionStatus = "draft" | "evaluating" | "eval_failed" | "eval_passed" | "rejected" | "approved" | "retired";
export interface VersionRow {
  id: string; seq: number; parent_id: string | null; instructions: string; prompt_sha256: string; policy_version: string; diff_json: string; rationale: string;
  evidence_json: string; author_kind: "user" | "ai" | "import"; author: string; created_at: string; status: VersionStatus; approved_by: string | null; approved_at: string | null;
  decision_note: string | null; status_updated_at: string;
}

const TRANSITIONS: Record<VersionStatus, readonly VersionStatus[]> = {
  draft: ["evaluating", "rejected"],
  evaluating: ["eval_passed", "eval_failed"],
  eval_failed: ["evaluating", "rejected"],
  eval_passed: ["approved", "rejected", "evaluating"],
  approved: ["retired", "evaluating"],
  rejected: [],
  retired: ["evaluating"],
};

export const canTransition = (from: VersionStatus, to: VersionStatus) => TRANSITIONS[from].includes(to);

export async function getVersion(db: Db, id: string): Promise<VersionRow | null> {
  return db.prepare(`SELECT * FROM so_versions WHERE id = ?`).bind(id).first<VersionRow>();
}

export async function listVersions(db: Db, limit = 50): Promise<VersionRow[]> {
  return (await db.prepare(`SELECT * FROM so_versions ORDER BY seq DESC LIMIT ?`).bind(limit).all<VersionRow>()).results;
}

export interface NewVersion { parentId: string | null; instructions: string; rationale: string; evidence?: unknown[]; authorKind: "user" | "ai" | "import"; author: string; actorUserId?: string | null }

export async function createVersion(db: Db, v: NewVersion): Promise<VersionRow> {
  const problems = salesPolicyViolations(v.instructions);
  if (v.rationale.trim().length < 3) problems.push("Describe why this version exists (rationale).");
  if (problems.length) throw new SalesOptError(problems.join(" "));
  const parent = v.parentId ? await getVersion(db, v.parentId) : null;
  if (v.parentId && !parent) throw new SalesOptError("Parent version not found", 404);
  const instructions = v.instructions.trim();
  if (parent && parent.instructions === instructions) throw new SalesOptError("This is identical to its parent version.", 409);
  const diff = lineDiff(parent?.instructions ?? "", instructions).filter((d) => d.op !== " ");
  const id = newId("sov"), at = nowIso();
  // seq is assigned in the INSERT itself; a concurrent insert that picks the same seq fails on UNIQUE and is retried once.
  for (let attempt = 0; ; attempt++) {
    try {
      await db.prepare(`INSERT INTO so_versions (id, seq, parent_id, instructions, prompt_sha256, policy_version, diff_json, rationale, evidence_json, author_kind, author, created_at, status, status_updated_at)
          SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ? FROM so_versions`)
        .bind(id, parent?.id ?? null, instructions, await sha256Hex(composeSalesPrompt(instructions)), SALES_POLICY_VERSION, JSON.stringify(diff),
          v.rationale.trim().slice(0, 2000), JSON.stringify((v.evidence ?? []).slice(0, 100)), v.authorKind, v.author.slice(0, 120), at, at).run();
      break;
    } catch (e) {
      const msg = (e as Error).message;
      if (/uq_so_versions_open_ai|author_kind/.test(msg) && v.authorKind === "ai") throw new SalesOptError("An AI proposal is already awaiting a decision.", 409);
      if (attempt === 0 && /UNIQUE/.test(msg)) continue;
      throw e;
    }
  }
  await audit(db, { actorUserId: v.actorUserId ?? null, actorKind: v.authorKind === "ai" ? "ai" : v.actorUserId ? "user" : "system", action: "salesopt.version_created", subjectType: "so_version", subjectId: id, details: { parent: parent?.id ?? null, author_kind: v.authorKind } });
  return (await getVersion(db, id))!;
}

/** Compare-and-swap status change. Returns the new row; throws 409 if the version moved meanwhile or the move is not allowed. */
export async function transition(db: Db, id: string, to: VersionStatus, actor: { userId?: string | null; note?: string | null } = {}): Promise<VersionRow> {
  const v = await getVersion(db, id);
  if (!v) throw new SalesOptError("Version not found", 404);
  if (!canTransition(v.status, to)) throw new SalesOptError(`A ${v.status.replace("_", " ")} version cannot become ${to.replace("_", " ")}.`, 409);
  const at = nowIso();
  const approving = to === "approved";
  const res = await db.prepare(`UPDATE so_versions SET status = ?, status_updated_at = ?, decision_note = COALESCE(?, decision_note)${approving ? ", approved_by = ?, approved_at = ?" : ""} WHERE id = ? AND status = ?`)
    .bind(...[to, at, actor.note?.slice(0, 500) ?? null, ...(approving ? [actor.userId ?? null, at] : []), id, v.status]).run();
  if (res.meta.changes !== 1) throw new SalesOptError("The version changed while you were deciding. Reload and try again.", 409);
  await audit(db, { actorUserId: actor.userId ?? null, actorKind: actor.userId ? "user" : "system", action: `salesopt.version_${to}`, subjectType: "so_version", subjectId: id, details: { from: v.status } });
  return (await getVersion(db, id))!;
}

/** Version currently verified on a stage (latest verified deployment), or null. */
export async function deployedVersion(db: Db, stage: Stage): Promise<VersionRow | null> {
  return db.prepare(`SELECT v.* FROM so_deployments d JOIN so_versions v ON v.id = d.version_id WHERE d.stage = ? AND d.status = 'verified' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`).bind(stage).first<VersionRow>();
}

/** Ensures version 1 exists (the baseline instructions, author "import"). */
export async function ensureBaseline(db: Db, instructions: string): Promise<VersionRow> {
  const first = await db.prepare(`SELECT * FROM so_versions ORDER BY seq LIMIT 1`).first<VersionRow>();
  return first ?? createVersion(db, { parentId: null, instructions, rationale: "Baseline sales instructions (platform default, pending Founder review).", authorKind: "import", author: "platform" });
}
