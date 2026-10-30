// The continuously running worker: four cooperative loops over the durable state.
//   ingest    open datasets → candidates (skip unchanged), state by state, checkpointed; pauses when the backlog is full
//   work      lease due candidates → verify/audit → (local model draft) → result; bounded concurrency
//   deliver   ready results → outbox batches → platform (idempotent batch ids, backoff, 413 split, 409 pause)
//   heartbeat status out, controls in (Owner pause, threshold, batch size, enabled sources)
// Owner pause stops ingest, work and delivery (heartbeats continue so resuming is noticed). Nothing is lost on pause,
// crash or restart: leases expire and work resumes from the state file.
import { createServer, type Server } from "node:http";
import type { Config } from "./config.ts";
import type { State } from "./state.ts";
import type { Http } from "./http.ts";
import type { SourceAdapter } from "./sources/types.ts";
import type { CommonCrawl } from "./sources/commoncrawl.ts";
import type { Browser } from "./browser.ts";
import type { LocalModel } from "./model.ts";
import { Platform, PlatformError, type Controls } from "./crm-client.ts";
import { evaluate, type Probe } from "./pipeline.ts";
import { qualify, validateProspect, US_STATE_TZ, type WebsiteClass } from "../../src/domain/research.ts";
import type { Logger } from "./log.ts";
import { errMsg } from "./log.ts";
import { snapshot } from "./resources.ts";

export const VERSION = "0.1.0";
/** After this many failed deliveries a batch is parked (about two days with the backoff), never retried forever. */
export const MAX_BATCH_ATTEMPTS = 60;
export const ALL_STATES = Object.keys(US_STATE_TZ);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

export interface WorkerDeps { cfg: Config; state: State; http: Http; platform: Platform; sources: SourceAdapter[]; cc: CommonCrawl | null; browser: Browser | null; model: LocalModel | null; log: Logger }

export class ResearchWorker {
  private controls: Controls = { paused: true, pauseReason: "waiting for the first heartbeat", qualifyThreshold: 60, maxBatch: 100, enabledSources: [], serverTime: "" };
  private readonly d: WorkerDeps;
  private readonly finishedAt: number[] = [];
  private readonly classCounts: Record<string, number> = {};
  private readonly sourceStatus: Record<string, { state: string; release?: string; lastRefreshAt?: string; error?: string; progress?: string }> = {};
  private platformState: { ok: boolean; lastError: string | null; lastHeartbeatAt: string | null; authFailed: boolean } = { ok: false, lastError: null, lastHeartbeatAt: null, authFailed: false };
  private inFlight = 0;
  /** Lowered after a 413 (payload too large) and kept for the life of the process, so a heartbeat cannot undo it. */
  private batchCap = Number.MAX_SAFE_INTEGER;
  private server: Server | null = null;
  constructor(d: WorkerDeps) {
    this.d = d;
    try { Object.assign(this.classCounts, JSON.parse(d.state.getCheckpoint("classCounts") ?? "{}")); } catch { /* fresh */ }
  }

  get paused() { return this.controls.paused || this.platformState.authFailed; }

  status(now = new Date()) {
    const hourAgo = now.getTime() - 3600e3;
    while (this.finishedAt.length && this.finishedAt[0] < hourAgo) this.finishedAt.shift();
    const day = this.d.state.day(now);
    return {
      day: now.toISOString().slice(0, 10), evaluated: day.evaluated, websitesChecked: day.websites_checked, failedJobs: day.failed_jobs, sentToday: day.sent,
      recordsPerHour: this.finishedAt.length, queueDepth: this.d.state.backlog(), outbox: this.d.state.outboxDepth(), stages: this.d.state.stages(), inFlight: this.inFlight,
      classCounts: this.classCounts, sources: this.sourceStatus, model: this.d.model ? `${this.d.model.name} (${this.d.model.calls} calls, ${this.d.model.failures} failed)` : "off (no RESEARCH_MODEL)",
      browser: this.d.browser ? "playwright" : "off", paused: this.paused, platform: this.platformState,
    };
  }

  // ───── heartbeat ─────
  async heartbeat(): Promise<void> {
    const status = { ...this.status(), resources: await snapshot(this.d.cfg.dataDir) };
    try {
      this.controls = await this.d.platform.heartbeat(this.d.cfg.runnerId, VERSION, status);
      this.platformState = { ok: true, lastError: null, lastHeartbeatAt: new Date().toISOString(), authFailed: false };
      this.d.state.setCheckpoint("classCounts", JSON.stringify(this.classCounts));
    } catch (e) {
      const auth = e instanceof PlatformError && (e.status === 401 || e.status === 403);
      this.platformState = { ...this.platformState, ok: false, lastError: errMsg(e), authFailed: auth };
      this.d.log[auth ? "error" : "warn"]("heartbeat failed", { status: (e as PlatformError).status, error: errMsg(e) });
    }
  }

  // ───── ingest ─────
  async ingestOnce(signal?: AbortSignal): Promise<void> {
    const states = this.d.cfg.states.length ? this.d.cfg.states : ALL_STATES;
    for (const src of this.d.sources) {
      if (signal?.aborted || this.paused) return;
      if (!this.controls.enabledSources.includes(src.id)) { this.sourceStatus[src.id] = { state: "disabled on the platform" }; continue; }
      let release: string;
      try { ({ release } = await src.prepare()); }
      catch (e) { this.sourceStatus[src.id] = { state: "error", error: errMsg(e) }; this.d.log.error("source prepare failed", { source: src.id, error: errMsg(e) }); continue; }
      this.sourceStatus[src.id] = { ...this.sourceStatus[src.id], state: "ingesting", release };
      let doneStates = 0;
      for (const st of states) {
        if (signal?.aborted || this.paused) return;
        const key = `ingest:${src.id}:${release}:${st}`;
        if (this.d.state.getCheckpoint(key)) { doneStates++; continue; }
        const counts = { new: 0, changed: 0, unchanged: 0 };
        try {
          for await (const c of src.candidates(st)) {
            while (this.d.state.backlog() >= this.d.cfg.pipeline.backlogLimit && !signal?.aborted && !this.paused) await sleep(30_000, signal); // backpressure
            if (signal?.aborted || this.paused) return; // state not checkpointed: it is re-read (unchanged records are skipped)
            counts[this.d.state.upsertCandidate(c, st, new Date(), this.d.cfg.pipeline.reverifyAfterDays)]++;
          }
          this.d.state.setCheckpoint(key, JSON.stringify({ ...counts, at: new Date().toISOString() }));
          doneStates++;
          this.sourceStatus[src.id].progress = `${doneStates}/${states.length} states`;
          this.d.log.info("state ingested", { source: src.id, release, state: st, ...counts });
        } catch (e) {
          this.sourceStatus[src.id] = { ...this.sourceStatus[src.id], state: "error", error: errMsg(e) };
          this.d.log.error("state ingest failed", { source: src.id, state: st, error: errMsg(e) });
        }
      }
      if (doneStates === states.length) this.sourceStatus[src.id] = { state: "current", release, lastRefreshAt: this.d.state.getCheckpoint(`refreshed:${src.id}:${release}`) ?? (this.d.state.setCheckpoint(`refreshed:${src.id}:${release}`, new Date().toISOString()), new Date().toISOString()), progress: `${doneStates}/${states.length} states` };
    }
  }

  // ───── work ─────
  async processOne(row: { business_key: string; payload: string; probe: string | null }): Promise<void> {
    const now = new Date();
    try {
      const c = JSON.parse(row.payload);
      const out = await evaluate(c, {
        http: this.d.http, state: this.d.state, cc: this.d.cc, browser: this.d.browser, lighthousePath: this.d.cfg.lighthouse.path,
        brokenAttempts: this.d.cfg.http.brokenAttempts, brokenRecheckAfterMs: this.d.cfg.http.brokenRecheckAfterMs, checkLinks: true,
      }, row.probe ? JSON.parse(row.probe) as Probe : null);
      if (out.kind === "defer") { this.d.state.defer(row.business_key, out.until, out.probe, out.note); return; }
      this.classCounts[out.cls] = (this.classCounts[out.cls] ?? 0) + 1;
      if (!out.send) { this.d.state.finish(row.business_key, null, new Date()); this.finishedAt.push(Date.now()); return; }
      const v = validateProspect(out.prospect);
      if (!v.ok) { this.d.state.fail(row.business_key, `invalid result: ${v.issues.join("; ")}`, now, 1); return; }
      // Drafts only for prospects that qualify on the same deterministic rule the platform applies (saves GPU time).
      if (this.d.model && qualify(v.value, { threshold: this.controls.qualifyThreshold }).qualified) {
        const dr = await this.d.model.draft({ name: c.name, category: c.category, city: c.address.city, state: c.address.state, websiteClass: out.cls as WebsiteClass,
          websiteUrl: out.prospect.website.url ?? null, findings: out.prospect.findings ?? [], recommendedPackage: qualify(v.value).recommendedPackage, allowedDomains: out.prospect.domains ?? [] });
        out.prospect.summary = dr.summary; out.prospect.brief = dr.brief; out.prospect.model = dr.summary || dr.brief ? dr.model : null;
        if (dr.rejected.length) this.d.log.info("model draft rejected", { key: row.business_key, reasons: dr.rejected.slice(0, 3) });
      }
      this.d.state.finish(row.business_key, out.prospect, new Date());
      this.finishedAt.push(Date.now());
    } catch (e) {
      this.d.state.fail(row.business_key, errMsg(e), now, this.d.cfg.pipeline.maxAttempts);
      this.d.log.warn("candidate failed", { key: row.business_key, error: errMsg(e) });
    }
  }

  async workLoop(signal: AbortSignal): Promise<void> {
    const max = this.d.cfg.http.concurrency;
    const running = new Set<Promise<void>>();
    while (!signal.aborted) {
      if (this.paused) { await sleep(5_000, signal); continue; }
      const free = max - running.size;
      const rows = free > 0 ? this.d.state.claim(free, new Date(), this.d.cfg.pipeline.leaseMs) : [];
      for (const r of rows) {
        this.inFlight++;
        const p = this.processOne(r).finally(() => { this.inFlight--; running.delete(p); });
        running.add(p);
      }
      if (!rows.length && !running.size) await sleep(2_000, signal);
      else if (running.size) await Promise.race([...running, sleep(1_000, signal)]);
    }
    // Graceful shutdown: let in-flight checks finish (bounded); unfinished leases simply expire and are redone.
    await Promise.race([Promise.allSettled([...running]), sleep(30_000)]);
  }

  // ───── deliver ─────
  async deliverOnce(): Promise<{ sent: number; paused?: boolean }> {
    if (this.paused) return { sent: 0, paused: true };
    const now = new Date();
    while (this.d.state.enqueueBatch(Math.min(this.controls.maxBatch, this.batchCap), now)) { /* move all ready results into batches */ }
    let sent = 0;
    for (let ob = this.d.state.nextOutbox(now); ob; ob = this.d.state.nextOutbox(new Date())) {
      try {
        const a = await this.d.platform.batch(this.d.cfg.runnerId, ob.batch_id, ob.body);
        if (a.rejected.length) { this.d.state.markRejected(a.rejected, new Date()); this.d.log.warn("platform rejected records", { batch: ob.batch_id, n: a.rejected.length, first: a.rejected[0]?.issues.slice(0, 2) }); }
        this.d.state.ackOutbox(ob.batch_id, new Date(), a.accepted);
        sent += a.accepted;
      } catch (e) {
        const s = e instanceof PlatformError ? e.status : 0;
        if (s === 409 && /paused/i.test(errMsg(e))) { this.controls = { ...this.controls, paused: true, pauseReason: errMsg(e) }; this.d.state.retryOutbox(ob.batch_id, errMsg(e), 60_000, new Date()); return { sent, paused: true }; }
        if (s === 413) { this.d.state.splitOutbox(ob.batch_id, new Date()); this.batchCap = Math.max(1, Math.floor(Math.min(this.batchCap, this.controls.maxBatch) / 2)); return { sent }; }
        if (s === 401 || s === 403) { this.platformState.authFailed = true; this.d.state.retryOutbox(ob.batch_id, errMsg(e), 600_000, new Date()); this.d.log.error("platform refused the worker's credentials; delivery stopped until the secret is fixed", { status: s }); return { sent }; }
        if ((s === 400 || s === 422) || ob.attempts + 1 >= MAX_BATCH_ATTEMPTS) {
          this.d.state.parkOutbox(ob.batch_id, `platform refused the batch (${s || "network"}, attempt ${ob.attempts + 1}): ${errMsg(e)}`, new Date());
          this.d.log.error("batch parked; its records are marked failed with the reason", { batch: ob.batch_id, status: s, error: errMsg(e) });
          continue;
        }
        const delay = Math.min(3600_000, 30_000 * 2 ** Math.min(ob.attempts, 7)) * (0.8 + Math.random() * 0.4);
        this.d.state.retryOutbox(ob.batch_id, errMsg(e), delay, new Date());
        this.d.log.warn("batch delivery failed; will retry with the same batch id", { batch: ob.batch_id, status: s, error: errMsg(e) });
        return { sent };
      }
    }
    return { sent };
  }

  // ───── health endpoint (this machine only) ─────
  startHealth(port: number): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.url !== "/health") { res.writeHead(404).end(); return; }
      const s = this.status();
      res.writeHead(this.platformState.authFailed ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify(s));
    });
    return new Promise((r) => this.server!.listen(port, "127.0.0.1", () => r()));
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.startHealth(this.d.cfg.healthPort);
    await this.heartbeat();
    const loops = [
      (async () => { while (!signal.aborted) { await sleep(this.d.cfg.pipeline.heartbeatMs, signal); if (!signal.aborted) await this.heartbeat(); } })(),
      (async () => { while (!signal.aborted) { if (!this.paused) await this.ingestOnce(signal).catch((e) => this.d.log.error("ingest loop error", { error: errMsg(e) })); await sleep(this.paused ? 10_000 : 3600_000, signal); } })(),
      this.workLoop(signal),
      (async () => { while (!signal.aborted) { await sleep(this.d.cfg.pipeline.batchFlushMs, signal); await this.deliverOnce().catch((e) => this.d.log.error("deliver loop error", { error: errMsg(e) })); } })(),
    ];
    await Promise.allSettled(loops);
    await this.deliverOnce().catch(() => {}); // flush what is ready before exit
    await this.heartbeat();
    this.d.state.setCheckpoint("classCounts", JSON.stringify(this.classCounts));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
