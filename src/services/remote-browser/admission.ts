// Admission and accounting for remote-browser sessions (Mode B). Every session is a row in remote_browser_sessions:
//   • concurrency — at most `maxConcurrent` sessions are live at once (abandoned rows are expired first);
//   • budget      — at most `dailyMinutes` browser-minutes per UTC day are started (Cloudflare Browser Run bills by
//                   browser-hour and concurrent browsers; the defaults keep usage inside the Workers Paid allowance);
//   • rate        — each visitor may start a few sessions per 10 minutes;
//   • tokens      — a session is opened with a random one-time token; only its SHA-256 is stored.
import type { Db } from "../../lib/db.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { rateLimit } from "../security.ts";

export interface RemoteBrowserConfig { enabled: boolean; maxConcurrent: number; dailyMinutes: number; maxSessionSeconds: number; idleSeconds: number; perVisitorPer10Min: number }
const num = (v: string | undefined, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : d; };
/** Configuration from the environment. Defaults stay inside Cloudflare's included Browser Run allowance. */
export function remoteBrowserConfig(env: { REMOTE_BROWSER?: string; REMOTE_BROWSER_MAX_CONCURRENT?: string; REMOTE_BROWSER_DAILY_MINUTES?: string; REMOTE_BROWSER_MAX_SESSION_SECONDS?: string; REMOTE_BROWSER_IDLE_SECONDS?: string; REMOTE_BROWSER_RATE_PER_10MIN?: string; BROWSER?: unknown; PORTFOLIO_BROWSER?: unknown; REMOTE_BROWSER_LOCAL?: unknown }): RemoteBrowserConfig {
  const wired = !!((env.BROWSER && env.PORTFOLIO_BROWSER) || env.REMOTE_BROWSER_LOCAL);
  return {
    enabled: env.REMOTE_BROWSER === "on" && wired,
    maxConcurrent: num(env.REMOTE_BROWSER_MAX_CONCURRENT, 3, 1, 50),
    dailyMinutes: num(env.REMOTE_BROWSER_DAILY_MINUTES, 20, 1, 24 * 60),
    maxSessionSeconds: num(env.REMOTE_BROWSER_MAX_SESSION_SECONDS, 300, 30, 1800),
    idleSeconds: num(env.REMOTE_BROWSER_IDLE_SECONDS, 90, 15, 600),
    perVisitorPer10Min: num(env.REMOTE_BROWSER_RATE_PER_10MIN, 6, 1, 1000),
  };
}

const STALE_SECONDS = 75; // a live session reports at least every 30 s; silence beyond this means it is gone
// A reservation whose WebSocket never connected (the visitor left, or the staff editor was closed, while the remote
// browser was starting) holds one of the few viewers until it is released: the viewer connects within a second or two,
// so after this long it never will (measured: three such staff previews held all three viewers for a minute).
const UNCLAIMED_SECONDS = 20;
export type Admission = { ok: true; id: string; token: string } | { ok: false; status: number; code: "disabled" | "busy" | "budget" | "rate"; message: string };

const iso = (ms: number) => new Date(ms).toISOString();
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Marks sessions that stopped reporting (a crashed or closed browser tab) or were never connected as ended. Returns how many. */
export async function expireStale(db: Db, now: number): Promise<number> {
  const r = await db.prepare(`UPDATE remote_browser_sessions SET ended_at = ?, end_reason = 'abandoned'
      WHERE ended_at IS NULL AND (last_seen_at < ? OR (started_at IS NULL AND created_at < ?))`)
    .bind(iso(now), iso(now - STALE_SECONDS * 1000), iso(now - UNCLAIMED_SECONDS * 1000)).run();
  return (r.meta as { changes?: number } | undefined)?.changes ?? 0;
}

export async function usage(db: Db, now: number): Promise<{ active: number; minutesToday: number }> {
  const day = iso(now).slice(0, 10);
  // One round trip: live sessions, and today's browser-seconds (live sessions count with the time run so far).
  const r = await db.prepare(`SELECT (SELECT COUNT(*) FROM remote_browser_sessions WHERE ended_at IS NULL) AS n,
    (SELECT COALESCE(SUM(CASE WHEN ended_at IS NULL THEN (julianday(?) - julianday(COALESCE(started_at, created_at))) * 86400 ELSE seconds END), 0)
       FROM remote_browser_sessions WHERE created_at >= ?) AS secs`).bind(iso(now), `${day}T00:00:00.000Z`).first<{ n: number; secs: number }>();
  return { active: r?.n ?? 0, minutesToday: Math.round(((r?.secs ?? 0) / 60) * 10) / 10 };
}

export async function admit(db: Db, cfg: RemoteBrowserConfig, req: { projectId: string; clientKey: string; access: "public" | "staff" | "preview"; now: number; rateLimit?: number }): Promise<Admission> {
  if (!cfg.enabled) return { ok: false, status: 503, code: "disabled", message: "The interactive remote view is not available right now." };
  // Independent steps in parallel (start-up time is round trips to the database).
  const [rl] = await Promise.all([rateLimit(db, `rb:${req.clientKey}`, req.rateLimit ?? cfg.perVisitorPer10Min, 600, req.now), expireStale(db, req.now)]);
  if (!rl.allowed) return { ok: false, status: 429, code: "rate", message: "Too many interactive views were started from here. Please wait a few minutes." };
  const u = await usage(db, req.now);
  if (u.minutesToday >= cfg.dailyMinutes) return { ok: false, status: 503, code: "budget", message: "Today's interactive viewing time has been used up. Please visit the live website, or come back tomorrow." };
  const id = `rb_${randomHex(12)}`, token = randomHex(24);
  // Admit atomically: the insert happens only while fewer than maxConcurrent sessions are live.
  const ins = await db.prepare(`INSERT INTO remote_browser_sessions (id, project_id, token_hash, client_key, access, created_at, last_seen_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM remote_browser_sessions WHERE ended_at IS NULL) < ?`)
    .bind(id, req.projectId, await sha256Hex(token), req.clientKey, req.access, iso(req.now), iso(req.now), cfg.maxConcurrent).run();
  if (!((ins.meta as { changes?: number } | undefined)?.changes)) return { ok: false, status: 503, code: "busy", message: "All interactive viewers are in use. Please try again in a minute, or visit the live website." };
  return { ok: true, id, token };
}

export interface SessionRow { id: string; project_id: string; token_hash: string; started_at: string | null; ended_at: string | null; access: string; created_at: string }
/** The session for a WebSocket connection: unused, unexpired (2 minutes to connect) and with the right token. */
export async function claim(db: Db, id: string, token: string, now: number): Promise<SessionRow | null> {
  if (!/^rb_[0-9a-f]{24}$/.test(id) || !/^[0-9a-f]{48}$/.test(token)) return null;
  // One atomic round trip: the right token, unused, not ended, created within the last two minutes.
  const row = await db.prepare(`UPDATE remote_browser_sessions SET started_at = ?, last_seen_at = ?
      WHERE id = ? AND token_hash = ? AND started_at IS NULL AND ended_at IS NULL AND created_at >= ?
      RETURNING id, project_id, token_hash, started_at, ended_at, access, created_at`)
    .bind(iso(now), iso(now), id, await sha256Hex(token), iso(now - 120_000)).first<SessionRow>();
  return row ?? null;
}
export async function heartbeat(db: Db, id: string, now: number) {
  await db.prepare(`UPDATE remote_browser_sessions SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL`).bind(iso(now), id).run();
}
export async function finish(db: Db, id: string, now: number, reason: string) {
  await db.prepare(`UPDATE remote_browser_sessions SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?),
    seconds = CAST(ROUND((julianday(?) - julianday(COALESCE(started_at, created_at))) * 86400) AS INTEGER), last_seen_at = ? WHERE id = ?`).bind(iso(now), reason.slice(0, 60), iso(now), iso(now), id).run();
}
/** A visitor key for rate limiting that is not the IP itself. */
export async function clientKey(ip: string | null | undefined, salt: string) { return (await sha256Hex(`${salt}|${ip ?? "unknown"}`)).slice(0, 24); }
