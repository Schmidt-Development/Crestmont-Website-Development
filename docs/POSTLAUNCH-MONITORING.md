# Post-launch monitoring plan

**Requirement:** DOC-002 (§76.30, §43, §50) · **Status:** the in-platform checks below exist and run on the Worker's cron once it is deployed. **External alerting does not exist yet** (ASVS F-03, BLK-003). Nobody is paged automatically. Until an alerting channel is chosen and configured, monitoring is a staffed-hours routine (RUNBOOK §1).

## 1. What is measured, and where

| Signal | Source (real data) | Frequency | Where to look |
|---|---|---|---|
| Domain resolution + TLS for each environment URL | `env_probe` job: DNS-over-HTTPS lookup + HTTPS request (certificate validated) | every 15 min | `/staff/ops`, `/staff/readiness/env/<env>` (integration rows `dns`) |
| Service health (`/api/health`, correct environment) | `env_probe` job | every 15 min | same (integration rows `monitoring`) |
| Production verification of the deployed commit | `production_check` evidence: post-deploy checks (deploy workflow) and probe outcome changes | each deploy + on change | Gate H, `/staff/readiness/env/production` |
| Production = approved release | Deployment recorder compares the commit with the Founder-approved candidate | each deploy | `/staff/ops` alert, `production_incident` blocker |
| Server errors (5xx) | `app_errors` (500 handler) | continuous | `/staff/monitoring`, environment view "Recent server errors" |
| Readiness feed health (CI evidence, scheduled jobs) | `ingestion_status` (`ci`, `job:*`) | each run | `/staff/readiness` feed panel; `GET /api/readiness/health` returns **503** when degraded |
| Payments | `stripe_events` failed / dead-letter; Stripe-side reconciliation findings | 15 min / daily | `/staff/monitoring`, `/staff/finance/reconciliation` |
| Email | `email_deliveries` failed / bounced, Resend webhooks | continuous | `/staff/email?status=failed` |
| Support SLA | escalation sweep | 15 min | `/staff/support` |
| AI jobs and receptionist | `ai_jobs` failed, `voice_events` errors | continuous | `/staff/ai`, `/staff/voice` |
| Security | `security_events` (lockouts, rate limits), open findings | continuous | `/staff/security`, `/staff/readiness/security` |
| Retention | `retention_runs` | daily | `/staff/ops/retention` |

## 2. Thresholds and response (proposed)

| Condition | Severity | Response (RUNBOOK) |
|---|---|---|
| Production `/api/health` failing on 2 consecutive probes | Critical | Check the latest deployment at `/staff/ops`. If it is recent, roll back (RUNBOOK §3). Open a `production_incident` blocker. |
| TLS not confirmed / domain not resolving | Critical | Cloudflare dashboard → DNS / SSL. Check certificate status. |
| Production deployment flagged "does not match approved release" | Critical | Roll back to the approved release, or get a new Founder approval for that commit. Resolve the incident blocker with evidence. |
| Post-deploy production check failed | Critical | The workflow rolls back automatically. Confirm the rollback and investigate. |
| `/api/readiness/health` = 503 for > 24 h | High | Fix the failing feed (CI evidence posting, scheduled job error). Readiness figures are untrustworthy meanwhile. |
| > 5 server errors per hour, or any new error type | High | `/staff/monitoring` → error detail → fix forward through staging. |
| Stripe dead-letter event | High | RUNBOOK §5. |
| Email failure rate > 5 % per day, or any bounce on a transactional email | Medium | RUNBOOK §6. |
| Support SLA breach | Medium | RUNBOOK §9. |
| Lockout burst (> 10 per hour) | Medium | Possible credential stuffing. Review `/staff/security`. Consider a WAF rule. |

## 3. Routine (until external alerting exists)

- **Start and end of each staffed day:** RUNBOOK §1 daily checks, plus `/staff/ops` (deployments and probe rows) and the readiness feed panel.
- **After every production deploy:** Gate H, the `/staff/ops` release match, the post-deploy check evidence, and `/staff/monitoring` for new errors during the following hour.
- **Weekly:** `/staff/backups` (latest export and drill), `/staff/ops/retention` run history, open findings and blockers, the Stripe reconciliation findings.
- **Monthly:** a restore drill in staging (BACKUP-RECOVERY §6), a rollback rehearsal in staging, a review of these thresholds.

## 4. External alerting — decision needed (Founder)

The probe and the health endpoint are designed for an external monitor. The options below need an account and possibly a cost, which is why each needs Founder approval (§78):

1. **Cloudflare Health Checks / Notifications** (on the account once BLK-003 is cleared): monitor `https://<host>/api/health` and `/api/readiness/health`, and notify by email. Low cost and no new vendor.
2. **An uptime service** (e.g. a free tier) polling the same two endpoints, with email/SMS alerts.
3. **Workers Logs / Logpush** for error-rate alerting on `level":"error"` log lines.

Recommendation: option 1 for uptime and TLS, and option 3 once traffic exists. When configured, record the integration as `monitoring` verified only after a test alert is actually received. Then resolve ASVS F-03.

## 5. Ownership

| Area | Owner |
|---|---|
| Daily checks, first response | Staff on duty during staffed hours |
| Deploys, rollbacks, error fixes | Engineering |
| Production approval, incident communication to customers, monitoring-vendor cost | Founder |
