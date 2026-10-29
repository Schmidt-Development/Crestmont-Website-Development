# Crestmont design system — DESIGN.md (v3, reference-matched · dark colourway)

The governing specification for every Crestmont surface: public website, customer portal, staff and owner
dashboards, sign-in flows and token pages. Implemented in `public/assets/app.css` (tokens + components),
`public/assets/app.js` (behaviour and motion), `src/ui/layout.ts` / `src/ui/components.ts` (markup) and the public
page templates in `src/routes/public.ts`. Motion is specified separately in [MOTION.md](MOTION.md).

## 1. Concept

v3 follows the supplied reference's composition and motion. The approved **dark colourway** (owner decision after
reviewing the v3 recordings) replaces the reference's light pages: layout, type, artwork and motion are unchanged;
only colour differs.

- **Rich black pages, charcoal for emphasis.** Pages are `#080808`; cards and bands step up through near-black
  charcoals. The panels that carry the moments that matter — the featured package, "Working with Crestmont", the
  closing contact band, the hero price panel — are raised charcoal (`.on-dark`, `#141414`) with hairline borders.
- **White headings, grey supporting text.** Headings `#F5F5F5`, body `#E2E2E2`, supporting text `#B8B8B8`.
- **Gold is the accent, not the surface.** Primary buttons are solid Crestmont gold with dark labels; secondary
  buttons are outlined with a gold arrow square; check marks, active rails, tab underlines, selected chips, the
  switch pill and the hover fill are gold. Gold text uses the text-safe `--gold-1` (`#E6C582`).
- **Dimensional, original artwork.** Glossy gold, black lacquer and pearl objects rendered for Crestmont
  (`tools/art/render_illustrations.py`) carry the process, services and hero. No stock imagery; no reinterpretation
  of the logo.
- **Proof over decoration.** No invented testimonials, results, team, logos or discounts.

## 2. Brand assets (never altered)

| Asset | File | Native size | Rule |
|---|---|---|---|
| Crest mark | `public/assets/brand/crestmont-crest.png` | 84×82 | Shown at 42×41 CSS px (2× density) inside a black tile of its own background colour. Never upscaled. |
| Full lockup | `public/assets/brand/crestmont-logo-original.png` | 232×213 | Shown at ≤ 232 CSS px on black (sign-in panel). Never upscaled. |
| Favicons | `favicon-16.png`, `favicon-32.png` | — | Unchanged. |

Both PNGs have an opaque `#0D0D0D` background, so the crest sits in a `#0D0D0D` tile (`.brand__tile`) of exactly
that colour — on the `#080808` page it reads as a near-invisible badge, never a mismatch. On black surfaces the artwork is displayed with
`mix-blend-mode: lighten; filter: contrast(1.04)` so its flat background dissolves; the file is never modified.
A vector master remains a production request (see HANDOFF).

## 3. Colour tokens

The page token set (`:root`, also used by the footer, sidebar, sign-in panel and intro) and the raised-panel set
(`.on-dark`) share names, so every component works on both. Contrast measured (WCAG 2.1):

| Token | Page | Raised panel | Use |
|---|---|---|---|
| `--ink-0` | `#080808` | `#141414` | Page / panel |
| `--ink-1` | `#101010` | `#181818` | Band, bento card |
| `--ink-2` | `#141414` | `#1D1D1D` | Card |
| `--ink-3` | `#1A1A1A` | `#222222` | Control fill, table head |
| `--line` / `--line-2` | `#242424` / `#313131` | `#2C2C2C` / `#383838` | Hairlines |
| `--line-control` | `#737373` | `#767676` | Form-control borders, ≥ 3:1 on their fill |
| `--line-gold` | `#4F4128` | `#5A4B2E` | Subtle gold borders (featured card, secondary buttons) |
| `--white` (heading) | `#F5F5F5` | `#FFFFFF` | Strongest text |
| `--text` / `-2` / `-3` | `#E2E2E2` / `#B8B8B8` / `#959595` | same | Text (on page: 15.5 / 10.1 / 6.7:1; ≥ 4.7:1 on every raised surface) |
| `--gold-1` | `#E6C582` | same | Gold text and links |
| `--gold-2` | `#D7B56F` | same | Gold fills — the approved Crestmont gold (dark `#0D0D0D` labels on it: 9.9:1) |
| `--gold-pale` | `#F1DFB0` | same | Hover fill of solid-gold buttons (dark label: 14.7:1) |
| `--ok` `--warn` `--bad` `--info` | `#79C795` `#E4B652` `#E8877A` `#8DB2E2` | same | Status, always with words |
| `--focus` | `#F0D68F` | same | Focus outline |

`color-scheme: dark` and `<meta name="color-scheme" content="dark">` keep native controls, scrollbars and the
pre-stylesheet canvas dark; `html` and `body` are `#080808`, so overscroll never shows white. Print stylesheets and
the printable receipt stay black-on-white.

## 4. Typography

| Role | Family | Notes |
|---|---|---|
| Display | **Inter Display Medium** | Headlines, prices, KPI values, stage numbers. Tracking −0.035 to −0.045em, leading 1.0–1.06. |
| Text & UI | **Inter** Regular / Medium / SemiBold | Body, labels, tables, buttons. |

Both self-hosted (Latin-subset WOFF, SIL OFL 1.1, licence in `public/assets/fonts/Inter-OFL.txt`); three faces are
preloaded; no third-party requests. Section labels use a gold slash marker ("/ Our services"), sentence case.

## 5. Space, width, shape

- Spacing `--s-1…--s-10` (4–160 px). Content width 1240 px; hero and footer 1360 px. Gutters 16/24/40 px.
- Radii by hierarchy: 4 px small controls, 8 px buttons/inputs, 16 px cards, 24 px feature panels.
- Elevation: borders first; `--shadow-1` only on floating layers and the miniature browser.

## 6. Components

All earlier class names are kept. Additions: `.btn--cta` + `.btn__arrow` (arrow square), `.btn__fx` (tile hover
layer, built by app.js), `.brand__tile`, `.bento`, `.stages`, `.statement`, `.versus`, `.switch`, `.faq`,
`.showcase`, `.intro`, `.footer-word`. Buttons: primary = solid gold, dark label, black arrow square, hover fills with pale-gold
tiles; secondary = outline (subtle gold border), white label, gold arrow square, hover fills with gold tiles
(MOTION.md M03 — same choreography in both colourways).

## 7. Accessibility floor

WCAG 2.1 AA contrast (above); visible focus (2 px pale-gold outline; gold border + ring on fields); skip link; landmarks;
44 px targets on touch; forms announce errors; reduced motion shows everything immediately; every enhancement has a
no-JS equivalent (`nojs.css`, loaded through `<noscript>`).
