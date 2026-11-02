# Retell AI integration (VOICE-003..006)

**Status:** Platform side built and tested with simulated, signed Retell payloads (`tests/integrations.test.ts`, `tests/voice-retell-backend.test.ts`). **No Retell workspace, agent or phone number exists for Crestmont.** Nothing has been purchased, no real call has been made, and nothing here is evidence of live Retell verification. VOICE-001 (provider decision) and VOICE-002 (number) stay with the Founder (BLK-009). Follow `PROVIDER-EVALUATION.md` §6: use a **new, separate Crestmont workspace**, and never touch the other business's receptionist.

Inbound agent: the eight named functions and their exact Retell settings are in `RETELL-INBOUND-FUNCTION-REGISTER.md`.

Related: `RETELL-AGENT-SPEC.md` (what to enter in Retell), `RETELL-CONNECTION-GUIDE.md` (Founder checklist, in order), `RETELL-BACKEND-REPORT.md` (inventory and acceptance).

## 1. How it fits

Retell calls three endpoints. Each verifies `X-Retell-Signature`, translates Retell's format, and hands the result to the provider-agnostic voice service (`src/services/voice.ts#handleVoiceEvent`). Business rules live in the services, never in the prompt alone.

| Endpoint | Retell feature | Where it is configured in Retell | Code |
|---|---|---|---|
| `POST /api/webhooks/retell` | Agent webhook (call + transfer events) | Agent → Webhook URL | `translateRetellEvent` (`src/adapters/retell.ts`) |
| `POST /api/webhooks/retell/functions` | Custom functions | Each custom function's URL | `translateRetellFunction` |
| `POST /api/webhooks/retell/inbound` | Inbound call webhook | Phone number → Inbound Webhook URL | `translateRetellInbound` |

All three are exempt from the staging preview password gate (`src/app/preview-gate.ts`, `/api/webhooks/*`), so Retell can reach staging. Calls are stored with `provider = 'retell'` and Retell's `call_id`. Retell `web_call`s (dashboard / web SDK test calls), or calls whose `metadata.crestmont_test` is `true`, are flagged `is_test` and kept out of metrics.

| Service | Responsibility |
|---|---|
| `src/services/voice.ts` | Call lifecycle, idempotency per call, all agent functions, guardrails, consent-gated transcripts |
| `src/services/voice-settings.ts` | Hours, holidays, time zone, transfer, inbound number binding, scheduling and outbound switches (table `voice_settings`) |
| `src/services/voice-scheduling.ts` | Consultation slots and bookings (table `consultations`) |
| `src/services/voice-outbound.ts` | Outbound queue, consent, do-not-call, calling windows, caps, dialling, results |
| `src/services/voice-ops.ts` | Owner analytics and caller-data erasure |
| `src/routes/voice-ops.ts` | Owner page `/staff/voice/operations` (Owner role only) |

## 2. Signature verification (fail closed)

As documented in [Retell: Secure the webhook](https://docs.retellai.com/features/secure-webhook.md), re-checked 2026-10-28:

- Header `X-Retell-Signature: v=<unix ms>,d=<hex>`; `d = HMAC-SHA256(key = Retell API key, message = rawBody + v)` (body first, timestamp appended with no separator).
- Reject when `v` is more than **5 minutes** from now. Constant-time compare. Verify the **raw** body.
- Only an API key **with the webhook badge** can verify. Store it as the secret `RETELL_API_KEY` (per environment).
- Custom-function and inbound-webhook requests carry the same header.

When `RETELL_API_KEY` is not set, all three endpoints answer `401` for every request. Retell's published outbound IP (`100.20.5.228`) is optional defence in depth and is not relied on.

## 3. Environment separation (production-safe)

- Each environment has its own D1 database, so `voice_settings`, calls, consultations and the outbound queue can never be shared between staging and production.
- Secrets are per environment (`wrangler secret put RETELL_API_KEY --env staging|production`). The key never appears in source, logs, browser pages, function responses, Retell request bodies or audit entries (tested).
- The inbound webhook stamps every call with `metadata.crestmont_env = <ENVIRONMENT>`, and outbound creation does the same. **A call stamped for a different environment is refused before any business logic runs**: events are acknowledged and ignored, functions answer `409` with a safe spoken message, and an audit entry `voice.environment_mismatch` is written. Unstamped calls (dashboard web calls) are allowed.
- Once the Owner lists this environment's receptionist numbers (`inbound.numbers`), a call to any other number is **rejected** by the inbound webhook. A number from another business or workspace can never reach Crestmont's data.

## 4. Event mapping

Retell webhook body: `{ "event": ..., "call": { ... } }` ([webhook overview](https://docs.retellai.com/features/webhook-overview.md)). Retell expects a 2xx within 10 s and retries up to 3 times. Events are sent in order but non-blocking (`call_ended` can arrive without `call_started`). Every step is idempotent.

| Retell event | Platform action |
|---|---|
| `call_started` | Envelope `call_started`, idempotent per call id. Consent from `record_consent` if already called. |
| `call_ended` | Envelope `call_ended`. **Outcome** derived from what the voice service recorded: `error` if `call_status = error` or `disconnection_reason` starts with `error`; then escalate → `escalated`, route_support → `support_routed`, create_lead or book_consultation → `lead_captured`, request_callback → `callback_requested`, any conversation → `info_only`, nothing → `abandoned`. Stores `to_number`, `direction`, `duration_ms`, `disconnection_reason`. **Cost:** `call_cost.combined_cost` ("in cents") stored as micro-USD (× 10,000); absent → `NULL`, shown as "Unknown". Transcript and recording are **discarded unless consent was recorded**, and card numbers / SSNs are redacted before storage. A missed inbound call (`abandoned`, real caller) raises an Owner notification; nothing is dialled automatically. For an outbound call the result is applied to its queue entry (§7). |
| `call_analyzed` | Sets `calls.summary` from `call_analysis.call_summary` **only with consent** and when empty; fills `cost_microusd` only if still unknown (never overwrites, so retries cannot double-count). |
| `transfer_started`, `transfer_bridged`, `transfer_cancelled`, `transfer_ended` | Recorded once per `event + call_id + start_timestamp + destination` (Retell's documented dedupe key). `transfer_cancelled` (the transfer failed) creates an urgent callback task on the call's lead and an Owner notification. These events are **not** in Retell's default subscription: select them on the agent. |
| anything else (`transcript_updated`, chat events) | `200 {"ok":true,"ignored":...}`. |

## 5. Inbound call webhook

Configured per phone number ([inbound call webhook](https://docs.retellai.com/features/inbound-call-webhook.md)). Retell sends `{ "event": "call_inbound", "call_inbound": { call_id, from_number, to_number, agent_id? } }` and waits up to 10 s (3 attempts; if all fail it connects the number's own inbound agent). The platform answers:

```json
{ "call_inbound": {
    "dynamic_variables": { "crestmont_env": "staging", "business_open_now": "true", "business_hours_configured": "true",
      "business_hours": "Monday: 9 AM–5 PM; ... (America/Detroit).", "transfer_available": "false", "transfer_number": "",
      "scheduling_available": "false" },
    "metadata": { "crestmont_env": "staging" } } }
```

- All values are strings (Retell requirement). `transfer_number` is non-empty **only** when the Owner enabled transfer with an approved number **and** the business is open now.
- `override_agent_id` is added when `inbound.agent_id` is set.
- `{ "call_inbound": { "reject": true } }` when the receptionist is paused (`inbound.mode = reject`, the emergency stop) or the dialled number is not bound to this environment. Rejected calls create no call record and are audited (`voice.inbound_rejected`).

## 6. Custom functions

Retell POSTs `{ "name", "call", "args" }`. Keep the **default payload** (not "args only"): the adapter needs `name` and `call.call_id`. Retell sends no invocation id, so the idempotency key is `retell-` + SHA-256(name + args); an identical retry returns the stored result and does not act twice. The response body is the service's `result` object, which Retell stringifies for the LLM. Validation errors return 422 with a safe spoken message. Any function name not listed below is rejected (422).

Configure every function: method **POST**, URL `https://<host>/api/webhooks/retell/functions`, **Timeout 10000 ms** (Retell's default is 120000 ms; the platform answers well within 10 s and a long wait is a poor caller experience), "Payload: args only" **off**, **max retries 1** (idempotent by design; Retell allows 0–5), execution mode *Wait for completion*. The schemas below mirror `fnSchemas` in `src/services/voice.ts`, which is the server-side authority: a field the model invents is ignored or rejected there.

```json
{ "name": "get_published_pricing", "description": "Get Crestmont's published package and maintenance prices and payment rules. Quote only these figures.",
  "parameters": { "type": "object", "properties": {} } }

{ "name": "record_consent", "description": "Record whether the caller agreed to the call being recorded and transcribed. Call once, right after asking.",
  "parameters": { "type": "object", "required": ["consent"], "properties": { "consent": { "type": "boolean", "description": "true only if the caller clearly agreed" } } } }

{ "name": "create_lead", "description": "Create a new-project enquiry once you have the caller's name, a phone or email, the package of interest and their requirements.",
  "parameters": { "type": "object", "required": ["name", "interest", "requirements"], "properties": {
    "name": { "type": "string", "description": "Caller's full name" },
    "email": { "type": "string", "description": "Caller's email, if given" },
    "phone": { "type": "string", "description": "Caller's phone number, if given" },
    "company": { "type": "string", "description": "Business name, if given" },
    "interest": { "type": "string", "enum": ["starter", "business", "premium", "custom", "maintenance", "other"] },
    "requirements": { "type": "string", "description": "What the caller needs, in their words (at least a sentence)" } } } }

{ "name": "request_callback", "description": "Ask a Crestmont team member to call the caller back. Use when the caller wants a person and no live transfer is available.",
  "parameters": { "type": "object", "required": ["name", "phone", "reason"], "properties": {
    "name": { "type": "string" }, "phone": { "type": "string" }, "reason": { "type": "string" },
    "preferred_time": { "type": "string", "description": "Caller's preferred time, if any" },
    "wants_founder": { "type": "boolean", "description": "true ONLY if the caller explicitly asked to speak with the Founder/owner. Omit otherwise (AI Follow-Up calendar)." } } } }

{ "name": "route_support", "description": "Pass an existing customer's support issue to the support team. Never confirm whether an account exists.",
  "parameters": { "type": "object", "required": ["name", "email", "phone", "summary"], "properties": {
    "name": { "type": "string" }, "email": { "type": "string" }, "phone": { "type": "string" }, "summary": { "type": "string" } } } }

{ "name": "escalate", "description": "Escalate anything complex, sensitive, urgent or outside your rules (refunds, contracts, project status, complaints, outages) to a person.",
  "parameters": { "type": "object", "required": ["reason"], "properties": {
    "reason": { "type": "string" }, "name": { "type": "string" }, "phone": { "type": "string" },
    "wants_founder": { "type": "boolean", "description": "true ONLY if the caller explicitly asked to speak with the Founder/owner. Omit otherwise (AI Follow-Up calendar)." } } } }

{ "name": "get_business_hours", "description": "Get Crestmont's published business hours and whether the business is open right now.",
  "parameters": { "type": "object", "properties": {} } }

{ "name": "check_transfer_availability", "description": "Check whether a person can take the call live right now. Only transfer when transfer_available is true.",
  "parameters": { "type": "object", "properties": { "department": { "type": "string", "enum": ["sales", "support", "urgent"] } } } }

{ "name": "check_consultation_availability", "description": "List open consultation times. Offer only the returned labels.",
  "parameters": { "type": "object", "properties": { "preferred_date": { "type": "string", "description": "YYYY-MM-DD, if the caller named a day" } } } }

{ "name": "book_consultation", "description": "Book one of the times returned by check_consultation_availability. Then read the booking reference back letter by letter.",
  "parameters": { "type": "object", "required": ["name", "phone", "start_time", "topic"], "properties": {
    "name": { "type": "string" }, "phone": { "type": "string" }, "email": { "type": "string", "description": "Only if the caller gave one" },
    "start_time": { "type": "string", "description": "The exact start_time value of the chosen slot" },
    "topic": { "type": "string", "description": "What the caller wants to discuss" },
    "reminder_call_ok": { "type": "boolean", "description": "true only if the caller explicitly agreed to a reminder call" },
    "wants_founder": { "type": "boolean", "description": "true ONLY if the caller explicitly asked to speak with the Founder/owner. Omit otherwise (AI Follow-Up calendar)." } } } }

{ "name": "lookup_consultation", "description": "Check an existing consultation. Needs the booking reference and the phone number used to book.",
  "parameters": { "type": "object", "required": ["confirmation_code", "phone"], "properties": { "confirmation_code": { "type": "string" }, "phone": { "type": "string" } } } }

{ "name": "reschedule_consultation", "description": "Move an existing consultation to a time returned by check_consultation_availability.",
  "parameters": { "type": "object", "required": ["confirmation_code", "phone", "new_start_time"], "properties": {
    "confirmation_code": { "type": "string" }, "phone": { "type": "string" }, "new_start_time": { "type": "string" } } } }

{ "name": "cancel_consultation", "description": "Cancel an existing consultation.",
  "parameters": { "type": "object", "required": ["confirmation_code", "phone"], "properties": {
    "confirmation_code": { "type": "string" }, "phone": { "type": "string" }, "reason": { "type": "string" } } } }

{ "name": "record_opt_out", "description": "Call when the person asks not to be called again.",
  "parameters": { "type": "object", "properties": { "phone": { "type": "string", "description": "Only if different from the number they are calling from" } } } }
```

Guarantees enforced in code (tested), whatever the model sends:

- **Pricing:** catalog figures only; maintenance entitlements are never returned.
- **Support:** a ticket is opened only for a verified account email **and** matching phone; the spoken answer is identical either way (no account enumeration, no customer data returned).
- **Bookings:** read/change needs reference **and** phone; every failure returns the same answer; after 3 failures on one call further attempts are refused. Slots are only those the rules offer; the database prevents two active bookings at one start time.
- **Opt-out:** `record_opt_out` (and Retell's `user_requested_dnc`) adds the number to `voice_dnc`, revokes consents and cancels pending calls.
- **Redaction:** card numbers (Luhn-valid) and SSNs are removed from every string argument and from consented transcripts and summaries (including `call_analyzed`) before storage.
- **Replays:** write functions replay their stored result on an identical retry; a stored *failure* is re-run instead. Read-only functions (pricing, hours, transfer and slot availability) are never replayed, so a repeated question gets a current answer.
- **Consent:** callback and reminder consent are recorded only for the caller's own number. An existing booking is reported back only for the caller's own number.
- **Not available by phone (by policy):** refunds, agreements, pricing changes, project status, invoices, delivery dates, customer lookup. See `RETELL-BACKEND-REPORT.md` §4 for why and what a Founder decision would require.

**Consent (VOICE-006):** Retell has no field carrying spoken consent. The agent asks and calls `record_consent`; the answer is stored (`retell_call_consents`), grant-only. Without it transcripts, recordings and summaries are discarded. Also set the agent's **Data Storage Setting** to the most restrictive option the plan allows (`basic_attributes_only`) until the Founder's privacy review (PROVIDER-EVALUATION §6, condition 4); with that setting Retell still sends the transcript in webhooks but deletes its own copy.

## 7. Outbound calls (off by default)

Nothing dials unless **both** `RETELL_OUTBOUND=on` is set in the environment **and** the Owner enables outbound in `/staff/voice/operations` (which requires an approved caller number that is also a bound receptionist number, and an agent id). Then, for every request, immediately before dialling:

1. Staff approval (`/staff/voice/operations`).
2. An unrevoked consent for that exact purpose (`callback`, `consultation_reminder`, `support_followup`; there is no marketing or cold-call purpose). A caller's `request_callback` counts as callback consent **only for the number they are calling from**; a number the caller merely names becomes a task for a person. Staff can record consent with evidence.
3. Not on the do-not-call list.
4. Within the calling window **in the recipient's local time** (default 09:00–20:00, bounded to 08:00–21:00, at least 8 hours long). With no known recipient zone the window must hold in every US zone at once, Eastern through Alaska and Hawaii. Outbound is limited to +1 numbers.
5. Per-number caps (default 1/day, 3/week).

The scheduled job `voice_outbound` (every 15 minutes) dials up to 5 due requests via [create-phone-call](https://docs.retellai.com/api-references/create-phone-call.md): `Authorization: Bearer`, `override_agent_id`, `honor_internal_dnc: true`, `idempotency_key = crestmont_<request>_a<attempt>` (Retell guarantees no duplicate call for a repeated key within an hour), `metadata.crestmont_env`, and only `contact_name` / `call_purpose` as dynamic variables (internal notes are never sent). 429/5xx/timeouts are retried at most twice within a run and over at most 3 runs, **always with the same key**, because Retell may already have placed the call; the key advances only after Retell confirms a call. Other errors fail the request to a human task. A request with no call result after 3 hours is handed to a person and never re-dialled automatically. The call row is linked to its request from Retell's signed metadata even when `call_started` arrives before the create-phone-call response. Results come back through `call_ended`: no answer → one more attempt ≥ 4 h later, then a human task; `user_requested_dnc` → do-not-call; unreachable → failed + task. Retell publishes no API rate-limit figure and limits concurrency per workspace (20 on pay-as-you-go), so the platform keeps its own volume tiny.

## 8. Cost import convention (FIN-002, related)

The daily `cost_import` job (`src/services/cost-import.ts`) charges AI usage to projects by `ai_jobs.input_ref` (`project:`, `ticket:`, `lead:`/`quote:`; anything else company-wide). Voice call costs (`calls.cost_microusd`, and `voice_outbound_requests.cost_microusd`) are shown on `/staff/voice` and `/staff/voice/operations` and are not imported into project costs, because calls are not project work. No Retell price is hard-coded anywhere; only provider-reported costs are summed, and calls without a reported cost are counted as "unknown", never as $0.

### 8a. Owner monthly voice budget (CREST-GAP-053)

`/staff/voice` → *Monthly voice budget* (Owner only, `voice.monthly_budget_usd`, audit `voice.budget_updated`). Spend = sum of provider-reported `calls.cost_microusd` for calls started this UTC month, test calls included (Retell bills them). Fail closed like the paid-AI budget: when the budget is **unset or reached**, `/api/webhooks/retell/inbound` answers with `receptionist_mode = "voicemail"`, no transfer, no scheduling and `agent_override` (`agent.max_call_duration_ms = 180000`, `retell_llm.begin_message` = message-only greeting); the voice service refuses every function on that call except `request_callback`, `escalate`, `record_opt_out` and `get_business_hours`, and the outbound job dials nothing. Owners get one in-app notification per month when the budget is reached; `/staff/monitoring` shows *AI receptionist budget* (not configured / healthy / failing). The Retell workspace spending limit remains the hard stop.

### 8b. Prompt synchronisation (CREST-GAP-053)

Activating a configuration version (or *Push active version to Retell*) calls `GET /get-agent/{agent_id}` → `response_engine.llm_id`, `PATCH /update-retell-llm/{llm_id}` with `{ general_prompt: <guardrails + instructions> }`, then `GET /get-retell-llm/{llm_id}` and compares the returned `general_prompt` byte for byte. The agent id is *Inbound agent id* (else *Outbound agent id*) in `/staff/voice/operations`. Each run is stored in `voice_prompt_syncs` (`in_sync` / `drift` / `failed` / `not_configured`, SHA-256 prefixes only) and audited as `voice.prompt_sync`; drift and failures notify the Owners and turn the *Retell prompt sync* monitoring check to failing (stale when a newer version is active). Without `RETELL_API_KEY`, or without an agent id, nothing is sent and the result is `not_configured` — never success. Agent versions are not published from the platform.

### 8c. Escalation

`escalate` during staffed hours with an enabled transfer number (and not in voicemail mode) returns `{ escalated: true, transfer: true, transfer_available: true }` and the agent uses Transfer Call with `{{transfer_number}}`; the number is never returned in the function response. Otherwise the call is flagged, a 4-hour CRM task is created (a lead is created for the caller if needed), the Owners get an in-app notification and a `voice_escalation` email (`/staff/email` previews).

## 9. Sources (checked 2026-10-28; prompt-sync endpoints 2026-10-29)

- Get agent: https://docs.retellai.com/api-references/get-agent · Update Retell LLM: https://docs.retellai.com/api-references/update-retell-llm · Get Retell LLM: https://docs.retellai.com/api-references/get-retell-llm

- Secure the webhook: https://docs.retellai.com/features/secure-webhook.md
- Webhook overview (events, defaults, retries, ordering, dedupe keys): https://docs.retellai.com/features/webhook-overview.md
- Inbound call webhook: https://docs.retellai.com/features/inbound-call-webhook.md
- Custom function (payload, timeout 1000–600000 ms default 120000, max_retry 0–5): https://docs.retellai.com/build/single-multi-prompt/custom-function.md
- Dynamic variables (string values only): https://docs.retellai.com/build/dynamic-variables.md
- Transfer call: https://docs.retellai.com/build/single-multi-prompt/transfer-call.md
- Create phone call (idempotency_key, honor_internal_dnc, errors): https://docs.retellai.com/api-references/create-phone-call.md
- Get call (call object, disconnection reasons, `combined_cost` in cents, bearer auth): https://docs.retellai.com/api-references/get-call.md
- Concurrency (20 per pay-as-you-go workspace; no published API rate limit): https://docs.retellai.com/deploy/concurrency.md
- Data storage settings: https://docs.retellai.com/accounts/privacy-disable.md
- Not verified from docs (isolated in code, see report): exact meanings of create-phone-call 402/422 responses; whether `transfer_*` events include `start_timestamp` on every plan.

## Dual internal calendars (migration 0065)

Every callback, escalation callback, support callback and consultation the receptionist (or the outbound sales agent) records
lands on exactly one staff-only calendar. Rules: `src/domain/calendars.ts`.

| Calendar | Used for | Staff view |
|---|---|---|
| A — AI Follow-Up (`ai_follow_up`) | Everything by default: routine callbacks, follow-up calls, questions, qualification, reminders, consultations | `/staff/calendars/ai-follow-up` (Owner, Administrator) |
| B — Founder Callback (`founder_callback`) | ONLY when the caller explicitly asked to speak with the Founder (`wants_founder: true`, stored reason `customer_requested_founder`), or a Founder-approved escalation rule applies (`rule:<id>`; the approved list is **empty**) | `/staff/calendars/founder-callback` (Owner) |

`wants_founder` is an optional boolean on `request_callback`, `escalate`, `book_consultation`, `schedule_consultation`
(and `schedule_sales_followup` outbound). Missing, false or any non-boolean value means AI Follow-Up: existing Retell
configurations keep working unchanged. The database rejects a Founder entry without a reason. The task and its calendar
entry are written in one transaction and read back before the agent is told anything was recorded; a booking is reported
only after the database confirms it on the routed calendar. To use Calendar B, the live Retell tools must add the
`wants_founder` parameter and the Founder's live prompt must say when to set it; this repository does not overwrite the
live prompt.
