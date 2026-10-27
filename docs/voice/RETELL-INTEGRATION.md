# Retell AI integration (VOICE-003)

**Status:** Platform side built and tested with signed test payloads (`tests/integrations.test.ts`). **No Retell workspace, agent or phone number exists for Crestmont.** Nothing has been purchased. VOICE-001 (provider decision) and VOICE-002 (number) stay with the Founder (BLK-009). Follow `PROVIDER-EVALUATION.md` §6: use a **new, separate Crestmont workspace**, and never touch the other business's receptionist.

## 1. How it fits

Retell calls two endpoints. Both translate Retell's format into the platform's existing provider-agnostic voice envelope and hand it to `handleVoiceEvent()` in `src/services/voice.ts`. No voice business logic is duplicated: idempotency per call, published-pricing-only, lead creation (`source = 'ai_receptionist'`), callback tasks, support routing that discloses nothing, escalation, and consent-gated transcripts all live in the voice service.

| Endpoint | Retell feature | Code |
|---|---|---|
| `POST /api/webhooks/retell` | Agent / account webhook (call events) | `src/routes/hooks.ts` → `translateRetellEvent` (`src/adapters/retell.ts`) |
| `POST /api/webhooks/retell/functions` | Custom functions | `src/routes/hooks.ts` → `translateRetellFunction` |

Calls are stored with `provider = 'retell'` and Retell's `call_id`. Retell `web_call`s (dashboard / web SDK test calls), or calls whose `metadata.crestmont_test` is `true`, are flagged `is_test` and kept out of call metrics.

## 2. Signature verification (fail closed)

As documented in [Retell: Secure the webhook](https://docs.retellai.com/features/secure-webhook.md):

- Header `X-Retell-Signature: v=<unix ms>,d=<hex>`.
- `d = HMAC-SHA256(key = Retell API key, message = rawBody + v)`. The body comes first and the timestamp is concatenated as a string.
- Reject when `v` is more than **5 minutes** from now. Compare in constant time. Verify the **raw** body.
- Only an API key **with the webhook badge** can verify. Store it as the secret `RETELL_API_KEY`.
- Custom-function requests carry the same header ([custom functions](https://docs.retellai.com/build/single-multi-prompt/custom-function.md)).

When `RETELL_API_KEY` is not set, both endpoints answer `401` for every request. Integration health shows `retell: not_configured`. Retell also publishes its outbound IP (`100.20.5.228`). An IP allowlist is optional defence in depth and is not relied on.

## 3. Event mapping

Retell webhook body: `{ "event": ..., "call": { call_id, call_type, from_number, call_status, disconnection_reason, transcript, recording_url, call_cost, call_analysis, ... } }` ([webhook overview](https://docs.retellai.com/features/webhook-overview.md), [call object](https://docs.retellai.com/api-references/get-call.md)). Retell expects a 2xx within 10 s and retries up to 3 times, so every step is idempotent.

| Retell event | Platform action |
|---|---|
| `call_started` | Envelope `call_started` (idempotent per call id). Consent is taken from `record_consent` if it was already called. |
| `call_ended` | Envelope `call_ended`. **Outcome** comes from what the voice service recorded for the call: `error` if `call_status = error` or `disconnection_reason` starts with `error`; otherwise escalate → `escalated`, route_support → `support_routed`, create_lead → `lead_captured`, request_callback → `callback_requested`, any conversation → `info_only`, nothing → `abandoned`. **Cost:** `call_cost.combined_cost` is documented "in cents", stored as micro-USD (× 10,000). If it is absent the cost stays `NULL` and is shown as "Unknown". `transcript` and `recording_url` are passed through, and the voice service **discards them unless consent was recorded**. |
| `call_analyzed` | Sets `calls.summary` from `call_analysis.call_summary` **only when the call recorded consent** and no summary exists. Fills `cost_microusd` if it is still unknown. |
| anything else (`transcript_updated`, `transfer_*`, chat events) | `200 {"ok":true,"ignored":...}`. Not used. |

## 4. Custom functions

Retell POSTs `{ "name", "call", "args" }`. Keep the **default payload**, not "args only", because the adapter needs `name` and `call.call_id`. Retell sends no invocation id, so the idempotency key is `retell-` + SHA-256(name + args). A retry with identical arguments (Retell `max_retry`) returns the stored result and does not act twice. The response body is the voice service's `result` object (for example `{ "leadCreated": true, "message": "..." }`), which Retell stringifies for the agent's LLM. Validation errors return 422 with a safe spoken message.

Configure each function in the Crestmont agent as follows: method **POST**, URL `https://<staging host>/api/webhooks/retell/functions`, timeout 10000 ms, "Talk while waiting" off, "Payload: args only" **off**, max retries 0–2. Parameter schemas (they mirror `fnSchemas` in `src/services/voice.ts`, which is the server-side authority):

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

{ "name": "request_callback", "description": "Ask a Crestmont team member to call the caller back.",
  "parameters": { "type": "object", "required": ["name", "phone", "reason"], "properties": {
    "name": { "type": "string" }, "phone": { "type": "string" }, "reason": { "type": "string" },
    "preferred_time": { "type": "string", "description": "Caller's preferred time, if any" } } } }

{ "name": "route_support", "description": "Pass an existing customer's support issue to the support team. Never confirm whether an account exists.",
  "parameters": { "type": "object", "required": ["name", "email", "phone", "summary"], "properties": {
    "name": { "type": "string" }, "email": { "type": "string" }, "phone": { "type": "string" }, "summary": { "type": "string" } } } }

{ "name": "escalate", "description": "Escalate anything complex, sensitive, or outside your rules (refunds, contracts, project status, complaints) to a person.",
  "parameters": { "type": "object", "required": ["reason"], "properties": {
    "reason": { "type": "string" }, "name": { "type": "string" }, "phone": { "type": "string" } } } }
```

Any other function name is rejected (422) by the voice service. Do not add refund, contract, pricing or project-status functions; the platform will refuse them anyway.

**Consent (VOICE-006):** Retell has no field that carries the caller's spoken consent. The prompt therefore asks for consent and the agent calls `record_consent`. The answer is stored in `retell_call_consents`. It is grant-only: a later "no" never silently erases an earlier "yes". It is passed to the voice service on `call_started` and `call_ended`. Without it, transcripts, recordings and summaries are discarded. Also set the workspace/agent **data storage setting** to the most restrictive option the plan allows (`basic_attributes_only` where available) until the Founder's privacy review (PROVIDER-EVALUATION §6, condition 4) is complete.

## 5. Agent configuration in the Retell dashboard (Founder / Owner, staging first)

1. In the **new Crestmont workspace**, create an API key that has the webhook badge. Set it on **staging only**: `wrangler secret put RETELL_API_KEY --env staging`.
2. Agent → Webhook URL: `https://<staging host>/api/webhooks/retell`. Events: `call_started`, `call_ended`, `call_analyzed`.
3. Add the six functions above with URL `https://<staging host>/api/webhooks/retell/functions`.
4. **Prompt:** copy the **active configuration version** from `/staff/voice`. It is `VOICE_GUARDRAILS` followed by the instructions (see `composePrompt()` in `src/services/voice.ts`, table `voice_agent_configs`). Do not edit the prompt in Retell directly. Create a new version in `/staff/voice`, activate it, and paste it again. Add one instruction to the active version: *"After greeting, ask whether the caller agrees to the call being recorded and transcribed, then call record_consent with their answer."*
5. Place a **web test call** from the Retell dashboard. It arrives as `call_type = web_call` and is labelled as a test. Check that `/staff/voice` shows the call, the lead (for a lead scenario) and the outcome. Record the result as evidence.
6. `/staff/integrations` shows `Retell AI webhooks: configured_unverified`. There is no read-only probe; a successful signed test call is the verification evidence.
7. **Do not** buy or attach a phone number. That is VOICE-002 and needs the Founder's approval (BLK-009).

## 6. Cost import convention (FIN-002, related)

The daily `cost_import` job (`src/services/cost-import.ts`) charges AI usage to projects by `ai_jobs.input_ref`:

- `project:<projectId>` or `project:<projectId>:<anything>` → that project.
- `ticket:<ticketId>` → the ticket's `project_id`, when it has one.
- `lead:<leadId>` or `quote:<quoteId>` → the one project the lead converted into (`orders.lead_id` → `projects.order_id`). If the lead has not converted yet, the cost is recorded company-wide and moved onto the project on a later run once it converts; a lead with more than one project stays company-wide.
- anything else → a company-wide `ai_usage` cost with `project_id NULL`, shown as "Unattributed AI cost" on `/staff/finance/reconciliation?view=costs`.

Voice call costs (`calls.cost_microusd`) are shown on `/staff/voice` and are not imported into project costs, because calls are not project work.

## 7. Sources (checked 2026-10-27)

- Retell, Secure the webhook: https://docs.retellai.com/features/secure-webhook.md
- Retell, Webhook overview: https://docs.retellai.com/features/webhook-overview.md
- Retell, Custom function: https://docs.retellai.com/build/single-multi-prompt/custom-function.md
- Retell, Get Call (call object, `combined_cost` in cents): https://docs.retellai.com/api-references/get-call.md
- The non-`.md` page https://docs.retellai.com/features/secure-webhook could not be fetched in this session (the permission request timed out). The `.md` version above was used instead.
