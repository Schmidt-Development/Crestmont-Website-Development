# Frontend redesign — integration handoff

For the backend session and whoever merges `claude/frontend-redesign`. The design specification is
[DESIGN.md](DESIGN.md) (v3, reference-matched), the motion specification and M01–M10 checklist is
[MOTION.md](MOTION.md), research is [RESEARCH.md](RESEARCH.md), and route coverage is [COVERAGE.md](COVERAGE.md).

## 1. Branch, base and status

- **Branch:** `claude/frontend-redesign` (pushed to `Schmidt-Development/Crestmont-Website-Development`).
- **Based on** `main` @ `c61b639`, with the latest `main` merged in (see `git log`). There are no conflicts with `main`.
- **Never pushed to or merged into `main`.** The shared staging Worker `crestmont-platform-staging` was not deployed, migrated, seeded or reconfigured by this work.
- **Checks on the branch:**
  - `tsc` passes.
  - `npm test` passes all suites.
  - The local browser E2E suites pass (34 passed, 0 failed; staging-only journeys are skipped).
  - The backend's `staging-quality` content and link crawl passes against a local gated server.

## 2. What changed, by ownership

| File | Owner | Change |
|---|---|---|
| `public/assets/app.css` | Frontend | Rewritten as the v3 token-based design system: light pages, black panels, gold accent. **Every existing class name is kept**; new classes are added (DESIGN.md §6). |
| `public/assets/app.js` | Frontend | All existing behaviour is kept verbatim. Added: header state, accessible menus, toast dismissal, busy submit buttons, copy links, roving tablists, tab overflow hints. Bug fix: cancelling a `data-confirm` dialog no longer disables the form's buttons. v3 adds the motion layer (MOTION.md): word reveals, one IntersectionObserver, one rAF scroll loop, tile-fill buttons, tile illustration swaps, package switch, FAQ disclosure. |
| `public/assets/nojs.css` | Frontend (new) | No-JS fallbacks, loaded only via `<noscript><link>` (CSP-compliant). No render-blocking script is needed. |
| `public/assets/fonts/*` | Frontend (new) | Self-hosted Inter Display Medium and Inter Regular/Medium/SemiBold: Latin-subset WOFF files plus the SIL OFL licence. Google Fonts is no longer requested. |
| `public/assets/art/*.webp` | Frontend (new) | 11 original dimensional illustrations (hero, 4 process stages, 6 services; ≈220 KB total), rendered by `tools/art/render_illustrations.py`. |
| `tools/art/render_illustrations.py` | Frontend (new) | Reproducible numpy SDF renderer for the artwork (`python3 tools/art/render_illustrations.py --out public/assets/art`). Not part of the Worker. |
| `src/ui/layout.ts` | Frontend / shared | Same exports and signatures. New `crestRing()` export. The header, footer, auth shell (split layout) and app shell (scrim, avatar) are re-marked up. v3: the crest sits in a `#0d0d0d` tile (`.brand__tile`); the M01 intro overlay renders on the first public page view of a browser session (session cookie `cm_intro`, never on POST re-renders, flash pages or errors). Accessible names used by tests ("Menu", "Sign out", sidebar labels) are unchanged. |
| `src/routes/public.ts` | **Shared** | Edits are limited to the public page templates: the `section()` and `pageHero` helpers, `serviceList()` / `serviceBento()` (replace `serviceCard()`), `anatomy()`, `processStages()` (replaces `processStepper()`; groups the 11 approved steps into 4 phases), `ledger()`, `packageCards()`, `showcase()`, and the `/`, `/services`, `/services/:slug`, `/process` and `/about` render bodies. CMS keys, form handling, prices, `data-testid`s, section ids and the CMS/portfolio admin are untouched. |
| `src/app/app.ts` | **Shared** | One line: `woff` and `woff2` MIME types added to `STATIC_TYPES` for the dev server. Production assets are served by the Cloudflare `ASSETS` binding. |
| `wrangler.toml` | **Shared** | Additive only: a new `[env.frontend-preview]` block placed **between** staging and production, which the gate test requires. The staging and production blocks are unchanged. |
| `.github/workflows/deploy-frontend-preview.yml` | Frontend (new) | Separate preview deploy, now with a byte-for-byte asset and homepage-marker check. See §4. |
| `tests/e2e/core.e2e.ts` | **Shared (test)** | `BRAND-001` only: instead of requiring a black `<body>`, it checks that the nearest opaque surface behind the crest is `rgb(13, 13, 13)` — the same guarantee (the logo's own background is never mismatched) now that pages are light. The 2× density and original-file assertions are unchanged. |
| `docs/frontend/*` | Frontend (new) | Specification, research, coverage and this handoff. |

**Unchanged:** business logic, payments, database schema and migrations, authorization, jobs, secrets, API routes and their request/response contracts, and every other route module.

### Merge notes

- `src/routes/public.ts` is the only file both sessions are likely to edit. If a conflict appears, keep the backend's data and handler changes and the frontend's template markup. The two are in separate functions.
- `public/assets/app.css` was rewritten wholesale. If the backend added CSS on `main` after `c61b639`, re-append it under §16 "Area-specific components". It will pick up the tokens automatically.

## 3. Backend follow-ups surfaced by the redesign (not changed by the frontend)

These are backend-owned decisions. The frontend did not hide them with CSS, because a hidden control is not access control.

1. **Links shown to roles that cannot open them.** The crawl found these returning 403 (or 404 for support):
   - Sales sees links to `/staff/projects/:id`, for example from CRM records.
   - Sales, support and developer see `/staff/ops/retention`.
   - Staff signed in on public pages see `Choose …` package links to `/checkout/*`, which 403 for staff accounts.
   
   **Request:** render these links only when `can(actor, …)` allows them, or render plain text in their place.
2. **Raw enum text in owner views.** Examples: "B (not_evaluable)" in readiness gate summaries, and `configured_unverified`-style values in some cells. **Request:** pass them through `label()` / `badge()`.
3. **A trailing separator in CRM kanban card meta.** Some cards end with a dangling "·" when a field is empty. **Request:** join the present fields instead of concatenating separators.
4. **Long timestamp cells wrap** in owner tables, for example the "Checked" columns. **Request:** a short datetime format for table cells.
5. **Minor markup inconsistencies:**
   - Several route templates set inline `style="font-size:…"` on `h2`. They render correctly, but should move to classes over time.
   - The owner "Open command center" link has button padding that offsets it from the card's text edge.

## 4. Independent frontend preview

- **Worker:** `crestmont-platform-frontend-preview`, at `https://crestmont-platform-frontend-preview.<workers-subdomain>.workers.dev`.
  - The subdomain matches the staging account (`partners-df4`). The full hostname is inferred from the deploy convention; it has not been browsed from the build environment.
- **Database:** its own D1 database `crestmont-frontend-preview`. It is **recreated and reseeded on every run**, using labelled sample data and `.test` demo accounts.
- **Excluded:** no R2 bucket and no cron triggers, so scheduled jobs never run twice.
- **Gate:** `PREVIEW_GATE = "required"`, so it fails closed. The preview password is the Founder's own GitHub secret
  `FRONTEND_PREVIEW_PASSWORD` (12+ characters). Without it the preview deploys **locked** (random values nobody holds).
- **Workflow:** `deploy-frontend-preview.yml` runs on pushes to `claude/frontend-redesign` and on manual dispatch.
  - A guard refuses to run if the target Worker or database is anything other than the preview's own.
  - It does **not** use `scripts/staging-access.ts`, which is hard-wired to `--env staging`.
  - Smoke checks: `/api/health` returns 200, `/` returns 401 (the gate), `/assets/app.css` returns 200.
  - Asset check: the sha256 of `app.css`, `app.js`, `nojs.css`, the display font and two illustrations served by the preview must equal the commit's files, and the gated homepage must contain the v3 markers (`class="intro"`, `data-statement`, `data-stages`, `class="bento"`, `data-switch`, `hero-build.webp`).
- **Access (public repository — no credential is ever uploaded or logged):**
  - Preview: open the URL and enter the Founder's `FRONTEND_PREVIEW_PASSWORD`.
  - Demo accounts (`owner@`, `administrator@`, `sales@`, `support@`, `developer@`, `customer.harbor@`,
    `customer.ridgeline@crestmont-preview.test`) use `FRONTEND_PREVIEW_DEMO_PASSWORD`, or `FRONTEND_PREVIEW_PASSWORD`
    when that optional secret is not set (`scripts/frontend-preview-access.ts`).
  - Staff demo accounts have no authenticator: two-factor stays required and the Founder enrols their own app on first
    sign-in (`/mfa/setup`). The database is recreated every run, so enrol again after each deploy.
  - Reset: change the secret, then run *Deploy frontend preview* again.
  - Every run verifies the path on the live preview (`scripts/frontend-preview-check.ts`): preview password →
    homepage → Owner sign-in → two-factor required. The run summary states the access steps and never a credential.
  - History: until run `40606533216` the workflow uploaded plaintext access notes; after the repository became public
    the Founder had all of them deleted, and those passwords stopped working when the preview database and password
    were recreated. PR #9 (encrypted notes) is superseded by this approach (no credential artifacts at all).
- **First run:** Actions run `40499029032` on `1760530` succeeded, including every guard and smoke step.
- **v3 run:** Actions run `40596685833` on `c60be7d` succeeded, including the byte-for-byte asset check and the homepage markers.
- **Retiring it:**
  1. Delete the workflow file.
  2. Run `wrangler delete --env frontend-preview`.
  3. Run `wrangler d1 delete crestmont-frontend-preview`.

## 5. Business facts still needed (owner decisions)

The redesign keeps the honest placeholders the platform already renders. These need real values:

- **Maintenance plan inclusions.** They are proposed but not approved ("Full plan details will be published here once finalised").
- **Staffed support hours**, needed on the contact page and support policy.
- **Legal business name and registered address**, needed on the disclosures, privacy and terms pages.
- **Portfolio.** Projects appear only once genuine screenshots and relationship documentation exist (BLK-008).
- **A vector master of the crest**, as SVG or PDF. The only approved artwork is a 232×213 PNG, so it is never shown larger than its native size. A vector master would allow a larger hero mark and print use. The frontend will not redraw it.
- **Attorney review of the legal drafts.** Already flagged in the existing legal pages.

## 6. Verification evidence and gaps

**Local verification** (development server, seeded with the staging seed, Chromium 153):

- **Crawl (v3 @ `c60be7d`):**
  - 3,182 page audits across 528 concrete pages.
  - Roles: public, customer, owner, sales, support and developer, at 1280px and 360px.
  - Every page was checked for horizontal overflow, console and page errors, exactly one `h1`, exactly one `main`, and broken images.
  - **0 open issues.**
- **Screenshots:** before (v2) and after (v3) sets at 320, 414, 820, 1280 and 1680px, captured after scrolling each page so reveals have run. Delivered separately as zips, plus side-by-side comparison sheets.
- **Recordings:** `crestmont-motion-desktop.mp4` (38.6 s, 1440-wide, captioned M01–M10) and `crestmont-motion-mobile.mp4` (21.2 s, 390-wide).
- **Keyboard:** every focus stop on `/`, `/quote` and `/login` has a visible indicator. Menus and the drawer close on Escape and return focus. The anatomy and stepper tablists use arrow keys.
- **Reduced motion:** every section renders complete with no animation, no intro and no pinning (`prefers-reduced-motion: reduce`).
- **No-JS:** with JavaScript disabled every section is visible (`nojs.css`); hidden reveal states only apply under `html.js`.
- **Contrast:**
  - Every text token measures ≥ 4.8:1 on every surface.
  - Form-control borders are ≥ 3:1.
  - The primary button is 9.9:1.
- **Backend `staging-quality` crawl:** the content, link and truthfulness rules pass against a local gated server. The axe-core sub-test was skipped, because axe-core cannot be installed in the build environment (package registries are blocked). It will run in the staging and preview workflows, which install it.
- **`npm test` (v3):** 311 passed, 0 failed.
- **E2E (`npm run e2e`, local Chromium, v3):** **34 passed, 0 failed, 37 skipped.** The skipped tests are staging journeys that need a deployed preview plus its access file.
  v3 fixes found by this suite: `BRAND-006` contrast (container link colours overrode button labels; the switch's selected state was transparent) — both fixed in CSS; `BRAND-001` updated as described in §2. A third, intermittent `BRAND-006` failure (≈1 run in 3) was traced to the package switch's first render: the selected label's colour transition started from dark grey on the already-black button for 280 ms. The first placement now applies without transitions; 8/8 isolated runs and two full E2E runs pass. Under reduced motion, all four process phases are now shown at full strength (they had kept the scroll-position dimming).
  Two earlier regressions found by this suite were fixed:
  - `AUTH-003` failed because a synchronous `boot.js` blocked HTML parsing during form round-trips, so the half-parsed page lacked the error text. It is replaced by `<noscript>` `nojs.css`. Verified 3/3 runs, and the baseline passes too.
  - `BRAND-004` failed because a decorative meter grow-in rendered 0px at the first frame. Operational screens no longer animate data.
- **Not verified here:**
  - Safari and Firefox rendering (only Chromium was available).
  - Browsing the hosted preview, since the build environment's egress policy blocks `workers.dev`.
  - Real device testing.

## 7. Remaining discrepancies against the reference (v3)

1. **Reference internals not inspected.** The reference's CSS/JS could not be fetched; every motion value was measured from the supplied recording (±33 ms) — see MOTION.md.
2. **Hosted preview not viewed.** CI proves the preview serves this commit's assets and markup byte-for-byte; a human look at the hosted page is the remaining check.
3. **Browsers.** Only Chromium was tested. Safari (sticky + WAAPI) and Firefox should be checked on the preview.
4. **Process grouping.** The reference shows 4 stages; Crestmont's 11 approved steps are grouped into 4 phases (Scope, Design, Build, Launch) with every step still listed. The `/process` page keeps all 11.
5. **Content by design.** No testimonials, client logos, team or blog sections — the reference has them; Crestmont has no approved material for them.
6. **Hero timing.** The hero settles in ≈1.4 s versus ≈2.3 s in the recording (the recording includes a longer load hold).
7. **Crest scale.** The crest stays at native resolution in a black tile; a vector master would allow the larger mark the reference uses.

## 8. Approvals needed (ordered by what they unblock)

1. **Review the hosted preview** (link and password in the run's `frontend-preview-access` artifact) and decide on merging `claude/frontend-redesign` into `main` — the merge is not done by this work.
2. **Business facts** in §5 (maintenance inclusions, support hours, legal name/address) — they unblock final copy on pricing, contact and legal pages.
3. **Crest vector master** — unblocks a larger hero mark and print use.
4. **Attorney review** of the legal drafts — unblocks publishing the policy pages as final.
5. **Portfolio material** with consent — unblocks the showcase (currently the "Portfolio in preparation" panel).

## 9. Dark colourway (palette-only change after design approval)

The owner approved the v3 design, layout, artwork and motion at `503749e` and asked for a colourway change only:
rich black pages, charcoal secondary surfaces, white headings, grey supporting text, the existing Crestmont gold.

- **Files:** `public/assets/app.css` (tokens + targeted hard-coded colours, the Anatomy miniature's mock site,
  one SVG icon stroke) and `src/ui/layout.ts` (one line: `theme-color` `#080808`, `color-scheme` `dark`).
- **No layout or motion change:** 10,226 elements on 12 pages at 1280 and 390 px, with and without reduced motion,
  have identical geometry, typography, text and transition/animation properties versus `503749e`; all 114
  role/width screenshots have identical dimensions.
- **States checked:** button hover fills (14.7:1 and 9.9:1), switch selected/unselected (9.9 / 7.9:1), FAQ expanded
  (10.1:1, `aria-expanded` true), field focus (gold border 10.7:1 + ring), validation text and invalid border
  (7.2:1), error summary (16.2:1), disabled buttons (45 % opacity, as before), loading skeletons (token-based).
- **No white flash:** first-visit frames captured from a mid-grey start page never exceed mean luminance 31/255;
  the pre-CSS canvas is dark via the `color-scheme` meta.
- **Artwork:** all 11 illustrations have fully transparent edges (no baked backgrounds); the crest files are unchanged.
