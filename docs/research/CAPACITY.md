# Lead research — what actually runs, and what 60,000 a day would take

Audit date **2026-11-02**. Architecture: `README.md`. Operations: `RUNBOOK.md`. Throughput record: `BENCHMARK.md`.
Calling rules: `COMPLIANCE-GATE.md` (unchanged by this work).

Every figure below is either measured here, read from a real staging run, or an arithmetic consequence of those. Where
something is an estimate or was not measurable from this session, it says so.

## 1. Is the Research Agent running? No.

The research **code** is merged and live on staging; there is no evidence the research **worker** has ever run, and
strong evidence that it has not. The platform side is healthy: every one of the 13 research checks in the latest
staging deploy passed against live staging D1.

| Question | Answer | Evidence |
|---|---|---|
| Is the platform side deployed? | **On staging only.** Migration `0051_lead_research.sql` applied, all six tables present. **Production has never been deployed** (`deploy-production.yml`: zero runs), so research does not exist there | `research.migration_applied — 6 research tables`, staging deploy run 41364900468, 2026-11-02 00:54 UTC |
| Is `CrestmontResearch-Worker` installed on Node 1? | **Almost certainly not — but this is an inference, not a direct observation** (see below) | `PRODUCTION.md` ("not deployed anywhere") and `README.md` both record that no session has had workstation access; the staging prospect count is consistent only with the per-deploy E2E |
| Is its scheduled task enabled / started in the past 24 h? | **Not directly observable from here.** No worker-reported day counters exist on staging | `research_runner_days` is the worker's own counter table and the dashboard's "evaluated" reads from it; the dashboard reported no worker-driven throughput |
| Is research paused? | **Yes, paused on staging, and it is paused right now** | Ships paused (`research_settings.paused = 1`, seeded by migration 0051). The latest E2E recorded `PASS research.paused_refuses_batches`, i.e. it found research paused when it started |
| Has the Overture snapshot downloaded? | **No full snapshot anywhere.** Only tiny bounding-box extracts per deploy | `{"release":"2026-10-21.0","placesInBbox":1350,"written":30}` — one 0.03° × 0.02° box in Lansing, MI |
| Is ingestion progressing? | **No continuous ingestion exists** | The ingest loop only runs inside the worker, which does not run |
| Is website verification running? | **Only for 30 businesses per staging deploy** | `PASS research.real_batch_to_staging_d1 — 30 real businesses researched` |
| Are outbound batches accumulating locally? | **No local state exists** (the E2E uses an in-memory state file and discards it) | `new State(":memory:")` in `scripts/research-staging-e2e.ts` |
| Does Cloudflare accept research batches? | **Yes.** Signed delivery, replay protection and idempotency all pass against live staging D1 | `PASS research.unsigned_refused`, `PASS research.replay_refused`, `PASS research.batch_retry_idempotent` |
| Any auth / migration / config / network / rate-limit errors? | **None in the latest run.** 13 of 13 research checks passed | Staging deploy run 41364900468, step "Lead research E2E", 2026-11-02 00:54–01:06 UTC |
| Is CRM promotion automatic or manual? | **Manual, one prospect at a time, by an Owner** | `POST /staff/research/promote` takes a single `prospect_id`; no bulk route exists |
| Are research records stored separately from CRM leads? | **Yes, by design** | `research_prospects` is not the CRM. A prospect becomes a lead only through an audited promotion |

### Why the CRM holds only a few hundred leads
Not a failure. **Nothing has ever been running that could produce more.** The only thing that has ever created a
research prospect or a research lead is the staging deploy's own end-to-end test, and it is deliberately tiny:

- it extracts Overture places for **one small bounding box** in Lansing, MI (1,350 places in the box);
- it keeps a **different deterministic 30** of them each UTC day (`overture-sample.ts`: `slice(0, min(100, limit))` with `limit: 30`);
- it researches those 30, and of those only the opportunity classes with a phone are sent — **7 in the latest run**;
- it promotes at most **`maxPromotions: 5`** per deploy, and only records not already decided;
- then it **pauses research again** and leaves.

`deploy-staging` has run **123 times**. At a ceiling of 5 promotions each, a few hundred leads is exactly the
arithmetic. Staging D1 currently holds **4,834 research prospects** and the latest deploy added **2** CRM leads.

**And those leads are on staging, not production.** `deploy-production.yml` has **never run** — zero workflow runs —
so migration `0051_lead_research.sql` has never been applied to the production database and the production CRM
contains **no research leads at all, and no research tables**. Any "few hundred research leads" being looked at are
staging's, produced by the deploy test. This also means production activation is not a matter of resuming research:
production has never been deployed at all (`PRODUCTION.md` §7 step 1 onwards).

So, against the list the audit was asked to distinguish between: this is **missing deployment**, not paused execution,
not ingestion failure, not a verification backlog, not delivery failure, not qualification rejection, and not a manual
promotion bottleneck. Every stage that has been exercised works. None of them has been given more than 30 businesses
a day to work on.

### The one inference in this report, and how to settle it in 30 seconds
Everything else above is a direct reading of a real staging run. Whether a worker exists on Node 1 is **not**, because
this session cannot reach either Node 1 or staging D1 directly. The inference rests on three things: the two
production-readiness documents both state the worker has never been installed; a worker keeps heartbeating **even
while research is paused** (by design, so that resuming is noticed), so an installed worker pointed at staging would
have left rows behind; and 4,834 prospects is the arithmetic of 123 deploy-time E2E runs, not of a worker that has
ingested any part of a 9.2 M-business country.

The decisive check is one query, and it should be run before acting on this report:

```
wrangler d1 execute crestmont-staging --env staging --remote --command \
  "SELECT runner_id, version, first_seen_at, last_seen_at FROM research_runners ORDER BY last_seen_at DESC LIMIT 10;"
```

Every row whose `runner_id` starts with `staging-e2e-` is a deploy test's throwaway runner. **Any other row is a real
worker**, and if one exists then the diagnosis changes from "never deployed" to "deployed but not producing", and the
next step is its health endpoint and log rather than the installer. On Node 1 itself:
`Get-ScheduledTask -TaskName CrestmontResearch-Worker` and `C:\CrestmontResearch\Get-ResearchWorkerHealth.ps1`.

### What could not be checked from this session
This session runs in a cloud container with **no Cloudflare credentials, no `wrangler`, no DuckDB CLI, no GPU, no
Ollama, and no route to Node 1**. So:

- staging D1 could not be queried directly; the staging numbers above come from the deploy workflow's own live
  `wrangler d1 execute --remote` output, which is real staging data, not a reconstruction;
- Node 1's health endpoint (`127.0.0.1:8789`), its scheduled task and its logs could not be read at all;
- no live-site or GPU benchmark on the real hardware was possible.

These are the precise blockers. Nothing in this document is a guess about Node 1's current state.

## 2. The funnel, as measured

**Last 24 hours (staging, the only place research has run).** Two deploys ran the research E2E: run 41364883709 at
00:24–00:30 UTC and run 41364900468 at 00:54–01:06 UTC. Only the second reports detail, because the first deploy
failed later on an unrelated browser journey (its research step itself passed).

| Stage | Last 24 h | Note |
|---|---|---|
| Raw businesses discovered | 1,350 in the box | per deploy; the same box every time |
| Unique businesses after dedup | 30 selected | the daily slice cap, not a pipeline limit |
| Businesses evaluated | 30 | `research.real_batch_to_staging_d1` |
| Websites successfully checked | 12 of 30 verified | 10 official + 1 issues + 1 broken |
| Classifications | official 10 · unverified 13 · no website found 5 · issues 1 · broken 1 | |
| Evidence-backed opportunities | 7 | the classes that are sent |
| Records delivered to staging | 7 | |
| Records rejected | 0 | |
| Duplicates / suppressed | 0 new | `research.no_duplicate_lead_on_repeat_promotion` passed |
| **CRM leads created** | **2** | `research.deltas — research leads +2` |
| Research records awaiting promotion | part of the 4,834 on record | dashboard "Businesses on record" |
| Worker uptime | **0** | no worker exists |
| Processing failures | 0 | |

**Seven days.** `research-live-sample.yml` last ran on **2026-10-31** (run 13). Between then and the audit the only
research activity was the per-deploy E2E, at the same scale. There is no seven-day series worth tabulating, and no
worker-reported `research_runner_days` rows at all.

**Throughput of the latest staging run — do not read it as capacity.** 30 businesses took 266 s wall
(01:01:33 → 01:05:59) at `HTTP_CONCURRENCY: 16`, i.e. ≈ 406 businesses/hour. That is **not** a throughput
measurement: 30 items cannot fill 16 concurrent slots, so the wall time is set by the slowest few sites. The real
measured rate is in §5.

### A metrics defect found, and fixed
The run reports `prospects +54, batches +5` while having sent **7** records. Those table-wide deltas are not this
run's work: the `before` and `after` counts are two separate `wrangler d1 execute --remote` reads, so a lagging D1
read replica and/or the previous deploy's writes land inside the window. The E2E now also reports the figures
attributed to **its own runner id** (batches, records received, created, updated, rejected), which are exact, and
labels the table-wide deltas as including other writers. `scripts/research-staging-e2e.ts`.

## 3. GPU dependency: real, and it was unguarded

**Today, with default configuration, research uses no GPU at all.** `RESEARCH_MODEL` is unset by default
(`config.ts`: `name: env.RESEARCH_MODEL ?? null`), and with no model there is no inference anywhere in the pipeline.
Qualification, scoring, package choice and the compliance gate are all pure code in `src/domain/research.ts`.

**But the documented install path turns the GPU on.** `RUNBOOK.md` §1.3 tells the operator to run
`Install-ResearchWorker.ps1 -Model "<pulled Ollama model>"`, which writes `RESEARCH_MODEL=<model>` into
`settings.env`. Follow the runbook and research starts calling Ollama.

And that Ollama is **the Website Builder's Ollama**: both the runner and the research worker target
`http://127.0.0.1:11434`, so both use the one RTX 5090. The builder schedules its GPU work through
`runner/src/inference/scheduler.ts`, but that scheduler is **in-process inside the runner container** and
unreachable from the research worker, which is a native Windows scheduled task. Before this change the research
worker therefore:

1. called Ollama directly, with no admission control of any kind;
2. **awaited the draft inline inside `processOne`**, holding a verification slot while the GPU worked;
3. sent no `keep_alive`, so Ollama's 5-minute default kept the research model resident long after each draft.

That is materially harmful to website generation, and not hypothetically. The builder's own scheduler treats a model
it does not manage as `foreign`, never unloads it, and if Ollama then evicts the builder's model it records a
**failed switch → cooldown → `ModelUnavailableError`**, whose documented consequence is "builds that need it are
checkpointed and retried". A research draft could therefore delay or interrupt a customer's website build.

**What was changed** (`research-worker/src/gpu-admission.ts`, new; `model.ts`, `orchestrator.ts`, `config.ts`,
`main.ts`): a minimal cooperative admission gate over the signal the two processes *do* share — Ollama's own
`GET /api/ps`. Before each draft, research refuses the GPU when any model other than `RESEARCH_MODEL` is resident,
when `nvidia-smi` reports the GPU busier than 25%, when loading would leave less than 8 GB of VRAM headroom, or when
Ollama does not answer (unknown always counts as refused). It **never unloads another application's model**. A
refusal defers rather than fails; drafting moved out of `processOne` into its own low-priority loop, so a prospect is
delivered on its evidence immediately and wording is attached later and re-sent; `keep_alive` is now `30s`. Full
rules, settings and the "no GPU at all" option: `RUNBOOK.md` §8.

**Measured consumption.** CPU, RAM, disk and GPU are reported in every heartbeat (`resources.ts`, which already reads
`nvidia-smi`). On this container: no GPU present, 311–948 MB peak RSS and 11–52% of 4 vCPU across the 10k–60k runs
(§5). **Node 1's actual CPU/RAM/GPU/disk figures remain unmeasured**, because no session has reached the workstation.

## 4. The four 60,000-a-day targets

The Founder's goal is an outbound capacity of ~60,000 **dials** per day. That is not 60,000 new contacts per day, and
the difference decides what is buildable. Measured yields come from the real-data run 8 in `BENCHMARK.md` §3 (1,197
real businesses in Lansing, MI, live websites): **15.3% qualified**, **13.3% became CRM leads**, **5.41 HTTP requests
per business**, **4,168 businesses/hour at concurrency 48**, avg 25.4 s wall per business.

### Nationwide supply — measured, not assumed
Measured on 2026-11-02 against the release the pipeline actually uses (`2026-10-21.0`), applying the pipeline's own
filters (US address, named, not permanently closed, confidence ≥ 0.5). Method: a seeded random sample of **3.49% of
row groups (3,086,964 of 88,418,121 rows) across all 16 Parquet parts**, read over HTTP range requests with Parquet
column pruning (179 MB transferred, 268 s). Read-only public open data, no credentials.

| Overture `2026-10-21.0` | Estimate |
|---|---|
| Places worldwide | 88,418,121 (exact, from Parquet metadata) |
| **US places passing the pipeline's filters** | **10.42 M** |
| **US places with at least one phone number** | **9.20 M** ← the addressable research universe |
| US places with a phone and **no** listed website | 1.24 M |
| US places with a phone and a listed website | 7.96 M |
| Recognised brand/chain locations (excluded as brand-managed) | 0.15 M |

The binomial interval on these is ±0.4% or less, but that interval **understates the real uncertainty**: Overture's
parts are spatially ordered — US rows turned up in only **5 of the 16 parts**, and the other 11 contributed none — so
row groups are geographically clustered and the effective sample is far smaller than 3.09 M independent rows. Treat
these figures as accurate to roughly ±5%, and confirm them with a full scan when Node 1 ingests the snapshot.

An exact count needs no sampling and no new tooling — run this with the DuckDB CLI the worker already requires
(it is the same filter set as `snapshotQuery`, so it answers for the real candidate universe):

```sql
INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
SELECT count(*) AS us_places,
       count_if(len(coalesce(phones, [])) > 0) AS with_phone,
       count_if(len(coalesce(phones, [])) > 0 AND len(coalesce(websites, [])) = 0) AS phone_no_website,
       count_if(brand.wikidata IS NOT NULL) AS brand_managed
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*.parquet')
WHERE len(addresses) > 0 AND addresses[1].country = 'US' AND names.primary IS NOT NULL
  AND coalesce(confidence, 1) >= 0.5
  AND coalesce(operating_status, 'open') <> 'permanently_closed';
```

(This session could not run it: the DuckDB `httpfs` extension host is not reachable through the container's egress
proxy, which is why the sample above was read with plain HTTP range requests instead.)

### The 25,000-qualified-per-day target (2026-11-02 activation request)
At the measured 15.3% qualification rate, 25,000 qualified prospects a day needs **163,400 businesses evaluated per
day** — 6,808/hour, 113/minute, 1.9/second — which matches the Founder's own planning figures. Against the measured
real-data rate of 4,168 businesses/hour at concurrency 48, that implies **concurrency of about 80**, roughly
**884,000 HTTP requests a day** (~177 GB, ~16 Mbit/s sustained, on the unmeasured ~200 KB/request assumption) and
about **710 MB of state file growth per day**.

| Question | Answer |
|---|---|
| Is 25,000 qualified in **one** 24-hour window plausible? | **Possibly**, on software grounds. It needs ~80 concurrency to hold for 24 hours, which has never been tested: the 4,168/hour figure is an 18-minute burst from one datacenter IP in one small area, and ~25% of its checks were already being refused by robots rules or bot protection |
| Is 25,000/day **sustainable**? | **For about 56 days, then no.** The national qualified pool is ≈ 1.41 M (9.20 M with a phone × 15.3%). 1.41 M ÷ 25,000 ≈ 56 days of first-pass harvest, after which new supply is business formation plus newly-broken sites |
| What is the sustainable rate afterwards? | **Under ~3,856 new qualified prospects/day**, and realistically a few hundred. That ceiling assumes 100% of the national inventory turns over every year, which it does not |
| Does 25,000/day of *evaluation* work indefinitely? | **Yes.** Keeping the whole country current on the 30-day re-verification cycle would itself demand ~307,000 evaluations/day, so 163,400/day never runs out of legitimate work |

So the honest framing for a 24-hour proof run: **it can test whether the machine and the pipeline sustain ~6,800
evaluations/hour**, which is the real unknown. It cannot establish 25,000/day as an ongoing lead-generation rate,
because the national inventory does not contain 25,000 new qualified businesses per day to find.

### Verdict per target

| | Target | Evaluations/day needed | Concurrency needed | Feasible? |
|---|---|---|---|---|
| **A** | 60,000 **discovered**/day | — (a DuckDB scan) | n/a | **Yes.** 9.20 M with a phone = 153 days of first-pass discovery at 60k/day |
| **B** | 60,000 **evaluated**/day | 60,000 (2,500/h) | ≈ 30 | **Yes, with headroom**, and sustainable indefinitely |
| **C** | 60,000 **qualified**/day | ≈ 392,000 (16,340/h) | ≈ 190 | **Software yes for ~23 days, then no.** The whole country holds ≈ 1.41 M qualified prospects |
| **D** | 60,000 **CRM leads**/day | ≈ 451,000 (18,800/h) | ≈ 215 | **No, not sustainably.** National pool ≈ 1.22 M leads ≈ 20 days |
| **E** | 60,000 eligible **automated-calling** contacts/day | — | — | **0 today and not changeable here.** `COMPLIANCE-GATE.md`; conditions 1, 2 and 8 can never currently be met |

### Why C and D cannot be sustained
9.20 M businesses with a phone × 15.3% qualified ≈ **1.41 M qualified prospects in the entire national inventory,
ever**. At 60,000 a day that inventory is exhausted in **23 days**; for CRM leads (13.3%), **20 days**. After that the
only new supply is business formation plus sites that newly break. An upper bound settles it without needing a churn
measurement: even if **100% of the national inventory turned over every year** — which it does not — that is
9.20 M ÷ 365 × 15.3% ≈ **3,856 new qualified prospects per day**. The realistic figure is a few hundred. So a
sustained 60,000 new qualified prospects per day is out by a factor of at least 15, and claiming otherwise would mean
recycling the same businesses and calling them new.

Measuring the real churn needs two consecutive Overture releases compared through `upsertCandidate` (which already
reports `new` / `changed` / `unchanged` per state). **That has not been done** and is the one number needed to state
the sustainable rate instead of bounding it.

### What *is* sustainable, and matches the Founder's goal
- **Target B is sustainable forever.** Re-verification alone, at the 30-day cycle, would demand 9.20 M ÷ 30 ≈
  **307,000 evaluations a day** to keep the whole country current. 60,000/day is 20% of that: the engine will never
  run out of legitimate work.
- **60,000 dials/day does not need 60,000 new prospects/day.** A pool of 1.22–1.41 M supports 60,000 dials a day with
  each prospect reached about once every 20–23 days. Building that pool once costs ≈ 9.20 M evaluations: **153 days at
  60k/day, 46 days at 200k/day, 23 days at 400k/day.** Then a few hundred to a few thousand new qualified prospects a
  day keep it topped up.
- This is a research-capacity statement only. **It is not permission to dial anyone**, and nothing in this work
  changes that.

## 5. Throughput: what is proven

**Synthetic (proven here, 2026-11-02).** `BENCHMARK.md` §1b: 10,000 / 25,000 / 60,000 records at concurrency 64 with
250 ms simulated site latency, on 4 vCPU / 15 GB / no GPU. 489,000–523,000 records/hour, linear to 60,000, **zero**
failed jobs, zero rejections, zero batch retries, nothing left in the outbox. CPU reached 52% only at 60,000.
About 94% of the wall time is the simulated latency, so this proves the software adds ~6% overhead and loses nothing —
**it is not a capacity ceiling**, and it says nothing about real sites or real hardware.

**Real data (pre-existing, not re-run here).** `BENCHMARK.md` §3 run 8: **4,168 businesses/hour** at concurrency 48
over 1,197 real businesses and their live websites, 18 minutes, from a GitHub datacenter IP. 183 qualified, 159 CRM
leads, 0 duplicates, 0 released for calling. ~25% of checks were restricted by robots rules or 401/403/429, which is
probably inflated by datacenter IPs.

**Maximum sustainable daily throughput — honestly, unknown.** 4,168/hour sustained for 24 hours would be
**100,000 businesses a day**, which comfortably covers target B. But that rate is an 18-minute measurement, in one
small area, from one IP, on hardware that is not Node 1. A 20-minute burst does not establish a 24-hour rate:
per-host politeness waits, the tail of slow sites, bot-protection rates on a residential/business IP, and Common
Crawl's 200-query daily cap all behave differently over a day. **Nothing here lets anyone claim 60,000 a day is
operational.** The measurement that would is `RUNBOOK.md` §4: one state, 24 hours, on Node 1, plus a hand-verified
sample of 100 results.

### Accuracy
Not re-measured in this session. The standing figure is the automated audit in `AUDIT.md`: A+B 97.5%, 93.4% of tested
material claims supported, false-positive rate 1.8%, 0 duplicate promotions, 0 do-not-call releases. Its own caveat
stands — 123 of 132 "B" leads are "no website found" records, whose central claim cannot be proven, only falsified.
**The hand-verified 100-result sample has still never been done.**

## 6. Resource requirements

Measured here unless marked as an estimate.

| Resource | Figure | Basis |
|---|---|---|
| Overture release download | **11.90 GB** across 16 Parquet parts, per release | Measured from the bucket listing |
| Bytes actually needed from it | ≈ 32% of row-group bytes (the projected columns) ⇒ **≈ 3.8 GB** per full scan | Measured from Parquet column metadata |
| US projected snapshot on disk | ≈ 0.5–1.5 GB (estimate; re-encoded, US is 11.8% of rows) | Derived |
| **Worker state file** | **927 bytes per business ingested** + **3,422 bytes per stored result** | Measured over 20,000 businesses with a file-backed state |
| **State file for a full national pass (9.20 M)** | **≈ 40 GB** | 9.20 M × (927 + 3,422), linear extrapolation |
| CPU | Not the constraint. 52% of 4 vCPU at 489,000 records/hour of software throughput; target B needs 2,500/hour | Measured |
| RAM | Worker process stayed ≤ 948 MB, and that figure is dominated by the **benchmark's** own in-memory fixtures and in-memory SQLite, not the worker's working set | Measured, with caveat |
| Network, target B (60k evaluated/day) | 60,000 × 5.41 ≈ **325,000 requests/day**; ≈ 65 GB/day ≈ 6 Mbit/s sustained **(estimate: assumes ~200 KB/request, which was not measured)** | Derived |
| Network, target C (392k evaluated/day) | ≈ **2.12 M requests/day**; ≈ 424 GB/day ≈ 39 Mbit/s sustained (same estimate) | Derived |
| GPU | **None required.** Leave `RESEARCH_MODEL` unset. With it set, drafting is deferred whenever the builder needs the GPU | By design, now enforced |

**The ≈ 40 GB state file is the one under-documented requirement.** `RUNBOOK.md` §5 only mentions deleting old
Overture snapshots. A full national pass needs tens of gigabytes of durable space on the data drive, and that should
be confirmed on Node 1 before the first nationwide ingest. `BACKLOG_LIMIT` bounds the *queue*, not the table: every
business ever ingested keeps a row.

**No additional workers are needed for target B.** One workstation at concurrency ~30 covers it. Target C/D would need
concurrency ~190–215 and ~2.1 M requests/day from one IP, which is where a second egress path or additional workers
would start to matter — but since C and D are not sustainable against the supply, that hardware should not be bought
for this reason.

## 6b. Scalability: most of it is already built, and it is not the bottleneck

The scaling checklist the audit asked about is largely already in the code, and was verified by reading it and by the
runs in §5: partitioned per-state ingestion with durable checkpoints, incremental updates (`source_hash`, so
unchanged records are skipped), backpressure (`BACKLOG_LIMIT` pauses ingest until verification catches up), bounded
HTTP concurrency with per-host intervals and robots `Crawl-delay`, idempotent batch delivery with a stable batch id,
exponential backoff, 413 splitting, 409 pause handling, batch parking after `MAX_BATCH_ATTEMPTS`, lease-based crash
recovery, robots.txt caching per origin, Common Crawl answers cached per domain and crawl with a daily query cap, and
duplicate/suppression protection at both ingest and promotion.

Measured here, so it can be ruled out:

| Layer | Measurement | Verdict |
|---|---|---|
| Ingest into the state file | 60,000 candidates in 4.5 s | not a constraint |
| Verify + audit + deliver | linear to 60,000 records; 0 failures, 0 retries, 0 records lost | not a constraint |
| Delivery | 165 batches for 33,000 records in 24.7 s (in-process platform) | not a constraint |
| Work-queue `claim(24)` | **0.38 ms** at 1,000 pending; **7.54 ms** at the 50,000 `BACKLOG_LIMIT` default, on a 1,000,000-row state file | not a constraint: even target C needs only ~700 claims/hour |

The `claim` cost is proportional to the **pending backlog**, not to the table size (SQLite resolves the query with
`MULTI-INDEX OR` on `idx_cand_stage`, then a temp B-tree for the `ORDER BY`). That is worth knowing — raising
`BACKLOG_LIMIT` is not free — but at 7.5 ms per claim it is seconds of database time per hour at any target here.

**Two optimisations were deliberately not shipped**, because they would trade a real risk for a gain nothing currently
needs:

1. **A US bounding-box prefilter on the full snapshot query.** `snapshotQuery` adds a `bbox` constraint only when a
   bounding box is passed, and the nationwide snapshot passes none, so the Parquet reader cannot prune row groups on
   `bbox` statistics and reads the projected columns of all 16 parts (≈ 3.8 GB). Since US rows live in only 5 of those
   parts, a latitude/longitude prefilter should cut the one-time scan substantially. It was not shipped because a
   wrong bound **silently drops real businesses** — Alaska's Aleutians cross the antimeridian, and Hawaii and the
   Pacific territories sit far from the contiguous bounds — and this session cannot run the full scan to prove the
   prefilter is a strict superset of `addresses[1].country = 'US'`. To ship it: add the candidate bound, run the exact
   count in §4 with and without it, and only keep it if the two counts are identical.
2. **Restructuring the `claim` query** to avoid the temp B-tree (two indexed queries instead of an `OR`). Measured
   above as irrelevant at these volumes; changing crash-recovery semantics for a 7 ms saving is not worth the risk.

The conclusion for this phase is the same as everywhere else in this document: **the scaling machinery exists and
works; it has simply never been given more than 30 businesses a day.** The next useful engineering is driven by the
24-hour run on Node 1, not by more code.

## 7. CRM integration: the workflow is deliberately manual

Promotion is an **explicit, per-prospect Owner decision** (`POST /staff/research/promote`, one `prospect_id`), routed
through the CRM intake engine (`contact-identity.ts`, channel `research_agent`), which applies customer, suppression,
shared-identifier and duplicate-review rules and records a decision in `crm_intake_decisions`. There is no bulk route.

**This is not the current bottleneck**, so no bulk-promotion mechanism was built. The bottleneck is that only ~7
prospects per day are produced at all; a bulk tool would have nothing to act on. Building one now would also convert a
human-approval workflow into something closer to automatic insertion while the thing it approves does not yet exist —
the opposite of the order the audit asked for ("fix the real bottleneck before scaling anything").

When it *is* needed, the requirements are already established and should be implemented as a **proposal** an Owner
authorises, not an automatic path: Founder authorisation, existing-contact matching, deduplication, suppression
checks, shared-number review, idempotent processing (the intake engine's `research_agent:promote:<prospect>` key
already gives this), audit history, batch rollback or reconciliation, rate limiting, and `utm_source=crestmont-research`
attribution. Nothing about CRM insertion implies permission to call.

## 8. Monitoring

`/staff/research` already covers most of what was asked: worker online/offline and last check-in, evaluated vs
received vs qualified vs callable, duplicates prevented, failed jobs, rejected records, the classification breakdown,
per-source refresh, a 24-hour throughput chart and the 30-day CRM import success rate. The heartbeat carries
CPU/RAM/disk/GPU in `status_json`, and `Get-ResearchWorkerHealth.ps1` prints the worker's full health including the
new `drafts` counters and the last GPU admission decision. **No second dashboard was built.**

One real gap was closed: the stale-worker alert that `PRODUCTION.md` §6 listed as "not built". The existing scheduled
`ops_alerts` job now raises `research_worker_stale` and emails the Owners once per episode when research is resumed
and no worker has checked in for 30 minutes, or has **never** checked in (re-stated daily, because that is exactly
today's situation and it looks like "running" from the platform), or a worker reports its credentials refused.
Nothing is raised while research is paused.

Still not built: seven-day trend series and capacity warnings on the dashboard. Both need real worker-reported days in
`research_runner_days`, of which there are currently none.

## 9. Compliance boundary — unchanged

Nothing in this work touched the outbound gate. `outboundEligibility()` is untouched, "Verified callable today"
remains **0**, and the latest staging run proves it end to end: `PASS research.no_automated_calling` — 0 prospects
eligible, 0 outbound requests queued for any researched number. No consent check was bypassed, no DNC restriction
removed, no calling window altered, no contact added to a callable queue, and no outbound-agent behaviour changed.
Research scalability and outbound-call authorisation remain separate workstreams.

## 10. What remains before production activation

1. **Install the worker on Node 1** against staging (`RUNBOOK.md` §1) — the single blocking step, and the reason the
   CRM is nearly empty.
2. **Decide the GPU question explicitly:** leave `RESEARCH_MODEL` unset (no GPU use at all, recommended while the
   Website Builder is being developed), or set it and rely on the new admission gate.
3. **Run 24 hours on one state** and fill `BENCHMARK.md` §2 with real per-hour, CPU/RAM/GPU/disk and snapshot figures.
4. **Hand-verify 100 sent prospects** (`RUNBOOK.md` §4) — still never done; accuracy on real data is otherwise
   unmeasured by a person.
5. **Confirm disk** on Node 1 for a ≈ 40 GB state file plus snapshots before any nationwide ingest.
6. **Measure release-to-release churn** across two Overture releases, to replace the bound in §4 with a real
   sustainable rate.
7. **Founder decisions still open:** Foursquare OS access, OSM internal-use confirmation, production
   `RESEARCH_RUNNER_SECRET`, and pointing the worker at production.
8. **Outbound calling stays closed** and is a separate, counsel-reviewed decision.
