// Staff offboarding (CREST-GAP-041). Disabling an account (src/services/employees.ts setStaffDisabled) records every
// piece of the person's open work in offboarding_items:
//   task / project  — open assignments (tasks not done, projects not completed/cancelled)
//   project_manager — projects they manage that are still open
//   lead            — open leads they own
//   ticket          — open tickets assigned to them
// Two modes, chosen when disabling:
//   queue (default) — the work stays as it is, flagged "owner disabled", until someone reassigns or ends each item
//                     from the reassignment queue (/staff/employees/:id/offboarding);
//   end             — every assignment is ended immediately (PM cleared, lead owner cleared) and the work is flagged
//                     "owner disabled" so coordinators can pick it up.
// Re-enabling the account marks still-pending items 'restored' (the person keeps that work). Every step is audited.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { notify } from "./notifications.ts";

export type OffboardingSubject = "task" | "project" | "project_manager" | "lead" | "ticket";
export interface OffboardingItem {
  id: string; user_id: string; subject_type: OffboardingSubject; subject_id: string; label: string; status: "pending" | "reassigned" | "ended" | "restored";
  created_at: string; resolved_at: string | null; resolved_to_user_id: string | null; resolved_to_name: string | null;
}

export class OffboardingError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

export const SUBJECT_LABELS: Record<OffboardingSubject, string> = { task: "Task assignment", project: "Project assignment", project_manager: "Project manager", lead: "Lead owner", ticket: "Ticket assignment" };
/** Roles that may take each kind of work (same rules as the normal assignment flows). */
const ELIGIBLE_ROLES: Record<OffboardingSubject, string[]> = {
  task: ["owner", "administrator", "developer", "project_manager", "support", "sales"],
  project: ["owner", "administrator", "developer", "project_manager", "support", "sales"],
  project_manager: ["owner", "project_manager"],
  lead: ["owner", "administrator", "sales"],
  ticket: ["owner", "support"],
};

/** The person's open work right now (what disabling them would leave behind). */
export async function openWork(db: Db, userId: string): Promise<{ subject_type: OffboardingSubject; subject_id: string; label: string }[]> {
  const q = <T>(sql: string) => db.prepare(sql).bind(userId).all<T>().then((r) => r.results);
  const tasks = await q<{ id: string; label: string }>(`SELECT t.id, t.title || ' — ' || p.name AS label FROM assignments a JOIN tasks t ON t.id = a.subject_id JOIN projects p ON p.id = t.project_id
      WHERE a.subject_type = 'task' AND a.user_id = ? AND a.ended_at IS NULL AND t.status <> 'done' ORDER BY t.created_at`);
  const projects = await q<{ id: string; label: string }>(`SELECT p.id, p.name AS label FROM assignments a JOIN projects p ON p.id = a.subject_id
      WHERE a.subject_type = 'project' AND a.user_id = ? AND a.ended_at IS NULL AND p.status NOT IN ('completed','cancelled') ORDER BY p.created_at`);
  const pm = await q<{ id: string; label: string }>(`SELECT id, name AS label FROM projects WHERE project_manager_id = ? AND status NOT IN ('completed','cancelled') ORDER BY created_at`);
  const leads = await q<{ id: string; label: string }>(`SELECT l.id, c.name AS label FROM leads l JOIN contacts c ON c.id = l.contact_id
      WHERE l.owner_user_id = ? AND l.merged_into_lead_id IS NULL AND l.stage NOT IN ('converted','lost','rejected','archived') ORDER BY l.created_at`);
  const tickets = await q<{ id: string; label: string }>(`SELECT t.id, t.subject AS label FROM assignments a JOIN tickets t ON t.id = a.subject_id
      WHERE a.subject_type = 'ticket' AND a.user_id = ? AND a.ended_at IS NULL AND t.status NOT IN ('resolved','closed') ORDER BY t.created_at`);
  return [
    ...tasks.map((x) => ({ subject_type: "task" as const, subject_id: x.id, label: x.label })),
    ...projects.map((x) => ({ subject_type: "project" as const, subject_id: x.id, label: x.label })),
    ...pm.map((x) => ({ subject_type: "project_manager" as const, subject_id: x.id, label: x.label })),
    ...leads.map((x) => ({ subject_type: "lead" as const, subject_id: x.id, label: x.label })),
    ...tickets.map((x) => ({ subject_type: "ticket" as const, subject_id: x.id, label: x.label })),
  ];
}

/** Called when an account is disabled: queues the open work, or ends it immediately (mode "end"). Returns counts. */
export async function startOffboarding(db: Db, byUserId: string, userId: string, mode: "queue" | "end"): Promise<{ queued: number; ended: number }> {
  const work = await openWork(db, userId);
  const at = nowIso();
  let queued = 0, ended = 0;
  for (const w of work) {
    const id = newId("off");
    const res = await db.prepare(`INSERT OR IGNORE INTO offboarding_items (id, user_id, subject_type, subject_id, label, status, created_by, created_at) VALUES (?,?,?,?,?, 'pending', ?, ?)`)
      .bind(id, userId, w.subject_type, w.subject_id, w.label.slice(0, 300), byUserId, at).run();
    if (res.meta.changes !== 1) continue;
    queued++;
    if (mode === "end") { await endWork(db, w.subject_type, w.subject_id, userId); await markResolved(db, id, "ended", byUserId, null); ended++; queued--; }
  }
  return { queued, ended };
}

/** Called when an account is re-enabled: pending items go back to the person (their assignments were never removed). */
export async function restoreOnEnable(db: Db, byUserId: string, userId: string): Promise<number> {
  const res = await db.prepare(`UPDATE offboarding_items SET status = 'restored', resolved_by = ?, resolved_at = ? WHERE user_id = ? AND status = 'pending'`).bind(byUserId, nowIso(), userId).run();
  return res.meta.changes;
}

export async function listItems(db: Db, userId: string): Promise<OffboardingItem[]> {
  return (await db.prepare(`SELECT i.id, i.user_id, i.subject_type, i.subject_id, i.label, i.status, i.created_at, i.resolved_at, i.resolved_to_user_id, u.display_name AS resolved_to_name
      FROM offboarding_items i LEFT JOIN users u ON u.id = i.resolved_to_user_id WHERE i.user_id = ? ORDER BY CASE i.status WHEN 'pending' THEN 0 ELSE 1 END, i.created_at DESC, i.subject_type, i.label LIMIT 500`)
    .bind(userId).all<OffboardingItem>()).results;
}

export async function pendingCount(db: Db, userId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM offboarding_items WHERE user_id = ? AND status = 'pending'`).bind(userId).first<{ n: number }>())?.n ?? 0;
}

/** Active staff who can take each kind of work (for the reassignment selects). */
export async function eligibleAssignees(db: Db, excludeUserId: string): Promise<{ id: string; display_name: string; role_id: string }[]> {
  return (await db.prepare(`SELECT u.id, u.display_name, m.role_id FROM users u JOIN memberships m ON m.user_id = u.id JOIN organizations o ON o.id = m.organization_id
      WHERE o.kind = 'internal' AND u.disabled_at IS NULL AND u.id <> ? AND m.role_id IN ('owner','administrator','sales','developer','project_manager','support') ORDER BY u.display_name`)
    .bind(excludeUserId).all<{ id: string; display_name: string; role_id: string }>()).results;
}

export const canTake = (subject: OffboardingSubject, role: string) => ELIGIBLE_ROLES[subject].includes(role);

/** "Owner disabled" flags for one record (shown on task, lead and ticket pages). */
export async function disabledOwnerFlag(db: Db, subjectTypes: OffboardingSubject[], subjectId: string): Promise<{ name: string; status: string } | null> {
  return db.prepare(`SELECT u.display_name AS name, i.status FROM offboarding_items i JOIN users u ON u.id = i.user_id
      WHERE i.subject_id = ? AND i.subject_type IN (${subjectTypes.map(() => "?").join(",")}) AND i.status IN ('pending','ended') AND u.disabled_at IS NOT NULL ORDER BY i.created_at DESC LIMIT 1`)
    .bind(subjectId, ...subjectTypes).first<{ name: string; status: string }>();
}

async function markResolved(db: Db, itemId: string, status: "reassigned" | "ended", byUserId: string, toUserId: string | null) {
  await db.prepare(`UPDATE offboarding_items SET status = ?, resolved_by = ?, resolved_to_user_id = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`).bind(status, byUserId, toUserId, nowIso(), itemId).run();
}

async function endWork(db: Db, type: OffboardingSubject, subjectId: string, userId: string) {
  const at = nowIso();
  if (type === "task" || type === "project" || type === "ticket") {
    await db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = ? AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(at, type, subjectId, userId).run();
  } else if (type === "project_manager") {
    await db.prepare(`UPDATE projects SET project_manager_id = NULL, updated_at = ? WHERE id = ? AND project_manager_id = ?`).bind(at, subjectId, userId).run();
  } else if (type === "lead") {
    await db.batch([
      db.prepare(`UPDATE leads SET owner_user_id = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?`).bind(at, subjectId, userId),
      db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = 'lead' AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(at, subjectId, userId),
    ]);
  }
}

async function moveWork(db: Db, type: OffboardingSubject, subjectId: string, fromUserId: string, toUserId: string, byUserId: string) {
  const at = nowIso();
  if (type === "task" || type === "project" || type === "ticket") {
    const already = await db.prepare(`SELECT 1 FROM assignments WHERE subject_type = ? AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(type, subjectId, toUserId).first();
    await db.batch([
      db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = ? AND subject_id = ? AND user_id = ? AND ended_at IS NULL`).bind(at, type, subjectId, fromUserId),
      ...(already ? [] : [db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("asg"), type, subjectId, toUserId, byUserId, at)]),
    ]);
  } else if (type === "project_manager") {
    await db.prepare(`UPDATE projects SET project_manager_id = ?, updated_at = ? WHERE id = ?`).bind(toUserId, at, subjectId).run();
  } else if (type === "lead") {
    await db.batch([
      db.prepare(`UPDATE leads SET owner_user_id = ?, updated_at = ? WHERE id = ?`).bind(toUserId, at, subjectId),
      db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = 'lead' AND subject_id = ? AND ended_at IS NULL`).bind(at, subjectId),
      db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?, 'lead', ?, ?, ?, ?)`).bind(newId("asg"), subjectId, toUserId, byUserId, at),
    ]);
  }
  const notifyType = type === "project_manager" ? "project" : type;
  await notify(db, toUserId, { kind: "assignment", subjectType: notifyType, subjectId, body: `${SUBJECT_LABELS[type]} handed over to you from a disabled account.` });
}

/**
 * Resolves pending queue items for `userId`: `itemIds` (or "all"), by reassigning to `toUserId` or ending them.
 * Items whose new owner cannot take that kind of work are skipped and reported.
 */
export async function resolveItems(db: Db, byUserId: string, userId: string, itemIds: string[] | "all", action: "reassign" | "end", toUserId: string | null, ip: string | null = null): Promise<{ done: number; skipped: string[] }> {
  if (action !== "reassign" && action !== "end") throw new OffboardingError("Choose reassign or end.");
  const pending = (await listItems(db, userId)).filter((i) => i.status === "pending" && (itemIds === "all" || itemIds.includes(i.id)));
  if (!pending.length) throw new OffboardingError("Nothing selected is waiting in the queue.", 404);
  let target: { id: string; display_name: string; role_id: string } | undefined;
  if (action === "reassign") {
    if (!toUserId) throw new OffboardingError("Choose who takes over the work.");
    target = (await eligibleAssignees(db, userId)).find((u) => u.id === toUserId);
    if (!target) throw new OffboardingError("Choose an active staff member.");
  }
  let done = 0;
  const skipped: string[] = [];
  for (const i of pending) {
    if (target && !canTake(i.subject_type, target.role_id)) { skipped.push(`${SUBJECT_LABELS[i.subject_type]}: ${i.label}`); continue; }
    if (target) await moveWork(db, i.subject_type, i.subject_id, userId, target.id, byUserId);
    else await endWork(db, i.subject_type, i.subject_id, userId);
    await markResolved(db, i.id, target ? "reassigned" : "ended", byUserId, target?.id ?? null);
    done++;
  }
  await audit(db, { actorUserId: byUserId, action: "offboarding.resolved", subjectType: "user", subjectId: userId, ip,
    details: { action, to: target?.id ?? null, items: pending.map((i) => ({ id: i.id, type: i.subject_type, subject: i.subject_id })).slice(0, 100), done, skipped: skipped.length } });
  return { done, skipped };
}
