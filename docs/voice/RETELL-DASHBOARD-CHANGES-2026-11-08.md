# Retell dashboard changes for the Founder (2026-11-08)

> **SUPERSEDED (2026-11-08, evening).** The Founder saved and republished both agents' master prompts after this was
> written. Do not use the instructions below, and never overwrite or revert either published prompt. The read-only live
> audits of the newly published versions (staging deploy run 42521194657, 20:45 UTC) found:
>
> - **Receptionist `agent_b6ed20f033422649ecf1aedd38`: 43/43 checks pass.** v4 is published and carries the saved
>   prompt (14,046 characters, sha256 prefix `6316b7dd75e0`). All 17 functions are named, 24/7 service holds with no
>   after-hours wording, callback booking uses `schedule_consultation`, and the Founder calendar is used only on request
>   (`wants_founder`). Warm transfer goes to `{{transfer_number}}`. Number …2055 routes to the latest published version.
> - **Sales agent `agent_bbb30864fb403d788a5a2784bc`: 42/44 findings ok.** v3 is published (13,851 characters, sha
>   `90aef151803548bb`). All nine functions match the backend and are named in the prompt. Two findings remain in the
>   live configuration:
>   1. *Voicemail message content*: the fixed voicemail text is unchanged (288 characters, sha `99a985f3aeec`). It
>      names Crestmont and gives a callback number, but does not say the caller is an AI. This is the voicemail
>      setting, not the prompt. Section 1 below still applies to that one setting only, and outbound calling stays off.
>   2. *SIE current version = live prompt*: the Sales Self-Improvement Engine's recorded version (v2) differs from the
>      newly published prompt. Until an Owner presses **Adopt live prompt** on /staff/sales-optimization, the engine
>      refuses to deploy over the live prompt, which protects the Founder's text. Adopting records the published prompt
>      as the engine's baseline and changes nothing in Retell.
>
> The receptionist's equivalent (**Adopt the live Retell prompt** on /staff/voice) is informational only. The platform
> pushes nothing while no version is active.

These changes are made by the Founder in the Retell dashboard. The platform never writes either agent's prompt or
settings during a deployment, and nothing in this document has been applied. Each change is saved as a **draft** first
and goes live only when the Founder reviews it and presses **Publish**. Leave the working configuration in place until
each change has been reviewed. Do not publish a prompt that has not been read in full.

**Source of the findings:** the read-only live audits from staging deploy run 42514825859 (2026-11-08 19:30 UTC),
`scripts/trigger-scheduler.ts retell-audit` and `retell-outbound-audit` (`src/services/retell-inbound-audit.ts`,
`src/services/retell-outbound-audit.ts`). The receptionist audit passed 40 of 43 checks. The outbound audit passed 44
of 45 findings.

Not changed: outbound calling stays off. Enabling it still needs the compliance and counsel approvals recorded in
`docs/voice/OUTBOUND-SALES-CONFIG.md`.

---

## 1. Outbound voicemail compliance (sales agent `agent_bbb30864fb403d788a5a2784bc`, outbound workspace)

**Finding (FAIL):** `voicemail message content: identifies Crestmont: true; gives a callback number: true; discloses AI: false`.
The approved fixed voicemail message (288 characters, sha256 prefix `99a985f3aeec`) names Crestmont and gives a
callback number, but it never says the caller is an AI. An AI voice counts as an "artificial voice" under 47 CFR
64.1200(b), so the message must identify the caller as one.

**Change, in Retell:** Agents → the sales agent → *Call Settings* → *Voicemail* → *Leave a message* (static text).
Replace the text with wording that keeps the **same callback number the current message already gives**, for example:

> Hi, this is Cimo, an AI assistant calling on behalf of Crestmont Website Development about your business's website.
> Please call us back at [the callback number already in the approved message], or visit crestmontwebsitedevelopment.com.
> Thank you.

The audit passes once the text has all three: the word *AI* (or *artificial*, *automated*, *virtual assistant*),
*Crestmont*, and a callback number (digits, spelled out, or `{{agent_number}}`).

**Ask counsel before publishing:** for prerecorded or artificial-voice telemarketing messages left on voicemail,
47 CFR 64.1200(b)(3) also asks for a toll-free callback number that leads to an automated opt-out. Whether the
callback line meets that requirement belongs in the counsel review the outbound launch already needs. It is not a code
question.

**Publishing:** the outbound agent's published version is **v2**. The draft is **v3**, and the audit confirmed v3
carries the same prompt as v2. Before publishing, open *Versions* and compare v2 with v3. Publish only if the voicemail
text is the sole difference, so that no unreviewed setting goes live alongside it.

## 2. Receptionist function awareness (receptionist `agent_b6ed20f033422649ecf1aedd38`, inbound workspace)

**Finding (FAIL):** `prompt names all 17 functions: not mentioned: crm_customer_lookup, crm_upsert_lead,
get_packages_pricing, create_checkout_session, check_payment_status, schedule_consultation, create_support_ticket,
send_customer_email, record_consent, request_callback, escalate, check_transfer_availability, get_business_hours,
record_opt_out, lo…` (the log line is cut off at this point). A related check also fails: `prompt: callback booking:
schedule_consultation is not named`.

All 17 functions are **configured correctly** on the agent: each matches the backend's URL, schema, timeout and retry
settings. What is missing is the prompt telling the model when to use each one. The live prompt is the Founder's own
12,492-character V4, written in the dashboard and authoritative. It refers to these actions in prose but never by
function name.

**Change, in Retell:** Agents → the receptionist → the LLM prompt (draft). Keep the Founder's text and add a section
like the one below. It is condensed from the repository's receptionist instructions (`INBOUND_MASTER_INSTRUCTIONS` in
`src/services/voice.ts`), which already pass all of these checks.

```
FUNCTIONS (use these exact tools)
- record_consent: once, right after asking to record; true only if the caller clearly agrees.
- get_packages_pricing: for any price, package, plan or add-on question; quote only what it returns.
- crm_upsert_lead: save a new enquiry (name, phone/email, interest, requirements); call again to add details.
- create_checkout_session: Starter, Business or Premium only, after confirming package, name and email.
- check_payment_status: with the checkout reference and the email it went to; read back only its message.
- schedule_consultation: book a 30-minute callback; first without start_time to get times, then with the chosen one.
  Pass wants_founder true only if the caller asks for the Founder.
- lookup_consultation / reschedule_consultation / cancel_consultation: for an existing booking (reference + phone).
- request_callback: when booking is unavailable, a function fails, or the caller wants a person and no transfer is possible.
- crm_customer_lookup: when someone says they are a customer; follow its next_step (it never reveals account details).
- create_support_ticket: support, project status, billing or invoice questions; read the reference back.
- escalate: refunds, cancellations, contract changes, complaints, anything urgent.
- check_transfer_availability: before any live transfer; transfer only if it returns transfer_available true.
- get_business_hours: staffed hours for live transfer only (you yourself are available 24/7).
- send_customer_email: only when the caller asks (package_information, or consultation_details for a booking made on this call).
- record_opt_out: when the caller asks not to be called again.
```

## 3. 24/7 availability (receptionist)

**Finding (FAIL):** `prompt: no after-hours limits: says Crestmont is closed: 1 as an instruction; switches to
message-taking: 1 as an instruction`. The positive check (`prompt: sells 24/7`) passes, so the prompt does say the
receptionist is always available. But it also contains **one sentence telling the agent to say Crestmont (or the
office) is closed**, and **one sentence telling it to take a message**. Neither sits inside a prohibition such as
"never …", and neither belongs to the voicemail (budget-mode) instruction. On a call outside staffed hours, those two
sentences contradict the Founder's 24/7 full-service decision.

**Change:** in the draft prompt, find those two sentences (search for "closed" and "message"). Replace them with the
repository's wording:

```
You work 24/7, holidays included. Never say Crestmont is closed or fall back to message-taking because of the hour.
Only live transfer depends on staffed hours.
```

Message-taking is still right in voicemail mode. Keep that instruction, but tie it to the mode, for example: *If
{{receptionist_mode}} is "voicemail", only take a message: … call request_callback …*. The audit accepts message-taking
wording when "voicemail" appears near it.

## 4. Unpublished agent versions

| Agent | Latest | Published | What callers hear |
|---|---|---|---|
| Receptionist `agent_b6ed20f033422649ecf1aedd38` | v4 (draft, not published) | earlier version | the **published** version, not the v4 draft |
| Sales `agent_bbb30864fb403d788a5a2784bc` | v3 (draft) | v2 | v2 (same prompt as v3) |

**Steps:**
1. Make changes 2 and 3 in the receptionist **draft**. Read the whole prompt, then publish it as one reviewed version.
2. Under *Phone Numbers*, open the receptionist's number. If it is pinned to a specific agent version, point it at the
   newly published version. If it follows the latest published version, nothing is needed.
3. In Crestmont, open **/staff/voice** and use **Adopt the live Retell prompt**, so the platform records the published
   text and its drift guard protects it. The platform does not push a prompt on its own.
4. Make change 1 on the sales agent and publish it after the comparison described in §1. Outbound calling stays off.

## 5. Checking the result

Run the staging deployment (`deploy-staging.yml`, any verification mode) or the audit button on
**/staff/voice/operations**. Expected results: receptionist **43/43**, and outbound **45/45** with `voicemail message
content: … discloses AI: true` and `published agent version` matching the reviewed version. Both audits only read; they
place no calls and write nothing to Retell.

Recorded but not failing (privacy decisions for counsel, unchanged): the receptionist's `data_storage_setting =
basic_attributes_only`; the sales agent's `data_storage_setting = everything` with post-call PII redaction (8
categories). The platform keeps transcripts only after `record_consent`.
