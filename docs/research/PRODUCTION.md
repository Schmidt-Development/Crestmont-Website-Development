# Lead research — production readiness and deployment plan

**Status: not deployed anywhere.** Production activation needs the Founder's explicit approval at each step in §7. Outbound AI calling of research prospects stays prohibited (D-14, MSA Sched. C.7, `COMPLIANCE-GATE.md`).

## 1. Configuration
| Setting | Where | Value |
|---|---|---|
| `RESEARCH_RUNNER_SECRET` | `wrangler secret put RESEARCH_RUNNER_SECRET --env production` | 32 random bytes as hex. **Different from staging.** Stored on Node 1 by `Install-ResearchWorker.ps1` (DPAPI) |
| `research_settings` | D1 row created by migration 0051 | Ships **paused**. Owner resumes in `/staff/research` |
| `research_sources` | D1 rows created by migration 0051 | Overture and Common Crawl on. Foursquare OS, OSM and open-data off until the Founder decides (`DATA-SOURCES.md`) |
| Worker `settings.env` | Node 1 `C:\CrestmontResearch` | `CRESTMONT_URL=https://crestmontwebsitedevelopment.com` only after staging sign-off |

No new paid service, API key or subscription is involved.

## 2. Migration safety (`0051_lead_research.sql`)
- **Additive only:** six new tables and their indexes, plus seed rows for settings and sources. It does not alter, rebuild or delete any existing table. In particular, `leads`, whose rebuild in D1 would cascade-delete `crm_activities`, is untouched.
- **Foreign keys** point only from the new tables to `users`, `leads` and `contacts`, so existing rows are unaffected.
- **Independent of the open migrations:** `0048`/`0049` in PR #50 and `0048` in PR #52 touch none of these tables, and D1 applies by name.
- **Proven three ways:** the full suite applies every migration from empty (646 tests), the research tests exercise every table, and the live-sample runs apply all migrations to a fresh database each time.
- **Before production:** `deploy-production.yml` takes a D1 Time Travel bookmark, which gives point-in-time restore.

## 3. Rollback and recovery
- **Worker rollback.** The previous Worker version ignores the new tables. Leave them in place; no data migration is needed.
- **Stop research.** Pause it in `/staff/research`. The worker holds its queue and outbox until resumed.
- **Undo promotions.** Promoted leads are ordinary CRM leads (`utm_source=crestmont-research`), managed in the CRM: archive them, don't delete them. Each one carries its evidence and a `crm_activities` note.
- **Remove the feature.** Unregister the `CrestmontResearch-Worker` scheduled task and delete `RESEARCH_RUNNER_SECRET`. Dropping the tables is optional and a separate, reviewed change.
- **Worker recovery** is automatic: leases expire, the state file is durable, batch ids are stable, the scheduled task restarts the worker, and `Start-ResearchWorker.ps1` restarts it with backoff.

## 4. Credential isolation
- **Per-environment secrets.** Staging and production each have their own `RESEARCH_RUNNER_SECRET`. A staging worker cannot authenticate to production.
- **Worker channel.** It authenticates with an HMAC signature plus a single-use nonce, never a cookie. It can only push research batches and heartbeats: it cannot read CRM data, create leads or call anyone.
- **Ollama** is restricted to 127.0.0.1 by configuration validation. The installer refuses an `OLLAMA_HOST` that exposes it.
- **Logs** redact the secret.
- **Public repository.** Live-sample evidence is sealed, and only aggregates are published.

## 5. CRM and D1 compatibility
- **Ingest** reads `contacts.phone_norm`/`email_norm`, the CRM's own duplicate keys from migration 0044, and `voice_dnc`.
- **Promotion** goes through the CRM intake engine (`contact-identity.ts`, PR #50, channel `research_agent`). That engine owns the company, contact, lead and activity writes, the identity links and the decision record. The lead gets `source=manual` (inside the existing CHECK) and `origin=research_agent`.
- **D1 limits:** every statement stays under 100 bound parameters (45 at most). Each batch reads in chunks of 90.
- **Batch size:** the 100-record default keeps an ingest under about 1,000 D1 queries per invocation. Lower `max_batch` in `/staff/research` on a Workers plan with tighter limits.
- **PR #50 is integrated.** Its `0048`/`0049` migrations, and #64's `0050`, precede 0051.

## 6. Monitoring
- **`/staff/research`:** worker online/offline, last check-in, queue depth, failed jobs, rejected records, per-source refresh, the 24-hour throughput chart, and import success rate.
- **Node 1:** `Get-ResearchWorkerHealth.ps1` (127.0.0.1:8789) shows the platform auth state, per-stage counts and the outbox depth. Logs are in `logs\worker-*.log`.
- **Alerting gap (not built):** a stale-worker alert into `ops_alerts`. Proposed follow-up: a scheduled check that raises an alert when no research heartbeat has arrived for 30 minutes while research is resumed.

## 7. Deployment plan
1. Merge PR #48 to `main`. That deploys **staging only** and applies migration 0051 on staging.
2. Set the staging secret; install the worker on Node 1 against staging (`RUNBOOK.md` §1); resume research for one state.
3. Run 24 hours on staging and fill in `BENCHMARK.md` §2. The Founder manually reviews 100 sealed results.
4. With the Founder's approval: run `deploy-production.yml` for the release tag. It requires the GitHub `production` environment approval plus the Founder's release authorization. Then set the production secret.
5. Point Node 1 at production; it stays paused until the Owner resumes.
6. Outbound calling of research prospects remains closed under all of the above.
