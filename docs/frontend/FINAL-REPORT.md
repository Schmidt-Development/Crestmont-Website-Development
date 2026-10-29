# Master frontend directive — final report

> **Historical record (updated 2026-10-29, CREST-GAP-061).** This document describes the retired
> `crestmont-platform-frontend-preview` Worker and the `claude/frontend-redesign` branch. That work is merged into `main`
> and is deployed only to `crestmont-platform-staging` by `.github/workflows/deploy-staging.yml`. Evidence quoted below
> (including the preview's 256/256 hosted checks) came from the preview origin and is kept as history only; the current
> verification is the staging workflow's steps *Portfolio projects and their isolated demos*, *Frontend assets and
> homepage served by this commit*, *Browser journey on the live site* and *Frontend browser verification on staging*.
> See [`docs/CONSOLIDATION.md`](../CONSOLIDATION.md).

Branch `claude/frontend-redesign` (at the time of this report not merged into `main`; it has since been merged). Retired preview: https://crestmont-platform-frontend-preview.partners-df4.workers.dev
(password-gated; its own Worker and a disposable D1 database recreated on every deploy).

## 1. Commits

| Commit | Change |
|---|---|
| 7fcfacc | Pricing: cumulative packages from one structured feature model |
| ce36ad2 | Portfolio live links: `noopener noreferrer`, a live link on every case study, hosted link check |
| 6f246a0 | Portfolio framing: real device widths scaled to fit; full width always visible; native scrolling |
| a2474cc, c5d4481, efc1665 | Read-only demo-isolation audit (workflow + rules + annotations, optional dedicated token) |
| bf640e6 | AI Receptionist service, page, homepage section and call control centre |
| 3264de6 | Crestmont website assistant (chatbot) |
| b5840dd | About redesign |
| 83d2d82 | Contact redesign |
| 47d4270 | Hosted real-browser verification stage with recorded tours |

## 2. Hosted verification (real browser, GitHub runner)

Deploy run 40656877851 (commit 47d4270): **33 of 33 checks passed** at 1440×900 and 390×844:
- ten public pages: HTTP 200, no horizontal overflow, assistant launcher present, no console or page errors;
- pricing comparison is cumulative in every row;
- the portfolio frame shows the full site width;
- the AI Receptionist call completes with a summary;
- the assistant shows its honest offline state;
- About: the constellation, journey and live contrast checks work, and the CRESTMONT wordmark is preserved.

Contact: Turnstile is active on the preview, so the automated submission is skipped there. The submission path was verified locally and by unit tests.

Recordings and screenshots: artifact `frontend-preview-browser` on run 40656877851 (14-day retention, no credentials in it). The hosted live-link check passed in run 40646014955.

Tests: **411 unit tests passing** (after the review fixes). The local e2e and visual sweep also pass.

## 3. Portfolio demos — status: BLOCKED on credentials (screenshot fallbacks in use)

Superseded by the follow-up below and by the status table in `PORTFOLIO.md`.

## 4. Pricing audit and commercial decisions to confirm

- Prices are unchanged; `effectivePrices()` remains the source.
- One feature model (`PACKAGE_FEATURES`) drives the cards, the comparison and the assistant.

Decisions for the Founder:
- Future contract scope and build briefs now list inherited items. Existing projects keep their frozen scope.
- Integration quantities are undefined.
- Premium "Defined integrations" is the same as Business.

## 5. AI Receptionist

The service, page, homepage section and simulated call control centre are built and labelled "Simulated call · no real call, no audio".
- No voice provider has been purchased or connected, so voice styles are text previews only; no provider voices are named.
- Disclosure, consent and opt-out safeguards are described. There are no prices or guarantees (custom quote).

## 6. Website assistant (chatbot)

The assistant is built and shown on all public pages.
- It works only through the existing AI gateway. That gateway requires the Owner to enable paid AI and set `ai.monthly_budget_usd`.
- It is **offline (honest state) on the preview** because paid AI is not enabled; it is not live. Enabling it is an Owner decision.
- Limits: 600 characters per message, 10 turns, 450 reply tokens, per-IP and site-wide daily caps.
- Each answer's cost is recorded. Visitor text is not stored.
- Invented prices are withheld, and only approved site paths are linked.

## 7. Triple-pass review

1. Automated: the unit suite, the local e2e and visual sweep, and the hosted real-browser stage.
2. Self-review: fixed during the work (pricing dashes, touch-target sizes, overflow at 375px, the contact selector
   collision, the global submit guard).
3. Independent review of the new server and client code. No critical issues were found: no XSS, no CSRF bypass and
   no leaks. Six defects were found and fixed:
   - a double-submit could show "received" when the first request then failed;
   - a quote whose details row failed could be resubmitted and create a duplicate lead;
   - submission tokens reset at UTC midnight;
   - the public assistant could use up the whole staff AI budget (it now has its own 50% share, and its client-held
     history is size-capped);
   - the invented-price guardrail missed "dollars", "USD" and "% off";
   - the quote form's client and server message minimums differed.

   One minor point remains: without a session header, usage rows hash the IP unsalted. Visitors' browsers always send
   a session id, so this applies only to non-browser callers.

## 8. Safety confirmation

The following were not touched:
- `main` (not merged or pushed);
- the production Worker and DNS;
- the shared staging Worker;
- the production and shared staging sites of the four businesses.

No secrets were committed or printed. Only `claude/frontend-redesign` (Crestmont) and the Glassly demo branch were pushed.

## Follow-up (2026-10-28 evening): Glassly frame, About diagram, demo unblocking

**Fixed**
- *Glassly in the main explorer:* the explorer chose the device from the frame's width, so on 1000–1200px laptops the
  homepage/portfolio frames (narrower than the case-study frame) switched to the tablet layout; Glassly's full-bleed
  cover-video hero then appeared as an enlarged portrait crop. The device now follows the visitor's viewport, and
  desktop renderings keep the 16:10 frame at every width (no gap below the screenshot). Posters were confirmed genuine
  against the demo build.
- *About capability diagram:* nodes are placed from their complete bounds (label, selected ring, focus ring), kept
  inside the panel and clear of the core and each other; below ~380px the diagram stacks; connectors are redrawn from
  the final centres on resize. No clipping is used; without JavaScript the capabilities are a plain list.
- *Isolation audit:* Pages listing paginated (`per_page=10`, every page; the 400 was `per_page=100`); errors classified
  (400 invalid request vs 401/403 auth/permission vs network); per-repository verdicts; optional Netlify settings check.
- *Demo credentials:* demo workflows use only a dedicated `PORTFOLIO_DEMO_CLOUDFLARE_API_TOKEN` and refuse a token that
  is inactive or can see zones (better-lansing-mechanics' `CLOUDFLARE_API_TOKEN` is its production backup token).
- *Demo kit (all four):* framed demos keep `scrollIntoView`, `focus` and in-page links inside their own document — the
  explorer check found Glassly's in-page link scrolling the Crestmont page.

**Hosted verification** — deploy run 40757361020 (commit dd5483a): **176 of 176 checks passed** at 1440 desktop, 1180
laptop, 820 touch tablet, 390 phone and reduced motion: every explorer location and project frame (full width, arrows
outside the frame, honest state), the About diagram's six selections at four sizes plus keyboard, pages, pricing,
receptionist, assistant and contact. The demos show the screenshot fallback ("no-demo") because none is deployed.

**Locally verified against all four demos (154 checks):** interactive state after the origin-checked handshake;
wheel and finger-swipe scrolling to the end and past both boundaries with Crestmont stationary; scrolling outside
the explorer; internal navigation staying in the demo; forged messages ignored; Reset; 390/820/1440 device controls;
and each simulated transaction inside the frame with Crestmont stationary (LCR application → call booked; mentorship
booking → simulated checkout → confirmation → captured emails; Glassly instant quote → quote page; BLM wizard →
simulated checkout → confirmed booking). The same checks run on the hosted preview as soon as demos are deployed.

**Demo status:** Glassly and BLM — isolation verified, branches pushed, deploy waits for
`PORTFOLIO_DEMO_CLOUDFLARE_API_TOKEN`. Lansing Car Rentals and Mentorship — Cloudflare isolated; Netlify settings
unread (needs `NETLIFY_AUTH_TOKEN`); branches held locally.
