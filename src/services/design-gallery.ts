// The ONE premium design gallery (Founder directive, 2026-11-02).
//
// One authoritative table, one set of rules, read by both the Owner Dashboard and the AI. The dashboard decides what
// is eligible; the AI only ever asks this module, so there is no second gallery to drift (J01, J02).
//
// Every package draws from the same gallery and is held to the same visual standard. `eligibleReferences` takes no
// package argument, deliberately: a Starter customer's website is not allowed to be designed from worse references
// than a Premium one (J24). Packages differ in scope -- pages, revision rounds, features -- not in design quality.
//
// Selection rules that matter:
//   - only APPROVED, ai_eligible, not-deleted rows are ever returned (J03, J04, J05);
//   - a reference with no rights basis is never AI-eligible, whatever its status says (J17, J18);
//   - a bounded number is returned (default 6) because feeding the whole gallery into a model's context degrades it
//     and costs tokens for nothing (J23);
//   - what was selected is recorded against the job with the gallery version it saw (J07, J08, J20).

import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";
import { classifyIndustry, weightFor, WEIGHT, type IndustryClassification } from "./industry-match.ts";

export const GALLERY_TARGET = 50;
/** References handed to one build. Enough to synthesise from, few enough to keep the model's context useful. */
export const SELECTION_SIZE = 6;
export const STATUSES = ["PENDING_REVIEW", "APPROVED", "DISABLED", "REJECTED"] as const;
export type ReferenceStatus = (typeof STATUSES)[number];
export const RIGHTS = ["owner_supplied", "licensed", "public_permitted", "own_work", "unverified"] as const;
export type RightsBasis = (typeof RIGHTS)[number];

export interface DesignReference {
  id: string; title: string; source_url: string | null; source_name: string | null;
  industry: string; style_tags_json: string; status: ReferenceStatus; ai_eligible: number;
  desktop_key: string | null; mobile_key: string | null; tablet_key: string | null;
  typography_notes: string | null; layout_notes: string | null; color_notes: string | null;
  animation_notes: string | null; responsive_notes: string | null; quality_notes: string | null;
  rights_basis: RightsBasis; rights_note: string | null; captured_at: string | null;
  checksum: string | null; version: number; created_by: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; deleted_by: string | null;
}

export const tags = (r: Pick<DesignReference, "style_tags_json">): string[] => {
  try { const v = JSON.parse(r.style_tags_json); return Array.isArray(v) ? v.map(String).slice(0, 12) : []; } catch { return []; }
};

/** A rights basis that permits Crestmont to learn from the reference internally. */
export const rightsCleared = (b: string): boolean => b !== "unverified";

export async function galleryVersion(db: Db): Promise<number> {
  const r = await db.prepare(`SELECT version FROM design_gallery_state WHERE id = 1`).first<{ version: number }>();
  return r?.version ?? 1;
}

/** Any change to eligibility bumps the shared version, so a cache can detect staleness in one comparison. */
async function bumpVersion(db: Db, at: string): Promise<number> {
  await db.prepare(`UPDATE design_gallery_state SET version = version + 1, updated_at = ? WHERE id = 1`).bind(at).run();
  return galleryVersion(db);
}

async function recordEvent(db: Db, referenceId: string, action: string, actorUserId: string | null, note: string | null, before: unknown, after: unknown, at: string) {
  await db.prepare(`INSERT INTO design_reference_events (reference_id, at, action, actor_user_id, note, before_json, after_json) VALUES (?,?,?,?,?,?,?)`)
    .bind(referenceId, at, action, actorUserId, note, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)).run();
}

export interface GalleryCounts { total: number; approved: number; pending: number; disabled: number; rejected: number; aiEligible: number }

export async function counts(db: Db): Promise<GalleryCounts> {
  const r = await db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'PENDING_REVIEW' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'DISABLED' THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN status = 'APPROVED' AND ai_eligible = 1 AND rights_basis <> 'unverified' THEN 1 ELSE 0 END) AS aiEligible
    FROM design_references WHERE deleted_at IS NULL`).first<Record<string, number>>();
  return {
    total: r?.total ?? 0, approved: r?.approved ?? 0, pending: r?.pending ?? 0,
    disabled: r?.disabled ?? 0, rejected: r?.rejected ?? 0, aiEligible: r?.aiEligible ?? 0,
  };
}

export interface ListFilter { status?: ReferenceStatus | "ALL"; industry?: string; tag?: string; q?: string; limit?: number; offset?: number }

export async function listReferences(db: Db, f: ListFilter = {}): Promise<{ rows: DesignReference[]; total: number }> {
  const where: string[] = ["deleted_at IS NULL"];
  const bind: unknown[] = [];
  if (f.status && f.status !== "ALL") { where.push("status = ?"); bind.push(f.status); }
  if (f.industry) { where.push("industry = ?"); bind.push(f.industry); }
  if (f.q) { where.push("(title LIKE ? OR source_name LIKE ? OR quality_notes LIKE ?)"); const like = `%${f.q.slice(0, 60)}%`; bind.push(like, like, like); }
  if (f.tag) { where.push("style_tags_json LIKE ?"); bind.push(`%"${f.tag.slice(0, 40)}"%`); }
  const clause = where.join(" AND ");
  // Both of these arrive from a query string, so they can be anything. An out-of-range or fractional value must not
  // reach SQL: 1e20 is not a representable integer to bind, and the page answered 500 instead of an empty list.
  const limit = Math.max(1, Math.min(200, Math.floor(Number(f.limit) || 60)));
  const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(f.offset) || 0)));
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM design_references WHERE ${clause}`).bind(...bind).first<{ n: number }>())?.n ?? 0;
  const rows = (await db.prepare(`SELECT * FROM design_references WHERE ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).bind(...bind, limit, offset).all<DesignReference>()).results;
  return { rows, total };
}

export async function getReference(db: Db, id: string): Promise<DesignReference | null> {
  return db.prepare(`SELECT * FROM design_references WHERE id = ? AND deleted_at IS NULL`).bind(id).first<DesignReference>();
}

export interface NewReference {
  title: string; industry: string; styleTags?: string[]; sourceUrl?: string | null; sourceName?: string | null;
  desktopKey?: string | null; mobileKey?: string | null; tabletKey?: string | null;
  rightsBasis?: RightsBasis; rightsNote?: string | null; checksum?: string | null;
  typographyNotes?: string | null; layoutNotes?: string | null; colorNotes?: string | null;
  animationNotes?: string | null; responsiveNotes?: string | null; qualityNotes?: string | null;
}

/**
 * Add a reference. It starts PENDING_REVIEW: nothing an automated capture finds becomes usable without a person
 * saying so (5.6, J16). A duplicate checksum is refused rather than silently creating a second row (J15).
 */
export async function addReference(db: Db, r: NewReference, actorUserId: string | null, now = new Date()): Promise<string> {
  const title = String(r.title ?? "").trim();
  if (title.length < 2 || title.length > 200) throw new HttpError(422, "Give the reference a title (2–200 characters).");
  const industry = String(r.industry ?? "").trim().toLowerCase();
  if (!industry) throw new HttpError(422, "Choose an industry for the reference.");
  if (r.sourceUrl) {
    let u: URL;
    try { u = new URL(r.sourceUrl); } catch { throw new HttpError(422, "The source URL is not a valid address."); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(422, "The source URL must be http or https.");
  }
  const rights = (r.rightsBasis && (RIGHTS as readonly string[]).includes(r.rightsBasis) ? r.rightsBasis : "unverified") as RightsBasis;
  if (r.checksum) {
    const dup = await db.prepare(`SELECT id, title FROM design_references WHERE checksum = ? AND deleted_at IS NULL`).bind(r.checksum).first<{ id: string; title: string }>();
    if (dup) throw new HttpError(409, `That image is already in the gallery as "${dup.title}".`);
  }
  const at = now.toISOString();
  const id = newId("dref");
  await db.prepare(`INSERT INTO design_references (id, title, source_url, source_name, industry, style_tags_json, status, ai_eligible,
      desktop_key, mobile_key, tablet_key, typography_notes, layout_notes, color_notes, animation_notes, responsive_notes, quality_notes,
      rights_basis, rights_note, captured_at, checksum, version, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?, 'PENDING_REVIEW', 1, ?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
    .bind(id, title, r.sourceUrl ?? null, r.sourceName ?? null, industry, JSON.stringify((r.styleTags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12)),
      r.desktopKey ?? null, r.mobileKey ?? null, r.tabletKey ?? null,
      r.typographyNotes ?? null, r.layoutNotes ?? null, r.colorNotes ?? null, r.animationNotes ?? null, r.responsiveNotes ?? null, r.qualityNotes ?? null,
      rights, r.rightsNote ?? null, at, r.checksum ?? null, actorUserId, at, at).run();
  await recordEvent(db, id, "created", actorUserId, null, undefined, { title, industry, rights }, at);
  await audit(db, { actorUserId, action: "design_gallery.reference_added", subjectType: "design_reference", subjectId: id, details: { title, industry, rights } });
  await bumpVersion(db, at);
  return id;
}

export type Decision = "approve" | "reject" | "disable" | "enable";

/** Approve, reject, disable or re-enable. Every transition is recorded and bumps the gallery version. */
export async function decide(db: Db, id: string, decision: Decision, actorUserId: string | null, note: string | null = null, now = new Date()): Promise<DesignReference> {
  const before = await getReference(db, id);
  if (!before) throw new HttpError(404, "That design reference does not exist.");
  const status: ReferenceStatus = decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : decision === "disable" ? "DISABLED" : "APPROVED";
  if (decision === "enable" && before.status !== "DISABLED") throw new HttpError(409, "Only a disabled reference can be re-enabled.");
  const at = now.toISOString();
  await db.prepare(`UPDATE design_references SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(status, at, id).run();
  await recordEvent(db, id, decision === "approve" ? "approved" : decision === "reject" ? "rejected" : decision === "disable" ? "disabled" : "enabled",
    actorUserId, note, { status: before.status }, { status }, at);
  const auditAction = { approve: "design_gallery.reference_approved", reject: "design_gallery.reference_rejected", disable: "design_gallery.reference_disabled", enable: "design_gallery.reference_enabled" }[decision];
  await audit(db, { actorUserId, action: auditAction, subjectType: "design_reference", subjectId: id, details: { decision, from: before.status, to: status, note } });
  await bumpVersion(db, at);
  return (await getReference(db, id))!;
}

export interface ReferenceEdit {
  title?: string; industry?: string; styleTags?: string[]; sourceUrl?: string | null;
  qualityNotes?: string | null; typographyNotes?: string | null; layoutNotes?: string | null;
  colorNotes?: string | null; animationNotes?: string | null; responsiveNotes?: string | null;
  rightsBasis?: RightsBasis; rightsNote?: string | null; aiEligible?: boolean; status?: ReferenceStatus;
}

export async function editReference(db: Db, id: string, e: ReferenceEdit, actorUserId: string | null, now = new Date()): Promise<DesignReference> {
  const before = await getReference(db, id);
  if (!before) throw new HttpError(404, "That design reference does not exist.");
  const sets: string[] = [], bind: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); bind.push(v); };
  if (e.title !== undefined) { const t = String(e.title).trim(); if (t.length < 2 || t.length > 200) throw new HttpError(422, "Give the reference a title (2–200 characters)."); put("title", t); }
  if (e.industry !== undefined) { const i = String(e.industry).trim().toLowerCase(); if (!i) throw new HttpError(422, "Choose an industry."); put("industry", i); }
  if (e.styleTags !== undefined) put("style_tags_json", JSON.stringify(e.styleTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12)));
  if (e.sourceUrl !== undefined) put("source_url", e.sourceUrl || null);
  for (const [k, col] of [["qualityNotes", "quality_notes"], ["typographyNotes", "typography_notes"], ["layoutNotes", "layout_notes"], ["colorNotes", "color_notes"], ["animationNotes", "animation_notes"], ["responsiveNotes", "responsive_notes"], ["rightsNote", "rights_note"]] as const) {
    const v = (e as Record<string, unknown>)[k];
    if (v !== undefined) put(col, v === null ? null : String(v).slice(0, 2000));
  }
  if (e.rightsBasis !== undefined) { if (!(RIGHTS as readonly string[]).includes(e.rightsBasis)) throw new HttpError(422, "Unknown rights basis."); put("rights_basis", e.rightsBasis); }
  if (e.aiEligible !== undefined) put("ai_eligible", e.aiEligible ? 1 : 0);
  if (e.status !== undefined) { if (!(STATUSES as readonly string[]).includes(e.status)) throw new HttpError(422, "Unknown status."); put("status", e.status); }
  if (!sets.length) return before;
  const at = now.toISOString();
  await db.prepare(`UPDATE design_references SET ${sets.join(", ")}, updated_at = ?, version = version + 1 WHERE id = ?`).bind(...bind, at, id).run();
  await recordEvent(db, id, "edited", actorUserId, null, before, e, at);
  await audit(db, { actorUserId, action: "design_gallery.reference_edited", subjectType: "design_reference", subjectId: id, details: { fields: Object.keys(e) } });
  await bumpVersion(db, at);
  return (await getReference(db, id))!;
}

/**
 * Remove a reference. A soft delete: selection stops immediately and the row stays for audit history, which is what
 * "preserve appropriate audit history" requires. A removed reference can never be selected again, including after a
 * restart, because eligibility is read from the database on every selection and nothing caches it (J03).
 */
export async function removeReference(db: Db, id: string, actorUserId: string | null, now = new Date()): Promise<void> {
  const before = await getReference(db, id);
  if (!before) throw new HttpError(404, "That design reference does not exist.");
  const at = now.toISOString();
  await db.prepare(`UPDATE design_references SET deleted_at = ?, deleted_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(at, actorUserId, at, id).run();
  await recordEvent(db, id, "removed", actorUserId, null, { status: before.status }, null, at);
  await audit(db, { actorUserId, action: "design_gallery.reference_removed", subjectType: "design_reference", subjectId: id, details: { status: before.status, title: before.title } });
  await bumpVersion(db, at);
}

/** Bulk approve or reject, for a batch of captures reviewed together (5.6). */
export async function decideMany(db: Db, ids: string[], decision: Decision, actorUserId: string | null, now = new Date()): Promise<number> {
  let n = 0;
  for (const id of ids.slice(0, 200)) { try { await decide(db, id, decision, actorUserId, "bulk decision", now); n++; } catch { /* skip the ones that do not apply */ } }
  return n;
}

// ── what the AI may use ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every reference the AI is allowed to see. This is the ONLY way the builder reaches the gallery, so the dashboard's
 * decisions bind it by construction rather than by convention.
 *
 * Takes no package argument on purpose: all packages share one gallery and one quality standard.
 */
export async function eligibleReferences(db: Db): Promise<DesignReference[]> {
  return (await db.prepare(`SELECT * FROM design_references
    WHERE deleted_at IS NULL AND status = 'APPROVED' AND ai_eligible = 1 AND rights_basis <> 'unverified'
    ORDER BY updated_at DESC`).all<DesignReference>()).results;
}

export interface SelectionInput { industry?: string | null; styleHints?: string[]; size?: number }
export interface SelectedReference { reference: DesignReference; weight: number; why: string }
export interface Selection {
  references: DesignReference[];
  /** Per-reference relevance, in the same order, for the audit record and the runner's prompt. */
  scored: SelectedReference[];
  classification: IndustryClassification;
  galleryVersion: number;
  reason: string;
}

/**
 * Choose a small, relevant set for one build.
 *
 * RELEVANCE OUTRANKS VARIETY (Founder directive 2026-11-03). This used to take the best reference per industry
 * first, which guaranteed six different sectors and meant a junk-removal website was shown luxury fashion and
 * restaurants while five construction references sat unused. Now the customer's own trade fills the set, then
 * related trades, then design-pattern categories, and unrelated sectors only when nothing better is left.
 *
 * Deterministic given the same gallery and inputs, so a build is reproducible and a selection is defensible.
 */
export async function selectForBuild(db: Db, input: SelectionInput = {}): Promise<Selection> {
  const all = await eligibleReferences(db);
  const version = await galleryVersion(db);
  const size = Math.max(1, Math.min(12, input.size ?? SELECTION_SIZE));
  const hints = (input.styleHints ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const classification = classifyIndustry(input.industry, hints);
  if (!all.length) {
    return { references: [], scored: [], classification, galleryVersion: version,
      reason: "the gallery has no approved, AI-eligible reference, so the build proceeds without references" };
  }

  const scored = all.map((r) => {
    const w = weightFor(classification, r.industry);
    const t = tags(r);
    // Style agreement refines the order WITHIN a relevance band; it can never lift an unrelated sector above a
    // relevant one, which is the whole point of the band being worth 100.
    let style = 0;
    for (const h of hints) if (t.includes(h)) style += 3;
    for (const h of hints) if ((r.quality_notes ?? "").toLowerCase().includes(h)) style += 1;
    const why = w >= WEIGHT.related ? `${r.industry} matches the customer's trade (weight ${w})`
      : w > WEIGHT.unrelated ? `${r.industry} is a design pattern, not the customer's trade (weight ${w})`
      : `${r.industry} is unrelated to the customer's trade`;
    return { reference: r, weight: w, why, score: w * 100 + style };
  }).sort((a, b) => b.score - a.score || a.reference.id.localeCompare(b.reference.id));

  const chosen = scored.slice(0, size);
  const relevant = chosen.filter((c) => c.weight >= WEIGHT.related).length;
  const unrelated = chosen.filter((c) => c.weight === WEIGHT.unrelated).length;
  return {
    references: chosen.map((c) => c.reference),
    scored: chosen.map(({ reference, weight, why }) => ({ reference, weight, why })),
    classification, galleryVersion: version,
    reason: `${chosen.length} of ${all.length} eligible reference(s): ${relevant} from the customer's trade or a related one, `
      + `${chosen.length - relevant - unrelated} design-pattern, ${unrelated} unrelated. ${classification.reason}`,
  };
}

/** Record what a build was given, so the selection is auditable afterwards. */
export async function recordSelection(db: Db, jobId: string, projectId: string, sel: Selection, now = new Date()): Promise<void> {
  const at = now.toISOString();
  const by = new Map(sel.scored.map((s) => [s.reference.id, s]));
  for (const r of sel.references) {
    const s = by.get(r.id);
    await db.prepare(`INSERT INTO design_reference_uses (job_id, project_id, reference_id, gallery_version, selected_at, reason, relevance, matched_category)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(jobId, projectId, r.id, sel.galleryVersion, at, s?.why ?? sel.reason, s?.weight ?? null, r.industry).run();
  }
}

/**
 * The runner fetched this reference's image bytes into the build workspace. Delivery is not interpretation: it
 * says the file arrived, nothing more.
 */
export async function markImageDelivered(db: Db, jobId: string, referenceId: string): Promise<void> {
  await db.prepare(`UPDATE design_reference_uses SET image_delivered = 1 WHERE job_id = ? AND reference_id = ?`).bind(jobId, referenceId).run();
}

/**
 * A vision-capable model was actually sent these images. Only the runner knows this, and only after the call: it
 * is the one fact that makes "the builder looked at the gallery" checkable rather than asserted.
 */
export async function markImagesSeen(db: Db, jobId: string, referenceIds: string[], model: string): Promise<number> {
  let n = 0;
  for (const id of referenceIds) {
    const r = await db.prepare(`UPDATE design_reference_uses SET model_saw = 1, seen_by_model = ? WHERE job_id = ? AND reference_id = ? AND image_delivered = 1`)
      .bind(model.slice(0, 120), jobId, id).run();
    n += r.meta?.changes ?? 0;
  }
  return n;
}

export type ImageVariant = "desktop" | "tablet" | "mobile";
const VARIANTS: ImageVariant[] = ["desktop", "tablet", "mobile"];

/**
 * The bytes of one gallery image, for the runner that holds this job's lease.
 *
 * Scoped to references THIS job was actually given: a runner cannot walk the gallery, and a reference the owner
 * has since disabled or whose rights were withdrawn stops being served even mid-build, because the eligibility
 * conditions are re-checked here rather than trusted from selection time.
 */
export async function galleryImageForJob(
  db: Db, storage: { get(key: string): Promise<{ body: ReadableStream | ArrayBuffer | Uint8Array; contentType: string; size: number } | null> },
  jobId: string, referenceId: string, variant: ImageVariant,
): Promise<{ base64: string; contentType: string; size: number } | null> {
  if (!VARIANTS.includes(variant)) throw new HttpError(400, "Unknown image variant");
  const row = await db.prepare(`SELECT r.desktop_key, r.tablet_key, r.mobile_key, r.status, r.ai_eligible, r.rights_basis, r.deleted_at
    FROM design_reference_uses u JOIN design_references r ON r.id = u.reference_id
    WHERE u.job_id = ? AND u.reference_id = ?`).bind(jobId, referenceId)
    .first<{ desktop_key: string | null; tablet_key: string | null; mobile_key: string | null; status: string; ai_eligible: number; rights_basis: string; deleted_at: string | null }>();
  if (!row) return null; // not selected for this job: never served
  if (row.deleted_at || row.status !== "APPROVED" || !row.ai_eligible || !rightsCleared(row.rights_basis)) return null;
  const key = variant === "desktop" ? row.desktop_key : variant === "tablet" ? row.tablet_key : row.mobile_key;
  if (!key) return null;
  const obj = await storage.get(key);
  if (!obj) return null;
  const bytes = obj.body instanceof Uint8Array ? obj.body
    : obj.body instanceof ArrayBuffer ? new Uint8Array(obj.body)
    : new Uint8Array(await new Response(obj.body as ReadableStream).arrayBuffer());
  await markImageDelivered(db, jobId, referenceId);
  return { base64: Buffer.from(bytes).toString("base64"), contentType: obj.contentType, size: bytes.length };
}

/** The full audit row for a job: what was selected, how relevant, and how far each image actually travelled. */
export interface ReferenceUse {
  reference_id: string; title: string; industry: string; gallery_version: number; selected_at: string;
  reason: string | null; relevance: number | null; matched_category: string | null;
  image_delivered: number; model_saw: number; seen_by_model: string | null;
}
export async function selectionAudit(db: Db, jobId: string): Promise<ReferenceUse[]> {
  return (await db.prepare(`SELECT u.reference_id, r.title, r.industry, u.gallery_version, u.selected_at, u.reason,
      u.relevance, u.matched_category, u.image_delivered, u.model_saw, u.seen_by_model
    FROM design_reference_uses u JOIN design_references r ON r.id = u.reference_id
    WHERE u.job_id = ? ORDER BY u.relevance DESC, u.id`).bind(jobId).all<ReferenceUse>()).results;
}

export async function selectionForJob(db: Db, jobId: string): Promise<{ reference_id: string; title: string; gallery_version: number; selected_at: string }[]> {
  return (await db.prepare(`SELECT u.reference_id, r.title, u.gallery_version, u.selected_at
    FROM design_reference_uses u JOIN design_references r ON r.id = u.reference_id
    WHERE u.job_id = ? ORDER BY u.id`).bind(jobId).all<{ reference_id: string; title: string; gallery_version: number; selected_at: string }>()).results;
}
