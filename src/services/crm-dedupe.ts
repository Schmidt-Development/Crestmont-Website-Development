// CRM duplicate detection and merge (CRM-002, CRM-005).
// Duplicates are leads whose contacts share a normalized email, a normalized phone number, or the
// same name at the same company. Detection respects the actor's lead visibility (leadScope). A merge
// keeps both rows: the surviving lead receives the other lead's activities, quotes, orders and calls,
// blank contact fields are filled (never overwritten), and the merged lead is archived with
// merged_into_lead_id set. Every merge and every "not a duplicate" decision is audited.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { can, type Actor } from "../domain/authz.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import { getLead, leadScope, type LeadRow } from "./crm.ts";

export type DuplicateReason = "email" | "phone" | "name_company";

export interface DupLead {
  id: string; stage: string; source: string; created_at: string; updated_at: string; owner_user_id: string | null; owner_name: string | null;
  contact_name: string; contact_email: string | null; contact_phone: string | null; company_name: string | null;
}
export interface DuplicateCluster { leads: DupLead[]; reasons: DuplicateReason[]; survivorId: string }

export const normEmail = (s: string | null | undefined) => (s ?? "").trim().toLowerCase() || null;
export function normPhone(s: string | null | undefined): string | null {
  let d = (s ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 7 ? d : null;
}
const normText = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ") || null;

function keysOf(l: DupLead): [DuplicateReason, string][] {
  const out: [DuplicateReason, string][] = [];
  const e = normEmail(l.contact_email); if (e) out.push(["email", e]);
  const p = normPhone(l.contact_phone); if (p) out.push(["phone", p]);
  const n = normText(l.contact_name), c = normText(l.company_name);
  if (n && c) out.push(["name_company", `${n}|${c}`]);
  return out;
}

/** Stage order used to pick the suggested survivor: the most advanced lead keeps its record. */
const STAGE_RANK: Record<string, number> = { converted: 9, awaiting_payment: 8, accepted: 7, negotiation: 6, quote_sent: 5, quote_required: 4, qualified: 3, new: 2, lost: 1, rejected: 1, archived: 0 };
export function suggestSurvivor(leads: DupLead[]): DupLead {
  return [...leads].sort((a, b) => (STAGE_RANK[b.stage] ?? 0) - (STAGE_RANK[a.stage] ?? 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

async function candidates(db: Db, actor: Actor): Promise<DupLead[]> {
  const scope = leadScope(actor);
  return (await db.prepare(`SELECT l.id, l.stage, l.source, l.created_at, l.updated_at, l.owner_user_id, u.display_name AS owner_name,
      c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, co.name AS company_name
    FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = l.owner_user_id
    WHERE ${scope.sql} AND l.merged_into_lead_id IS NULL ORDER BY l.created_at LIMIT 20000`).bind(...scope.binds).all<DupLead>()).results;
}

async function dismissedPairs(db: Db): Promise<Set<string>> {
  return new Set((await db.prepare(`SELECT lead_a, lead_b FROM crm_duplicate_dismissals`).all<{ lead_a: string; lead_b: string }>()).results.map((r) => pairKey(r.lead_a, r.lead_b)));
}

/** Groups visible, unmerged leads into duplicate clusters (connected by any shared key, minus dismissed pairs). */
export async function findDuplicateClusters(db: Db, actor: Actor): Promise<DuplicateCluster[]> {
  const leads = await candidates(db, actor);
  const dismissed = await dismissedPairs(db);
  const byKey = new Map<string, DupLead[]>();
  for (const l of leads) for (const [r, k] of keysOf(l)) { const key = `${r}:${k}`; byKey.set(key, [...(byKey.get(key) ?? []), l]); }
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (const l of leads) parent.set(l.id, l.id);
  const edgeReasons = new Map<string, Set<DuplicateReason>>();
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const reason = key.slice(0, key.indexOf(":")) as DuplicateReason;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const pk = pairKey(group[i].id, group[j].id);
      if (dismissed.has(pk)) continue;
      edgeReasons.set(pk, new Set([...(edgeReasons.get(pk) ?? []), reason]));
      parent.set(find(group[i].id), find(group[j].id));
    }
  }
  const clusters = new Map<string, DupLead[]>();
  for (const l of leads) {
    const root = find(l.id);
    clusters.set(root, [...(clusters.get(root) ?? []), l]);
  }
  const out: DuplicateCluster[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const ids = new Set(members.map((m) => m.id));
    const reasons = new Set<DuplicateReason>();
    for (const [pk, rs] of edgeReasons) { const [a, b] = pk.split("|"); if (ids.has(a) && ids.has(b)) rs.forEach((r) => reasons.add(r)); }
    out.push({ leads: members, reasons: [...reasons].sort(), survivorId: suggestSurvivor(members).id });
  }
  return out.sort((a, b) => b.leads.length - a.leads.length || a.leads[0].created_at.localeCompare(b.leads[0].created_at));
}

/** Possible duplicates of one lead (shared key, visible to the actor, not merged, not dismissed). */
export async function duplicatesOf(db: Db, actor: Actor, lead: LeadRow): Promise<(DupLead & { reasons: DuplicateReason[] })[]> {
  const mine = keysOf({ ...lead, contact_name: lead.contact_name, company_name: lead.company_name } as DupLead);
  if (!mine.length) return [];
  const dismissed = await dismissedPairs(db);
  const out: (DupLead & { reasons: DuplicateReason[] })[] = [];
  for (const l of await candidates(db, actor)) {
    if (l.id === lead.id || dismissed.has(pairKey(l.id, lead.id))) continue;
    const theirs = new Map(keysOf(l));
    const reasons = mine.filter(([r, k]) => theirs.get(r) === k).map(([r]) => r);
    if (reasons.length) out.push({ ...l, reasons });
  }
  return out;
}

export class MergeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function assertCanWrite(actor: Actor, lead: LeadRow) {
  if (can(actor, "lead.write_all")) return;
  if (can(actor, "lead.write_assigned") && lead.owner_user_id === actor.userId) return;
  throw new HttpError(403, "You can only merge leads you are allowed to edit.");
}

/** Merges `sourceId` into `targetId`. Returns the number of moved records per kind. */
export async function mergeLeads(db: Db, actor: Actor, sourceId: string, targetId: string, opts: { ip?: string | null } = {}) {
  if (sourceId === targetId) throw new MergeError(422, "Choose two different leads to merge.");
  const source = await getLead(db, actor, sourceId);
  const target = await getLead(db, actor, targetId);
  assertCanWrite(actor, source);
  assertCanWrite(actor, target);
  const flags = await db.prepare(`SELECT id, merged_into_lead_id FROM leads WHERE id IN (?, ?)`).bind(sourceId, targetId).all<{ id: string; merged_into_lead_id: string | null }>();
  if (flags.results.some((f) => f.merged_into_lead_id)) throw new MergeError(409, "One of these leads has already been merged.");
  if (source.stage === "converted" && target.stage !== "converted") throw new MergeError(409, "The lead being merged away is converted. Merge in the other direction so the converted lead survives.");
  const count = async (sql: string) => (await db.prepare(sql).bind(sourceId).first<{ n: number }>())?.n ?? 0;
  const moved = {
    activities: await count(`SELECT COUNT(*) AS n FROM crm_activities WHERE lead_id = ?`),
    quotes: await count(`SELECT COUNT(*) AS n FROM quotes WHERE lead_id = ?`),
    orders: await count(`SELECT COUNT(*) AS n FROM orders WHERE lead_id = ?`),
    calls: await count(`SELECT COUNT(*) AS n FROM calls WHERE lead_id = ?`),
  };
  const at = nowIso();
  const fill: string[] = [];
  const stmts = [
    db.prepare(`UPDATE crm_activities SET lead_id = ? WHERE lead_id = ?`).bind(targetId, sourceId),
    db.prepare(`UPDATE quotes SET lead_id = ? WHERE lead_id = ?`).bind(targetId, sourceId),
    db.prepare(`UPDATE orders SET lead_id = ? WHERE lead_id = ?`).bind(targetId, sourceId),
    db.prepare(`UPDATE calls SET lead_id = ? WHERE lead_id = ?`).bind(targetId, sourceId),
    db.prepare(`UPDATE lead_request_details SET lead_id = ? WHERE lead_id = ? AND NOT EXISTS (SELECT 1 FROM lead_request_details WHERE lead_id = ?)`).bind(targetId, sourceId, targetId),
    db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = 'lead' AND subject_id = ? AND ended_at IS NULL`).bind(at, sourceId),
  ];
  if (source.contact_id !== target.contact_id) {
    if (!target.contact_email && source.contact_email) fill.push("email");
    if (!target.contact_phone && source.contact_phone) fill.push("phone");
    stmts.push(db.prepare(`UPDATE contacts SET email = COALESCE(email, ?), phone = COALESCE(phone, ?), user_id = COALESCE(user_id, ?), company_id = COALESCE(company_id, ?) WHERE id = ?`)
      .bind(source.contact_email, source.contact_phone, source.contact_user_id, source.company_id, target.contact_id));
    if (!target.company_id && source.company_id) fill.push("company");
  }
  const notes = [target.qualification_notes, source.qualification_notes ? `Merged from ${source.id}:\n${source.qualification_notes}` : null].filter(Boolean).join("\n\n").slice(0, 5000) || null;
  stmts.push(
    db.prepare(`UPDATE leads SET qualification_notes = ?, interest = COALESCE(interest, ?), message = COALESCE(message, ?), owner_user_id = COALESCE(owner_user_id, ?),
      utm_source = COALESCE(utm_source, ?), utm_medium = COALESCE(utm_medium, ?), utm_campaign = COALESCE(utm_campaign, ?), updated_at = ? WHERE id = ?`)
      .bind(notes, source.interest, source.message, source.owner_user_id, source.utm_source, source.utm_medium, source.utm_campaign, at, targetId),
    db.prepare(`UPDATE leads SET stage = 'archived', lost_reason = ?, merged_into_lead_id = ?, merged_at = ?, updated_at = ? WHERE id = ? AND merged_into_lead_id IS NULL`)
      .bind(`Merged into ${targetId}`, targetId, at, at, sourceId),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'system',?,?)`)
      .bind(newId("act"), targetId, actor.userId ?? null, `Merged duplicate lead ${sourceId} (${source.contact_name}, ${label(source.stage)}): moved ${moved.activities} activities, ${moved.quotes} quotes, ${moved.orders} orders, ${moved.calls} calls${fill.length ? `; filled ${fill.join(", ")}` : ""}.`, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'system',?,?)`)
      .bind(newId("act"), sourceId, actor.userId ?? null, `Merged into lead ${targetId}; this record is archived and kept for history.`, at),
  );
  const res = await db.batch(stmts);
  if (res[res.length - 3].meta.changes !== 1) throw new MergeError(409, "The lead changed while you were merging. Reload and try again.");
  await audit(db, { actorUserId: actor.userId, action: "lead.merged", subjectType: "lead", subjectId: targetId, ip: opts.ip ?? null, details: { merged: sourceId, fromStage: source.stage, moved, filled: fill } });
  return moved;
}

function label(s: string) { return s.replace(/_/g, " "); }

/** Records that two leads are not duplicates, so detection stops pairing them. */
export async function dismissPair(db: Db, actor: Actor, a: string, b: string, opts: { ip?: string | null } = {}) {
  if (a === b) throw new MergeError(422, "Choose two different leads.");
  const la = await getLead(db, actor, a), lb = await getLead(db, actor, b);
  assertCanWrite(actor, la); assertCanWrite(actor, lb);
  const [x, y] = a < b ? [a, b] : [b, a];
  await db.prepare(`INSERT OR IGNORE INTO crm_duplicate_dismissals (lead_a, lead_b, dismissed_by, created_at) VALUES (?,?,?,?)`).bind(x, y, actor.userId ?? null, nowIso()).run();
  await audit(db, { actorUserId: actor.userId, action: "lead.duplicate_dismissed", subjectType: "lead", subjectId: x, ip: opts.ip ?? null, details: { other: y } });
}
