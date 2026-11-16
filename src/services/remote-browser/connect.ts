// Opening a remote-browser session: who may start one (public visitors for published Mode B projects, staff with
// portfolio.manage for previews, and holders of a short-lived preview link), and what the browser side receives.
import type { Db } from "../../lib/db.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { claim } from "./admission.ts";
import { siteOf } from "./policy.ts";
import { DEVICE_WIDTH, type Device } from "./session.ts";

export interface ConnectInfo { id: string; url: string; site: string; device: Device; height: number; maxSessionSeconds: number; idleSeconds: number }
export const parseDevice = (d: unknown): Device => (typeof d === "string" && d in DEVICE_WIDTH ? (d as Device) : "desktop");

/** Validates a WebSocket connection request and returns what the browser side needs, or null (403). */
export async function prepareConnection(db: Db, id: string, token: string, q: URLSearchParams, now: number, cfg: { maxSessionSeconds: number; idleSeconds: number }): Promise<ConnectInfo | null> {
  const row = await claim(db, id, token, now);
  if (!row) return null;
  const p = await db.prepare(`SELECT live_url, embed_url, archived_at FROM portfolio_projects WHERE id = ?`).bind(row.project_id).first<{ live_url: string; embed_url: string | null; archived_at: string | null }>();
  if (!p || p.archived_at) return null;
  const url = p.embed_url || p.live_url, site = siteOf(url);
  if (!site) return null;
  return { id, url, site, device: parseDevice(q.get("device")), height: Number(q.get("h")) || 900, ...cfg };
}

/** A preview link (unpublished projects, release acceptance): valid, unexpired, for this project. */
export async function previewTokenProject(db: Db, token: string, now: number): Promise<string | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const r = await db.prepare(`SELECT project_id, expires_at FROM portfolio_preview_tokens WHERE token_hash = ?`).bind(await sha256Hex(token)).first<{ project_id: string; expires_at: string }>();
  return r && Date.parse(r.expires_at) > now ? r.project_id : null;
}
export async function issuePreviewToken(db: Db, projectId: string, minutes: number, purpose: string, now: number): Promise<string> {
  await db.prepare(`DELETE FROM portfolio_preview_tokens WHERE expires_at < ?`).bind(new Date(now - 86_400_000).toISOString()).run(); // housekeeping
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare(`INSERT INTO portfolio_preview_tokens (token_hash, project_id, expires_at, created_at, purpose) VALUES (?,?,?,?,?)`)
    .bind(await sha256Hex(token), projectId, new Date(now + minutes * 60_000).toISOString(), new Date(now).toISOString(), purpose.slice(0, 60)).run();
  return token;
}
