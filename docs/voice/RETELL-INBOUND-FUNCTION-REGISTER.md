# Retell inbound function configuration register (staging)

Branch `claude/retell-inbound-8-functions`. Implementation: `src/services/voice.ts` (`INBOUND_FUNCTIONS`), migration `0055_voice_inbound_functions.sql`, template `voice_followup` (`src/services/mailer.ts`). Tests: `tests/voice-retell-inbound-functions.test.ts` (signed fixtures only, not live verification).

**Status:** deployed to staging with PR #68 (merge `d7a8a15`).

**Two workspaces, two keys** (`src/adapters/retell-workspaces.ts`):
- `RETELL_INBOUND_API_KEY` belongs to the receptionist's workspace. It covers the function and inbound-call webhooks, receptionist events, receptionist prompt sync and receptionist callbacks.
- `RETELL_OUTBOUND_API_KEY` belongs to the sales agent's workspace. It covers the sales agent's events and `record_consent` calls, plus the sales Self-Improvement Engine.
- Which workspace sent a request is decided only by which key's signature verifies.
- There is no fallback between keys. The legacy `RETELL_API_KEY` is never read.
- If the two keys are identical, every request is refused.

Without `RETELL_INBOUND_API_KEY`, the receptionist routes answer `401 Retell webhook key not configured (RETELL_INBOUND_API_KEY)`.

## Settings shared by all eight functions

| Field | Value |
|---|---|
| API method | `POST` |
| API endpoint URL | `https://crestmont-platform-staging.partners-df4.workers.dev/api/webhooks/retell/functions` (same URL for all eight; the backend dispatches on the function `name`) |
| Timeout | 10 seconds (10000 ms) |
| Max retries | 1 (retries are safe: identical calls replay the stored result) |
| Headers | **None.** Retell signs every request with `X-Retell-Signature` (HMAC of the body with the workspace API key that has the webhook badge). There is no custom auth header to add. |
| Query parameters | None |
| Payload: args only | **OFF.** The backend needs `name` and `call.call_id`. |
| Response variables | None required. Retell passes the JSON response to the LLM. |
| Execution mode | Wait for completion (none of these run in the background) |

**Secret:** Crestmont verifies the signature with the `RETELL_INBOUND_API_KEY` Worker secret: the receptionist workspace's API key that has the webhook badge. Set it either on the Worker directly (`wrangler secret put RETELL_INBOUND_API_KEY --env staging`) or as the GitHub `staging` environment secret of the same name; the deploy puts it only when it changed. Never paste it into Retell fields, the repo, chat or tickets.

## Functions

Each block gives the Retell description and the parameters JSON schema to paste.

### 1. `crm_customer_lookup`
Description: `Use when the caller says they are an existing customer. For privacy this never confirms or reveals account details; it tells you which function to use next.`
```json
{ "type": "object", "properties": {
  "name": { "type": "string", "description": "Caller's name, if given" },
  "email": { "type": "string", "description": "Email the caller gave, if any" },
  "phone": { "type": "string", "description": "Phone the caller gave, if any" } } }
```
Output: `identity_verified` (bool, always false), `account_details_available` (bool, always false), `details_captured_this_call` (bool), `next_step` (string), `message` (string). Talk while waiting: OFF. Typing sound: OFF.
**Policy:** this function never runs a query. Guardrail 6 forbids saying whether an account exists, and phone and email are not identity verification. A real lookup needs a Founder-approved verification method (`RETELL-BACKEND-REPORT.md` §4.7).

### 2. `crm_upsert_lead`
Description: `Save a new-project enquiry once you have the caller's name, a phone or email, the package of interest and their requirements. Safe to call again with more details.`
```json
{ "type": "object", "required": ["name", "interest", "requirements"], "properties": {
  "name": { "type": "string", "description": "Caller's full name" },
  "email": { "type": "string", "description": "Caller's email, if given" },
  "phone": { "type": "string", "description": "Caller's phone, if given" },
  "company": { "type": "string", "description": "Business name, if given" },
  "interest": { "type": "string", "enum": ["starter", "business", "premium", "custom", "maintenance", "other"] },
  "requirements": { "type": "string", "description": "What the caller needs, in their words (at least a sentence)" } } }
```
Output: `lead_saved` (bool), `message`. Uses CRM intake dedupe (`contact-identity.ts`), so a returning phone or email continues the existing open lead. Talk while waiting: ON, "One moment while I note that down." Typing sound: ON.

### 3. `get_packages_pricing`
Description: `Get Crestmont's approved website packages, maintenance prices, add-ons and payment rules. Quote only these figures.`
```json
{ "type": "object", "properties": {} }
```
Output: `pricing.packages[]` (name, price, priceCents, pageLimit, revisionRounds), `pricing.maintenance[]`, `pricing.maintenancePurchasableOnline[]`, `pricing.addOns` (empty: none are approved), `pricing.paymentRules`, `pricing.rules`. Talk while waiting: OFF. Typing sound: OFF.

### 4. `create_checkout_session`
Description: `When the caller wants to buy a Starter, Business or Premium package, email them a secure checkout link. Never take card details by phone.`
```json
{ "type": "object", "required": ["package", "name", "email"], "properties": {
  "package": { "type": "string", "enum": ["starter", "business", "premium"] },
  "name": { "type": "string", "description": "Caller's name" },
  "email": { "type": "string", "description": "Email address to send the secure link to" } } }
```
Output: `link_sent` (bool), `email_sent` (bool), `email_status`, `package`, `price`, `reason` (on refusal), `message`. Talk while waiting: ON, "I'm sending that secure link now." Typing sound: ON.
**Behaviour:** it emails a link to the existing `/checkout/<package>` flow. The caller signs in, verifies their email and accepts the agreements, and only then does `billing.ts` create the Stripe Checkout session (test mode on staging). The function does not create a Stripe session itself, because that would skip account authorization and the agreement acceptance. The checkout reference is sent only by email.

### 5. `check_payment_status`
Description: `Check whether a package payment went through. Needs the checkout reference from the email and the email address it was sent to.`
```json
{ "type": "object", "required": ["checkout_reference", "email"], "properties": {
  "checkout_reference": { "type": "string", "description": "6-character reference from the checkout email" },
  "email": { "type": "string", "description": "Email the checkout link was sent to" } } }
```
Output: `verified` (bool), `payment_status` (`paid` | `checkout_started_not_paid` | `not_started`), `package`, `locked` (after 3 failed tries per call), `message`. Reads `invoices.status`, which only the signed Stripe webhook can set to paid. Talk while waiting: ON, "Let me check on that." Typing sound: ON.

### 6. `schedule_consultation`
Description: `Book a consultation. Call first without start_time to get open times; offer only those labels; then call again with the chosen start_time, name, phone and topic.`
```json
{ "type": "object", "properties": {
  "preferred_date": { "type": "string", "description": "YYYY-MM-DD, if the caller named a day" },
  "start_time": { "type": "string", "description": "Exact start_time of the chosen slot; omit to list times" },
  "name": { "type": "string" }, "phone": { "type": "string" },
  "email": { "type": "string", "description": "Only if the caller gave one" },
  "topic": { "type": "string", "description": "What the caller wants to discuss" },
  "reminder_call_ok": { "type": "boolean", "description": "true only if the caller agreed to a reminder call" } } }
```
Output: `step` (`availability` | `booking`); for availability: `available`, `reason`, `timezone`, `slots[]` (start_time, label); for booking: `booked`, `status`, `when`, `confirmation_code`, `already_booked`, `slots[]` (alternatives). Talk while waiting: ON, "Let me check the calendar." Typing sound: ON. The database allows one active booking per start time.

### 7. `create_support_ticket`
Description: `Pass an existing customer's support issue to the support team. Never confirm whether an account exists. Read the request reference back.`
```json
{ "type": "object", "required": ["name", "email", "phone", "summary"], "properties": {
  "name": { "type": "string" }, "email": { "type": "string" }, "phone": { "type": "string" },
  "summary": { "type": "string", "description": "The issue in the caller's words" } } }
```
Output: `received` (bool), `request_reference` (`SR-XXXXXX`), `message`. A ticket is opened only for a verified account email plus a matching phone; otherwise a CRM callback task carries the same reference. The response looks the same in both cases. Talk while waiting: ON, "I'm passing that to our support team now." Typing sound: ON.

### 8. `send_customer_email`
Description: `Email the caller something they asked for: our package prices, or details of a consultation booked on this call. You cannot write the email text.`
```json
{ "type": "object", "required": ["template", "name", "email"], "properties": {
  "template": { "type": "string", "enum": ["package_information", "consultation_details"] },
  "name": { "type": "string" }, "email": { "type": "string" },
  "confirmation_code": { "type": "string", "description": "Booking reference, only for consultation_details" } } }
```
Output: `email_sent` (bool), `email_status`, `template`, `reason`, `message`. Limits: at most 3 emails per call (together with checkout links) and 3 per address per day. Sent through the existing Resend adapter; on staging, only addresses in `EMAIL_RECIPIENT_ALLOWLIST` are actually delivered. Talk while waiting: ON, "Sending that now." Typing sound: ON.

## Cross-cutting behaviour (tested)

- Unsigned, wrongly signed, stale (more than 5 minutes) or tampered requests get `401` for all eight, and nothing is stored.
- Validation errors get `422` with a safe message.
- A call stamped for another environment gets `409`.
- In voicemail mode (no Owner budget, or budget reached), all eight are refused.
- Card numbers and SSNs are redacted from every argument before validation and storage.
- Write functions replay their stored result on an identical retry. Read-only answers are always fresh.

## Webhooks (agent level)

| Retell setting | Value |
|---|---|
| Agent → Webhook URL | `https://crestmont-platform-staging.partners-df4.workers.dev/api/webhooks/retell` |
| Events | `call_started`, `call_ended`, `call_analyzed`, `transfer_started`, `transfer_bridged`, `transfer_cancelled`, `transfer_ended` |
| Phone number → Inbound Webhook URL | `https://crestmont-platform-staging.partners-df4.workers.dev/api/webhooks/retell/inbound` |
| Auth | `X-Retell-Signature` signed with the webhook-badge API key. There are no custom headers. |

## Existing functions the master prompt also uses

These are on the same URL with the same settings. Their JSON is in `RETELL-INTEGRATION.md` §6:
- `record_consent`
- `request_callback`
- `escalate`
- `check_transfer_availability`
- `get_business_hours`
- `record_opt_out`
- `lookup_consultation`
- `reschedule_consultation`
- `cancel_consultation`

The built-in tools are Transfer Call (destination `{{transfer_number}}`) and End Call.

## Master prompt

The instructions are `INBOUND_MASTER_INSTRUCTIONS` in `src/services/voice.ts`. `/staff/voice` → Create a new version pre-fills them. Activating the version pushes guardrails + instructions to the agent's Retell LLM `general_prompt` and reads it back. Do not edit the prompt in the Retell dashboard: activation overwrites it, and the drift check reports any difference.

## Founder decisions (2026-10-31): these override older guidance in this folder

| Decision | How the platform applies it |
|---|---|
| 24/7/365 AI receptionist | Answers every call, at any hour. The inbound webhook never rejects a call for being outside hours. **Business hours in `/staff/voice/operations` are the human staffing hours**: they decide only when a live transfer is offered and when consultations can be booked. |
| Full-service mode | Requires the Owner's monthly voice budget (`/staff/voice`). Without one, or once it is reached, functions refuse everything except message-taking. This is checked live on every function call, even if the number's inbound webhook is not configured. |
| Max call 60 minutes | The audit passes at ≤ 60 minutes. |
| Warm transfer only | The audit requires `transfer_option = warm_transfer`. The destination must be either `{{transfer_number}}` (filled per call by the inbound webhook only during staffed hours, so the server enforces staffing), or a fixed number equal to the approved transfer number in `/staff/voice/operations`. With a fixed number, staffing hours are enforced only by the prompt calling `check_transfer_availability`. A destination that is one of the workspace's own numbers is reported as a loop. |
| Zero default dynamic variables | Not required. Per-call variables still come from the inbound webhook (they aren't defaults). The audit fails only if the prompt uses a variable that nothing supplies. |
| Master prompt = Founder's Retell-native single prompt (V4) | It's maintained in the Retell dashboard. In `/staff/voice` → Retell prompt synchronisation, choose **Adopt the live Retell prompt**: it records V4 as the active version and writes nothing to Retell. A plain push or an activation never overwrites a prompt edited in the dashboard (drift guard); replacing it requires **Overwrite Retell with the active version**. |
| Data storage | Reported for the pending privacy/legal review, not judged. The platform keeps transcripts and recordings only after `record_consent`. |
