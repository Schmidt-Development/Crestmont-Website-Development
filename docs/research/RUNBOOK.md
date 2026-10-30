# Lead research — operations runbook

Architecture and vocabulary: `README.md`. Licences: `DATA-SOURCES.md`. Calling rules: `COMPLIANCE-GATE.md`.

## 1. One-time setup (staging first)
1. **Platform secret.** Generate a value and set it on staging only:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, then
   `wrangler secret put RESEARCH_RUNNER_SECRET --env staging`.
   Production gets its own, different value, and only after the Founder approves production activation.
2. **Migration 0047.** It is applied by the normal staging deploy, which runs only from `main`. Research starts **paused**.
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
   - Playwright, for mobile rendering checks: `npm i -g playwright && npx playwright install chromium`;
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
3. **Draft.** Only for prospects that qualify under the same deterministic rule the platform uses, it asks the local model for a summary and a call-prep brief. A draft that adds facts is discarded.
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

## 6. Recovery and rollback
- **Worker crash or reboot.** Nothing to do: leases expire and work resumes from `data\state.sqlite`.
- **Corrupted state file.** Stop the task and rename `state.sqlite` to keep it. On restart everything is re-ingested. That is safe: the platform skips unchanged records and batch ids are new.
- **Platform rollback.** Migration 0047 only adds tables. Rolling the Worker back to a version without `src/routes/research.ts` leaves the tables unused. Delete nothing.
- **Stop research for good.** Pause in `/staff/research`, unregister the `CrestmontResearch-Worker` task, then remove `RESEARCH_RUNNER_SECRET` from the environment.

## 7. Production activation (Founder approval gate)
Production stays untouched until the Founder approves, in writing, each of the following:
1. Merging this branch. Merging to `main` deploys **staging** only.
2. Production `RESEARCH_RUNNER_SECRET`.
3. Pointing the worker at production.

Outbound calling of research prospects is a separate, later decision (`COMPLIANCE-GATE.md`).
