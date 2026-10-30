// Signed client for the platform's research API (src/routes/research.ts):
//   header x-crestmont-research-signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//   every body carries a fresh random _nonce (single use on the platform).
// Batches keep their batchId across retries, so a retry after a timeout can never double-insert.
import { createHmac, randomBytes } from "node:crypto";

export const SIGNATURE_HEADER = "x-crestmont-research-signature";
export const signBody = (secret: string, body: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

export interface Controls { paused: boolean; pauseReason: string | null; qualifyThreshold: number; maxBatch: number; enabledSources: string[]; serverTime: string }
export interface BatchAnswer { batchId: string; accepted: number; created: number; updated: number; unchanged: number; rejected: { businessKey: string | null; issues: string[] }[]; crmMatches: number; duplicatesPrevented: number; replay?: true }

export class PlatformError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
  /** Retrying cannot help (bad secret, bad request): stop and tell the operator. */
  get permanent() { return this.status === 400 || this.status === 401 || this.status === 403 || this.status === 422; }
}

export class Platform {
  private readonly base: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  constructor(base: string, secret: string, fetchImpl: typeof fetch = fetch) { this.base = base; this.secret = secret; this.fetchImpl = fetchImpl; }

  private async post<T>(path: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    const body = JSON.stringify({ ...payload, _nonce: randomBytes(16).toString("hex") });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(this.secret, body, Math.floor(Date.now() / 1000)) },
      });
    } catch (e) { throw new PlatformError(0, `network: ${(e as Error).message}`); }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { /* keep text */ }
      throw new PlatformError(res.status, msg);
    }
    return JSON.parse(text) as T;
  }
  heartbeat(runnerId: string, version: string, status: Record<string, unknown>) { return this.post<Controls>("/api/research/runner/heartbeat", { runnerId, version, status }, 30_000); }
  batch(runnerId: string, batchId: string, prospectsJson: string) {
    // The prospects array is already serialized in the outbox; parse once so the signed body is canonical JSON.
    return this.post<BatchAnswer>("/api/research/runner/batch", { runnerId, batchId, prospects: JSON.parse(prospectsJson) as unknown[] }, 120_000);
  }
}
