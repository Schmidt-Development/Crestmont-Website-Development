# Crestmont — master verification and final production readiness

Final record for the Founder's *Master Verification, Remediation & Final Production Readiness* request (2026-11-08),
measured against the **original 112-item Crestmont implementation checklist** the Founder recovered on 2026-11-09. §B
reproduces that checklist exactly: same wording, order and sections. The `0/X` counters on the original were unchecked
tracking boxes, not engineering results, and are not treated as evidence of anything.

The Founder-only actions are listed separately and concisely in [FOUNDER-ACTIONS-2026-11-09.md](FOUNDER-ACTIONS-2026-11-09.md).

Every item is in exactly one state:

| State | Meaning |
|---|---|
| **PASS** | Implemented and verified, with the evidence named in the row. Test names are exact; staging runs are GitHub Actions run ids. |
| **FAILED** | A defect is present now. |
| **FOUNDER** | Engineering is complete and verified; what remains needs the Founder's judgment, account access or authorization. |
| **N/A** | Not applicable or intentionally disabled, with the reason. |

Evidence sources used throughout:
- **Unit/integration suite** (`npm test`, current `main`): **1,429 passed, 0 failed, 5 skipped**. The 5 skipped are the real-ClamAV tests, which need a live daemon; they passed **5/5, 0 skipped** in the ClamAV certification run 42523967236.
- **Final staging deploy, full verification**: run **42541946002** at commit `026e7bb`, conclusion **success** (§E).
- **Staging closeout verification** (real Stripe test mode, Resend, self-hosted AI): run 42520360929, plus the final-code rerun in §E.
- **Live Retell audits** (read-only) against the agents the Founder republished on 2026-11-08: receptionist **43/43**, sales agent **42/44**.

---

## A. Executive summary

| | |
|---|---|
| Original requirements | **112** (10 sections) |
| PASS | **104** |
| FAILED | **0** engineering defects open. One live-configuration finding (the sales agent's voicemail wording, item 9.8) can only be changed in Retell by the Founder, so it is counted under FOUNDER |
| FOUNDER | **7**: 6.1, 6.2, 6.3 (approve the document design), 9.8 (voicemail wording in Retell), 9.10 (DNS/domain), 10.3 (production backup destination), 10.18 (production authorization) |
| N/A | **1**: 4.5 (the refund request interface already existed and was verified, so nothing was added) |
| Staging certification | **All mandatory staging verification passes** (deploy 42541946002: success). The journey register reads 29/33 passed, 0 failed. Journeys 31–33 can only pass after a real production launch, by design. Journey 25 (live renewal failure) has no Stripe test-clock driver yet; the seven-day policy it would exercise is covered by automated tests (item 5.8) |
| Production decision | **NOT READY — EXTERNAL APPROVALS OR CREDENTIALS.** No technical blocker remains. Production needs the Founder items marked "blocks production" in the action list, then the Founder's explicit authorization (§H) |

---

## B. The 112 original requirements

PRs this cycle: #226 Stage B · #227 Stage A · #228 Stage C · #229 Stage D · #230 Stage F/G · #231 invoices/receipts ·
#232 outbound test pool · #233 closeout verification · #234–#239 staging certification fixes (§F). "W1–W6" are the
Founder walkthroughs in §C.

### 1. Tabs and sections to remove — 20 items

Implementation: `src/routes/nav.ts` (`RETIRED_STAFF_PAGES`, 16 sidebar entries), the Sales Optimization, AI
Receptionist and Reports pages (#227, #228, #229). Removing a tab never removes the service behind it: every retired
route still answers for the Owner.
Common evidence: `[OWN-001] retired pages are gone from the sidebar, with no duplicates, yet every one still answers for
the Owner; nothing behind them was removed` (R) and `[OWN-001] relocated actions stay reachable: AI drafts,
data-deletion requests and payment discrepancies in My Work; suppressions on Email operations; budgets moved` (M), both in
`tests/navigation.test.ts`. On staging, all 20 remaining Owner modules load (deploy 42541946002).

| # | Original requirement | Evidence | State |
|---|---|---|---|
| 1.1 | Remove Executive Overview | R; actionable items in My Work | PASS |
| 1.2 | Remove Launch Readiness | R; release safeguards still run in GitHub workflows (27 workflow checks pass) | PASS |
| 1.3 | Remove Engineering | R | PASS |
| 1.4 | Remove Development | R | PASS |
| 1.5 | Remove Staging | R | PASS |
| 1.6 | Remove Production | R; production workflows untouched | PASS |
| 1.7 | Remove standalone Tasks | R; `[OWN-001] My Work is the single task interface: All tasks tab, inline status updates that return to My Work` | PASS |
| 1.8 | Remove Profitability | R; profitability records and calculations kept (`[FIN-002] [FIN-003] …`) | PASS |
| 1.9 | Remove Reconciliation & Cost Import | R; the engine feeds My Work (section 3) | PASS |
| 1.10 | Remove AI Operations after relocating its budget | R; M (budget form on AI Sales Optimization, `id="ai-budget"`) | PASS |
| 1.11 | Retire Artifact Builder interface | R; Website Delivery kept (`[WDL-01…06]`); `AI_BUILD_AUTOMATION=off` | PASS |
| 1.12 | Remove Email Suppressions | R; M (suppressions on Email operations); enforcement live on staging: 6 sends refused for suppressed addresses in 7 days (closeout 42520360929) | PASS |
| 1.13 | Remove Monitoring | R; ops alerts every 15 min (`[INFRA-006] ops_alerts runs every 15 minutes …`) | PASS |
| 1.14 | Remove Deployments | R; deploy workflows and gates exercised throughout this cycle | PASS |
| 1.15 | Remove Security | R; security suites (matrix, tenancy, CSRF) pass | PASS |
| 1.16 | Remove Backups | R; staging restore drill 42547053035 (217 tables, 724,777 rows) and rollback rehearsal 42546329892 on the final build | PASS |
| 1.17 | Remove Profitability from Accounting Exports | M: Reports no longer links `/staff/reports/profitability.csv`; transactions, invoices, refunds and subscriptions exports remain | PASS |
| 1.18 | Remove Rollbacks from AI Sales Optimization | M: no "Rollback history" section; rollback still works (`[SALESOPT-011] a safety breach on the live version rolls back automatically …`) | PASS |
| 1.19 | Remove Experiments from AI Sales Optimization | M: no "Experiments" section; experiment records kept (`[SALESOPT-009] …`) | PASS |
| 1.20 | Remove AI Monthly Voice Budget from AI Receptionist | M: "Monthly voice budget" absent, "Voice costs this month" shown; `[VOICE-005] the inbound receptionist runs continuously: with no application voice budget it answers in full mode; the emergency pause still rejects calls` | PASS |

### 2. Dashboard and employee experience — 8 items

| # | Original requirement | Implementation · PR | Evidence | State |
|---|---|---|---|---|
| 2.1 | Simplify Lead Research evidence into plain English | research evidence view · #230 | `[CRM-004] Lead Research evidence reads in plain English; speculation is labelled; raw evidence is hidden but kept` | PASS (visual check in W1) |
| 2.2 | Fix Leads by Source chart overflow | Sales page grid · #230 | `[BRAND-006] Leads by source: labels and counts stay inside the card, never overlap, at 1440, 1024, 768, 390 and 320px` (browser, run 2026-11-09: pass); staging design sweep at 375 px and 1440 px (deploy 42541946002) | PASS |
| 2.3 | Make employee Recent Activity readable | `src/services/audit-describe.ts` · #230 | `[SEC-005] [EMP-003] audit events are described in plain English; names come only from the database; unknown events get a safe generic description` | PASS |
| 2.4 | Add Remove Employee action | employee detail · #226 | `[EMP-001] an administrator removes an employee: access and sessions revoked, work unassigned for reassignment, history kept` | PASS |
| 2.5 | Revoke removed employees' access and sessions | same | same test; `[EMP-001] permissions and Owner protection: no self-removal, only an Owner removes an Owner, never the last one` | PASS |
| 2.6 | Preserve employee activity and reassign outstanding work | same | first EMP-001 test; `[EMP-001] a person who is also a customer keeps their customer access when removed as staff` | PASS |
| 2.7 | Make Audit Logs readable in plain English | audit routes · #230, #237 | `[SEC-005] [EMP-003] Audit Logs: readable timeline, original record under Details, filters by employee, action, date, customer or project, and result`; `[SEC-005] audit 'event name starts with' and 'record type or id' filters use indexes and return exactly the matching entries` | PASS |
| 2.8 | Consolidate existing tasks into My Work | My Work · #227 | `[OWN-001] My Work is the single task interface …` | PASS |

### 3. My Work and financial discrepancies — 7 items

Implementation: `src/services/finance-work.ts`, migration 0099 · #228. Tests in `tests/finance-work.test.ts`.

| # | Original requirement | Evidence | State |
|---|---|---|---|
| 3.1 | Integrate reconciliation into My Work | `[FIN-W01] a discrepancy appears in My Work automatically, in plain English, once, and leaves when it clears` | PASS |
| 3.2 | Integrate cost-import issues into My Work | `[FIN-W03] failed maintenance payments, disputes, refund requests and a failed cost import appear and disappear with their source` | PASS |
| 3.3 | Automatically create actionable discrepancy tasks | FIN-W01, FIN-W03 | PASS |
| 3.4 | Allow investigation and resolution in My Work | `[FIN-W02] resolving from My Work records the note only; a problem marked fixed that comes back re-opens, an explained one does not`; `[FIN-W04] issues can be assigned to someone who can see them; assignment is audited and refused otherwise` | PASS |
| 3.5 | Automatically close genuinely resolved discrepancies | FIN-W01 ("leaves when it clears") | PASS |
| 3.6 | Prevent duplicate discrepancy tasks | FIN-W01 ("once"); FIN-W02 (recurrence re-opens rather than duplicates) | PASS |
| 3.7 | Preserve financial records and audit history | FIN-W02 (resolution records a note only, never alters a financial record); FIN-W04 (audited) | PASS |

### 4. Customer service and refunds — 6 items

| # | Original requirement | Implementation · PR | Evidence | State |
|---|---|---|---|---|
| 4.1 | Make Support AI Draft Reply update automatically without refresh | `src/services/ai-drafts.ts` · #228 | `[SUP-004] ticket AI draft: click starts a job at once, repeated clicks join it, the draft arrives via the status endpoint into the editable reply field, and nothing is sent`; **staging AI-01 with the real self-hosted model** `qwen3.6:35b-a3b-q4_K_M` (closeout 42520360929) | PASS |
| 4.2 | Add AI Draft Reply to Conversations | same | `[PORTAL-005] conversation AI draft: same flow on /staff/conversations/:orgId, context is only that customer's visible messages, idempotent, never auto-sent`; **staging AI-02** | PASS |
| 4.3 | Keep AI drafts editable and require human approval | same | `[SUP-004] AI-drafted replies on sensitive tickets require explicit human approval; drafts are never auto-sent`; staging `ai_draft_not_sent` (0 staff replies) | PASS (tone review in W3) |
| 4.4 | Verify customer refund request availability in portal | existing refund system | `[PAY-007] refund flow: customer request → support review → Founder approval → Stripe refund, audited and notified`; staging journey 26 (request enters the approval workflow) | PASS |
| 4.5 | Add refund request interface only if missing | — | It was not missing (4.4), so nothing was added, as the requirement directs | N/A |
| 4.6 | Preserve existing Owner-controlled refund approval | existing | `[PAY-007] mandatory obligations cannot be denied; issuing without Stripe explains it; AI can never act`; **staging Stripe test-mode refund**: the Founder approves with step-up MFA, Stripe refunds, the signed `charge.refunded` is matched, and the customer is notified once (deploy 42541946002) | PASS |

### 5. Subscription and website launch — 8 items

Implementation: `src/services/launch-gate.ts`, `src/services/maintenance-lifecycle.ts`, `src/routes/portal.ts`
(launch-gate card), migration 0098 · #226, #234, #238. Tests in `tests/launch-gate.test.ts` (6) and
`tests/maintenance-lifecycle.test.ts`. Staging: closeout LG-01…LG-07 with real Stripe test mode (run 42520360929: a $99.00
first payment confirmed by the signed `invoice.paid`, and the handoff published only after it), and journeys 19–20 on
deploy 42541946002 (a custom-quote project: the Owner records the plan, the customer signs and pays in Stripe test mode,
then deployment and handoff).

| # | Original requirement | Evidence | State |
|---|---|---|---|
| 5.1 | Require signed maintenance agreement before launch | `[PAY-004] launch gate: every incomplete state is blocked; only a signed agreement plus a Stripe-verified first payment unlocks publishing`; `[PAY-004] … a quote-based project cannot reach maintenance Checkout before the agreement is signed (found on staging)`; staging LG-01/LG-03 | PASS |
| 5.2 | Require active maintenance subscription before launch | same; `[PAY-004] … a $0 first invoice (a trial) is not a payment, and a trialing subscription does not unlock publishing`; `[PAY-004] launch gate: a custom-quote project gets its maintenance plan recorded by the Owner, then the normal gate applies (found by staging journey 19)` | PASS |
| 5.3 | Verify successful initial Stripe payment | `subscription_initial_payments` written only from the signed `invoice.paid`; staging `gate_first_payment` ($99.00); declined card (LG-05) then retry (LG-06) | PASS |
| 5.4 | Show both pending actions in Customer Portal | `[PAY-004] launch gate: the activation opens at customer review and the portal shows the two pending actions in order`; staging LG-01 | PASS (wording check in W2) |
| 5.5 | Automatically clear completed pending actions | staging LG-06: "both actions clear only after Stripe's webhook confirms the first payment" | PASS |
| 5.6 | Show launch eligibility to staff | release check 7 and the launch status on the project's Approvals tab; staging LG-02/LG-07 | PASS |
| 5.7 | Block all manual and automated publishing bypasses | `[PAY-004] launch gate: no release path can bypass it — deployment record, status change, authorization approval, handoff, Owner release and the runner`; staging LG-02 (handoff 409, deployment refused) | PASS |
| 5.8 | Preserve existing seven-day recurring-payment policy | `[PAY-004] clarifications 1–2: a failed payment starts a seven-day clock; reminder from day five; eligible on day seven; suspension is an Owner decision that deletes nothing`; a failed FIRST payment no longer starts that clock (#234). Live renewal failure on staging (journey 25) needs a Stripe test-clock driver that does not exist yet; the policy itself is verified by the tests above | PASS |

### 6. Invoices, receipts and reports — 10 items

Implementation: finance document renderer, zero-dependency PDF writer, `src/services/document-numbers.ts`, migration 0100 ·
#231. Tests in `tests/invoice-receipt-redesign.test.ts` (7) and `tests/finance-documents.test.ts`.

| # | Original requirement | Evidence | State |
|---|---|---|---|
| 6.1 | Redesign customer-facing invoice layout | Implemented and tested (fields, pagination, PDF) | FOUNDER: approve the appearance (F1) |
| 6.2 | Redesign receipt layout | Implemented and tested | FOUNDER: approve the appearance (F1) |
| 6.3 | Use professional black, gold and white branding | Implemented; brand tokens | FOUNDER: approve the appearance (F1) |
| 6.4 | Use sequential invoice numbers 001, 002, 003 | `[PAY-005] Phase 8.3: migration 0100 backfills historical invoices and receipts once, in created_at order; new documents continue each sequence; numbers never change`; `[PAY-005] Phase 8.3: concurrent allocation: every document gets exactly one number, numbers are unique and contiguous, and repeated calls never consume a number` | PASS |
| 6.5 | Use sequential receipt numbers 001, 002, 003 | same two tests | PASS |
| 6.6 | Hide raw Stripe and internal IDs | `[PAY-005] Phase 8.4/8.5: invoice and receipt show the required customer-facing fields and no internal or Stripe identifiers (HTML and PDF)` | PASS |
| 6.7 | Show readable customer, service, date, amount and status | same; `[PAY-005] Phase 8.5: a refunded or disputed payment shows that status while the original payment date and amount remain`; `[PAY-005] Phase 8.4: tax appears only when it was configured at issue …` | PASS |
| 6.8 | Preserve internal payment references | `[PAY-005] printable receipt: stable unique number, customer-facing numbers only (internal/Stripe refs for staff) …` | PASS |
| 6.9 | Verify accurate PDF rendering and delivery | `[PAY-005] zero-dependency PDF writer: valid PDF 1.4 structure …`; `[PAY-005] Phase 8.6: long customer names and many line items wrap and paginate without clipping …`; `[PAY-005] Phase 8.6: the receipt email from the verified payment names the receipt and invoice numbers and links the receipt and its PDF, which download for the customer` | PASS |
| 6.10 | Remove Profitability export while preserving other accounting exports | navigation test (1.17); `[FIN-004] accounting exports use date ranges, ISO dates, cents and dollars, and escape formulas` | PASS |

### 7. AI receptionist and sales optimization — 12 items

| # | Original requirement | Implementation · PR | Evidence | State |
|---|---|---|---|---|
| 7.1 | Move monthly AI budget into AI Sales Optimization | sales-opt page · #228 | M (1.10); `[VOICE-005] voice costs are recorded per call; the monthly budget governs outbound only …` | PASS |
| 7.2 | Remove voice monthly budget from AI Receptionist | voice page · #229 | M (1.20) | PASS |
| 7.3 | Correct Retell provider configuration status | `src/services/receptionist-status.ts` · #229 | `[VOICE-005] receptionist status: not configured without the Retell key; configured but unverified until real calls; verified by real signed calls here`; staging `retell` **verified** | PASS |
| 7.4 | Correct phone number configuration status | same | staging `telephony` **verified** (+1 517-300-2055, real calls on …2055) | PASS |
| 7.5 | Correct agent configuration status | same | `[VOICE-005] the receptionist page and the Integrations rows show the same real status`; live receptionist audit **43/43** on the published v4 | PASS |
| 7.6 | Verify call and usage-cost tracking | voice ingestion | staging: 3 real signed calls, each with duration, provider call id and provider cost (total $0.9253), no duplicate provider ids (closeout `calls_real`, `calls_no_duplicates`) | PASS |
| 7.7 | Analyze completed outbound sales calls automatically | `src/services/sales-opt/*` | `[SALESOPT-001] signed sales-agent events are recorded once …`; `[SALESOPT-003] analyses run only on consented transcripts …`. Running it on real calls awaits outbound calling, which stays off until counsel approves (F9) | PASS |
| 7.8 | Identify failed or incorrect closes | same | `[SALESOPT-002] only webhook-verified payments become sales; multi-touch credit, refunds, duplicates and test calls are handled`; `[SALESOPT-004] [SALESOPT-010] per-version calls, qualified-conversation and appointment conversion come only from recorded facts …` | PASS |
| 7.9 | Generate improved sales-script candidates | same | `[SALESOPT-005] proposals from the self-hosted model must cite evidence and pass the policy; accepted ones become AI versions under evaluation` | PASS |
| 7.10 | Evaluate and safely promote eligible script improvements | same | `[SALESOPT-007] [SALESOPT-006] evaluation runs on the runner channel; a version passes only when every scenario passes`; `[SALESOPT-008] production needs every gate …`; `[SALESOPT-009] … no promotion on small samples, safety stop …`. The engine refuses to deploy over the Founder's newly published prompt until "Adopt live prompt" is pressed (F8) | PASS |
| 7.11 | Preserve internal rollback capability | same | `[SALESOPT-011] a safety breach on the live version rolls back automatically to the last verified version` | PASS |
| 7.12 | Show optimization activity and results in dashboard | sales-opt dashboard · #228 | `[SALESOPT-010] at a glance: plain-English status from recorded events only; nothing is claimed before it happened, blockers are named` | PASS |

### 8. CRM, outbound calls and calendars — 10 items

| # | Original requirement | Implementation · PR | Evidence | State |
|---|---|---|---|---|
| 8.1 | Verify CRM leads enter outbound calling queue | `src/services/sales-outbound.ts` (`CONSENTED_LEAD_IDS`) · #234, #235 | `[VOICE-005] outbound counts: both consent routes counted, lost/merged/revoked excluded, already-called leads are not candidates`; outbound staging E2E 25 passed, 0 failed, 1 blocked (deploy 42541946002). Only leads with documented AI-calling consent enter the queue; the 36,000+ imported leads never do. Live dialling stays off until counsel approves | PASS |
| 8.2 | Show eligible, queued, scheduled and completed calls | `src/services/outbound-status.ts` · #228 | `[VOICE-003] outbound calling status: eligibility explained, queue counts follow the real engine, results synced once and shown in plain English`; Sales page loads on staging | PASS |
| 8.3 | Preserve DNC, consent and calling eligibility rules | existing | `[VOICE-005] [SEC-001] compliance gate: blocked by default …`; `[VOICE-005] sales calling window: weekdays 10:00–19:00 recipient time …`; `[VOICE-005] [CRM-005] do-not-call: recorded immediately, applied to every channel …` | PASS |
| 8.4 | Sync call outcomes back to CRM | existing | `[VOICE-003] call webhook: status, final outcome written once from platform facts …`; `[VOICE-005] final outcome precedence …` | PASS |
| 8.5 | Verify AI Follow-Up Calendar | appointment sync · #228 | `[VOICE-003] [EMAIL-002] AI Follow-Up appointment via the signed Retell webhook: calendar, time zone, lead, duplicates, reschedule, cancel; one internal email per event` | PASS (live booking in W5) |
| 8.6 | Verify Founder Callback Calendar | existing + #228 | `[VOICE-003] [EMAIL-002] [SEC-002] Founder Callback calendar: explicit request only, never dialled by the AI …`; `[VOICE-003] no overlapping Founder appointments, even under concurrent booking …` | PASS (live booking in W5) |
| 8.7 | Verify appointment creation, changes and cancellations | same | the two tests above; `tests/founder-calendar.test.ts` | PASS |
| 8.8 | Send appointment notification emails to internal Gmail | `src/services/appointment-notifications.ts` · #228 | `[VOICE-003] [EMAIL-002] the internal mailbox is emailed once per new, rescheduled and cancelled Founder appointment …`; real delivery to the internal mailbox verified on staging (9.4) | PASS |
| 8.9 | Synchronize appointments with outbound agent scheduling | appointment → `sales_calls` · #228 | `[VOICE-005] [VOICE-003] a booked AI appointment is dialled at its time (not before), with the appointment in the agent's context …`; `[VOICE-005] a moved appointment whose call was not moved is never dialled at the old time …` | PASS |
| 8.10 | Prevent duplicate or inappropriate callbacks | same | `[VOICE-005] one callback request never becomes two calls …`; `[VOICE-005] a cancelled appointment is never dialled …`; `[VOICE-005] a lead who opted out after booking is never called …`; `[VOICE-005] cold outreach never calls a prospect who already has an appointment on either calendar` | PASS |

### 9. Email and integrations — 13 items

| # | Original requirement | Implementation · PR | Evidence | State |
|---|---|---|---|---|
| 9.1 | Send paid website order notifications to internal Gmail | `src/services/internal-notify.ts` · #229 | `[EMAIL-001] a verified website payment emails the internal mailbox once, with the order's facts; duplicates and retries send nothing more` | PASS |
| 9.2 | Route all appropriate internal operational emails to internal Gmail | same | `[EMAIL-001] staging may mail the internal operations mailbox; every other non-allowlisted address is still held`; disputes (`[PAY-008] [PAY-003] Stripe test mode: a disputed payment reaches staff Disputes and the internal mailbox is emailed once`, staging pass), refunds, escalations and ops alerts | PASS |
| 9.3 | Investigate Resend HTTP 401 error | `src/services/integrations.ts` · #229 | Cause: a least-privilege send-only key is refused on `/domains` (`restricted_api_key`) while it sends normally. Now judged by what Resend accepted and delivered: `[EMAIL-001] a send-only Resend key is not reported as failing …` | PASS |
| 9.4 | Verify actual email sending and delivery | — | **Real delivery on staging**: Resend message 01a1bcdc-… accepted and confirmed delivered by Resend's signed webhook (closeout EM-02); the `resend` status is verified (18 accepted, 18 delivered in 30 days) | PASS |
| 9.5 | Verify purchase, receipt, appointment, support and refund notifications | mailer templates | `[EMAIL-002] template catalogue renders every template as a labelled preview`; the purchase (9.1), receipt (6.9), appointment (8.8), support (`[SUP-003] first response time is recorded … and the customer is notified`) and refund (`[EMAIL-001] a refund request emails the internal mailbox once; the customer still gets their own confirmation`) tests; the staging refund E2E checks exactly one refund email. Mail to customer addresses on staging is held by the recipient allowlist by design | PASS (wording approval: F2) |
| 9.6 | Preserve email suppression and bounce enforcement | existing | staging: 6 sends refused for hard-bounced addresses in 7 days; `[EMAIL-001] the Email page separates held, waiting, accepted, delivered, bounced, failed and suppressed …` | PASS |
| 9.7 | Verify Stripe integration | — | staging `stripe` verified (test mode; webhook endpoint enabled with every handled event); real test-mode purchase, subscription, refund and dispute pass on staging. Live keys are for production activation (F6) | PASS |
| 9.8 | Verify Retell inbound and outbound integrations | — | Inbound: **verified**, live audit 43/43. Outbound: live audit **42/44**. The voicemail text lacks an AI disclosure, which is a Retell setting only the Founder changes; the Self-Improvement Engine baseline awaits "Adopt live prompt" | FOUNDER (F7, F8; outbound calling stays off) |
| 9.9 | Verify Cloudflare D1, R2 and Turnstile | — | staging `database`, `object_storage` and `turnstile` verified. D1 overload remediated: all 20 Owner modules load and no "overloaded" fault occurred in the final deploy (§F) | PASS |
| 9.10 | Verify DNS and domain configuration | — | The platform has no DNS provider access (BLK-011, by design); the production domain has not been pointed at production yet | FOUNDER (F4) |
| 9.11 | Verify GitHub and self-hosted AI integrations | — | staging `github` verified (read-only workflow token); `ai` verified (self-hosted runner heartbeat, no paid API) | PASS |
| 9.12 | Correct inaccurate integration statuses | `integrations.ts`, `receptionist-status.ts` · #229, #230, #236 | Resend 401 (9.3); receptionist (7.3–7.5); Resend webhooks "unverified" despite real signed events, fixed (`tests/integrations.test.ts`) | PASS |
| 9.13 | Distinguish staging readiness from production readiness | — | statuses carry the environment ("Staging results never prove production"); `[PAY-010] payments mode: production refuses test keys …`; `[VOICE-003] [INFRA-002] staging and production never accept each other's Retell events …` | PASS |

### 10. Production verification — 18 items

| # | Original requirement | Evidence | State |
|---|---|---|---|
| 10.1 | Preserve backend security and MFA | `tests/security-matrix.test.ts` (7), `tests/security-tenancy.test.ts` (5), CSRF on every state-changing route; staging transport checks 7/8 (the one warning, Always Use HTTPS, is a Cloudflare dashboard setting: F4) | PASS |
| 10.2 | Preserve monitoring and critical alerts | `[INFRA-006] ops_alerts emails the internal operations mailbox …`; Worker fault capture records faults even when D1 refuses writes (it did so throughout §F) | PASS |
| 10.3 | Preserve backups and recovery procedures | Staging restore drill 42547053035 and rollback rehearsal 42546329892 pass on the final build. **Production backups are not verified**: no off-Cloudflare destination yet, and no production restore evidence | FOUNDER (F5) |
| 10.4 | Preserve deployment safeguards | workflow security/structure tests (27); every change this cycle went through PR, green CI and a staging deploy | PASS |
| 10.5 | Preserve existing Research Agent | research worker unchanged; lead research staging E2E **19/0** | PASS |
| 10.6 | Preserve completed customer and financial records | no destructive migration (0098–0101 add columns and indexes only); staging fixtures use per-run `@example.com` organizations | PASS |
| 10.7 | Test desktop and mobile layouts | staging design-language sweep at 375 px and 1440 px (public, portal, employee and Owner pages); Leads by Source at 5 widths; local browser suite 48/48 run | PASS (visual approval: F10) |
| 10.8 | Test all affected permissions | security matrix covers every registered route, including those added this cycle (an anonymous 500 on a new route was caught before merge) | PASS |
| 10.9 | Test employee removal end to end | EMP-001 ×3 through the real routes (sessions issued before removal are refused) | PASS |
| 10.10 | Test payment, subscription and publishing gates | closeout LG-01…LG-07 (real Stripe test mode); journeys 19–20; launch-gate tests ×6 | PASS |
| 10.11 | Test support and conversation AI drafting | staging AI-01/AI-02 with the real self-hosted model; SUP-004 and PORTAL-005 tests | PASS |
| 10.12 | Test CRM, Retell, calendars and notifications | journeys 27–28 (a real Retell call's lead appears in the CRM); outbound E2E; CRM duplicate protection E2E 24/0; calendar tests (8.5–8.10) | PASS (live booking call: F11) |
| 10.13 | Test reconciliation and accounting exports | FIN-W01…W04; `[PAY-009] ledger reconciliation compares Stripe invoices, balance transactions and payouts …`; FIN-004 | PASS |
| 10.14 | Test invoice and receipt PDF output | section 6 PDF tests | PASS |
| 10.15 | Run relevant CI and staging E2E tests | CI green on every PR (#234–#239); final full staging deploy 42541946002 **success** (§E) | PASS |
| 10.16 | Document external blockers without inventing fixes | §G and the Founder action list | PASS |
| 10.17 | Produce final pass/fail completion matrix | this document | PASS |
| 10.18 | Hold production deployment until authorized | production has never been deployed; no production deploy in this cycle | FOUNDER (F6: authorization) |

**Totals:** PASS 104 · FAILED 0 · FOUNDER 7 · N/A 1 = 112.

---

## C. Founder checklist (manual items, automated preparation done)

Everything below has passed its automated and staging verification (§B, §E). What remains is a person's judgment,
access or authorization. The checks are grouped into six walkthroughs so that one sign-in or one call covers many
items. None of them asks the Founder to read code, run SQL, inspect webhooks or operate CI.

**Sign-in for W1–W3:** the staging Owner account and the demo customer accounts listed in the sealed access notes
produced by the latest staging deploy (`docs/STAGING-PREVIEW.md` explains how to open them). Site:
`https://crestmont-platform-staging.partners-df4.workers.dev`.

### W1 — Owner Dashboard and staff experience (≈20 min, desktop, then phone) · approval required · blocks production: no (quality approval)

| Step | Where | Expected | Decision |
|---|---|---|---|
| 1 | Sign in as Owner → sidebar | The 20 removed tabs and sections are absent (section 1, items 1.1–1.20); every remaining entry opens | Approve the simplified navigation |
| 2 | My Work → All tasks; financial issues | One task list; discrepancies in plain English with amount, customer, next action | Approve wording and layout |
| 3 | Sales | Leads by Source fits its card with 36k-scale counts; "Outbound calling (AI sales calls)" shows counts with reasons | Approve |
| 4 | CRM → a research lead → Evidence | Plain-English findings; technical detail only under Details | Approve |
| 5 | Employees → a person → Recent activity; Audit logs | Readable timeline; filters work | Approve |
| 6 | Customers, Projects, Support, Refunds, Disputes, Revenue, Subscriptions, Invoices | Each opens with real staging data | Approve |
| 7 | Repeat steps 1–3 on a phone | No horizontal scrolling; menu usable | Approve mobile |

### W2 — Customer Portal, launch gate, invoice and receipt (≈15 min) · approval required · blocks production: invoice/receipt appearance (items 6.1–6.3) yes, the rest no

| Step | Where | Expected | Decision |
|---|---|---|---|
| 1 | Run **Actions → "Staging closeout verification" → Run workflow** (one click; it creates a fresh test customer whose website is at customer review and walks it through the real Stripe test-mode launch) | Run succeeds: 12/12 browser checks, 10/10 database checks (last run: 42520360929) | None: this is the prepared fixture |
| 2 | As Owner: Projects → the newest "Closeout E2E" project → Approvals | Release check 7 reads "Pass"; handoff published after the first payment | None |
| 3 | As a demo customer: Portal → project | Launch-gate card: "Pending action: Sign your maintenance agreement", then "Activate your maintenance subscription" | Approve the customer-facing explanation (item 5.4) |
| 4 | Staff → Finance → Invoices → open an invoice and its receipt (HTML and PDF) | Black/gold/white document; human numbers (Invoice 001…, Receipt 001…); no Stripe or database identifiers | **Approve invoice and receipt appearance (items 6.1–6.3)** |
| 5 | Portal → Billing (demo customer) | Orders, invoices, receipts, subscription and refund request visible | Approve |

### W3 — Customer communications and AI drafts (≈10 min) · approval required · blocks production: customer-notification wording yes

| Step | Where | Expected | Decision |
|---|---|---|---|
| 1 | Email operations → Templates | Every customer and internal template rendered as a preview | **Approve wording** of: account, purchase, invoice/receipt, appointment booked/changed, support response, refund request, dispute, maintenance agreement, subscription activated, subscription did not start (new in #234), subscription payment failed |
| 2 | Support → the newest "Closeout" ticket → AI Draft Reply | A draft from the self-hosted model appears without a refresh, editable, not sent | Approve draft quality and tone |
| 3 | Conversations → that customer → AI Draft Reply | Same | Approve |
| 4 | Gmail `crestmontwebsitedevelopment@gmail.com` | Internal notices (e.g. "New lead") received from staging | Confirm receipt |

### W4 — Retell settings that only the Founder changes (≈5 min) · decision required · blocks production: no (outbound calling stays off)

| Step | Where | Expected | Decision |
|---|---|---|---|
| 1 | Retell → **outbound** workspace → sales agent `agent_bbb30864fb403d788a5a2784bc` → Call settings → Voicemail (static text) | Current text (288 characters) names Crestmont and a callback number but does not say the caller is an AI | Add AI disclosure, e.g. "Hi, this is Cimo, an AI assistant calling on behalf of Crestmont Website Development…", keeping the same callback number; publish. **Prompts are not touched** |
| 2 | Staging → **/staff/sales-optimization** → "Adopt live prompt" | The engine records the Founder's newly published sales prompt as its baseline (writes nothing to Retell) | Press it, or leave it: until pressed, the engine refuses to deploy over the live prompt |
| 3 | Counsel | Outbound AI calling (TCPA/47 CFR 64.1200, including the voicemail opt-out mechanism) | Approval before outbound calling is ever enabled; an automated audit is not legal approval |

### W5 — One controlled inbound call (≈8 min, from the Founder's own phone) · approval of call quality · blocks production: no

Call **+1 517-300-2055** (staging receptionist, published v4). In one call:

| Say / do | Function exercised | Expected afterwards |
|---|---|---|
| Agree to recording | `record_consent` | Call record with transcript (consented) |
| "What do your packages cost?" | `get_packages_pricing` | Exact catalog prices |
| Give name, email, business, "Business package" | `crm_upsert_lead` | One CRM lead (staff → CRM) |
| "Can someone call me back Tuesday?" | `schedule_consultation` | AI Follow-Up Calendar entry; one internal email |
| "Actually I'd like to talk to the Founder" | `schedule_consultation` / `request_callback` with `wants_founder` | Founder Callback Calendar entry; one detailed internal email |
| "Move my appointment" then "cancel it" | `lookup_consultation`, `reschedule_consultation`, `cancel_consultation` | Calendar updated; internal emails for change and cancellation |
| "Send me the prices by email" | `send_customer_email` | Held by the staging allowlist unless the Founder's address is allowlisted (by design) |
| Ask for a person | `check_transfer_availability` → warm transfer (staffed hours only) or callback | Transfer only during staffed hours |
| Stay silent ~10 s | natural silence handling | A gentle prompt, no hang-up |

**Decision:** approve voice and conversation quality (Cimo, 24/7 behavior). No outbound call is placed.

### W6 — Production authorization (≈15 min) · authorization required · blocks production: yes

See §G (external items) and §H. In order: (1) review the unexpected live-service secret on the production Worker flagged
by provisioning run 42119243249; (2) authorize the production deploy; (3) DNS: apex records for
`crestmontwebsitedevelopment.com` per `docs/PRODUCTION-PROVISIONING.md` Stage 2; (4) set the repository variable
`PRODUCTION_URL` (turns on the free production health monitor and daily backup schedule) and the backup destination
`BACKUP_S3_*` / `BACKUP_SEAL_PASSPHRASE` (docs/BACKUP-RECOVERY.md §3.2); (5) at customer activation only: production
Resend and live Stripe keys with `PAYMENTS_LIVE_AUTHORIZED`; (6) after the deploy: production smoke test and the
decision to open customer access.

## D. Claude technical checklist

| Area | Verified | Evidence | State |
|---|---|---|---|
| A. Infrastructure and D1 | Query plans, indexes, Owner routes, scheduled jobs, concurrent workloads, error logging | §F root causes 1–3; plan tests in `tests/outbound-status-scale.test.ts`; D1 analytics runs 42519454251 / 42521965812; Owner sweep §E; Worker tail capture recorded every fault even when `app_errors` writes were refused | see §E |
| B. Dashboard and permissions | Removals, navigation, role restrictions, sessions, audit, assignment, reporting, filters, pagination | §B sections 1–3; `tests/security-matrix.test.ts`; `[PM-004] task list: search, unassigned and dependency filters, pagination …` | PASS |
| C. My Work and accounting | Intake, cost-import exceptions, reconciliation, assignment, dedupe, resolution, history, exports, permissions | FIN-W01…W04; FIN-004 | PASS |
| D. Stripe and publishing | Package purchase (test mode), agreements, agreement-before-Checkout, initial payment, status sync, pending tasks, every publish path, direct API bypass, abandoned, declined, incomplete, retry, duplicate/reordered webhooks, renewal failure + seven-day policy, recovery, quotes, entitlements, environment isolation | §B section 5, item 9.13; staging LG-01…LG-07 (real Stripe test mode); `STRIPE_PUBLISHABLE_KEY` below | PASS |
| `STRIPE_PUBLISHABLE_KEY` | Is it needed? | **No.** Checkout is Stripe-hosted (server-created session, redirect); no application code reads the key (`src/routes/api.ts`: "No publishable key is used: checkout is Stripe-hosted"). `scripts/staging-binding-guard.ts` lists it only as a Founder-managed value it must not delete. Not added; not required for production | PASS (N/A as a requirement) |
| E. Financial documents | Generation, numbering, concurrency, retries, amounts, confirmation, permissions, email, refunds, disputes, reconciliation | §B section 6; PAY-005…PAY-009 | PASS (appearance: W2) |
| F. Support and AI | Real drafting, approval, editing, retries, timeouts, authorization, history, context, attachments, notifications | §B items 4.1–4.3; `[SUP-001]…[SUP-005]`; staging AI-01/AI-02 (real self-hosted model) | PASS |
| G. Retell | Both live agents, audits, schemas, signatures, consent, CRM, calendars, transfers, voicemail, outcomes, analytics, budgets, provider status, SIE protections | live audits (deploys 42521194657 and 42541946002): inbound **43/43**, outbound **42/44** (item 9.8); `tests/voice*.test.ts`, `tests/outbound-sales.test.ts`, `tests/sales-optimization.test.ts` | PASS inbound · FOUNDER outbound (W4) |
| H. CRM, research, calendars | Research Agent intact, evidence, attribution, dedupe, stages, ownership, eligibility, suppression, both calendars, create/reschedule/cancel, time zones, collisions, reminders, associations, retries | §B items 2.1, 8.1–8.10; `[CRM-001]…[CRM-007]` suites | PASS (live booking: W5) |
| I. Resend and external integrations | Delivery, templates, sender, allowlist, bounces, complaints, suppression, Stripe/Retell webhooks, Cloudflare, DNS, GitHub, self-hosted AI | §B section 9 | PASS · FOUNDER (DNS) |
| J. Security and reliability | Auth, MFA + step-up, RBAC, sessions, signatures, replay, idempotency, validation, malware scanning, quarantine, backups, restore, monitoring, errors, alerting, recovery, rollback | security suites; scanner suite + real-ClamAV certification (§E); staging restore drill 42547053035 + rollback rehearsal 42546329892 (final build); **production backups are not verified** (no off-Cloudflare destination yet, no production restore evidence) | PASS (staging) · FOUNDER (production backup destination) |
| K. Full staging certification | All mandatory checks | §E | see §E |
| L. Production preparation | Worker, D1, R2, bindings, secrets, DNS, TLS, Stripe/Retell/Resend production, Turnstile, migrations, backups, monitoring, recovery, rollback, access restrictions | Worker `crestmont-platform-production` (draft, workers.dev and previews off), D1 `crestmont-production`, R2 `crestmont-files-production`, Turnstile production keys, `EVIDENCE_INGEST_SECRET`, `MFA_ENCRYPTION_KEY`, `CRM_ERASURE_HMAC_KEY` installed (provision run 42119243249); migrations apply on first deploy; `AI_BUILD_AUTOMATION=off`; payments/email/voice deliberately absent until activation | FOUNDER (W6) |

## E. Test results (exact counts)

| Suite | Run | Passed | Failed | Skipped / blocked | Notes |
|---|---|---|---|---|---|
| Unit + integration (`npm test`) | CI on every PR; staging deploy test gate | **1,429** | **0** | 5 | The 5 are real-ClamAV tests needing a live daemon; they run in the certification below |
| Real-ClamAV certification | 42523967236 | **29** scanner suite · **5/5** real-daemon | 0 | 0 | First run ever: the workflow had never executed a test (§F #7). Its container's signature set is dated 2026-03-01: this certifies scanner behaviour against real ClamAV, not signature freshness, which the staging heartbeat monitors |
| Local browser suite (`npm run e2e`) | 2026-11-09, this session | **48** | **0** after §F #14 | 90 (staging-only specs skip without staging credentials) | Includes Leads by Source at 1440/1024/768/390/320 px |
| **Final staging deploy, full verification** | **42541946002** at `026e7bb` | — | — | — | **Conclusion: success** |
| · test gate | same | 1,429 | 0 | 5 | |
| · Owner access sweep | same | 4/4 stages, **20/20 Owner modules** | 0 | — | Waited for CI's evidence post first (§F #5); no "D1 DB is overloaded" fault anywhere in the run |
| · transport security | same | 7 | 0 | 1 warning | Plain http served without a redirect: Cloudflare "Always Use HTTPS" (F4) |
| · staging health check | same | 9 | 0 | 0 | |
| · browser journeys and quality | same | **45** | **0** | 4 | Journey register **29/33 passed, 0 failed**. Skipped: 25 (no Stripe test-clock driver for a live renewal failure; item 5.8) and 31–33 (only a real production launch can pass them, by design) |
| · CRM duplicate protection E2E | same | 24 | 0 | 0 | |
| · malware scanning lifecycle (real ClamAV + EICAR) | same | 9 | 0 | 0 | Verified against the live Node 1 scanner serving staging |
| · lead research E2E (Research Agent) | same | 19 | 0 | 0 | |
| · outbound sales agent E2E (read-only) | same | 25 | 0 | 1 blocked | Live-audit findings reported separately below |
| · frontend browser verification | same | all | 0 | 0 | |
| **Staging closeout** (real Stripe test mode, Resend, self-hosted AI) | **42546367226** (final code) | **12/12** browser · **10/10** database | 0 | 0 | $99.00 first payment confirmed by the signed `invoice.paid`; handoff published 9 s later; Resend message 01a1bdf5-… delivered; AI drafts from `qwen3.6:35b-a3b-q4_K_M`, none sent |
| Rollback rehearsal | 42546329892 | success | — | — | On the final build |
| Restore drill (staging) | 42547053035 | **success**: 217 tables, 724,777 rows | 0 | — | Exported staging D1, replayed into a scratch database with foreign keys enforced; integrity and foreign-key checks clean; every table equals the export. (Its automatic run had been displaced in the concurrency queue by the closeout dispatch, not by a failure) |
| **Live Retell audit, receptionist** | deploy 42541946002 | **43/43** | 0 | — | Published v4, 14,046 characters, all 17 functions named, 24/7 behaviour, `wants_founder` routing, warm transfer |
| **Live Retell audit, sales agent** | deploy 42541946002 | **42/44** | 2 | — | (1) voicemail text has no AI disclosure (F7); (2) Self-Improvement Engine baseline not adopted (F8). Both need the Founder; outbound calling stays off |

Integration statuses on staging after the final deploy (closeout 42546367226): **verified**: ai, auth, bindings, database, github,
object storage, resend (52/52 delivered), resend webhooks (108 signed events), retell (inbound), stripe (test mode),
telephony, turnstile, voice. **configured, unverified**: monitoring (internal alerts verified; no external uptime monitor
is claimed). **not configured**: dns (no DNS provider access, by design). **failing**: retell_outbound (the two audit
findings above).

## F. Remediation record (this session)

Every defect below was found by verification (a staging run, D1's own analytics, or a certification workflow), fixed
at its root cause, covered by a regression test that fails without the fix, merged after green CI, and re-verified on
staging.

| # | Defect (how found) | Root cause | Fix | PR | Regression evidence |
|---|---|---|---|---|---|
| 1 | 13 Owner modules HTTP 500, "D1 DB is overloaded" (deploy 42514825859) | `/staff/sales` outbound counts: every open lead joined to every consent through a **correlated** `research_prospects` subquery, ~8.6 s of D1 time at staging scale | One uncorrelated consented-lead set (`CONSENTED_LEAD_IDS`), shared with the cold-call top-up: 8,616 → 57 ms locally | #234 | `[VOICE-005] outbound counts never use a correlated subquery over leads …` |
| 2 | Quote-based project reached maintenance Checkout unsigned (staging LG-01) | `maintenanceCheckoutBlock` enforced agreement-first only for package orders | An open launch-gate activation decides first, whatever the order kind (publishing was never exposed) | #234 | `[PAY-004] launch gate: a quote-based project cannot reach maintenance Checkout before the agreement is signed (found on staging)` |
| 3 | A declined first maintenance payment blocked the retry (staging LG-05/06) | Initial `invoice.payment_failed` treated as a renewal failure (`past_due` + seven-day clock), and `past_due` counts as "already subscribed" | Initial failure → `incomplete`, no clock, "subscription did not start" notice; renewals unchanged | #234 | launch-gate test step 3; staging LG-06 then passed |
| 4 | `/staff/sales` alone still 500 (deploy 42518473036; D1 analytics: 1,062,681 rows read in that minute vs ~25k idle) | The uncorrelated form still walked every unmerged lead (`idx_leads_merged`) and every research record with a lead; the Sales report made 2 lead passes plus 4 for an attribution report it no longer displays | Consent-first plan (`CROSS JOIN`, primary-key lookups); one lead pass for chart + funnel; attribution not computed for Sales | #235 | `[VOICE-005] outbound counts start from the consents: research records by phone, leads by primary key, no pass over all leads` |
| 5 | 12 modules 500 after Sales/Quotes; CI's evidence post also 500 (deploys 42514825859, 42521194657) | **Scheduling collision**: a merge starts CI and the deploy in the same minute; both take ~8 min, so CI's ~1,400-row evidence batch (~3 s of D1 work) landed inside the Owner-module sweep (19:31:12 vs 19:31:07; 20:46:18 vs 20:46:13) | The deploy waits (bounded, read-only token, no retries) for the commit's CI run before verifying the live site | #236 | deploy 42523964359: wait step, then **all 20 Owner modules load** |
| 6 | "Resend delivery webhooks: configured but unverified" while the Resend row counted 18 webhook-confirmed deliveries | Status ignored the signed events actually received | Verified by signed events for this environment (another environment's do not count) | #236 | `tests/integrations.test.ts` (both cases) |
| 7 | Real-ClamAV certification had never run a test (first dispatch 42522838789) | `npm ci` without a lockfile (the repo has none) | Install tooling as CI does | #236 | run 42523967236: scanner suite 29/29, real-ClamAV 5/5, 0 skipped |
| 8 | D1 refused requests during the browser journeys (deploy 42523964359; analytics run 42528453491) | `/staff/research` summary + census each scan ~48.5k wide rows (23.5 s + 15.1 s of D1 time in 15 min); the audit "event/record" filter walked ~122k rows per request (`LIKE` cannot use the index; `subject_id` unindexed) and the refund journey polls it every 5 s | Migration 0101: covering summary index (119 → 39 ms) and `idx_audit_subject_id`; the action prefix is also an index range (identical results) | #237 | `tests/d1-read-indexes.test.ts` |
| 9 | Journeys 19/20 refused by the launch gate; dispute email counted at the wrong address | Journeys predated the Founder's production-blocking gate (#226) and internal-mailbox routing (#229) | Journey 19's customer signs and pays the first maintenance invoice in Stripe test mode via the portal; journey 20 hands off that project; dispute notice counted at the internal mailbox. All prior assertions kept | #237, #238 | deploy 42541946002: journeys 19, 20 and the dispute E2E pass |
| 10 | Closeout spec gave no clue when a navigation timed out (LG-03, run 42514856681) | Click-and-wait with no diagnosis | Link asserted, followed by href; failures say where the browser was | #234 | closeout run 42520360929: 12/12 |
| 11 | **A custom-quote website could never launch** (staging journey 19, deploy 42530695208) | Quote acceptance never recorded a maintenance plan on the order (only package checkout does), so no activation could open; the launch status told staff to "record the plan from the approved quote" with no control to do it. The closeout fixture had masked this by inserting its activation directly | Owner-only, once-only, audited "Record maintenance plan" on the project (quote orders only); opens the activation if the site is already at review; gate unchanged | #238 | `[PAY-004] launch gate: a custom-quote project gets its maintenance plan recorded by the Owner, then the normal gate applies (found by staging journey 19)`; security matrix caught an anonymous 500 before merge |
| 12 | Refund E2E could not see its webhook (deploy 42530695208, D1 healthy) | Since the plain-English audit timeline (#230), the Stripe refund id sits in the entry's technical record under a collapsed "Details", which `innerText` skips | The check reads the entry's full text content | #238 | deploy 42541946002: refund E2E passes |
| 13 | Malware scanning E2E 6/9 (deploy 42537012650) although every verdict was correct | The operational **Node 1 scanner now serves staging** and claimed the run's files before the E2E's own scanner; the local-only orderings (queue offers all three; link works before the scan) stopped being facts | When another scanner sent a healthy heartbeat in the last 15 minutes, the E2E verifies that scanner with the existing remote-mode claims (all verdicts correct, link unusable, revoked when it predated the verdict, pending at the deadline fails) | #239 | deploy 42541946002: "Scanner node1-clamav is serving this platform" → **9/9** |
| 14 | `npm run e2e` on a developer machine failed the whole closeout spec (ENOENT) | Its `after()` hook wrote the run record even when every check was skipped | Records only when the suite ran | report PR | local run: 12 clean skips |

`STRIPE_PUBLISHABLE_KEY` was investigated and **not** added: hosted Checkout never uses it (§D).

## G. Genuine remaining blockers

**Technical: none.** Every engineering-controlled defect found during verification is fixed, regression-tested and
re-verified on staging (§F, 14 items). Two engineering notes, neither of which blocks launch:
- **Journey 25** (a live renewal failure on staging) needs a Stripe test-clock driver that does not exist yet. The seven-day policy is verified by automated tests (item 5.8). Building the driver is a follow-up, not a launch dependency.
- **The scanner certification image** carries a March 2026 signature set. Node 1, the operational scanner, updates its own signatures, and the staging heartbeat reports their age (the 72-hour rule).

**Founder-only** (the concise list is in [FOUNDER-ACTIONS-2026-11-09.md](FOUNDER-ACTIONS-2026-11-09.md)):

| Blocks production | Item(s) |
|---|---|
| Approve the invoice and receipt appearance | 6.1–6.3 (F1) |
| Approve customer-notification wording | 9.5 (F2) |
| Review the unexpected secret on the production Worker (provisioning run 42119243249) | — (F3) |
| DNS / domain, Always Use HTTPS | 9.10, 10.1 (F4) |
| Production backup destination and `PRODUCTION_URL` (production backups unverified until the first restore drill there) | 10.3 (F5) |
| Production deploy authorization → smoke test → open customer access | 10.18 (F6) |

| Does not block production | Item(s) |
|---|---|
| Outbound voicemail AI disclosure (a Retell setting; prompts untouched) | 9.8 (F7) |
| "Adopt live prompt" on Sales Optimization | 7.10, 9.8 (F8) |
| Counsel approval before outbound AI calling is enabled | 7.7, 8.1 (F9) |
| Visual approval of staff screens (desktop and phone) | 2.1, 10.7 (F10) |
| One controlled inbound call for voice quality and live calendar booking | 8.5, 8.6, 10.12 (F11) |
| AI draft tone | 4.3 (F12) |

## H. Production decision

**NOT READY — EXTERNAL APPROVALS OR CREDENTIALS.**

All mandatory staging verification passes on the final code (deploy 42541946002: success; closeout 42546367226:
success), and no technical blocker remains. Production waits only for the Founder items marked "blocks production"
(F1–F5) and then the Founder's explicit authorization (F6). Production has not been deployed, and no production deploy
will be started without that authorization. When it is given, the release runs through `deploy-production.yml` (a
tagged release, the Owner's MFA-protected approval, migrations 0001–0101 applied on first deploy, `AI_BUILD_AUTOMATION=off`).
It is followed by the production smoke test, and customer access opens only on the Founder's decision.
