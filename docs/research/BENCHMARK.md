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
