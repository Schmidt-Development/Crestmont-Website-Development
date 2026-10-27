# Crestmont design system — DESIGN.md (v3, reference-matched)

The governing specification for every Crestmont surface: public website, customer portal, staff and owner
dashboards, sign-in flows and token pages. Implemented in `public/assets/app.css` (tokens + components),
`public/assets/app.js` (behaviour and motion), `src/ui/layout.ts` / `src/ui/components.ts` (markup) and the public
page templates in `src/routes/public.ts`. Motion is specified separately in [MOTION.md](MOTION.md).

## 1. Concept

v3 follows the supplied reference's composition — light sections, dark typography, black panels, one strong accent
— executed in Crestmont's identity: the unaltered gold crest, black, white and the crest's own gold.

- **Light by default, black for emphasis.** Pages are a warm light grey with white cards. Black panels carry the
  moments that matter: the featured package, "Working with Crestmont", the closing contact band, the footer, the
  sign-in brand panel and the app sidebar.
- **Gold is the accent, not the surface.** Arrow squares, check marks, active rails, the hover fill, the stage
  marker and the switch dot. Gold text on light surfaces uses the darker, text-safe `--gold-1`.
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

Both PNGs have an opaque `#0D0D0D` background, so on light surfaces the crest always sits in a `#0D0D0D` tile
(`.brand__tile`) — a deliberate badge, never a visible mismatch. On black surfaces the artwork is displayed with
`mix-blend-mode: lighten; filter: contrast(1.04)` so its flat background dissolves; the file is never modified.
A vector master remains a production request (see HANDOFF).

## 3. Colour tokens

Light (default) and black-panel (`.on-dark` and the dark shells) token sets share names, so every component works
on both. Contrast measured (WCAG 2.1):

| Token | Light | Black panel | Use |
|---|---|---|---|
| `--ink-0` | `#F2F1EE` | `#0D0D0D` | Page / panel |
| `--ink-1` | `#E9E7E2` | `#121211` | Band, bento card |
| `--ink-2` | `#FFFFFF` | `#171614` | Card |
| `--ink-3` | `#F8F7F4` | `#1E1D1A` | Control fill, table head |
| `--line` / `--line-2` | `#DEDAD3` / `#CBC6BC` | `#2B2925` / `#3A372F` | Hairlines |
| `--line-control` | `#8D887C` | `#6A655A` | Form-control borders, ≥ 3:1 |
| `--white` (heading) | `#0D0D0D` | `#FFFFFF` | Strongest text |
| `--text` / `-2` / `-3` | `#1B1A17` / `#4A4741` / `#686459` | `#ECE9E2` / `#B7B1A5` / `#969083` | Text (light: 15.4 / 8.2 / 5.2:1 on page) |
| `--gold-1` | `#7A5A1C` | `#E6C582` | Gold text and links (light: 5.6:1) |
| `--gold-2` | `#D7B56F` | `#D7B56F` | Gold fills (dark text on it: 9.9:1) |
| `--ok` `--warn` `--bad` `--info` | `#22663E` `#835C0E` `#AD3A2A` `#2B5D9B` | `#79C795` `#E4B652` `#E8877A` `#8DB2E2` | Status, always with words |

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
`.showcase`, `.intro`, `.footer-word`. Buttons: primary = black with gold arrow square (gold on black panels);
secondary = white with black arrow square; hover fills with gold tiles (MOTION.md M03).

## 7. Accessibility floor

WCAG 2.1 AA contrast (above); visible focus (2 px, dark on light, pale gold on black); skip link; landmarks;
44 px targets on touch; forms announce errors; reduced motion shows everything immediately; every enhancement has a
no-JS equivalent (`nojs.css`, loaded through `<noscript>`).
