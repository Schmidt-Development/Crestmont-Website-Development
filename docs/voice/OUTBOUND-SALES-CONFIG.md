# Outbound AI sales agent — Retell configuration register

Every value below matches the server-side authority (`src/services/sales-functions.ts` schemas,
`src/routes/sales-outbound.ts`). Architecture and compliance: [`OUTBOUND-SALES.md`](OUTBOUND-SALES.md).

**Deployment status (2026-10-31): NOT DEPLOYED.** The staging Worker runs `main`; this code is on branch
`claude/outbound-sales-agent` (PR #69, now based on `main` after #48 merged). The staging URLs below are the exact URLs these routes will have once
this PR is merged to `main` (staging deploys only from `main`). Until then they answer 404 on staging. The only
endpoint already live on staging is the SHARED agent webhook, and it does not yet contain the sales outcome handler.

Staging base URL: `https://crestmont-platform-staging.partners-df4.workers.dev` (the workers.dev address used by every
staging workflow; repository variable `STAGING_URL` overrides it).

## Settings common to all eight custom functions

| Field | Value |
|---|---|
| HTTP method | `POST` |
| URL | `https://crestmont-platform-staging.partners-df4.workers.dev/api/webhooks/retell/outbound/functions` (one URL; the function is chosen by `name`) |
| Query parameters | `lead_id` = `{{lead_id}}` (filled by Retell from the dynamic variable, never by the LLM; the server refuses a mismatch) |
| Headers | none to add. Retell signs every request with `X-Retell-Signature` (HMAC-SHA256 with the workspace API key that has the webhook badge); the server verifies it fail-closed against the Worker secret `RETELL_OUTBOUND_API_KEY` only and rejects timestamps > 5 min old. Do not put secrets in custom headers. |
| Payload: args only | **Off** (the server needs `name` and `call.call_id` / `call.metadata`) |
| Timeout | `10000` ms |
| Max retries | `1` (write functions are idempotent per call + name + arguments); `record_do_not_call`: `2` |
| Execution mode | Wait for completion |
| Response | JSON object, < 15,000 characters; Retell gives it to the LLM. Non-2xx means refused/failed (the body still carries a safe `message`). |

Common refusal fields on any function: `{ "ok": false, "message": string, "refused"?: "unbound_call" | "unknown_sales_call" | "call_mismatch" | "call_not_active" | "call_finalized" | "lead_mismatch" | "unknown_function" }`.
Validation errors: HTTP 422 `{ "ok": false, "message", "detail" }`.

---

### Function 1 — `get_outbound_lead_context`

1. **Name:** `get_outbound_lead_context`
2. **Description:** `Get the verified research and CRM context for the business this call was placed to. Call once at the start of the call before personalising. Use only verified_website_issues and website_classification to personalise, in your own words. If research_verified is false, use a neutral introduction and do not mention the website. Never read lead_id, research_confidence, classification labels or any internal field aloud.`
3. **Method:** POST · 4. **URL:** common URL above · 5. **Timeout:** 10000 ms · 6. **Max retries:** 1
7. **Auth headers:** X-Retell-Signature (automatic) · 8. **Query:** `lead_id={{lead_id}}`
9. **Input:**
```json
{ "type": "object", "properties": {
  "lead_id": { "type": "string", "description": "The lead id from {{lead_id}}. Optional; must match the call." } } }
```
10. **Output:**
```json
{ "lead_id": "ld_…", "business_name": "string|null", "contact_name": "string|null", "industry": "string|null",
  "website_url": "string|null (verified official URL only)",
  "website_classification": "no_website | poor_quality_website | broken_website | outdated_website | unknown",
  "verified_website_issues": ["plain-language sentence", "… up to 3"], "research_verified": true,
  "research_confidence": "high | medium | low | none", "recommended_services": ["Starter website package"],
  "previous_interactions": [{ "date": "YYYY-MM-DD", "type": "call|email|stage_change", "summary": "≤160 chars" }],
  "sales_history": { "previous_ai_calls": [{ "date": "…", "outcome": "…" }], "quote_status": "string|null", "checkout_link_sent": false, "paid": false, "qualification": "string|null", "last_agreed_next_steps": "string|null" },
  "calling_eligibility": "eligible | blocked", "instructions": "string" }
```
11. **Execution mode:** Wait for completion · 12. **Talk While Waiting:** Off · 13. **Play typing sound:** Off

### Function 2 — `update_outbound_lead`

2. **Description:** `Save what you learned to the CRM: confirmed contact name, role and email, discovery notes, services of interest, budget range, purchase timeline, objections, qualification, pipeline stage, your disposition of the call and the agreed next steps. Call whenever the prospect confirms a fact; send only fields you actually learned. Confirm the email by reading it back before saving it. The response says whether the contact was verified.`
8. **Query:** `lead_id={{lead_id}}` · 6. **Max retries:** 1
9. **Input:**
```json
{ "type": "object", "properties": {
  "lead_id": { "type": "string", "description": "From {{lead_id}}. Optional; must match the call." },
  "contact_name": { "type": "string", "description": "The person's full name as they confirmed it" },
  "contact_role": { "type": "string", "description": "Their role, e.g. owner, manager" },
  "contact_email": { "type": "string", "description": "Email address read back to and confirmed by the prospect" },
  "discovery_notes": { "type": "string", "description": "What they need and why, in their words (1–3 sentences)" },
  "service_interests": { "type": "array", "items": { "type": "string", "enum": ["starter","business","premium","custom","maintenance","redesign","ecommerce","seo","booking","ai_receptionist"] }, "description": "Services they showed interest in" },
  "budget_range": { "type": "string", "enum": ["under_1000","1000_2500","2500_5000","over_5000","not_shared"] },
  "purchase_timeline": { "type": "string", "enum": ["now","within_30_days","1_3_months","later","not_shared"] },
  "objections": { "type": "array", "items": { "type": "string" }, "description": "Concerns they raised, short phrases (max 5)" },
  "qualification": { "type": "string", "enum": ["qualified","not_qualified","needs_review"], "description": "qualified only if they have a real need, authority and interest" },
  "pipeline_stage": { "type": "string", "enum": ["qualified","quote_required","lost"], "description": "quote_required when custom work needs a person's quote; lost only if they clearly declined" },
  "sales_outcome": { "type": "string", "enum": ["wrong_number","not_interested","interested","follow_up_requested"], "description": "Your disposition of the call" },
  "next_steps": { "type": "string", "description": "What was agreed, one sentence" } } }
```
10. **Output:** `{ "updated": true, "contact_verification"?: "verified|held_for_review|suppressed|not_linked", "pipeline_stage"?: "string", "notes"?: ["…"], "message": "Saved to the CRM." }`
11. Wait for completion · 12. **Talk While Waiting:** Off · 13. **Play typing sound:** Off (fast; avoids dead air cues mid-conversation)

### Function 3 — `get_packages_pricing` (SHARED logic with the receptionist's `get_published_pricing`)

2. **Description:** `Get Crestmont's current approved package and maintenance prices and payment rules. Quote only these figures. Never offer discounts, bundles or guarantees. Premium is a starting price; custom work is quoted by a person. Maintenance plans can't be bought yet: give the monthly price only and say a team member will confirm what each includes.`
8. **Query:** `lead_id={{lead_id}}` · 9. **Input:** `{ "type": "object", "properties": {} }`
10. **Output:**
```json
{ "packages": [{ "id": "starter", "name": "Starter", "price": "$999", "starting_price": false, "page_limit": 5, "revision_rounds": 2, "purchasable_online": true },
               { "id": "business", "name": "Business", "price": "$2,499", "…": "…" }, { "id": "premium", "name": "Premium", "price": "$4,999+", "starting_price": true, "…": "…" }],
  "custom_development": "Quoted separately after a scoping conversation; no price is given by phone.",
  "maintenance": [{ "name": "Essential", "monthly": "$99/month", "purchasable_now": false }, { "name": "Professional", "monthly": "$199/month", "purchasable_now": false }, { "name": "Executive", "monthly": "$299/month", "purchasable_now": false }],
  "maintenance_note": "…", "payment_rules": "…", "rules": "…" }
```
Prices are `src/domain/catalog.ts` overlaid by Founder-approved effective prices (`pricing-approvals.ts`). Verified against
the repository: Starter $999, Business $2,499, Premium from $4,999, custom quoted; maintenance $99/$199/$299 — the plans
are named **Essential / Professional / Executive** in the repository, not Basic/Business/Premium, and are not purchasable
until their entitlements are Founder-approved.
11. Wait · 12. **Talk While Waiting:** On, static: `One moment while I pull up our current packages.` · 13. **Typing sound:** On

### Function 4 — `create_checkout_session`

2. **Description:** `Email the prospect a secure link to buy a standard package (starter, business or premium) once they have said they want to buy and are authorised to. First confirm their email with update_outbound_lead and record qualification. Never take card or bank details by phone and never read the link aloud. The link opens Crestmont's checkout, where they sign in, accept the agreement and pay on Stripe's secure page. Payment is confirmed only when check_payment_status says paid.`
9. **Input:**
```json
{ "type": "object", "required": ["package","email","buyer_confirmed"], "properties": {
  "lead_id": { "type": "string", "description": "From {{lead_id}}. Optional; must match the call." },
  "package": { "type": "string", "enum": ["starter","business","premium"] },
  "email": { "type": "string", "description": "The confirmed email address (must match the one saved with update_outbound_lead)" },
  "buyer_confirmed": { "type": "boolean", "description": "true only if the person said they want to buy and can make the purchase decision" } } }
```
10. **Output:** `{ "checkout_link_sent": bool, "delivery"?: "sent|queued|failed|suppressed|…", "checkout_reference"?: "slk_…", "checkout_url"?: "https://…/buy/<64 hex>", "package"?: "Business", "price"?: "$2,499", "expires_at"?: ISO, "already_sent_today"?: true, "reason"?: "payments_not_configured|email_not_verified|not_qualified|email_opted_out", "message": "…" }`
Design note: the voice agent does not create a raw Stripe Checkout Session. Crestmont's checkout requires a signed-in,
email-verified account administrator and a recorded acceptance of the Development Agreement before it creates the
Stripe session (test mode only on staging, `StripeTestPayments`). Creating a session from the call would bypass that and
the onboarding/provisioning the paid webhook performs. The link is single-purpose (redirects to
`/checkout/<package>?ref=sales`), expires in 7 days, is stored only as a SHA-256 hash, is idempotent per lead + package +
day, and is attributed to the lead; the order is linked to the same lead by the existing checkout flow (`orders.lead_id`).
11. Wait · 12. **Talk While Waiting:** On, static: `I'm sending that secure link to your email now.` · 13. **Typing sound:** On

### Function 5 — `check_payment_status`

2. **Description:** `Check whether the prospect's purchase has been paid. Only payment_status "paid" means Stripe confirmed the payment; never say a payment went through otherwise.`
9. **Input:**
```json
{ "type": "object", "properties": {
  "lead_id": { "type": "string", "description": "From {{lead_id}}. Optional; must match the call." },
  "checkout_reference": { "type": "string", "description": "checkout_reference returned by create_checkout_session, if known" } } }
```
10. **Output:** `{ "payment_status": "no_checkout|link_sent|link_opened|checkout_started_not_paid|paid|refunded|disputed", "checkout_reference": "slk_…|null", "stripe_checkout_session_id": "cs_…|null", "lead_id": "ld_…", "onboarding_status": "not_started|awaiting_project_setup|project_created[:status]", "message": "…" }`
Authority: `paid` only when the invoice is `paid` **and** a `succeeded` payment exists — both written solely by the verified Stripe webhook (`src/services/payments.ts`).
11. Wait · 12. **Talk While Waiting:** On, static: `Let me check on that for you.` · 13. **Typing sound:** On

### Function 6 — `send_sales_email`

2. **Description:** `Email the prospect something they asked for, using Crestmont's approved templates only: package_information, checkout_link (needs package), approved_quote (only a proposal a team member already sent), consultation_confirmation, follow_up (only after a follow-up was agreed with schedule_sales_followup) or onboarding_instructions (only after payment is confirmed). The address must be the one confirmed with update_outbound_lead. You cannot write the email's content.`
9. **Input:**
```json
{ "type": "object", "required": ["email_type","email"], "properties": {
  "lead_id": { "type": "string", "description": "From {{lead_id}}. Optional; must match the call." },
  "email_type": { "type": "string", "enum": ["package_information","checkout_link","approved_quote","consultation_confirmation","follow_up","onboarding_instructions"] },
  "email": { "type": "string", "description": "The confirmed email address" },
  "package": { "type": "string", "enum": ["starter","business","premium"], "description": "Only for checkout_link" } } }
```
10. **Output:** `{ "sent": bool, "delivery"?: "sent|queued|failed|suppressed|opted_out|rate_limited|not_configured", "already_sent_today"?: true, "reason"?: "email_not_verified|no_approved_quote|quote_expired|no_consultation|no_follow_up_agreed|payment_not_confirmed", "message": "…" }` (checkout_link returns Function 4's shape)
Limits: ≤ 3 sales emails per lead per 24 h; idempotent per lead + type + day; sales opt-outs and Resend suppressions honoured; on staging only `EMAIL_RECIPIENT_ALLOWLIST` addresses receive mail.
11. Wait · 12. **Talk While Waiting:** On, static: `I'm sending that over now.` · 13. **Typing sound:** On

### Function 7 — `schedule_sales_followup`

2. **Description:** `Arrange a follow-up the prospect agreed to: consultation (call first without start_time to get open times, offer only those, then call again with the chosen start_time), staff_callback (a team member calls back on a preferred date and part of day), or ai_follow_up_call (an automated call later, only if they agreed to be called again). Never say a consultation is confirmed unless the response says confirmed true.`
9. **Input:**
```json
{ "type": "object", "required": ["followup_type","prospect_agreed"], "properties": {
  "lead_id": { "type": "string", "description": "From {{lead_id}}. Optional; must match the call." },
  "followup_type": { "type": "string", "enum": ["consultation","staff_callback","ai_follow_up_call"] },
  "start_time": { "type": "string", "description": "Consultation only: the exact start_time of the slot the prospect chose" },
  "preferred_date": { "type": "string", "description": "YYYY-MM-DD the prospect asked for, if any" },
  "preferred_time": { "type": "string", "enum": ["morning","afternoon","evening","any"] },
  "name": { "type": "string", "description": "Name for the booking, if different from the contact" },
  "email": { "type": "string", "description": "Email for the booking confirmation, if given" },
  "topic": { "type": "string", "description": "What the follow-up is about, one sentence" },
  "prospect_agreed": { "type": "boolean", "description": "true only if the prospect explicitly agreed to this follow-up" } } }
```
10. **Output:** `{ "scheduled": bool, "confirmed"?: bool, "status"?: "requested|confirmed|…", "when"?: "label", "confirmation_code"?: "…", "needs_time"?: true, "slots"?: [{ "start_time", "label" }], "already_scheduled"?: true, "reason"?: "…", "message": "…" }`
Uses the receptionist's scheduling service (off until the Owner enables phone scheduling; without a calendar every booking is `requested` until staff confirm). One open follow-up per lead and type. AI follow-up calls re-run the full compliance gate at dial time.
11. Wait · 12. **Talk While Waiting:** On, static: `Let me check that for you.` · 13. **Typing sound:** On

### Function 8 — `record_do_not_call`

2. **Description:** `Call immediately when the person asks not to be called again, asks to be removed from the list, or says they are not the business. Set also_stop_email to true if they also don't want emails. Then confirm they won't be called again, thank them and end the call. Do not keep selling.`
9. **Input:**
```json
{ "type": "object", "properties": {
  "lead_id": { "type": "string", "description": "From {{lead_id}}. Optional; must match the call." },
  "phone": { "type": "string", "description": "Only if they name a different number to stop calling" },
  "also_stop_email": { "type": "boolean", "description": "true if they also asked not to be emailed" } } }
```
10. **Output:** `{ "recorded": true, "suppressed_for": ["all outbound calls", "sales email"?], "confirmation": "Understood. We've removed this number from our call list and won't call again.", "message": "…" }`
Effects: `voice_dnc` (SHARED with the receptionist: revokes follow-up consents, cancels follow-up requests), sales consents revoked, queued sales calls and AI follow-ups cancelled, research prospects with the number suppressed (re-imports are never callable), optional sales-email opt-out, CRM note, audit `sales_outbound.do_not_call`. Retell's own `user_requested_dnc` disconnection reason triggers the same path from the webhook.
6. **Max retries:** 2 · 11. Wait · 12. **Talk While Waiting:** Off · 13. **Typing sound:** Off

### Additional function — `record_consent` (SHARED receptionist endpoint, required for SIE transcripts)

The protected sales policy (rule 2) and the master prompt ask for recording consent and call `record_consent`. Without
it the platform discards the transcript (consent-gated storage), so the Self-Improvement Engine has nothing to analyse.
#73 lets the outbound workspace call exactly this one receptionist function.

| Field | Value |
|---|---|
| Name | `record_consent` |
| Description | `Record whether the person agreed to the call being recorded and transcribed. Call once, right after asking.` |
| Method / URL | POST `https://crestmont-platform-staging.partners-df4.workers.dev/api/webhooks/retell/functions` (SHARED; outbound-signed requests may call only this function there) |
| Timeout / retries | 10000 ms / 1 |
| Query parameters / headers | none |
| Payload: args only | Off |
| Parameters | `{ "type": "object", "required": ["consent"], "properties": { "consent": { "type": "boolean", "description": "true only if the person clearly agreed" } } }` |
| Response | `{ "recorded": true, "message": "…" }` |
| Execution mode / Talk While Waiting / typing sound | Wait for completion / Off / Off |

### SIE registration (Self-Improvement Engine)

Register the outbound sales agent as the **staging** target on `/staff/sales-optimization` and press *Verify with Retell*
(uses `RETELL_OUTBOUND_API_KEY`). Only then do calls carry `crestmont_so_version` and feed SIE metrics and attribution.
Version 1 of the SIE is the master prompt's instructions, so the engine's deployment of v1 and a hand-pasted
`outbound-sales-agent-prompt.txt` are byte-identical.

### Function 9 — `record_call_outcome` → **agent-level webhook, not a custom function**

Decision and reasons: `OUTBOUND-SALES.md` §6. Retell UI (sales agent → Webhook settings):

| Retell field | Value |
|---|---|
| Agent Level Webhook URL | `https://crestmont-platform-staging.partners-df4.workers.dev/api/webhooks/retell` (**SHARED** route with the receptionist; the route is matched by `src/routes/hooks.ts`) |
| Webhook Timeout | `10` seconds (Retell's documented webhook timeout; the handler answers well inside it) |
| Webhook Events | `call_started`, `call_ended`, `call_analyzed`, `transfer_started`, `transfer_bridged`, `transfer_cancelled`, `transfer_ended` |
| Leave off | `transcript_updated` (ignored by the platform; adds load only), all chat events |
| Signature | automatic `X-Retell-Signature`, verified with the Worker secret `RETELL_OUTBOUND_API_KEY` (the OUTBOUND workspace key with the webhook badge; the receptionist key is refused) |
| Post-call analysis (optional) | a selector field named exactly `sales_outcome` with choices `wrong_number`, `not_interested`, `interested`, `follow_up_requested`; any other field name is ignored by the platform |

`transfer_cancelled` (a warm transfer that did not connect) creates an urgent CRM callback task on the call's lead and an Owner notification. Transfer events are deduplicated on event + call id + start timestamp + destination.

Outcomes stored (`sales_calls.outcome`): `no_answer`, `voicemail`, `wrong_number`, `not_interested`, `interested`, `follow_up_requested`, `consultation_booked`, `checkout_sent`, `payment_confirmed`, `do_not_call`, `technical_failure`, plus `unclassified` (connected, nothing recorded → CRM task; never guessed). Stable key: Retell `call_id` bound to `crestmont_sales_call_id`; written once.

## Agent-level default dynamic variables (Security & fallback settings → Default Dynamic Variables)

Retell leaves an unset variable as the literal `{{name}}`; an empty string renders as nothing. Set these defaults so a
missing value is never spoken:

| Variable | Default |
|---|---|
| `business_name` | empty string |
| `first_name` | empty string |
| `industry` | empty string |
| `website_url` | empty string |
| `website_status` | `unknown` |
| `verified_issue` | empty string |
| `recommended_service` | empty string |
| `research_verified` | `false` |
| `crestmont_env` | empty string |
| `lead_id` | **no default** (never a fabricated id; the server binds the lead from signed call metadata, and an unrendered `{{lead_id}}` is ignored) |

`agent_number` is a Retell system variable (the calling number) and needs no default.

## Master prompt

Paste-ready text for the sales agent's Prompt field: [`outbound-sales-agent-prompt.txt`](outbound-sales-agent-prompt.txt). It is the SIE's protected sales policy followed by version 1 of the optimizable instructions (`composeSalesPrompt(baselineSalesInstructions())`, tested byte for byte); prices in the policy come from the catalog. `tests/outbound-sales.test.ts` checks that it names only real tools and variables.

---

## Call initiation (performed by the platform's `sales_outbound` job, not by you)

`POST https://api.retellai.com/v2/create-phone-call` · `Authorization: Bearer <RETELL_OUTBOUND_API_KEY>` · `Content-Type: application/json`
```json
{ "from_number": "+1… (sales_outbound_settings.from_number)",
  "to_number": "+1… (lead phone, E.164)",
  "override_agent_id": "<sales agent id>",
  "idempotency_key": "crestmont_scall_<id>_a<attempt>",
  "honor_internal_dnc": true,
  "metadata": { "crestmont_env": "staging", "crestmont_sales_call_id": "scall_…", "crestmont_lead_id": "ld_…", "crestmont_test": "false" },
  "retell_llm_dynamic_variables": {
    "lead_id": "ld_…", "business_name": "…", "first_name": "… or empty", "industry": "…",
    "website_url": "verified official URL or empty", "website_status": "no_website|poor_quality_website|broken_website|outdated_website|unknown",
    "verified_issue": "one plain-language sentence or empty", "recommended_service": "e.g. Starter website package, or empty",
    "research_verified": "true|false", "crestmont_env": "staging" } }
```
Set agent-level **default** dynamic variables for a neutral opening: `website_status=unknown`, `research_verified=false`,
and empty strings for the others, so a missing value never renders as a literal `{{…}}`.

## Required configuration

**Cloudflare Worker secrets / vars (staging; set with `wrangler secret put … --env staging`):**
`RETELL_OUTBOUND_API_KEY` (the outbound workspace key with the webhook badge; separate from the receptionist's `RETELL_INBOUND_API_KEY`), `RETELL_SALES_OUTBOUND`
(leave unset; `on` only after counsel approval), `STRIPE_SECRET_KEY` (`sk_test_…` only), `STRIPE_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_RECIPIENT_ALLOWLIST`, `RESEARCH_RUNNER_SECRET` (PR #48). Production
gets its own values; nothing is shared.

**Retell:** a separate Crestmont workspace (PROVIDER-EVALUATION §6); a **dedicated sales agent** (Retell LLM response
engine) distinct from the receptionist; a Retell-purchased or imported US number for outbound (register for
STIR/SHAKEN / branded caller ID); inbound calls to that number should route to the receptionist (set its inbound
webhook to `/api/webhooks/retell/inbound` and list it in `inbound.numbers`); agent webhook and the 8 functions above;
data storage set to the most restrictive option until the privacy review; optional `sales_outcome` post-call field;
optionally register the agent as the sales optimizer's target (`/staff/sales-optimization`).

**Platform (Owner, `/staff/sales-outbound`):** compliance approval (Founder + counsel reference), per-number written
consents, DNC scrubs, sales agent id + caller number, limits (start at concurrency 1).
