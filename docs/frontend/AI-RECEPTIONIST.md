# AI Receptionist — service, page and demonstrations

A standalone service (`ai-receptionist`, approved service "AI receptionist voice agents (inbound and outbound calls)"),
custom-quoted with no published price. It appears in:

- the homepage, as a section after "What we build";
- `/services/ai-receptionist`;
- the services index and the footer;
- the quote form (`/quote?service=ai-receptionist`);
- the voice agent's own service list (`APPROVED_SERVICES`).

## Truthfulness rules followed

- The assistant always identifies itself as AI. Copy promises natural, humanlike conversation as a design goal, never
  that callers cannot tell.
- Outbound calling is limited to contacts who have given the consent the law requires. The page lists the pre-call
  safeguards: consent on file, do-not-call and suppression checks, permitted hours, AI disclosure, and recording consent.
- **Voice provider status:** none has been purchased for Crestmont. Retell is recommended and pending the Founder's
  decision (`docs/voice/PROVIDER-EVALUATION.md`). The voice library therefore shows voice *styles* with sample lines
  and a waveform, labelled "text preview", and says that audio samples arrive once the provider is approved. No vendor
  voice names, accents or languages are claimed beyond "English standard; others such as Spanish where the provider
  supports them".
- **Demonstrations:** every demonstration is a labelled simulation, with a fictional business, fictional 555-01xx
  numbers, no audio, no network requests and no real calls.

## Control centre (`src/ui/receptionist.ts`, engine `receptionist` in `public/assets/services.js`)

There are three scripted scenarios:

- **Inbound "Book an estimate":** the assistant discloses that it is AI and asks for recording consent, asks
  follow-ups, remembers details, handles an interruption, books the visit, creates a CRM record, sends a confirmation
  and files a summary.
- **Inbound "Urgent → a person":** the assistant recognises urgency and makes a warm transfer to a team member, with
  the summary passed along.
- **Outbound "Appointment confirmation":** pre-call safeguards, disclosure, answering a question, rescheduling, CRM
  update, the opt-out reminder, and the next action.

Behaviour:

- It starts by itself when 45% visible; Play/Pause, Next line and Replay are always available.
- With reduced motion it shows the completed call immediately.
- Lines are announced to screen readers only after the visitor interacts.
- The transcript scrolls only inside its own box, so the page never moves.
- Without JavaScript, every scenario's full transcript and summary are shown.

## Real voice functionality (backend — not live)

The platform side is built and tested (`src/services/voice.ts`, the Retell adapter, `/staff/voice`). Going live needs
the Founder's provider decision, a separate Crestmont workspace, a number purchase approved by the Founder, staging
test calls, and the privacy review (BLK-009, VOICE-001 and VOICE-002).
