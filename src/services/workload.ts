// Employee workload (EMP-001, EMP-003): per-person open work and capacity, derived from assignments,
// tasks, time entries, leads and tickets. Capacity comes from staff_profiles; when it is not set the
// utilisation is "Unknown", never 0%.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { listStaff, type StaffRow } from "./employees.ts";

export interface Workload {
  userId: string;
  openTasks: number; overdueTasks: number; dueNext7: number; blockedTasks: number;
  openEstimateMinutes: number; unestimatedTasks: number;
  activeProjects: number; openLeads: number; openTickets: number;
  loggedLast7Minutes: number; loggedLast30Minutes: number;
  weeklyCapacityMinutes: number | null; jobTitle: string | null;
  /** Logged minutes in the last 7 days ÷ weekly capacity, or null when capacity is not set. */
  utilisation: number | null;
}

export async function workloadFor(db: Db, userId: string, now: Date): Promise<Workload> {
  const today = now.toISOString().slice(0, 10);
  const in7 = new Date(now.getTime() + 7 * 86400e3).toISOString().slice(0, 10);
  const ago7 = new Date(now.getTime() - 7 * 86400e3).toISOString().slice(0, 10);
  const ago30 = new Date(now.getTime() - 30 * 86400e3).toISOString().slice(0, 10);
  const t = await db.prepare(`SELECT COUNT(*) AS open,
      SUM(CASE WHEN t.due_at IS NOT NULL AND substr(t.due_at,1,10) < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN t.due_at IS NOT NULL AND substr(t.due_at,1,10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS due7,
      SUM(CASE WHEN t.status = 'blocked' OR EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id AND dt.status <> 'done') THEN 1 ELSE 0 END) AS blocked,
      COALESCE(SUM(t.estimate_minutes),0) AS est, SUM(CASE WHEN t.estimate_minutes IS NULL THEN 1 ELSE 0 END) AS unest
    FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND a.user_id = ? AND a.ended_at IS NULL AND t.status <> 'done'`)
    .bind(today, today, in7, userId).first<{ open: number; overdue: number | null; due7: number | null; blocked: number | null; est: number; unest: number | null }>();
  const projects = await db.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE p.status NOT IN ('completed','maintenance','cancelled') AND (p.project_manager_id = ?1
      OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ?1 AND a.ended_at IS NULL)
      OR EXISTS (SELECT 1 FROM assignments a JOIN tasks tt ON tt.id = a.subject_id WHERE a.subject_type = 'task' AND tt.project_id = p.id AND a.user_id = ?1 AND a.ended_at IS NULL AND tt.status <> 'done'))`)
    .bind(userId).first<{ n: number }>();
  const leads = await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE owner_user_id = ? AND merged_into_lead_id IS NULL AND stage NOT IN ('converted','lost','rejected','archived')`).bind(userId).first<{ n: number }>();
  const tickets = await db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN tickets t ON t.id = a.subject_id WHERE a.subject_type = 'ticket' AND a.user_id = ? AND a.ended_at IS NULL AND t.status NOT IN ('resolved','closed')`).bind(userId).first<{ n: number }>();
  const logged = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN worked_on >= ? THEN minutes ELSE 0 END),0) AS m7, COALESCE(SUM(minutes),0) AS m30 FROM time_entries WHERE user_id = ? AND worked_on >= ?`).bind(ago7, userId, ago30).first<{ m7: number; m30: number }>();
  const prof = await db.prepare(`SELECT job_title, weekly_capacity_minutes FROM staff_profiles WHERE user_id = ?`).bind(userId).first<{ job_title: string | null; weekly_capacity_minutes: number | null }>();
  const cap = prof?.weekly_capacity_minutes ?? null;
  const m7 = logged?.m7 ?? 0;
  return {
    userId, openTasks: t?.open ?? 0, overdueTasks: t?.overdue ?? 0, dueNext7: t?.due7 ?? 0, blockedTasks: t?.blocked ?? 0,
    openEstimateMinutes: t?.est ?? 0, unestimatedTasks: t?.unest ?? 0,
    activeProjects: projects?.n ?? 0, openLeads: leads?.n ?? 0, openTickets: tickets?.n ?? 0,
    loggedLast7Minutes: m7, loggedLast30Minutes: logged?.m30 ?? 0,
    weeklyCapacityMinutes: cap, jobTitle: prof?.job_title ?? null, utilisation: cap ? m7 / cap : null,
  };
}

export async function teamWorkload(db: Db, now: Date): Promise<(StaffRow & { w: Workload })[]> {
  const staff = await listStaff(db, now.toISOString());
  const out: (StaffRow & { w: Workload })[] = [];
  for (const s of staff) out.push({ ...s, w: await workloadFor(db, s.id, now) });
  return out;
}

export const hours = (m: number) => `${(m / 60).toFixed(1)} h`;
export const utilisationText = (w: Workload) => (w.utilisation === null ? "Unknown (capacity not set)" : `${Math.round(w.utilisation * 100)}%`);

export class ProfileError extends Error {}

export async function saveProfile(db: Db, byUserId: string, userId: string, input: { jobTitle: string; weeklyCapacityHours: string }): Promise<void> {
  const title = input.jobTitle.trim();
  if (title.length > 120) throw new ProfileError("Job title must be 120 characters or fewer.");
  let minutes: number | null = null;
  if (input.weeklyCapacityHours.trim()) {
    const h = Number(input.weeklyCapacityHours);
    if (!Number.isFinite(h) || h < 0 || h > 100 || Math.round(h * 4) !== h * 4) throw new ProfileError("Weekly capacity must be between 0 and 100 hours, in quarter hours.");
    minutes = Math.round(h * 60);
  }
  const staff = await db.prepare(`SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND o.kind = 'internal'`).bind(userId).first();
  if (!staff) throw new ProfileError("Not a staff member.");
  const before = await db.prepare(`SELECT job_title, weekly_capacity_minutes FROM staff_profiles WHERE user_id = ?`).bind(userId).first<{ job_title: string | null; weekly_capacity_minutes: number | null }>();
  await db.prepare(`INSERT INTO staff_profiles (user_id, job_title, weekly_capacity_minutes, updated_by, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET job_title = excluded.job_title, weekly_capacity_minutes = excluded.weekly_capacity_minutes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(userId, title || null, minutes, byUserId, nowIso()).run();
  await audit(db, { actorUserId: byUserId, action: "employee.profile_updated", subjectType: "user", subjectId: userId, details: { from: before ?? null, to: { job_title: title || null, weekly_capacity_minutes: minutes } } });
}
