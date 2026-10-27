// Time-limited signed share links for private files (SEC-003, FILE-001 "secure sharing").
// - The link is /share/<token>; the token is 32 random bytes (hex). Only SHA-256(token) is stored,
//   so a database read never reveals a working link.
// - Expiry is mandatory and at most 7 days. Links can be revoked at any time.
// - Only staff who can read the file, or a customer_admin of the file's organization, may create one.
// - Files whose malware scan is not 'clean' are refused unless the creator explicitly acknowledges that
//   the file has not been scanned (no scanner is configured yet, so every file is 'pending').
//   'infected' and 'failed' files can never be shared.
// - Every access (landing page, download, denied attempt) is rate limited per IP and audited.
// - A link resolves to exactly one file id; nothing about other files is reachable from it.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { randomToken } from "../lib/auth-crypto.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { HttpError } from "../app/http.ts";
import { audit, rateLimit } from "./security.ts";
import { canReadFile, getFile, type FileRow } from "./files.ts";

export const SHARE_MAX_HOURS = 7 * 24;
export const SHARE_DURATIONS: { hours: number; label: string }[] = [
  { hours: 1, label: "1 hour" }, { hours: 24, label: "24 hours" }, { hours: 72, label: "3 days" }, { hours: SHARE_MAX_HOURS, label: "7 days (maximum)" },
];
/** Anonymous accesses allowed per IP per hour across all share links. */
export const SHARE_ACCESS_LIMIT = 30;
/** Links one person may create per hour. */
export const SHARE_CREATE_LIMIT = 20;

export interface ShareLinkRow {
  id: string; file_id: string; organization_id: string; created_by: string; created_at: string; expires_at: string;
  unscanned_acknowledged: number; note: string | null; revoked_at: string | null; revoked_by: string | null;
  access_count: number; last_accessed_at: string | null; creator_name?: string;
}

export class ShareError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Who may create and revoke links for this file. Customers: admins of the owning org. Staff: anyone who can read it. */
export async function canManageShares(ctx: AppContext, f: FileRow): Promise<boolean> {
  if (!ctx.user || !ctx.actor || f.deleted_at) return false;
  const custAdmin = ctx.user.memberships.some((m) => m.organizationId === f.organization_id && m.role === "customer_admin");
  if (custAdmin) return true;
  if (!ctx.user.isStaff) return false;
  return canReadFile(ctx, f);
}

export function shareableProblem(f: FileRow, acknowledgedUnscanned: boolean): string | null {
  if (f.deleted_at) return "This file has been removed.";
  if (f.scan_status === "infected") return "This file was flagged by the malware scan and cannot be shared.";
  if (f.scan_status === "failed") return "The malware scan for this file failed, so it cannot be shared.";
  if (f.scan_status !== "clean" && !acknowledgedUnscanned) {
    return "This file has not been scanned for malware (no scanner is configured yet). Tick the acknowledgement to share it anyway.";
  }
  return null;
}

export async function createShareLink(ctx: AppContext, input: { fileId: string; hours: number; acknowledgeUnscanned: boolean; note?: string }): Promise<{ id: string; token: string; url: string; expiresAt: string }> {
  if (!ctx.user) throw new HttpError(401, "Please sign in.");
  const f = await getFile(ctx.db, input.fileId);
  if (!f || !(await canManageShares(ctx, f))) throw new HttpError(404, "File not found");
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > SHARE_MAX_HOURS) throw new ShareError(422, "Choose how long the link stays valid (at most 7 days).");
  const problem = shareableProblem(f, input.acknowledgeUnscanned);
  if (problem) throw new ShareError(422, problem);
  const note = (input.note ?? "").trim();
  if (note.length > 200) throw new ShareError(422, "The note must be at most 200 characters.");
  const rl = await rateLimit(ctx.db, `sharecreate:${ctx.user.id}`, SHARE_CREATE_LIMIT, 3600, ctx.now().getTime());
  if (!rl.allowed) throw new ShareError(429, "Too many share links created in the last hour. Try again later.");
  const token = randomToken(32);
  const id = newId("shr");
  const at = ctx.now();
  const expiresAt = new Date(at.getTime() + input.hours * 3600e3).toISOString();
  await ctx.db.prepare(`INSERT INTO share_links (id, token_hash, file_id, organization_id, created_by, created_at, expires_at, unscanned_acknowledged, note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, await sha256Hex(token), f.id, f.organization_id, ctx.user.id, at.toISOString(), expiresAt, f.scan_status === "clean" ? 0 : 1, note || null).run();
  await audit(ctx.db, { actorUserId: ctx.user.id, action: "share_link.created", subjectType: "file", subjectId: f.id, organizationId: f.organization_id, ip: ctx.ip,
    details: { shareLinkId: id, expiresAt, hours: input.hours, scanStatus: f.scan_status, unscannedAcknowledged: f.scan_status !== "clean" } });
  return { id, token, url: `${ctx.baseUrl}/share/${token}`, expiresAt };
}

export async function listShareLinks(db: Db, fileId: string): Promise<ShareLinkRow[]> {
  return (await db.prepare(`SELECT s.id, s.file_id, s.organization_id, s.created_by, s.created_at, s.expires_at, s.unscanned_acknowledged, s.note, s.revoked_at, s.revoked_by,
      s.access_count, s.last_accessed_at, u.display_name AS creator_name FROM share_links s JOIN users u ON u.id = s.created_by WHERE s.file_id = ? ORDER BY s.created_at DESC LIMIT 50`)
    .bind(fileId).all<ShareLinkRow>()).results;
}

export function shareState(s: Pick<ShareLinkRow, "revoked_at" | "expires_at">, now: Date): "active" | "expired" | "revoked" {
  if (s.revoked_at) return "revoked";
  return s.expires_at <= now.toISOString() ? "expired" : "active";
}

export async function revokeShareLink(ctx: AppContext, id: string): Promise<{ fileId: string }> {
  if (!ctx.user) throw new HttpError(401, "Please sign in.");
  const s = await ctx.db.prepare(`SELECT id, file_id, organization_id, revoked_at FROM share_links WHERE id = ?`).bind(id).first<{ id: string; file_id: string; organization_id: string; revoked_at: string | null }>();
  const f = s ? await getFile(ctx.db, s.file_id) : null;
  // A deleted file's links are dead anyway; let the creator's org admins / staff still revoke them for the record.
  if (!s || !f || !(await canManageShares(ctx, { ...f, deleted_at: null }))) throw new HttpError(404, "Share link not found");
  if (s.revoked_at) throw new ShareError(409, "This link was already revoked.");
  await ctx.db.prepare(`UPDATE share_links SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowIso(), ctx.user.id, id).run();
  await audit(ctx.db, { actorUserId: ctx.user.id, action: "share_link.revoked", subjectType: "file", subjectId: s.file_id, organizationId: s.organization_id, ip: ctx.ip, details: { shareLinkId: id } });
  return { fileId: s.file_id };
}

export type ShareResolution = { ok: true; link: ShareLinkRow; file: FileRow } | { ok: false; reason: "not_found" | "expired" | "revoked" | "file_unavailable" | "rate_limited" };

/**
 * Resolves a public share token. Rate limited per IP; every outcome for a known link is audited
 * (unknown tokens are recorded as security events by the caller-independent audit below).
 */
export async function resolveShare(ctx: AppContext, token: string, kind: "view" | "download"): Promise<ShareResolution> {
  const rl = await rateLimit(ctx.db, `shareaccess:${ctx.ip ?? "unknown"}`, SHARE_ACCESS_LIMIT, 3600, ctx.now().getTime());
  if (!/^[0-9a-f]{64}$/.test(token)) {
    await audit(ctx.db, { actorKind: "system", action: "share_link.access_denied", subjectType: "share_link", ip: ctx.ip, details: { reason: "malformed_token", kind } });
    return { ok: false, reason: rl.allowed ? "not_found" : "rate_limited" };
  }
  const link = await ctx.db.prepare(`SELECT * FROM share_links WHERE token_hash = ?`).bind(await sha256Hex(token)).first<ShareLinkRow>();
  if (!rl.allowed) {
    await audit(ctx.db, { actorKind: "system", action: "share_link.rate_limited", subjectType: link ? "file" : "share_link", subjectId: link?.file_id ?? null, organizationId: link?.organization_id ?? null, ip: ctx.ip, details: { shareLinkId: link?.id, kind } });
    return { ok: false, reason: "rate_limited" };
  }
  if (!link) {
    await audit(ctx.db, { actorKind: "system", action: "share_link.access_denied", subjectType: "share_link", ip: ctx.ip, details: { reason: "unknown_token", kind } });
    return { ok: false, reason: "not_found" };
  }
  const state = shareState(link, ctx.now());
  const file = await getFile(ctx.db, link.file_id);
  const reason = state !== "active" ? state : !file || file.deleted_at || file.scan_status === "infected" || file.scan_status === "failed" ? "file_unavailable" : null;
  if (reason) {
    await audit(ctx.db, { actorKind: "system", action: "share_link.access_denied", subjectType: "file", subjectId: link.file_id, organizationId: link.organization_id, ip: ctx.ip, details: { shareLinkId: link.id, reason, kind } });
    return { ok: false, reason };
  }
  await ctx.db.prepare(`UPDATE share_links SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`).bind(ctx.now().toISOString(), link.id).run();
  await audit(ctx.db, { actorUserId: ctx.user?.id ?? null, actorKind: ctx.user ? "user" : "system", action: kind === "download" ? "share_link.downloaded" : "share_link.viewed", subjectType: "file", subjectId: link.file_id,
    organizationId: link.organization_id, ip: ctx.ip, details: { shareLinkId: link.id, userAgent: (ctx.req.headers.get("user-agent") ?? "").slice(0, 160) } });
  return { ok: true, link, file: file! };
}
