# Frontend redesign — integration handoff

For the backend session and whoever merges `claude/frontend-redesign`. The design specification is
[DESIGN.md](DESIGN.md), research is [RESEARCH.md](RESEARCH.md), and route coverage is [COVERAGE.md](COVERAGE.md).

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
| `public/assets/app.css` | Frontend | Rewritten as a token-based design system. **Every existing class name is kept**; new classes are added. |
| `public/assets/app.js` | Frontend | All existing behaviour is kept verbatim. Added: header state, accessible menus, toast dismissal, busy submit buttons, copy links, roving tablists, tab overflow hints. Bug fix: cancelling a `data-confirm` dialog no longer disables the form's buttons. |
| `public/assets/nojs.css` | Frontend (new) | No-JS fallbacks, loaded only via `<noscript><link>` (CSP-compliant). No render-blocking script is needed. |
| `public/assets/fonts/*` | Frontend (new) | Self-hosted Gloock and Instrument Sans: Latin-subset WOFF files plus their SIL OFL licences. Google Fonts is no longer requested. |
| `src/ui/layout.ts` | Frontend / shared | Same exports and signatures. New `crestRing()` export. The header, footer, auth shell (split layout) and app shell (scrim, avatar) are re-marked up. Accessible names used by tests ("Menu", "Sign out", sidebar labels) are unchanged. |
| `src/routes/public.ts` | **Shared** | Edits are limited to the public page templates: the `section()` helper, `serviceList()` (replaces `serviceCard()`), `anatomy()`, `processStepper()`, `ledger()`, and the `/`, `/services` and `/services/:slug` render bodies. CMS keys, form handling, prices, `data-testid`s, section ids and the CMS/portfolio admin are untouched. |
| `src/app/app.ts` | **Shared** | One line: `woff` and `woff2` MIME types added to `STATIC_TYPES` for the dev server. Production assets are served by the Cloudflare `ASSETS` binding. |
| `wrangler.toml` | **Shared** | Additive only: a new `[env.frontend-preview]` block placed **between** staging and production, which the gate test requires. The staging and production blocks are unchanged. |
| `.github/workflows/deploy-frontend-preview.yml` | Frontend (new) | Separate preview deploy. See §4. |
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
- **Gate:** `PREVIEW_GATE = "required"`, so it fails closed. A new random preview password is generated on every run.
- **Workflow:** `deploy-frontend-preview.yml` runs on pushes to `claude/frontend-redesign` and on manual dispatch.
  - A guard refuses to run if the target Worker or database is anything other than the preview's own.
  - It does **not** use `scripts/staging-access.ts`, which is hard-wired to `--env staging`.
  - Smoke checks: `/api/health` returns 200, `/` returns 401 (the gate), `/assets/app.css` returns 200.
- **Access:** each run uploads a private **`frontend-preview-access`** artifact, kept for 3 days. It contains the URL, the preview password and the demo accounts.
- **First run:** Actions run `40499029032` on `1760530` succeeded, including every guard and smoke step.
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

- **Crawl:**
  - 3,072 page audits across 506 concrete pages (237 route shapes).
  - Roles: public, customer, owner, sales, support and developer, at 1280px and 360px.
  - Every page was checked for horizontal overflow, console and page errors, exactly one `h1`, exactly one `main`, and broken images.
  - **0 open issues.**
- **Screenshots:** 114, at 320, 414, 820, 1280 and 1680px. Delivered separately as a zip.
- **Keyboard:** every focus stop on `/`, `/quote` and `/login` has a visible indicator. Menus and the drawer close on Escape and return focus. The anatomy and stepper tablists use arrow keys.
- **Reduced motion:** the hero renders complete with no animation (`prefers-reduced-motion: reduce`).
- **Contrast:**
  - Every text token measures ≥ 4.8:1 on every surface.
  - Form-control borders are ≥ 3:1.
  - The primary button is 9.9:1.
- **Backend `staging-quality` crawl:** the content, link and truthfulness rules pass against a local gated server. The axe-core sub-test was skipped, because axe-core cannot be installed in the build environment (package registries are blocked). It will run in the staging and preview workflows, which install it.
- **E2E (`npm run e2e`, local Chromium):** **34 passed, 0 failed, 37 skipped.** The skipped tests are staging journeys that need a deployed preview plus its access file.
  Two regressions found by this suite were fixed:
  - `AUTH-003` failed because a synchronous `boot.js` blocked HTML parsing during form round-trips, so the half-parsed page lacked the error text. It is replaced by `<noscript>` `nojs.css`. Verified 3/3 runs, and the baseline passes too.
  - `BRAND-004` failed because a decorative meter grow-in rendered 0px at the first frame. Operational screens no longer animate data.
- **Not verified here:**
  - Safari and Firefox rendering (only Chromium was available).
  - Browsing the hosted preview, since the build environment's egress policy blocks `workers.dev`.
  - Real device testing.
