// Remote-browser sessions (portfolio Mode B, docs/frontend/PORTFOLIO.md).
//   POST /api/portfolio/remote-sessions            {slug, preview?}  → {id, token, ws}   (same-origin JSON only)
//   GET  /api/portfolio/remote-sessions/:id/live   WebSocket upgrade → the session's Durable Object (handled in
//                                                   app.ts before the normal pipeline: a 101 response must pass untouched)
// Who may start a session:
//   • anyone, for a PUBLISHED project whose display mode is "remote";
//   • the holder of a short-lived preview link for that project (staff editor, release acceptance) — still only when the
//     project's display mode is "remote". Preview links are issued by staff with portfolio.manage and by the
//     Owner-approved ops challenge; they never grant anything beyond viewing that one project's public site.
import type { Router } from "../lib/router.ts";
import type { Env } from "../app/context.ts";
import { HttpError, jsonResponse } from "../app/http.ts";
import { readBody } from "./api.ts";
import * as pf from "../services/portfolio.ts";
import { admit, clientKey, remoteBrowserConfig, usage } from "../services/remote-browser/admission.ts";
import { prepareConnection, previewTokenProject } from "../services/remote-browser/connect.ts";

export const LIVE_PATH = /^\/api\/portfolio\/remote-sessions\/(rb_[0-9a-f]{24})\/live$/;

export function register(r: Router): void {
  r.post("/api/portfolio/remote-sessions", async (ctx) => {
    const origin = ctx.req.headers.get("origin");
    if (!origin || origin !== ctx.url.origin) return jsonResponse(ctx, 403, { code: "forbidden", message: "Cross-origin request blocked" });
    if (!/^application\/json\b/i.test(ctx.req.headers.get("content-type") ?? "")) return jsonResponse(ctx, 415, { code: "invalid", message: "Send JSON" });
    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(ctx.req)); } catch (e) { if (e instanceof HttpError) throw e; return jsonResponse(ctx, 400, { code: "invalid", message: "Invalid JSON" }); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonResponse(ctx, 422, { code: "invalid", message: "Send {\"slug\": …}" });
    const body = parsed as { slug?: unknown; preview?: unknown };
    const slug = typeof body.slug === "string" && /^[a-z0-9-]{1,80}$/.test(body.slug) ? body.slug : "";
    if (!slug) return jsonResponse(ctx, 422, { code: "invalid", message: "Send {\"slug\": …}" });
    const p = await pf.getBySlug(ctx.db, slug);
    if (!p || p.archived_at) return jsonResponse(ctx, 404, { code: "not_found", message: "Project not found" });
    const cfg = remoteBrowserConfig(ctx.env);
    if (!cfg.enabled) return jsonResponse(ctx, 503, { code: "disabled", message: "The interactive remote view is not available right now.", live: p.live_url });
    let access: "public" | "preview" | null = null;
    if (typeof body.preview === "string" && body.preview) {
      if ((await previewTokenProject(ctx.db, body.preview, Date.now())) === p.id) access = "preview";
    } else if (p.published) access = "public";
    if (!access) return jsonResponse(ctx, 404, { code: "not_found", message: "Project not found" });
    if (p.display_mode !== "remote") return jsonResponse(ctx, 409, { code: "not_remote", message: "This project is not shown through the remote browser." });
    const a = await admit(ctx.db, cfg, { projectId: p.id, clientKey: await clientKey(ctx.ip, "remote-browser"), access, now: Date.now() });
    if (!a.ok) return jsonResponse(ctx, a.status, { code: a.code, message: a.message, live: p.live_url }, a.status === 429 ? { "retry-after": "120" } : {});
    return jsonResponse(ctx, 200, { id: a.id, ws: `/api/portfolio/remote-sessions/${a.id}/live?token=${a.token}`, limits: { seconds: cfg.maxSessionSeconds, idleSeconds: cfg.idleSeconds } }, { "cache-control": "no-store" });
  });

  // Capacity, for the staff editor and the release check (no project or visitor detail).
  r.get("/api/portfolio/remote-sessions/status", async (ctx) => {
    const cfg = remoteBrowserConfig(ctx.env);
    const u = cfg.enabled ? await usage(ctx.db, Date.now()) : { active: 0, minutesToday: 0 };
    return jsonResponse(ctx, 200, { enabled: cfg.enabled, active: u.active, maxConcurrent: cfg.maxConcurrent, minutesToday: u.minutesToday, dailyMinutes: cfg.dailyMinutes }, { "cache-control": "no-store" });
  });
}

/**
 * The WebSocket of one session: validates the one-time token and forwards the upgrade to that session's own Durable
 * Object. Called from app.ts handle() before routing, because the 101 response (with its WebSocket) must be returned
 * exactly as the Durable Object produced it.
 */
export async function liveSocket(req: Request, env: Env, url: URL): Promise<Response> {
  const m = LIVE_PATH.exec(url.pathname);
  if (!m || req.method !== "GET") return new Response("Not found", { status: 404 });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
  // Browsers always send Origin on a WebSocket handshake: only this site's own pages may open one.
  if (req.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
  const cfg = remoteBrowserConfig(env);
  if (!cfg.enabled || !env.PORTFOLIO_BROWSER) return new Response("Unavailable", { status: 503 });
  const info = await prepareConnection(env.DB, m[1]!, url.searchParams.get("token") ?? "", url.searchParams, Date.now(), cfg);
  if (!info) return new Response("Forbidden", { status: 403 });
  const stub = env.PORTFOLIO_BROWSER.get(env.PORTFOLIO_BROWSER.idFromName(info.id));
  return stub.fetch(new Request("https://portfolio-browser/session", { headers: { upgrade: "websocket", "x-rb-session": JSON.stringify(info) } }));
}

