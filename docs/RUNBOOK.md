# Operational runbook

**Requirement:** DOC-002 · Applies to development now and to staging/production once provisioned (BLK-003). Commands assume `wrangler` is authenticated with a **scoped** Cloudflare API token for the Crestmont account only.

Staffed hours are set at /staff/settings. Outside those hours, nobody is paged. **No external alerting exists yet** (see /staff/monitoring). Until it does, check /staff/monitoring at the start and end of each staffed day.

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

## 3. Rollback

1. `wrangler deployments list --env <env>` → `wrangler rollback <id> --env <env> --message "<reason>"`.
2. Confirm `/api/health` and the critical journeys.
3. If the cause was a migration, follow BACKUP-RECOVERY §5. Database restores in production need Founder approval.
4. Open an incident blocker. Record `rolled_back` in release history.

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
| `TURNSTILE_SECRET` | Rotate in the Cloudflare dashboard → `wrangler secret put` | |

Generate secrets with `openssl rand -hex 32`. Never paste a secret into chat, tickets, commits or logs. The integration matrix stores only a truncated hash fingerprint, so a rotation automatically resets an integration to "configured, unverified" until the probe passes again.

**Compromised staff account:** disable it at /staff/employees (this revokes all sessions). Rotate any secret that person could read. Review /staff/audit filtered by that actor.

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
