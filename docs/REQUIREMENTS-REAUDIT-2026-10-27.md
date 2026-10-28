# Requirements re-audit — 2026-10-27 (evening)

Computed from `requirements/inventory.ts` + `requirements/status/*` at this commit (not copied from the checkpoint).

| Ledger | Implemented | In progress | Not started | Total |
|---|---|---|---|---|
| Original registry | 83 | 58 | 13 | 154 |
| AI Builds addendum (AIB-001..011) | 9 | 2 | 0 | 11 |

The counts did not move today: the work since the checkpoint (rollback rehearsal, provider contract tests, self-hosted AI
drafts, local runner) closes **engineering gaps inside** in-progress requirements, but none of them can be honestly marked
implemented until the evidence named below exists. "Code exists" is not completion.

Legend — **Code**: first-party code still to write. **Evidence**: what must be observed before marking implemented.
**Ext**: external credential/service. **Founder**: Founder decision.

## Stale blocker notes corrected by this audit
Staging now exists (Worker `crestmont-platform-staging`, D1, deploys on push; public `/api/readiness/health` shows
`ci` and `staging_e2e` evidence received at 20:42 UTC today). Notes that still cite "BLK-003: staging does not exist"
are out of date for INFRA-002, READY-004, READY-006, READY-009, PAY-003, SUP-003, PM-005, DOC-002. They remain
**in progress** because each still lacks its own specific evidence (listed below) — the correction is to the reason, not the status.

## Original registry — incomplete requirements

### Engineering-completable (no external dependency for the remaining step)
| ID | Code | Evidence still required |
|---|---|---|
| TEST-004 | none — rehearsal + restore drill workflows exist | Run `staging-rollback-rehearsal` and `staging-restore-drill` once (manual dispatch); evidence posts to readiness |
| TEST-002 | 12 journeys still skip (Stripe, Resend, voice, portfolio) | Staging run artifacts for the 21 automated journeys (feed is healthy); remaining 12 need Ext |
| TEST-003 | axe runs in staging e2e already | CI artifact of the staging axe run |
| BRAND-006, WEB-009 | none | Point the visual sweep / link checks at staging in the deploy workflow |
| READY-004 | none | Already receiving CI evidence on staging — verify the ingestion record in the Owner readiness view and mark |
| READY-006, READY-009 | none | First staging deployment recorded by the deploy workflow in the readiness timeline |
| READY-012 | none | External alert destination (Founder F-03) |
| PM-005 | none | Staging cron execution recorded in `scheduled_job_runs` |
| INFRA-004 | none | A green Actions run with logs (this session cannot read Actions; Founder can confirm in GitHub) |
| AIOPS-002, SUP-004 | done today: self-hosted drafts with no paid API | One real draft produced by the local model on the Windows host |
| AIOPS-003 | none | Staging check that AI actors are refused on refund/contract/release routes (covered by unit matrix) |

### Blocked on an external service (all internal logic done and tested with fakes/fixtures — simulated)
| ID(s) | Ext | Evidence required |
|---|---|---|
| PAY-001, PAY-003..009, PORTAL-008, SALES-004, PM-003, CRM-007, FIN-002 | Stripe test account (BLK-004) | Real test-mode checkout, refund, dispute, webhook delivery and reconciliation run on staging |
| EMAIL-001..003, PORTAL-005, SUP-003 | Resend + verified domain (BLK-005) | Real delivery + signed webhook events |
| VOICE-002..006 | Retell account + number (BLK-009, purchase needs Founder) | Live call creating a lead |
| PORTAL-004, SEC-003, FILE-001 | R2 enabled on the account; malware scanner choice (F-02) | Upload/download on staging R2; scan status other than pending |
| READY-005 | GitHub token as staging secret | Live sync record |
| SEC-004 | per-environment secrets (now partly present); CI scan run | Scan results from Actions |
| INFRA-005, INFRA-006 | branch protection (Founder GitHub settings), alert channel | Settings screenshot / alert received |
| IDENT-003, IDENT-004 | mailboxes, domain ownership | DNS + mailbox verification |

### Founder / business decisions
IDENT-001, IDENT-002, IDENT-005, CAT-005/006, SUP-005, PORT-001..006 (genuine screenshots + relationship records),
LEGAL-001/002/004/005, PAY-010, SEC-006 (retention periods), SEC-007 (independent review), VOICE-001, DOC-002 (alerting),
LAUNCH-001..003.

## AI Builds addendum
| ID | Status | Remaining |
|---|---|---|
| AIB-010 | in progress | Runner is now provider-independent: local Ollama provider (default, no paid fallback), Agent SDK kept as an optional adapter, per-build Docker sandbox, Windows/WSL2 install scripts. Evidence: the sandbox verification script passing **on the Windows host**. |
| AIB-011 | in progress | One controlled internal Starter build on the Windows host with real local inference, network log showing no paid API traffic, build + browser tests passing, owner review, cancel/recover exercised. Needs the machine linked or the Founder running `Collect-Evidence.ps1`. |
