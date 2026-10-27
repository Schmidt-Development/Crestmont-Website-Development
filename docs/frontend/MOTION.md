# Crestmont motion map — reference-matched (M01–M10)

Reference: the supplied screen recording of the Sadewa template (47 s, 30 fps; only the site inside the
monitor is used) and the live page `https://sadewa.framer.website/` (structure read as text; its CSS/JS could
not be inspected from the build environment, so motion facts come from the recording). Timings below marked
**measured** were read frame-by-frame from the recording (±33 ms per frame). Values marked **chosen** are
implementation decisions, not measurements.

## Observed reference behaviour

| ID | Recording | Observed (measured from frames) |
|---|---|---|
| M01 | 0.00–1.50 s | Dark screen, small centred wordmark (≈1 s hold, partly page-load time). Wordmark disappears (≈1 frame), then a grid of ~12×7 near-square tiles clears in random order over **≈0.30 s** (1.20→1.50 s); each tile fades individually (grey intermediates visible). Page fully visible at 1.50 s with header already in place. |
| M02 | 1.50–2.40 s | Headline resolves word by word from pale grey to full black (1.67 "Smart", 1.83 "Smart AI Automation", 2.00 second line). 3D artwork, black media panel, paragraph and buttons fade in slightly behind the headline (2.00–2.17). Settled by **≈2.3 s** — about **0.8 s** after the tiles clear. |
| M03 | 3.70–4.97 s | Hover on "Work with us": the small arrow square switches to dark first (3.73), then the button fills with accent in **blocky tiles in random order over ≈0.27 s** (3.73→4.00). Pointer leaves → reverts in ≈1–2 frames. Dark button hover: dark breaks into accent tiles over ≈0.3 s (4.67→4.97); arrow square goes dark. |
| M04 | 5.70–10.40 s | Statement scrolls in and resolves word by word (6.17–6.83). It then **holds at viewport centre while scrolling continues** (7.0–10.2 s, sticky). Four small problem labels appear one by one at offset corners (≈7.8, 8.2, 9.2, 9.3 s), drifting slightly upward as scroll continues. Section then releases. |
| M05 | 10.50–11.80 s | "Automation solutions" heading resolves word by word; bento grid of light service cards with grey dimensional icons arrives as a group; "Latest works" cards with large dark imagery enter with text slightly after images. |
| M06 | 16.80–23.30 s | **Sticky left column** (stage number "/01" + large glossy illustration); stage title + description scroll in normal flow on the right. When the next stage's text reaches the reading line the number changes and the illustration **breaks into tiles and reassembles as the next object (≈0.17–0.25 s)**. Four stages over ≈6 s of scrolling. |
| M08 | 24.50–26.70 s | "The difference is clear" resolves word by word at centre; then a black panel (accent checks) and a light panel enter, the light panel sliding out from behind the black one. Normal flow (no hold observed). |
| M09 | 31.30–35.00 s | Section heading; three plans rise in a short stagger (light / black featured / light). Yearly↔Monthly segmented control: active pill slides; prices change with a short vertical roll/blur (33.50→33.67). |
| M10 | 35.30–43.00 s | FAQ: large three-line heading left, question list right with +/chevron. Closing CTA: black band, headline resolves, dimensional mark, accent button. Footer: black, link columns, oversized faint wordmark across the bottom. |

## Crestmont implementation map

| ID | Crestmont component | Trigger | Animation (chosen values) | Verification |
|---|---|---|---|---|
| M01 | `.intro` overlay (server-rendered on the first public page view of a browser session, `cm_intro` session cookie) with the approved crest PNG and a 12×7 tile grid | Page load | Crest holds 450 ms; tiles fade out in seeded random order over 300 ms (each 120 ms); overlay removed at 1.05 s. Pure CSS (no script needed to finish); `pointer-events: none` throughout; hidden for reduced motion and no-JS (nojs.css); never on POST re-renders, errors or later views. | Frame captures at 0/300/600/750/900/1100 ms; DOM check overlay removed; second view has no overlay |
| M02 | Hero headline split into word spans (`.reveal-words`), artwork, panel, copy, actions | Load (after M01 when present) | Words: opacity .12→1, 10 px rise, 45 ms stagger, 520 ms each; artwork/panel 120 ms after headline start; copy/actions 240 ms after. Text stays selectable; fixed-size artwork box (no layout shift). | Captures during sequence; CLS measured 0 |
| M03 | `.btn--primary`, `.btn--secondary` (tile fill) + `.btn__arrow` square on CTAs | Hover, keyboard focus-visible, press | Arrow square swaps first (80 ms); gold tiles (2 rows × width/22) fill in random order over 260 ms; each tile carries a black label copy, so text is black-on-gold or white-on-black at every pixel; leave reverts in 90 ms; press scales .98. Tiles built lazily on first hover/focus. | Hover captures at 0/90/180/300 ms; focus capture |
| M04 | `.statement` sticky stage (desktop): statement + 4 labels from the approved "Why Crestmont" titles | Scroll progress through a 220vh section | Words resolve over progress 0–0.25; labels appear at 0.32/0.44/0.56/0.68 (fade + 14 px settle) and drift −24 px across the hold; releases at 1.0. ≤ 760 px: not pinned; statement then labels as a 2-column list revealed on entry. | Captures at five scroll positions; mobile capture; no overlap check |
| M05 | Services bento (6 approved services, rendered dimensional icons) + portfolio showcase | Section entry (IntersectionObserver) | Heading words resolve; cards rise 24 px + fade, 70 ms stagger; image group before text group (+120 ms) in showcase; hover lifts icon 4 px and shows link arrow. | Entry captures |
| M06 | `.stages` controller: sticky number + 4 rendered illustrations; 4 phases built from the 11 approved process steps | Scroll position of each phase's text (reading line at 45% viewport) | Number rolls (old up / new from below, 240 ms); illustration tile transition 8×8 tiles, outgoing tiles clear and incoming assemble in seeded random order (≈320 ms total); interrupt-safe (an in-flight transition snaps to its end before the next starts); ≤ 760 px: illustration sits above each phase's text (no pinning) with the same tile assembly on entry. Keyboard/touch: normal scrolling; phase list also linkable. | Captures mid-transition; rapid-scroll test leaves consistent number/illustration/text |
| M07 | Anatomy of a build (existing, working tablist) | Click/keys (existing) + entry | Restyled to the light system; layer changes unchanged; entry reveal. | Existing E2E + capture of each layer |
| M08 | Statement + comparison: black "Working with Crestmont" panel (approved commitments) and light "What we will not do" panel (approved About-page list) | Section entry | Words resolve; black panel rises; light panel slides from behind (−48 px x) 160 ms later. No competitor claims. | Entry captures |
| M09 | Packages with a segmented control: "Website packages" / "Monthly care" (both real, purchasable catalogue items) | Entry; click/keys on the control | Cards rise in 80 ms stagger; pill slides 280 ms; switching sets swap with a vertical roll on prices (old up/out, new up/in, 260 ms). Without JS both sets are shown. Exact catalogue prices only. | Captures before/during/after switch |
| M10 | FAQ (details/summary enhanced), CTA band (black), footer (black, oversized wordmark) | Click (FAQ), entry | FAQ height transition 280 ms with rotating +; `aria-expanded` kept in sync; CTA words resolve + mark rises; footer columns stagger 60 ms. | Expand/collapse captures; aria state check |

## Global rules implemented

- Load sequences (M01, M02) are CSS-only; entry sequences use one shared IntersectionObserver (`data-reveal`),
  scroll-driven sequences (M04, M06) use one passive rAF-throttled scroll loop that only runs for sections near the
  viewport; hover/focus (M03) and click (M09, M10) are separate handlers.
- Elements already in view when the script starts (reload midway) are shown without animation; elements above the
  viewport are never hidden. Content is fully visible if the script fails (hidden states require `html.js`).
- `prefers-reduced-motion: reduce`: no intro, no tile effects, no reveals, M04/M06 unpinned; all content visible.
- Tile effects never flash: tiles only fade between two stable colours, never alternate (no strobe).

## Status checklist

Kept current in the final report: Implemented and verified / Implemented but unverified / Blocked / Not implemented.
