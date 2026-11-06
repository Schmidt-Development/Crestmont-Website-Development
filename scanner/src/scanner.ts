// The scan cycle: pull files awaiting a scan, fetch each one's bytes, verify their SHA-256, stream them to clamd and
// report the verdict. One file at a time, so memory is bounded by the largest storable file.
//
// What each outcome becomes:
//   clamd "OK"                                   → clean
//   clamd "<name> FOUND"                         → infected (terminal on the platform; share links revoked there)
//   Heuristics.Limits.Exceeded / Encrypted       → failed: those bytes were NOT fully examined, so they are never
//                                                  called clean, and an unexaminable file is not called malware either
//   an archive declaring more expansion than       → failed, decided HERE and before streaming, because clamd skips an
//   clamd will examine                             oversized member and still answers "OK" (scanner/src/archive.ts)
//   clamd "... ERROR" for this file              → failed (quarantined until a later scan succeeds)
//   clamd unreachable                            → no verdict at all: it is not the file's fault; the cycle stops and
//                                                  the heartbeat reports the daemon down
//   bytes whose SHA-256 differs from the record  → no verdict; retried later (the platform refuses a verdict for
//                                                  bytes other than the stored ones anyway)
//   platform/network trouble                     → retried with backoff, then the file waits for the next cycle
// A file that keeps failing is retried with growing per-file backoff (1 min doubling to 6 h), so one bad file can
// neither starve the queue nor be hammered.
import { createHash } from "node:crypto";
import { ClamdUnavailable, ping, scanBytes, version, type ClamdOptions } from "./clamd.ts";
import { PlatformError, type Platform } from "./platform.ts";
import { beyondDaemonLimits, DEFAULT_DAEMON_LIMITS, type DaemonLimits } from "./archive.ts";

export interface ScannerConfig {
  scannerId: string; clamd: ClamdOptions; batch: number;
  /** The scanner's own ceiling; the platform's maxBytes applies too and the lower one wins. */
  maxBytes: number;
  /**
   * The ceilings configured on clamd itself. An archive that declares more expansion than these is reported `failed`
   * BEFORE it is streamed, because clamd skips an oversized member and answers "OK" without saying it skipped
   * anything. Must match the CLAMD_CONF_* values in scanner/docker-compose.yml.
   *
   * Omitted falls back to DEFAULT_DAEMON_LIMITS, which is those same values: the check is never silently off.
   */
  daemonLimits?: DaemonLimits;
}

export interface CycleReport {
  scanned: number; clean: number; infected: number; failed: number; deferred: number;
  daemonOk: boolean; error: string | null; engine: string | null;
}

const UNEXAMINED = /^Heuristics\.(Limits\.Exceeded|Encrypted)/;
const BACKOFF_MIN_MS = 60_000, BACKOFF_MAX_MS = 6 * 3_600_000, BACKOFF_ENTRIES = 1_000;

export class Scanner {
  readonly totals = { scanned: 0, failed: 0 };
  lastCycleAt: string | null = null;
  lastCycleOk = false;
  lastError: string | null = null;
  engine: { engine: string; signaturesAt: string | null } | null = null;
  daemonOk = false;
  private backoff = new Map<string, { until: number; delay: number }>();

  private cfg: ScannerConfig;
  private api: Platform;
  private now: () => number;
  constructor(cfg: ScannerConfig, api: Platform, now: () => number = Date.now) { this.cfg = cfg; this.api = api; this.now = now; }

  private defer(fileId: string) {
    const prev = this.backoff.get(fileId);
    const delay = Math.min(prev ? prev.delay * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
    this.backoff.delete(fileId);
    this.backoff.set(fileId, { until: this.now() + delay, delay });
    // Bounded: the oldest entries go first (a Map iterates in insertion order).
    while (this.backoff.size > BACKOFF_ENTRIES) this.backoff.delete(this.backoff.keys().next().value!);
  }

  /** Daemon state and signature age, then a signed heartbeat. Never throws: a heartbeat failure is recorded. */
  async heartbeat(): Promise<void> {
    try {
      this.daemonOk = await ping(this.cfg.clamd);
      this.engine = this.daemonOk ? await version(this.cfg.clamd) : this.engine;
    } catch (e) { this.daemonOk = false; this.lastError = (e as Error).message; }
    try {
      await this.api.heartbeat({ scannerId: this.cfg.scannerId, engine: this.engine?.engine ?? null, signaturesAt: this.engine?.signaturesAt ?? null,
        daemonOk: this.daemonOk, detail: this.daemonOk ? (this.lastCycleOk ? null : this.lastError) : this.lastError, scannedTotal: this.totals.scanned, failedTotal: this.totals.failed });
    } catch (e) { this.lastError = `heartbeat: ${(e as Error).message}`; }
  }

  /** One pass over the queue. */
  async cycle(): Promise<CycleReport> {
    const rep: CycleReport = { scanned: 0, clean: 0, infected: 0, failed: 0, deferred: 0, daemonOk: false, error: null, engine: null };
    const finish = (error: string | null) => {
      rep.error = error; rep.daemonOk = this.daemonOk; rep.engine = this.engine?.engine ?? null;
      this.lastCycleAt = new Date(this.now()).toISOString(); this.lastCycleOk = !error; if (error) this.lastError = error;
      return rep;
    };
    try {
      this.daemonOk = await ping(this.cfg.clamd);
      if (this.daemonOk) this.engine = await version(this.cfg.clamd);
    } catch (e) { this.daemonOk = false; return finish((e as Error).message); }
    if (!this.daemonOk || !this.engine) return finish("clamd did not answer PING");

    let q;
    // Ask for more than one batch: files in backoff are skipped, and newer files behind them must not starve.
    try { q = await this.api.queue(100); } catch (e) { return finish(`queue: ${(e as Error).message}`); }
    const limit = Math.min(this.cfg.maxBytes, q.maxBytes || this.cfg.maxBytes);
    let attempted = 0;
    for (const item of q.files) {
      const b = this.backoff.get(item.fileId);
      if (b && b.until > this.now()) { rep.deferred++; continue; }
      if (attempted++ >= this.cfg.batch) break;
      const engine = this.engine.engine;
      const report = async (verdict: "clean" | "infected" | "failed", extra: { signature?: string; detail?: string } = {}) => {
        await this.api.result({ fileId: item.fileId, verdict, engine, scannedSha256: item.sha256, scannedAt: new Date(this.now()).toISOString(), ...extra });
        this.totals.scanned++; rep.scanned++;
        if (verdict === "failed") { this.totals.failed++; rep.failed++; this.defer(item.fileId); }
        else { this.backoff.delete(item.fileId); if (verdict === "clean") rep.clean++; else rep.infected++; }
      };
      try {
        if (item.sizeBytes > limit) { await report("failed", { detail: `larger than the scanner's limit (${item.sizeBytes} > ${limit} bytes)` }); continue; }
        const got = await this.api.file(item.fileId);
        const bytes = Buffer.from(got.base64, "base64");
        if (bytes.length > limit) { await report("failed", { detail: `received ${bytes.length} bytes, over the scanner's limit` }); continue; }
        const sha = createHash("sha256").update(bytes).digest("hex");
        if (sha !== item.sha256.toLowerCase() || sha !== got.sha256.toLowerCase()) {
          // Not a verdict: these are not the stored bytes. Try again later.
          rep.deferred++; this.defer(item.fileId); this.lastError = `bytes for ${item.fileId} did not match the recorded SHA-256`; continue;
        }
        // Decided before streaming: clamd cannot be asked whether it skipped something, so the question is settled
        // here, where the configured limits are known.
        const unexaminable = beyondDaemonLimits(bytes, this.cfg.daemonLimits ?? DEFAULT_DAEMON_LIMITS);
        if (unexaminable) { await report("failed", { detail: `not fully examined: ${unexaminable}` }); continue; }
        const v = await scanBytes(this.cfg.clamd, bytes);
        if (v.kind === "clean") await report("clean");
        else if (v.kind === "found" && UNEXAMINED.test(v.signature)) await report("failed", { detail: `not fully examined: ${v.signature}` });
        else if (v.kind === "found") await report("infected", { signature: v.signature });
        else await report("failed", { detail: `clamd: ${v.message}` });
      } catch (e) {
        if (e instanceof ClamdUnavailable) { this.daemonOk = false; return finish(e.message); }
        // 409 = the file is no longer awaiting a scan (scanned elsewhere, deleted, or already quarantined): move on.
        if (e instanceof PlatformError && e.status === 409) { rep.deferred++; continue; }
        rep.deferred++; this.defer(item.fileId); this.lastError = (e as Error).message;
      }
    }
    return finish(null);
  }

  /** Facts for the local health endpoint. Healthy only when the daemon answers and a cycle succeeded recently. */
  health(maxAgeMs: number) {
    const fresh = !!this.lastCycleAt && this.now() - Date.parse(this.lastCycleAt) <= maxAgeMs;
    return {
      ok: this.daemonOk && this.lastCycleOk && fresh, scannerId: this.cfg.scannerId, daemonOk: this.daemonOk,
      engine: this.engine?.engine ?? null, signaturesAt: this.engine?.signaturesAt ?? null,
      lastCycleAt: this.lastCycleAt, lastCycleOk: this.lastCycleOk, lastError: this.lastError, ...this.totals,
    };
  }
}
