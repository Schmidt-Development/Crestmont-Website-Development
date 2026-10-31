// Public lead capture → CRM (CRM-001, WEB-005). Writes contact, lead, first activity and
// an audit entry atomically.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { parse, v } from "../lib/validate.ts";
import { transitionLead, type LeadStage, isReopen } from "../domain/crm.ts";
import { require as requirePerm, can, type Actor } from "../domain/authz.ts";
import type { AppContext } from "../app/context.ts";
import { cookie, isSecure, parseCookies } from "../app/http.ts";
import { sendMail } from "./mailer.ts";
import { intake } from "./contact-identity.ts";
import { businessDate, endOfBusinessDay } from "../lib/business-time.ts";

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

// ───────────── Campaign attribution (CRM-001) ─────────────
// First-party only: UTM parameters from the landing URL, the external referrer and the landing path are kept
// in an HttpOnly cookie set by our own server (cm_attr) and copied into hidden form fields when a public lead
// form renders. No third-party tracking and no JavaScript is involved. When the browser sends Do-Not-Track
// (DNT: 1) or Global Privacy Control (Sec-GPC: 1) the referrer is not recorded.
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export interface Attribution { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string; referrer?: string; landing_page?: string }
export const ATTRIBUTION_FIELDS = [...UTM_KEYS, "referrer", "landing_page"] as const;
export const ATTRIBUTION_COOKIE = "cm_attr";
export const ATTRIBUTION_MAX_AGE = 60 * 60 * 24 * 30;

const cleanToken = (s: string | null | undefined): string | undefined => {
  const t = (s ?? "").replace(/[\u0000-\u001f\u007f<>"'`]/g, "").trim().slice(0, 120);
  return t || undefined;
};
/** Referrer reduced to origin + path (query strings can carry personal data). Only http(s). */
export function cleanReferrer(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return (u.origin + u.pathname).slice(0, 300);
  } catch { return undefined; }
}
/** Landing page as a same-site path only (no query, no host). */
export function cleanLandingPath(s: string | null | undefined): string | undefined {
  if (!s || !s.startsWith("/") || s.startsWith("//")) return undefined;
  const path = s.split(/[?#]/)[0].replace(/[^\w\-./~%]/g, "").slice(0, 200);
  return path || undefined;
}
export function sanitizeAttribution(a: Record<string, string | null | undefined>): Attribution {
  const out: Attribution = {};
  for (const k of UTM_KEYS) { const v = cleanToken(a[k]); if (v) out[k] = v; }
  const ref = cleanReferrer(a.referrer); if (ref) out.referrer = ref;
  const land = cleanLandingPath(a.landing_page); if (land) out.landing_page = land;
  return out;
}
export function privacySignal(headers: Headers): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}
export function parseAttributionCookie(value: string | undefined): Attribution {
  if (!value) return {};
  try {
    const o = JSON.parse(value);
    return o && typeof o === "object" ? sanitizeAttribution(o as Record<string, string>) : {};
  } catch { return {}; }
}
/**
 * Attribution for the current request: the stored cookie, overridden by UTM parameters on this URL (a new
 * campaign click replaces the old campaign). The first external referrer and landing path are kept.
 * Returns the merged value and whether the cookie needs (re)writing.
 */
export function attributionForRequest(url: URL, headers: Headers, cookieValue: string | undefined, ownOrigin: string): { value: Attribution; changed: boolean } {
  const stored = parseAttributionCookie(cookieValue);
  const fromUrl = sanitizeAttribution(Object.fromEntries(UTM_KEYS.map((k) => [k, url.searchParams.get(k)])));
  const hasCampaign = Object.keys(fromUrl).length > 0;
  const dnt = privacySignal(headers);
  const refRaw = headers.get("referer");
  let externalRef: string | undefined;
  if (refRaw && !dnt) { try { if (new URL(refRaw).origin !== ownOrigin) externalRef = cleanReferrer(refRaw); } catch { /* ignore */ } }
  let value: Attribution;
  if (hasCampaign) value = { ...fromUrl, referrer: externalRef ?? (dnt ? undefined : stored.referrer), landing_page: cleanLandingPath(url.pathname) };
  else if (cookieValue === undefined) value = { referrer: externalRef, landing_page: cleanLandingPath(url.pathname) };
  else value = dnt ? { ...stored, referrer: undefined } : stored;
  value = sanitizeAttribution(value as Record<string, string | undefined>);
  const changed = cookieValue === undefined || JSON.stringify(value) !== JSON.stringify(stored);
  return { value, changed };
}

const perRequest = new WeakMap<AppContext, Attribution>();
/**
 * Attribution for this request, computed once. Writes the first-party cm_attr cookie when it changed.
 * Called by the public layout (so any landing page records the campaign) and by the lead forms.
 */
export function requestAttribution(ctx: AppContext): Attribution {
  const hit = perRequest.get(ctx);
  if (hit) return hit;
  const raw = parseCookies(ctx.req.headers.get("cookie"))[ATTRIBUTION_COOKIE];
  const { value, changed } = attributionForRequest(ctx.url, ctx.req.headers, raw, ctx.url.origin);
  if (changed && ctx.req.method === "GET") ctx.setCookies.push(cookie(ATTRIBUTION_COOKIE, JSON.stringify(value), { maxAge: ATTRIBUTION_MAX_AGE, secure: isSecure(ctx), httpOnly: true, sameSite: "Lax" }));
  perRequest.set(ctx, value);
  return value;
}

/** Attribution submitted with a lead form (hidden fields), falling back to the cookie; referrer dropped under DNT/GPC. */
export function submittedAttribution(ctx: AppContext, form: FormData): Attribution {
  const fields = Object.fromEntries(ATTRIBUTION_FIELDS.map((k) => [k, typeof form.get(k) === "string" ? String(form.get(k)) : undefined]));
  const fromForm = sanitizeAttribution(fields);
  const fromCookie = parseAttributionCookie(parseCookies(ctx.req.headers.get("cookie"))[ATTRIBUTION_COOKIE]);
  const merged = Object.keys(fromForm).length ? fromForm : fromCookie;
  if (privacySignal(ctx.req.headers)) delete merged.referrer;
  return merged;
}

/** CREST-GAP-093: lead emails are stored trimmed and lowercased, so they match accounts and duplicates reliably. */
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** Business setting holding the default owner for new web leads (CREST-GAP-005). Ignored unless that user is active sales staff. */
export const DEFAULT_LEAD_OWNER_KEY = "crm.default_lead_owner";
const ACTIVE_SALES_USER = `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id IN ('owner','administrator','sales') AND u.disabled_at IS NULL`;

export async function captureLead(db: Db, body: unknown, meta: { ip?: string; attribution?: Attribution; channel?: "web_form" | "quote_form" | "api_lead" } = {}) {
  const input = parse(leadInput, body);
  input.email = normalizeEmail(input.email);
  const attr = sanitizeAttribution((meta.attribution ?? {}) as Record<string, string | undefined>);
  const owner = await db.prepare(`SELECT value FROM business_settings WHERE key = '${DEFAULT_LEAD_OWNER_KEY}' AND value IN (${ACTIVE_SALES_USER})`).first<{ value: string }>();
  // CRM duplicate protection: a person already in the CRM (same email or phone) continues their open lead; the new
  // message is added to its history with a follow-up task, instead of a second lead being created.
  const res = await intake(db, { contactName: input.name, businessName: input.company ?? null, website: input.website ?? null, emails: [{ value: input.email }], phones: input.phone ? [{ value: input.phone }] : [] }, {
    channel: meta.channel ?? input.source, ip: meta.ip ?? null,
    lead: { source: input.source, interest: input.interest, message: input.message, ownerUserId: owner?.value ?? null, utm: attr,
      activityBody: `Lead captured via ${input.source}${attr.utm_source ? ` (campaign source: ${attr.utm_source}${attr.utm_medium ? ` / ${attr.utm_medium}` : ""})` : ""}` },
    continuedStatements: (leadId) => [db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, due_at, created_at) VALUES (?,?,'task',?,?,?)`)
      .bind(newId("act"), leadId, `Reply to the new ${input.source === "quote_form" ? "quote request" : "message"} from ${input.name}`, endOfBusinessDay(businessDate(new Date())), nowIso())],
  });
  if (!res.leadId) throw Object.assign(new Error("We could not save this request. Please check your email address and try again."), { status: 422 });
  if (res.leadCreated) {
    await db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES ('system','lead.created','lead',?,?,?,?)`)
      .bind(res.leadId, JSON.stringify({ source: input.source, ...(Object.keys(attr).length ? { attribution: attr } : {}) }), meta.ip ?? null, nowIso()).run();
  }
  return { leadId: res.leadId, outcome: res.outcome, created: res.leadCreated };
}

/**
 * CREST-GAP-005: a new web lead (/quote, /contact, /api/leads) notifies Crestmont. Every active Owner and sales user gets
 * one in-app notification, and one staff email goes to the lead's default owner, else the public contact email
 * (Business settings), else the first Owner. Both are idempotent per lead, so a retry never notifies twice.
 */
export async function notifyNewLead(ctx: Pick<AppContext, "db" | "email" | "baseUrl" | "settings">, leadId: string, kind: "quote" | "contact" | "api") {
  const db = ctx.db;
  const lead = await db.prepare(`SELECT l.id, l.interest, l.source, l.owner_user_id, c.name, co.name AS company FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE l.id = ?`)
    .bind(leadId).first<{ id: string; interest: string | null; source: string; owner_user_id: string | null; name: string; company: string | null }>();
  if (!lead) return;
  const what = kind === "quote" ? "quote request" : kind === "contact" ? "contact message" : "lead";
  const body = `New ${what} from ${lead.name}${lead.company ? ` (${lead.company})` : ""}${lead.interest ? ` — interest: ${lead.interest}` : ""}.${lead.owner_user_id ? "" : " Unassigned."}`;
  const staff = (await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id IN ('owner','sales') AND u.disabled_at IS NULL`).all<{ user_id: string }>()).results;
  const at = nowIso();
  for (const s of staff) {
    await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) SELECT ?,?,'lead_new','lead',?,?,?
        WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'lead_new' AND subject_id = ?)`)
      .bind(newId("ntf"), s.user_id, leadId, body.slice(0, 500), at, s.user_id, leadId).run();
  }
  const ownerEmail = lead.owner_user_id ? (await db.prepare(`SELECT email FROM users WHERE id = ? AND disabled_at IS NULL`).bind(lead.owner_user_id).first<{ email: string }>())?.email : null;
  const firstOwner = async () => (await db.prepare(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL ORDER BY m.created_at LIMIT 1`).first<{ email: string }>())?.email ?? null;
  const to = ownerEmail ?? (ctx.settings["contact.email"]?.trim() || null) ?? await firstOwner();
  if (to) {
    await sendMail(ctx, { template: "lead_alert", to, idempotencyKey: `lead-staff:${leadId}`,
      data: { kind: kind === "api" ? "lead" : kind, name: lead.name, company: lead.company, interest: lead.interest, assigned: !!lead.owner_user_id, url: `${ctx.baseUrl}/staff/crm/leads/${leadId}` } });
  }
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
