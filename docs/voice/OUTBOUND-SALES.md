# Outbound AI sales representative (Retell) — architecture, compliance gate and operations

**Status (2026-10-31): built and tested against simulated, signed Retell payloads and a fake Retell API. Not deployed,
not activated, not live.** No Retell sales agent, phone number or call exists. Nothing in this branch can dial anyone:
three independent switches are off and a fourth (the Founder + counsel compliance approval) does not exist.
Configuration values for Retell are in [`OUTBOUND-SALES-CONFIG.md`](OUTBOUND-SALES-CONFIG.md).

> **Founder decision D-14 still applies.** AI-voice outbound sales calls need a counsel-approved consent design before
> any call is placed (`docs/FOUNDER-DECISION-REGISTER.md`, MSA Sched. C.7, `docs/research/COMPLIANCE-GATE.md`). This
> branch implements the machinery *and* the gate that keeps it closed. It does not change the decision.

## 1. Audit (what existed, what was reused)

| Area | Found | Reused / added |
|---|---|---|
| AI Research Agent + lead DB | PR #48 (open, stacked base of this branch): `research_prospects`, website classes, evidenced findings, `outboundEligibility()` gate (closed), promotion via CRM intake | Reused: findings → spoken context; `outboundEligibility()` is called inside the sales gate so the two never disagree; `applySuppressions()` on do-not-call |
| CRM + duplicate prevention | PR #50 (merged): `contact-identity.ts#intake`, identity reviews, tombstones, outreach ledger | Reused: contact verification goes through `intake()`; number lease through `reservePhone()`; suppression through `suppressionFor()` |
| Pipeline | `leads.stage` + `LEAD_TRANSITIONS`, `crm_activities` (notes/tasks) | Reused; agent stage moves are forward-only and validated by `transitionLead()`; `converted` stays webhook-only |
| Customers / Stripe | `/checkout/<package>` (sign-in, verified email, agreement acceptance, Stripe Checkout, test-mode-only adapter), Stripe webhook is the only payment truth | Reused unchanged: the agent emails a link into this flow; payment status reads webhook-written `invoices`/`payments` |
| Resend | `mailer.ts` templates, dev outbox, staging allowlist, suppressions | Added one template, `sales_info` (category **marketing**, unsubscribe link + postal address); quote and consultation emails reuse existing templates |
| Scheduling | `voice-scheduling.ts` (consultations, off by default, staff confirmation) | Reused for consultations; staff callbacks are CRM tasks |
| Retell integration | `adapters/retell.ts` (signature, create-phone-call client with idempotency), `/api/webhooks/retell` (+ `/functions`, `/inbound`) for the receptionist | Reused: signature verification, create-phone-call client, the agent webhook URL (SHARED). New URL for the sales functions |
| Inbound receptionist | 14 functions on `/api/webhooks/retell/functions` (merged #32); PR #17 superseded | Not modified. `get_packages_pricing` reuses its `publishedPricing()` logic |
| Call history / outcomes | `calls`, `voice_events`, sales optimizer (`so_call_facts`, attribution) | Sales calls create normal `calls` rows (lead linked); final outcome in `sales_calls` |
| DNC / consent | `voice_dnc`, `voice_call_consents` (3 follow-up purposes only), outreach ledger | Reused `voice_dnc` (shared). Added separate `sales_call_consents` (prior express **written** consent, AI disclosure required) and `sales_dnc_scrubs` |

## 2. Components

| Layer | File |
|---|---|
| Schema (additive, `0060`) | `migrations/0060_outbound_sales.sql` |
| Pure rules: compliance gate, calling window, research → spoken context, dynamic variables, final outcome | `src/domain/sales-eligibility.ts` |
| Orchestration: settings, approvals, consent, DNC scrubs, queue, dialling, webhook outcome, do-not-call everywhere | `src/services/sales-outbound.ts` |
| Custom functions (8) and public link handlers | `src/services/sales-functions.ts` |
| Routes: function endpoint, `/buy/:token`, `/sales/unsubscribe/:token`, Owner page `/staff/sales-outbound` | `src/routes/sales-outbound.ts` |
| Webhook hook (after the receptionist handler, failure-isolated) | `src/routes/hooks.ts` |
| Scheduled job `sales_outbound` (every 15 min, no-op while disabled) | `src/app/scheduled.ts` |
| Tests (14) | `tests/outbound-sales.test.ts` |

## 3. Call orchestration

1. **Select** — staff queue a CRM lead on `/staff/sales-outbound` (or the agent agrees an AI follow-up). The gate runs
   immediately; a blocked lead is stored as `blocked` with its reasons (audit `sales_outbound.blocked`).
2. **Check** — the job re-runs the full gate for each due row right before dialling (consent can be revoked, numbers
   opt out, scrubs age).
3. **Context** — research facts are mapped to speakable sentences (`spokenContext`): only findings with confidence ≥ 0.7,
   evidence ≤ 45 days old, identity confidence ≥ 0.6; otherwise `website_status = "unknown"` and a neutral opening.
4. **Initiate** — `POST https://api.retellai.com/v2/create-phone-call` (§5) with `override_agent_id` (the dedicated sales
   agent), `honor_internal_dnc: true`, `idempotency_key = crestmont_<scall>_a<attempt>`.
5. **Variables** — `retell_llm_dynamic_variables` (all strings, §5). Internal scores, sources, licences and raw evidence
   are never sent.
6. **Associate** — `metadata.crestmont_sales_call_id` (signed back to us on every webhook and function call) binds the
   call to exactly one `sales_calls` row and CRM lead; a `calls` row is created with `lead_id`.
7. **Status** — `call_started` → `in_progress`.
8. **Outcome** — `call_ended` resolves the final outcome once (§6); `call_analyzed` only fills a missing guess and cost.
9. **Follow-up** — outcome effects on the CRM (forward-only stage, tasks, lost reason) and retries for no-answer.
10. **No duplicates** — unique open series per lead and per number; number lease in the outreach ledger (shared with the
    receptionist's follow-up calls); Retell idempotency key; claim-before-dial compare-and-swap; stale dials (no result
    in 3 h) go to a person and are never re-dialled automatically.

Capacity per run = min(`max_concurrent` − active, `max_dials_per_run`, `max_dials_per_day` − today). Retell documents 20
concurrent calls for a pay-as-you-go workspace, **shared with the receptionist**, so the setting is capped at 20 and
defaults to 1. Raising capacity is a settings change after a verified staging run, not a code change.

## 4. Compliance gate (separate from the sales conversation)

`salesCallEligibility()` — every condition must hold; any unknown blocks:

| # | Condition | Why |
|---|---|---|
| 1 | Active Founder + counsel approval (`sales_compliance_approvals`, counsel reference required) | D-14; MSA Sched. C.7 |
| 2 | Documented **prior express written consent** for AI/artificial-voice sales calls to that exact number, with the exact disclosure text and a signed-record reference; line type recorded | FCC 24-17 (AI voices are "artificial or prerecorded voice" under the TCPA); 47 CFR 64.1200(a)(2)–(3), (f)(9) |
| 3 | US (+1) number, not on `voice_dnc`, not suppressed/erased in the CRM | Internal DNC; opt-outs honoured |
| 4 | National DNC Registry check ≤ 31 days old with result `clear`; any state-registry hit blocks | TSR 31-day scrub; state DNC lists |
| 5 | Known recipient state and time zone (multi-zone states are never guessed) | Recipient-local calling hours |
| 6 | Number not shared with another business record | Wrong-party risk |
| 7 | Lead open (`new`…`negotiation`), not merged | CRM integrity |
| 8 | Attempts below `max_attempts_per_lead` (default 2, ≥ 48 h apart) | Protection against repeated unwanted calls |

**Calling window** (`withinSalesWindow`): weekdays 10:00–19:00 recipient-local, no US federal holidays, Maine 10:00–17:00.
That is narrower than the federal 8 a.m.–9 p.m. rule and the stricter state rules found in research (8 p.m. end in
FL/OK/MD/WA; no Sunday/holiday sales calls in AL/LA/MS/UT; Texas Sunday noon). **It is a planning default for counsel to
confirm, not legal advice**, and state holiday calendars beyond federal ones are not encoded.

**Disclosures and opt-out** belong in the agent prompt (written last by the Founder) but are enforced where code can:
`record_do_not_call` and Retell's `user_requested_dnc` apply DNC everywhere at once; email opt-out via the footer link;
the sales email template is commercial and always carries the unsubscribe link and postal address (CAN-SPAM).
**Caller ID:** the `from_number` must be a Retell-owned or imported number Crestmont controls; register it for
STIR/SHAKEN and branded caller ID with the carrier before use. **Recording:** Retell records by default; set the agent's
data storage to the most restrictive option until the privacy review (as for the receptionist), and the prompt must
disclose recording at the start (all-party-consent states).
**Audit:** every queue, block, dial, function side-effect, outcome, approval, consent and scrub is in `audit_logs`; the
FTC TSR's call detail record fields (numbers, time, duration, disposition) are in `calls` + `sales_calls`.

Questions for counsel (unchanged from `docs/research/COMPLIANCE-GATE.md`, plus): the form and wording of the written AI
consent; whether B2B landlines change anything for Crestmont's targets; state AI-disclosure and mini-TCPA registration
(e.g. Texas SB 140); state holiday calendars; whether to subscribe to the National DNC Registry (paid data service:
Founder approval under the $0-fee rule).

## 5. Retell contract (verified against docs.retellai.com, 2026-10-31)

`POST https://api.retellai.com/v2/create-phone-call`, `Authorization: Bearer <RETELL_OUTBOUND_API_KEY>`, `201` → call object.
Body fields used: `from_number`, `to_number` (E.164; US only from Retell numbers), `override_agent_id`, `metadata`,
`retell_llm_dynamic_variables` (string values only), `idempotency_key` (5–255 `[A-Za-z0-9_-]`, no second call for one
hour), `honor_internal_dnc` (400 when the contact is DNC). Documented errors 400/401/402/422/429/500; 429/5xx are retried
with the same key. Custom functions: body `{name, call, args}` with "Payload: args only" off, `X-Retell-Signature`,
timeout 1000–600000 ms (default 120000), `max_retry` 0–5 (default 0), execution mode "Wait for completion" / "Run in
background", "Talk While Waiting" and "Play typing sound" in wait mode, query parameters may use dynamic variables and
are never filled by the LLM, response ≤ 15,000 characters.

## 6. Final outcome (Function 9 is a webhook, not a custom function)

A custom function only runs if the model remembers to call it, cannot run on calls that never connect (no answer,
voicemail, failed dial), and could be skipped when the caller hangs up. Retell's `call_ended` webhook arrives for every
call (Retell retries up to 3 times), is signed, and carries `disconnection_reason`. So the outcome is resolved
server-side in `applySalesCallEvent()` from the most reliable source available, written exactly once (`finalized_at`):

platform facts (DNC recorded, Stripe-verified payment, checkout link sent, consultation booked) → telephony
(`disconnection_reason`) → the agent's disposition (`update_outbound_lead.sales_outcome`) → a booked follow-up →
Retell post-call analysis (`custom_analysis_data.sales_outcome`, an LLM guess) → `unclassified` + a CRM task for a person.
No-answer/voicemail before the attempt limit re-queues the series (new attempt, new idempotency key, old call's late
events ignored).

## 7. Activation checklist (all Founder/manual; none done)

1. Counsel approves the consent design → Founder records it on `/staff/sales-outbound` (step-up MFA).
2. Consent capture exists outside this branch (a signed web form) and consents are recorded per number with evidence.
3. National DNC subscription (paid) and scrubs recorded (≤ 31 days).
4. Retell: separate sales agent + number, functions and webhook per `OUTBOUND-SALES-CONFIG.md`, prompt written last.
5. Staging: merge #48 then this PR (deploys staging only), set `RETELL_OUTBOUND_API_KEY`, Stripe test keys, Resend; test with a
   consenting internal number on the staging allowlist.
6. Only then: `RETELL_SALES_OUTBOUND=on` on staging, Owner switch on, max concurrency 1.
