// Signed client for the platform's scanner endpoints (/api/scan/*). The scanner's OWN credential,
// FILE_SCANNER_SECRET: header x-crestmont-scanner-signature = "t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>".
// Every attempt gets a fresh _nonce and signature, so a retry is never refused as a replay.
import { createHmac, randomBytes } from "node:crypto";

export class PlatformError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export interface PlatformOptions {
  url: string; secret: string; timeoutMs: number;
  /** Delays between attempts for network errors, 429 and 5xx. 4xx other than 429 is never retried. */
  retryDelaysMs?: number[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export function platform(o: PlatformOptions) {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delays = o.retryDelaysMs ?? [1_000, 4_000, 15_000];
  async function post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    let last: Error = new Error("not attempted");
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt) await sleep(delays[attempt - 1]);
      const body = JSON.stringify({ ...payload, _nonce: randomBytes(16).toString("hex") });
      try {
        const res = await f(o.url + path, {
          method: "POST", body, signal: AbortSignal.timeout(o.timeoutMs),
          headers: { "content-type": "application/json", "x-crestmont-scanner-signature": sign(o.secret, body), "user-agent": "crestmont-file-scanner/1" },
        });
        const text = await res.text();
        if (res.ok) return JSON.parse(text) as T;
        let msg = text.slice(0, 200);
        try { const j = JSON.parse(text) as { error?: string }; if (j.error) msg = j.error; } catch { /* plain text */ }
        last = new PlatformError(`${path} → HTTP ${res.status}: ${msg}`, res.status);
        if (res.status !== 429 && res.status < 500) throw last;   // the request itself is wrong; retrying cannot help
      } catch (e) {
        if (e instanceof PlatformError && e.status !== 429 && e.status < 500) throw e;
        last = e instanceof PlatformError ? e : new PlatformError(`${path} → ${(e as Error).name === "TimeoutError" ? `no answer within ${o.timeoutMs} ms` : (e as Error).message}`, 0);
      }
    }
    throw last;
  }
  return {
    queue: (limit: number) => post<{ files: { fileId: string; sha256: string; sizeBytes: number; scanStatus: string }[]; maxBytes: number }>("/api/scan/queue", { limit }),
    file: (fileId: string) => post<{ fileId: string; sha256: string; sizeBytes: number; base64: string }>("/api/scan/file", { fileId }),
    result: (r: { fileId: string; verdict: "clean" | "infected" | "failed"; engine: string; scannedSha256: string; signature?: string; detail?: string; scannedAt: string }) =>
      post<{ current: string; previous: string; sharesRevoked: number }>("/api/scan/result", r),
    heartbeat: (h: { scannerId: string; engine: string | null; signaturesAt: string | null; daemonOk: boolean; detail: string | null; scannedTotal: number; failedTotal: number }) =>
      post<{ ok: true; seenAt: string }>("/api/scan/heartbeat", h),
  };
}
export type Platform = ReturnType<typeof platform>;
