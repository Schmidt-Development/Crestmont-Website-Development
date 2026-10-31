// Worker ↔ platform, end to end and in process: the worker's signed client talks to the real Crestmont request
// pipeline (src/app/app.ts, real migrations on in-memory SQLite). TEST DATA only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "../../tests/support/app.ts";
import { handle } from "../../src/app/app.ts";
import { addDnc } from "../../src/services/voice-outbound.ts";
import { State } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";
import { Platform } from "../src/crm-client.ts";
import { ResearchWorker } from "../src/orchestrator.ts";
import { silentLogger } from "../src/log.ts";
import type { Candidate, SourceAdapter } from "../src/sources/types.ts";
import { FakeHttp, cand, ok, status, page } from "./helpers.ts";
import type { SqliteDb } from "../../dev/sqlite-d1.ts";

const SECRET = "integration-research-secret-0123456789abcdef";

class ListSource implements SourceAdapter {
  readonly id = "overture" as const;
  readonly items: Candidate[];
  constructor(items: Candidate[]) { this.items = items; }
  async prepare() { return { release: "2026-10-21.0" }; }
  async *candidates(state: string) { for (const c of this.items) if (c.address.state === state) yield c; }
}

async function world(opts: { secret?: string; items?: Candidate[]; http?: FakeHttp } = {}) {
  const app = await createTestApp({ RESEARCH_RUNNER_SECRET: SECRET });
  let drop = 0; // simulate responses lost on the way back (request processed, answer never arrives)
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const res = await handle(new Request(url, init), app.env);
    if (drop > 0 && String(url).endsWith("/batch")) { drop--; throw new Error("socket hang up (simulated)"); }
    return res;
  }) as typeof fetch;
  const cfg = loadConfig({ CRESTMONT_URL: "https://crestmont.test", RESEARCH_RUNNER_SECRET: opts.secret ?? SECRET, RESEARCH_STATES: "MI", COMMON_CRAWL: "off", PLAYWRIGHT: "off", HTTP_CONCURRENCY: "4" });
  const state = new State(":memory:");
  const items = opts.items ?? [
    cand({ businessKey: "overture:broken1", name: "Riverside Plumbing", phones: ["+15175552142"], websites: ["https://riverside-plumbing.example/"] }),
    cand({ businessKey: "overture:nosite1", name: "Maple Street Bakery", phones: ["+15175552150"], websites: [], address: { line: "9 Maple St", city: "Lansing", state: "MI", zip: "48933" } }),
    cand({ businessKey: "overture:healthy1", name: "Lakeview Dental", phones: ["+15175552160"], websites: ["https://lakeview-dental.example/"], address: { line: "4 Lake Rd", city: "Lansing", state: "MI", zip: "48933" } }),
    cand({ businessKey: "overture:crm1", name: "Existing Customer Co", phones: ["+15175552170"], websites: [] }),
  ];
  const http = opts.http ?? new FakeHttp({
    "https://riverside-plumbing.example/": status("https://riverside-plumbing.example/", 502),
    "http://riverside-plumbing.example/": status("http://riverside-plumbing.example/", 502),
    "https://lakeview-dental.example/": ok("https://lakeview-dental.example/", page({ title: "Lakeview Dental", phone: "(517) 555-2160", street: "4 Lake Road" })),
  });
  const worker = new ResearchWorker({ cfg: { ...cfg, http: { ...cfg.http, brokenAttempts: 1 } }, state, http: http as never, platform: new Platform(cfg.platformUrl, cfg.secret, fetchImpl), sources: [new ListSource(items)], cc: null, browser: null, model: null, log: silentLogger });
  const drain = async () => { for (let i = 0; i < 10; i++) { const rows = state.claim(50, new Date(), 600_000); if (!rows.length) break; await Promise.all(rows.map((r) => worker.processOne(r))); } };
  return { app, worker, state, drain, raw: (app.db as SqliteDb).raw, dropNext: (n: number) => { drop = n; } };
}

test("[integration] research ships paused: the worker holds until the Owner resumes, then ingests, verifies and delivers", async () => {
  const w = await world();
  await w.worker.heartbeat();
  assert.equal(w.worker.paused, true);
  await w.worker.ingestOnce();
  assert.equal(w.state.backlog(), 0, "nothing ingested while paused");
  w.raw.prepare(`UPDATE research_settings SET paused = 0 WHERE id = 1`).run();
  await w.worker.heartbeat();
  assert.equal(w.worker.paused, false);
  await w.worker.ingestOnce();
  assert.equal(w.state.backlog(), 4);
  await w.drain();
  const d = await w.worker.deliverOnce();
  assert.equal(d.sent, 3, "broken + no-website + existing-CRM candidates are sent; the healthy official site is not");
  const rows = w.raw.prepare(`SELECT business_key, website_class, status FROM research_prospects ORDER BY business_key`).all() as { business_key: string; website_class: string; status: string }[];
  assert.deepEqual(rows.map((r) => [r.business_key, r.website_class]), [["overture:broken1", "VERIFIED_WEBSITE_BROKEN"], ["overture:crm1", "NO_OFFICIAL_WEBSITE_FOUND"], ["overture:nosite1", "NO_OFFICIAL_WEBSITE_FOUND"]]);
  assert.equal(w.worker.status().classCounts.VERIFIED_OFFICIAL_WEBSITE, 1, "counted locally");
  const hb = w.raw.prepare(`SELECT status_json FROM research_runners`).get() as { status_json: string };
  await w.worker.heartbeat();
  assert.match((w.raw.prepare(`SELECT status_json FROM research_runners`).get() as { status_json: string }).status_json, /"evaluated":4/);
  assert.ok(hb);
});

test("[integration] duplicate protection end to end: an existing CRM contact and a do-not-call number never become new calling opportunities", async () => {
  const w = await world();
  w.raw.prepare(`UPDATE research_settings SET paused = 0 WHERE id = 1`).run();
  w.raw.prepare(`INSERT INTO contacts (id, name, phone, created_at) VALUES ('ct_existing', 'Existing Customer', '(517) 555-2170', '2026-10-01T00:00:00Z')`).run();
  await addDnc(w.app.db, "517-555-2150", "staff", "TEST DATA opt-out");
  await w.worker.heartbeat(); await w.worker.ingestOnce(); await w.drain(); await w.worker.deliverOnce();
  const st = (k: string) => (w.raw.prepare(`SELECT status FROM research_prospects WHERE business_key = ?`).get(k) as { status: string }).status;
  assert.equal(st("overture:crm1"), "existing_crm");
  assert.equal(st("overture:nosite1"), "suppressed");
  assert.equal((w.raw.prepare(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible'`).get() as { n: number }).n, 0, "nothing is released for automated calling");
});

test("[integration] idempotent retries: a batch whose answer was lost is re-sent with the same id and stored once", async () => {
  const w = await world();
  w.raw.prepare(`UPDATE research_settings SET paused = 0 WHERE id = 1`).run();
  await w.worker.heartbeat(); await w.worker.ingestOnce(); await w.drain();
  w.dropNext(1);
  assert.equal((await w.worker.deliverOnce()).sent, 0, "answer lost");
  assert.equal((w.raw.prepare(`SELECT COUNT(*) AS n FROM research_batches`).get() as { n: number }).n, 1, "the platform did store it");
  w.raw.prepare(`SELECT 1`).get();
  w.state.db.prepare(`UPDATE outbox SET next_at = ?`).run(new Date(0).toISOString());
  assert.equal((await w.worker.deliverOnce()).sent, 3, "retry answered from the stored result");
  assert.equal((w.raw.prepare(`SELECT COUNT(*) AS n FROM research_batches`).get() as { n: number }).n, 1);
  assert.equal((w.raw.prepare(`SELECT COUNT(*) AS n FROM research_prospects`).get() as { n: number }).n, 3);
  assert.equal(w.state.outboxDepth(), 0);
});

test("[integration] CRM authentication failure: delivery stops, the outbox is kept, health reports it; nothing is lost", async () => {
  const w = await world({ secret: "wrong-secret-wrong-secret-wrong-secret-00" });
  await w.worker.heartbeat();
  assert.equal(w.worker.paused, true);
  assert.equal(w.worker.status().platform.authFailed, true);
  // Results produced earlier stay in the outbox until the secret is fixed.
  w.state.upsertCandidate(cand(), "MI", new Date(), 30); w.state.claim(1, new Date(), 1000); w.state.finish("overture:t1", { x: 1 }, new Date());
  assert.equal((await w.worker.deliverOnce()).paused, true);
  assert.equal(w.state.stages().ready, 1);
});

test("[integration] restart recovery: work leased by a crashed worker is finished by the next one from the same state file", async () => {
  const w = await world();
  w.raw.prepare(`UPDATE research_settings SET paused = 0 WHERE id = 1`).run();
  await w.worker.heartbeat(); await w.worker.ingestOnce();
  const leased = w.state.claim(4, new Date(), 5); // a worker took them with a short lease, then died
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(leased.length, 4);
  await w.drain();   // the "new" worker sees the expired leases
  assert.equal((await w.worker.deliverOnce()).sent, 3);
  assert.equal(w.state.backlog(), 0);
});

test("[integration] unavailable source: an error in one state is reported in the status and does not stop other work", async () => {
  const w = await world();
  w.raw.prepare(`UPDATE research_settings SET paused = 0 WHERE id = 1`).run();
  await w.worker.heartbeat();
  const broken: SourceAdapter = { id: "overture", prepare: async () => { throw new Error("S3 unreachable (simulated)"); }, candidates: async function* () {} };
  const w2 = new ResearchWorker({ ...(w.worker as unknown as { d: ConstructorParameters<typeof ResearchWorker>[0] }).d, sources: [broken] });
  await w2.heartbeat();
  await w2.ingestOnce();
  assert.match(JSON.stringify(w2.status().sources), /S3 unreachable/);
});
