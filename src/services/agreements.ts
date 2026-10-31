// Agreement versioning and acceptance records (LEGAL-003, §67).
//
// Every policy in src/content/legal.ts is stored as an immutable version row in `agreements`
// (kind, version, body_text, body_sha256 = SHA-256 of body_text, attorney_reviewed = 0,
// effective_at). body_text is the canonical plain-text rendering of the document exactly as
// customers see it (same facts from business_settings as the public /legal pages).
//
// Drift control:
//  - Developer drift: tests/legal-commerce.test.ts renders every document with the default facts
//    and fails unless a version row with that exact hash exists and is the latest for its kind.
//    Changing legal copy therefore requires a new migration with a new version row
//    (`node --no-warnings scripts/agreement-versions.ts` prints the INSERT statements).
//  - Runtime drift (business settings such as the legal name change what the documents say):
//    recordAcceptance() renders the live text; if no stored version has that hash it stores a new
//    version first (audited), so an acceptance always points at the exact text that was shown.
//
// Nothing here ever sets attorney_reviewed = 1 (LEGAL-004 is a business task, never self-certified).
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { legalDocs, LEGAL_SLUGS, type LegalDoc, type LegalFacts, type LegalSlug } from "../content/legal.ts";
import { audit } from "./security.ts";

export const AGREEMENT_KINDS = {
  privacy: "privacy_policy",
  terms: "terms_of_service",
  "development-agreement": "development_agreement",
  "custom-development-agreement": "custom_development_agreement",
  "maintenance-agreement": "maintenance_agreement",
  "data-processing": "data_processing_addendum",
  refunds: "refund_policy",
  cancellation: "cancellation_policy",
  support: "support_policy",
  "acceptable-use": "acceptable_use_policy",
  accessibility: "accessibility_statement",
  disclosures: "business_disclosures",
} as const satisfies Record<LegalSlug, string>;
export type AgreementKind = (typeof AGREEMENT_KINDS)[LegalSlug];

export const SEED_VERSION = "2026-10-draft-1";

/** Which documents a person accepts at each step (the checkbox label on that step names them). */
export const ACCEPTANCE_SETS = {
  registration: ["terms_of_service", "privacy_policy"],
  quote_acceptance: ["custom_development_agreement", "terms_of_service", "data_processing_addendum"],
  package_checkout: ["development_agreement", "terms_of_service", "refund_policy", "data_processing_addendum"],
  /** CREST-GAP-033: a quoted standard package is governed by the package documents, not the custom development agreement. */
  package_quote_acceptance: ["development_agreement", "terms_of_service", "refund_policy", "data_processing_addendum"],
  maintenance_checkout: ["maintenance_agreement", "terms_of_service", "support_policy", "cancellation_policy", "data_processing_addendum"],
} as const satisfies Record<string, readonly AgreementKind[]>;
export type AcceptanceContext = keyof typeof ACCEPTANCE_SETS;

const SUPPORT_EMAIL = "support@crestmontwebsitedevelopment.com";
const BILLING_EMAIL = "billing@crestmontwebsitedevelopment.com";
const LEGAL_EMAIL = "legal@crestmontwebsitedevelopment.com";

/** Same facts the public /legal pages use (src/routes/public.ts legalFacts). */
export function factsFromSettings(settings: Record<string, string>): LegalFacts {
  return {
    legalName: settings["business.legal_name"]?.trim() || null,
    address: settings["business.address"]?.trim() || null,
    staffedHours: settings["support.staffed_hours"]?.trim() || null,
    supportEmail: settings["contact.email"]?.trim() || SUPPORT_EMAIL,
    legalEmail: LEGAL_EMAIL, billingEmail: BILLING_EMAIL,
  };
}

export function slugForKind(kind: string): LegalSlug | null {
  const hit = (Object.entries(AGREEMENT_KINDS) as [LegalSlug, string][]).find(([, k]) => k === kind);
  return hit ? hit[0] : null;
}
export function kindForSlugOrKind(s: string): { slug: LegalSlug; kind: AgreementKind } | null {
  if (s in AGREEMENT_KINDS) return { slug: s as LegalSlug, kind: AGREEMENT_KINDS[s as LegalSlug] };
  const slug = slugForKind(s);
  return slug ? { slug, kind: AGREEMENT_KINDS[slug] } : null;
}

/** Canonical plain-text rendering. Line prefixes: "# " title, "## " heading, "- " list item; other lines are paragraphs. */
export function canonicalText(d: LegalDoc): string {
  const out = [`# ${d.title}`, d.summary];
  for (const s of d.sections) {
    out.push("", `## ${s.heading}`);
    for (const p of s.paras ?? []) out.push(p);
    for (const li of s.list ?? []) out.push(`- ${li}`);
  }
  return out.join("\n") + "\n";
}

export interface RenderedAgreement { slug: LegalSlug; kind: AgreementKind; title: string; text: string; sha256: string }

export async function renderAll(facts: LegalFacts): Promise<RenderedAgreement[]> {
  const docs = legalDocs(facts);
  return Promise.all(LEGAL_SLUGS.map(async (slug) => {
    const text = canonicalText(docs[slug]);
    return { slug, kind: AGREEMENT_KINDS[slug], title: docs[slug].title, text, sha256: await sha256Hex(text) };
  }));
}

export interface AgreementRow { id: string; kind: string; version: string; title: string | null; body_sha256: string; body_text: string | null; attorney_reviewed: number; effective_at: string | null; created_at: string | null }

/** Latest effective version per kind (latest effective_at, then created_at). */
export async function latestVersions(db: Db): Promise<Map<string, AgreementRow>> {
  const rows = (await db.prepare(`SELECT * FROM agreements WHERE effective_at IS NOT NULL ORDER BY kind, effective_at DESC, created_at DESC`).all<AgreementRow>()).results;
  const m = new Map<string, AgreementRow>();
  for (const r of rows) if (!m.has(r.kind)) m.set(r.kind, r);
  return m;
}

export interface DriftItem { slug: LegalSlug; kind: AgreementKind; title: string; currentSha: string; storedVersion: string | null; storedSha: string | null }

/** Documents whose current rendering (for these facts) is not the latest stored version. */
export async function agreementDrift(db: Db, facts: LegalFacts): Promise<DriftItem[]> {
  const latest = await latestVersions(db);
  return (await renderAll(facts)).filter((r) => latest.get(r.kind)?.body_sha256 !== r.sha256).map((r) => ({
    slug: r.slug, kind: r.kind, title: r.title, currentSha: r.sha256, storedVersion: latest.get(r.kind)?.version ?? null, storedSha: latest.get(r.kind)?.body_sha256 ?? null,
  }));
}

/** Returns the stored version whose text matches what is shown now; stores a new version first if needed. */
export async function currentVersion(db: Db, r: RenderedAgreement, now: Date, actorUserId: string | null): Promise<AgreementRow> {
  const existing = await db.prepare(`SELECT * FROM agreements WHERE kind = ? AND body_sha256 = ? ORDER BY effective_at DESC LIMIT 1`).bind(r.kind, r.sha256).first<AgreementRow>();
  const latest = (await latestVersions(db)).get(r.kind);
  if (existing && latest && latest.id === existing.id) return existing;
  // Either the text has never been stored, or an older text is being shown again (e.g. a business
  // setting was cleared): store it as a new, latest version so the history stays linear and exact.
  const at = nowIso(() => now);
  const version = `${at.slice(0, 10)}-r${r.sha256.slice(0, 10)}${existing ? `-${at.slice(11, 19).replace(/:/g, "")}` : ""}`;
  await db.prepare(`INSERT OR IGNORE INTO agreements (id, kind, version, title, body_sha256, body_text, attorney_reviewed, effective_at, created_at) VALUES (?,?,?,?,?,?,0,?,?)`)
    .bind(newId("agr"), r.kind, version, r.title, r.sha256, r.text, at, at).run();
  const row = (await db.prepare(`SELECT * FROM agreements WHERE kind = ? AND version = ?`).bind(r.kind, version).first<AgreementRow>())!;
  await audit(db, { actorUserId, actorKind: actorUserId ? "user" : "system", action: "agreement.version_created", subjectType: "agreement", subjectId: row.id, details: { kind: r.kind, version, sha256: r.sha256, reason: "rendered text differs from the latest stored version" } });
  return row;
}

/**
 * Records that `userId` accepted the documents for `context` on behalf of `organizationId`.
 * Callers must only call this after the person ticked the explicit acceptance checkbox.
 */
export async function recordAcceptance(ctx: AppContext, a: { userId: string; organizationId: string; context: AcceptanceContext; contextId?: string | null }) {
  const p = await prepareAcceptance(ctx, a);
  await ctx.db.batch(p.statements);
  await auditAcceptance(ctx, a, p.versions);
  return p.versions;
}

/**
 * The exact versions shown for `context` and the acceptance INSERTs, for a caller that must commit them in the same
 * batch as the business change they belong to (CREST-GAP-032). `guard` (SQL) limits each insert to a committed change.
 */
export async function prepareAcceptance(ctx: AppContext, a: { userId: string; organizationId: string; context: AcceptanceContext; contextId?: string | null }, guard?: { sql: string; binds: unknown[] }) {
  const now = ctx.now();
  const rendered = await renderAll(factsFromSettings(ctx.settings));
  const kinds = ACCEPTANCE_SETS[a.context] as readonly string[];
  const versions: AgreementRow[] = [];
  for (const r of rendered.filter((x) => kinds.includes(x.kind))) versions.push(await currentVersion(ctx.db, r, now, a.userId));
  const at = nowIso(() => now);
  const statements = versions.map((v) => ctx.db.prepare(`INSERT INTO agreement_acceptances (id, agreement_id, user_id, organization_id, ip, accepted_at, context_type, context_id, user_agent) SELECT ?,?,?,?,?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ""}`)
    .bind(newId("acc"), v.id, a.userId, a.organizationId, ctx.ip, at, a.context, a.contextId ?? null, ctx.req.headers.get("user-agent")?.slice(0, 300) ?? null, ...(guard?.binds ?? [])));
  return { versions, statements };
}

export async function auditAcceptance(ctx: AppContext, a: { userId: string; organizationId: string; context: AcceptanceContext; contextId?: string | null }, versions: AgreementRow[]) {
  await audit(ctx.db, { actorUserId: a.userId, action: "agreements.accepted", subjectType: "organization", subjectId: a.organizationId, organizationId: a.organizationId, ip: ctx.ip,
    details: { context: a.context, contextId: a.contextId ?? null, versions: versions.map((v) => ({ kind: v.kind, version: v.version, sha256: v.body_sha256 })) } });
}

export interface AcceptanceRow { id: string; accepted_at: string; ip: string | null; context_type: string | null; context_id: string | null; kind: string; version: string; title: string | null; body_sha256: string; attorney_reviewed: number; user_name: string; user_email: string; organization_id: string; org_name: string }

const ACCEPTANCE_SELECT = `SELECT x.id, x.accepted_at, x.ip, x.context_type, x.context_id, a.kind, a.version, a.title, a.body_sha256, a.attorney_reviewed,
  u.display_name AS user_name, u.email AS user_email, x.organization_id, o.name AS org_name
  FROM agreement_acceptances x JOIN agreements a ON a.id = x.agreement_id JOIN users u ON u.id = x.user_id JOIN organizations o ON o.id = x.organization_id`;

export async function orgAcceptances(db: Db, organizationId: string, page: { limit: number; offset: number }): Promise<AcceptanceRow[]> {
  return (await db.prepare(`${ACCEPTANCE_SELECT} WHERE x.organization_id = ? ORDER BY x.accepted_at DESC, x.rowid DESC LIMIT ? OFFSET ?`).bind(organizationId, page.limit + 1, page.offset).all<AcceptanceRow>()).results;
}

export async function allAcceptances(db: Db, f: { organizationId?: string }, page: { limit: number; offset: number }): Promise<AcceptanceRow[]> {
  const where = f.organizationId ? `WHERE x.organization_id = ?` : "";
  const binds: unknown[] = f.organizationId ? [f.organizationId] : [];
  return (await db.prepare(`${ACCEPTANCE_SELECT} ${where} ORDER BY x.accepted_at DESC, x.rowid DESC LIMIT ? OFFSET ?`).bind(...binds, page.limit + 1, page.offset).all<AcceptanceRow>()).results;
}

export async function versionsWithCounts(db: Db) {
  return (await db.prepare(`SELECT a.id, a.kind, a.version, a.title, a.body_sha256, a.attorney_reviewed, a.effective_at, (SELECT COUNT(*) FROM agreement_acceptances x WHERE x.agreement_id = a.id) AS acceptances
    FROM agreements a ORDER BY a.kind, a.effective_at DESC, a.created_at DESC`).all<{ id: string; kind: string; version: string; title: string | null; body_sha256: string; attorney_reviewed: number; effective_at: string | null; acceptances: number }>()).results;
}

export async function versionByKind(db: Db, kind: string, version: string) {
  return db.prepare(`SELECT * FROM agreements WHERE kind = ? AND version = ?`).bind(kind, version).first<AgreementRow>();
}
export async function versionsForKind(db: Db, kind: string) {
  return (await db.prepare(`SELECT * FROM agreements WHERE kind = ? ORDER BY effective_at DESC, created_at DESC`).bind(kind).all<AgreementRow>()).results;
}

/** Parses canonical text back into blocks for display. */
export function textBlocks(text: string): ({ t: "h2"; s: string } | { t: "p"; s: string } | { t: "ul"; items: string[] })[] {
  const out: ({ t: "h2"; s: string } | { t: "p"; s: string } | { t: "ul"; items: string[] })[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("# ")) continue;
    if (line.startsWith("## ")) out.push({ t: "h2", s: line.slice(3) });
    else if (line.startsWith("- ")) {
      const last = out.at(-1);
      if (last && last.t === "ul") last.items.push(line.slice(2)); else out.push({ t: "ul", items: [line.slice(2)] });
    } else out.push({ t: "p", s: line });
  }
  return out;
}

/** SQL for new version rows (used by scripts/agreement-versions.ts when legal copy changes). */
export function versionInsertSql(rows: { kind: string; version: string; title: string; text: string; sha256: string; effectiveAt: string }[]): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `INSERT INTO agreements (id, kind, version, title, body_sha256, body_text, attorney_reviewed, effective_at, created_at) VALUES\n` +
    rows.map((r) => `(${q(`agr_${r.kind}_${r.version}`.replace(/[^A-Za-z0-9_]/g, "_"))}, ${q(r.kind)}, ${q(r.version)}, ${q(r.title)}, ${q(r.sha256)}, ${q(r.text)}, 0, ${q(r.effectiveAt)}, ${q(r.effectiveAt)})`).join(",\n") + ";\n";
}
