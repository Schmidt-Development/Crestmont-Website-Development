# AI Builds: approved starters

Every package (Starter, Business, Premium and Custom) is built from an **approved, versioned starter**, so every
first build begins from reviewed structure, accessibility and checks rather than from a blank directory. New
builds are dispatched on **fullstack v1** with the quality engine required (`QUALITY-ENGINE.md`). The brochure v1
starter remains for builds that were started on it.

## How a starter is selected

The claim names it (`"starter": { "name": "brochure", "version": "1" }`). The runner maps that to
`runner/starters/<name>-v<version>/`, copies everything except `starter.json` into the new job repository as the
first commit, and fails the job if the directory or the package's profile is missing. The control plane decides
which version a project gets; a project keeps its version for revisions.

## brochure v1

Static multi-page site in `public/`, served by a Cloudflare Worker with static assets (`wrangler.jsonc`), no
dependencies.

| Path | Purpose |
| --- | --- |
| `public/*.html` | Home, About, Services, Contact, 404. Semantic landmarks, skip link, labelled form, `STARTER-PLACEHOLDER` markers |
| `public/assets/css/tokens.css` | Design tokens (color, type scale with `clamp()`, spacing, radius) the agent derives from the brand |
| `public/assets/css/site.css` | Mobile-first components, breakpoints 40rem / 64rem, reduced-motion support |
| `public/assets/js/contact.js` | Progressive enhancement; never claims a send unless the endpoint says ok |
| `src/worker.js` | `/api/contact` stub: validates, honeypot, then **503 "not connected yet"** (501 if only a provider name is set) |
| `scripts/check.mjs` | Offline acceptance check (below) |
| `STARTER.md` | Conventions the agent must follow |
| `starter.json` | Runner-side contract: per-package page limits, requirement keys, acceptance commands, protected checker files (not copied) |

### Acceptance check (`node scripts/check.mjs --package <id>`; `npm run check -- --package <id>` for the agent)

No network, no dependencies, Node 22+. Fails (exit 1) on:

- HTML validation-lite: doctype, `lang`, charset, viewport, tag balance, void-element misuse, duplicate ids.
- Internal links, assets and `#anchors` that do not resolve inside `public/`.
- SEO: missing title or meta description (all packages); canonical, `og:title`, `og:description` (Business,
  Premium); JSON-LD on the home page (Premium); `robots.txt` and `sitemap.xml` present, sitemap lists every page
  (warning on Starter, error above).
- Accessibility basics: exactly one `h1`, `main` landmark, `alt` on images, labelled form controls, link text.
- Responsive: viewport meta on every page and `@media` or `clamp()` in the CSS.
- Package: page count over the limit (5 / 12 / 25, matching `PACKAGES` in `src/domain/catalog.ts`), missing contact
  form posting to `/api/contact` with name/email/message.
- Leftovers: any `STARTER-PLACEHOLDER`, any "lorem ipsum", bracketed fill-ins such as `[Your Phone Number]`, unrendered
  template variables (`{{ ... }}`), `TODO`/`FIXME` in page text, placeholder image services (placeholder.com,
  placehold.co, picsum.photos, dummyimage.com, ...).

The runner runs this itself after the agent's verify phase (the agent's own claims are not enough), gives the agent
one repair round if it fails, and records each check as a `check:<id>` requirement: `verified` with the command as
evidence when it passes, `blocked` with the exit code when it fails. Browser verification (desktop/mobile,
keyboard, form behavior) is done by the agent with the Playwright/Webapp Testing skills and only counts as
`verified` when the evidence names a screenshot or command.

**Check integrity.** The agent can edit every file in its workspace, including the checker. Before each of its
acceptance runs the runner therefore (1) recreates the build's sandbox container, so nothing the agent left running
survives into the checks, (2) restores the files listed in `starter.json` `protected` (`scripts/check.mjs`,
`scripts/check-profiles.json`) from its own copy of the starter, never writing through a link the agent planted, and
(3) runs the checker directly with `node`, not through the editable `package.json` script. When a protected file had
been changed, the owner report says so ("Check integrity: ..."). The browser check (`/opt/crestmont/browser-check.mjs`)
lives in the sandbox image and loads only the image's Playwright, never a `playwright` package in the project.

**Brief conformance** (`check:brief-conformance`, computed by the runner from the brief snapshot; files are read,
nothing is executed): the customer's business name must appear on the home page, and the public email and phone the
customer gave must appear on at least one page. A failure gets the same repair round and blocks the preview like any
other failed check. This is an objective floor, not a quality judgement: design, copy and brand fit are decided in
the owner's review of the preview.

> brochure v1 was amended on 2026-10-28 (check integrity, brief conformance, template-leftover rules) **before any
> real build used it**, so the "immutable once released" rule below was not broken in practice. From the first real
> build on, further check changes go into `brochure-v2`.

### Package profiles (from `PACKAGES.includes`)

| Package | Pages | Requirement keys seeded by the starter |
| --- | --- | --- |
| Starter | ≤ 5 | pages within limit, responsive, basic SEO, contact form, analytics configuration (placeholder until an account exists), draft copy, licensed imagery |
| Business | ≤ 12 | pages within limit, expanded design customization, content structure, advanced forms within scope, defined integrations (stubbed until credentials exist), expanded SEO, responsive |
| Premium | ≤ 25 | pages within limit, bespoke design, advanced layouts/interactions, defined integrations, enhanced SEO, performance, responsive |

## Versioning rules

- A released starter directory is immutable in behavior. Fix typos freely; anything that changes structure, checks
  or limits becomes a new directory (`brochure-v2`) plus a control-plane change to start assigning it.
- `starter.json` `version` must equal the directory suffix.
- `runner/test/starter.test.ts` keeps page limits in `starter.json` and `scripts/check-profiles.json` equal to the
  catalog. Update all three together if package page limits ever change.

## Custom projects

No starter. The agent is asked for `.crestmont/requirements-map.md` (scoped line item → requirements and checks),
`ARCHITECTURE.md` (stack, data model, integrations, real vs stubbed), a scaffold with meaningful implementation of
the highest-priority requirements, and `REMAINING-WORK.md` (prioritized, sized). The runner runs whichever of the
project's `check`, `build` and `test` npm scripts exist; with none, the report says no automated checks were run.

## fullstack v1

A real business website: Cloudflare Worker + D1 + static assets, with no runtime dependencies. Configured from
`business.config.json`, which is filled only from the customer's brief; unknown facts stay `null` and are listed as
missing information.

| Area | What the foundation provides |
| --- | --- |
| Data | `migrations/0001_foundation.sql` (protected): settings, services, resources, customers, bookings + history, quotes, contact messages, payments, webhook events, idempotency keys, admin users, sessions, rate limits, audit log, notification outbox |
| Booking | Slots from hours, lead time, buffers, capacity, blackout dates and service area; time-zone and DST correct (`src/lib/time.js`); atomic capacity check on insert (no double booking); reschedule and cancellation rules |
| Payments | The **customer's own** Stripe account; server-side prices; idempotent Checkout sessions; signed webhooks with a timestamp tolerance; the amount is checked before a payment is marked paid; test and live modes are kept separate, and live needs `PAYMENTS_LIVE_AUTHORIZED`. No card data is ever stored |
| Admin | One-time setup with `ADMIN_SETUP_TOKEN`, roles, `__Host-` session cookie, CSRF (Origin + header), rate limits, audit log |
| Notifications | Outbox through the customer's own Resend account; queued until the sending domain is verified |
| Gates | `scripts/gates.mjs --package <id>`: A requirements, B frontend, C backend, D database, E integrations, F security, G performance, J deployment. The runner adds H (browser) and I (independent review) |

Package capabilities (from `scripts/packages.json`, protected):

| Package | Capabilities |
| --- | --- |
| Starter | contact, admin, notifications |
| Business | + quotes, booking, payments |
| Premium / Custom | + customer accounts |

A requested feature outside the package is recorded as a scope change for a change order; it is never silently
built or dropped. Public package descriptions are unchanged by this starter; any change to them needs the
Owner's approval.
