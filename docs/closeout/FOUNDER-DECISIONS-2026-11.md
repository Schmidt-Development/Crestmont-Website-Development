# Founder decisions FD-01 … FD-47 — traceability matrix and execution ledger

Started 2026-11-01 (America/New_York) from `main` @ `1bfbcac`. **This file is the resume point** for any session working
on the 47 Founder decisions and the clarifications that follow them. Update a row only with evidence (file, PR, merged
commit, CI run, staging run). Older recommendations in `docs/FOUNDER-DECISION-REGISTER.md` (e.g. 72-hour breach notice,
30-day warranty, 12-month liability cap) are **superseded** by the decisions below.

None of these decisions is attorney approval or permission to publish the legal suite (clarification 10).

## Status vocabulary (never substitute one for another)

| Status | Meaning |
|---|---|
| NOT STARTED | Nothing implements the decision yet, or current code/text contradicts it |
| IMPLEMENTED | Code/config/text exists on a branch or `main` |
| TESTED | Required automated tests pass (local + CI) |
| STAGING CERTIFIED | Complete staging E2E passed with recorded evidence |
| PRODUCTION READY / CERTIFIED | Not used yet — no decision has reached staging certification |
| BLOCKED | A named external action is required (attorney, insurer, vendor, Founder, Node 1) |
| ALIGNED (pre-existing) | Code on `main` already behaved as decided before this work; still needs staging evidence |

"Legal text" means the draft documents in `docs/legal/` and `src/content/legal.ts`; every legal row is additionally
**BLOCKED on attorney review (LEGAL-004)** before publication.

## Baseline (2026-11-01)

- `main` @ `1bfbcac`: 826 tests passed / 0 failed locally (`npm test`); typecheck runs in CI (`@types/node` cannot be
  installed in the cloud workspace — npm registry unreachable).
- Staging `/api/readiness/health` was 503 (health monitor run 41360372620); PR #106 (another session) addressed the
  cause and merged.
- No AI system has a recorded run against a real provider: no Node 1 inference, no real Retell call, no real Stripe
  payment (see "Five systems" below).

## Matrix

PR column: **#108** = FD-26 mandatory plan (`claude/fd26-mandatory-maintenance-commitment`); **#109 / B1** = batch 1
(`claude/founder-decisions-batch-1`); **FD27** = launch billing + suspension (`claude/fd27-launch-billing-suspension`,
stacked on #108); **B2** = batch 2 (`claude/founder-decisions-batch-2`); **MFA** = customer-admin MFA
(`claude/fd30-customer-admin-mfa`); **CAL** = dual calendars (`claude/dual-calendars`).
Open PRs: **#108** FD-26 · **#109** batch 1 + FD-45 · **#110** FD-27 + suspension (stacked on #108) · **#111** batch 2 ·
**#112** FD-13 · **#113** FD-16.

| FD | Decision (short) | Status | Implementation / PR | Tests | Remaining |
|---|---|---|---|---|---|
| 01 | Liability cap = amount paid for affected order | NOT STARTED (legal text) | `src/content/legal.ts:77` already "amounts you paid for the services giving rise to the claim"; MSA §15.2 still `[LIABILITY CAP]`; Website Terms offer "$100 or 12 months" | — | Fill MSA §15.2 and Website Terms; attorney |
| 02 | Mediation, then Michigan courts | NOT STARTED (legal text) | MSA:295 still lists three options; governing law placeholder | — | Choose option (i), Michigan; attorney |
| 03 | Founder discretionary refunds; mandatory refunds never denied | IMPLEMENTED (B1) | `src/domain/refunds.ts`: support can no longer deny at review; `routes/finance.ts` hides Deny from non-Founders. Mandatory-obligation guard pre-existing | `tests/domain.test.ts` FD-03 test; `tests/finance.test.ts` (403 for support) | MSA Schedule E: remove "support may decline" and the Option B percentage table |
| 04 | No automatic proration of maintenance | ALIGNED (pre-existing) | No proration code; MSA E.5 and `legal.ts:171` | — | Drop bracketed choice at MSA E.5 |
| 05 | Proposed benefits are the baseline; not certified until tested | NOT STARTED | `catalog.ts` entitlements `proposed_pending_founder_approval`; maintenance checkout gated | — | Introduce "approved baseline, operational verification pending" state; verify each benefit (Phase 4) |
| 06 | 99.5% monthly availability target, no restoration deadline | NOT STARTED (legal text) | MSA:456 `[UPTIME TARGET]` | — | Fill MSA D with 99.5%, measurement method, exclusions |
| 07 | No automatic downtime credits | ALIGNED (code) | No credit logic | — | Pick "no credits" in MSA:460 |
| 08 | Human support Mon–Fri 9–5 ET; no 24/7 implication | IMPLEMENTED (guards pre-existing) | 24/7 claims refused (`catalog.ts` PROHIBITED_CLAIMS, settings validation) | existing | Owner sets `support.staffed_hours`; fill MSA D.2 |
| 09 | 48-hour customer notice of confirmed incidents | NOT STARTED (legal text) | DPA:67 `[NOTIFICATION HOURS]`; old register said 72 h | — | DPA §8.1, `INCIDENT-RESPONSE.md` §4.2; counsel |
| 10 | 90-day defect warranty | NOT STARTED | MSA:235 `[WARRANTY PERIOD]`; no warranty tracking | — | Legal text; record warranty end date at handoff |
| 11 | Invoices Net 7; keep upfront + 50/25/25 | IMPLEMENTED (B1) | `src/services/stripe-invoices.ts` `DAYS_UNTIL_DUE = 7` (was 14) | `tests/finance-documents.test.ts`, `tests/founder-decisions-batch1.test.ts` | MSA §4.3 |
| 12 | No late fees or interest | ALIGNED (code) | No late-fee code | — | Strike MSA §4.4(b) "1.5% per month" |
| 13 | Portfolio display requires recorded opt-in | IMPLEMENTED (#112; CI green) | Migration 0068 consent fields; `publishBlockers` refuses without consent or after withdrawal; Staff → Portfolio consent card; withdrawal unpublishes at once. Founder's written 2026-10-27 authorization recorded as consent for his own businesses (backfill + setup script; never re-granted after withdrawal) | `tests/portfolio-consent.test.ts`; workflow test asserts refusal before consent | MSA:189 opt-out option to strike; portal self-service consent for client sites (later) |
| 14 | Five business days per review request | IMPLEMENTED (#111; CI green) | `approval_requests.respond_by` (migration 0067) = end of 5th business day ET; shown in email + portal; `runReviewDeadlineSweep` reminds once, never approves | `tests/founder-decisions-batch2.test.ts` | MSA `[REVIEW DAYS]` text; public holidays not excluded (Founder may decide) |
| 15 | Silence never approval | ALIGNED + TESTED (#111) | Approvals only via customer path; overdue sweep leaves the request open | `tests/founder-decisions-batch2.test.ts` (no approval row after deadline) | Strike MSA §7.5 option (ii) |
| 16 | Founder payment exceptions via MFA workflow | IMPLEMENTED (#113) | Migration 0069 `release_payment_exceptions`; Owner-only `release.payment_exception`; step-up MFA route; waives only unpaid scheduled milestones (never change orders, simulated payments or approvals); revocable; audited | `tests/payment-exception.test.ts` (4) | — |
| 17 | 30 days to report handoff issues; keeps 90-day warranty | NOT STARTED | MSA:158 placeholder | — | Legal text; tracking |
| 18 | Paused projects resume, no automatic restart fee | ALIGNED (code) | Resume to prior stage, no fee | existing | MSA:171 wording |
| 19 | Never auto-cancel for inactivity | ALIGNED (code) | `project.ts` auto-pause only | `tests/domain.test.ts` | Strike MSA §9.4 closure option |
| 20 | No Crestmont termination for convenience | NOT STARTED (legal text) | MSA:277 still grants it | — | Remove; attorney |
| 21 | Customer owns domains/deliverables; hosting suspendable after notice | IMPLEMENTED in part (#110) | Suspension workflow with notices, Owner decision, no deletion (see C-1/2) | `tests/maintenance-lifecycle.test.ts` | Technical enforcement of "hosting suspended" on the customer site (take-offline step) is manual; legal text |
| 22 | 60-day export/transition window | NOT STARTED | DPA:77 proposes 30 days; no org export | — | Org-level export job; text |
| 23 | Insurance research only; no coverage claimed | BLOCKED (insurer quotes, Founder) | MSA:257 claims "Crestmont maintains [INSURANCE]" | — | Remove claim until bound; obtain quotes |
| 24 | Quotes valid 30 days | IMPLEMENTED (#111; CI green) | `quotes.ts` refuses validity > 30 days from the Eastern creation date; form default fixed to the same business date (was UTC) | `tests/founder-decisions-batch2.test.ts` | MSA `[QUOTE VALIDITY DAYS]` |
| 25 | 30 days' notice of subscription price increases | IMPLEMENTED (#111; CI green) | `pricing-approvals.ts`: increases need ≥30 days at proposal; effective ≥30 days after approval; subscribers emailed at approval | `tests/founder-decisions-batch2.test.ts` | Stripe price objects for existing subscriptions are not changed by this (manual until live billing exists) |
| 26 | Mandatory minimum plan; one business project per plan | IMPLEMENTED, TESTED (#108, CI green) | `catalog.ts` minimums; migration 0064; checkout plan picker; Executive "1 business project"; MSA B.2A; "optional plans" copy replaced (FD27) | `tests/maintenance-commitment.test.ts` (7); FD27 copy guard | Merge #108; custom-quote plan; staging journey |
| 27 | Subscription billing starts at approved launch | IMPLEMENTED (#110, stacked on #108; CI green) | `services/maintenance-lifecycle.ts`: activation opened by both launch paths; checkout refused before launch / below committed plan; webhook completes activation (migration 0066) | `tests/maintenance-lifecycle.test.ts` | Merge #108 first; real Stripe test-mode subscription on staging (BLK-004) |
| 28 | Third-party costs: disclosed, approved, invoiced separately | NOT STARTED | `project_costs` internal only | — | Approval + pass-through invoice kind |
| 29 | Verified email before checkout/payment/invitation | ALIGNED (pre-existing) | `routes/verify-gate.ts`; quote acceptance; invitation token | `tests/commerce-closeout.test.ts` | Staging evidence |
| 30 | MFA required for customer administrators | NOT STARTED (conflicts) | `auth.ts:255` lets customers skip MFA | — | Force enrolment for `customer_admin` |
| 31 | Role-based staff access with access logging | IMPLEMENTED in part | Roles in `authz.ts`; read logging only for a few views | existing | Log staff reads of customer records broadly |
| 32 | Progressive rate limits, no fixed 15-minute lockout | ALIGNED (code) | `auth.ts` no lockout, Turnstile + limits | `tests/auth.test.ts` | Fix docs claiming lockout (AUTH-PRODUCTION, DPA, Website Terms) |
| 33 | Recovery numbers internal until proven | IMPLEMENTED in part | `BACKUP-RECOVERY.md` internal targets | — | Remove RPO/RTO table from MSA D.8 |
| 34 | Production release: Founder auth + MFA + exact commit/env | ALIGNED (pre-existing) | `deploy-production.yml`; `readiness-admin.ts` binds commit | existing | Record environment explicitly on approval |
| 35 | 30 days' notice of subprocessor changes | NOT STARTED (legal text) | DPA:55 placeholder | — | DPA text |
| 36 | 60-day post-termination data export window | NOT STARTED | Per-user export only | — | Same as FD-22 |
| 37 | Encrypted daily backups, 35 days + 12 monthly | IMPLEMENTED in part; BLOCKED | `production-backup.yml` encrypted, off-Cloudflare, dormant without 5 `BACKUP_*` secrets; retention not enforced in code | — | Bucket + secrets (Founder); retention/monthly archive enforcement; restore evidence |
| 38 | 90-day raw IP, 180-day security logs | IMPLEMENTED (#111; CI green), provisional | `retention.ts`: security events 180 d; new `raw_ips` 90 d rule (sessions, security events, audit log); migration 0067 lets audit_logs clear an IP and nothing else; acceptance IPs kept as evidence | `tests/founder-decisions-batch2.test.ts` (trigger refuses every other change) | Owner applies periods on /staff/ops/retention; counsel confirms exceptions |
| 39 | Audited emergency backup-administrator access | IMPLEMENTED in part | Owner MFA break-glass script (audited) | existing | Designated backup admin workflow; Founder names person |
| 40 | High-risk customers reviewed individually | NOT STARTED | — | — | Risk flag + Owner review gate |
| 41 | Security reporting contact / security.txt | IMPLEMENTED (B1); BLOCKED on a verified mailbox | `/.well-known/security.txt` from setting `security.contact_email`; 404 until set | `tests/founder-decisions-batch1.test.ts` | See "Security mailbox" below |
| 42 | Opt-in marketing with consent records | NOT STARTED | Unsubscribe + suppression exist; no consent ledger; `sales_info` sent without stored consent | — | Consent ledger; privacy text says no marketing |
| 43 | Signed confidentiality before sensitive access | NOT STARTED; BLOCKED (attorney-approved agreement text) | — | — | Design ready: Owner records "signed confidentiality agreement on file" (date, evidence) before a staff role is granted or used. Changes staff sign-in for staging demo accounts → ship with/after the MFA branch. Needs counsel-approved agreement |
| 44 | Crestmont inbound receptionist in launch certification | BLOCKED (Retell workspace, number, test call) | Inbound code + fixtures exist | fixtures | Real staging call (journeys 27–28) |
| 45 | Sell only certified AI receptionist capabilities | IMPLEMENTED (#109) — TEMPORARY "Coming soon" | One flag `AI_RECEPTIONIST_OFFER.status` (`catalog.ts`): service page + homepage say Coming soon; every quote link → "Ask about availability"; quote form refuses the service (422, no lead); outbound demo scenario + toggle removed; website assistant and phone agent say not yet available | `tests/founder-decisions-batch1.test.ts`, updated `service-visuals`, `closeout-frontend` | **Reverse** (status → "available") only after FD-44 real E2E call is certified and recorded here |
| 46 | Retire preview Worker after safety checks | IMPLEMENTED in part | No workflow deploys it (`tests/workflow-security.test.ts`) | existing | Founder deletes Worker/env after checks |
| 47 | External security test: scope + real quotes | BLOCKED (vendor quotes, Founder) | `docs/security/PENTEST-SCOPE.md` | — | Request-for-quote package; Founder authorization |
| C-1/2 | 7-day failed-payment suspension; no deletion at suspension | IMPLEMENTED (#110; CI green) | First failure starts the clock; day-0 email; day-5 notice; day-7 eligible (Owner told); Founder-only suspend/restore with reason + step-up MFA; payment restores automatically; nothing deleted (`/staff/billing/hosting`) | `tests/maintenance-lifecycle.test.ts` | Real Stripe test-clock run on staging; take-offline mechanism for hosted sites |

## Security mailbox (FD-41) — checked 2026-11-01

Public DNS for `crestmontwebsitedevelopment.com`: MX → `route1/2/3.mx.cloudflare.net` and SPF
`include:_spf.mx.cloudflare.net`, i.e. **Cloudflare Email Routing receives mail for the domain**. That proves mail can be
received, not that `security@` is routed or read: Email Routing rules are not visible in DNS, this session has no
Cloudflare credential, and the repo documents only `support@`, `billing@`, `sales@`, `legal@`, `dmarc@` (EMAIL-DNS.md §3).
No test email was sent to an unverified address.

**Exact external action (Founder, ~5 minutes):** Cloudflare dashboard → the domain → Email → Email Routing → Routing
rules → *Create address* `security@crestmontwebsitedevelopment.com` → action *Send to an email* → a mailbox the Founder
reads (verify the destination when Cloudflare emails it). Send one test message from an outside account and confirm it
arrives. Then Staff → Settings → "Security reporting email" = `security@crestmontwebsitedevelopment.com` →
`/.well-known/security.txt` goes live on that environment.

## Merge order and deploy triggers

Every merge to `main` runs **Deploy staging** (~35–45 min, `concurrency: deploy-staging`, not cancelled, so merges queue
one deploy each), then the restore drill and rollback rehearsal (`workflow_run`). To avoid redundant deploys, merge
related PRs back to back only after each PR's CI is green; queued deploys run in order and the last one carries
everything. Recommended order (each step re-checked against `main` before merging):

1. **#108** FD-26 (no dependencies; migration 0064).
2. **#109** batch 1 + FD-45 (independent of #108; no conflicts verified with `git merge-tree`).
3. **FD27** (stacked on #108 — rebase on `main` after #108 merges; migration 0066).
4. **B2** batch 2 (migration 0067; independent).
5. **CAL** dual calendars (migration 0065 reserved; independent).
6. **MFA** customer-admin MFA — **last**, and only after its staging browser journeys are updated: it changes how every
   customer signs in, including the staging demo accounts the deploy's browser journeys use.

Staging deploys were failing on journey 14 (revision request) for #105 and #106; the fix (`bd51532`, another session)
is first included in the #107 deploy. Its result is recorded in the ledger.

## Five systems (2026-11-01 audit, code + docs)

| System | Implemented | Tested | Staging | Blocked by (exact action) |
|---|---|---|---|---|
| AI website builder (Node 1) | Pull-only HMAC runner, Docker sandbox (`--network none`, read-only, cap-drop), Ollama dual model | Fixtures/fake model servers only | **No Node 1 job ever claimed** | Founder at Node 1: probe `/api/builds/runner/claim` (503 ⇒ set `BUILD_RUNNER_SECRET` + Deploy staging), `ollama pull` both models, `Install-CrestmontRunner.ps1`, `Test-Node1Dispatch.ps1 -InferenceProbe`, queue D01–D13 diagnostic |
| Research agent | Evidence-required ingest, provenance, CRM dedup, quality gates | 60 tests; real-data audit passes on GitHub runner | E2E step in Deploy staging; no 24 h Node 1 run | `RESEARCH_RUNNER_SECRET`, research worker on Node 1, 24 h run, Founder 100-row review |
| Inbound receptionist | Signed webhook, 17 functions, DB-confirmed bookings, AI disclosure, recording consent | Fixtures | No real call | Retell workspace, key, agent, number, budget; one test call. **Dual calendar (AI follow-up vs Founder callback) does not exist yet** |
| Outbound sales agent | Compliance gate (consent, DNC ≤31 d, window, attempts), dedup, concurrency cap 1–20 | Fixtures | Calling OFF | Counsel consent design + Founder approval; consent capture; National DNC subscription; Retell number with STIR/SHAKEN |
| Self-improvement engine | Sales prompt only (`sales-opt`); builder proposals table | Fixture chain | Migration only | Extends to other systems not started; no real failure→fix→PR loop yet |

## Execution ledger

| When (ET) | Session action | Evidence |
|---|---|---|
| 2026-11-01 18:43 | Baseline on `main` @ `1bfbcac` | 826 passed / 0 failed |
| 2026-11-01 19:30 | PR #108 FD-26/27 opened | 833 passed / 0 failed locally; CI `test` (incl. typecheck), CodeQL, runner images, Windows scripts all green; mergeable, clean |
| 2026-11-01 20:40 | Merge of #108 attempted | **Refused by this session's permission policy (merge without review). Needs a person to merge.** Not worked around |
| 2026-11-01 20:45 | Batch 1 (FD-03, FD-11, FD-41, FD-45) | 832 passed / 0 failed locally |
| 2026-11-01 19:39 | Founder instructions: continue; FD-45 "Coming soon"; check security mailbox; start customer-admin MFA | — |
| 2026-11-01 19:45 | Rechecked #108/#109 against `main` @ `029e545` | Both mergeable/clean, all checks green. Merge not attempted again (refused earlier by policy) |
| 2026-11-01 19:50 | Staging deploys for #105/#106 failed on journey 14; fix `bd51532` first deployed by #107 run 41364900468 | Watching |
| 2026-11-01 20:30 | #109: FD-45 Coming soon | 832 passed / 2 failed → the 2 failures were tests requiring the old quote link; updated to the FD-45 rule, 16/16 pass |
| 2026-11-01 21:00 | FD27 branch (launch billing + suspension) | lifecycle 7/7; security matrix/email/commerce/ops 98/98 |
| 2026-11-01 21:30 | B2 branch (FD-14, FD-24, FD-25, FD-38) | batch-2 6/6; affected suites 32/32 after fixing the UTC/Eastern quote-date default |
| 2026-11-01 21:30 | Security mailbox checked (DNS) | Cloudflare Email Routing; `security@` route unverifiable from here → Founder action above |
| 2026-11-01 20:00 | #107 staging deploy run 41364900468 | **success**; journey 14 passes — `main` deploys cleanly again |
| 2026-11-01 20:05 | #110 FD27 full suite | 841 passed / 0 failed locally; CI test green |
| 2026-11-01 20:10 | Merge of #108 retried once after `main` was healthy | Refused again by this session's permission policy. All PRs left ready for the Founder |
| 2026-11-01 20:30 | #112 FD-13 portfolio consent | Generated staging portfolio SQL applied to a migrated DB: same 4 entries published as on `main`; withdrawal survives re-run. CI test green |
| 2026-11-01 20:50 | #113 FD-16 payment exception | 4/4 new tests; affected suites 78/78; typecheck clean |
| 2026-11-01 20:50 | Local typecheck now possible | `tsc --types ''` diffed against `main` (tool in session scratchpad); found and fixed one real error on #111 |

## Next code workstreams (highest risk first)

1. FD-30 customer-admin MFA enforcement.
2. FD-27 subscription at approved launch (uses `orders.maintenance_plan_id` from #108).
3. Suspension (C-1/2) with notices, no deletion, restore on payment.
4. FD-38 log retention + IP truncation.
5. Dual calendar for the receptionist (AI follow-up vs Founder callback).
6. FD-13 portfolio opt-in; FD-14 review due dates; FD-24 quote default; FD-25 price notice; FD-16 exception workflow.
7. Legal-suite revision (FD-01/02/06/09/10/17/20/22/23/33/35) as one draft PR for attorney review.
