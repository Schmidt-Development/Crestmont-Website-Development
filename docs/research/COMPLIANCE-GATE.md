# Outbound eligibility gate for research prospects

**Status: closed. No research prospect can be released for automated (AI-voice) dialing.**

## Why
- **Founder decision D-14** (`docs/FOUNDER-DECISION-REGISTER.md`): the AI receptionist is inbound-only at launch. Any outbound use needs a new consent design and counsel review.
- **MSA Schedule C.7** and the Acceptable Use Policy (c) say Crestmont places no outbound AI or artificial-voice calls without documented prior express consent.
- **The existing outbound queue** (`src/services/voice-outbound.ts`) has only three purposes: callback, consultation reminder and support follow-up. There is deliberately no cold-call or marketing purpose.
- **Open data is not permission.** A business phone number in an open dataset says nothing about consent to be called by an AI voice. Being a B2B call is not a universal exemption.

## What the gate checks
The gate is `outboundEligibility()` in `src/domain/research.ts`, a pure function with tests in `tests/research.test.ts`. Every condition below must hold, and any unknown counts as a block:

1. A recorded legal/compliance approval for AI-voice outreach to research prospects (Founder + counsel, with a reference).
2. Documented prior express consent for artificial/AI-voice calls to that exact number.
3. A valid US number.
4. The number is not on the do-not-call list (`voice_dnc`). Opt-outs propagate to prospects immediately (`applySuppressions`).
5. The number does not belong to an existing CRM contact. Those follow the CRM record and its history.
6. The number is not shared with another business record, or a person has confirmed who it reaches.
7. A known recipient time zone, needed for calling windows. States that span zones return "unknown" and are never guessed.
8. A reliably known line type (mobile/landline). No free, permitted source for this exists today, so it is always "unknown".

Today conditions 1, 2 and 8 can never be met, so the dashboard's **"Verified callable today" is 0**, and that number is correct. The research agent never starts a call. Promoting a prospect creates a CRM lead for people to work, with "Not released for automated calling" written on the lead.

## Questions for counsel before any change
- How the TCPA treats AI-generated voices as "artificial or prerecorded voice" (FCC 2024 declaratory ruling), for calls to business landlines versus wireless numbers.
- Which consent is required for those calls, and in what form (prior express written consent for telemarketing).
- State rules: mini-TCPA statutes (for example Florida, Oklahoma, Maryland), state DNC registries, AI/bot disclosure laws, and calling-hour limits stricter than the federal rule.
- Whether to scrub against the National DNC Registry, and the subscription cost. That cost would be a paid data service, so it needs the Founder's approval under the $0-fee rule.
- Whether staff calling research leads manually is acceptable, and under which script and disclosure rules.

## What would change it
A counsel-approved design would add a dedicated purpose with its own consent capture, recorded with evidence. That is a migration plus a change to `voice_call_consents.purpose`. The gate's `complianceApproval` and `marketingConsentEvidence` inputs would then be read from real records instead of being `null`. That work is a separate, Founder-approved change. It is **not** part of this branch.
