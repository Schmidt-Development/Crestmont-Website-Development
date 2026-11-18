// Development / CI stand-in for Cloudflare Browser Run: starts a fresh headless Chromium per remote-browser session
// (own temporary profile, killed when the session ends) and returns its CDP WebSocket. Same isolation model as
// production — one browser per visitor session — so the shared session code (src/services/remote-browser/session.ts)
// runs unchanged.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SocketLike } from "../src/services/remote-browser/cdp.ts";

/** `extraArgs`: e.g. software WebGL for the native verification ("--enable-unsafe-swiftshader"). */
export async function launchLocalBrowser(executable: string, extraArgs: string[] = []): Promise<{ ws: SocketLike; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "crestmont-rb-"));
  const proc = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-extensions", "--mute-audio", ...extraArgs, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const close = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* busy */ } }, 500); };
  const url = await new Promise<string>((resolve, reject) => {
    let err = "";
    const t = setTimeout(() => reject(new Error(`Chromium did not start: ${err.slice(-300)}`)), 20_000);
    proc.stderr!.on("data", (d: Buffer) => { err += d.toString(); const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); resolve(m[1]!); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`Chromium exited (${c}): ${err.slice(-300)}`)); });
  }).catch((e) => { close(); throw e; });
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("CDP connection failed"))); });
  return { ws: ws as unknown as SocketLike, close: () => { try { ws.close(); } catch { /* closed */ } close(); } };
}
