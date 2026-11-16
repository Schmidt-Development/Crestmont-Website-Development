// Durable Object that hosts ONE remote-browser session (Mode B, docs/frontend/PORTFOLIO.md). Each visitor session gets
// its own object and its own Cloudflare Browser Run browser; nothing is shared between sessions. The Worker validates
// the visitor's one-time token (src/services/remote-browser/connect.ts) and forwards the WebSocket upgrade here with the
// session's parameters; this object acquires a browser, runs the shared session (session.ts) and closes the browser when
// the session ends.
import type { Env } from "../app/context.ts";
import { Cdp, chunkedSocket, type SocketLike } from "../services/remote-browser/cdp.ts";
import { RemoteSession } from "../services/remote-browser/session.ts";
import { finish, heartbeat } from "../services/remote-browser/admission.ts";
import type { ConnectInfo } from "../services/remote-browser/connect.ts";

const BR = "https://fake.host"; // Browser Run binding endpoint (the host is ignored by the binding)

interface BrowserBinding { fetch(input: string, init?: RequestInit): Promise<Response & { webSocket?: (SocketLike & { accept(): void }) | null }> }

export class PortfolioBrowser {
  private readonly env: Env;
  constructor(_state: unknown, env: Env) { this.env = env; }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    let info: ConnectInfo;
    try { info = JSON.parse(req.headers.get("x-rb-session") ?? ""); } catch { return new Response("Bad session", { status: 400 }); }
    const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, SocketLike & { accept(): void }> }).WebSocketPair;
    const pair = new Pair();
    const client = pair[0], server = pair[1];
    server.accept();
    void this.run(info, server);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private async run(info: ConnectInfo, visitor: SocketLike) {
    const db = this.env.DB, browser = (this.env as unknown as { BROWSER?: BrowserBinding }).BROWSER;
    let browserSession = "";
    const fail = async (reason: string) => {
      console.error(JSON.stringify({ level: "error", msg: "remote browser session failed", session: info.id, reason: reason.slice(0, 300) }));
      try { visitor.send(JSON.stringify({ t: "error", message: "The remote browser is not available right now." })); visitor.close(1011, "unavailable"); } catch { /* gone */ }
      await finish(db, info.id, Date.now(), reason).catch(() => undefined);
    };
    if (!browser) return fail("no-browser-binding");
    try {
      // A fresh browser for this session; keep_alive only bridges brief gaps — the session closes it explicitly.
      // Browser Run's standard DevTools endpoint (plain CDP JSON); the binding's older acquire/connectDevtools pair
      // (chunked binary frames) is the fallback, so either platform interface works.
      let socket: SocketLike | null = null, how = "";
      const acq = await browser.fetch(`${BR}/v1/devtools/browser?keep_alive=60000`, { method: "POST" });
      if (acq.status === 200) {
        browserSession = String(((await acq.json()) as { sessionId?: string }).sessionId ?? "");
        const up = await browser.fetch(`${BR}/v1/devtools/browser/${browserSession}`, { headers: { Upgrade: "websocket" } });
        if (up.webSocket) { up.webSocket.accept(); socket = up.webSocket; }
        how = `devtools ${up.status}`;
      } else how = `devtools ${acq.status}`;
      if (!socket) {
        const legacy = await browser.fetch(`${BR}/v1/acquire?keep_alive=60000`);
        if (legacy.status === 200) {
          browserSession = String(((await legacy.json()) as { sessionId?: string }).sessionId ?? "");
          const up = await browser.fetch(`${BR}/v1/connectDevtools?browser_session=${encodeURIComponent(browserSession)}`, { headers: { Upgrade: "websocket" } });
          if (up.webSocket) { up.webSocket.accept(); socket = chunkedSocket(up.webSocket); }
          how += `; connectDevtools ${up.status}`;
        } else how += `; acquire ${legacy.status}`;
      }
      if (!socket) return fail(`no-browser: ${how}`);
      console.log(JSON.stringify({ level: "info", msg: "remote browser session started", session: info.id, via: how.split(";").pop()!.trim() }));
      const cdp = new Cdp(socket);
      const session = new RemoteSession(cdp, visitor, {
        ...info,
        heartbeat: () => heartbeat(db, info.id, Date.now()),
        closeBrowser: async () => { await cdp.send("Browser.close").catch(() => undefined); cdp.close(); },
        onEnd: (reason) => finish(db, info.id, Date.now(), reason),
      });
      await session.start();
    } catch (e) {
      await fail(`error: ${(e as Error).message}`.slice(0, 60));
    }
  }
}
