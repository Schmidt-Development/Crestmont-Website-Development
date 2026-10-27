// CRM read/write services (CRM-002, CRM-004, CRM-005, CRM-006). Record-level visibility:
// staff with lead.read_all see every lead; sales with lead.read_assigned see only leads they own.
// Stage changes always go through changeLeadStage (src/services/leads.ts), which enforces
// assignment and the validated pipeline.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { can, type Actor } from "../domain/authz.ts";
import { LEAD_STAGES, type LeadStage } from "../domain/crm.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import type { DateRange } from "./finance.ts";

export const LEAD_SOURCES = ["web_form", "quote_form", "ai_receptionist", "referral", "manual", "checkout"] as const;

export interface LeadRow {
  id: string; stage: LeadStage; source: string; interest: string | null; message: string | null; owner_user_id: string | null; owner_name: string | null;
  qualification_notes: string | null; lost_reason: string | null; created_at: string; updated_at: string;
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; utm_term: string | null; utm_content: string | null; referrer: string | null; landing_page: string | null;
  contact_id: string; contact_name: string; contact_email: string | null; contact_phone: string | null; contact_user_id: string | null;
  company_id: string | null; company_name: string | null; company_website: string | null; company_organization_id: string | null;
}

const LEAD_SELECT = `SELECT l.id, l.stage, l.source, l.interest, l.message, l.owner_user_id, u.display_name AS owner_name, l.qualification_notes, l.lost_reason, l.created_at, l.updated_at,
  l.utm_source, l.utm_medium, l.utm_campaign, l.utm_term, l.utm_content, l.referrer, l.landing_page,
  c.id AS contact_id, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, c.user_id AS contact_user_id,
  co.id AS company_id, co.name AS company_name, co.website AS company_website, co.organization_id AS company_organization_id
  FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = l.owner_user_id`;

/** Visibility predicate for the current actor. Returns SQL + binds, or throws 403. */
export function leadScope(actor: Actor): { sql: string; binds: unknown[] } {
  if (can(actor, "lead.read_all")) return { sql: "1=1", binds: [] };
  if (can(actor, "lead.read_assigned")) return { sql: "l.owner_user_id = ?", binds: [actor.userId ?? "-"] };
  throw new HttpError(403, "You do not have access to leads.");
}

export interface LeadFilter { q?: string; stage?: string; source?: string; owner?: string; from?: string; to?: string }

function filterSql(actor: Actor, f: LeadFilter): { where: string; binds: unknown[] } {
  const scope = leadScope(actor);
  const conds = [scope.sql];
  const binds = [...scope.binds];
  if (f.q) {
    conds.push(`(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')`);
    const like = `%${f.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    binds.push(like, like, like);
  }
  if (f.stage && (LEAD_STAGES as readonly string[]).includes(f.stage)) { conds.push(`l.stage = ?`); binds.push(f.stage); }
  if (f.source && (LEAD_SOURCES as readonly string[]).includes(f.source)) { conds.push(`l.source = ?`); binds.push(f.source); }
  if (f.owner === "unassigned") conds.push(`l.owner_user_id IS NULL`);
  else if (f.owner) { conds.push(`l.owner_user_id = ?`); binds.push(f.owner); }
  // Only real calendar days are applied (2026-13-45 matches the pattern but is not a date).
  const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString().startsWith(s);
  if (isDay(f.from)) { conds.push(`l.created_at >= ?`); binds.push(`${f.from}T00:00:00.000Z`); }
  if (isDay(f.to)) { conds.push(`l.created_at < ?`); binds.push(new Date(Date.parse(f.to) + 86400e3).toISOString()); }
  return { where: conds.join(" AND "), binds };
}

export async function listLeads(db: Db, actor: Actor, f: LeadFilter, page: { limit: number; offset: number }): Promise<LeadRow[]> {
  const { where, binds } = filterSql(actor, f);
  return (await db.prepare(`${LEAD_SELECT} WHERE ${where} ORDER BY l.updated_at DESC, l.id LIMIT ? OFFSET ?`).bind(...binds, page.limit, page.offset).all<LeadRow>()).results;
}

export async function stageCounts(db: Db, actor: Actor, f: LeadFilter): Promise<Record<string, number>> {
  const { where, binds } = filterSql(actor, f);
  const rows = (await db.prepare(`SELECT l.stage, COUNT(*) AS n FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE ${where} GROUP BY l.stage`).bind(...binds).all<{ stage: string; n: number }>()).results;
  return Object.fromEntries(rows.map((r) => [r.stage, r.n]));
}

export async function getLead(db: Db, actor: Actor, id: string): Promise<LeadRow> {
  const scope = leadScope(actor);
  const row = await db.prepare(`${LEAD_SELECT} WHERE l.id = ? AND ${scope.sql}`).bind(id, ...scope.binds).first<LeadRow>();
  if (!row) {
    // Do not distinguish "exists but not yours" from "missing" for assigned-only users.
    throw new HttpError(404, "Lead not found.");
  }
  return row;
}

function assertCanWrite(actor: Actor, lead: LeadRow) {
  if (can(actor, "lead.write_all")) return;
  if (can(actor, "lead.write_assigned") && lead.owner_user_id === actor.userId) return;
  throw new HttpError(403, "This lead is not assigned to you.");
}

export async function createManualLead(db: Db, actor: Actor, input: { name: string; email: string; phone: string; company: string; website: string; interest: string; message: string; source: string }) {
  const issues: string[] = [];
  if (input.name.length < 2 || input.name.length > 120) issues.push("Enter the contact's name");
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.email)) issues.push("Enter a valid email address");
  if (!input.email && !input.phone) issues.push("Enter an email or phone number");
  if (input.phone && !/^[+0-9 ().-]{7,40}$/.test(input.phone)) issues.push("Enter a valid phone number");
  if (input.website && !/^https?:\/\/[^\s]+$/.test(input.website)) issues.push("Website must start with http:// or https://");
  if (!["manual", "referral"].includes(input.source)) issues.push("Source must be manual or referral");
  if (!["starter", "business", "premium", "custom", "maintenance", "other"].includes(input.interest)) issues.push("Choose what they are interested in");
  if (input.message.length > 5000) issues.push("Notes are too long");
  if (input.company.length > 160) issues.push("Company name is too long");
  if (issues.length) return { ok: false as const, issues };
  const at = nowIso();
  const companyId = input.company ? newId("co") : null, contactId = newId("ct"), leadId = newId("ld");
  // Sales reps own the leads they enter so they can keep working them.
  const owner = can(actor, "lead.write_all") ? null : actor.userId ?? null;
  await db.batch([
    ...(companyId ? [db.prepare(`INSERT INTO companies (id, name, website, created_at) VALUES (?,?,?,?)`).bind(companyId, input.company, input.website || null, at)] : []),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, user_id, created_at) VALUES (?,?,?,?,?,(SELECT id FROM users WHERE email = ?),?)`)
      .bind(contactId, companyId, input.name, input.email ? input.email.toLowerCase() : null, input.phone || null, input.email.toLowerCase(), at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, owner_user_id, interest, message, created_at, updated_at) VALUES (?,?,?,'new',?,?,?,?,?)`)
      .bind(leadId, contactId, input.source, owner, input.interest, input.message || null, at, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'system',?,?)`).bind(newId("act"), leadId, actor.userId ?? null, `Lead entered manually (source: ${input.source})`, at),
  ]);
  await audit(db, { actorUserId: actor.userId, action: "lead.created", subjectType: "lead", subjectId: leadId, details: { source: input.source } });
  return { ok: true as const, leadId };
}

export async function updateContact(db: Db, actor: Actor, lead: LeadRow, input: { name: string; email: string; phone: string; company: string; website: string; qualificationNotes: string }) {
  assertCanWrite(actor, lead);
  const issues: string[] = [];
  if (input.name.length < 2 || input.name.length > 120) issues.push("Enter the contact's name");
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.email)) issues.push("Enter a valid email address");
  if (input.phone && !/^[+0-9 ().-]{7,40}$/.test(input.phone)) issues.push("Enter a valid phone number");
  if (input.website && !/^https?:\/\/[^\s]+$/.test(input.website)) issues.push("Website must start with http:// or https://");
  if (input.qualificationNotes.length > 5000) issues.push("Qualification notes are too long");
  if (issues.length) return { ok: false as const, issues };
  const at = nowIso();
  const stmts = [
    db.prepare(`UPDATE contacts SET name = ?, email = ?, phone = ? WHERE id = ?`).bind(input.name, input.email ? input.email.toLowerCase() : null, input.phone || null, lead.contact_id),
    db.prepare(`UPDATE leads SET qualification_notes = ?, updated_at = ? WHERE id = ?`).bind(input.qualificationNotes || null, at, lead.id),
  ];
  if (lead.company_id) stmts.push(db.prepare(`UPDATE companies SET name = ?, website = ? WHERE id = ?`).bind(input.company || lead.company_name, input.website || null, lead.company_id));
  else if (input.company) {
    const co = newId("co");
    stmts.push(db.prepare(`INSERT INTO companies (id, name, website, created_at) VALUES (?,?,?,?)`).bind(co, input.company, input.website || null, at));
    stmts.push(db.prepare(`UPDATE contacts SET company_id = ? WHERE id = ?`).bind(co, lead.contact_id));
  }
  await db.batch(stmts);
  await audit(db, { actorUserId: actor.userId, action: "lead.contact_updated", subjectType: "lead", subjectId: lead.id });
  return { ok: true as const };
}

export async function addNote(db: Db, actor: Actor, lead: LeadRow, body: string, kind: "note" | "call" | "email" = "note") {
  assertCanWrite(actor, lead);
  if (body.length < 1 || body.length > 5000) return { ok: false as const, issues: ["Enter a note (up to 5000 characters)"] };
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("act"), lead.id, actor.userId ?? null, kind, body, at),
    db.prepare(`UPDATE leads SET updated_at = ? WHERE id = ?`).bind(at, lead.id),
  ]);
  return { ok: true as const };
}

export async function addTask(db: Db, actor: Actor, lead: LeadRow, body: string, due: string) {
  assertCanWrite(actor, lead);
  const issues: string[] = [];
  if (body.length < 2 || body.length > 500) issues.push("Describe the follow-up (2–500 characters)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) issues.push("Choose a due date");
  if (issues.length) return { ok: false as const, issues };
  await db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, due_at, created_at) VALUES (?,?,?,'task',?,?,?)`)
    .bind(newId("act"), lead.id, actor.userId ?? null, body, `${due}T17:00:00.000Z`, nowIso()).run();
  return { ok: true as const };
}

export async function completeTask(db: Db, actor: Actor, lead: LeadRow, activityId: string) {
  assertCanWrite(actor, lead);
  const res = await db.prepare(`UPDATE crm_activities SET completed_at = ? WHERE id = ? AND lead_id = ? AND kind = 'task' AND completed_at IS NULL`).bind(nowIso(), activityId, lead.id).run();
  if (res.meta.changes !== 1) throw new HttpError(409, "That task is already complete or does not exist.");
  await audit(db, { actorUserId: actor.userId, action: "lead.task_completed", subjectType: "lead", subjectId: lead.id, details: { activityId } });
}

export async function assignOwner(db: Db, actor: Actor, leadId: string, userId: string | null) {
  if (!can(actor, "lead.assign")) throw new HttpError(403, "You cannot assign leads.");
  if (userId) {
    const ok = await db.prepare(`SELECT 1 AS ok FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.role_id IN ('owner','administrator','sales') AND u.disabled_at IS NULL`).bind(userId).first();
    if (!ok) throw new HttpError(400, "Leads can only be assigned to active sales staff.");
  }
  const at = nowIso();
  const lead = await db.prepare(`SELECT owner_user_id FROM leads WHERE id = ?`).bind(leadId).first<{ owner_user_id: string | null }>();
  if (!lead) throw new HttpError(404, "Lead not found.");
  await db.batch([
    db.prepare(`UPDATE leads SET owner_user_id = ?, updated_at = ? WHERE id = ?`).bind(userId, at, leadId),
    db.prepare(`UPDATE assignments SET ended_at = ? WHERE subject_type = 'lead' AND subject_id = ? AND ended_at IS NULL`).bind(at, leadId),
    ...(userId ? [db.prepare(`INSERT INTO assignments (id, subject_type, subject_id, user_id, assigned_by, created_at) VALUES (?, 'lead', ?, ?, ?, ?)`).bind(newId("asg"), leadId, userId, actor.userId ?? null, at)] : []),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'system',?,?)`)
      .bind(newId("act"), leadId, actor.userId ?? null, userId ? `Lead assigned to ${(await db.prepare(`SELECT display_name FROM users WHERE id = ?`).bind(userId).first<{ display_name: string }>())?.display_name ?? userId}` : "Lead unassigned", at),
  ]);
  await audit(db, { actorUserId: actor.userId, action: "lead.assigned", subjectType: "lead", subjectId: leadId, details: { from: lead.owner_user_id, to: userId } });
  if (userId && userId !== actor.userId) {
    await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("ntf"), userId, "lead_assigned", "lead", leadId, "A lead was assigned to you.", at).run();
  }
}

export async function salesStaff(db: Db) {
  return (await db.prepare(`SELECT DISTINCT u.id, u.display_name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.role_id IN ('owner','administrator','sales') AND u.disabled_at IS NULL ORDER BY u.display_name`).all<{ id: string; display_name: string }>()).results;
}

export async function activities(db: Db, leadId: string) {
  return (await db.prepare(`SELECT a.id, a.kind, a.body, a.due_at, a.completed_at, a.created_at, u.display_name AS actor FROM crm_activities a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.rowid DESC`)
    .bind(leadId).all<{ id: string; kind: string; body: string; due_at: string | null; completed_at: string | null; created_at: string; actor: string | null }>()).results;
}

/** Customer organization tied to a lead: via the company record or the contact's user membership. */
export async function leadOrganizationId(db: Db, lead: LeadRow): Promise<string | null> {
  if (lead.company_organization_id) return lead.company_organization_id;
  const o = await db.prepare(`SELECT organization_id FROM orders WHERE lead_id = ? LIMIT 1`).bind(lead.id).first<{ organization_id: string }>();
  if (o) return o.organization_id;
  if (lead.contact_user_id) {
    const m = await db.prepare(`SELECT organization_id FROM memberships WHERE user_id = ? AND role_id LIKE 'customer_%' LIMIT 1`).bind(lead.contact_user_id).first<{ organization_id: string }>();
    if (m) return m.organization_id;
  }
  return null;
}

export async function leadLinks(db: Db, lead: LeadRow) {
  const orgId = await leadOrganizationId(db, lead);
  const quotes = (await db.prepare(`SELECT q.id, q.status, q.current_version, q.created_at, qv.total_cents FROM quotes q LEFT JOIN quote_versions qv ON qv.quote_id = q.id AND qv.version = q.current_version WHERE q.lead_id = ? ORDER BY q.created_at DESC`)
    .bind(lead.id).all<{ id: string; status: string; current_version: number; created_at: string; total_cents: number | null }>()).results;
  const orders = (await db.prepare(`SELECT id, status, total_cents, kind, created_at FROM orders WHERE lead_id = ? ${orgId ? "OR organization_id = ?" : ""} ORDER BY created_at DESC`)
    .bind(lead.id, ...(orgId ? [orgId] : [])).all<{ id: string; status: string; total_cents: number; kind: string; created_at: string }>()).results;
  const projects = orgId ? (await db.prepare(`SELECT id, name, status, created_at FROM projects WHERE organization_id = ? ORDER BY created_at DESC`).bind(orgId).all<{ id: string; name: string; status: string; created_at: string }>()).results : [];
  const tickets = orgId ? (await db.prepare(`SELECT id, subject, status, priority, created_at FROM tickets WHERE organization_id = ? ORDER BY created_at DESC LIMIT 20`).bind(orgId).all<{ id: string; subject: string; status: string; priority: string; created_at: string }>()).results : [];
  return { orgId, quotes, orders, projects, tickets };
}

export async function exportLeads(db: Db, actor: Actor, f: LeadFilter): Promise<LeadRow[]> {
  const { where, binds } = filterSql(actor, f);
  return (await db.prepare(`${LEAD_SELECT} WHERE ${where} ORDER BY l.created_at DESC LIMIT 10000`).bind(...binds).all<LeadRow>()).results;
}

// ── customers (CRM-002) ──
export async function listCustomers(db: Db, q: string, page: { limit: number; offset: number }) {
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  return (await db.prepare(`SELECT o.id, o.name, o.created_at,
      (SELECT COUNT(*) FROM orders x WHERE x.organization_id = o.id) AS orders,
      (SELECT COUNT(*) FROM projects x WHERE x.organization_id = o.id) AS projects,
      (SELECT COUNT(*) FROM subscriptions x WHERE x.organization_id = o.id AND x.status IN ('active','trialing','past_due')) AS subscriptions,
      (SELECT COUNT(*) FROM tickets x WHERE x.organization_id = o.id AND x.status NOT IN ('resolved','closed')) AS open_tickets,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments x WHERE x.organization_id = o.id AND x.status IN ('succeeded','partially_refunded','disputed')) AS paid_cents
    FROM organizations o WHERE o.kind = 'customer' ${q ? `AND o.name LIKE ? ESCAPE '\\'` : ""} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...(q ? [like] : []), page.limit + 1, page.offset).all<{ id: string; name: string; created_at: string; orders: number; projects: number; subscriptions: number; open_tickets: number; paid_cents: number }>()).results;
}

export async function customerDetail(db: Db, orgId: string) {
  const org = await db.prepare(`SELECT id, name, created_at, stripe_customer_id FROM organizations WHERE id = ? AND kind = 'customer'`).bind(orgId).first<{ id: string; name: string; created_at: string; stripe_customer_id: string | null }>();
  if (!org) throw new HttpError(404, "Customer not found.");
  const q = <T>(sql: string) => db.prepare(sql).bind(orgId).all<T>().then((r) => r.results);
  return {
    org,
    members: await q<{ display_name: string; email: string; role_id: string }>(`SELECT u.display_name, u.email, m.role_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at`),
    orders: await q<{ id: string; status: string; total_cents: number; kind: string; created_at: string; lead_id: string | null }>(`SELECT id, status, total_cents, kind, created_at, lead_id FROM orders WHERE organization_id = ? ORDER BY created_at DESC`),
    invoices: await q<{ id: string; status: string; amount_cents: number; description: string | null; created_at: string }>(`SELECT id, status, amount_cents, description, created_at FROM invoices WHERE organization_id = ? ORDER BY created_at DESC`),
    projects: await q<{ id: string; name: string; status: string; created_at: string }>(`SELECT id, name, status, created_at FROM projects WHERE organization_id = ? ORDER BY created_at DESC`),
    subscriptions: await q<{ id: string; product_id: string; status: string; current_period_end: string | null }>(`SELECT id, product_id, status, current_period_end FROM subscriptions WHERE organization_id = ? ORDER BY created_at DESC`),
    tickets: await q<{ id: string; subject: string; status: string; created_at: string }>(`SELECT id, subject, status, created_at FROM tickets WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50`),
    leads: await q<{ id: string; stage: string; source: string; created_at: string }>(`SELECT DISTINCT l.id, l.stage, l.source, l.created_at FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id
      LEFT JOIN memberships m ON m.user_id = c.user_id WHERE co.organization_id = ?1 OR m.organization_id = ?1 OR l.id IN (SELECT lead_id FROM orders WHERE organization_id = ?1) ORDER BY l.created_at DESC`),
  };
}

export async function listContacts(db: Db, actor: Actor, q: string, page: { limit: number; offset: number }) {
  const scope = leadScope(actor);
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  return (await db.prepare(`SELECT c.id, c.name, c.email, c.phone, co.name AS company, co.organization_id, c.user_id, COUNT(l.id) AS leads, MAX(l.id) AS last_lead_id, MAX(l.updated_at) AS last_activity
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id JOIN leads l ON l.contact_id = c.id
     WHERE ${scope.sql} ${q ? `AND (c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')` : ""}
     GROUP BY c.id ORDER BY last_activity DESC LIMIT ? OFFSET ?`)
    .bind(...scope.binds, ...(q ? [like, like, like] : []), page.limit + 1, page.offset)
    .all<{ id: string; name: string; email: string | null; phone: string | null; company: string | null; organization_id: string | null; user_id: string | null; leads: number; last_lead_id: string; last_activity: string }>()).results;
}

// ── sales reporting (CRM-006) ──
export const SALES_DEFINITIONS: [string, string][] = [
  ["Leads created", "Leads whose created_at falls in the range (all sources)."],
  ["Converted", "Of those leads, the ones now in stage converted. Conversion is set only by a verified Stripe payment webhook."],
  ["Conversion rate", "Converted ÷ leads created in the range."],
  ["Stage funnel", "Current stage of each lead created in the range."],
  ["Quotes sent", "Quotes whose first send (quotes.sent_at) falls in the range."],
  ["Quotes accepted", "Quote versions accepted (quote_versions.accepted_at) in the range."],
  ["Campaign attribution", "Leads created in the range grouped by the first-party UTM parameters (utm_source / utm_medium / utm_campaign) captured from the landing URL of the visit that submitted a public form. \"(none)\" = no campaign parameters (direct, organic or untagged links, manual entry, receptionist)."],
  ["Revenue by source", "Captured payments in the range on orders linked to a lead (orders.lead_id), grouped by that lead's source. Package checkouts without a lead are shown as \"no lead (direct checkout)\"."],
];

export async function salesReport(db: Db, actor: Actor, range: DateRange) {
  const scope = leadScope(actor);
  const r = [range.fromIso, range.toIso];
  const bySource = (await db.prepare(`SELECT l.source, COUNT(*) AS n, SUM(CASE WHEN l.stage='converted' THEN 1 ELSE 0 END) AS converted FROM leads l WHERE ${scope.sql} AND l.created_at >= ? AND l.created_at < ? GROUP BY l.source ORDER BY n DESC`)
    .bind(...scope.binds, ...r).all<{ source: string; n: number; converted: number }>()).results;
  const funnel = (await db.prepare(`SELECT l.stage, COUNT(*) AS n FROM leads l WHERE ${scope.sql} AND l.created_at >= ? AND l.created_at < ? GROUP BY l.stage`).bind(...scope.binds, ...r).all<{ stage: string; n: number }>()).results;
  const created = bySource.reduce((s, x) => s + x.n, 0);
  const converted = bySource.reduce((s, x) => s + (x.converted ?? 0), 0);
  const sent = await db.prepare(`SELECT COUNT(*) AS n FROM quotes q JOIN leads l ON l.id = q.lead_id WHERE ${scope.sql} AND q.sent_at >= ? AND q.sent_at < ?`).bind(...scope.binds, ...r).first<{ n: number }>();
  const accepted = await db.prepare(`SELECT COUNT(*) AS n FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id JOIN leads l ON l.id = q.lead_id WHERE ${scope.sql} AND qv.accepted_at >= ? AND qv.accepted_at < ?`).bind(...scope.binds, ...r).first<{ n: number }>();
  const revenue = can(actor, "lead.read_all")
    ? (await db.prepare(`SELECT COALESCE(l.source, 'no lead (direct checkout)') AS source, SUM(p.amount_cents) AS cents FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN leads l ON l.id = o.lead_id
        WHERE p.status IN ('succeeded','partially_refunded','refunded','disputed') AND p.created_at >= ? AND p.created_at < ? GROUP BY source ORDER BY cents DESC`).bind(...r).all<{ source: string; cents: number }>()).results
    : (await db.prepare(`SELECT l.source AS source, SUM(p.amount_cents) AS cents FROM payments p JOIN orders o ON o.id = p.order_id JOIN leads l ON l.id = o.lead_id
        WHERE ${scope.sql} AND p.status IN ('succeeded','partially_refunded','refunded','disputed') AND p.created_at >= ? AND p.created_at < ? GROUP BY l.source ORDER BY cents DESC`).bind(...scope.binds, ...r).all<{ source: string; cents: number }>()).results;
  const attribution = await attributionReport(db, actor, range);
  return { bySource, funnel: Object.fromEntries(funnel.map((f) => [f.stage, f.n])) as Record<string, number>, created, converted, rate: created ? converted / created : null, quotesSent: sent?.n ?? 0, quotesAccepted: accepted?.n ?? 0, revenue, attribution };
}

// ── campaign attribution (CRM-001, CRM-006) ──
export interface AttributionRow { value: string | null; n: number; converted: number }
/** Leads created in the range grouped by UTM source, medium and campaign (each dimension separately, plus the full combination). */
export async function attributionReport(db: Db, actor: Actor, range: DateRange) {
  const scope = leadScope(actor);
  const by = async (col: "utm_source" | "utm_medium" | "utm_campaign") => (await db.prepare(`SELECT l.${col} AS value, COUNT(*) AS n, SUM(CASE WHEN l.stage='converted' THEN 1 ELSE 0 END) AS converted
      FROM leads l WHERE ${scope.sql} AND l.created_at >= ? AND l.created_at < ? GROUP BY l.${col} ORDER BY n DESC, value LIMIT 25`).bind(...scope.binds, range.fromIso, range.toIso).all<AttributionRow>()).results;
  const combos = (await db.prepare(`SELECT l.utm_source AS source, l.utm_medium AS medium, l.utm_campaign AS campaign, COUNT(*) AS n, SUM(CASE WHEN l.stage='converted' THEN 1 ELSE 0 END) AS converted
      FROM leads l WHERE ${scope.sql} AND l.created_at >= ? AND l.created_at < ? AND (l.utm_source IS NOT NULL OR l.utm_medium IS NOT NULL OR l.utm_campaign IS NOT NULL)
      GROUP BY l.utm_source, l.utm_medium, l.utm_campaign ORDER BY n DESC LIMIT 50`).bind(...scope.binds, range.fromIso, range.toIso)
    .all<{ source: string | null; medium: string | null; campaign: string | null; n: number; converted: number }>()).results;
  return { source: await by("utm_source"), medium: await by("utm_medium"), campaign: await by("utm_campaign"), combos };
}
