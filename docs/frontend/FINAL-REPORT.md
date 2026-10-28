# Master frontend directive — final report

Branch `claude/frontend-redesign` (not merged into `main`). Preview: https://crestmont-platform-frontend-preview.partners-df4.workers.dev
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

Tests: **410 unit tests passing**. The local e2e and visual sweep also pass.

## 3. Portfolio demos — status: BLOCKED (screenshot fallbacks in use)

| Demo | Branch | State | Exact restriction |
|---|---|---|---|
| Glassly | `crestmont/portfolio-demo` | pushed (c1ebeeb); not deployed | `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit + D1 Edit) and `CLOUDFLARE_ACCOUNT_ID` missing at https://github.com/Schmidt-Development/glassly/settings/secrets/actions |
| Lansing Car Rentals (rentals, mentorship) | `crestmont/portfolio-demo-rentals`, `-mentorship` | local only (a707c26, 54c6e80) | Isolation unverified: Workers Builds / Pages / Netlify Git integrations exist, and the audit cannot read them |
| Better Lansing Mechanics | `crestmont/portfolio-demo` | local only (e5a9948) | same as above |

The isolation audit (latest re-run of 40646972719) returns **UNVERIFIED**:
- 6 Worker build configurations are unreadable (the token needs *Workers CI: Read*);
- Pages listing returns 403 (needs *Cloudflare Pages: Read*).

To unblock, add `CLOUDFLARE_AUDIT_TOKEN` (Workers CI Read, Pages Read, Workers Scripts Read) at https://github.com/Schmidt-Development/Crestmont-Website-Development/settings/secrets/actions, then re-run "Portfolio demo isolation audit". The demo branches are pushed only if the verdict is ISOLATED.

Netlify cannot be audited with Cloudflare tokens; confirm branch deploys are off for these branches in Netlify. Recovery bundles of all branches have been delivered. The "unavailable" messaging stays until hosted demos are verified.

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

## 7. Safety confirmation

The following were not touched:
- `main` (not merged or pushed);
- the production Worker and DNS;
- the shared staging Worker;
- the production and shared staging sites of the four businesses.

No secrets were committed or printed. Only `claude/frontend-redesign` (Crestmont) and the Glassly demo branch were pushed.
