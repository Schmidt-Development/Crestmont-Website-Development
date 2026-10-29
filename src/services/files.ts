// Private, tenant-scoped file service (FILE-001, PORTAL-004, SEC-003).
// Bytes live in ctx.storage (R2 in production); metadata in `files`. Downloads always pass through
// GET /files/:id which checks access and writes a 'file.downloaded' audit entry. No malware scanner
// is configured yet, so every file stays scan_status = 'pending' and the UI says "not yet scanned".
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { toHex } from "../lib/crypto.ts";
import { validateUpload, sanitizeFilename } from "../adapters/storage.ts";
import { audit } from "./security.ts";
import { can, STAFF_ROLES } from "../domain/authz.ts";
import { HttpError } from "../app/http.ts";

export interface FileRow {
  id: string; organization_id: string; project_id: string | null; r2_key: string; filename: string; content_type: string;
  size_bytes: number; sha256: string; scan_status: string; folder: string | null; replaced_by: string | null;
  uploaded_by: string; deleted_at: string | null; created_at: string;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);

export class UploadError extends Error {}

export function normalizeFolder(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
  if (!s) return null;
  const clean = s.split("/").map((seg) => seg.replace(/[^\w\- ]/g, "").trim()).filter((seg) => seg && seg !== "." && seg !== "..").join("/");
  return clean.slice(0, 80) || null;
}

/** Validates (extension + magic bytes + size), stores bytes, records metadata. Throws UploadError with a user-facing reason. */
export async function storeUpload(ctx: Pick<AppContext, "db" | "storage">, input: {
  organizationId: string; projectId: string | null; file: File; uploadedBy: string; folder?: string | null; replaces?: string | null;
}): Promise<FileRow> {
  if (!ctx.storage) throw new UploadError("File storage is not configured yet, so uploads are unavailable.");
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const filename = sanitizeFilename(input.file.name || "file");
  const check = validateUpload(filename, bytes);
  if (!check.ok) throw new UploadError(check.reason);
  const id = newId("file");
  const key = `org/${input.organizationId}/${input.projectId ?? "general"}/${id}.${check.ext}`;
  const sha = await sha256Bytes(bytes);
  await ctx.storage.put(key, bytes, check.contentType);
  const at = nowIso();
  const stmts = [
    ctx.db.prepare(`INSERT INTO files (id, organization_id, project_id, r2_key, filename, content_type, size_bytes, sha256, scan_status, folder, uploaded_by, created_at)
                    VALUES (?,?,?,?,?,?,?,?, 'pending', ?,?,?)`)
      .bind(id, input.organizationId, input.projectId, key, filename, check.contentType, bytes.length, sha, normalizeFolder(input.folder), input.uploadedBy, at),
  ];
  if (input.replaces) stmts.push(ctx.db.prepare(`UPDATE files SET replaced_by = ? WHERE id = ? AND organization_id = ? AND replaced_by IS NULL`).bind(id, input.replaces, input.organizationId));
  try {
    await ctx.db.batch(stmts);
  } catch (e) {
    await ctx.storage.delete(key).catch(() => undefined);
    throw e;
  }
  await audit(ctx.db, { actorUserId: input.uploadedBy, action: input.replaces ? "file.replaced" : "file.uploaded", subjectType: "file", subjectId: id, organizationId: input.organizationId,
    details: { filename, size: bytes.length, projectId: input.projectId, replaces: input.replaces ?? undefined, sha256: sha } });
  return (await getFile(ctx.db, id))!;
}

export async function getFile(db: Db, id: string): Promise<FileRow | null> {
  return db.prepare(`SELECT * FROM files WHERE id = ?`).bind(id).first<FileRow>();
}

/** Customer-side lookup: only files of the caller's organization, never deleted ones. */
export async function getOrgFile(db: Db, organizationId: string, id: string): Promise<FileRow> {
  const f = await db.prepare(`SELECT * FROM files WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`).bind(id, organizationId).first<FileRow>();
  if (!f) throw new HttpError(404, "File not found");
  return f;
}

function fileListWhere(organizationId: string, opts: { projectId?: string | null; folder?: string | null; includeReplaced?: boolean }) {
  const where = ["f.organization_id = ?", "f.deleted_at IS NULL"];
  const binds: unknown[] = [organizationId];
  if (opts.projectId) { where.push("f.project_id = ?"); binds.push(opts.projectId); }
  if (opts.folder) { where.push("(f.folder = ? OR f.folder LIKE ?)"); binds.push(opts.folder, `${opts.folder}/%`); }
  if (!opts.includeReplaced) where.push("f.replaced_by IS NULL");
  return { where: where.join(" AND "), binds };
}

/** One page of files (default: the first 500). Pass limit/offset to page; see countFiles for the total (CREST-GAP-071). */
export async function listFiles(db: Db, organizationId: string, opts: { projectId?: string | null; folder?: string | null; includeReplaced?: boolean; limit?: number; offset?: number } = {}): Promise<(FileRow & { uploader: string })[]> {
  const { where, binds } = fileListWhere(organizationId, opts);
  const limit = Math.max(1, Math.min(500, opts.limit ?? 500)), offset = Math.max(0, opts.offset ?? 0);
  return (await db.prepare(`SELECT f.*, u.display_name AS uploader FROM files f JOIN users u ON u.id = f.uploaded_by WHERE ${where} ORDER BY COALESCE(f.folder,''), f.created_at DESC, f.id LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset).all<FileRow & { uploader: string }>()).results;
}

/** Number of files listFiles would page through with the same filters. */
export async function countFiles(db: Db, organizationId: string, opts: { projectId?: string | null; folder?: string | null; includeReplaced?: boolean } = {}): Promise<number> {
  const { where, binds } = fileListWhere(organizationId, opts);
  return (await db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
}

export async function fileVersions(db: Db, organizationId: string, id: string): Promise<FileRow[]> {
  return (await db.prepare(`SELECT * FROM files WHERE organization_id = ? AND replaced_by = ? ORDER BY created_at DESC`).bind(organizationId, id).all<FileRow>()).results;
}

export async function softDeleteFile(db: Db, organizationId: string, id: string, byUserId: string): Promise<void> {
  const res = await db.prepare(`UPDATE files SET deleted_at = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`).bind(nowIso(), id, organizationId).run();
  if (res.meta.changes !== 1) throw new HttpError(404, "File not found");
  await audit(db, { actorUserId: byUserId, action: "file.deleted", subjectType: "file", subjectId: id, organizationId });
}

export async function moveFile(db: Db, organizationId: string, id: string, folder: string | null, byUserId: string): Promise<void> {
  const res = await db.prepare(`UPDATE files SET folder = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`).bind(normalizeFolder(folder), id, organizationId).run();
  if (res.meta.changes !== 1) throw new HttpError(404, "File not found");
  await audit(db, { actorUserId: byUserId, action: "file.moved", subjectType: "file", subjectId: id, organizationId, details: { folder: normalizeFolder(folder) } });
}

/**
 * Who may read a file:
 *  - a customer whose membership organization owns the file;
 *  - staff with project.read_all or ticket.manage (with delivery/support area access);
 *  - other staff with delivery/support access who are assigned to the file's project (PM, project or task assignment).
 */
export async function canReadFile(ctx: AppContext, f: FileRow): Promise<boolean> {
  // A session that has not completed MFA (where the account requires it) reads nothing, customer or staff.
  if (!ctx.user || !ctx.actor || f.deleted_at || !ctx.sessionMfaVerified) return false;
  const customerOrgs = ctx.user.memberships.filter((m) => !(STAFF_ROLES as readonly string[]).includes(m.role)).map((m) => m.organizationId);
  if (customerOrgs.includes(f.organization_id)) return true;
  if (!ctx.user.isStaff || !ctx.sessionMfaVerified) return false;
  if (!can(ctx.actor, "delivery.access") && !can(ctx.actor, "support.access")) return false;
  if (can(ctx.actor, "project.read_all") || can(ctx.actor, "ticket.manage")) return true;
  if (!f.project_id) return false;
  const assigned = await ctx.db.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ? AND (p.project_manager_id = ?
       OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
       OR EXISTS (SELECT 1 FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND t.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL))`,
  ).bind(f.project_id, ctx.user.id, ctx.user.id, ctx.user.id).first();
  return !!assigned;
}

/** Streams a file after the access check; audits every download/preview. */
export async function serveFile(ctx: AppContext, id: string, inline: boolean): Promise<Response> {
  if (!ctx.user) throw new HttpError(401, "Please sign in.");
  if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
  const f = await getFile(ctx.db, id);
  // Same response for "missing" and "not yours" so file ids cannot be probed across tenants.
  if (!f || !(await canReadFile(ctx, f))) {
    if (f) await audit(ctx.db, { actorUserId: ctx.user.id, action: "file.download_denied", subjectType: "file", subjectId: f.id, organizationId: f.organization_id, ip: ctx.ip });
    throw new HttpError(404, "File not found");
  }
  // Fail closed on scanner verdicts (F-02): a file flagged as infected, or whose scan failed, is quarantined.
  // Nobody downloads or previews it through the portal (share links already refuse it). Files with no scan yet
  // ('pending') stay downloadable because no scanner is connected; the UI labels them "Not yet scanned".
  if (isQuarantined(f.scan_status)) {
    await audit(ctx.db, { actorUserId: ctx.user.id, action: "file.download_blocked", subjectType: "file", subjectId: f.id, organizationId: f.organization_id, ip: ctx.ip, details: { scanStatus: f.scan_status } });
    throw new HttpError(409, f.scan_status === "infected" ? "This file was flagged by the malware scan and is quarantined." : "The malware scan for this file failed, so it is quarantined until it is scanned again.");
  }
  if (!ctx.storage) throw new HttpError(503, "File storage is not configured yet.");
  const obj = await ctx.storage.get(f.r2_key);
  if (!obj) throw new HttpError(404, "File content is missing from storage.");
  const preview = inline && PREVIEWABLE.has(f.content_type);
  await audit(ctx.db, { actorUserId: ctx.user.id, action: "file.downloaded", subjectType: "file", subjectId: f.id, organizationId: f.organization_id, ip: ctx.ip, details: { inline: preview } });
  const headers = new Headers({
    "content-type": f.content_type,
    "content-disposition": `${preview ? "inline" : "attachment"}; filename="${f.filename.replace(/[^\w.\- ()]/g, "_")}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
  });
  for (const c of ctx.setCookies) headers.append("set-cookie", c);
  return new Response(obj.body as BodyInit, { headers });
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Scan states in which a file must not be served or shared. */
export function isQuarantined(status: string): boolean {
  return status === "infected" || status === "failed";
}

export function scanLabel(status: string): string {
  return status === "pending" ? "Not yet scanned" : status === "clean" ? "Scanned clean" : status === "infected" ? "Blocked: malware detected" : "Scan failed";
}
