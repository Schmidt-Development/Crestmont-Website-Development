# Retell agent specification — Crestmont receptionist

**Status:** Specification only. No agent exists. Do not create it until the Founder approves VOICE-001 and works through `RETELL-CONNECTION-GUIDE.md`, staging first.

## 1. One agent or two?

**Recommendation: one agent, "Crestmont Receptionist", used for both directions.** Retell lets an outbound call use any agent (`override_agent_id` on create-phone-call) and gives every call the system variable `{{direction}}` plus our `{{call_purpose}}`. A second agent would duplicate the prompt, the 14 function definitions, the webhook settings and the data-storage setting, and the two would drift. The backend does not rely on which agent called: every rule (consent, verification, pricing, opt-out) is enforced server-side.

Use the same agent id in `/staff/voice/operations` for the inbound override (optional) and the outbound agent. Create a separate outbound agent only if the Founder later wants a different voice or model for outbound, and give it the same functions and settings.

**Customer AI Receptionist templates:** not prepared. AI receptionist is not a service Crestmont sells today (it is absent from `APPROVED_SERVICES` in `src/domain/catalog.ts` and from the service pages), so per-customer templates would be invented scope. See `RETELL-BACKEND-REPORT.md` §3 for what offering it would require.

## 2. Purpose and boundaries

| | |
|---|---|
| Purpose | Answer Crestmont's own line: explain services and published packages, capture new-project leads, book consultations, route existing-customer support without disclosing account data, take callbacks, escalate. Outbound: return calls people asked for, consultation reminders the caller agreed to, support follow-ups with recorded consent. |
| Approved knowledge | `get_published_pricing` (server catalog), `get_business_hours`, the active prompt version from `/staff/voice`. **No knowledge base upload** until the Founder approves its content; anything uploaded must not contain prices, dates or customer data. |
| Out of bounds | Prices beyond the catalog, discounts, delivery dates, contracts, refunds, project status, invoices, account details, whether a person is a customer, card or bank details, legal or tax advice. |
| Identity | Always says it is an AI assistant for Crestmont Website Development. |

## 3. Prompt

Copy the **active configuration version** from `/staff/voice` (the immutable `VOICE_GUARDRAILS` followed by the instructions). Never edit the prompt in Retell directly; create and activate a new version, then paste it. The default instructions (`defaultAgentPrompt()` in `src/services/voice.ts`) already cover the functions below. Add, as a new version before go-live:

> After greeting, ask whether the caller agrees to the call being recorded and transcribed, then call record_consent with their answer.
> If {{direction}} is outbound: say you are Crestmont's AI assistant calling about {{call_purpose}} for {{contact_name}}; if the person did not expect the call or asks not to be called, apologise, call record_opt_out and end the call.
> If {{transfer_available}} is "true" and the caller asks for a person, call check_transfer_availability and transfer only if it confirms. Otherwise offer request_callback.

**Begin message (agent speaks first):** "Hello, you've reached Crestmont Website Development. I'm an AI assistant. How can I help you today?" (Retell has no separate recording-disclaimer setting; the consent question comes right after.)

## 4. Model and voice

Founder decision, made in the Retell dashboard; nothing in the backend depends on it. Criteria: low latency, reliable function calling, temperature low (≈0.2–0.3) for factual answers; a clear, neutral US English voice; interruption sensitivity moderate. Record the choice and the per-minute price shown in Retell at that time in `PROVIDER-EVALUATION.md` (prices are not hard-coded anywhere in the platform).

## 5. Dynamic variables

| Variable | Source | Values |
|---|---|---|
| `crestmont_env` | inbound webhook / outbound creation | `staging` / `production` |
| `business_open_now`, `business_hours_configured`, `business_hours` | inbound webhook | `"true"`/`"false"`, text |
| `transfer_available`, `transfer_number` | inbound webhook | `"true"`/`"false"`; number only when approved **and** open, else `""` |
| `scheduling_available` | inbound webhook | `"true"`/`"false"` |
| `contact_name`, `call_purpose` | outbound creation | text; `callback` / `consultation_reminder` / `support_followup` |
| `direction`, `user_number`, `call_id`, `current_time_America/Detroit` | Retell system variables | — |

Set agent **Default Dynamic Variables** so an unset value never reads aloud as `{{...}}`: `transfer_available = "false"`, `transfer_number = ""`, `scheduling_available = "false"`, `business_open_now = "false"`, `call_purpose = ""`, `contact_name = ""`.

## 6. Functions

The 14 custom functions in `RETELL-INTEGRATION.md` §6 (exact JSON), all on `https://<host>/api/webhooks/retell/functions`, POST, default payload, timeout 10000 ms, max retries 1. Plus Retell's built-in tools:

- **Transfer Call** — Cold transfer; destination `{{transfer_number}}`; displayed caller ID: Retell agent's number; ring duration 25 s. Prompt: only after `check_transfer_availability` returns true. A failed transfer produces `transfer_cancelled`, which the backend turns into an urgent callback task.
- **End Call** — after the caller's needs are met, after `record_opt_out`, or if the caller is abusive.
- **No** Retell-native booking, SMS or "press digit" tools: bookings go through our functions so the database stays authoritative.

## 7. Escalation and failure responses

| Situation | Agent behaviour | Backend effect |
|---|---|---|
| Caller asks for a person | `check_transfer_availability` → transfer, else `request_callback` | Callback task + consented, approval-pending callback request |
| Complaint, refund, contract, project status, outage, anything urgent | `escalate` (reason in caller's words) | Call flagged, 4-hour task, Owner notification |
| Function returns an error message | Read the message, offer a callback | Error recorded on `/staff/voice` |
| Booking details don't verify | Offer a callback; never hint which detail was wrong | Locked after 3 failures per call |
| Caller starts reading card details | Interrupt politely: payments only through secure links Crestmont emails | Digits redacted before storage anyway |
| Environment mismatch / line not set up | Apologise, end call | 409 + audit `voice.environment_mismatch` |

## 8. Settings

| Setting | Value |
|---|---|
| Webhook URL | `https://<host>/api/webhooks/retell` |
| Webhook events | `call_started`, `call_ended`, `call_analyzed`, `transfer_started`, `transfer_bridged`, `transfer_cancelled`, `transfer_ended` |
| Data storage | `basic_attributes_only` until the privacy review; then at most `everything_except_pii` |
| Data retention | Shortest available; the platform keeps consented transcripts per `retention.voice_transcripts_days` |
| Voicemail detection (outbound) | On, set not to leave a message (no voicemail wording is approved). Check the options on Retell's "Handle voicemail" page when configuring; they were not verified for this spec. |
| Max call duration | Recommended 15 minutes (Retell default is 1 hour) |
| Post-call analysis | Call summary only; no custom extraction of personal data |
| Phone number → inbound agent | This agent; Inbound Webhook URL `https://<host>/api/webhooks/retell/inbound` |
| Fallback number (concurrency) | None until a Founder-approved business line exists |

## 9. Configuration dependencies

`RETELL_API_KEY` (webhook-badge key) per environment · active prompt version in `/staff/voice` · business hours and time zone in `/staff/voice/operations` · bound receptionist number · (optional) approved transfer number · (optional) scheduling on · (outbound only) `RETELL_OUTBOUND=on`, outbound switch, caller number, agent id.
