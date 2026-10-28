# Portfolio explorer and isolated demos

The portfolio is a horizontal explorer of **interactive demos**. Each one is a separate demo deployment built from a
verified revision of a project's source. Production sites are never embedded or proxied.
`src/ui/portfolio-explorer.ts` renders the explorer and `public/assets/portfolio.js` enhances it. The same component
is used on `/portfolio`, on the homepage work section and, with a single slide, on each `/portfolio/:slug` case study.

## Founder authorization (recorded 2026-10-27)

> "I, Noah Schmidt, founder, confirm: I own all four businesses/websites… authorize their names, logos, public website
> imagery, and demonstrations to appear in Crestmont's portfolio. Our team may claim full credit for developing them.
> Describe them accurately as founder-owned/in-house projects developed by our team."

This is recorded through the existing relationship-evidence fields (`relationship`, `relationship_evidence`,
`relationship_documented_at`) and appended to `audit_logs` (`portfolio.relationship_documented`) by
`scripts/portfolio-setup.ts`. The relationship text is "Founder-owned business — website designed and developed
in-house by the Crestmont team". Do not ask the Founder for this again.

## Data model (migration 0037, additive)

`portfolio_projects` gains these columns:

- `demo_url`
- `demo_status` (`none` | `ready` | `unavailable`)
- `demo_verified_at` and `demo_verified_by`
- `demo_revision` (`repo@sha`)
- `poster_desktop_asset` and `poster_mobile_asset` (`/assets/portfolio/*.webp`, genuine captures of the demo builds)

Staff → Portfolio → *Interactive demo* edits them (`POST /staff/portfolio/:id/demo`, audit `portfolio.demo_updated`;
changing the URL clears verification). Order, publication and copy use the existing controls. Counts, arrows and
labels are derived from the published records.

A demo is embedded only when **all** of the following hold. Otherwise the explorer shows the genuine poster with an
honest status line.

1. `demo_status = ready` with a verification date.
2. Its origin is listed in `PORTFOLIO_DEMO_ORIGINS`. Only https origins qualify, plus loopback http in
   `ENVIRONMENT=development`.
3. It is not the production site's host.

Only pages that render the explorer add those origins to `frame-src`. Crestmont keeps `frame-ancestors 'none'`.

## Repeatable setup

```
node --no-warnings scripts/portfolio-setup.ts --out portfolio.sql --origins "<origins>" --verified slug1,slug2
```

The script emits idempotent upserts with fixed ids, writes each audit row only once, and publishes a project only
when `publishBlockers()` is empty. The frontend-preview workflow runs it on every rebuild. Before marking a demo as
verified, the workflow checks from the runner that each demo answers `/__demo/info` with `"demo":true` and that its
`frame-ancestors` names the preview origin.

## Demo contract (each demo deployment)

- `GET /__demo/info` → `{"demo":true,…}`; `GET /__demo/reset` clears demo cookies and redirects (303) to `/`.
- `Content-Security-Policy: frame-ancestors <approved Crestmont origins>` (from `DEMO_FRAME_ANCESTORS`). No
  `X-Frame-Options`, `X-Robots-Tag: noindex`, cookies `SameSite=None; Secure; Partitioned`.
- `/__demo/embed.js` posts `{source:"crestmont-demo", type:"ready"|"navigate", href}` to each approved parent only.
  The parent accepts messages only from the slide's own demo origin, and shows the frame only after "ready", with a
  20-second fallback.
- External links go through `/__demo/leave`, an explanation page with "open in a new tab"; Turo links never
  silently start a booking.
- Server-side isolation:
  - its own D1 database with synthetic records;
  - production secrets are absent;
  - outbound `fetch` is deny-all except named public APIs (Glassly: NHTSA vPIC);
  - payments run against a simulated provider (BLM uses a signed simulated webhook through the real handler);
  - email is captured to a demo outbox;
  - owner, staff, portal, webhook and cron surfaces return 404;
  - no scheduled triggers or routes.

| Project | Demo worker | Source revision | Branch (not yet pushed) |
|---|---|---|---|
| Lansing Car Rentals | lansing-car-rentals-portfolio-demo | lansing-car-rentals@e11bf33 | lansing-car-rentals:crestmont/portfolio-demo-rentals |
| Glassly Auto Glass | glassly-portfolio-demo | glassly@dadad20 | glassly:crestmont/portfolio-demo |
| LCR Mentorship | lcr-mentorship-portfolio-demo | lansing-car-rentals@b3e0b17 | lansing-car-rentals:crestmont/portfolio-demo-mentorship |
| Better Lansing Mechanics | better-lansing-mechanics-portfolio-demo | better-lansing-mechanics@59ccaf4 | better-lansing-mechanics:crestmont/portfolio-demo |

Each branch carries a guarded workflow. It refuses to deploy unless the worker name ends in `portfolio-demo`, there
are no routes or triggers, and the database is the demo database. It then recreates the D1 database, deploys, and
smoke-checks the contract above. Each repository needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets
(scoped to Workers and D1 edit).

## Backend requirements (owned by the backend session)

- Apply migration 0037 to staging and production when the backend session schedules it.
- Set `PORTFOLIO_DEMO_ORIGINS` for the backend-owned environments when the demos are approved for them. The value
  is a space-separated list of https origins; unset means posters only.
- Optional: an R2 binding for the preview, if uploaded screenshots should replace the bundled posters.

## Deployment status and blockers (updated 2026-10-28, evening)

Isolation audit (read-only, `portfolio-demo-isolation-audit.yml`, run 40746359640 with `CLOUDFLARE_AUDIT_TOKEN`):
every Pages project (paginated, `per_page=10`) and all three Workers Builds triggers were read.

| Project | Cloudflare | Other hosts | Branch | Deploy |
|---|---|---|---|---|
| Glassly Auto Glass | ISOLATED (no trigger or Pages project) | Vercel: no status on any non-main push since 2026-09-03 (two branch pushes this week) | pushed `55cbfd1` | waits for `PORTFOLIO_DEMO_CLOUDFLARE_API_TOKEN` |
| Better Lansing Mechanics | ISOLATED (staging trigger `main` only, production trigger `production` only) | none | pushed `29dfa7b` (no Cloudflare build started) | waits for `PORTFOLIO_DEMO_CLOUDFLARE_API_TOKEN` |
| Lansing Car Rentals, LCR Mentorship | ISOLATED (staging trigger selects only `claude/session-2026-10-21`; Pages previews off) | Netlify `astonishing-sawine-f80069`: settings unread (needs `NETLIFY_AUTH_TOKEN`) | held locally (`964831d`, `31cb794`) | after the Netlify check, then the demo token |

Credentials:

- `PORTFOLIO_DEMO_CLOUDFLARE_API_TOKEN` — a dedicated token (Account › Workers Scripts › Edit, Account › D1 › Edit; no zone
  permissions) available to glassly, better-lansing-mechanics and lansing-car-rentals (an organization secret shared
  with the three is simplest). The demo workflows deliberately do **not** use a repository's `CLOUDFLARE_API_TOKEN`
  (better-lansing-mechanics' is its production backup token); each refuses a token that is inactive or can see zones.
  The account ID falls back to `CLOUDFLARE_ACCOUNT_ID` or is inferred by Wrangler.
- `NETLIFY_AUTH_TOKEN` (Crestmont repository, read-only use) — lets the audit read the Netlify site's branch-deploy
  settings. Until then lansing-car-rentals stays UNVERIFIED and its branches are not pushed.

After a demo deploys, the next frontend-preview deploy verifies it from the runner (`/__demo/info` and
`frame-ancestors`) before marking it ready; the hosted browser stage then drives it inside the explorer (scroll
containment by wheel and touch, navigation, reset, device controls, simulated transaction).

Demo kit fix (all four branches): framed, `scrollIntoView`, `focus` and in-page links scroll only the demo's own
document. Before, Glassly's in-page quote link also scrolled the Crestmont page around the frame.
