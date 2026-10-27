// Website CMS (CMS-001..003, §59). Content lives in cms_entries / cms_revisions.
// Lifecycle: draft → (pending_founder_approval for pricing presentation) → published; the previous
// published revision becomes archived, so the full history is kept. Every write is audited.
// The CMS edits presentation text only. Prices are never stored here and always come from
// src/domain/catalog.ts, so no CMS action can change what checkout charges (CMS-003, CAT-007).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { AppContext } from "../app/context.ts";
import { can, type Actor } from "../domain/authz.ts";
import { findProhibitedClaims } from "../domain/catalog.ts";
import { cmsKeyDef, CMS_KEYS, type CmsKeyDef } from "../content/registry.ts";

export type RevisionStatus = "draft" | "pending_founder_approval" | "published" | "archived";
export interface Revision {
  id: string; entry_id: string; body_json: string; status: RevisionStatus; requires_founder_approval: number;
  author_user_id: string; approved_by: string | null; created_at: string; published_at: string | null; note: string | null;
  author_name?: string | null; approver_name?: string | null;
}

export class CmsError extends Error {
  readonly status: number;
  readonly issues: string[];
  constructor(status: number, message: string, issues: string[] = []) { super(message); this.status = status; this.issues = issues; }
}

const PRICE_PATTERN = /\$\s?\d|\b\d[\d,]*(\.\d+)?\s?(usd|dollars?)\b/i;

/** Validates submitted fields against the key's definition. Returns cleaned values or throws CmsError(422). */
export function validateFields(def: CmsKeyDef, input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const issues: string[] = [];
  for (const f of def.fields) {
    const val = (input[f.name] ?? "").replace(/\r\n/g, "\n").trim();
    if (!val) { issues.push(`${f.label} is required`); continue; }
    if (val.length > f.max) issues.push(`${f.label} must be at most ${f.max} characters`);
    if (f.kind === "text" && val.includes("\n")) issues.push(`${f.label} must be a single line`);
    const claims = findProhibitedClaims(val);
    if (claims.length) issues.push(`${f.label} contains a prohibited claim (no guaranteed outcomes, ad/social management, 24/7 human support or scarcity claims)`);
    if (def.sensitivePricing && PRICE_PATTERN.test(val)) issues.push(`${f.label} must not contain prices — prices are shown from the server-side catalog and cannot be edited in the CMS`);
    out[f.name] = val;
  }
  if (issues.length) throw new CmsError(422, "Please fix the content", issues);
  return out;
}

async function ensureEntry(db: Db, key: string): Promise<string> {
  const existing = await db.prepare(`SELECT id FROM cms_entries WHERE key = ?`).bind(key).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId("cms");
  await db.prepare(`INSERT INTO cms_entries (id, key, published_revision_id) VALUES (?,?,NULL) ON CONFLICT(key) DO NOTHING`).bind(id, key).run();
  return (await db.prepare(`SELECT id FROM cms_entries WHERE key = ?`).bind(key).first<{ id: string }>())!.id;
}

/** Saves a draft revision. Pricing presentation drafts are marked for Founder approval. */
export async function saveDraft(db: Db, actor: Actor, key: string, input: Record<string, string>, opts: { note?: string; ip?: string | null } = {}) {
  if (!can(actor, "cms.edit")) throw new CmsError(403, "You do not have permission to edit website content.");
  const def = cmsKeyDef(key);
  if (!def) throw new CmsError(404, "Unknown content key");
  const fields = validateFields(def, input);
  const entryId = await ensureEntry(db, key);
  const id = newId("rev");
  const at = nowIso();
  const status: RevisionStatus = def.sensitivePricing ? "pending_founder_approval" : "draft";
  const note = (opts.note ?? "").trim().slice(0, 300) || null;
  const stmts = [
    db.prepare(`INSERT INTO cms_revisions (id, entry_id, body_json, status, requires_founder_approval, author_user_id, approved_by, created_at, note) VALUES (?,?,?,?,?,?,NULL,?,?)`)
      .bind(id, entryId, JSON.stringify(fields), status, def.sensitivePricing ? 1 : 0, actor.userId ?? null, at, note),
    db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(actor.userId ?? null, actor.kind, "cms.draft_saved", "cms_revision", id, JSON.stringify({ key, status }), opts.ip ?? null, at),
  ];
  if (def.sensitivePricing) {
    // Tell every Owner that a pricing-presentation change awaits their approval.
    const owners = (await db.prepare(`SELECT DISTINCT user_id FROM memberships WHERE role_id = 'owner'`).all<{ user_id: string }>()).results;
    for (const o of owners) {
      stmts.push(db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(newId("ntf"), o.user_id, "cms.pricing_approval", "cms_revision", id, `Pricing presentation change awaiting your approval (${def.label}).`, at));
    }
  }
  await db.batch(stmts);
  return { revisionId: id, status };
}

/** Publishes a revision. Pricing presentation revisions need the Owner-only pricing.change permission. */
export async function publishRevision(db: Db, actor: Actor, revisionId: string, opts: { ip?: string | null } = {}) {
  if (!can(actor, "cms.publish")) throw new CmsError(403, "You do not have permission to publish website content.");
  const rev = await db.prepare(`SELECT r.*, e.key, e.published_revision_id FROM cms_revisions r JOIN cms_entries e ON e.id = r.entry_id WHERE r.id = ?`).bind(revisionId)
    .first<Revision & { key: string; published_revision_id: string | null }>();
  if (!rev) throw new CmsError(404, "Revision not found");
  const def = cmsKeyDef(rev.key);
  if (!def) throw new CmsError(404, "Unknown content key");
  if (rev.status === "published") throw new CmsError(409, "This revision is already published.");
  if ((rev.requires_founder_approval || def.sensitivePricing) && !can(actor, "pricing.change")) {
    throw new CmsError(403, "Pricing presentation changes require Founder approval. Only the Owner can publish this revision.");
  }
  // Re-validate stored content against current rules before it goes live.
  validateFields(def, JSON.parse(rev.body_json));
  const at = nowIso();
  const stmts = [
    db.prepare(`UPDATE cms_revisions SET status = 'archived' WHERE entry_id = ? AND status = 'published'`).bind(rev.entry_id),
    db.prepare(`UPDATE cms_revisions SET status = 'published', published_at = ?, approved_by = ? WHERE id = ?`).bind(at, actor.userId ?? null, revisionId),
    db.prepare(`UPDATE cms_entries SET published_revision_id = ? WHERE id = ?`).bind(revisionId, rev.entry_id),
    db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(actor.userId ?? null, actor.kind, def.sensitivePricing ? "cms.pricing_presentation_approved" : "cms.published", "cms_revision", revisionId,
        JSON.stringify({ key: rev.key, previous: rev.published_revision_id }), opts.ip ?? null, at),
  ];
  await db.batch(stmts);
  return { key: rev.key };
}

/** Removes the published revision so the page falls back to the repository default. */
export async function unpublishEntry(db: Db, actor: Actor, key: string, opts: { ip?: string | null } = {}) {
  if (!can(actor, "cms.publish")) throw new CmsError(403, "You do not have permission to publish website content.");
  const def = cmsKeyDef(key);
  if (!def) throw new CmsError(404, "Unknown content key");
  if (def.sensitivePricing && !can(actor, "pricing.change")) throw new CmsError(403, "Pricing presentation changes require Founder approval.");
  const entry = await db.prepare(`SELECT id, published_revision_id FROM cms_entries WHERE key = ?`).bind(key).first<{ id: string; published_revision_id: string | null }>();
  if (!entry?.published_revision_id) throw new CmsError(409, "Nothing is published for this content.");
  await db.batch([
    db.prepare(`UPDATE cms_revisions SET status = 'archived' WHERE id = ?`).bind(entry.published_revision_id),
    db.prepare(`UPDATE cms_entries SET published_revision_id = NULL WHERE id = ?`).bind(entry.id),
    db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(actor.userId ?? null, actor.kind, "cms.reverted_to_default", "cms_entry", entry.id, JSON.stringify({ key }), opts.ip ?? null, nowIso()),
  ]);
}

export async function history(db: Db, key: string): Promise<Revision[]> {
  return (await db.prepare(`SELECT r.*, a.display_name AS author_name, p.display_name AS approver_name FROM cms_revisions r
    JOIN cms_entries e ON e.id = r.entry_id LEFT JOIN users a ON a.id = r.author_user_id LEFT JOIN users p ON p.id = r.approved_by
    WHERE e.key = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 100`).bind(key).all<Revision>()).results;
}

export async function getRevision(db: Db, id: string) {
  return db.prepare(`SELECT r.*, e.key FROM cms_revisions r JOIN cms_entries e ON e.id = r.entry_id WHERE r.id = ?`).bind(id).first<Revision & { key: string }>();
}

/** Overview for the CMS list page: per key, published revision time and the newest unpublished revision. */
export async function overview(db: Db) {
  const rows = (await db.prepare(`SELECT e.key, pr.published_at, pr.id AS published_id,
      (SELECT r.status FROM cms_revisions r WHERE r.entry_id = e.id AND r.status IN ('draft','pending_founder_approval') ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS pending_status,
      (SELECT r.created_at FROM cms_revisions r WHERE r.entry_id = e.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_edit
    FROM cms_entries e LEFT JOIN cms_revisions pr ON pr.id = e.published_revision_id`).all<{ key: string; published_at: string | null; published_id: string | null; pending_status: RevisionStatus | null; last_edit: string | null }>()).results;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return CMS_KEYS.map((def) => ({ def, state: byKey.get(def.key) ?? null }));
}

/**
 * Loads published content for the given keys, merged over repository defaults. A signed-in staff
 * member with cms.edit can append ?preview=<revisionId> to any public page to see an unpublished
 * revision in place (CMS-001 preview).
 */
export async function loadContent(ctx: AppContext, keys: string[]): Promise<{ get: (key: string) => Record<string, string>; previewing: string | null }> {
  const out = new Map<string, Record<string, string>>();
  for (const k of keys) out.set(k, { ...(cmsKeyDef(k)?.defaults ?? {}) });
  if (keys.length) {
    const ph = keys.map(() => "?").join(",");
    const rows = (await ctx.db.prepare(`SELECT e.key, r.body_json FROM cms_entries e JOIN cms_revisions r ON r.id = e.published_revision_id WHERE e.key IN (${ph})`)
      .bind(...keys).all<{ key: string; body_json: string }>()).results;
    for (const r of rows) out.set(r.key, { ...out.get(r.key), ...safeParse(r.body_json) });
  }
  let previewing: string | null = null;
  const previewId = ctx.url.searchParams.get("preview");
  if (previewId && ctx.actor && ctx.sessionMfaVerified && can(ctx.actor, "cms.edit")) {
    const rev = await getRevision(ctx.db, previewId);
    if (rev && keys.includes(rev.key)) {
      out.set(rev.key, { ...out.get(rev.key), ...safeParse(rev.body_json) });
      previewing = rev.key;
    }
  }
  return { get: (key) => out.get(key) ?? { ...(cmsKeyDef(key)?.defaults ?? {}) }, previewing };
}

function safeParse(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  } catch { return {}; }
}

