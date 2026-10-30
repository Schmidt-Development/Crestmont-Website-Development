// Durable worker state in a local SQLite file (node:sqlite, no dependency). Survives crashes and restarts:
// every candidate's stage, lease, attempts and result live here, plus the outbox of batches not yet acknowledged by
// the platform, source checkpoints and the day's counters. WAL mode; one process owns the file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { stableJson } from "../../src/domain/research.ts";
import type { Candidate } from "./sources/types.ts";

export type Stage = "pending" | "working" | "ready" | "sent" | "skipped" | "failed";

export interface CandidateRow { business_key: string; payload: string; stage: Stage; attempts: number; next_at: string; state: string | null; result: string | null; probe: string | null }

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export class State {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS candidates (
        business_key TEXT PRIMARY KEY, payload TEXT NOT NULL, source_hash TEXT NOT NULL, state TEXT,
        stage TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, lease_until TEXT,
        last_error TEXT, probe TEXT, result TEXT, result_hash TEXT, verified_at TEXT, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_cand_stage ON candidates(stage, next_at);
      CREATE TABLE IF NOT EXISTS phone_index (phone TEXT NOT NULL, business_key TEXT NOT NULL, PRIMARY KEY (phone, business_key));
      CREATE TABLE IF NOT EXISTS domain_index (domain TEXT NOT NULL, business_key TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (domain, business_key));
      CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (batch_id TEXT PRIMARY KEY, body TEXT NOT NULL, keys TEXT NOT NULL, n INTEGER NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_error TEXT);
      CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, evaluated INTEGER NOT NULL DEFAULT 0, websites_checked INTEGER NOT NULL DEFAULT 0, failed_jobs INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cc_cache (domain TEXT PRIMARY KEY, crawl TEXT NOT NULL, captures INTEGER NOT NULL, last_status INTEGER, last_fetch TEXT, at TEXT NOT NULL);`);
  }
  close() { this.db.close(); }

  // ── Ingest (skip unchanged source records) ──
  /** Inserts or refreshes a candidate. Unchanged source data keeps its stage; changed data (or due re-verification) goes back to pending. */
  upsertCandidate(c: Candidate, state: string, now: Date, reverifyAfterDays: number): "new" | "changed" | "unchanged" {
    const payload = stableJson(c);
    const hash = sha256(stableJson({ ...c, sources: c.sources.map((s) => ({ ...s, retrievedAt: undefined, release: undefined })) }));
    const prev = this.db.prepare(`SELECT source_hash, stage, verified_at FROM candidates WHERE business_key = ?`).get(c.businessKey) as { source_hash: string; stage: Stage; verified_at: string | null } | undefined;
    const at = now.toISOString();
    for (const p of c.phones) this.db.prepare(`INSERT OR IGNORE INTO phone_index (phone, business_key) VALUES (?, ?)`).run(p, c.businessKey);
    if (!prev) {
      this.db.prepare(`INSERT INTO candidates (business_key, payload, source_hash, state, stage, next_at, updated_at) VALUES (?,?,?,?,'pending',?,?)`).run(c.businessKey, payload, hash, state, at, at);
      return "new";
    }
    const stale = prev.verified_at && now.getTime() - Date.parse(prev.verified_at) > reverifyAfterDays * 86400e3;
    if (prev.source_hash === hash && !stale) return "unchanged";
    if (prev.stage === "working") return "unchanged"; // in flight; picked up again on the next refresh
    this.db.prepare(`UPDATE candidates SET payload = ?, source_hash = ?, state = ?, stage = 'pending', attempts = 0, next_at = ?, last_error = NULL, updated_at = ? WHERE business_key = ?`).run(payload, hash, state, at, at, c.businessKey);
    return "changed";
  }
  indexDomain(domain: string, businessKey: string, source: string) {
    this.db.prepare(`INSERT OR IGNORE INTO domain_index (domain, business_key, source) VALUES (?,?,?)`).run(domain, businessKey, source);
  }
  businessesForDomain(domain: string): { business_key: string; source: string }[] {
    return this.db.prepare(`SELECT business_key, source FROM domain_index WHERE domain = ?`).all(domain) as { business_key: string; source: string }[];
  }
  businessesForPhone(phone: string): string[] {
    return (this.db.prepare(`SELECT business_key FROM phone_index WHERE phone = ?`).all(phone) as { business_key: string }[]).map((r) => r.business_key);
  }
  candidate(key: string): Candidate | null {
    const r = this.db.prepare(`SELECT payload FROM candidates WHERE business_key = ?`).get(key) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) as Candidate : null;
  }

  // ── Work queue with leases (crash-safe) ──
  backlog(): number { return (this.db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE stage IN ('pending','working')`).get() as { n: number }).n; }
  /** Leases up to n due candidates. A lease that expires (crash, kill) makes the candidate due again. */
  claim(n: number, now: Date, leaseMs: number): CandidateRow[] {
    const at = now.toISOString(), until = new Date(now.getTime() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT business_key, payload, stage, attempts, next_at, state, result, probe FROM candidates
          WHERE (stage = 'pending' AND next_at <= ?) OR (stage = 'working' AND lease_until < ?) ORDER BY next_at LIMIT ?`).all(at, at, n) as unknown as CandidateRow[];
      const upd = this.db.prepare(`UPDATE candidates SET stage = 'working', lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE business_key = ?`);
      for (const r of rows) upd.run(until, at, r.business_key);
      this.db.exec("COMMIT");
      return rows;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  /** Not finished yet (e.g. a broken site must fail again later before it is called broken). */
  defer(key: string, until: Date, probe: unknown, note: string) {
    this.db.prepare(`UPDATE candidates SET stage = 'pending', next_at = ?, lease_until = NULL, probe = ?, last_error = ?, attempts = MAX(0, attempts - 1), updated_at = ? WHERE business_key = ?`)
      .run(until.toISOString(), JSON.stringify(probe), note.slice(0, 300), new Date().toISOString(), key);
  }
  fail(key: string, err: string, now: Date, maxAttempts: number) {
    const r = this.db.prepare(`SELECT attempts FROM candidates WHERE business_key = ?`).get(key) as { attempts: number } | undefined;
    const final = (r?.attempts ?? 0) >= maxAttempts;
    const backoff = Math.min(24 * 3600e3, 60e3 * 2 ** (r?.attempts ?? 1));
    this.db.prepare(`UPDATE candidates SET stage = ?, next_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE business_key = ?`)
      .run(final ? "failed" : "pending", new Date(now.getTime() + backoff).toISOString(), err.slice(0, 500), now.toISOString(), key);
    this.bump("failed_jobs", now);
  }
  /** Finished: result recorded; "ready" results are batched to the platform, "skipped" ones are not sent. */
  finish(key: string, result: unknown | null, now: Date) {
    const json = result === null ? null : stableJson(result);
    const hash = json ? sha256(json) : null;
    const prev = this.db.prepare(`SELECT result_hash, stage FROM candidates WHERE business_key = ?`).get(key) as { result_hash: string | null } | undefined;
    const stage: Stage = !json ? "skipped" : prev?.result_hash === hash ? "sent" : "ready";
    this.db.prepare(`UPDATE candidates SET stage = ?, result = COALESCE(?, result), result_hash = COALESCE(?, result_hash), lease_until = NULL, last_error = NULL, verified_at = ?, updated_at = ? WHERE business_key = ?`)
      .run(stage, json, hash, now.toISOString(), now.toISOString(), key);
    this.bump("evaluated", now);
  }

  // ── Outbox (idempotent batches survive restarts) ──
  /** Moves up to n ready results into one outbox batch with a fresh batch id. */
  enqueueBatch(n: number, now: Date): { batchId: string; n: number } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT business_key, result FROM candidates WHERE stage = 'ready' ORDER BY updated_at LIMIT ?`).all(n) as { business_key: string; result: string }[];
      if (!rows.length) { this.db.exec("COMMIT"); return null; }
      const batchId = `rb_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(8).toString("hex")}`;
      this.db.prepare(`INSERT INTO outbox (batch_id, body, keys, n, created_at, next_at) VALUES (?,?,?,?,?,?)`)
        .run(batchId, `[${rows.map((r) => r.result).join(",")}]`, JSON.stringify(rows.map((r) => r.business_key)), rows.length, now.toISOString(), now.toISOString());
      const upd = this.db.prepare(`UPDATE candidates SET stage = 'sent', updated_at = ? WHERE business_key = ?`);
      for (const r of rows) upd.run(now.toISOString(), r.business_key);
      this.db.exec("COMMIT");
      return { batchId, n: rows.length };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  nextOutbox(now: Date): { batch_id: string; body: string; keys: string; n: number; attempts: number } | null {
    return (this.db.prepare(`SELECT batch_id, body, keys, n, attempts FROM outbox WHERE next_at <= ? ORDER BY created_at LIMIT 1`).get(now.toISOString()) as { batch_id: string; body: string; keys: string; n: number; attempts: number } | undefined) ?? null;
  }
  ackOutbox(batchId: string, now: Date, n: number) { this.db.prepare(`DELETE FROM outbox WHERE batch_id = ?`).run(batchId); this.bump("sent", now, n); }
  retryOutbox(batchId: string, err: string, delayMs: number, now: Date) {
    this.db.prepare(`UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE batch_id = ?`).run(new Date(now.getTime() + delayMs).toISOString(), err.slice(0, 300), batchId);
  }
  /** The platform answered 413 for this batch: put its records back as ready, to be re-batched smaller. */
  splitOutbox(batchId: string, now: Date) {
    const r = this.db.prepare(`SELECT keys FROM outbox WHERE batch_id = ?`).get(batchId) as { keys: string } | undefined;
    if (!r) return;
    // Only records still as they were sent go back to ready; one re-queued meanwhile (changed source data) is re-verified instead.
    const upd = this.db.prepare(`UPDATE candidates SET stage = 'ready', updated_at = ? WHERE business_key = ? AND stage = 'sent'`);
    for (const k of JSON.parse(r.keys) as string[]) upd.run(now.toISOString(), k);
    this.db.prepare(`DELETE FROM outbox WHERE batch_id = ?`).run(batchId);
  }
  /** A batch the platform refuses permanently (400/422) or after too many attempts: its records are marked failed with the reason. */
  parkOutbox(batchId: string, reason: string, now: Date) {
    const r = this.db.prepare(`SELECT keys FROM outbox WHERE batch_id = ?`).get(batchId) as { keys: string } | undefined;
    if (!r) return;
    this.markRejected((JSON.parse(r.keys) as string[]).map((k) => ({ businessKey: k, issues: [reason] })), now);
    this.db.prepare(`DELETE FROM outbox WHERE batch_id = ?`).run(batchId);
  }
  /** Records the platform rejected (validation) are marked failed with the reason; they are not retried blindly. */
  markRejected(keys: { businessKey: string | null; issues: string[] }[], now: Date) {
    const upd = this.db.prepare(`UPDATE candidates SET stage = 'failed', last_error = ?, updated_at = ? WHERE business_key = ?`);
    for (const k of keys) if (k.businessKey) { upd.run(`rejected by platform: ${k.issues.join("; ")}`.slice(0, 500), now.toISOString(), k.businessKey); this.bump("failed_jobs", now); }
  }
  outboxDepth(): number { return (this.db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM outbox`).get() as { n: number }).n; }

  // ── Checkpoints and counters ──
  getCheckpoint(key: string): string | null { return (this.db.prepare(`SELECT value FROM checkpoints WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null; }
  setCheckpoint(key: string, value: string) { this.db.prepare(`INSERT INTO checkpoints (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString()); }
  bump(col: "evaluated" | "websites_checked" | "failed_jobs" | "sent", now: Date, by = 1) {
    this.db.prepare(`INSERT INTO days (day, ${col}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + excluded.${col}`).run(today(now), by);
  }
  day(now: Date) { return (this.db.prepare(`SELECT * FROM days WHERE day = ?`).get(today(now)) as { evaluated: number; websites_checked: number; failed_jobs: number; sent: number } | undefined) ?? { evaluated: 0, websites_checked: 0, failed_jobs: 0, sent: 0 }; }
  stages(): Record<string, number> {
    return Object.fromEntries((this.db.prepare(`SELECT stage, COUNT(*) AS n FROM candidates GROUP BY stage`).all() as { stage: string; n: number }[]).map((r) => [r.stage, r.n]));
  }

  // ── Common Crawl result cache (one lookup per domain per crawl) ──
  ccGet(domain: string, crawl: string) { return (this.db.prepare(`SELECT captures, last_status, last_fetch FROM cc_cache WHERE domain = ? AND crawl = ?`).get(domain, crawl) as { captures: number; last_status: number | null; last_fetch: string | null } | undefined) ?? null; }
  ccPut(domain: string, crawl: string, captures: number, lastStatus: number | null, lastFetch: string | null) {
    this.db.prepare(`INSERT INTO cc_cache (domain, crawl, captures, last_status, last_fetch, at) VALUES (?,?,?,?,?,?) ON CONFLICT(domain) DO UPDATE SET crawl = excluded.crawl, captures = excluded.captures, last_status = excluded.last_status, last_fetch = excluded.last_fetch, at = excluded.at`)
      .run(domain, crawl, captures, lastStatus, lastFetch, new Date().toISOString());
  }
}
