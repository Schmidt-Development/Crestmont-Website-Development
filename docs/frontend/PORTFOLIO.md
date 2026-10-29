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

## Data model (migration 0038, additive; numbered 0037 on the retired frontend-preview branch)

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

- Migration 0038 is applied to staging by deploy-staging.yml (consolidation PR). Production receives it only through the Founder-approved production deploy.
- Set `PORTFOLIO_DEMO_ORIGINS` for the backend-owned environments when the demos are approved for them. The value
  is a space-separated list of https origins; unset means posters only.
- Optional: an R2 binding for the preview, if uploaded screenshots should replace the bundled posters.

## Deployment status (2026-10-28, 19:50 ET) — all four demos live and connected

Isolation audit run 40783606013: ISOLATED for every repository (Workers Builds triggers `main`, `production`,
`claude/session-2026-10-21`; Pages previews off; Netlify branch deploys only `claude/session-2026-10-21`, PR previews off).

| Demo | URL | Demo workflow run |
|---|---|---|
| Lansing Car Rentals | https://lansing-car-rentals-portfolio-demo.partners-df4.workers.dev/ | lansing-car-rentals 40785029945 |
| LCR Mentorship | https://lcr-mentorship-portfolio-demo.partners-df4.workers.dev/ | lansing-car-rentals 40785033696 |
| Glassly Auto Glass | https://glassly-portfolio-demo.partners-df4.workers.dev/ | glassly 40785026514 |
| Better Lansing Mechanics | https://better-lansing-mechanics-portfolio-demo.partners-df4.workers.dev/ | better-lansing-mechanics 40785531768 |

Each demo workflow passed its scope guard, isolation, framing and blocked-route smoke checks. Frontend preview run
40787390976 (commit 98ba751) verified each demo from the runner, connected all four, and passed 256/256 hosted
browser checks, including every demo's scroll containment, navigation, reset, device controls and simulated transaction.

Demo token scope guard: listing zones is not evidence of zone permissions — the token (Account › Workers Scripts ›
Edit, Account › D1 › Edit) sees zone metadata, but every zone surface (settings, DNS, Workers routes, rulesets, page
rules, SSL) answers 403. The guard fails on any readable zone surface, more than one account, or unusable Workers/D1.
