# Closeout continuation — resume here

Read this first in any new session working on the 104-finding closeout. The register
(`docs/closeout/crestmont-104-register.json`, rendered to `CRESTMONT-104-CLOSEOUT.md`) is the source of truth for
each finding's state; this file records batches, PRs and what to do next.

## Ground rules (from the Founder directive of 2026-10-29)

- Full commerce is the target; no quote-only substitute. Production payments stay gated behind live credentials,
  legal approval and a Founder flag.
- Non-blocking: anything needing a human or provider goes to the Founder/External action register; keep working.
- Never merge branches that restore the staging preview gate (`PREVIEW_GATE = "required"`) or roll
  `ACCESS_EPOCH` back from 3. PRs #8, #18, #19 predate public staging: cherry-pick their `src/` changes only.
- Do not recreate `crestmont-platform-frontend-preview`. Do not deploy production.
- Merging: on 2026-10-30 the Founder authorized sessions to merge passing PRs and deploy **staging** (never
  production). Merging to `main` triggers Deploy staging; required check `test` and branch protection stay on.

## Tooling notes

- Tests: `npm test` (unit/integration), `PLAYWRIGHT_MODULE=/opt/npm-tools/node_modules/playwright/index.mjs npm run e2e`.
- Typecheck in sandboxes without npm registry access: `ln -sfn /opt/npm-tools/node_modules/@types node_modules/@types`
  then `/opt/npm-tools/node_modules/.bin/tsc -p tsconfig.json`.
- Register: edit the JSON, then `node --no-warnings scripts/closeout-register.ts` (CI test fails if the markdown is stale).

## Current state (2026-10-29, after deploy #61)

- #37 merged as `64985d3`. Deploy staging run 61 (40919077179): build, tests, D1 provisioning, **migrations applied**,
  Worker deployed, access verified, smoke checks and "frontend served by this commit" all passed, so staging runs
  `64985d3` with migrations 0040–0046. Only the final gate failed: three staging browser tests failed.
- Root causes (reproduced on a local staging replica; the raw job log is not downloadable outside GitHub):
  1. Journey 4 opened `/q/[redacted` — the Owner's email viewer redacts tokens (correct for real customers), so the
     journeys could never follow their own proposal/verification links (CREST-NEW-003). Masked before CREST-GAP-030.
  2. The per-IP sign-in limit counted successful sign-ins (CREST-NEW-004); the deploy runner signs in every demo account
     many times from one IP, so later journeys were refused (probable cause of the other two failures; deploy #61's log
     could not be read — the next run publishes each failure as an annotation).
  3. Journeys 29–30 could never run (secret withheld from the browser step) (CREST-NEW-005); failure text truncated
     (CREST-NEW-006).
- Recovery PR: `claude/staging-61-recovery` (fixes above). Local staging replica after the fix: 19/33 passed, 0 failed;
  plus 29–30 pass through receipts — 21/33 expected on staging, the other 12 need Stripe/Retell/production.

## Staging recovery closeout (2026-10-30, deploy #76) — COMPLETE for the staging recovery scope

Staging serves `main` at `b0e7985` ([Deploy staging #76](https://github.com/Schmidt-Development/Crestmont-Website-Development/actions/runs/41143396093),
conclusion success, GitHub deployment 7450816755). Version proof: the "Frontend assets and homepage served by this
commit" step matched the SHA-256 of 10 served assets (including `app.css` and `app.js`) to the commit.
A full green run also happened on `fb348ca`, deploy #73.

| PR | Merge | What |
| --- | --- | --- |
| #53 | `e0ec01d` | Journey 29 exact run link; `/portfolio` 400 (harness `?to=`); Turnstile flexible/compact sizing (`/login`, `/register` 375px); contact orbs, FAQ address, intro grid; headings readable (axe under reduced motion plus a normal-motion readability pass) |
| #55 | `eca45a2` | axe `listitem`: `/about` journey `<ol role=group>`, GBP checklist, home anatomy tablist `<li role=presentation>` |
| #60 | `e629b3a` | A CRM E2E failure no longer skips hosted verification (continue-on-error plus a final gate) |
| #62 | `b0e7985` | The deploy waits, read-only, for the Owner's two-factor attempts (8 per 15 minutes) before using them; journeys enter codes in fresh steps |

Concurrent session (kept, not modified): #50 CRM identity, plus #56, #58, #59 and #61 (CRM staging E2E fixes). #57 was
closed as a duplicate of #56.

### Deploy #76 evidence

- **Hosted browser verification:** 256/256, with no console or page errors on desktop and phone.
  - Portfolio: 198/198, with all four demos interactive (no `/portfolio` 400).
  - Pages and interactions: 48/48, including no horizontal overflow on every public page at desktop and phone.
  - About: 10/10.
- **Staging tests:** design language (no overflow at 375px, `/login` and `/register` included), axe WCAG 2.1 A/AA, links
  and claims, and public/auth separation all passed.
- **Journeys:** 20/33 passed, 0 failed, including journey 29. That journey ingests this run's CI evidence document and
  checks that every result is shown on the exact run's page. This is the controlled count check: ingest → D1 → page.
- **CRM staging E2E:** 24/24.

### Not verified here

- **13 journeys** wait on external services (see below).
- **Mobile widths 320 and 360px** are covered by the local `tests/e2e/mobile-layout.e2e.ts` only. Hosted checks run at
  phone size and staging tests at 375px.
- **2 runner lockfile tests** are skipped until the lockfiles are committed.

This closes the staging recovery only; it is **not** a production-readiness statement.

## Next step for a new session

1. Read the recovery PR's CI; after merge, read the Deploy staging run's annotations:
   `gh api repos/Schmidt-Development/Crestmont-Website-Development/check-runs/<deploy job id>/annotations` — each
   failed journey is an `::error` with its message; "Staging certification" is a notice.
2. Fix any engineering failure on a new branch (never weaken a journey); record passes in the register.
3. Close #17 and #26–#36 (superseded; their commits are in main).

## Founder actions (deduplicated, by provider)

- **GitHub:** review and merge #37; production secret `PRODUCTION_MFA_ENCRYPTION_KEY` then Provision production
  (009); `v*` tag ruleset and production reviewer = Founder (054); variable `PRODUCTION_URL` at launch (015); five
  `BACKUP_*` production secrets, then one manual production-backup run (016); `@dependabot recreate` on #3/#5/#6/#7
  (063); merge glassly#1 and better-lansing-mechanics#24, and remove the preview origin from the two
  lansing-car-rentals demos (059).
- **Cloudflare:** confirm the zone, SSL Full (strict) and www redirect for the now-resolving domain (013); enable R2
  (055); real staging Turnstile keys (019); `wrangler secret put FOUNDER_EMAIL --env production` (020); delete the
  retired preview Worker and `frontend-preview` environment (058); `RUNNER_REQUIRE_NONCE=yes` once runners update (087).
- **Stripe:** account in test mode; webhook at 2025-02-24.acacia with the 17 events; billing portal, dunning,
  branding, dispute emails; staging test key (unlocks journeys 5–7, 24) (017, 038, 083). Live only after legal
  approval: `PAYMENTS_LIVE_AUTHORIZED=yes` + live key + live webhook secret (007, 008, 010).
- **Resend:** reported configured by the Founder; confirm the next Deploy staging shows the sending domain verified
  (012). Only if not: DNS records from docs/EMAIL-DNS.md.
- **Retell:** approve provider, workspaces, key, agent, URLs, number, spending limit, Owner budget, one test call
  (053; docs/voice/RETELL-CONNECTION-GUIDE.md) — unlocks journeys 27–28.
- **Business / legal / tax:** entity and address (011); attorney review of 12 policies (010); maintenance
  entitlements (050, 090); retention periods (057); accountant review of Michigan tax (084); approve RPO 24 h / RTO 4 h
  (016); staffed hours (049); AI Receptionist copy review (051); malware-scanner choice (052).
- **Security vendor:** commission the pen test from docs/security/PENTEST-SCOPE.md (056).
- **Other:** fix any published CMS `portfolio.intro` revision claiming production screenshots (048).

## Staging certification rule

CERTIFIED = 33/33 required journeys passed on one Deploy staging run (evidence/staging-certification.json). These
cannot pass until their dependency exists: 5–7, 17, 19, 24 (Stripe test key on staging), 25 (Stripe test clock — manual
check), 27–28 (Retell), 31–33 (Founder launch decision and a production deployment).
