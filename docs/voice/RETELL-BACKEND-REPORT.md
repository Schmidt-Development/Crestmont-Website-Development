# Retell backend — requirements, inventory and acceptance (2026-10-28)

Branch `claude/crestmont-retell-backend`, from `main` @ `85819b8`. Scope: Retell backend only. Nothing was activated, purchased, called, emailed or deployed.

## 1. What Crestmont actually needs (Phase 2 findings)

| Context | Finding | Basis |
|---|---|---|
| **A. Crestmont's own receptionist** | Confirmed requirement (VOICE-001..006). Sales enquiries, published pricing, lead capture, callbacks, support intake without disclosure, escalation, consent-gated recording. | `requirements/inventory.ts` (§51–§53), `src/services/voice.ts` |
| Consultation scheduling | **No booking system existed.** Built one, off by default (`consultations`), with staff confirmation because no calendar is connected. | No appointment table in any migration; `onboarding.ts` only asks customers about *their* booking needs |
| Project status / customer lookup by phone | **Deliberately not built.** The platform's guardrails forbid it (VOICE_GUARDRAILS 6–7): knowing a name, email and phone is not identity verification, and a voice transcript cannot carry MFA. | `VOICE_GUARDRAILS`, `route_support` design |
| **B. Outbound** | Built as a foundation, disabled by default, limited to follow-ups the person asked for. Cold or "qualified lead" calling is **not** implemented: it needs the Founder's decision and legal review (TCPA/state rules). | Directive §B; no consent model existed before |
| **C. Customer-facing AI Receptionist product** | **Not a current product.** It is absent from `APPROVED_SERVICES`, the service pages and the catalog; the legal copy says only "if we offer an automated phone receptionist". Tenant-isolated customer receptionists were therefore **not built**; doing so would invent scope. | `src/domain/catalog.ts`, `src/content/services.ts`, `src/content/legal.ts` |

What offering (C) would require, for the Founder's decision: a catalog service and price (CAT-007 approval); one Retell workspace **per customer** (Retell isolates keys, numbers, webhooks and billing per workspace); a `voice_tenants` table keyed by organization with its own encrypted Retell key, numbers, hours, transfer and scheduling adapter; tenant resolution in the inbound webhook from the dialled number; tenant id in `metadata` (verified on every event like `crestmont_env` is today); per-tenant analytics and cost attribution to the customer's project; and customer-portal settings pages. The pieces built here (number binding, metadata stamping, settings validation, scheduling and outbound services) are designed to be lifted into that model.

## 2. Inventory (Phase 3)

| Component | Existing before this branch | Missing | Done in this branch |
|---|---|---|---|
| Retell webhook receiver | `POST /api/webhooks/retell` (call_started/ended/analyzed) | transfer events, call detail fields | Transfer events with documented dedupe key; `to_number`, `direction`, `duration_ms`, `disconnection_reason` stored |
| Signature verification | Correct, fail-closed, tested | — | Applied to the new inbound route; fuzzed |
| Call event processing | Idempotent per call; consent-gated | out-of-order coverage, redaction | Tested out-of-order; card/SSN redaction |
| Inbound call routing | None (no inbound webhook) | number binding, env stamp, variables, emergency stop | `POST /api/webhooks/retell/inbound` |
| Outbound call initiation | None | everything | Queue, consent, DNC, windows, caps, approval, Retell client, results, job |
| CRM integration | Leads (`ai_receptionist`), tasks, activities | consultation and outbound links | Bookings/callbacks write lead notes and tasks |
| Scheduling tools | None | everything | 5 functions + Owner confirm/cancel |
| Customer support tools | `route_support` (no disclosure) | — | Unchanged by design |
| Knowledge retrieval | `get_published_pricing` | hours | `get_business_hours` |
| Human transfers | Only "escalate" | availability, failure recovery | `check_transfer_availability`, `{{transfer_number}}`, transfer_cancelled → task |
| Call analytics | `/staff/voice` volume, outcomes, conversion, cost | direction, answered/missed, duration, bookings, transfers | `voiceAnalytics()` on `/staff/voice/operations` |
| Customer notifications | Mail pipeline, in-app notifications | consultation email | `consultation` template (4 events) |
| Tenant isolation | Single Crestmont context | — (no tenant product) | Number binding + environment stamp; tenant model documented (§1) |
| Owner controls | Prompt versions, test events | hours, transfer, scheduling, outbound, DNC, erasure | `/staff/voice/operations` (Owner only) |
| Usage and cost tracking | Provider cost per call, never invented | outbound cost | Outbound cost per request; retries never double-count |

## 3. Retell contract verification (Phase 4)

Checked against docs.retellai.com on 2026-10-28; sources in `RETELL-INTEGRATION.md` §9. Two points could not be confirmed and are isolated: create-phone-call 402/422 meanings (treated as non-retryable failures that go to a person) and whether every plan's `transfer_*` payload carries `start_timestamp` (dedupe falls back to event + destination). Retell publishes no API rate limit, so outbound volume is capped by the platform.

## 4. Founder decisions required

1. VOICE-001: approve Retell (separate workspace) and a monthly budget; VOICE-002: buy the number.
2. Business hours, time zone and closed dates for the receptionist.
3. Live transfer: whether, and to which business line (no number has been assumed).
4. Phone scheduling: on/off, length, notice; who confirms bookings. Connect a calendar later (adapter seam exists, `CalendarAdapter`).
5. Outbound: whether to enable at all; purposes are limited to callback, consultation reminder, support follow-up. Any cold or lead outreach needs legal review first.
6. Customer-facing AI Receptionist product (§1 C): offer it or not.
7. Phone disclosure of project status / account details: stays **off** unless the Founder approves a real verification method (e.g. a one-time code sent to the account email during the call).
8. Proposed requirement IDs to add to the inventory (not added: the inventory is the Founder-approved denominator): `VOICE-007` phone scheduling, `VOICE-008` outbound calling with consent/DNC, `VOICE-009` live transfer and hours. New tests are tagged with existing VOICE/SEC ids meanwhile.
9. Optional guardrail amendment (immutable prefix, so a deliberate change): add "Never ask for or accept payment card or bank details." It is already in the default instructions and enforced by redaction.

## 5. Acceptance (Phase 18)

| Component | Status | Evidence |
|---|---|---|
| Retell adapter | Complete (simulated) | `src/adapters/retell.ts`; tests in `voice-retell-backend.test.ts`, `integrations.test.ts` |
| Webhook security | Complete | Signature tests (3 routes), `security-fuzz` signed hostile JSON, route matrix |
| Inbound workflows | Complete (simulated) | inbound webhook, env mismatch, out-of-order, missed call tests |
| Outbound workflows | Complete, disabled by default | gate, consent, DNC, quiet hours, caps, retries, results tests |
| CRM integration | Complete | lead/task assertions in booking and callback tests |
| Scheduling functions | Complete; no calendar connected | availability, booking, verification, reschedule/cancel tests |
| Support functions | Complete (pre-existing, unchanged) | `route_support` non-disclosure tests |
| Human transfers | Complete; no number configured | availability + transfer_cancelled recovery tests |
| Notifications | Complete via existing outbox/Resend + in-app | `email_deliveries` assertions (dev outbox; nothing sent) |
| Call analytics | Complete | analytics test; Owner page render |
| Tenant isolation | Partial — Crestmont-only by design; customer tenants not a product | number binding + environment stamp tests; §1 |
| Security and privacy | Complete | redaction, erasure, secret non-disclosure, Owner-only access, review regressions (§6) |
| Retell configuration guide | Complete | `RETELL-CONNECTION-GUIDE.md`, `RETELL-AGENT-SPEC.md` |

"Simulated" means signed test payloads and a fake Retell API; it is not live verification.

## 6. Independent review

A separate review of the diff (by an agent that had not seen the work being written) found nine confirmed defects, all fixed with regression tests: consent recordable for another person's number; outbound requests able to stick in `dialing` (webhook-first race, lost results); a timeout retry that could have dialled twice under a new idempotency key; calling windows that could never be met; Hawaii/Alaska missing from quiet-hours checks and non-US numbers accepted; unredacted `call_analyzed` summaries; caller erasure leaving the number in CRM notes, lead text and notifications; booking responses revealing whether another number had a booking; and stored errors / stale read-only answers being replayed. Also fixed: non-atomic reschedule, duplicate slots on the spring-forward day, string test flag, injected clock for retries, outbound cost from `call_analyzed`. Remaining known limitation: two simultaneous bookings for the same caller's number on different calls can both succeed (each slot is still unique); staff see both on the operations page.
