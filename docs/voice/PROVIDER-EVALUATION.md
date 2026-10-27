# AI receptionist: voice provider evaluation

**Status:** Recommendation for Founder decision (VOICE-001, BLK-009). **Nothing has been purchased.** No account was created, no phone number was bought, and no existing receptionist was opened, viewed or changed.
**Prepared:** 2026-10-26 by engineering · **Directive:** §51–§53

## 1. What we need (from §52, and from the code that already exists)

The platform side is built and tested (`src/services/voice.ts`, `POST /api/webhooks/voice`, `/staff/voice`). It is provider-agnostic. A provider has to do the following:

1. Answer inbound calls on a US number. The agent says it is an AI assistant.
2. Run an LLM agent that calls our functions: `get_published_pricing`, `create_lead`, `request_callback`, `route_support` and `escalate`. Calls go to an HTTPS endpoint that we sign or verify.
3. Send call lifecycle events (`call_started`, `call_ended` with an outcome, cost and optional transcript) to the webhook.
4. Ask the caller for recording/transcription consent and honour the answer. The platform already discards transcripts, summaries and recordings when consent is false (VOICE-006).
5. Transfer to a human or end the call with a handoff. We have no staffed phone line yet, so this mostly means a callback task. Live transfer comes later.
6. Run as a **separate Crestmont configuration**, isolated from the other business's existing Retell receptionist.

The platform webhook expects the envelope `x-crestmont-voice-signature: t=<unix s>,v1=<HMAC-SHA256(secret, "t.body")>`. Neither vendor emits that natively. We will need a thin adapter in either case (see §5). That is a few dozen lines and does not decide the choice.

## 2. Options considered

| Option | What it is |
|---|---|
| **A. Retell AI**, in a new, separate Crestmont workspace | A managed voice-agent platform: STT, LLM orchestration, TTS, telephony, function calling, webhooks and a dashboard. The Founder already uses it. |
| **B. Twilio Programmable Voice + ConversationRelay** | Twilio supplies the number, the carrier, STT/TTS and turn-taking over a WebSocket. **We** host the agent loop (LLM calls, tool execution, state) in a Worker or Durable Object. |
| **C. Vapi**, as a check against A | A managed platform similar to Retell. Its per-minute costs are similar, with fewer included concurrent lines. I did not find any benefit over A for this use case. |
| D. Build directly on raw media streams (Twilio Media Streams + our own STT/TTS) | Rejected. It needs the most engineering and the most latency tuning, and we would own voice quality. Nothing in §52 requires it. |

## 3. Evaluation against the §51 criteria

Legend: ✔ meets the need · ◐ partially, or needs our work · ✖ does not · **(unverified)** = not confirmed from a primary source in this session.

| Criterion | A. Retell (separate workspace) | B. Twilio + ConversationRelay |
|---|---|---|
| **Phone number availability** | ✔ Retell sells numbers ($2/mo) or imports your own (no charge). Retell telephony runs on Twilio/Telnyx [R1]. | ✔ US local $1.15/mo, toll-free $2.15/mo [T2]. |
| **Inbound calling** | ✔ Native. | ✔ Native. Inbound local $0.0085/min, toll-free $0.022/min [T2]. |
| **Voice quality** | ✔ Choice of TTS vendors, including ElevenLabs. The Founder already knows the quality first-hand. **(unverified for Crestmont's script until a test call)** | ◐ TTS: Google, Amazon or ElevenLabs (default ElevenLabs). STT: Google or Deepgram [T3]. Quality is comparable, but end-to-end latency depends on our own LLM loop. |
| **Concurrency** | ✔ 20 concurrent calls included; more at $8/line/month [R1]. Far more than we need. | ✔ No practical cap at our volume. **(Twilio account-level CPS limits unverified)** |
| **Function calling** | ✔ Built-in custom functions that call HTTPS endpoints. | ◐ We write it ourselves: the LLM tool-use loop runs in our code. That gives full control and more code to own. |
| **Webhooks** | ✔ Call events go to a webhook. Signed with `X-Retell-Signature: v=<ms>,d=<HMAC-SHA256(body+timestamp)>` keyed by the workspace's webhook API key. IP allowlist available [R3]. | ✔ Twilio status callbacks, signed with `X-Twilio-Signature`, and the ConversationRelay WebSocket [T3]. |
| **CRM integration** | ✔ Through our webhook and functions. Already implemented on our side. | ✔ Same. We already own the CRM. |
| **Transfer capabilities** | ✔ Call transfer is a built-in function. **(exact warm-transfer behaviour unverified)** | ✔ The session ends with `handoffData`. Our `<Connect action>` endpoint then routes the call: `<Dial>`, voicemail, or a callback [T3]. |
| **Cost** (see §4) | ◐ About $0.09–$0.17/min all-in, depending on the LLM and voice chosen. | ✔ About $0.08–$0.14/min plus our own LLM tokens. Slightly cheaper at scale, but engineering time dominates at our volume. |
| **Privacy** | ◐ Retell states "SOC 2 certified, HIPAA-ready". The enterprise table lists custom data retention, opt-out of recording and transcription, and PII redaction, but which tiers include these did not render for us [R1]. **(tier availability unverified)** Call data sits with Retell plus its LLM/TTS sub-processors. | ◐ Call audio and transcripts pass through Twilio and its STT/TTS vendors. The LLM provider is whichever one we call, which can be the same Anthropic account the platform already uses (one less processor). |
| **Call recording controls** | ◐ Opt-out of recording/transcription is listed (enterprise row) [R1]. **(unverified on pay-as-you-go)** Our platform drops transcripts and recordings without consent either way. | ✔ Recording is off unless we explicitly enable it in TwiML or the API. We decide per call after consent. |
| **Reliability** | ✔ Managed service; the Founder has run it in production for another business. **(no published SLA checked)** | ✔ Twilio carrier-grade voice. ConversationRelay has been generally available since May 2025 [T4]. **Our** agent loop becomes a new failure point that we have to monitor. |
| **Separate business configuration** | ✔ **Yes.** One Retell account can hold several workspaces. Each workspace isolates agents, LLMs, knowledge bases, phone numbers, API keys, webhooks, telephony settings, billing (its own card, credits and invoices) and members. "A key from one workspace cannot access another workspace's data" [R2]. Workspaces are created manually in the dashboard; there is no API for it [R2]. | ✔ Create a Twilio subaccount or a dedicated account for Crestmont, with its own auth token and numbers. |
| **Time to first test call** | ✔ Days: configure an agent, add five functions, point the webhook at staging. | ◐ 1–2 weeks: WebSocket handler, LLM loop, tool dispatch, barge-in handling, observability. |

## 4. Cost estimate (illustrative, not a quote)

Assumptions: 300 inbound minutes per month (about 100 calls of 3 minutes), one local number, a mid-priced LLM.

| | Retell (pay-as-you-go) [R1] | Twilio + ConversationRelay [T1][T2] |
|---|---|---|
| Platform / orchestration | $0.055/min | ConversationRelay $0.07/min |
| TTS | $0.015/min (standard) to $0.04–$0.10 (ElevenLabs) | Included in ConversationRelay **(unverified: page says "voice costs are calculated separately", which may mean carrier minutes only)** |
| LLM | e.g. Claude 4.5 Haiku $0.025/min; GPT 5.4 $0.080/min | Our Anthropic tokens. Roughly $0.01–$0.03/min **(estimate, depends on prompt size)** |
| Telephony | $0.015/min | $0.0085/min inbound local |
| Number | $2/mo | $1.15/mo |
| **≈ per minute** | **$0.11 (Haiku + standard TTS)** | **≈ $0.09–$0.11** |
| **≈ per month at 300 min** | **≈ $35** | **≈ $30 + engineering** |

At this volume the difference is a few dollars a month. **Engineering effort and the risk of owning the real-time agent loop matter far more than per-minute price.** Every call cost the provider reports is stored in `calls.cost_microusd`. Where it is missing it shows as "Unknown", never 0.

## 5. Integration plan (either option)

- **Retell:** set the workspace webhook URL and function URLs to a small adapter route, for example `/api/webhooks/voice/retell`. The adapter verifies `X-Retell-Signature` with the **Crestmont workspace's** webhook key and maps `call_started` / `call_ended` / `call_analyzed` and function invocations into our envelope. It then calls the same `handleVoiceEvent()`. The tested guardrails (published pricing only, no customer-data leakage, consent-gated transcripts, idempotency per call id) all stay in our code.
- **Twilio:** the Worker serves TwiML `<Connect><ConversationRelay url="wss://…">`. A Durable Object holds the WebSocket, runs the Anthropic tool-use loop with the five functions, and calls `handleVoiceEvent()`.
- Either way: a new `VOICE_WEBHOOK_SECRET` per environment, and staging first. Test calls are labelled `is_test` and kept out of call metrics.

## 6. Recommendation (for Founder approval)

**Recommend option A: Retell AI, in a new, dedicated "Crestmont Website Development" workspace.** Revisit option B only if call volume grows enough for per-minute cost to matter, or if Retell's privacy terms turn out to be unacceptable.

Why: it meets every §51 criterion today with the least new code. The Founder already knows its quality and operation. Retell documents workspace-level isolation of agents, numbers, keys, webhooks, members **and billing**, which is exactly the separation §51 asks for.

**Conditions attached to this recommendation:**

1. **Separate workspace, never the existing one.** Create a new workspace from the workspace selector in the Retell dashboard (or a separate Retell account if the Founder prefers a hard boundary). **Do not open, edit, re-point, test against or reuse any agent, number, knowledge base, API key or webhook in the other business's existing receptionist workspace.** Crestmont's API keys, webhook key, card and invoices must be the new workspace's own.
2. **Founder-only purchases.** The Founder approves the cost and buys the number personally (or explicitly authorises it) after reading this document. This platform has no code path that buys numbers.
3. **Staging first.** Point the workspace at staging, run the test-call script, and record the results as evidence before any public number is published.
4. **Privacy review before go-live.** Confirm in Retell's current terms or DPA (a) which tier includes opt-out of recording/transcription and custom retention, (b) the list of sub-processors, and (c) whether call audio is used for training. Update the privacy policy draft (LEGAL-001) to cover AI call handling and recording consent.
5. **Agent prompt = the platform-managed configuration.** Paste the active version from `/staff/voice` (guardrails first). Changes go through new versions, never ad-hoc dashboard edits.

**Founder decision needed:** approve option A with the conditions above (or choose B), approve a monthly budget ceiling (suggested $50/month while volume is low), and decide toll-free vs local number. Then mark BLK-009 resolved and update VOICE-001.

## 7. Sources

Checked 2026-10-26. Prices change; re-check before purchase.

- [R1] Retell AI pricing page — https://www.retellai.com/pricing
- [R2] Retell AI docs, Workspaces — https://docs.retellai.com/accounts/workspace.md
- [R3] Retell AI docs, Secure webhook — https://docs.retellai.com/features/secure-webhook.md ; API keys — https://docs.retellai.com/accounts/api-keys-overview.md
- [T1] Twilio Conversational AI pricing ("current as of August 2026") — https://twilio.com/en-us/products/conversational-ai/pricing
- [T2] Twilio phone number pricing ("current as of August 2026") — https://www.twilio.com/en-us/phone-numbers/pricing
- [T3] Twilio `<ConversationRelay>` TwiML docs — https://twilio.com/docs/voice/twiml/connect/conversationrelay
- [T4] Twilio changelog, ConversationRelay GA (May 14, 2025) — https://www.twilio.com/en-us/changelog/conversationrelay-is-now-available-in-ga
- [V1] Vapi cost summary (CloudTalk, a competitor, updated Sept 2026; not neutral) — https://cloudtalk.io/blog/vapi-ai-pricing
- Secondary: eesel.ai Retell pricing guide — https://eesel.ai/blog/retell-ai-pricing ; Retell community thread on per-client workspaces (user opinions) — https://community.retellai.com/t/separate-workspace-for-each-business-client/3148

The Twilio US voice pricing page (https://www.twilio.com/en-us/voice/pricing/us) could not be fetched in this session, so recording and transcription per-minute prices are **unverified**.
