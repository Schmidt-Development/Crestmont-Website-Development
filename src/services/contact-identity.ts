// Canonical contact identity and duplicate-safe CRM intake (CRM-002, CRM-005, CRM-007).
//
// Every channel that brings a person or business into the CRM (manual entry, public forms, the JSON lead API, the AI
// receptionist, the research-agent import API) calls intake(). It normalizes the identifiers, looks up canonical
// identities (migrations/0048), checks customers and suppression, decides one of eight outcomes, writes everything for
// that decision in ONE D1 batch (atomic), and records the decision with its evidence and idempotency key.
//
// Rules that are deliberately conservative:
//  - Email matching is trim + lowercase only. Gmail dots and +tags are NOT removed (they can be distinct mailboxes).
//  - A shared phone number or inbox (receptionist, franchise HQ, agency) never merges two businesses: a phone match
//    counts as "same business" only when the business identity (website domain / company name / location) agrees.
//  - Automated channels (research agent, CRM API) never create a competing prospect for an existing customer, never
//    re-create a suppressed contact, never overwrite customer-supplied or manually entered values, and send every
//    conflicting value to the review queue.
//  - A duplicate never silently creates a second lead: it links to the existing contact/lead or is held for review.
//  - Nothing here grants permission to call or email. Outreach eligibility stays in voice-outbound.ts (consent,
//    do-not-call, calling window, caps) and outreach-ledger.ts; both fail closed.
import type { Db, DbStatement } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Actor } from "../domain/authz.ts";
import { can } from "../domain/authz.ts";

export const INTAKE_OUTCOMES = ["CREATED", "EXISTING_CONTACT_LINKED", "EXISTING_BUSINESS_UPDATED", "VERIFIED_DATA_MERGED", "POSSIBLE_DUPLICATE_REVIEW", "SUPPRESSED", "REJECTED_INVALID", "NO_CHANGE"] as const;
export type IntakeOutcome = (typeof INTAKE_OUTCOMES)[number];
export type IntakeChannel = "manual" | "web_form" | "quote_form" | "api_lead" | "ai_receptionist" | "research_agent" | "crm_api";
/** Channels where the person contacted Crestmont themselves. Everything else is automated/third-party data. */
const INBOUND: ReadonlySet<IntakeChannel> = new Set(["web_form", "quote_form", "api_lead", "ai_receptionist"]);
const AUTOMATED: ReadonlySet<IntakeChannel> = new Set(["research_agent", "crm_api"]);
const OPEN_STAGES = `('new','qualified','quote_required','quote_sent','negotiation','accepted','awaiting_payment')`;
export const RACE_GUARD = "crm_identity_race";

/** Salted hash of a normalized identifier, used for erasure tombstones (migration 0049, identity-erasure.ts). */
export async function tombstoneHash(kind: "phone" | "email", value: string): Promise<string> {
  return sha256Hex(`crestmont-crm-erasure:v1|${kind}:${value}`);
}

// ───────────── Normalization ─────────────

/** E.164, identical to the SQL view contact_identity_norm_v and to toE164(): +digits kept, 10 digits → +1, 1+10 → +. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const d = s.replace(/[ \-().+\t]/g, "");
  if (!d || /[^0-9]/.test(d)) return null;
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 && d[0] !== "0" ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** trim + lowercase. No provider-specific rewriting (dots and +tags are kept). Identical to contact_identity_norm_v. */
export function emailKey(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.indexOf("@") < 1 || /\s/.test(s)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return null;
  return s.toLowerCase();
}

/** Website domain: lowercase host without a leading www. Identical to company_domain_v for http(s) URLs. */
export function domainKey(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const i = s.indexOf("://");
  if (i >= 0) s = s.slice(i + 3);
  s = s.split("/")[0].split(":")[0];
  if (s.startsWith("www.")) s = s.slice(4);
  return s.includes(".") && /^[a-z0-9.-]+$/.test(s) ? s : null;
}

const LEGAL_SUFFIX = /\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|limited|pllc|plc|lp|llp)\.?$/;
/** Company name for comparison: lowercase, & → and, punctuation removed, legal suffixes dropped. */
export function companyKey(raw: string | null | undefined): string | null {
  let s = (raw ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (let k = 0; k < 2; k++) s = s.replace(LEGAL_SUFFIX, "").trim();
  s = s.replace(/^the /, "");
  return s || null;
}

export interface LocationInput { city?: string | null; region?: string | null; postalCode?: string | null }
export function locationKey(l: LocationInput | null | undefined): string | null {
  if (!l) return null;
  const city = (l.city ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const region = (l.region ?? "").trim().toUpperCase();
  const zip = (l.postalCode ?? "").trim().slice(0, 5);
  return city || region || zip ? `${city}|${region}|${zip}` : null;
}
const locationDisplay = (l: LocationInput | null | undefined) => (l ? [[l.city, l.region].filter(Boolean).join(", "), l.postalCode].filter(Boolean).join(" ") || null : null);
const nameKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ") || null;
/** Same normalization as contacts.name_company_norm (migrations/0044): lower(trim), whitespace runs collapsed. */
const rawCompanyNorm = (s: string | null | undefined) => (s ?? "").replace(/[\t\n]/g, " ").trim().toLowerCase().replace(/ +/g, " ") || null;

// ───────────── Types ─────────────

export interface IdentifierInput { value: string; label?: "main" | "mobile" | "office" | "direct" | "shared_line" | "shared_inbox" | "other"; verified?: boolean }
export interface Candidate {
  contactName?: string | null;
  businessName?: string | null;
  website?: string | null;
  location?: LocationInput | null;
  phones?: IdentifierInput[];
  emails?: IdentifierInput[];
  /** Fields the source has verified (e.g. the research agent confirmed the website on the business's own site). */
  verifiedFields?: ("contact_name" | "business_name" | "website")[];
}
export interface LeadFields {
  source: "web_form" | "quote_form" | "ai_receptionist" | "referral" | "manual" | "checkout";
  interest?: string | null; message?: string | null; ownerUserId?: string | null;
  utm?: Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_term" | "utm_content" | "referrer" | "landing_page", string | null>>;
  /** Extra statements to run in the same batch once the lead id is known (e.g. linking a call). */
  activityBody?: string; activityKind?: "system" | "call";
  isTest?: boolean;
}
export interface IntakeOptions {
  channel: IntakeChannel;
  actor?: Actor | null;
  /** Same key + same request → the stored decision is returned. Same key + different request → IntakeError 409. */
  idempotencyKey?: string | null;
  requestFingerprint?: unknown;
  /** Research/CRM API record id (stored as provenance, never PII). */
  sourceRef?: string | null;
  /** 0–100. Automated channels are capped (research 60, crm_api 80). */
  confidence?: number;
  batchId?: string | null;
  lead: LeadFields;
  /** What a person chose after seeing the duplicate warning (manual entry) or a review item (held records). */
  resolution?: { kind: "create_new" } | { kind: "link"; contactId: string } | null;
  ip?: string | null;
  /** Run extra statements in the intake batch (they receive the final lead id). */
  extraStatements?: (leadId: string) => DbStatement[];
  /** Statements run only when an existing open lead is continued instead of a new one created (e.g. a reply task). */
  continuedStatements?: (leadId: string) => DbStatement[];
}

export interface IdentityMatch {
  contactId: string; leadId: string | null; contactName: string; companyName: string | null;
  reasons: ("email" | "phone" | "domain" | "name_company")[];
  /** strong = same contact; ambiguous = unshared identifier but business details disagree; shared = used by other businesses. */
  strength: "strong" | "ambiguous" | "shared" | "weak";
  customer: boolean; organizationId: string | null; stage: string | null;
}
export interface IntakeResult {
  outcome: IntakeOutcome;
  decisionId: string | null;
  leadId: string | null;
  contactId: string | null;
  leadCreated: boolean;
  replayed: boolean;
  matches: IdentityMatch[];
  reviewIds: string[];
  suppressed: Suppression;
  reasons: string[];
  /** Always false: duplicate protection is never permission to call. See voice-outbound.ts eligibility(). */
  outreachEligible: false;
}

export class IntakeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ───────────── Lookups ─────────────

interface IdentityRow { id: string; kind: "phone" | "email"; value_norm: string; shared: number; verification_status: string }
interface ContactRow {
  id: string; name: string; email: string | null; phone: string | null; user_id: string | null; company_id: string | null;
  company_name: string | null; website: string | null; domain_norm: string | null; location_norm: string | null; organization_id: string | null;
  member_org: string | null; open_lead_id: string | null; any_lead_id: string | null; any_stage: string | null; lead_origin: string | null;
  has_sales: number; manual_edits: number;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

async function findIdentities(db: Db, emails: string[], phones: string[]): Promise<IdentityRow[]> {
  const conds: string[] = [], binds: string[] = [];
  if (emails.length) { conds.push(`(kind = 'email' AND value_norm IN (${placeholders(emails.length)}))`); binds.push(...emails); }
  if (phones.length) { conds.push(`(kind = 'phone' AND value_norm IN (${placeholders(phones.length)}))`); binds.push(...phones); }
  if (!conds.length) return [];
  return (await db.prepare(`SELECT id, kind, value_norm, shared, verification_status FROM contact_identities WHERE ${conds.join(" OR ")}`).bind(...binds).all<IdentityRow>()).results;
}

const CONTACT_SELECT = `SELECT c.id, c.name, c.email, c.phone, c.user_id, c.company_id, co.name AS company_name, co.website, co.domain_norm, co.location_norm, co.organization_id,
  (SELECT m.organization_id FROM memberships m WHERE m.user_id = c.user_id AND m.role_id LIKE 'customer_%' ORDER BY m.created_at LIMIT 1) AS member_org,
  (SELECT l.id FROM leads l WHERE l.contact_id = c.id AND l.merged_into_lead_id IS NULL AND l.stage IN ${OPEN_STAGES} ORDER BY l.updated_at DESC, l.id LIMIT 1) AS open_lead_id,
  (SELECT l.id FROM leads l WHERE l.contact_id = c.id AND l.merged_into_lead_id IS NULL ORDER BY l.updated_at DESC, l.id LIMIT 1) AS any_lead_id,
  (SELECT l.stage FROM leads l WHERE l.contact_id = c.id AND l.merged_into_lead_id IS NULL ORDER BY l.updated_at DESC, l.id LIMIT 1) AS any_stage,
  (SELECT l.origin FROM leads l WHERE l.contact_id = c.id AND l.merged_into_lead_id IS NULL ORDER BY l.created_at, l.id LIMIT 1) AS lead_origin,
  EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id AND (l.stage = 'converted' OR EXISTS (SELECT 1 FROM orders o WHERE o.lead_id = l.id))) AS has_sales,
  (SELECT COUNT(*) FROM crm_field_changes f WHERE f.contact_id = c.id AND f.actor_user_id IS NOT NULL) + (SELECT COUNT(*) FROM audit_logs a WHERE a.action = 'lead.contact_updated' AND a.subject_id IN (SELECT id FROM leads WHERE contact_id = c.id)) AS manual_edits
  FROM contacts c LEFT JOIN companies co ON co.id = c.company_id`;

async function contactsByIds(db: Db, ids: string[]): Promise<ContactRow[]> {
  if (!ids.length) return [];
  const out: ContactRow[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    out.push(...(await db.prepare(`${CONTACT_SELECT} WHERE c.id IN (${placeholders(chunk.length)}) AND c.name <> 'Deleted contact'`).bind(...chunk).all<ContactRow>()).results);
  }
  return out;
}

/** A contact whose every lead was merged away is represented by the surviving lead's contact. */
async function canonicalContactIds(db: Db, contactIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>(contactIds.map((c) => [c, c]));
  if (!contactIds.length) return map;
  for (let i = 0; i < contactIds.length; i += 80) { // D1: at most 100 bound parameters per statement
    const chunk = contactIds.slice(i, i + 80);
    const rows = (await db.prepare(`SELECT l.contact_id AS src, t.contact_id AS dst FROM leads l JOIN leads t ON t.id = l.merged_into_lead_id
        WHERE l.contact_id IN (${placeholders(chunk.length)}) AND NOT EXISTS (SELECT 1 FROM leads u WHERE u.contact_id = l.contact_id AND u.merged_into_lead_id IS NULL)`)
      .bind(...chunk).all<{ src: string; dst: string }>()).results;
    for (const r of rows) map.set(r.src, r.dst);
  }
  return map;
}

async function linkedContacts(db: Db, identityIds: string[]): Promise<{ identity_id: string; contact_id: string }[]> {
  if (!identityIds.length) return [];
  return (await db.prepare(`SELECT identity_id, contact_id FROM contact_identity_links WHERE removed_at IS NULL AND identity_id IN (${placeholders(identityIds.length)})`)
    .bind(...identityIds).all<{ identity_id: string; contact_id: string }>()).results;
}

export interface Suppression { phone: boolean; email: boolean; /** an erasure tombstone exists for one of the identifiers */ erased: boolean }
async function tombstoneHashes(phones: string[], emails: string[]): Promise<string[]> {
  return [...await Promise.all(phones.map((p) => tombstoneHash("phone", p))), ...await Promise.all(emails.map((e) => tombstoneHash("email", e)))];
}
export async function suppressionFor(db: Db, phones: string[], emails: string[]): Promise<Suppression> {
  const phone = phones.length ? !!(await db.prepare(`SELECT 1 AS x FROM voice_dnc WHERE phone_e164 IN (${placeholders(phones.length)}) LIMIT 1`).bind(...phones).first()) : false;
  const email = emails.length ? !!(await db.prepare(`SELECT 1 AS x FROM email_suppressions WHERE removed_at IS NULL AND lower(email) IN (${placeholders(emails.length)}) LIMIT 1`).bind(...emails).first()) : false;
  const hashes = await tombstoneHashes(phones, emails);
  const erased = hashes.length ? !!(await db.prepare(`SELECT 1 AS x FROM crm_erasure_tombstones WHERE key_hash IN (${placeholders(hashes.length)}) LIMIT 1`).bind(...hashes).first()) : false;
  return { phone, email, erased };
}

async function customerAccountsByEmail(db: Db, emails: string[]): Promise<{ organization_id: string; user_id: string }[]> {
  if (!emails.length) return [];
  return (await db.prepare(`SELECT m.organization_id, u.id AS user_id FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE lower(u.email) IN (${placeholders(emails.length)}) AND m.role_id LIKE 'customer_%'`).bind(...emails).all<{ organization_id: string; user_id: string }>()).results;
}

// ───────────── Matching ─────────────

interface Normalized {
  emails: { key: string; input: IdentifierInput }[]; phones: { key: string; input: IdentifierInput }[];
  domain: string | null; company: string | null; companyRaw: string | null; location: string | null; name: string | null;
  invalid: string[];
}

export function normalizeCandidate(c: Candidate): Normalized {
  const invalid: string[] = [];
  const emails = new Map<string, IdentifierInput>(), phones = new Map<string, IdentifierInput>();
  for (const e of c.emails ?? []) { const k = emailKey(e.value); if (k) { if (!emails.has(k)) emails.set(k, e); } else if (e.value?.trim()) invalid.push("email"); }
  for (const p of c.phones ?? []) { const k = phoneKey(p.value); if (k) { if (!phones.has(k)) phones.set(k, p); } else if (p.value?.trim()) invalid.push("phone"); }
  return {
    emails: [...emails].map(([key, input]) => ({ key, input })), phones: [...phones].map(([key, input]) => ({ key, input })),
    domain: domainKey(c.website), company: companyKey(c.businessName), companyRaw: rawCompanyNorm(c.businessName), location: locationKey(c.location), name: nameKey(c.contactName), invalid,
  };
}

/**
 * same       domain (or company name) and location agree
 * different  clearly another business: another location of the same brand, or both website AND name differ
 * ambiguous  one signal differs and the other agrees or is missing (renamed business, typo, new website)
 * unknown    not enough business identity on one side
 */
type Relation = "same" | "different" | "ambiguous" | "unknown";
function businessRelation(n: Normalized, c: ContactRow): Relation {
  const locOk = !n.location || !c.location_norm || n.location === c.location_norm;
  const existingCompany = companyKey(c.company_name);
  const namesBoth = !!(n.company && existingCompany), namesEqual = namesBoth && n.company === existingCompany;
  if (n.domain && c.domain_norm) {
    if (n.domain === c.domain_norm) return locOk ? "same" : "different";
    return namesEqual ? "ambiguous" : namesBoth ? "different" : "ambiguous";
  }
  if (namesBoth) return namesEqual ? (locOk ? "same" : "different") : "ambiguous";
  return "unknown";
}

interface Evaluation {
  matches: (IdentityMatch & { row: ContactRow; relation: Relation })[];
  identities: IdentityRow[];
  linkCounts: Map<string, number>;
  customerAccounts: { organization_id: string; user_id: string }[];
  businessMatches: ContactRow[];
  /** Customer organizations that own a company with the same website domain (another location of a customer). */
  domainCustomers: string[];
}

async function evaluate(db: Db, n: Normalized): Promise<Evaluation> {
  const identities = await findIdentities(db, n.emails.map((e) => e.key), n.phones.map((p) => p.key));
  const links = await linkedContacts(db, identities.map((i) => i.id));
  const linkCounts = new Map<string, number>();
  for (const l of links) linkCounts.set(l.identity_id, (linkCounts.get(l.identity_id) ?? 0) + 1);
  const canon = await canonicalContactIds(db, [...new Set(links.map((l) => l.contact_id))]);
  const byContact = new Map<string, Set<string>>();
  for (const l of links) { const cid = canon.get(l.contact_id) ?? l.contact_id; byContact.set(cid, new Set([...(byContact.get(cid) ?? []), l.identity_id])); }
  const rows = await contactsByIds(db, [...byContact.keys()]);
  const idById = new Map(identities.map((i) => [i.id, i]));
  const matches: Evaluation["matches"] = [];
  for (const row of rows) {
    const ids = [...(byContact.get(row.id) ?? [])].map((i) => idById.get(i)!).filter(Boolean);
    const reasons = new Set<IdentityMatch["reasons"][number]>();
    let strong = false, ambiguous = false;
    const rel = businessRelation(n, row);
    for (const ident of ids) {
      reasons.add(ident.kind);
      // A shared identifier (receptionist line, HQ inbox, or historical duplicates) proves nothing about WHICH business
      // this is, so it counts only when the business identity confirms it (same domain/location or company name).
      const sharedHere = ident.shared === 1 || (linkCounts.get(ident.id) ?? 0) > 1;
      if (rel === "same") strong = true;
      else if (rel === "unknown" && !sharedHere) strong = true;
      else if (rel === "ambiguous" && !sharedHere) ambiguous = true;
    }
    if (rel === "same") reasons.add(n.domain && row.domain_norm === n.domain ? "domain" : "name_company");
    const customer = !!(row.organization_id || row.member_org || row.has_sales);
    matches.push({ contactId: row.id, leadId: row.open_lead_id ?? row.any_lead_id, contactName: row.name, companyName: row.company_name, reasons: [...reasons],
      strength: strong ? "strong" : ambiguous ? "ambiguous" : "shared", customer, relation: rel, organizationId: row.organization_id ?? row.member_org, stage: row.any_stage, row });
  }
  // Business identity without a shared identifier: same domain (and location) or same name at the same company.
  const businessMatches: ContactRow[] = [];
  if (n.domain || (n.company && n.name)) {
    const conds: string[] = [], binds: string[] = [];
    if (n.domain) { conds.push(`co.domain_norm = ?`); binds.push(n.domain); }
    if (n.company && n.name) { conds.push(`c.name_company_norm = ?`); binds.push(`${n.name}|${n.companyRaw ?? ""}`); }
    const ids = (await db.prepare(`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE (${conds.join(" OR ")}) AND c.name <> 'Deleted contact' LIMIT 25`).bind(...binds).all<{ id: string }>()).results.map((r) => r.id);
    const known = new Set(matches.map((m) => m.contactId));
    for (const row of await contactsByIds(db, ids.filter((i) => !known.has(i)))) {
      if (businessRelation(n, row) === "same" || (n.name && n.company && nameKey(row.name) === n.name && companyKey(row.company_name) === n.company)) businessMatches.push(row);
    }
  }
  const customerAccounts = await customerAccountsByEmail(db, n.emails.map((e) => e.key));
  const domainCustomers = n.domain ? (await db.prepare(`SELECT DISTINCT organization_id FROM companies WHERE domain_norm = ? AND organization_id IS NOT NULL LIMIT 10`).bind(n.domain).all<{ organization_id: string }>()).results.map((r) => r.organization_id) : [];
  return { matches, identities, linkCounts, customerAccounts, businessMatches, domainCustomers };
}

const toPublicMatch = ({ row: _row, relation: _rel, ...m }: IdentityMatch & { row?: ContactRow; relation?: Relation }): IdentityMatch => m;

/** Read-only duplicate preview (used by the manual-entry warning and the import dry run). */
export async function previewMatches(db: Db, c: Candidate): Promise<{ matches: IdentityMatch[]; suppressed: Suppression; invalid: string[] }> {
  const n = normalizeCandidate(c);
  const ev = await evaluate(db, n);
  const business = ev.businessMatches.map((row) => ({ contactId: row.id, leadId: row.open_lead_id ?? row.any_lead_id, contactName: row.name, companyName: row.company_name,
    reasons: [n.domain && row.domain_norm === n.domain ? "domain" as const : "name_company" as const], strength: "weak" as const, customer: !!(row.organization_id || row.member_org || row.has_sales),
    organizationId: row.organization_id ?? row.member_org, stage: row.any_stage }));
  return { matches: [...ev.matches.map(toPublicMatch), ...business], suppressed: await suppressionFor(db, n.phones.map((p) => p.key), n.emails.map((e) => e.key)), invalid: n.invalid };
}

// ───────────── Merge rules ─────────────

type Field = "name" | "email" | "phone" | "company_name" | "website";
interface FieldPlan { field: Field; current: string | null; proposed: string; action: "fill" | "verified_update" | "review" | "additional" }

const capConfidence = (ch: IntakeChannel, c: number | undefined) => {
  const base = c ?? (ch === "research_agent" ? 40 : ch === "crm_api" ? 60 : ch === "ai_receptionist" ? 60 : 70);
  return Math.max(0, Math.min(ch === "research_agent" ? 60 : ch === "crm_api" ? 80 : 90, Math.round(base)));
};

/**
 * Field-level merge plan against an existing contact. Blank values may be filled; additional phones/emails become
 * additional identity links; differing values are applied only when the candidate is verified and the existing value is
 * neither customer-protected nor manually entered nor itself verified; everything else goes to review.
 */
function planMerge(n: Normalized, c: Candidate, row: ContactRow, ch: IntakeChannel, protectedRecord: boolean): FieldPlan[] {
  const plan: FieldPlan[] = [];
  // Customer records are changed only by staff: automated data AND unauthenticated forms/calls only propose changes.
  const manual = ch === "manual";
  const verified = new Set(c.verifiedFields ?? []);
  // Values that came from an automated source and were never touched by a person may be corrected by verified data.
  const correctable = !protectedRecord && row.manual_edits === 0 && (row.lead_origin === "research_agent" || row.lead_origin === "crm_api");
  const consider = (field: Field, proposed: string | null | undefined, current: string | null, same: boolean, isVerified: boolean) => {
    if (!proposed || same) return;
    if (!current) { plan.push({ field, current, proposed, action: protectedRecord && !manual ? "review" : "fill" }); return; }
    plan.push({ field, current, proposed, action: isVerified && correctable ? "verified_update" : "review" });
  };
  // People type their own name differently from one form to the next; that is not worth a review item.
  consider("name", c.contactName?.trim(), row.name, !n.name || nameKey(row.name) === n.name || INBOUND.has(ch), verified.has("contact_name"));
  consider("company_name", c.businessName?.trim(), row.company_name, !n.company || companyKey(row.company_name) === n.company, verified.has("business_name"));
  consider("website", c.website?.trim(), row.website, !n.domain || row.domain_norm === n.domain, verified.has("website"));
  // Identifiers: the primary column is filled when blank; otherwise a new value is an additional identifier, never a
  // replacement. For a protected (customer) record automated data only proposes it.
  for (const [field, list, current, key] of [["email", n.emails, row.email, emailKey(row.email)], ["phone", n.phones, row.phone, phoneKey(row.phone)]] as const) {
    for (const { key: k, input } of list) {
      if (k === key) continue;
      if (!current && !plan.some((p) => p.field === field && p.action === "fill")) plan.push({ field, current: null, proposed: input.value.trim(), action: protectedRecord && !manual ? "review" : "fill" });
      else plan.push({ field, current, proposed: input.value.trim(), action: protectedRecord && !manual ? "review" : "additional" });
    }
  }
  return plan;
}

// ───────────── Intake ─────────────

function isRaceError(e: unknown) { return /crm_identity_race|UNIQUE constraint failed: (crm_intake_decisions\.idempotency_key|contact_identities\.kind)/.test(String((e as Error)?.message ?? e)); }

async function replayDecision(db: Db, key: string, hash: string): Promise<IntakeResult | null> {
  const d = await db.prepare(`SELECT id, outcome, lead_id, contact_id, request_hash, evidence_json FROM crm_intake_decisions WHERE idempotency_key = ?`).bind(key)
    .first<{ id: string; outcome: IntakeOutcome; lead_id: string | null; contact_id: string | null; request_hash: string | null; evidence_json: string }>();
  if (!d) return null;
  if (d.request_hash && d.request_hash !== hash) throw new IntakeError(409, "This idempotency key was already used for a different request.");
  const ev = JSON.parse(d.evidence_json) as { reviewIds?: string[]; suppressed?: Suppression; reasons?: string[]; matches?: IdentityMatch[]; leadCreated?: boolean };
  return { outcome: d.outcome, decisionId: d.id, leadId: d.lead_id, contactId: d.contact_id, leadCreated: false, replayed: true, matches: ev.matches ?? [], reviewIds: ev.reviewIds ?? [],
    suppressed: { phone: false, email: false, erased: false, ...ev.suppressed }, reasons: ev.reasons ?? [], outreachEligible: false };
}

/** Normalize, match, decide and write. Retries the decision when a concurrent writer linked the same identifier first. */
export async function intake(db: Db, candidate: Candidate, opts: IntakeOptions): Promise<IntakeResult> {
  const hash = await sha256Hex(JSON.stringify({ c: candidate, f: opts.requestFingerprint ?? null, ch: opts.channel }));
  for (let attempt = 0; ; attempt++) {
    if (opts.idempotencyKey) { const r = await replayDecision(db, opts.idempotencyKey, hash); if (r) return r; }
    try { return await decideAndWrite(db, candidate, opts, hash); }
    catch (e) {
      if (isRaceError(e) && attempt < 4) continue;
      if (isRaceError(e)) throw new IntakeError(409, "This contact is being saved by another request right now. Please retry.");
      throw e;
    }
  }
}

async function decideAndWrite(db: Db, candidate: Candidate, opts: IntakeOptions, hash: string): Promise<IntakeResult> {
  const ch = opts.channel;
  const at = nowIso();
  const automated = AUTOMATED.has(ch), inbound = INBOUND.has(ch);
  const n = normalizeCandidate(candidate);
  const confidence = capConfidence(ch, opts.confidence);
  const decisionId = newId("dec");
  const reasons: string[] = [];
  const reviewIds: string[] = [];
  const stmts: DbStatement[] = [];
  const actorId = opts.actor?.userId ?? null;
  /** A person already decided (manual warning or review queue): the automated hold rules do not apply again. */
  const decided = !!opts.resolution;

  const finish = (outcome: IntakeOutcome, extra: { leadId?: string | null; contactId?: string | null; leadCreated?: boolean; matches?: IdentityMatch[]; suppressed?: Suppression } = {}) => {
    const suppressed = extra.suppressed ?? { phone: false, email: false, erased: false };
    const evidence = { rule: reasons[0] ?? null, reasons, reviewIds, suppressed, leadCreated: !!extra.leadCreated, confidence,
      matches: (extra.matches ?? []).map((m) => ({ ...m, contactName: undefined, companyName: undefined })),
      identifiers: { emails: n.emails.length, phones: n.phones.length, domain: !!n.domain, location: !!n.location }, sourceRef: opts.sourceRef ?? null };
    // The decision row goes FIRST (leads, reviews and field changes reference it; a reused idempotency key aborts the
    // batch before anything else is written) and receives its lead/contact ids LAST, once those rows exist.
    stmts.unshift(db.prepare(`INSERT INTO crm_intake_decisions (id, channel, idempotency_key, request_hash, outcome, batch_id, actor_user_id, evidence_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(decisionId, ch, opts.idempotencyKey ?? null, hash, outcome, opts.batchId ?? null, actorId, JSON.stringify(evidence), at));
    if (extra.leadId || extra.contactId) stmts.push(db.prepare(`UPDATE crm_intake_decisions SET lead_id = ?, contact_id = ? WHERE id = ?`).bind(extra.leadId ?? null, extra.contactId ?? null, decisionId));
    stmts.push(db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(actorId, opts.actor?.kind === "user" ? "user" : automated ? "system" : ch === "ai_receptionist" ? "ai" : "system", `crm.intake.${outcome.toLowerCase()}`, "crm_intake_decision", decisionId,
        JSON.stringify({ channel: ch, lead: extra.leadId ?? null, reviews: reviewIds.length, rule: reasons[0] ?? null }), opts.ip ?? null, at));
    return { outcome, decisionId, leadId: extra.leadId ?? null, contactId: extra.contactId ?? null, leadCreated: !!extra.leadCreated, replayed: false,
      matches: extra.matches ?? [], reviewIds, suppressed, reasons, outreachEligible: false as const };
  };
  const commit = async (r: IntakeResult) => { await db.batch(stmts); return r; };

  const review = (kind: "possible_duplicate" | "field_conflict" | "customer_match", p: { contactId?: string | null; leadId?: string | null; field?: Field; current?: string | null; proposed?: string | null; reason: string; candidate?: boolean }) => {
    const id = newId("rev");
    const dedupe = `${kind}:${p.contactId ?? "-"}:${p.field ?? "-"}:${(p.proposed ?? "").toLowerCase()}:${p.candidate ? hash.slice(0, 16) : ""}`;
    stmts.push(db.prepare(`INSERT INTO crm_identity_reviews (id, kind, contact_id, lead_id, decision_id, field, current_value, proposed_value, proposed_source, proposed_confidence, candidate_json, reason, dedupe_key, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) WHERE status = 'open' DO NOTHING`)
      .bind(id, kind, p.contactId ?? null, p.leadId ?? null, decisionId, p.field ?? null, p.current ?? null, p.proposed ?? null, ch, confidence,
        p.candidate ? JSON.stringify({ candidate, lead: { ...opts.lead, extraStatements: undefined }, channel: ch, sourceRef: opts.sourceRef ?? null }) : null, p.reason.slice(0, 500), dedupe, at));
    reviewIds.push(id);
  };

  // 1. Validation.
  const hasIdentifier = n.emails.length > 0 || n.phones.length > 0;
  const hasName = !!(candidate.contactName?.trim() || candidate.businessName?.trim());
  if (!hasIdentifier || !hasName) {
    reasons.push(!hasName ? "missing_name" : n.invalid.length ? `invalid_${n.invalid[0]}` : "missing_identifier");
    return commit(finish("REJECTED_INVALID"));
  }

  // 2. Evaluate identities, customers and suppression.
  const ev = await evaluate(db, n);
  const suppressed = await suppressionFor(db, n.phones.map((p) => p.key), n.emails.map((e) => e.key));
  const erasureHashes = automated ? await tombstoneHashes(n.phones.map((p) => p.key), n.emails.map((e) => e.key)) : [];
  let strong = ev.matches.filter((m) => m.strength === "strong");
  const ambiguousMatches = ev.matches.filter((m) => m.strength === "ambiguous");
  const shared = ev.matches.filter((m) => m.strength === "shared");
  // A person contacting us themselves is never turned away or duplicated: same identifier with a slightly different
  // company name, or historical duplicates of their record, continue the best existing record; the rest is reviewed.
  let inboundNote: string | null = null;
  if (inbound) {
    const candidates = [...strong, ...ambiguousMatches, ...shared.filter((m) => m.relation !== "different")];
    const uniq = [...new Map(candidates.map((m) => [m.contactId, m])).values()];
    if (uniq.length) {
      const best = [...uniq].sort((a, b) => Number(!!b.row.open_lead_id) - Number(!!a.row.open_lead_id) || Number(!!b.row.any_lead_id) - Number(!!a.row.any_lead_id))[0];
      if (uniq.length > 1 || best.strength !== "strong") inboundNote = uniq.length > 1 ? `This inquiry matches ${uniq.length} CRM records (${uniq.map((m) => m.contactId).join(", ")}); it was added to ${best.contactId}. Merge the duplicates if they are the same.` : `This inquiry used an identifier on file but different business details; it was added to the existing record. Check whether it is the same business.`;
      strong = [{ ...best, strength: "strong" }];
    }
  }
  const publicMatches = ev.matches.map(toPublicMatch);

  // Race guard: the batch commits only if the identifiers still have exactly the links we based the decision on.
  const guard = () => {
    const keys = [...n.emails.map((e) => ["email", e.key]), ...n.phones.map((p) => ["phone", p.key])];
    const seen = keys.reduce((s, [, k]) => s + ev.identities.filter((i) => i.value_norm === k).reduce((t, i) => t + (ev.linkCounts.get(i.id) ?? 0), 0), 0);
    // Automated data also aborts if an erasure tombstone for these identifiers was written meanwhile (concurrent erasure).
    if (automated && erasureHashes.length) stmts.unshift(db.prepare(`INSERT INTO crm_write_guard (ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM crm_erasure_tombstones WHERE key_hash IN (${placeholders(erasureHashes.length)}))`).bind(...erasureHashes));
    stmts.unshift(db.prepare(`INSERT INTO crm_write_guard (ok) SELECT 0 WHERE (SELECT COUNT(*) FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id
        WHERE l.removed_at IS NULL AND (${keys.map(() => "(ci.kind = ? AND ci.value_norm = ?)").join(" OR ")})) <> ?`).bind(...keys.flat(), seen));
  };

  // Automated data for a suppressed identifier never creates, links or reactivates anything.
  if (automated && (suppressed.phone || suppressed.email || suppressed.erased)) {
    reasons.push(suppressed.phone ? "phone_on_do_not_call_list" : suppressed.email ? "email_suppressed" : "erased_at_request");
    return commit(finish("SUPPRESSED", { matches: publicMatches, suppressed, contactId: strong[0]?.contactId ?? null, leadId: strong[0]?.leadId ?? null }));
  }

  // Manual entry: show the person the matches before anything is written, unless they already chose.
  if (ch === "manual" && !opts.resolution && (strong.length || shared.length || ev.businessMatches.length || ev.customerAccounts.length)) {
    reasons.push("manual_duplicate_warning");
    throw Object.assign(new IntakeError(409, "Possible duplicate"), { preview: await previewMatches(db, candidate) });
  }

  // 3. Conflicting identities: the email belongs to one record and the phone to another (automated data only; inbound
  // picked one above). Also: an unshared identifier whose business details disagree (renamed business, typo, new site).
  const strongContacts = [...new Set(strong.map((m) => m.contactId))];
  if (automated && !decided && !strongContacts.length && ambiguousMatches.length) {
    reasons.push("identifier_match_with_different_business_details");
    review("possible_duplicate", { contactId: ambiguousMatches[0].contactId, leadId: ambiguousMatches[0].leadId, reason: "Same phone or email as an existing record but a different website or company name. Link if it is the same business (renamed, new website), or create separately.", candidate: true });
    guard();
    return commit(finish("POSSIBLE_DUPLICATE_REVIEW", { matches: publicMatches, suppressed }));
  }
  if (strongContacts.length > 1 && !decided) {
    reasons.push("identifiers_match_different_records");
    review("possible_duplicate", { contactId: strongContacts[0], leadId: strong[0].leadId, reason: `Identifiers match ${strongContacts.length} different CRM records (${strongContacts.join(", ")}).`, candidate: true });
    guard();
    return commit(finish("POSSIBLE_DUPLICATE_REVIEW", { matches: publicMatches, suppressed }));
  }

  // Customer account with this email but no CRM contact yet (e.g. registered in the portal).
  const customerOrgs = [...new Set([...ev.customerAccounts.map((a) => a.organization_id), ...strong.filter((m) => m.customer && m.organizationId).map((m) => m.organizationId!)])];

  // 4. Exactly one strong match → link / update / merge.
  let target: (IdentityMatch & { row: ContactRow }) | undefined = strong[0];
  if (opts.resolution?.kind === "link") {
    const chosen = opts.resolution.contactId;
    target = ev.matches.find((m) => m.contactId === chosen);
    if (!target) {
      const rows = await contactsByIds(db, [chosen]);
      if (!rows.length) throw new IntakeError(404, "The contact you chose no longer exists.");
      const row = rows[0];
      target = { contactId: row.id, leadId: row.open_lead_id ?? row.any_lead_id, contactName: row.name, companyName: row.company_name, reasons: [], strength: "strong",
        customer: !!(row.organization_id || row.member_org || row.has_sales), organizationId: row.organization_id ?? row.member_org, stage: row.any_stage, row };
    }
  }
  if (opts.resolution?.kind === "create_new") target = undefined;

  if (target) {
    const row = target.row;
    const protectedRecord = target.customer || customerOrgs.length > 0;
    if (automated && protectedRecord) {
      // Existing customer: never a competing prospect, never cold outreach, never overwrite what the customer gave us.
      reasons.push(customerOrgs.length > 1 ? "matches_multiple_customer_accounts" : "existing_customer");
      for (const p of planMerge(n, candidate, row, ch, true)) review("field_conflict", { contactId: row.id, leadId: target.leadId, field: p.field, current: p.current, proposed: p.proposed, reason: "New research data for an existing customer (never applied automatically)." });
      if (customerOrgs.length > 1) review("customer_match", { contactId: row.id, leadId: target.leadId, reason: `Identifiers match ${customerOrgs.length} customer organizations (${customerOrgs.join(", ")}); possible duplicate customer records. Not merged automatically.` });
      if (target.leadId) stmts.push(activity(db, target.leadId, `Research evidence matched this existing customer (${ch}${opts.sourceRef ? `, record ${opts.sourceRef}` : ""}). No prospect was created and no contact details were changed.`, at));
      guard();
      return commit(finish("EXISTING_CONTACT_LINKED", { matches: publicMatches, suppressed, contactId: row.id, leadId: target.leadId }));
    }
    const plan = planMerge(n, candidate, row, ch, protectedRecord);
    if (inboundNote) review("possible_duplicate", { contactId: row.id, leadId: row.open_lead_id ?? row.any_lead_id, reason: inboundNote });
    let applied = 0, verifiedApplied = 0;
    const contactSets: string[] = [], contactBinds: unknown[] = [];
    const companySets: string[] = [], companyBinds: unknown[] = [];
    for (const p of plan) {
      if (p.action === "review") { review("field_conflict", { contactId: row.id, leadId: target.leadId, field: p.field, current: p.current, proposed: p.proposed, reason: p.current ? "Differs from the existing value; the existing value is kept until a person decides." : "Blank on a protected record; not filled automatically." }); continue; }
      if (p.action === "additional") {
        stmts.push(...additionalIdentifier(db, row.id, p.field as "email" | "phone", p.proposed, ch, opts.sourceRef ?? decisionId, confidence, at));
        stmts.push(fieldChange(db, row.id, row.company_id, p.field, null, p.proposed, ch, "additional_identifier", decisionId, actorId, at));
        applied++; continue;
      }
      if (p.field === "name" || p.field === "email" || p.field === "phone") { contactSets.push(`${p.field} = ?`); contactBinds.push(p.field === "email" ? p.proposed.toLowerCase() : p.proposed); }
      else if (row.company_id) { companySets.push(p.field === "company_name" ? "name = ?" : "website = ?"); companyBinds.push(p.proposed); }
      else continue;
      stmts.push(fieldChange(db, row.id, row.company_id, p.field, p.current, p.proposed, ch, p.action === "fill" ? "fill_blank" : "verified_over_unverified", decisionId, actorId, at));
      applied++; if (p.action === "verified_update") verifiedApplied++;
    }
    if (!row.company_id && (candidate.businessName?.trim() || n.domain) && !protectedRecord) {
      const co = newId("co");
      stmts.push(db.prepare(`INSERT INTO companies (id, name, website, location, location_norm, created_at) VALUES (?,?,?,?,?,?)`).bind(co, candidate.businessName?.trim() || n.domain, candidate.website?.trim() || null, locationDisplay(candidate.location), n.location, at));
      stmts.push(db.prepare(`UPDATE contacts SET company_id = ? WHERE id = ? AND company_id IS NULL`).bind(co, row.id));
      stmts.push(fieldChange(db, row.id, co, "company_name", null, candidate.businessName?.trim() || n.domain || "", ch, "fill_blank", decisionId, actorId, at));
      applied++;
    }
    if (contactSets.length) stmts.push(db.prepare(`UPDATE contacts SET ${contactSets.join(", ")} WHERE id = ?`).bind(...contactBinds, row.id));
    if (companySets.length) stmts.push(db.prepare(`UPDATE companies SET ${companySets.join(", ")} WHERE id = ?`).bind(...companyBinds, row.company_id));
    if (contactSets.length) stmts.push(sourceStamp(db, row.id, ch, opts.sourceRef ?? decisionId, confidence, "contact_edit"));

    // Lead: inbound requests continue the open lead (or start a new one for a returning contact); automated data never
    // starts a second lead for a contact that already has one.
    let leadId = row.open_lead_id;
    let leadCreated = false;
    if (inbound || ch === "manual") {
      if (leadId && ch !== "manual") {
        stmts.push(activity(db, leadId, `${opts.lead.isTest ? "[TEST] " : ""}New ${label(ch)} from this contact${opts.lead.interest ? ` (interest: ${opts.lead.interest})` : ""}:\n${(opts.lead.message ?? "").slice(0, 4000)}`, at, opts.lead.activityKind));
        stmts.push(db.prepare(`UPDATE leads SET updated_at = ? WHERE id = ?`).bind(at, leadId));
        if (opts.continuedStatements) stmts.push(...opts.continuedStatements(leadId));
      }
      else { leadId = newId("ld"); leadCreated = true; stmts.push(...newLead(db, leadId, row.id, opts, decisionId, at)); }
    } else if (!row.any_lead_id) { leadId = newId("ld"); leadCreated = true; stmts.push(...newLead(db, leadId, row.id, opts, decisionId, at)); }
    else { leadId = leadId ?? row.any_lead_id; if (leadId) stmts.push(activity(db, leadId, `Matching ${label(ch)} data received${opts.sourceRef ? ` (record ${opts.sourceRef})` : ""}: ${applied ? `${applied} field(s) updated` : "nothing new"}${reviewIds.length ? `, ${reviewIds.length} sent to review` : ""}.`, at)); }
    if (leadId && opts.extraStatements) stmts.push(...opts.extraStatements(leadId));
    // Guard the "no open lead" observation so two simultaneous returning-contact submissions cannot both open a lead.
    if (leadCreated && !row.open_lead_id) stmts.unshift(db.prepare(`INSERT INTO crm_write_guard (ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM leads WHERE contact_id = ? AND merged_into_lead_id IS NULL AND stage IN ${OPEN_STAGES})`).bind(row.id));
    guard();
    const outcome: IntakeOutcome = verifiedApplied ? "VERIFIED_DATA_MERGED" : applied ? "EXISTING_BUSINESS_UPDATED" : leadCreated || reviewIds.length || ch !== "research_agent" && ch !== "crm_api" ? "EXISTING_CONTACT_LINKED" : "NO_CHANGE";
    reasons.push(opts.resolution?.kind === "link" ? "person_chose_link" : `strong_${target.reasons.join("_")}_match`);
    return commit(finish(outcome, { matches: publicMatches, suppressed, contactId: row.id, leadId, leadCreated }));
  }

  // 5. No strong match.
  const sharedCustomerOrgs = [...new Set([...shared.filter((m) => m.customer).map((m) => m.organizationId ?? `paid contact ${m.contactId}`), ...ev.domainCustomers])];
  if (automated && !decided && (customerOrgs.length || sharedCustomerOrgs.length)) {
    reasons.push(customerOrgs.length ? "email_belongs_to_customer_account" : "business_shares_identity_with_customer");
    review("customer_match", { contactId: shared.find((m) => m.customer)?.contactId ?? null, reason: customerOrgs.length
      ? `Email belongs to a customer account (${customerOrgs.join(", ")}) with no CRM contact. Not imported as a prospect.`
      : `Shares a website domain, phone or inbox with existing customer(s) ${sharedCustomerOrgs.join(", ")} (possibly another location). Not imported as a cold prospect.`, candidate: true });
    return commit(finish("EXISTING_CONTACT_LINKED", { matches: publicMatches, suppressed }));
  }
  if (automated && !decided && ev.businessMatches.length) {
    const b = ev.businessMatches[0];
    reasons.push(n.domain && b.domain_norm === n.domain ? "same_domain_and_location" : "same_name_and_company");
    review("possible_duplicate", { contactId: b.id, leadId: b.open_lead_id ?? b.any_lead_id, reason: `Same business identity as an existing record (${reasons[0].replace(/_/g, " ")}) but no shared phone or email.`, candidate: true });
    guard();
    return commit(finish("POSSIBLE_DUPLICATE_REVIEW", { matches: [...publicMatches, ...ev.businessMatches.map((r) => ({ contactId: r.id, leadId: r.open_lead_id ?? r.any_lead_id, contactName: r.name, companyName: r.company_name, reasons: ["domain" as const], strength: "weak" as const, customer: !!(r.organization_id || r.member_org || r.has_sales), organizationId: r.organization_id ?? r.member_org, stage: r.any_stage }))], suppressed }));
  }
  if (automated && !decided && shared.length && !n.domain && !n.company) {
    // A shared identifier and no business identity to tell the businesses apart.
    reasons.push("shared_identifier_without_business_identity");
    review("possible_duplicate", { contactId: shared[0].contactId, leadId: shared[0].leadId, reason: "Phone or email is shared by several businesses and the record has no website or company name to tell which.", candidate: true });
    guard();
    return commit(finish("POSSIBLE_DUPLICATE_REVIEW", { matches: publicMatches, suppressed }));
  }

  // CREATED: a new business/contact/lead. Shared identifiers are linked to the same canonical identity (one ledger row
  // per number), so the new lead is not an independent dialing opportunity.
  const companyId = candidate.businessName?.trim() || n.domain ? newId("co") : null;
  const contactId = newId("ct"), leadId = newId("ld");
  const primaryEmail = n.emails[0]?.key ?? null, primaryPhone = n.phones[0]?.input.value.trim() ?? null;
  if (companyId) {
    const orgId = shared.find((m) => m.organizationId && n.domain && m.row.domain_norm === n.domain)?.organizationId ?? null;
    stmts.push(db.prepare(`INSERT INTO companies (id, name, website, location, location_norm, organization_id, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(companyId, candidate.businessName?.trim() || n.domain, candidate.website?.trim() || null, locationDisplay(candidate.location), n.location, orgId, at));
  }
  stmts.push(db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, user_id, created_at) VALUES (?,?,?,?,?,(SELECT id FROM users WHERE email = ?),?)`)
    .bind(contactId, companyId, candidate.contactName?.trim() || candidate.businessName!.trim(), primaryEmail, primaryPhone, primaryEmail ?? "", at));
  stmts.push(sourceStamp(db, contactId, ch, opts.sourceRef ?? decisionId, confidence, "contact_write"));
  // contacts.email is stored lowercase (CREST-GAP-093); the link keeps the value exactly as supplied, for display.
  if (n.emails[0]) stmts.push(db.prepare(`UPDATE contact_identity_links SET original_value = ? WHERE contact_id = ? AND identity_id = (SELECT id FROM contact_identities WHERE kind = 'email' AND value_norm = ?)`).bind(n.emails[0].input.value.trim(), contactId, n.emails[0].key));
  for (const e of n.emails.slice(1)) stmts.push(...additionalIdentifier(db, contactId, "email", e.input.value, ch, opts.sourceRef ?? decisionId, confidence, at));
  for (const p of n.phones.slice(1)) stmts.push(...additionalIdentifier(db, contactId, "phone", p.input.value, ch, opts.sourceRef ?? decisionId, confidence, at));
  for (const [kind, list] of [["email", n.emails], ["phone", n.phones]] as const) for (const x of list) if (x.input.label) {
    stmts.push(db.prepare(`UPDATE contact_identity_links SET label = ? WHERE contact_id = ? AND identity_id = (SELECT id FROM contact_identities WHERE kind = ? AND value_norm = ?)`).bind(x.input.label, contactId, kind, x.key));
  }
  stmts.push(...newLead(db, leadId, contactId, opts, decisionId, at));
  if (opts.extraStatements) stmts.push(...opts.extraStatements(leadId));
  guard();
  reasons.push(opts.resolution?.kind === "create_new" ? "manual_create_despite_match" : shared.length ? "new_business_sharing_identifier" : "no_match");
  if (shared.length && inbound) review("possible_duplicate", { contactId: shared[0].contactId, leadId: shared[0].leadId, reason: "New inquiry uses a phone number or email already linked to other businesses; created separately. Link or merge if it is the same person." });
  if (shared.length && automated && !decided) review("possible_duplicate", { contactId: shared[0].contactId, leadId: shared[0].leadId, reason: "Created as a separate business that shares a phone number or inbox with an existing record. Confirm they are different businesses." });
  return commit(finish("CREATED", { matches: publicMatches, suppressed, contactId, leadId, leadCreated: true }));
}

const label = (ch: IntakeChannel) => ({ manual: "manual entry", web_form: "contact form", quote_form: "quote request", api_lead: "lead API submission", ai_receptionist: "receptionist call", research_agent: "research-agent record", crm_api: "CRM API record" })[ch];

function activity(db: Db, leadId: string, body: string, at: string, kind: "system" | "call" = "system") {
  return db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,?,?,?)`).bind(newId("act"), leadId, kind, body.slice(0, 5000), at);
}

function newLead(db: Db, leadId: string, contactId: string, o: IntakeOptions, decisionId: string, at: string): DbStatement[] {
  const u = o.lead.utm ?? {};
  const origin = o.channel === "research_agent" || o.channel === "crm_api" ? o.channel : null;
  return [
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, owner_user_id, interest, message, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, landing_page, origin, intake_decision_id, created_at, updated_at)
        VALUES (?,?,?,'new',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(leadId, contactId, o.lead.source, o.lead.ownerUserId ?? null, o.lead.interest ?? null, o.lead.message ?? null, u.utm_source ?? null, u.utm_medium ?? null, u.utm_campaign ?? null,
        u.utm_term ?? null, u.utm_content ?? null, u.referrer ?? null, u.landing_page ?? null, origin, decisionId, at, at),
    activity(db, leadId, o.lead.activityBody ?? `Lead created via ${label(o.channel)}`, at, o.lead.activityKind),
  ];
}

/** Records which channel supplied the contact's primary identifiers (the trigger cannot know). */
function sourceStamp(db: Db, contactId: string, ch: IntakeChannel, ref: string, confidence: number, fromSource: string) {
  return db.prepare(`UPDATE contact_identity_links SET source = ?, source_ref = ?, confidence = ? WHERE contact_id = ? AND role = 'primary' AND source = ? AND removed_at IS NULL`).bind(ch, ref, confidence, contactId, fromSource);
}

function additionalIdentifier(db: Db, contactId: string, kind: "email" | "phone", raw: string, ch: IntakeChannel, ref: string, confidence: number, at: string): DbStatement[] {
  const key = kind === "email" ? emailKey(raw) : phoneKey(raw);
  if (!key) return [];
  return [
    db.prepare(`INSERT INTO contact_identities (id, kind, value_norm, display_value, first_source, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind, value_norm) DO NOTHING`)
      .bind(newId("cid"), kind, key, raw.trim(), ch, at, at),
    db.prepare(`INSERT INTO contact_identity_links (id, identity_id, contact_id, original_value, role, source, source_ref, confidence, created_at, last_seen_at)
        SELECT ?, id, ?, ?, 'additional', ?, ?, ?, ?, ? FROM contact_identities WHERE kind = ? AND value_norm = ?
        ON CONFLICT(identity_id, contact_id) DO UPDATE SET removed_at = NULL, last_seen_at = excluded.last_seen_at`)
      .bind(newId("cil"), contactId, raw.trim(), ch, ref, confidence, at, at, kind, key),
    db.prepare(`UPDATE contact_identities SET shared = 1, updated_at = ? WHERE kind = ? AND value_norm = ? AND shared = 0
        AND (SELECT businesses FROM contact_identity_business_count_v b WHERE b.identity_id = contact_identities.id) > 1`).bind(at, kind, key),
  ];
}

function fieldChange(db: Db, contactId: string, companyId: string | null, field: string, oldV: string | null, newV: string, source: string, rule: string, decisionId: string | null, actorId: string | null, at: string, reviewId: string | null = null) {
  return db.prepare(`INSERT INTO crm_field_changes (id, contact_id, company_id, field, old_value, new_value, source, rule, decision_id, review_id, actor_user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(newId("fch"), contactId, companyId, field, oldV, newV, source, rule, decisionId, reviewId, actorId, at);
}

// ───────────── Review queue ─────────────

export interface ReviewRow {
  id: string; kind: string; status: string; contact_id: string | null; lead_id: string | null; field: string | null; current_value: string | null; proposed_value: string | null;
  proposed_source: string | null; proposed_confidence: number | null; reason: string; created_at: string; contact_name: string | null; company_name: string | null; has_candidate: number;
  customer: number;
}

export async function listReviews(db: Db, opts: { status?: string; page?: number } = {}): Promise<{ rows: ReviewRow[]; total: number; hasNext: boolean }> {
  const status = opts.status && ["open", "applied", "rejected", "created_new", "linked"].includes(opts.status) ? opts.status : "open";
  const page = Math.max(1, Math.min(10_000, opts.page ?? 1));
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE status = ?`).bind(status).first<{ n: number }>())?.n ?? 0;
  const rows = (await db.prepare(`SELECT r.id, r.kind, r.status, r.contact_id, r.lead_id, r.field, r.current_value, r.proposed_value, r.proposed_source, r.proposed_confidence, r.reason, r.created_at,
      c.name AS contact_name, co.name AS company_name, (r.candidate_json IS NOT NULL) AS has_candidate,
      (co.organization_id IS NOT NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = c.user_id AND m.role_id LIKE 'customer_%')) AS customer
      FROM crm_identity_reviews r LEFT JOIN contacts c ON c.id = r.contact_id LEFT JOIN companies co ON co.id = c.company_id
      WHERE r.status = ? ORDER BY r.created_at DESC, r.id LIMIT 26 OFFSET ?`).bind(status, (page - 1) * 25).all<ReviewRow>()).results;
  return { rows: rows.slice(0, 25), total, hasNext: rows.length > 25 };
}

export type ReviewDecision = "apply" | "reject" | "create_new" | "link";

/**
 * Resolves a review item. Applying a change to a customer's record, creating a held candidate and linking require
 * lead.write_all; changes to customer records additionally require the Owner (founder review of risky merges).
 */
export async function resolveReview(db: Db, actor: Actor, id: string, decision: ReviewDecision, note = "", opts: { ip?: string | null } = {}): Promise<{ leadId: string | null }> {
  if (!can(actor, "lead.write_all")) throw new IntakeError(403, "Only staff who can edit all leads can resolve the review queue.");
  const r = await db.prepare(`SELECT r.*, co.organization_id, c.user_id, c.company_id, (SELECT m.organization_id FROM memberships m WHERE m.user_id = c.user_id AND m.role_id LIKE 'customer_%' LIMIT 1) AS member_org,
      EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id AND (l.stage = 'converted' OR EXISTS (SELECT 1 FROM orders o WHERE o.lead_id = l.id))) AS has_sales
      FROM crm_identity_reviews r LEFT JOIN contacts c ON c.id = r.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE r.id = ?`).bind(id)
    .first<{ id: string; kind: string; status: string; contact_id: string | null; lead_id: string | null; field: Field | null; current_value: string | null; proposed_value: string | null; proposed_source: string | null; candidate_json: string | null; organization_id: string | null; member_org: string | null; company_id: string | null; has_sales: number }>();
  if (!r) throw new IntakeError(404, "Review item not found.");
  if (r.status !== "open") throw new IntakeError(409, "This item was already resolved.");
  const customer = !!(r.organization_id || r.member_org || r.has_sales) || r.kind === "customer_match";
  const isOwner = actor.kind === "user" && actor.roles.some((x) => x.role === "owner") && actor.mfaVerified;
  if (customer && decision !== "reject" && !isOwner) throw new IntakeError(403, "Changes to an existing customer's records need the Owner's review.");
  const at = nowIso();
  const close = (status: string) => db.prepare(`UPDATE crm_identity_reviews SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND status = 'open'`).bind(status, actor.userId ?? null, at, note.slice(0, 500) || null, id);
  let leadId: string | null = r.lead_id;
  if (decision === "reject") {
    const res = await db.batch([close("rejected")]);
    if (res[0].meta.changes !== 1) throw new IntakeError(409, "This item was already resolved.");
  } else if (decision === "apply") {
    if (r.kind !== "field_conflict" || !r.field || !r.contact_id || r.proposed_value === null) throw new IntakeError(422, "Only a field change can be applied.");
    const stmts: DbStatement[] = [close("applied")];
    if (r.field === "email" || r.field === "phone") {
      // An identifier is added as an additional identifier; replacing the primary is done by editing the contact.
      stmts.push(...additionalIdentifier(db, r.contact_id, r.field, r.proposed_value, "manual", `review:${id}`, 80, at));
    } else if (r.field === "name") stmts.push(db.prepare(`UPDATE contacts SET name = ? WHERE id = ?`).bind(r.proposed_value, r.contact_id));
    else if (r.company_id) stmts.push(db.prepare(`UPDATE companies SET ${r.field === "company_name" ? "name" : "website"} = ? WHERE id = ?`).bind(r.proposed_value, r.company_id));
    stmts.push(fieldChange(db, r.contact_id, r.company_id, r.field, r.current_value, r.proposed_value, r.proposed_source ?? "review", "review_applied", null, actor.userId ?? null, at, id));
    const res = await db.batch(stmts);
    if (res[0].meta.changes !== 1) throw new IntakeError(409, "This item was already resolved.");
  } else {
    if (!r.candidate_json) throw new IntakeError(422, "This item has no held record to create or link.");
    const held = JSON.parse(r.candidate_json) as { candidate: Candidate; lead: LeadFields; channel: IntakeChannel; sourceRef: string | null };
    const claim = await db.prepare(`UPDATE crm_identity_reviews SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND status = 'open'`)
      .bind(decision === "create_new" ? "created_new" : "linked", actor.userId ?? null, at, note.slice(0, 500) || null, id).run();
    if (claim.meta.changes !== 1) throw new IntakeError(409, "This item was already resolved.");
    try {
      const res = await intake(db, held.candidate, { channel: held.channel, actor, lead: { ...held.lead, source: held.lead.source ?? "manual" }, sourceRef: held.sourceRef,
        resolution: decision === "create_new" ? { kind: "create_new" } : { kind: "link", contactId: r.contact_id ?? "" }, ip: opts.ip });
      leadId = res.leadId;
    } catch (e) {
      await db.prepare(`UPDATE crm_identity_reviews SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?`).bind(id).run();
      throw e;
    }
  }
  await db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(actor.userId ?? null, "user", "crm.identity_review_resolved", "crm_identity_review", id, JSON.stringify({ decision, kind: r.kind, field: r.field, customer }), opts.ip ?? null, at).run();
  return { leadId };
}

// ───────────── Identity panel and analytics ─────────────

export async function contactIdentityPanel(db: Db, contactId: string) {
  const identifiers = (await db.prepare(`SELECT ci.id, ci.kind, ci.value_norm, ci.verification_status, ci.shared, l.original_value, l.role, l.label, l.source, l.confidence, l.verified, l.created_at, l.removed_at,
      (SELECT COUNT(DISTINCT l2.contact_id) FROM contact_identity_links l2 WHERE l2.identity_id = ci.id AND l2.removed_at IS NULL) AS contacts,
      CASE ci.kind WHEN 'phone' THEN EXISTS (SELECT 1 FROM voice_dnc d WHERE d.phone_e164 = ci.value_norm) ELSE EXISTS (SELECT 1 FROM email_suppressions s WHERE s.removed_at IS NULL AND lower(s.email) = ci.value_norm) END AS suppressed,
      p.attempts, p.last_attempt_at, p.last_outcome, p.call_state, p.lease_expires_at, p.reserved_purpose
      FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id LEFT JOIN phone_outreach_ledger p ON p.phone_e164 = ci.value_norm AND ci.kind = 'phone'
      WHERE l.contact_id = ? ORDER BY l.removed_at IS NOT NULL, ci.kind, l.role, l.created_at`).bind(contactId)
    .all<{ id: string; kind: string; value_norm: string; verification_status: string; shared: number; original_value: string; role: string; label: string | null; source: string; confidence: number; verified: number; created_at: string; removed_at: string | null; contacts: number; suppressed: number; attempts: number | null; last_attempt_at: string | null; last_outcome: string | null; call_state: string | null; lease_expires_at: string | null; reserved_purpose: string | null }>()).results;
  const decisions = (await db.prepare(`SELECT d.id, d.channel, d.outcome, d.created_at, d.evidence_json FROM crm_intake_decisions d WHERE d.contact_id = ? ORDER BY d.created_at DESC LIMIT 20`).bind(contactId)
    .all<{ id: string; channel: string; outcome: string; created_at: string; evidence_json: string }>()).results.map((d) => ({ ...d, rule: (JSON.parse(d.evidence_json) as { rule?: string }).rule ?? null }));
  const changes = (await db.prepare(`SELECT f.field, f.old_value, f.new_value, f.source, f.rule, f.created_at, u.display_name AS actor FROM crm_field_changes f LEFT JOIN users u ON u.id = f.actor_user_id WHERE f.contact_id = ? ORDER BY f.created_at DESC LIMIT 30`).bind(contactId)
    .all<{ field: string; old_value: string | null; new_value: string | null; source: string; rule: string; created_at: string; actor: string | null }>()).results;
  const openReviews = (await db.prepare(`SELECT COUNT(*) AS n FROM crm_identity_reviews WHERE contact_id = ? AND status = 'open'`).bind(contactId).first<{ n: number }>())?.n ?? 0;
  return { identifiers, decisions, changes, openReviews };
}

export async function duplicateAnalytics(db: Db, sinceIso: string) {
  const byOutcome = (await db.prepare(`SELECT outcome, channel, COUNT(*) AS n FROM crm_intake_decisions WHERE created_at >= ? GROUP BY outcome, channel ORDER BY n DESC`).bind(sinceIso).all<{ outcome: string; channel: string; n: number }>()).results;
  const totals = Object.fromEntries(INTAKE_OUTCOMES.map((o) => [o, byOutcome.filter((r) => r.outcome === o).reduce((s, r) => s + r.n, 0)])) as Record<IntakeOutcome, number>;
  const identities = await db.prepare(`SELECT SUM(kind = 'phone') AS phones, SUM(kind = 'email') AS emails, SUM(shared) AS shared FROM contact_identities`).first<{ phones: number | null; emails: number | null; shared: number | null }>();
  const reviews = (await db.prepare(`SELECT kind, status, COUNT(*) AS n FROM crm_identity_reviews GROUP BY kind, status`).all<{ kind: string; status: string; n: number }>()).results;
  const ledger = await db.prepare(`SELECT COUNT(*) AS numbers, SUM(reservation_id IS NOT NULL) AS reserved, (SELECT COUNT(*) FROM phone_outreach_events WHERE event = 'denied' AND created_at >= ?) AS denied FROM phone_outreach_ledger`).bind(sinceIso).first<{ numbers: number; reserved: number | null; denied: number }>();
  const prevented = totals.EXISTING_CONTACT_LINKED + totals.EXISTING_BUSINESS_UPDATED + totals.VERIFIED_DATA_MERGED + totals.POSSIBLE_DUPLICATE_REVIEW + totals.NO_CHANGE + totals.SUPPRESSED;
  return { byOutcome, totals, prevented, identities: { phones: identities?.phones ?? 0, emails: identities?.emails ?? 0, shared: identities?.shared ?? 0 }, reviews, ledger: { numbers: ledger?.numbers ?? 0, reserved: ledger?.reserved ?? 0, denied: ledger?.denied ?? 0 } };
}
