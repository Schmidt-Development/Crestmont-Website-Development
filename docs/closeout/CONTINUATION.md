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
- **Merging requires a human.** The session's safety policy refuses merges without a review, so the single
  consolidated PR (#37) is opened green and handed to the Founder. Merging to `main` triggers Deploy staging.

## Tooling notes

- Tests: `npm test` (unit/integration), `PLAYWRIGHT_MODULE=/opt/npm-tools/node_modules/playwright/index.mjs npm run e2e`.
- Typecheck in sandboxes without npm registry access: `ln -sfn /opt/npm-tools/node_modules/@types node_modules/@types`
  then `/opt/npm-tools/node_modules/.bin/tsc -p tsconfig.json`.
- Register: edit the JSON, then `node --no-warnings scripts/closeout-register.ts` (CI test fails if the markdown is stale).

## Current state (2026-10-29)

- **One PR: #37 `claude/crestmont-final-104-closeout` → main.** It contains every commit of #26–#36 (verified by
  ancestry and a line-level loss check) plus CREST-NEW-002. Engineering head `1bdd603`: 606/606 unit, runner 92/92,
  e2e 37 passed / 0 failed (38 staging-only), tsc clean, migrations 0040–0046 replay cleanly on main's schema.
- Register: 70 EC-staging, 17 EC-external, 16 blocked on humans, 1 N/A, **0 open**; supplemental CREST-NEW-001/-002.
- Nothing merged, nothing deployed since the audit; staging still runs `92fee96` (the P0 is live there until #37 merges).
- Demo repos (separate, Founder merges): glassly#1, better-lansing-mechanics#24. lansing-car-rentals was not
  accessible to this workflow (059: two demos still list the retired preview origin).
- Live checks from the closeout workspace were not possible (shell egress blocked, robots.txt refuses the fetch tool,
  the browser bridge was offline). Observed: crestmontwebsitedevelopment.com answers (robots.txt served); the retired
  preview Worker returns a client error.

## Next step for a new session

1. If #37 is not merged: check its CI (`gh api repos/Schmidt-Development/Crestmont-Website-Development/pulls/37`),
   fix anything red on the same branch, and wait for the Founder's review. Do not reopen the 11 PRs.
2. After #37 merges: read the Deploy staging run (exact commit, migrations 0040–0046, cron registration) and the
   "Staging certification" summary. For each journey that passed, move its findings to CLOSED — VERIFIED in the
   register with the run link; failures are fixed on a new branch, never by weakening a journey.
3. Close #17 and #26–#36 with a comment pointing to #37 (their commits are in main), then follow
   docs/BRANCH-CLEANUP.md.
4. As the Founder completes provider steps (below), re-run Deploy staging and close the EC-external items.

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

CERTIFIED = 33/33 required journeys passed on one Deploy staging run (evidence/staging-certification.json). Today the
following cannot pass on staging by construction and keep it NOT CERTIFIED until their provider exists: 5–7, 17, 19,
24 (Stripe test key), 25 (needs a Stripe test clock — manual check), 27–28 (Retell), 31–33 (production launch).
