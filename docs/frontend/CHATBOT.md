# Crestmont website assistant

A branded assistant on every public page. The launcher, showing the Crestmont crest, sits fixed at the bottom right.
It is free for visitors (no account and no payment).

## Live functionality, honestly

- **Server:** `POST /api/assistant` (`src/services/assistant.ts`) uses the platform's approved AI gateway
  (`src/services/ai.ts`). It runs only when the Owner has set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, the
  model's price is known, and a monthly AI budget (`ai.monthly_budget_usd`) is set and not exhausted.
- **Availability:** `GET /api/assistant` reports whether live answers are available. When they are not, the widget
  says "Live AI answers off" and offers the pages and a person instead. It never shows scripted text as an AI reply.
- **Current state of the preview and staging:** paid AI is not enabled, so the assistant correctly shows the offline
  state. Turning it on is the Owner's decision: set the provider and key as Worker secrets and the monthly budget on
  the AI operations page.

## Grounding and guardrails

- Facts only from published sources:
  - effective package prices (the same figures as the pricing pages, including Founder-approved overrides) and the
    cumulative package features;
  - services (including the AI Receptionist) and payment rules;
  - published maintenance prices, never unpublished plan contents;
  - process, FAQs and contact routes.
- The system prompt forbids invented prices, timelines, guarantees and claims of being human. It also forbids
  advice, collecting sensitive data, and any account or order action.
- Any reply containing a dollar amount that isn't a published price is withheld. The visitor sees a pointer to
  `/pricing` and `/quote` instead, and the job is logged as a guardrail failure.
- Replies are rendered as text. Only server-approved site paths become links.

## Protections and cost

- Same-origin JSON only (Origin must match; `application/json` required).
- Per-IP limits of 8 requests per 2 minutes and 60 per day, and a site-wide limit of 1,500 per day.
- Messages are capped at 600 characters, with the last 10 turns sent, replies of up to 450 tokens, and a 25-second
  timeout with no retries. Because the history is held by the visitor's browser, earlier assistant turns are
  truncated to 1,200 characters and the whole history to 6,000 characters, which bounds the cost of every call.
- **Its own budget cap:** the public assistant may use at most **50%** of the Owner's monthly AI budget
  (`ASSISTANT_LIMITS.budgetShare`), so anonymous traffic can never exhaust staff drafting. When its share is used up it
  shows the offline state. (Concurrent requests near the cap can overshoot it by a few calls, each a fraction of a
  cent.)
- **Invented-figure guardrail:** a reply is withheld if it states an amount that is not a published price — written
  as `$…`, `USD …`, `US$…` or `… dollars` — or any percentage discount (none are published).
- Each answer is an `ai_jobs` row (`workflow = website_assistant`) with token cost, counted against the Owner's
  monthly budget (and the assistant's share of it) and visible with other AI usage. **No visitor text is stored**; the row carries only a hashed
  session reference.
- The conversation is kept in the visitor's tab (`sessionStorage`) so it survives page changes. Restart clears it.

## Accessibility and placement

- The panel is a non-modal dialog. Focus moves to the input on open and back to the launcher on Escape or close;
  the log is `role="log"` (polite).
- Keyboard: Enter sends and Shift+Enter adds a new line. Suggested questions are buttons.
- The widget hides while the mobile menu is open, while the portfolio's expanded view is open, or while a page form
  field has focus on a phone (keyboard up).
- It sits below the flash toast in the stacking order and respects safe areas. On phones the panel is a bottom
  sheet.
- With reduced motion, animations are off. It is not shown without JavaScript (the contact page and email remain).

## Tests

- `tests/assistant.test.ts` (Anthropic stubbed at the network): grounding, guardrails, fail-closed availability,
  origin and content-type checks, cost recording, no stored text, invented-price withholding, burst limit.
- `tests/security-fuzz.test.ts`: hostile and malformed bodies never produce a 5xx.
