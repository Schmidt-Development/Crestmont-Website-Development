// Small helpers shared by the voice service, the Retell adapter and outbound calling.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";

/** In-app notification to every active Owner (the platform's existing notifications table). */
export async function notifyOwners(db: Db, kind: string, body: string, subjectType: string, subjectId: string): Promise<number> {
  const owners = (await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id IN ('owner') AND u.disabled_at IS NULL`).all<{ user_id: string }>()).results;
  for (const o of owners) {
    await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("ntf"), o.user_id, kind, subjectType, subjectId, body.slice(0, 500), nowIso()).run();
  }
  return owners.length;
}

/** CRM follow-up task on a lead, due in `dueHours`. */
export async function addLeadTask(db: Db, leadId: string, body: string, dueHours = 24): Promise<void> {
  await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, due_at, created_at) VALUES (?,?,'task',?,?,?)`)
    .bind(newId("act"), leadId, body.slice(0, 2000), new Date(Date.now() + dueHours * 3600e3).toISOString(), nowIso()).run();
}

export async function addLeadNote(db: Db, leadId: string, body: string): Promise<void> {
  await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'call',?,?)`).bind(newId("act"), leadId, body.slice(0, 4000), nowIso()).run();
}

/**
 * Removes payment-card numbers (Luhn-valid 13–19 digits, any separators) and US SSNs from free text before
 * it is stored. Callers are told never to read card details to the agent; this catches it when they do.
 */
export function redactSensitive(text: string): string {
  const luhn = (d: string) => {
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
    return sum % 10 === 0;
  };
  return text
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number removed]" : m))
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN removed]");
}
