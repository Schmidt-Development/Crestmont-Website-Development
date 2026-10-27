# Crestmont design system — DESIGN.md

The governing specification for every Crestmont surface: public website, customer portal, staff and owner
dashboards, sign-in flows and token pages. Implemented in `public/assets/app.css` (tokens + components),
`public/assets/app.js` (behaviour) and `src/ui/layout.ts` / `src/ui/components.ts` (markup).

## 1. Concept — engraved craft

Crestmont's identity is a gold outlined crest on black. The system treats gold the way an engraver treats
gilt on a black plate: **fine line work and one solid mark**, never washes, glow or gradients-as-decoration.

- Gold is a signal. Per viewport: at most one solid gold control (the primary action — the public header CTA is a
  gold hairline so the page owns the solid one; it becomes solid inside the mobile menu), plus gold hairlines
  that carry structure (active navigation, the current step, the selected package, focus).
- Black is the material. Surfaces are warm, layered blacks; depth comes from hairlines and tone, not shadow.
- Type does the art direction. A high-contrast engraved serif for display; a crisp grotesque for everything
  you read or operate.
- Proof over decoration. The site sells website development, so its own craft — typography, motion, states,
  accessibility — is the demonstration. No stock imagery, no invented results, no decorative dashboards.

## 2. Brand assets (never altered)

| Asset | File | Native size | Rule |
|---|---|---|---|
| Crest mark | `public/assets/brand/crestmont-crest.png` | 84×82 | Shown at 42×41 CSS px (2× density). Never upscaled. |
| Full lockup | `public/assets/brand/crestmont-logo-original.png` | 232×213 | Shown at ≤ 232 CSS px. Never upscaled. |
| Favicons | `favicon-16.png`, `favicon-32.png` | — | Unchanged. |

Both PNGs have an opaque `#0D0D0D` background. **Any surface the artwork sits on must be exactly
`--ink-0` (#0D0D0D)** — header, sidebar, auth brand panel, hero ring centre — or a visible square appears.
Never recolour, crop, outline-trace, or regenerate the crest. Rendering note: the artwork is displayed with
`mix-blend-mode: lighten; filter: contrast(1.04)` so its flat near-black background (including a #0E0E0E patch in the
PNG) dissolves into the page; the gold shifts by ~1%. The file itself is never modified. A vector master is a production blocker (see
HANDOFF) — request one before print or very large display use.

## 3. Colour tokens

Golds are sampled from the logo artwork (`#E6C582`, `#D7B56F`).

| Token | Value | Use |
|---|---|---|
| `--ink-0` | `#0D0D0D` | Page; any surface behind the logo |
| `--ink-1` | `#121211` | Raised band (footer, table head, quiet cards) |
| `--ink-2` | `#171614` | Cards, panels, dialogs |
| `--ink-3` | `#1E1D1A` | Inputs, hover fills |
| `--ink-4` | `#272521` | Pressed, selected fills |
| `--line` | `#2B2925` | Default hairline |
| `--line-2` | `#3A372F` | Emphasised hairline, input borders |
| `--line-gold` | `#5A4B2E` | Gold hairline (selected / featured) |
| `--line-control` | `#6A655A` | Form-control borders — ≥ 3:1 against ink-0…ink-2 (WCAG 1.4.11) |
| `--gold-1` | `#E6C582` | Links, highlights, gold text on black |
| `--gold-2` | `#D7B56F` | Primary fill, active rails, focus base |
| `--gold-3` | `#A88B52` | Quiet gold rules and ornaments |
| `--white` | `#FFFFFF` | Headings |
| `--text` | `#ECE9E2` | Body text (15.9:1 on ink-0) |
| `--text-2` | `#B7B1A5` | Secondary text (9.1:1) |
| `--text-3` | `#969083` | Tertiary text (≥ 4.8:1 on every ink, measured) |
| `--ok` `--warn` `--bad` `--info` | `#79C795` `#E4B652` `#E8877A` `#8DB2E2` | Status — always paired with a text label |

Rules: status colour is never the only signal (badges carry words). Gold text only on `--ink-0..3`.
Primary button = `--ink-0` on `--gold-2` (9.9:1).

## 4. Typography

| Role | Family | Notes |
|---|---|---|
| Display | **Gloock** (single weight, high-contrast Didone-inspired serif) | Public h1/h2, prices, app page titles. Weight 400 only (`font-synthesis: none`). Never below 22px. |
| Text & UI | **Instrument Sans** (Regular, Italic, Bold) | Body, labels, tables, buttons, app headings h2–h4. 400–500 map to Regular, 600–700 to Bold. |
| Numbers | Instrument Sans, `font-variant-numeric: tabular-nums` | KPIs, tables, money. |
| Code | System monospace | Code blocks, ids, share URLs only — never decorative labels. |

Scale (1.25 minor-third steps, fluid at the top):
`--fs-xs .78rem · --fs-sm .875 · --fs-md 1 · --fs-lg 1.125 · --fs-xl 1.375 · --fs-2xl 1.75 ·
--fs-3xl clamp(2rem,3.4vw,2.6rem) · --fs-4xl clamp(2.5rem,5.2vw,4rem) · --fs-5xl clamp(2.9rem,8vw,6.6rem)`.

- Body 1rem / 1.65; measure ≤ 68ch (`.prose`, `.lede` ≤ 40rem).
- Display headings: tight leading (1.02–1.1), slight negative tracking at the largest sizes.
- No all-caps labels except the brand wordmark. Section labels are sentence case.
- Headlines are never accented by colouring or italicising one word.

Both families are **self-hosted** from `public/assets/fonts/` as Latin-subset WOFF files (≈105 KB total, two
preloaded) under the SIL Open Font License 1.1 (licence files alongside). No third-party font requests; the CSP's
`font-src 'self'` covers them. Bodoni Moda was the first choice; Gloock was adopted because it could be self-hosted
and verified in the build environment — the character (engraved, high-contrast) is the same.

## 5. Space, width, shape

- Spacing scale `--s-1…--s-10`: 4, 8, 12, 16, 24, 32, 48, 72, 112, 160 px.
- Widths: `--max` 1200px content; `--max-wide` 1360px for the hero and app pages; prose 68ch.
- Gutters: 16px phones, 24px tablets, 40px desktop.
- Radii carry hierarchy: `--r-1` 3px controls/badges-square, `--r-2` 6px cards/inputs, `--r-3` 12px
  dialogs and feature frames, `999px` pills and chips only.
- Elevation: borders first. `--shadow-1` only on floating layers (dropdowns, toasts, drawer, dialog).

## 6. Motion

One language, two timings, one curve.

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(.2,.7,.2,1)` | Everything entering or responding |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | Movement between two states (drawer, stepper) |
| `--t-fast` | 140ms | Hover, press, focus, colour |
| `--t-med` | 280ms | Menus, accordions, drawers, toasts, tab panels |
| `--t-slow` | 900ms | The single page-load moment (hero engraving) only |

- Only `transform` and `opacity` animate (plus colour/border for state changes).
- One orchestrated moment per page: on the homepage the crest ring engraves itself on load; elsewhere
  nothing animates unprompted. Section content is **never** hidden waiting for scroll.
- Motion answers people: menus open from their trigger, accordions expand, the drawer slides from the edge,
  buttons depress (scale .98), toasts rise, copied/saved states confirm.
- `prefers-reduced-motion: reduce` → all transitions collapse to instant; nothing loops; content identical.
- No scroll hijacking, no parallax, no continuous animation in operational screens.

## 7. Components (class contract)

All existing classes keep their names; the routes depend on them.

- **Buttons** `.btn` + `--primary` (one per view) · `--secondary` (gold hairline) · `--ghost` · `--danger`,
  `--sm`. 44px min height (34px `--sm`, 40px on touch). Press = scale .98. Disabled = 45% + not-allowed.
- **Fields** `.field` label above control, hint below, error below hint with `role=alert`,
  `aria-invalid` turns the border `--bad`. Focus = gold border + 3px gold ring at 22%.
- **Cards** `.card` hairline panel; `--gold` featured; `--feature` gold tick; `--link` whole-card link with
  hover hairline; `--quiet` low panel.
- **Badges** `.badge` pill with status dot + word; tones `--ok/--warn/--bad/--info/--gold`.
- **Tables** `.table-wrap` scroll container with hairline frame; header band `--ink-1`; numeric columns
  right-aligned tabular; row hover tint; long values wrap.
- **KPI** `.kpi` label (sentence case, small), value in tabular sans 1.75rem, optional `.meter`.
- **Page head** `.page-head` serif h1 + optional context line + right-aligned actions.
- **Navigation** public `.site-header` (sticky, solid ink-0); app `.sidebar` (ink-0, groups, gold rail on
  current), `.topbar` (area + account), `.tabs` (gold underline on current).
- **Overlays** `dialog`, `dialog.drawer` (right edge, slides 24px), `.toast` (bottom-right, rises),
  `details.disclosure` (animated +/− mark).
- **States** `.empty` (dashed frame, title, one action), `.skeleton` (shimmer, disabled in reduced
  motion), `.alert--info|success|warn|error`, `.error-page`, `.draft-banner` (environment).

## 8. Public layout patterns

- `.hero--home`: left-aligned display headline, lede, two actions; right: the lockup inside an engraved
  ring (SVG, decorative, `aria-hidden`). Below: `.commitments` strip of verified, catalogue-backed facts.
- `.section` with `.section__label` margin column (≥ 960px: label left 1/4, content right 3/4).
- `.index-list`: editorial service rows (name, summary, arrow) instead of card grids.
- `.anatomy`: the signature interactive concept (see §10).
- `.stepper`: the 11-step process; ordered list without JS, selectable detail panel with JS.
- `.ledger`: two-column hairline list for "why" and "capabilities" points.

## 9. App layout patterns

- Left rail 264px on desktop; off-canvas drawer below 960px with scrim, Escape closes, focus returns.
- Page head: one primary action; secondary actions as `--secondary`/`--ghost`.
- Dense data defaults: 14px table text, 12px header labels in sentence case, 12px vertical cell padding.
- Real data only. Unavailable values render as "Unknown", "Not configured" or an empty state — never 0.

## 10. Signature moment — "Anatomy of a build"

An interactive miniature website that assembles in six layers, each mapped to a real stage of the Crestmont
process (Scope review → Design → Development → Internal QA). Visitors choose a layer; the miniature changes
and a note explains what Crestmont checks at that stage. It is labelled **"Illustrative concept — not a
client project"**. Without JavaScript it renders as a complete, readable ordered list with the finished
miniature. Keyboard: arrow keys move between layers (roving tabindex, `role=tablist`).

## 11. Accessibility floor

WCAG 2.1 AA: contrast tokens above; visible 2px gold focus ring with offset on every control; skip link;
landmarks (`header`, `nav`, `main`, `footer`); 44px targets; forms announce errors; motion reduced on
request; every interactive enhancement has a no-JS equivalent.
