// Public lead capture → CRM (CRM-001, WEB-005). Writes contact, lead, first activity and
// an audit entry atomically.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { parse, v } from "../lib/validate.ts";
import { transitionLead, type LeadStage, isReopen } from "../domain/crm.ts";
import { require as requirePerm, can, type Actor } from "../domain/authz.ts";
import type { AppContext } from "../app/context.ts";
import { cookie, isSecure, parseCookies } from "../app/http.ts";

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

export async function captureLead(db: Db, body: unknown, meta: { ip?: string; attribution?: Attribution } = {}) {
  const input = parse(leadInput, body);
  const attr = sanitizeAttribution((meta.attribution ?? {}) as Record<string, string | undefined>);
  const at = nowIso();
  const companyId = input.company ? newId("co") : null;
  const contactId = newId("ct");
  const leadId = newId("ld");
  const stmts = [
    ...(companyId ? [db.prepare(`INSERT INTO companies (id, name, website, created_at) VALUES (?,?,?,?)`).bind(companyId, input.company, input.website ?? null, at)] : []),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES (?,?,?,?,?,?)`)
      .bind(contactId, companyId, input.name, input.email, input.phone ?? null, at),
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, landing_page, created_at, updated_at) VALUES (?,?,?,'new',?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(leadId, contactId, input.source, input.interest, input.message, attr.utm_source ?? null, attr.utm_medium ?? null, attr.utm_campaign ?? null, attr.utm_term ?? null, attr.utm_content ?? null, attr.referrer ?? null, attr.landing_page ?? null, at, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`)
      .bind(newId("act"), leadId, `Lead captured via ${input.source}${attr.utm_source ? ` (campaign source: ${attr.utm_source}${attr.utm_medium ? ` / ${attr.utm_medium}` : ""})` : ""}`, at),
    db.prepare(`INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES ('system','lead.created','lead',?,?,?,?)`)
      .bind(leadId, JSON.stringify({ source: input.source, ...(Object.keys(attr).length ? { attribution: attr } : {}) }), meta.ip ?? null, at),
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
