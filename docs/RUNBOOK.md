# Operational runbook

**Requirement:** DOC-002 · Applies to development and staging (live since 2026-10-27) and to production once the Founder authorizes it (LAUNCH-001). Commands assume `wrangler` is authenticated with a **scoped** Cloudflare API token for the Crestmont account only.

Staffed hours are set at /staff/settings. Outside those hours, nobody is paged.

**Alerting (baseline, no extra cost).** `.github/workflows/staging-health-monitor.yml` probes `/api/health` and `/api/readiness/health` from GitHub's infrastructure every 30 minutes (three attempts a minute apart). A failed run is the alert: GitHub notifies the account that last changed the workflow's schedule, and anyone watching the repository's Actions, by email and web notification. Make sure that account's notification settings send "Actions: failed workflows" by email. To add another channel (SMS, Slack, a paging service), keep this workflow and add a step that calls it — that choice is the Founder's (ASVS F-03). Production gets the same monitor when it exists (copy the workflow with the production URL). In-app signals remain at /staff/monitoring; check it at the start and end of each staffed day.

**Recovery is rehearsed automatically.** After every successful staging deploy, `staging-rollback-rehearsal.yml` rolls the Worker back to the previous code version, verifies health, rolls forward and verifies again, and `staging-restore-drill.yml` restores a fresh staging export into a scratch database and compares every table's row count. Both post signed evidence (TEST-004, INFRA-005, INFRA-006) visible at /staff/readiness. A failed rehearsal or drill alerts the same way as the monitor.

## 1. Daily checks (staffed hours)

1. /staff/monitoring: service health, 5xx counts, failed email, Stripe failed/dead-letter events, failed AI jobs, voice errors.
2. /staff/integrations: anything `failing` or `degraded`.
3. /staff/security: lockouts, unusual failed-login bursts, open findings.
4. /staff/support: SLA breaches and escalations.
5. /staff/security#privacy: privacy deletion requests. Process them within the period stated in the privacy policy.

## 2. Deploy

Preconditions: CI green on the commit (tests, typecheck, scans), migrations reviewed as **additive**, and the readiness gates checked.

```sh
# Staging
wrangler d1 export crestmont-staging --remote --output backups/pre-deploy-staging.sql   # safety copy
wrangler d1 migrations apply crestmont-staging --remote --env staging
wrangler deploy --env staging
curl -fsS https://<staging-host>/api/health
```
Then run the E2E suite against staging and post the evidence (`npm run evidence:post`).

**Production** deploys require the Founder's approval, bound to the release-candidate commit (§44–§45, READY-008), and are never done by AI or automation without that approval. They follow the same steps with `--env production`, after a fresh export (BACKUP-RECOVERY §3.2). Record the deployment in release history.

**Automated path (preferred):** `.github/workflows/deploy-staging.yml` runs the staging steps above on every push to `main` and records the deployment and evidence. `.github/workflows/deploy-production.yml` is manual only. It refuses to run unless `GET /api/readiness/release-authorization` confirms a valid Founder approval for the exact commit, runs the post-deploy production checks and rolls back on failure. Provisioning and the full flow: **docs/DEPLOYMENT.md**. Deployments are listed with their release-candidate match at `/staff/ops`.

**Cron triggers.** `/api/readiness/health` has a required `scheduler` feed on staging/production: it turns 503 when the 15-minute jobs have not run for 75 minutes or the daily jobs for 26 hours. Staging's Cloudflare account is on **Workers Free, whose 5 cron triggers per account are already used by other Workers** (Cloudflare error 10072, found 2026-10-28), so staging's jobs run through the **external scheduler**: `staging-health-monitor.yml` calls the signed `POST /api/scheduled/run` every 30 minutes (daily set during 11:00 UTC), with a key derived from the Cloudflare token secret and installed by the deploy. The deploy still tries native registration (`scripts/verify-crons.ts`); the `cron-triggers:staging` feed reports the outcome. **Founder option:** upgrading the account to Workers Paid (about $5/month) restores native triggers on the next deploy; the external scheduler can then stay as a backup. Production needs native triggers (or the same external scheduler) before launch.

## 3. Rollback

1. `wrangler deployments list --env <env>` → `wrangler rollback <id> --env <env> --message "<reason>"`.
2. Confirm `/api/health` and the critical journeys.
3. If the cause was a migration, follow BACKUP-RECOVERY §5. Database restores in production need Founder approval.
4. Open an incident blocker. Record `rolled_back` in release history: `node --no-warnings scripts/post-deployment.ts --id <deployment id> --environment <env> --commit <sha> --status rolled_back --rollback-target <previous deployment id> --by <name>` (DEPLOYMENT §9).

## 4. Rotating secrets

The secret names are listed (presence only) at /staff/security. Rotate on staff departure, on suspected exposure, and at least yearly.

| Secret | Rotate by | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Create a new restricted test key in Stripe → `wrangler secret put STRIPE_SECRET_KEY --env <env>` → run the Stripe probe at /staff/integrations → revoke the old key | Never set a live key (PAY-010). The adapter refuses it. |
| `STRIPE_WEBHOOK_SECRET` | Roll the endpoint secret in Stripe (it allows overlap) → `wrangler secret put` → send a test event | |
| `RESEND_API_KEY` | New key in Resend → `wrangler secret put` → probe → delete old | |
| `ANTHROPIC_API_KEY` | New key in the Console → `wrangler secret put` → probe → revoke old | |
| `GITHUB_TOKEN` | New fine-grained token (read-only on the one repo) → `wrangler secret put` → probe → revoke | |
| `EVIDENCE_INGEST_SECRET` | Generate 32 random bytes → set in Worker **and** the GitHub Actions secret together | Ingestion fails closed in between |
| `VOICE_WEBHOOK_SECRET` | Generate 32 random bytes → set in the Worker and in the provider adapter together | The webhook fails closed in between. Calls in progress may lose events. Rotate outside call hours. |
| `TURNSTILE_SECRET` | Rotate in the Cloudflare dashboard → `wrangler secret put` | Also protects /register and /password/forgot. |
| `MFA_ENCRYPTION_KEY` | **Not rotated in place.** The key encrypts every stored TOTP secret; replacing it makes them unreadable and staff sign-in fails closed. On suspected exposure: plan a re-enrolment (administrator MFA reset for each person, §4a) or a re-encryption release; never just overwrite the secret. | `openssl rand -base64 32`. Losing it means every user must re-enrol. Keep a copy in the Founder's password manager. |

Generate secrets with `openssl rand -hex 32`. Never paste a secret into chat, tickets, commits or logs. The integration matrix stores only a truncated hash fingerprint, so a rotation automatically resets an integration to "configured, unverified" until the probe passes again.

**Compromised staff account:** disable it at /staff/employees (this revokes all sessions). Rotate any secret that person could read. Review /staff/audit filtered by that actor.

## 4a. Lost authenticator (two-factor recovery)

Every account that enrols two-factor authentication receives **10 single-use recovery codes**, shown once. Each works once in place of a 6-digit code (at sign-in and at the "Confirm it is you" step-up). Using one is recorded (security event `mfa_recovery_code_used`, audit `user.mfa_recovery_code_used`) and the user is emailed. A new set is generated from /account (needs the current authenticator code); that replaces every earlier code.

**Employee without authenticator or codes:** an Owner or Administrator opens /staff/employees → *Reset 2FA* on that person (needs a fresh step-up check). This clears the authenticator and recovery codes, signs the person out everywhere, emails them, and writes `employee.mfa_reset`. They enrol a new authenticator at next sign-in. Confirm the person's identity out of band first (call them on a known number). Nobody can reset their own two-factor this way, and only the Owner can reset the Owner account.

**Owner break-glass** (the Owner has lost the authenticator *and* every recovery code). Run only on the Owner's direct request, after confirming identity out of band (video call or in person); never on an email or chat request alone.

```sh
# 1. Safety copy first (BACKUP-RECOVERY §3.2)
wrangler d1 export crestmont-production --remote --env production --output backups/pre-owner-mfa-reset.sql
# 2. Generate the SQL (refuses unless every flag is present; prints nothing secret)
node --no-warnings scripts/reset-owner-mfa.ts --email <owner email> --operator "<your name>" \
  --reason "<why, and how identity was confirmed>" --confirm-owner-break-glass --print-sql > owner-mfa-reset.sql
# 3. Read it, then apply it (every statement is a no-op unless the email is the Owner's)
wrangler d1 execute crestmont-production --remote --env production --file owner-mfa-reset.sql
rm owner-mfa-reset.sql
```

For a local or restored database file use `--db <path>` instead of `--print-sql` (it also refuses a non-Owner email). The script clears the Owner's authenticator, pending enrolment and recovery codes, revokes every Owner session, and writes `owner.mfa_break_glass_reset` to `audit_logs` (actor `system`, with operator and reason) plus a `mfa_reset_break_glass` security event. It never changes the password. The Owner then signs in with the password (or resets it by email) and enrols a new authenticator immediately; check /staff/audit for the entry.

## 4b. Step-up checks

Release approval, staff invitations / role changes / disable / enable / 2FA reset, refund decisions and issuing, integration probes and environment/automation settings, every data export, and replacing an authenticator require a two-factor check within the last 10 minutes (list: `src/app/step-up.ts`). The person is sent to "Confirm it is you", enters a current code (or a recovery code), and returns to the page; a form must then be submitted again. JSON exports answer 401 until the check is done in the browser.

## 5. Stripe webhook failures and dead letters

- A `failed` event is retried by reconciliation. After repeated failures it becomes `dead_letter`. Both are listed on /staff/monitoring.
- Diagnose: read `last_error`, check the related order/invoice, fix the cause (code or data).
- Replay: from the Stripe dashboard (Developers → Events → Resend), or by resetting `status='received'` for that event id after the fix so the processor picks it up again. Processing is idempotent by event id. Duplicate deliveries are recorded as duplicates and not applied twice.
- Never edit payment amounts by hand to "make it match". Stripe is the source of truth. Use the reconciliation job and record any manual correction in the audit log.

## 6. Email failures

- /staff/email?status=failed lists failures and their last error. Retry is available only when Resend is configured in that environment. In development, mail sits in the dev outbox and is never sent.
- A bounce or complaint means: fix the address in the customer record. Do not resend repeatedly.

## 7. AI jobs

- Failed jobs are listed at /staff/ai. Retry re-runs the same retained input as a new job (linked by `retry_of`). If no provider key is set, the retry fails honestly with `not_configured`.
- AI output is always a draft that a person approves. Never approve a draft that promises refunds, prices, dates or contract terms.

## 8. AI receptionist

- Call errors and escalations appear at /staff/voice. Escalations also notify the Owner and create a CRM task due within 4 hours.
- If the receptionist misbehaves (for example quoting wrong information): activate the previous configuration version at /staff/voice → Configuration versions, then pause the number in the provider dashboard if needed. **Never modify the other business's receptionist workspace.**
- Phone number purchase or changes require the Founder.

## 9. Support escalation

1. Ticket SLA breach or escalation → the assigned staff member, then a project manager or administrator during staffed hours.
2. Refund requests: support reviews, the Founder decides (`refund.decide` is Owner-only), Stripe issues. AI is excluded at every step.
3. Security-sensitive tickets (suspected account takeover, data exposure): treat as an incident (§10).

## 10. Incident response

1. **Detect / declare:** anyone may declare an incident. Create an `production_incident` blocker in /staff/readiness with a severity.
2. **Contain:** roll back (§3), disable affected accounts (§4), rotate exposed secrets, turn off the affected feature (for example remove the voice number's webhook), or put the site in maintenance through Cloudflare.
3. **Preserve evidence:** export D1 (BACKUP-RECOVERY §3.2) **before** making data fixes. Do not delete audit or security events (they are append-only).
4. **Eradicate / recover:** fix forward through the normal deploy path, or restore data with Founder approval.
5. **Notify:** the Founder immediately for any confirmed data exposure. Customer and regulator notification follows the privacy policy and applicable state breach laws (attorney input required, LEGAL-004). Use the `critical_incident` email template only once a human has approved the wording.
6. **Review:** write a post-incident note (timeline, cause, fix, follow-ups). Add findings to `security_findings`. Resolve the blocker with evidence.

## 11. Contacts and accounts

| Area | Owner |
|---|---|
| Cloudflare, GitHub, Stripe, Resend, voice provider accounts | Founder (account holder) |
| Platform code and deploys to staging | Engineering |
| Production deploy approval, refunds, pricing, security exceptions | Founder only |
