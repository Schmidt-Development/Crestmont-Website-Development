// Public lead capture → CRM (CRM-001, WEB-005). Writes contact, lead, first activity and
// an audit entry atomically.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { parse, v } from "../lib/validate.ts";
import { transitionLead, type LeadStage, isReopen } from "../domain/crm.ts";
import { require as requirePerm, can, type Actor } from "../domain/authz.ts";

export const leadInput = v.object({
  name: v.string({ min: 2, max: 120 }),
  email: v.email(),
  phone: v.string({ optional: true, max: 40, pattern: /^[+0-9 ().-]{7,40}$/ }),
  company: v.string({ optional: true, max: 160 }),
  website: v.string({ optional: true, max: 300, pattern: /^https?:\/\/[^\s]+$/ }),
  interest: v.enumOf(["starter", "business", "premium", "custom", "maintenance", "other"] as const),
  message: v.string({ min: 10, max: 5000 }),
  source: v.enumOf(["web_form", "quote_form"] as const),
});

export async function captureLead(db: Db, body: unknown, meta: { ip?: string } = {}) {
  const input = parse(leadInput, body);
  const at = nowIso();
  const companyId = input.company ? newId("co") : null;
  const contactId = newId("ct");
  const leadId = newId("ld");
  const stmts = [
    ...(companyId ? [db.prepare(`INSERT INTO companies (id, name, website, created_at) VALUES (?,?,?,?)`).bind(companyId, input.company, input.website ?? null, at)] : []),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES (?,?,?,?,?,?)`)
      .bind(contactId, companyId, input.name, input.email, input.phone ?? null, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, created_at, updated_at) VALUES (?,?,?,'new',?,?,?,?)`)
      .bind(leadId, contactId, input.source, input.interest, input.message, at, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`)
      .bind(newId("act"), leadId, `Lead captured via ${input.source}`, at),
    db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES ('system','lead.created','lead',?,?,?,?)`)
      .bind(leadId, JSON.stringify({ source: input.source }), meta.ip ?? null, at),
  ];
  await db.batch(stmts);
  return { leadId };
}

export async function changeLeadStage(db: Db, actor: Actor, leadId: string, to: LeadStage, opts: { reason?: string } = {}) {
  const lead = await db.prepare(`SELECT id, stage, owner_user_id FROM leads WHERE id = ?`).bind(leadId).first<{ id: string; stage: LeadStage; owner_user_id: string | null }>();
  if (!lead) throw Object.assign(new Error("Lead not found"), { status: 404 });
  if (!can(actor, "lead.write_all")) {
    requirePerm(actor, "lead.write_assigned");
    if (lead.owner_user_id !== actor.userId) throw Object.assign(new Error("Lead is not assigned to you"), { status: 403 });
  }
  if (to === "converted") throw Object.assign(new Error("Conversion is set by the payment webhook only"), { status: 409 });
  transitionLead(lead.stage, to, { lostReason: opts.reason });
  const at = nowIso();
  const res = await db.batch([
    db.prepare(`UPDATE leads SET stage = ?, lost_reason = COALESCE(?, lost_reason), updated_at = ? WHERE id = ? AND stage = ?`)
      .bind(to, opts.reason ?? null, at, leadId, lead.stage),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'stage_change',?,?)`)
      .bind(newId("act"), leadId, actor.userId ?? null, `${isReopen(lead.stage, to) ? "Reopened" : "Stage"}: ${lead.stage} → ${to}${opts.reason ? ` (${opts.reason})` : ""}`, at),
    db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES (?,?,'lead.stage_changed','lead',?,?,?)`)
      .bind(actor.userId ?? null, actor.kind, leadId, JSON.stringify({ from: lead.stage, to }), at),
  ]);
  if (res[0].meta.changes !== 1) throw Object.assign(new Error("Lead changed concurrently; reload and retry"), { status: 409 });
  return { from: lead.stage, to };
}
