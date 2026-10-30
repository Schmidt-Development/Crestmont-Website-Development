# Lead research — benchmark record

## 1. Synthetic run (2026-10-30, build container): software overhead only
Command: `node --no-warnings research-worker/bench/bench.ts --n 10000 --latency 250 --concurrency 64`

Host: cloud build container, 2 vCPU Intel Xeon @ 2.10 GHz, 8.4 GB RAM, no GPU. **This is not the workstation.**

The run used the real worker code: the state file, stages A–E, the audit, the outbox, and signed delivery into the real platform pipeline (in-process, in-memory SQLite). It ran over 10,000 generated TEST DATA businesses. Every website response was simulated with 250 ms of latency, so there were no politeness waits, no robots.txt fetches, no Playwright/Lighthouse and no local model. The class mix is fixed by the generator, so the yields below describe the generator, not the market.

| Measure | Result |
|---|---|
| Records processed | 10,000 in 32.4 s (≈ 1.1 M/hour of pure software throughput) |
| Unique businesses | 10,000 |
| Phone-number availability | 90% (by construction) |
| Website-verification rate | 75% (by construction) |
| Classes | 3,500 official · 2,000 issues · 2,000 broken · 2,500 no website found |
| Sent to the platform | 5,500 (opportunity classes with a phone) |
| Qualified yield | 35% (generator mix) |
| Eligible callable yield | **0%** (outbound gate closed by design) |
| Peak worker RSS / average CPU | 275 MB / 28% |
| Incremental external fees | $0 |
| False-positive rate | **Not measurable on synthetic data** |

Conclusion: worker and platform CPU, memory and storage overhead is not the bottleneck. The 10,000-evaluated-per-day target depends on real-site latency, politeness limits and the share of slow or dead sites. Those can only be measured live.

The platform-side ingest test (`tests/research.test.ts`, TEST-001) took 2.6–2.8 s on the same host to put 10,000 prospects through the signed API in batches of 200. That ran on in-memory SQLite, not on D1.

## 2. Live run on the RTX 5090 workstation — NOT YET PERFORMED
Procedure: `RUNBOOK.md` §4. Fill this in from the worker's health counters and the dashboard after 24 h on one state.

| Measure | Result |
|---|---|
| Records evaluated per hour | — |
| Unique businesses discovered | — |
| Phone-number availability | — |
| Website-verification rate | — |
| Qualified lead yield | — |
| Eligible calling lead yield | 0 until the compliance gate changes |
| False-positive rate (100 manually verified) | — |
| CPU / GPU / RAM / disk | — |
| Overture snapshot time and size | — |
| Incremental external API / subscription fees | $0 expected; confirm |

Until this table is filled in, the 10,000-candidates-per-day target is **not** claimed as achieved.

## 3. Real-data runs (2026-10-30, GitHub-hosted runner): workflow `research-live-sample.yml`
Overture places `2026-10-21.0` inside a 0.0006°² box in Lansing, MI (`research-worker/live/request.json`), the businesses' **live websites** (robots.txt honoured, 5 s per-host interval), and the Common Crawl index `CC-MAIN-2026-43`. Results went into the **real platform pipeline**, with real migrations and the real CRM intake engine, on in-memory SQLite: **not staging**. Public output is aggregate only. Per-business evidence and the review sheet are sealed for the Founder (artifact `research-live-sample-sealed`, opened with `scripts/seal.ts open`).

Defects these runs found and fixed:
- run 2: `slow_response` included our own politeness waits;
- run 3: robots.txt redirects were treated as "disallow all";
- run 4: franchise and multi-location matching.

Final runs 7 and 8 (every business with a phone in the box, concurrency 48):

| Measure | Run 7 | Run 8 (promotion via CRM intake engine) |
|---|---|---|
| Places discovered in box | 1,350 (88.7% with phone) | same |
| Businesses researched | 1,197, 0 failed, 0 unfinished | 1,197, 0 failed, 0 unfinished |
| Websites checked | 1,106 (6,475 requests) | 1,105 (6,472 requests) |
| Official, no material issues | 375 | 375 |
| Issues with evidence | 87 | 88 |
| Broken (2 failures 5 min apart) | 20 | 20 |
| No official website found | 163 | 163 |
| Unverified | 552 (301 robots/401/403/429, 263 identity not confirmed) | 551 (298 / 265) |
| Qualified | 183 | 183 |
| CRM leads created | 160 | 159 |
| Held as duplicate / existing | 21 promotions blocked by an existing CRM contact | 21 put in the CRM duplicate-review queue, 1 linked to an existing contact |
| Duplicate leads on re-send | 0 | 0 |
| Do-not-call / CRM controls | suppressed / existing_crm | suppressed / existing_crm |
| Released for automated calling | 0 | 0 |
| Measured throughput | 3,648 businesses/hour over 20 min | 4,168 businesses/hour over 18 min |
| Per business (wall) | avg 25.9 s, p50 10.8 s, p90 61 s | avg 25.4 s, p50 10.7 s, p90 60 s |
| Worker RSS / CPU | ≤ 192 MB / ~1% | same |
| External fees | $0 | $0 |

Issue drivers in run 8 (findings with confidence ≥ 0.6, medium or higher):

| Finding | Count |
|---|---|
| Broken internal links | 24 |
| Images without alt text | 19 |
| Obsolete markup | 18 |
| Mixed content | 11 |
| No viewport | 11 |
| Redirect chain | 9 |
| Missing title | 5 |
| Slow response | 3 |
| Insecure form | 2 |
| No HTTPS | 2 |

**What this does and does not show:**
- The measured rate is about 10× the 417 businesses/hour that 10,000 per day needs. But it is 20 minutes from one datacenter IP in one small area. It is **not** a 24-hour measurement, and not Node 1. The target is therefore **not yet claimed**.
- About 25% of checks were restricted (robots rules or 401/403/429 bot protection). That is likely inflated by GitHub's datacenter IPs, so the Node 1 rate should be measured.
- The false-positive rate requires the manual review below. Without it, accuracy is **unmeasured**.

**Manual review protocol.** Open the sealed artifact of run 41145776120. `review.md` lists all 1,197 businesses in Overture GERS-id order, which is effectively random, so the **first 100 rows are the sample**. For each row, record one verdict:
- correct;
- false positive (a claimed problem that isn't there);
- false negative (a missed website or problem);
- wrong identity.

Report the counts with a 95% Wilson interval. With n = 100, a 5% observed rate has an interval of roughly 2.2–11.2%.
