# Lead research — operations runbook

Architecture and vocabulary: `README.md`. Licences: `DATA-SOURCES.md`. Calling rules: `COMPLIANCE-GATE.md`.

## 1. One-time setup (staging first)
1. **Platform secret.** Generate a value and set it on staging only:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, then
   `wrangler secret put RESEARCH_RUNNER_SECRET --env staging`.
   Production gets its own, different value, and only after the Founder approves production activation.
2. **Migration 0051.** It is applied by the normal staging deploy, which runs only from `main`. Research starts **paused**.
3. **Workstation.** In an elevated PowerShell, from a checkout of this repository:
   ```powershell
   .\research-worker\windows\Install-ResearchWorker.ps1 -PlatformUrl https://<staging host> -States "MI" -Model "<pulled Ollama model>" -Install
   ```
   The installer:
   - checks Node ≥ 22.18, the DuckDB CLI (`winget install DuckDB.cli`), and that Ollama answers on 127.0.0.1;
   - stores the secret encrypted with DPAPI;
   - runs a preflight;
   - registers the `CrestmontResearch-Worker` scheduled task (starts at logon, restarts on failure, no time limit).

   Optional tools:
   - Playwright, for mobile rendering checks: `npm i -g playwright && npx playwright install chromium`, then set `PLAYWRIGHT=on` in `settings.env`. It is off by default because Chromium resolves names itself: a hostile site could rebind DNS to an address on your LAN. Turn it on only if nothing on the workstation's network answers without authentication (router admin, NAS, printers), or put the workstation on an isolated network/VLAN;
   - Lighthouse, for indicators only: set `LIGHTHOUSE_PATH`. Lighthouse loads third-party subresources in its own Chrome, which the worker's private-address filter does not cover. Leave it off unless that is acceptable.
4. **Resume.** In `/staff/research` (Owner): review the Sources table, untick *Pause research*, then save.

## 2. Daily operation
- **Dashboard.** `/staff/research` shows:
  - evaluated (reported by the worker) vs received vs qualified vs callable, which stays at 0 by design;
  - duplicates prevented and worker health;
  - the classification breakdown, both for everything evaluated and for what was sent;
  - source coverage and last refresh, the 24-hour throughput, and failed jobs.
- **Workstation health.** `C:\CrestmontResearch\Get-ResearchWorkerHealth.ps1` (127.0.0.1:8789). Logs are JSON lines in `C:\CrestmontResearch\logs\worker-YYYYMMDD.log`, kept for 14 days.
- **Working prospects.**
  - Owner: *Create CRM lead* builds the company, contact and lead (source `manual`, `utm_source=crestmont-research`) with the evidence in the lead text. Promotion is refused if the number is on do-not-call, already belongs to a CRM contact, or someone else promoted it a moment earlier.
  - Owner: *Dismiss* (with a reason) hides a prospect permanently. Its evidence is kept.
  - "Needs review" means the phone number is shared by two or more business records. A person decides who it reaches. Records are never auto-merged.
- **Pausing.** Untick in `/staff/research`. The worker notices at its next heartbeat (≤ 60 s) and stops ingesting, verifying and sending. Its queue and outbox stay on disk.

## 3. What the worker does continuously
1. **Ingest.** Once per Overture release, it copies the US places subset (projected columns) to `data\overture\<release>\us_places.parquet`. That is one remote scan and can take hours the first time. It then works state by state, checkpointed. Records whose facts did not change are skipped. When the backlog reaches `BACKLOG_LIMIT` (default 50,000), ingest pauses until verification catches up.
2. **Verify and audit.** It leases due records, runs website stages A–E, and audits official sites. It runs at most `HTTP_CONCURRENCY` (default 24) sites at a time, and one request at a time per host with at least `HTTP_PER_HOST_INTERVAL_MS` (default 5 s) between them, or longer if robots.txt asks. A site is called broken only after `BROKEN_ATTEMPTS` (default 2) failures at least `BROKEN_RECHECK_AFTER_MS` (default 6 h) apart.
3. **Draft (optional, lowest priority on the machine).** Only for prospects that qualify under the same deterministic rule the platform uses. A draft that adds facts is discarded. Drafting is **off unless `RESEARCH_MODEL` is set**, and it never sits on the path that evaluates or delivers a prospect: the prospect goes to the platform on its evidence immediately, and the wording is attached later and re-sent if and when the GPU is free. See §8.
4. **Deliver.** Batches of up to the platform's `max_batch` go out with a stable batch id. On a network error or 5xx, the same batch is retried with exponential backoff. A 413 splits it, a 409 "paused" holds it, and a 401 stops delivery and reports it on health.
5. **Re-verify.** Every `REVERIFY_AFTER_DAYS` (default 30), and whenever the source record changes.

## 4. Benchmark (Phase 10)
- **Synthetic** (this repository, any machine):
  `node --no-warnings research-worker/bench/bench.ts --n 10000 --latency 250 --concurrency 64 --json bench.json`.
  It runs the real worker code and real platform ingest over 10,000 generated TEST DATA businesses, with simulated website latency. It measures software overhead only.
- **Live** (the workstation, the real target):
  1. Set `RESEARCH_STATES` to one mid-size state.
  2. Run for 24 hours.
  3. Record from health and the dashboard: evaluated per hour, websites checked, class counts, sent, qualified, failed jobs, CPU/RAM/GPU/disk (`resources` in the heartbeat), and DuckDB snapshot time.
  4. Then draw a **random sample of 100 sent prospects** and verify each by hand (does the site match the business, and is each finding real?). The false-positive rate is wrong results ÷ 100. Record it in `docs/research/BENCHMARK.md`.

  Until that run exists, nobody may state that the 10,000-evaluated-per-day target is met.
- **Expected bottleneck** (an estimate, not a measurement): politeness waits and slow sites. Each business takes 2–4 requests per host, 5 s apart, so roughly 8–20 s of wall time. At 24 concurrent hosts that is about 1–3 businesses per second. Raising `HTTP_CONCURRENCY` raises throughput without raising the per-site rate.

## 8. Sharing the GPU with the AI Website Builder
Node 1 has one RTX 5090 and one Ollama on `127.0.0.1:11434`, used by the AI Website Builder as well. The builder
schedules its own GPU work in-process (`runner/src/inference/scheduler.ts`), but that scheduler runs inside the
runner container and this worker is a native Windows process, so the two cannot share a queue. What they share is
Ollama, and Ollama reports which models are resident. That is the admission signal
(`research-worker/src/gpu-admission.ts`).

The rule is one-sided on purpose: **website generation always wins.** A research draft is wording only — the score,
qualification and package are computed in code — so it is never worth delaying a customer's website for. Before each
draft the worker asks `GET /api/ps` and refuses to draft when:

- any model with a tag other than `RESEARCH_MODEL` is resident (the builder's Model A/B, or another application such
  as HQ/JARVIS). Their models are **never** unloaded by this worker;
- `nvidia-smi` reports the GPU busier than `MODEL_MAX_GPU_UTIL_PCT`;
- our model is not already loaded and less than `MODEL_MIN_FREE_VRAM_MB` is free, so loading a second model cannot
  squeeze the builder's out;
- Ollama does not answer at all — unknown always counts as refused.

A refusal defers the draft (it does not fail): the prospect keeps its evidence-only wording, the job is re-queued, and
after `MAX_DRAFT_ATTEMPTS` (5) deferrals it is dropped. `keep_alive` is short (`MODEL_KEEP_ALIVE`, default `30s`) so
research never squats VRAM between drafts. Refusals are sticky for 60 seconds, so a busy builder is not polled once
per prospect.

| Setting | Default | What it does |
|---|---|---|
| `RESEARCH_MODEL` | *(unset)* | No value = **no drafts and no GPU use at all**. The whole pipeline works without it |
| `MODEL_GPU_GUARD` | `on` | Turn off only on a machine with no other GPU work |
| `MODEL_KEEP_ALIVE` | `30s` | How long Ollama holds the research model after a draft |
| `MODEL_MAX_GPU_UTIL_PCT` | `25` | Defer drafting above this GPU utilisation |
| `MODEL_MIN_FREE_VRAM_MB` | `8000` | Headroom required before loading the research model |
| `MODEL_DRAFT_QUEUE_LIMIT` | `500` | Prospects that may wait for wording; overflow is dropped, never queued without bound |

`Get-ResearchWorkerHealth.ps1` reports `drafts` (pending, done, dropped, deferrals) and the last admission decision,
so "no summaries are appearing" can be told apart from "the worker is stuck".

**If research drafting must never touch the GPU at all,** leave `RESEARCH_MODEL` unset. Nothing else changes: every
number the platform shows is computed from evidence by code.

## 9. Continuous operation and a 24-hour measurement run
This is the procedure for an unattended run that keeps going without anyone holding a terminal open.

**Install for continuous, GPU-free, nationwide research.** In an elevated PowerShell, from a checkout of this
repository on Node 1:

```powershell
.\research-worker\windows\Install-ResearchWorker.ps1 `
  -PlatformUrl https://<staging host> `
  -States "" `
  -Concurrency 24 `
  -RunWhenLoggedOff `
  -Install
```

- **No `-Model`.** Drafting stays off, so research never touches the GPU and the AI Website Builder keeps all of it
  (§8). Qualification, scoring and packages are computed in code, so lead quality is unaffected.
- **`-States ""`** researches every state, in order, checkpointed per state. Do not point a second worker at the same
  partition: one worker owns the state file, and the task is registered `MultipleInstances IgnoreNew`.
- **`-RunWhenLoggedOff`** adds a boot trigger and runs the task under the account's stored password. Without it the
  task has only an at-logon trigger, so **after an unattended restart research stays stopped until someone signs in** —
  the installer prints a warning saying exactly that. The password is needed because the platform secret is DPAPI-
  protected for this user and a password-less (S4U) task cannot unprotect it.
- **`-Concurrency 24`** is a deliberate starting point, not a target. Raise it in steps (§9, "Raising the rate").

**Then resume research** in `/staff/research` (Owner). The worker notices within 60 s.

**Budget for the first dataset scan.** Before any state is ingested, the worker copies the US subset of the Overture
release to `data\overture\<release>\us_places.parquet`. That release is **11.90 GB across 16 Parquet parts** and the
projected columns are about **3.8 GB**, read over the network in one scan. Expect **one to several hours**, during
which evaluated/hour is legitimately 0. Start the official 24-hour clock **after** the snapshot completes (source
status reads `current` on the dashboard, with a release), or the window measures the download rather than the
pipeline.

**Verify it is really running, independently of any Claude session:**

```powershell
Get-ScheduledTask -TaskName CrestmontResearch-Worker | Select-Object State
C:\CrestmontResearch\Get-ResearchWorkerHealth.ps1
```

Health should show a recent platform heartbeat, `paused: false`, a non-zero queue once ingest starts, and
`drafts.gpu` reporting "no GPU guard" (no model configured). On the platform, `/staff/research` should show the runner
online with its last check-in. If research is resumed and no worker checks in for 30 minutes, the Owners are emailed
automatically (`PRODUCTION.md` §6).

**Raising the rate.** Change `HTTP_CONCURRENCY` in `C:\CrestmontResearch\settings.env`, then restart the task
(`Restart-ScheduledTask -TaskName CrestmontResearch-Worker`; the queue, outbox and checkpoints are durable, so nothing
is lost). Raise it only while all of these hold: processing failures flat, restricted/blocked check rate not climbing,
CPU below about 80%, disk free comfortable, the platform accepting batches, and the outbox not growing. One request
per host at a time with a politeness interval is enforced at any concurrency.

**Reporting.** `scripts/research-24h-report.ts` builds the window's report from staging D1, read-only:

```bash
node --no-warnings scripts/research-24h-report.ts --hours 24 --target 25000 --out evidence
```

It writes `evidence/research-24h-report.json` and `.md`, keeps every funnel stage separate, and refuses to state a
daily figure for a window that has not finished. The `Research performance report` workflow runs the same script
daily and on demand, and uploads the report as an artifact. Accuracy is **not** in it: a false-positive rate needs the
hand-verified sample in §4.

## 10. Automatic research → CRM promotion

Promotion is what turns a qualified research prospect into a CRM lead. There are three ways in, and all three go
through the CRM intake engine (`src/services/contact-identity.ts`, channel `research_agent`), so customer matching,
do-not-call, email suppression, erasure, duplicate review and the audit record apply identically to each:

| Path | Who starts it | Bound |
|---|---|---|
| One prospect | Owner, "Promote" in `/staff/research` | one record |
| Backlog reconciliation | Owner, "Reconcile the backlog now" in `/staff/research` | `auto_promote_max_per_run` (default 200) and a 20-second budget |
| Scheduled | the 15-minute `research_promote` job | the same per-run cap, and only while `auto_promote = 1` |

`research_settings.auto_promote` is **0 by default** (migration 0073). While it is 0 the scheduled job still runs
every 15 minutes and records a run with `stopped_reason = 'disabled'` and `examined 0` — which is how you can tell
the job is registered and firing without it creating anything.

Turning it on or off in staging:

```bash
gh workflow run research-auto-promote.yml --ref main -f enable=on -f max_per_run=200
```

(or the same with `enable=off`). It signs in as the staging Owner and posts the real settings form, so the change is
permission-checked and audited; it refuses any host that is not `crestmont-platform-staging.*`, and it reads the
pause flag and the Owner's pause reason first and sends them back unchanged — **enabling promotion never resumes
research**. Pausing research does not stop promotion either: pausing stops new website checking, while the backlog
already on file still has to reach the CRM. Those are deliberately different switches.

At 200 per run the scheduled job can place up to 19,200 leads a day. A prospect the intake engine refuses is retried
with backoff (15 min, 1 h, 4 h, 16 h) and then left alone after 5 attempts with its reason recorded in
`promote_last_error`; the report's "Promotion integrity" section counts those. A prospect at `review` is never
promoted automatically — a shared phone number or two records of one business is a person's decision.

Creating a CRM lead releases nobody for calling: outbound eligibility is computed fail-closed
(`src/domain/research.ts#outboundEligibility`) and stays `blocked`.

## 11. The 25-leads-per-minute import rate

What the target means: **successfully persisted, genuinely new CRM leads**, counted from the `leads` table. An
existing-contact match, a duplicate, a suppressed record, a review case and a failed attempt all count for nothing,
because none of them is a new lead. `importRate()` reads the rows; the promoter's own counters are reported beside
them so a disagreement is visible rather than invisible.

### How it is reached

| | Before | Now |
|---|---|---|
| Schedule | `*/15`, 11th of 12 jobs | **`* * * * *`, alone on its tick** |
| Sequential D1 round trips per promotion | 11.7 | **5.6** |
| Promotions in flight | 1 | **8** |
| Per invocation | 12-13 observed | **up to 100** |
| Sustained rate | ~0.85/minute | measured in staging certification |

Three things had to change together, and the schedule was the largest: a job that runs four times an hour cannot
meet a per-minute target however fast each run is.

### Why concurrency is safe here

Serial execution was doing a job beyond ordering. When two prospects share a phone number, an email or a company
domain, the second one used to see the contact the first had just created and was parked at `existing_crm` instead of
creating a second lead. Run them at the same time and both evaluate against a CRM that does not yet contain the
other, and both could create one.

So the race is removed rather than mitigated: a batch never contains two prospects that share an identifier
(`phone_norm`, email, domain), and the ones left out are the next tick's work, counted in `deferred_identity`. Every
promotion still goes through the CRM intake engine, so customer matching, do-not-call, email suppression, erasure,
duplicate review, the idempotency key and the audit record all apply exactly as they do to a human promotion.

### The limits it is built against

- **D1 allows 1,000 queries per Worker invocation**, a `batch()` counting as one. At ~8.3 round trips per promotion
  that is ~120, so `MAX_PER_INVOCATION` stops a run at **100** whatever the Owner's cap says, recording
  `query_limit` — the next tick continues, rather than the invocation being killed mid-batch.
- **30 s of CPU per sub-hourly Cron Trigger** on Workers Paid, with a 15-minute duration cap. The run budget is
  **40 s of WALL time**, which is a different thing: a promotion spends its time waiting on D1, and measured compute
  is about 2 ms each.
- **Cron Triggers: 250 per account** on Workers Paid.
- **D1 Paid: 25 billion rows read and 50 million written per month.** Rows read are negligible. Rows written are the
  meter that binds, and the certification measures them per lead rather than estimating.

### Overlap, recovery and the no-op case

A run takes a lease before it starts: one row, one conditional `UPDATE`, which is a correct compare-and-swap because
a single D1 statement is atomic. It carries an expiry rather than a flag, so a Worker killed mid-run cannot wedge the
schedule — the lease goes stale and the next tick takes it — and it is released in a `finally`, so an exception
cannot hold it either. A run that cannot take it records `locked` and touches nothing.

With the Owner's switch off, or nothing eligible, the tick is two reads, one small run row and no writes to the CRM.
It does not audit, because 1,440 rows a day of nothing would bury the log that real decisions are read from.
Retention deletes scheduled run rows after 90 days and keeps every run a person triggered.

### Certifying it

```bash
gh workflow run research-promotion-certify.yml --ref main -f minutes=60 -f target=25
```

Add `-f observe_minutes=60` to let the Cron Trigger work for an hour first and then certify the hour that just
elapsed. It is read-only: it promotes nothing and measures only what the schedule did unattended, which is the only
thing worth certifying.

**A drained backlog is success, not a shortfall.** Once nothing is eligible the rate falls to whatever research
delivers, so the certification splits the window where `remaining` hits zero and judges the target only over the
minutes when there was work. The ops alert works the same way: `promotion_below_target` needs both a rate under
target and at least 250 eligible prospects waiting, so it can never fire because the system succeeded.

### Supply, not throughput, is the ceiling

The rate is bounded by eligible prospects, and that is a research question, not a promotion one. 15,000 imports in
24 hours needs 15,000 eligible prospects; research has been measured producing about 5,050 qualified a day, which at
the 21.01% qualification rate needs ~71,000 evaluations a day to reach 15,000. Draining a backlog is quick; refilling
it is the slow part (`CAPACITY.md` §4). Read the backlog figure before reading the rate.

## 5. Troubleshooting
| Symptom | Check / fix |
|---|---|
| Dashboard: "No research worker can connect" | `RESEARCH_RUNNER_SECRET` is not set on that environment |
| Health: `platform.authFailed: true` | Secrets differ. Re-run the installer with `-SecretFile`, or delete `secrets\research_runner_secret.dpapi` and re-run |
| Worker offline on dashboard | Is the scheduled task running? Read the last log lines. The workstation may be asleep (power settings) |
| `Overture snapshot failed` | Network or schema change. Set `OVERTURE_RELEASE` to the previous release. Schema errors name the missing column |
| Many `common crawl lookup failed` | 503s / rate limits. The worker backs off by itself. Lower `CC_DAILY_QUERIES` or set `COMMON_CRAWL=off` |
| Records rejected by platform | `stage = failed` with the reason in the state DB. Usually a validation bug: open an issue with the reason |
| Disk filling | `data\overture\<old release>` folders can be deleted once a newer release is ingested |
| No summaries on prospects, pipeline otherwise fine | Expected while the Website Builder is using the GPU. Health shows `drafts.deferrals` rising and the admission reason. Qualification never depends on a draft (§8) |
| Website builds slow down after installing research | Check `RESEARCH_MODEL`: if it is set, confirm `MODEL_GPU_GUARD=on`. Unset `RESEARCH_MODEL` to remove research from the GPU entirely |
| Owner alert "Lead research is resumed but no worker is doing the work" | Research is unpaused on the platform and no worker has checked in for 30 minutes (or ever). Install/start the worker (§1) or pause research in `/staff/research` |

## 6. Recovery and rollback
- **Worker crash or reboot.** Nothing to do: leases expire and work resumes from `data\state.sqlite`.
- **Corrupted state file.** Stop the task and rename `state.sqlite` to keep it. On restart everything is re-ingested. That is safe: the platform skips unchanged records and batch ids are new.
- **Platform rollback.** Migration 0051 only adds tables. Rolling the Worker back to a version without `src/routes/research.ts` leaves the tables unused. Delete nothing.
- **Stop research for good.** Pause in `/staff/research`, unregister the `CrestmontResearch-Worker` task, then remove `RESEARCH_RUNNER_SECRET` from the environment.

## 7. Production activation (Founder approval gate)
Production stays untouched until the Founder approves, in writing, each of the following:
1. Merging this branch. Merging to `main` deploys **staging** only.
2. Production `RESEARCH_RUNNER_SECRET`.
3. Pointing the worker at production.

Outbound calling of research prospects is a separate, later decision (`COMPLIANCE-GATE.md`).
