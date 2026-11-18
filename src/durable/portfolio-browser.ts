// Durable Object that hosts ONE remote-browser session (Mode B, docs/frontend/PORTFOLIO.md). Each visitor session gets
// its own object and its own Cloudflare Browser Run browser; nothing is shared between sessions. The Worker validates
// the visitor's one-time token (src/services/remote-browser/connect.ts) and forwards the WebSocket upgrade here with the
// session's parameters; this object acquires a browser, runs the shared session (session.ts) and closes the browser when
// the session ends.
import type { Env } from "../app/context.ts";
import { Cdp, type SocketLike } from "../services/remote-browser/cdp.ts";
import { acquireBrowserRun, type BrowserBinding } from "../services/remote-browser/acquire.ts";
import { RemoteSession } from "../services/remote-browser/session.ts";
import { finish, heartbeat } from "../services/remote-browser/admission.ts";
import { holdEarlyMessages } from "../services/remote-browser/stream.ts";
import type { ConnectInfo } from "../services/remote-browser/connect.ts";


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
    void this.run(info, holdEarlyMessages(server));
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
      // A fresh browser for this session (src/services/remote-browser/acquire.ts, shared with the native verification).
      const got = await acquireBrowserRun(browser);
      const socket = got.socket, how = got.how;
      browserSession = got.session;
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
