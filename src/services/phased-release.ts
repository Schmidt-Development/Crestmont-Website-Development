// Founder scope dispositions for a phased release (policy: src/readiness/phased-release.ts, docs/PHASED-LAUNCH.md).
//
// Only the Founder's own Owner account, with a fresh second factor (src/app/step-up.ts), can defer or reinstate a
// requirement. Each decision is a `scope_disposition` row in release_approvals — the record the readiness schema has
// always reserved for this (migration 0002: requirements.disposition_approval_id) — bound to the release candidate
// and evidence set it was made against, and audited. Every decision voids outstanding launch approvals: the scope
// the Founder approved is no longer the scope being released.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { can, isOwner, type Actor } from "../domain/authz.ts";
import { ACCEPTANCE } from "../../requirements/acceptance.ts";
import { audit } from "./security.ts";
import * as ra from "./readiness-admin.ts";
import { PHASE_1, PRODUCTION_GATES, deferral, type ProductionGate } from "../readiness/phased-release.ts";

type Ctx = Pick<AppContext, "db" | "now" | "ip"> & { env?: Pick<AppContext["env"], "FOUNDER_EMAIL"> };

export interface PhaseItem {
  id: string; title: string; subsystem: string; category: string; priority: string; state: string;
  disposition: "in_scope" | "deferred_by_founder" | "excluded_by_founder"; approvalId: string | null;
  eligible: boolean; reason: string | null; gate: ProductionGate | null;
}

/** Every AI-system requirement with whether phase 1 may defer it, plus every requirement already deferred. */
export async function phaseItems(ctx: Pick<AppContext, "db" | "now">): Promise<PhaseItem[]> {
  const { report } = await ra.loadReport(ctx);
  const rows = new Map((await ctx.db.prepare(`SELECT id, disposition, disposition_approval_id FROM requirements`).all<{ id: string; disposition: PhaseItem["disposition"]; disposition_approval_id: string | null }>()).results.map((r) => [r.id, r]));
  const out: PhaseItem[] = [];
  for (const s of report.requirements) {
    const tracking = ACCEPTANCE[s.id]?.tracking ?? "platform";
    const row = rows.get(s.id);
    const disposition = row?.disposition ?? "in_scope";
    if (tracking !== "external_ai" && disposition === "in_scope") continue;
    const d = deferral({ id: s.id, subsystem: s.subsystem, category: s.category, tracking });
    out.push({ id: s.id, title: s.title, subsystem: s.subsystem, category: s.category, priority: s.priority, state: s.state, disposition, approvalId: row?.disposition_approval_id ?? null,
      eligible: d.ok, reason: d.ok ? null : d.reason, gate: d.ok ? d.gate : null });
  }
  return out;
}

/** Requirements currently deferred by the Founder, with their subsystem (read by the release-authorization check). */
export async function deferredRequirements(db: Db): Promise<{ id: string; subsystem: string }[]> {
  return (await db.prepare(`SELECT id, subsystem FROM requirements WHERE disposition = 'deferred_by_founder' ORDER BY id`).all<{ id: string; subsystem: string }>()).results;
}

async function requireFounder(ctx: Ctx, actor: Actor, userId: string, action: string): Promise<void> {
  if (actor.kind !== "user" || !isOwner(actor) || !can(actor, "release.approve_production")) throw new ra.ReadinessError("Only the Founder's Owner account can change the release scope.", 403);
  const notFounder = ra.founderProblem(await ra.approverEmail(ctx.db, userId), ctx.env?.FOUNDER_EMAIL);
  if (notFounder) {
    await audit(ctx.db, { actorUserId: userId, action: `release.scope_${action}_refused`, subjectType: "release", ip: ctx.ip, details: { reason: notFounder } });
    throw new ra.ReadinessError(`Refused: ${notFounder}. Only the Founder's own account can change the release scope.`, 403);
  }
}

async function recordDisposition(ctx: Ctx, userId: string, notes: string): Promise<{ id: string; evidenceSet: string; releaseId: string | null }> {
  const { report } = await ra.loadReport(ctx);
  const rc = await ra.currentReleaseCandidate(ctx.db);
  const id = newId("rap");
  await ctx.db.prepare(`INSERT INTO release_approvals (id, release_id, kind, approver_user_id, commit_sha, config_sha256, evidence_set_sha256, decision, notes, created_at) VALUES (?,?, 'scope_disposition', ?,?,?,?, 'approved', ?,?)`)
    .bind(id, rc?.id ?? null, userId, rc?.commit_sha ?? null, rc?.config_sha256 ?? null, report.evidenceSetSha256, notes.slice(0, 4000), nowIso(ctx.now)).run();
  return { id, evidenceSet: report.evidenceSetSha256, releaseId: rc?.id ?? null };
}

async function voidLaunchApprovals(db: Db, at: string, why: string): Promise<number> {
  const r = await db.prepare(`UPDATE release_approvals SET invalidated_at = ?, invalidated_reason = ? WHERE kind = 'production_launch' AND invalidated_at IS NULL`).bind(at, why).run();
  return r.meta?.changes ?? 0;
}

/** Defers the named AI-system requirements for phase 1. All-or-nothing: one ineligible id refuses the whole request. */
export async function deferForPhase(ctx: Ctx, actor: Actor, userId: string, v: { ids: string[]; notes: string; confirm: string }): Promise<{ approvalId: string; deferred: string[] }> {
  await requireFounder(ctx, actor, userId, "deferral");
  const ids = [...new Set(v.ids.map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length) throw new ra.ReadinessError("Choose at least one requirement to defer.");
  if (v.confirm.trim().toLowerCase() !== PHASE_1.confirmPhrase) throw new ra.ReadinessError(`Type "${PHASE_1.confirmPhrase}" to confirm.`);
  if (v.notes.trim().length < 20) throw new ra.ReadinessError("State the reason for the deferral (at least 20 characters); it is kept with the decision.");
  const items = new Map((await phaseItems(ctx)).map((i) => [i.id, i]));
  const problems: string[] = [];
  for (const id of ids) {
    const it = items.get(id);
    if (!it) { problems.push(`${id} is not an AI-system requirement; phase 1 defers only the separately-developed AI systems.`); continue; }
    if (it.disposition !== "in_scope") { problems.push(`${id} is already ${it.disposition.replace(/_/g, " ")}.`); continue; }
    if (!it.eligible) problems.push(it.reason!);
  }
  if (problems.length) throw new ra.ReadinessError(problems.join(" "));
  const subsystems = [...new Set(ids.map((id) => items.get(id)!.subsystem))];
  const rec = await recordDisposition(ctx, userId, `${PHASE_1.id}: deferred ${ids.join(", ")}\nGates relied on: ${subsystems.map((s) => PRODUCTION_GATES.find((g) => g.subsystem === s)!.gate).join(" | ")}\n\n${v.notes.trim()}`);
  const at = nowIso(ctx.now);
  await ctx.db.batch(ids.map((id) => ctx.db.prepare(`UPDATE requirements SET disposition = 'deferred_by_founder', disposition_approval_id = ?, updated_at = ? WHERE id = ? AND disposition = 'in_scope'`).bind(rec.id, at, id)));
  const voided = await voidLaunchApprovals(ctx.db, at, `Release scope changed by scope disposition ${rec.id} (${PHASE_1.id}: ${ids.length} requirement(s) deferred)`);
  await audit(ctx.db, { actorUserId: userId, action: "release.scope_deferred", subjectType: "release", subjectId: rec.releaseId ?? undefined, ip: ctx.ip,
    details: { approvalId: rec.id, policy: PHASE_1.id, requirements: ids, subsystems, evidenceSetBefore: rec.evidenceSet, launchApprovalsVoided: voided } });
  return { approvalId: rec.id, deferred: ids };
}

/** Puts a deferred requirement back into every gate. Never refused for scope reasons: it only makes release stricter. */
export async function reinstate(ctx: Ctx, actor: Actor, userId: string, v: { id: string; notes: string }): Promise<{ approvalId: string }> {
  await requireFounder(ctx, actor, userId, "reinstatement");
  const id = v.id.trim().toUpperCase();
  const row = await ctx.db.prepare(`SELECT disposition FROM requirements WHERE id = ?`).bind(id).first<{ disposition: string }>();
  if (!row) throw new ra.ReadinessError(`${id} is not in the requirements inventory.`, 404);
  if (row.disposition === "in_scope") throw new ra.ReadinessError(`${id} is already in scope.`);
  const rec = await recordDisposition(ctx, userId, `${PHASE_1.id}: reinstated ${id}${v.notes.trim() ? `\n\n${v.notes.trim()}` : ""}`);
  const at = nowIso(ctx.now);
  await ctx.db.prepare(`UPDATE requirements SET disposition = 'in_scope', disposition_approval_id = ?, updated_at = ? WHERE id = ?`).bind(rec.id, at, id).run();
  const voided = await voidLaunchApprovals(ctx.db, at, `Release scope changed by scope disposition ${rec.id} (${id} reinstated)`);
  await audit(ctx.db, { actorUserId: userId, action: "release.scope_reinstated", subjectType: "requirement", subjectId: id, ip: ctx.ip, details: { approvalId: rec.id, policy: PHASE_1.id, launchApprovalsVoided: voided } });
  return { approvalId: rec.id };
}
