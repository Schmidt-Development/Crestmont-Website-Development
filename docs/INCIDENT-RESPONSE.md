# Incident response runbook

**Requirements:** DOC-002, SEC-005, READY-012 · **Status:** procedure written; **not yet exercised** on staging; **no external paging exists** (ASVS F-03 — alert destination is Founder decision D-09). Legal notification steps need counsel review before launch.

This expands `docs/RUNBOOK.md` §10. Recovery mechanics live in `docs/BACKUP-RECOVERY.md` (data) and `docs/RUNBOOK.md` §3 (rollback) and §4 (secret rotation); this runbook says **when** and **in what order**.

## 0. Roles (small team)

| Role | Default holder | Duty |
|---|---|---|
| Incident lead | Founder (Owner) | declares, decides containment that affects customers, approves every external message |
| Operator | whoever is on duty (staff with ops access) | executes runbook steps, keeps the timeline |
| Counsel | [ATTORNEY — to be engaged] | breach-notification analysis, regulator/customer notice wording |

With one person, that person holds all roles and writes the timeline as they go.

## 1. Detection sources

- `/staff/monitoring` (unhandled errors), `/staff/readiness` health feeds (scheduler, cron registration, recovery drills, file storage), `/api/readiness/health`.
- `staging-health-monitor.yml` failures (GitHub Actions emails the repository owner).
- `security_events`: `login_locked`, `login_blocked_locked`, `rate_limited`, `breach_check_unavailable`; `audit_logs`: `file.download_blocked`, `file.quarantined`, `file.download_denied`, `privacy.deletion_blocked_by_hold`.
- Provider dashboards and emails: Cloudflare, Stripe (disputes, webhook failures), Resend (bounces/complaints), Retell.
- Customer reports via support tickets (security-sensitive tickets are incidents — RUNBOOK §9).
- GitHub: secret-scanning alerts, Dependabot security alerts (once enabled), unexpected workflow runs.

## 2. Severity

| Sev | Definition | Examples | First response |
|---|---|---|---|
| **SEV-1** | Confirmed or likely exposure of customer data or credentials; production down; money moving incorrectly | leaked secret with production scope; cross-tenant data access; payment charged twice at scale | immediately, any hour |
| **SEV-2** | Serious degradation or a contained security weakness being exploited/likely exploitable | staging Owner credentials public (F-18); email delivery stopped; webhooks failing | within 4 staffed hours |
| **SEV-3** | Limited impact, workaround exists | one integration degraded; single customer issue | next staffed day |
| **SEV-4** | Near miss / finding | vulnerability found in review, not exploited | add to `security_findings` |

When in doubt, choose the higher severity and downgrade later.

## 3. Universal steps (every incident)

1. **Declare.** Create a `production_incident` blocker at `/staff/readiness` with severity and a one-line description. Start a timeline (UTC times, who did what).
2. **Preserve evidence before changing anything.**
   - D1 export first (BACKUP-RECOVERY §3.2). Store it encrypted and private — never as a workflow artifact of a public repository.
   - If data deletion could destroy evidence, place a **legal hold**: `node --no-warnings scripts/legal-hold.ts place --scope global --reason "<incident id>" --matter <incident id> --print-sql > hold.sql` then `wrangler d1 execute <db> --remote --file hold.sql`. The retention job and privacy anonymisation then pause (F-25). Release it only when the incident is closed and counsel agrees.
   - Audit logs and security events are append-only; do not try to edit them.
3. **Contain** (scenario playbooks below).
4. **Eradicate and recover** through the normal deploy path (fix-forward) or a rollback; data restores need Founder approval.
5. **Communicate** (§5).
6. **Close** with a post-incident review (§6); resolve the blocker with evidence.

## 4. Scenario playbooks

### 4.1 Credential or secret compromise
Triggers: secret in a commit/log/artifact, secret-scanning alert, unexpected API usage, credentials published (e.g. F-18).
1. Identify the secret and its scope (`docs/security/SECURITY-READINESS-2026-10-28.md` §6). Do **not** paste the value anywhere while investigating.
2. Revoke/rotate at the provider first, then update the GitHub/Worker secret (RUNBOOK §4). Order matters: revoke before redeploying so a leaked value stops working immediately.
3. Remove the exposure: delete the artifact/log, rewrite nothing in git history without counsel if it is evidence; a public commit must be assumed copied.
4. Review usage since exposure: provider logs; `audit_logs` for `session.created` from unknown IPs; Stripe events; Cloudflare audit log.
5. For staff/Owner account credentials: revoke all sessions (`/staff/employees`), reset password and MFA (RUNBOOK §4a), check `audit_logs` for actions by that user.

### 4.2 Customer data exposure (confirmed or suspected)
1. SEV-1. Contain the path (feature flag off, rollback, revoke share links, disable the account).
2. Place an organization- or global-scoped legal hold.
3. Determine **what data, whose, when, how many people**. Sources: `audit_logs` (`file.downloaded`, `share_link.viewed`, `share_link.downloaded`, `privacy.export_generated`), `security_events`.
4. Engage counsel **before** any external statement. Notification duties depend on where affected people live and on contracts (DPA §8). Michigan's breach law (MCL 445.72) and the duty to notify clients for data Crestmont holds on their behalf are summarised in `docs/legal/RESEARCH-NOTES-2026-10.md` — that is research, not advice.
5. The DPA's notice window to business customers is a Founder/counsel decision (D-12); until decided, treat "without undue delay" as same-day for confirmed exposure.

### 4.3 Service outage
1. Check Cloudflare status and the Worker's recent deployments. If the outage began with a deploy, roll back (RUNBOOK §3) — target ≤ 30 min (proposed RTO tier 3).
2. If D1 is unavailable, there is no failover; post a status message and wait or restore (4.4).
3. Communicate if customer-facing for > 30 minutes (§5).

### 4.4 Database corruption or bad data change
1. Stop writers if possible (maintenance through Cloudflare, or roll back the deploy that caused it).
2. Export current state (evidence).
3. Choose: D1 Time Travel to a bookmark just before the event (minutes of loss) or restore an export into a **fresh** database and swap (BACKUP-RECOVERY §3). Restores need Founder approval and are recorded as incident blockers and release history.
4. After any restore, run the retention job before reopening (BACKUP-RECOVERY / RETENTION-SCHEDULE §5), and re-run reconciliation with Stripe.

### 4.5 Payment incident
Wrong amounts, duplicate charges, webhook backlog, dispute spike.
1. Pause the cause (checkout off in settings, or roll back).
2. Never issue refunds outside the Owner refund chain; record each decision.
3. Run Stripe reconciliation (`/staff/finance/reconciliation`); compare `stripe_events` with Stripe's dashboard.
4. For chargebacks: place an organization-scoped legal hold for the customer so files/messages that prove delivery are kept.

### 4.6 Third-party provider outage (Stripe, Resend, Retell, Cloudflare, AI runner)
1. Confirm on the provider status page. The platform fails closed (webhooks reject, Turnstile denies, uploads off without R2).
2. Communicate if customers are affected; queue work (emails retry; Stripe webhooks retry from Stripe's side).
3. After recovery, check dead letters (RUNBOOK §5, §6) and reconciliation.

### 4.7 Malware detected in an upload
1. `recordScanResult` with `infected` already quarantined the file and revoked its share links.
2. Check `audit_logs` for `file.downloaded` of that file before the verdict — who downloaded it, and was it shared?
3. Tell the uploading customer (their machine may be infected) and anyone who downloaded it; scan staff machines that opened it.

## 5. Communication

- **Internal:** timeline in the incident blocker; decisions recorded with who made them.
- **Customers:** only Founder-approved wording; use the `critical_incident` email template. Say what happened, what data, what we did, what they should do, how to contact us. No speculation, no blame.
- **Regulators / law enforcement:** only through or with counsel.
- **Status updates:** for outages > 30 min, every 60 minutes until resolved.

## 6. Post-incident review (within 5 business days)

Timeline, impact, root cause, what worked, what didn't, follow-ups with owners. Add each weakness to `security_findings`. Release legal holds only with a recorded reason. Update this runbook if a step was missing.

## 7. Exercises (proposed)

| Exercise | Frequency | Evidence |
|---|---|---|
| Tabletop: leaked Cloudflare token | before launch, then twice a year | notes in `/staff/readiness` |
| Rollback rehearsal | after deploys (automated, staging) | rehearsal health feed |
| Restore drill | monthly (staging) | `/staff/backups` |
| Legal-hold drill (place + release on staging) | before launch | `audit_logs` `legal_hold.*` |
