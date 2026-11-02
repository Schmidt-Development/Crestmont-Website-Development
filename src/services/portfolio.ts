// Portfolio management (PORT-004..007, §13–§16). Projects are database-backed; screenshots are
// stored through the storage adapter and recorded in `files` under the internal organization.
// Publishing is refused while genuine screenshots are missing or the relationship to Crestmont
// is undocumented — the honest pending state is shown instead of any substitute imagery.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { can, type Actor } from "../domain/authz.ts";
import { findProhibitedClaims } from "../domain/catalog.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { validateUpload, sanitizeFilename } from "../adapters/storage.ts";
import { toHex } from "../lib/crypto.ts";

export interface PortfolioProject {
  id: string; slug: string; name: string; industry: string; live_url: string; relationship: string; description: string;
  verified_features_json: string; technology_summary: string | null; desktop_screenshot_file_id: string | null; mobile_screenshot_file_id: string | null;
  screenshot_captured_at: string | null; link_verified_at: string | null; link_verified_by: string | null; position: number; published: number; updated_at: string;
  relationship_documented_at: string | null; relationship_documented_by: string | null; relationship_evidence: string | null; published_at: string | null;
  /** Isolated demonstration deployment (never the production site) — migration 0038. */
  demo_url: string | null; demo_status: "none" | "ready" | "unavailable"; demo_verified_at: string | null; demo_verified_by: string | null; demo_revision: string | null;
  /** Genuine screenshots bundled under /assets/portfolio/ (survive preview database rebuilds; no R2 needed). */
  poster_desktop_asset: string | null; poster_mobile_asset: string | null; poster_tablet_asset: string | null;
  /** FD-13 explicit, recorded opt-in by the website owner (migration 0068). */
  portfolio_consent_at?: string | null; portfolio_consent_by?: string | null; portfolio_consent_method?: "written" | "portal" | null;
  portfolio_consent_evidence?: string | null; portfolio_consent_recorded_by?: string | null; portfolio_consent_withdrawn_at?: string | null;
}
export interface Testimonial { id: string; portfolio_project_id: string | null; author_name: string; body: string; verification_evidence: string; verified_by: string; published: number; created_at: string | null }

export class PortfolioError extends Error {
  readonly status: number;
  readonly issues: string[];
  constructor(status: number, message: string, issues: string[] = []) { super(message); this.status = status; this.issues = issues; }
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function guard(actor: Actor) {
  if (!can(actor, "portfolio.manage")) throw new PortfolioError(403, "You do not have permission to manage the portfolio.");
}

export const features = (p: Pick<PortfolioProject, "verified_features_json">): string[] => {
  try { const v = JSON.parse(p.verified_features_json); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
};

/** Reasons a project cannot be published right now (empty = publishable). */
export function publishBlockers(p: PortfolioProject): string[] {
  const out: string[] = [];
  if (!p.desktop_screenshot_file_id && !p.poster_desktop_asset) out.push("A genuine desktop screenshot of the live site has not been uploaded.");
  if (!p.mobile_screenshot_file_id && !p.poster_mobile_asset) out.push("A genuine mobile screenshot of the live site has not been uploaded.");
  if (!p.relationship_documented_at || /pending/i.test(p.relationship)) out.push("Crestmont's relationship to this business has not been documented.");
  if (!p.link_verified_at) out.push("The live link has not been verified.");
  // FD-13: never shown without the owner's explicit, recorded opt-in (and never after it is withdrawn).
  if (!p.portfolio_consent_at || p.portfolio_consent_withdrawn_at) out.push("The website owner's explicit opt-in to portfolio display has not been recorded.");
  return out;
}

/** FD-13: records the website owner's explicit opt-in. Silence or a contract alone is not consent. */
export async function recordPortfolioConsent(db: Db, actor: Actor, id: string, input: { givenBy: string; method: string; givenOn: string; evidence: string }, ip?: string | null) {
  guard(actor);
  const issues: string[] = [];
  const by = input.givenBy.trim(), ev = input.evidence.trim();
  if (by.length < 3 || by.length > 200) issues.push("Name the person who gave consent and their role at the business (3–200 characters)");
  if (input.method !== "written" && input.method !== "portal") issues.push("Choose how consent was given");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.givenOn) || Number.isNaN(Date.parse(input.givenOn))) issues.push("Enter the date consent was given");
  else if (input.givenOn > new Date().toISOString().slice(0, 10)) issues.push("The consent date cannot be in the future");
  if (ev.length < 10 || ev.length > 2000) issues.push("Describe where the consent record is kept (10–2000 characters)");
  if (issues.length) throw new PortfolioError(422, "Please fix the consent details", issues);
  if (!(await getById(db, id))) throw new PortfolioError(404, "Project not found");
  await db.batch([
    db.prepare(`UPDATE portfolio_projects SET portfolio_consent_at = ?, portfolio_consent_by = ?, portfolio_consent_method = ?, portfolio_consent_evidence = ?, portfolio_consent_recorded_by = ?, portfolio_consent_withdrawn_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(`${input.givenOn}T00:00:00.000Z`, by, input.method, ev, actor.userId ?? null, nowIso(), id),
    auditStmt(db, actor, "portfolio.consent_recorded", id, { givenBy: by, method: input.method, givenOn: input.givenOn }, ip),
  ]);
}

/** FD-13: the owner withdrew consent. The entry is unpublished at once; the history stays in the audit log. */
export async function withdrawPortfolioConsent(db: Db, actor: Actor, id: string, note: string, ip?: string | null) {
  guard(actor);
  if (note.trim().length < 5) throw new PortfolioError(422, "Record how the withdrawal was received", ["Describe how the owner withdrew consent (at least 5 characters)"]);
  if (!(await getById(db, id))) throw new PortfolioError(404, "Project not found");
  const at = nowIso();
  await db.batch([
    db.prepare(`UPDATE portfolio_projects SET portfolio_consent_withdrawn_at = ?, published = 0, updated_at = ? WHERE id = ?`).bind(at, at, id),
    auditStmt(db, actor, "portfolio.consent_withdrawn", id, { note: note.trim().slice(0, 500), unpublished: true }, ip),
  ]);
}

// ── Interactive demos (isolated deployments only) ──
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
export const POSTER_RE = /^\/assets\/portfolio\/[a-z0-9]+(-[a-z0-9]+)*\.webp$/;

/** Approved demo origins from configuration (PORTFOLIO_DEMO_ORIGINS, comma/space separated). Anything that is
 *  not a bare https origin is ignored, so a misconfiguration can never widen what the site will frame. */
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
export function approvedDemoOrigins(config: string | undefined | null, opts: { allowLocal?: boolean } = {}): Set<string> {
  return new Set((config ?? "").split(/[\s,]+/).map((o) => o.trim().toLowerCase()).filter((o) => ORIGIN_RE.test(o) || (opts.allowLocal === true && LOCAL_RE.test(o))));
}
/** Development only: local demo servers on http://localhost / 127.0.0.1 may be approved. Never staging/production. */
export const allowLocalDemos = (environment: string | undefined) => environment === "development";
const originOf = (u: string | null | undefined): string | null => { try { const x = new URL(u ?? ""); const o = x.origin.toLowerCase(); return x.protocol === "https:" || LOCAL_RE.test(o) ? o : null; } catch { return null; } };

export type DemoState = { kind: "embed"; url: string; origin: string } | { kind: "unavailable"; reason: string } | { kind: "none" };
/** Whether a project's demo may be embedded right now: ready, verified, on an approved origin, not production. */
export function demoState(p: Pick<PortfolioProject, "demo_url" | "demo_status" | "demo_verified_at" | "live_url">, approved: Set<string>): DemoState {
  if (p.demo_status === "none" || !p.demo_url) return { kind: "none" };
  const origin = originOf(p.demo_url);
  if (p.demo_status === "unavailable") return { kind: "unavailable", reason: "The interactive demo is temporarily unavailable." };
  if (!origin || !approved.has(origin) || origin === originOf(p.live_url)) return { kind: "unavailable", reason: "The interactive demo is not available in this environment." };
  if (!p.demo_verified_at) return { kind: "unavailable", reason: "The interactive demo has not been verified yet." };
  return { kind: "embed", url: p.demo_url, origin };
}

export interface DemoInput { demo_url: string; demo_status: string; demo_revision: string; verified_on: string; poster_desktop_asset: string; poster_mobile_asset: string; poster_tablet_asset?: string }
export function validateDemo(input: DemoInput, liveUrl: string, approved: Set<string>): { values: { demo_url: string | null; demo_status: "none" | "ready" | "unavailable"; demo_revision: string | null; verified_on: string | null; poster_desktop_asset: string | null; poster_mobile_asset: string | null; poster_tablet_asset: string | null }; issues: string[] } {
  const t = (x: string | undefined) => (x ?? "").trim();
  const issues: string[] = [];
  const status = t(input.demo_status) || "none";
  if (!["none", "ready", "unavailable"].includes(status)) issues.push("Demo status must be none, ready or unavailable");
  const url = t(input.demo_url) || null;
  if (url) {
    const origin = originOf(url);
    if (!origin) issues.push("Demo link must be a full https:// address");
    else if (!approved.has(origin)) issues.push(`The demo origin ${origin} is not on the approved list (PORTFOLIO_DEMO_ORIGINS)`);
    else if (origin === originOf(liveUrl)) issues.push("The demo must be a separate demonstration deployment, never the production website");
  }
  if (status !== "none" && !url) issues.push("A demo link is required unless the status is none");
  const revision = t(input.demo_revision) || null;
  if (revision && (revision.length > 120 || !/^[A-Za-z0-9._\/@-]+$/.test(revision))) issues.push("Source revision must look like repository@commit (letters, numbers, . _ / @ -)");
  const verified = t(input.verified_on) || null;
  if (verified && (!/^\d{4}-\d{2}-\d{2}$/.test(verified) || Number.isNaN(Date.parse(verified)) || Date.parse(verified) > Date.now() + 86_400_000)) issues.push("Demo verification date must be a valid date, not in the future");
  if (status === "ready" && !verified) issues.push("Record the date the demo was verified before marking it ready");
  const pd = t(input.poster_desktop_asset) || null, pm = t(input.poster_mobile_asset) || null, pt = t(input.poster_tablet_asset) || null;
  if ([pd, pm, pt].some((x) => x && !POSTER_RE.test(x))) issues.push("Bundled posters must be /assets/portfolio/<name>.webp");
  return { values: { demo_url: url, demo_status: status as "none" | "ready" | "unavailable", demo_revision: revision, verified_on: verified, poster_desktop_asset: pd, poster_mobile_asset: pm, poster_tablet_asset: pt }, issues };
}

export async function setDemo(db: Db, actor: Actor, id: string, input: DemoInput, approved: Set<string>, ip?: string | null) {
  guard(actor);
  const p = await getById(db, id);
  if (!p) throw new PortfolioError(404, "Project not found");
  const { values: v, issues } = validateDemo(input, p.live_url, approved);
  if (issues.length) throw new PortfolioError(422, "Please fix the demo details", issues);
  const urlChanged = v.demo_url !== p.demo_url;
  // A changed demo link must be verified again: keep the previous verification only when the link is unchanged
  // and no new date was entered.
  const verifiedAt = v.verified_on ? `${v.verified_on}T00:00:00.000Z` : urlChanged ? null : p.demo_verified_at;
  const status = v.demo_status === "ready" && !verifiedAt ? "unavailable" : v.demo_status;
  await db.batch([
    db.prepare(`UPDATE portfolio_projects SET demo_url = ?, demo_status = ?, demo_revision = ?, demo_verified_at = ?, demo_verified_by = CASE WHEN ? THEN ? ELSE demo_verified_by END,
      poster_desktop_asset = ?, poster_mobile_asset = ?, poster_tablet_asset = ?, updated_at = ? WHERE id = ?`)
      .bind(v.demo_url, status, v.demo_revision, verifiedAt, v.verified_on ? 1 : 0, actor.userId ?? null, v.poster_desktop_asset, v.poster_mobile_asset, v.poster_tablet_asset, nowIso(), id),
    auditStmt(db, actor, "portfolio.demo_updated", id, { demoUrl: v.demo_url, status, revision: v.demo_revision, verifiedOn: v.verified_on, posters: [v.poster_desktop_asset, v.poster_tablet_asset, v.poster_mobile_asset] }, ip),
  ]);
}

export async function listPublished(db: Db): Promise<PortfolioProject[]> {
  return (await db.prepare(`SELECT * FROM portfolio_projects WHERE published = 1 ORDER BY position, name`).all<PortfolioProject>()).results;
}
export async function listAll(db: Db): Promise<PortfolioProject[]> {
  return (await db.prepare(`SELECT * FROM portfolio_projects ORDER BY position, name`).all<PortfolioProject>()).results;
}
export async function getBySlug(db: Db, slug: string) {
  return db.prepare(`SELECT * FROM portfolio_projects WHERE slug = ?`).bind(slug).first<PortfolioProject>();
}
export async function getById(db: Db, id: string) {
  return db.prepare(`SELECT * FROM portfolio_projects WHERE id = ?`).bind(id).first<PortfolioProject>();
}
export async function publishedTestimonials(db: Db, projectId: string): Promise<Testimonial[]> {
  return (await db.prepare(`SELECT * FROM testimonials WHERE portfolio_project_id = ? AND published = 1 ORDER BY rowid`).bind(projectId).all<Testimonial>()).results;
}
export async function testimonialsFor(db: Db, projectId: string): Promise<(Testimonial & { verifier: string | null })[]> {
  return (await db.prepare(`SELECT t.*, u.display_name AS verifier FROM testimonials t LEFT JOIN users u ON u.id = t.verified_by WHERE t.portfolio_project_id = ? ORDER BY t.rowid`).bind(projectId).all<Testimonial & { verifier: string | null }>()).results;
}

/** True only when the file is the current screenshot of a published project (public media gate). */
export async function isPublicPortfolioFile(db: Db, fileId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM portfolio_projects WHERE published = 1 AND (desktop_screenshot_file_id = ? OR mobile_screenshot_file_id = ?) LIMIT 1`).bind(fileId, fileId).first<{ ok: number }>();
  return !!row;
}

export interface ProjectInput { name: string; slug: string; industry: string; live_url: string; description: string; features: string; technology_summary: string; relationship: string }

export function validateProject(input: ProjectInput): { values: Omit<ProjectInput, "features"> & { featuresJson: string }; issues: string[] } {
  const issues: string[] = [];
  const v = Object.fromEntries(Object.entries(input).map(([k, x]) => [k, (x ?? "").trim()])) as unknown as ProjectInput;
  if (v.name.length < 2 || v.name.length > 120) issues.push("Name must be 2–120 characters");
  if (!SLUG.test(v.slug) || v.slug.length > 80) issues.push("Slug must be lowercase letters, numbers and hyphens");
  if (v.industry.length < 2 || v.industry.length > 120) issues.push("Industry must be 2–120 characters");
  let url: URL | null = null;
  try { url = new URL(v.live_url); } catch { /* handled below */ }
  if (!url || url.protocol !== "https:") issues.push("Live link must be a full https:// address");
  if (v.description.length < 20 || v.description.length > 4000) issues.push("Description must be 20–4000 characters");
  if (v.relationship.length < 5 || v.relationship.length > 300) issues.push("Relationship must be 5–300 characters");
  if (v.technology_summary.length > 600) issues.push("Technology summary must be at most 600 characters");
  const feats = v.features.split("\n").map((f) => f.trim()).filter(Boolean);
  if (feats.length > 30 || feats.some((f) => f.length > 200)) issues.push("Up to 30 verified features, each at most 200 characters");
  const claimText = [v.description, v.technology_summary, ...feats].join("\n");
  if (findProhibitedClaims(claimText).length) issues.push("Content contains a prohibited claim");
  return { values: { ...v, featuresJson: JSON.stringify(feats) }, issues };
}

export async function createProject(db: Db, actor: Actor, input: ProjectInput, ip?: string | null) {
  guard(actor);
  const { values, issues } = validateProject(input);
  if (issues.length) throw new PortfolioError(422, "Please fix the project details", issues);
  if (await getBySlug(db, values.slug)) throw new PortfolioError(422, "Please fix the project details", ["That slug is already used by another project"]);
  const id = newId("pf");
  const at = nowIso();
  const pos = (await db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM portfolio_projects`).first<{ n: number }>())!.n;
  await db.batch([
    db.prepare(`INSERT INTO portfolio_projects (id, slug, name, industry, live_url, relationship, description, verified_features_json, technology_summary, position, published, updated_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`).bind(id, values.slug, values.name, values.industry, values.live_url, values.relationship, values.description, values.featuresJson, values.technology_summary || null, pos, at, at),
    auditStmt(db, actor, "portfolio.created", id, { slug: values.slug }, ip),
  ]);
  return { id };
}

export async function updateProject(db: Db, actor: Actor, id: string, input: ProjectInput, ip?: string | null) {
  guard(actor);
  const p = await getById(db, id);
  if (!p) throw new PortfolioError(404, "Project not found");
  const { values, issues } = validateProject(input);
  if (values.slug !== p.slug && (await getBySlug(db, values.slug))) issues.push("That slug is already used by another project");
  if (issues.length) throw new PortfolioError(422, "Please fix the project details", issues);
  const linkChanged = values.live_url !== p.live_url;
  const relChanged = values.relationship !== p.relationship;
  const stmts = [
    db.prepare(`UPDATE portfolio_projects SET slug=?, name=?, industry=?, live_url=?, relationship=?, description=?, verified_features_json=?, technology_summary=?, updated_at=?,
      link_verified_at = CASE WHEN ? THEN NULL ELSE link_verified_at END, link_verified_by = CASE WHEN ? THEN NULL ELSE link_verified_by END WHERE id = ?`)
      .bind(values.slug, values.name, values.industry, values.live_url, values.relationship, values.description, values.featuresJson, values.technology_summary || null, nowIso(), linkChanged ? 1 : 0, linkChanged ? 1 : 0, id),
    auditStmt(db, actor, "portfolio.updated", id, { linkChanged, relationshipChanged: relChanged }, ip),
  ];
  // A project whose link changed must be re-verified before it can stay public.
  if (linkChanged && p.published) stmts.push(db.prepare(`UPDATE portfolio_projects SET published = 0 WHERE id = ?`).bind(id), auditStmt(db, actor, "portfolio.unpublished", id, { reason: "live link changed" }, ip));
  await db.batch(stmts);
}

export async function recordLinkVerification(db: Db, actor: Actor, id: string, dateIso: string, ip?: string | null) {
  guard(actor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || Number.isNaN(Date.parse(dateIso))) throw new PortfolioError(422, "Enter the verification date", ["Verification date must be a valid date"]);
  if (Date.parse(dateIso) > Date.now() + 86_400_000) throw new PortfolioError(422, "Enter the verification date", ["Verification date cannot be in the future"]);
  const p = await getById(db, id);
  if (!p) throw new PortfolioError(404, "Project not found");
  await db.batch([
    db.prepare(`UPDATE portfolio_projects SET link_verified_at = ?, link_verified_by = ?, updated_at = ? WHERE id = ?`).bind(`${dateIso}T00:00:00.000Z`, actor.userId ?? null, nowIso(), id),
    auditStmt(db, actor, "portfolio.link_verified", id, { date: dateIso, url: p.live_url }, ip),
  ]);
}

export async function documentRelationship(db: Db, actor: Actor, id: string, relationship: string, evidence: string, ip?: string | null) {
  guard(actor);
  const issues: string[] = [];
  const rel = relationship.trim(), ev = evidence.trim();
  if (rel.length < 5 || rel.length > 300) issues.push("Relationship must be 5–300 characters");
  if (/pending/i.test(rel)) issues.push("Describe the documented relationship (remove “pending”)");
  if (ev.length < 10 || ev.length > 2000) issues.push("Describe the documentation (where it is kept, who signed, date) in 10–2000 characters");
  if (issues.length) throw new PortfolioError(422, "Please fix the relationship details", issues);
  if (!(await getById(db, id))) throw new PortfolioError(404, "Project not found");
  await db.batch([
    db.prepare(`UPDATE portfolio_projects SET relationship = ?, relationship_evidence = ?, relationship_documented_at = ?, relationship_documented_by = ?, updated_at = ? WHERE id = ?`)
      .bind(rel, ev, nowIso(), actor.userId ?? null, nowIso(), id),
    auditStmt(db, actor, "portfolio.relationship_documented", id, { relationship: rel }, ip),
  ]);
}

export async function uploadScreenshot(db: Db, storage: StorageAdapter | null, actor: Actor, id: string, kind: "desktop" | "mobile", file: File, capturedOn: string, ip?: string | null) {
  guard(actor);
  if (!storage) throw new PortfolioError(503, "File storage is not configured in this environment, so screenshots cannot be uploaded yet.");
  const p = await getById(db, id);
  if (!p) throw new PortfolioError(404, "Project not found");
  const issues: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(capturedOn) || Number.isNaN(Date.parse(capturedOn))) issues.push("Enter the date the screenshot was captured from the live site");
  const name = sanitizeFilename(file.name || "screenshot");
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (!IMAGE_EXT.has(ext)) issues.push("Screenshots must be PNG, JPEG or WebP images");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!issues.length) {
    const check = validateUpload(name, bytes);
    if (!check.ok) issues.push(check.reason);
  }
  if (issues.length) throw new PortfolioError(422, "Screenshot not accepted", issues);
  const org = await db.prepare(`SELECT id FROM organizations WHERE kind = 'internal' ORDER BY created_at LIMIT 1`).first<{ id: string }>();
  if (!org) throw new PortfolioError(409, "The internal Crestmont organization record is missing.");
  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const fileId = newId("file");
  const key = `portfolio/${p.id}/${kind}/${fileId}.${ext === "jpeg" ? "jpg" : ext}`;
  const sha = toHex(await crypto.subtle.digest("SHA-256", bytes));
  await storage.put(key, bytes, contentType);
  const col = kind === "desktop" ? "desktop_screenshot_file_id" : "mobile_screenshot_file_id";
  const previous = p[col];
  const at = nowIso();
  const stmts = [
    db.prepare(`INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, folder, uploaded_by, created_at) VALUES (?,?,NULL,?,?,?,?,?,'pending','portfolio',?,?)`)
      .bind(fileId, org.id, key, name, contentType, bytes.length, sha, actor.userId ?? null, at),
    db.prepare(`UPDATE portfolio_projects SET ${col} = ?, screenshot_captured_at = ?, updated_at = ? WHERE id = ?`).bind(fileId, `${capturedOn}T00:00:00.000Z`, at, id),
    auditStmt(db, actor, previous ? "portfolio.screenshot_replaced" : "portfolio.screenshot_uploaded", id, { kind, fileId, previous, sha256: sha }, ip),
  ];
  if (previous) stmts.push(db.prepare(`UPDATE files SET replaced_by = ? WHERE id = ?`).bind(fileId, previous));
  await db.batch(stmts);
  return { fileId };
}

export async function setPublished(db: Db, actor: Actor, id: string, publish: boolean, ip?: string | null) {
  guard(actor);
  const p = await getById(db, id);
  if (!p) throw new PortfolioError(404, "Project not found");
  if (publish) {
    const blockers = publishBlockers(p);
    if (blockers.length) throw new PortfolioError(409, "This project cannot be published yet", blockers);
  }
  await db.batch([
    db.prepare(`UPDATE portfolio_projects SET published = ?, published_at = CASE WHEN ? THEN ? ELSE published_at END, updated_at = ? WHERE id = ?`).bind(publish ? 1 : 0, publish ? 1 : 0, nowIso(), nowIso(), id),
    auditStmt(db, actor, publish ? "portfolio.published" : "portfolio.unpublished", id, {}, ip),
  ]);
}

export async function move(db: Db, actor: Actor, id: string, dir: "up" | "down", ip?: string | null) {
  guard(actor);
  const all = await listAll(db);
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) throw new PortfolioError(404, "Project not found");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= all.length) return;
  [all[i], all[j]] = [all[j], all[i]];
  await db.batch([
    ...all.map((p, idx) => db.prepare(`UPDATE portfolio_projects SET position = ? WHERE id = ?`).bind(idx + 1, p.id)),
    auditStmt(db, actor, "portfolio.reordered", id, { dir }, ip),
  ]);
}

export async function addTestimonial(db: Db, actor: Actor, projectId: string, input: { author: string; body: string; evidence: string }, ip?: string | null) {
  guard(actor);
  const issues: string[] = [];
  const author = input.author.trim(), body = input.body.trim(), evidence = input.evidence.trim();
  if (author.length < 2 || author.length > 120) issues.push("Author name must be 2–120 characters");
  if (body.length < 10 || body.length > 1500) issues.push("Testimonial text must be 10–1500 characters");
  if (evidence.length < 15 || evidence.length > 2000) issues.push("Verification evidence is required: describe how the testimonial and permission to publish were confirmed (15–2000 characters)");
  if (findProhibitedClaims(body).length) issues.push("Testimonial contains a prohibited claim");
  if (issues.length) throw new PortfolioError(422, "Testimonial not saved", issues);
  if (!(await getById(db, projectId))) throw new PortfolioError(404, "Project not found");
  const id = newId("tst");
  await db.batch([
    db.prepare(`INSERT INTO testimonials (id, portfolio_project_id, author_name, body, verification_evidence, verified_by, published, created_at) VALUES (?,?,?,?,?,?,0,?)`)
      .bind(id, projectId, author, body, evidence, actor.userId ?? null, nowIso()),
    auditStmt(db, actor, "testimonial.verified_added", projectId, { testimonialId: id }, ip),
  ]);
  return { id };
}

export async function setTestimonialPublished(db: Db, actor: Actor, testimonialId: string, publish: boolean, ip?: string | null) {
  guard(actor);
  const t = await db.prepare(`SELECT * FROM testimonials WHERE id = ?`).bind(testimonialId).first<Testimonial>();
  if (!t) throw new PortfolioError(404, "Testimonial not found");
  await db.batch([
    db.prepare(`UPDATE testimonials SET published = ? WHERE id = ?`).bind(publish ? 1 : 0, testimonialId),
    auditStmt(db, actor, publish ? "testimonial.published" : "testimonial.unpublished", t.portfolio_project_id ?? testimonialId, { testimonialId }, ip),
  ]);
  return { projectId: t.portfolio_project_id };
}

function auditStmt(db: Db, actor: Actor, action: string, subjectId: string, details: unknown, ip?: string | null) {
  return db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(actor.userId ?? null, actor.kind, action, "portfolio_project", subjectId, JSON.stringify(details), ip ?? null, nowIso());
}
