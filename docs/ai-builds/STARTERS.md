# AI Builds: approved starters

Standard packages (Starter $999, Business, Premium) are built from an **approved, versioned starter** so every
first build begins from reviewed structure, accessibility and checks rather than from a blank directory. Custom
(quoted) projects use no starter.

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
| `starter.json` | Runner-side contract: per-package page limits, requirement keys, acceptance commands (not copied) |

### Acceptance check (`npm run check -- --package <id>`)

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
- Leftovers: any `STARTER-PLACEHOLDER`, any "lorem ipsum".

The runner runs this itself after the agent's verify phase (the agent's own claims are not enough), gives the agent
one repair round if it fails, and records each check as a `check:<id>` requirement: `verified` with the command as
evidence when it passes, `blocked` with the exit code when it fails. Browser verification (desktop/mobile,
keyboard, form behavior) is done by the agent with the Playwright/Webapp Testing skills and only counts as
`verified` when the evidence names a screenshot or command.

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
