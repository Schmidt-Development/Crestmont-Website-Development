// Acquires one fresh Cloudflare Browser Run browser and returns its DevTools socket. Shared by the remote viewer's
// Durable Object (Mode B) and the native-readiness verification (src/services/native/verify.ts), so both use exactly
// the same platform interface: Browser Run's standard DevTools endpoint (plain CDP JSON) first, and the binding's older
// acquire/connectDevtools pair (chunked binary frames) as the fallback. keep_alive only bridges brief gaps — callers
// close the browser explicitly.
import { chunkedSocket, type SocketLike } from "./cdp.ts";

const BR = "https://fake.host"; // Browser Run binding endpoint (the host is ignored by the binding)
export interface BrowserBinding { fetch(input: string, init?: RequestInit): Promise<Response & { webSocket?: (SocketLike & { accept(): void }) | null }> }

export async function acquireBrowserRun(browser: BrowserBinding): Promise<{ socket: SocketLike | null; how: string; session: string }> {
  let socket: SocketLike | null = null, how = "", session = "";
  const acq = await browser.fetch(`${BR}/v1/devtools/browser?keep_alive=60000`, { method: "POST" });
  if (acq.status === 200) {
    session = String(((await acq.json()) as { sessionId?: string }).sessionId ?? "");
    const up = await browser.fetch(`${BR}/v1/devtools/browser/${session}`, { headers: { Upgrade: "websocket" } });
    if (up.webSocket) { up.webSocket.accept(); socket = up.webSocket; }
    how = `devtools ${up.status}`;
  } else how = `devtools ${acq.status}`;
  if (!socket) {
    const legacy = await browser.fetch(`${BR}/v1/acquire?keep_alive=60000`);
    if (legacy.status === 200) {
      session = String(((await legacy.json()) as { sessionId?: string }).sessionId ?? "");
      const up = await browser.fetch(`${BR}/v1/connectDevtools?browser_session=${encodeURIComponent(session)}`, { headers: { Upgrade: "websocket" } });
      if (up.webSocket) { up.webSocket.accept(); socket = chunkedSocket(up.webSocket); }
      how += `; connectDevtools ${up.status}`;
    } else how += `; acquire ${legacy.status}`;
  }
  return { socket, how, session };
}
