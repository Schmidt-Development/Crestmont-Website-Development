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

PR column: **#108** = FD-26 mandatory plan (`claude/fd26-mandatory-maintenance-commitment`); **B1** = batch 1
(`claude/founder-decisions-batch-1`).

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
| 13 | Portfolio display requires recorded opt-in | NOT STARTED | `services/portfolio.ts` `publishBlockers` does not check consent | — | Consent record + publish blocker; MSA:189 |
| 14 | Five business days per review request | NOT STARTED | `approval_requests` has no due date | — | `respond_by` + reminders; MSA `[REVIEW DAYS]` |
| 15 | Silence never approval | ALIGNED (pre-existing) | Approvals only via customer path (`projects.ts`) | existing | Strike MSA §7.5 option (ii) |
| 16 | Founder payment/launch exception via MFA workflow | NOT STARTED | `project.ts` supports `documentedPaymentException`, never wired | — | Owner-only step-up workflow + record |
| 17 | 30 days to report handoff issues; keeps 90-day warranty | NOT STARTED | MSA:158 placeholder | — | Legal text; tracking |
| 18 | Paused projects resume, no automatic restart fee | ALIGNED (code) | Resume to prior stage, no fee | existing | MSA:171 wording |
| 19 | Never auto-cancel for inactivity | ALIGNED (code) | `project.ts` auto-pause only | `tests/domain.test.ts` | Strike MSA §9.4 closure option |
| 20 | No Crestmont termination for convenience | NOT STARTED (legal text) | MSA:277 still grants it | — | Remove; attorney |
| 21 | Customer owns domains/deliverables; hosting suspendable after notice | NOT STARTED | Ownership text exists; no suspension workflow | — | See "7-day suspension" row |
| 22 | 60-day export/transition window | NOT STARTED | DPA:77 proposes 30 days; no org export | — | Org-level export job; text |
| 23 | Insurance research only; no coverage claimed | BLOCKED (insurer quotes, Founder) | MSA:257 claims "Crestmont maintains [INSURANCE]" | — | Remove claim until bound; obtain quotes |
| 24 | Quotes valid 30 days | NOT STARTED | Staff choose `valid_until` freely | — | Default today + 30 |
| 25 | 30 days' notice of subscription price increases | NOT STARTED | Price changes only checked "not in the past" | — | Enforce ≥ 30 days + notice email |
| 26 | Mandatory minimum plan; one business project per plan | IMPLEMENTED, TESTED locally (#108) | `catalog.ts` minimums + `assertPlanMeetsMinimum`; migration 0064; checkout plan picker; Executive "1 business project" (was "up to 2 sites"); MSA B.2A | `tests/maintenance-commitment.test.ts` (7); 833/0 local | CI on #108; custom-quote plan; staging journey |
| 27 | Subscription billing starts at approved launch | IMPLEMENTED in part (#108) | No subscription at package purchase; plan recorded on order | #108 tests | Create subscription at `customer_launch` + deploy (next PR) |
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
| 38 | 90-day raw IP, 180-day security logs | NOT STARTED (conflicts) | `retention.ts` security events 365 d; audit IPs never cleared | — | Change periods; IP truncation incl. audit log |
| 39 | Audited emergency backup-administrator access | IMPLEMENTED in part | Owner MFA break-glass script (audited) | existing | Designated backup admin workflow; Founder names person |
| 40 | High-risk customers reviewed individually | NOT STARTED | — | — | Risk flag + Owner review gate |
| 41 | Security reporting contact / security.txt | IMPLEMENTED (B1); BLOCKED on mailbox | `/.well-known/security.txt` served from Owner setting `security.contact_email`; 404 until set | `tests/founder-decisions-batch1.test.ts` | Founder creates a monitored security@ mailbox and sets it |
| 42 | Opt-in marketing with consent records | NOT STARTED | Unsubscribe + suppression exist; no consent ledger; `sales_info` sent without stored consent | — | Consent ledger; privacy text says no marketing |
| 43 | Signed confidentiality before sensitive access | NOT STARTED; BLOCKED (agreements) | — | — | Record acknowledgement before role grant |
| 44 | Crestmont inbound receptionist in launch certification | BLOCKED (Retell workspace, number, test call) | Inbound code + fixtures exist | fixtures | Real staging call (journeys 27–28) |
| 45 | Sell only certified AI receptionist capabilities | IMPLEMENTED in part (B1) | Outbound removed from `APPROVED_SERVICES`, service page, FAQ and the "Outbound" panel | `tests/founder-decisions-batch1.test.ts` | Public demo still has an "Outbound" scenario (`ui/receptionist.ts`); **Founder decision: keep or pull the inbound service page until a real call is certified** |
| 46 | Retire preview Worker after safety checks | IMPLEMENTED in part | No workflow deploys it (`tests/workflow-security.test.ts`) | existing | Founder deletes Worker/env after checks |
| 47 | External security test: scope + real quotes | BLOCKED (vendor quotes, Founder) | `docs/security/PENTEST-SCOPE.md` | — | Request-for-quote package; Founder authorization |
| C-1/2 | 7-day failed-payment suspension; no deletion at suspension | NOT STARTED | `payments.ts` only sets `past_due` + one email; nothing deletes data | — | Day-0/day-7 notices, suspension flag, restore on payment |

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

## Next code workstreams (highest risk first)

1. FD-30 customer-admin MFA enforcement.
2. FD-27 subscription at approved launch (uses `orders.maintenance_plan_id` from #108).
3. Suspension (C-1/2) with notices, no deletion, restore on payment.
4. FD-38 log retention + IP truncation.
5. Dual calendar for the receptionist (AI follow-up vs Founder callback).
6. FD-13 portfolio opt-in; FD-14 review due dates; FD-24 quote default; FD-25 price notice; FD-16 exception workflow.
7. Legal-suite revision (FD-01/02/06/09/10/17/20/22/23/33/35) as one draft PR for attorney review.
