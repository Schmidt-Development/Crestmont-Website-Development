# Data retention schedule

**Requirement:** SEC-006 (§65–§66) · **Status: PROPOSED — pending Founder and attorney approval (LEGAL-004).** Nothing in the "configurable" tier is deleted until the Owner turns that period on at `/staff/ops/retention`, after the Founder and counsel have approved this schedule and the privacy policy says the same thing. The only data purged automatically today is in the "always" tier below. That tier holds expired security plumbing that no person or process can use again.

Implementation: `src/services/retention.ts`, run daily by the `retention` scheduled job (`17 11 * * *`, `src/app/scheduled.ts`). Every run writes one row per category to `retention_runs` (counts only, never the deleted content), visible at `/staff/ops/retention`. Tests: `tests/ops.test.ts` `[SEC-006]`.

## 1. Always applied (non-controversial expired operational data)

| Data | Rule | Why it is safe |
|---|---|---|
| `sessions` | Delete when expired, or revoked, more than **30 days** ago | An expired or revoked session can never authenticate again. The 30-day lag keeps recent sign-in history for incident review. Login events are also in `audit_logs`. |
| `rate_limits` | Delete windows that started more than **2 days** ago | The longest window is 1 hour. Old counters have no effect. |
| `auth_tokens` (email verification, password reset) | Delete when used or expired more than **7 days** ago | Single-use and only hashes are stored. Expired tokens are rejected anyway. |

## 2. Configurable (proposed; off until the Owner sets it)

| Data | Proposed period | What happens | Settings key | Allowed range |
|---|---|---|---|---|
| Security events (failed logins, lockouts, rate-limit hits; contain email + IP) | **365 days** | Rows deleted | `retention.security_events_days` | 90–3650 |
| Email message bodies (rendered subject/HTML/text) | **730 days** | Body deleted. The delivery log row (template, recipient, status, dates) is kept | `retention.email_bodies_days` | 90–3650 |
| Server error log (`app_errors`) | **90 days** | Rows deleted | `retention.app_errors_days` | 30–3650 |
| Voice call transcripts and recording links | **90 days** after the call | `transcript` and `recording_url` cleared. The call row, outcome, summary, consent flag and CRM lead are kept | `retention.voice_transcripts_days` | 30–3650 |
| Soft-deleted customer files | **30 days** after deletion | Object bytes deleted from R2. The `files` row is kept and marked `purged_at` because other records reference it. Files used as handoff documentation or portfolio screenshots are never purged | `retention.deleted_files_days` | 14–3650 |

Questions for the Founder and attorney before any of these are switched on:
1. Do state laws or contracts require keeping security logs longer (for example for breach investigation windows)?
2. Should email bodies for financial notices (invoices, receipts, refund decisions) follow the financial-records period instead of the general period?
3. Is 90 days right for call transcripts given the recording-consent disclosure the voice provider plays (VOICE-006)?
4. ASVS finding F-09: retention for audit IPs and security-event emails of anonymised users. The proposed answer is the security-events period above. Audit IPs stay because the audit log is append-only (see §3).

## 3. Never deleted by the retention job

| Data | Reason |
|---|---|
| `audit_logs` | Append-only (SEC-005), enforced by database triggers. Any future pruning would need a Founder-approved, attorney-reviewed procedure and a schema change. It is not part of this job. |
| Financial records: `orders`, `invoices`, `payments`, `refunds`, `receipts`, `disputes`, `subscriptions`, `project_costs`, price approvals | Tax and accounting retention (typically 7 years in the US; attorney/accountant to confirm). |
| `agreements`, `agreement_acceptances` | Proof of contract. Immutable by trigger. |
| `privacy_requests` | Proof that requests were handled. |
| Readiness evidence, releases, approvals, deployments, blockers | Launch and audit record (§46–§47). |
| CRM, projects, tickets, messages, active files | Business records for the life of the customer relationship. Deletion happens through a privacy deletion request (`/staff/security#privacy`), which anonymises the person and keeps financial records. |

## 4. Deletion requests vs. retention

A customer's deletion request (`/account/privacy`) is processed by staff (`src/services/privacy.ts`). It anonymises the user, revokes sessions and keeps the financial and agreement records the law requires. The retention job is separate. It applies time limits to operational data regardless of requests.

## 5. Backups

Database exports (BACKUP-RECOVERY §3.2) contain data that the retention job later deletes from the live database. The proposed backup retention is **35 days** for daily exports and **12 months** for monthly exports, encrypted at rest. This is also pending Founder approval. Restoring an old export re-introduces purged data, so after any restore, run the retention job before the database is used again.
