# Worker consolidation: frontend-preview → staging

**Goal:** exactly two Crestmont application Workers.

| Worker | Role after consolidation |
|---|---|
| `crestmont-platform-staging` | Complete frontend + backend (auth, MFA, encryption, D1, Resend, Retell, AI Builds, readiness). Deployed from `main` by `deploy-staging.yml`. |
| `crestmont-platform-production` | Unchanged and protected. Deployed only by `deploy-production.yml` after Founder release approval. This PR does not deploy it. |
| `crestmont-platform-frontend-preview` | **To be retired** after staging is verified live and the Founder authorizes it (§5). Not touched by this PR. |

No Worker is renamed and no third Worker is created. Consolidation means the source, assets, routes and configuration
of the preview now live in the staging Worker's codebase (`main`), and staging serves them at its existing URL.

## 1. What was inspected

| Worker | Source (from GitHub deployment records) | Notes |
|---|---|---|
| frontend-preview | `claude/frontend-redesign` @ `93cd51c` | 47 commits after merge base `17c38f0` (PR #15). |
| staging | `main` @ `12abaf7` (PR #21) | 16 commits after the same merge base: workflows, credential rotation, sealing, forensics. |
| production | `main` @ `4358fc2` | Not modified. |

`claude/frontend-preview-encrypt-access` (PR #9) was **not** merged: `docs/frontend/HANDOFF.md` records it as superseded
(the preview stopped producing credential artifacts entirely).

## 2. What moved into staging

The two lines of work touched disjoint files except `wrangler.toml`, and git merged them without conflict.

- **Frontend (from the preview):** design v3 (`public/assets/app.css`, `app.js`, `nojs.css`), Inter fonts, artwork,
  portfolio posters, `assistant.js` / `portfolio.js` / `services.js`; templates in `src/ui/*` and `src/routes/public.ts`;
  website assistant (`src/services/assistant.ts`, `/api` route); portfolio explorer and isolated-demo framing
  (`src/services/portfolio.ts`, per-response `frame-src`); catalog/pricing inheritance; `woff`/`woff2` content types;
  21 new tests; frontend docs under `docs/frontend/`.
- **Backend (already on `main`, preserved unchanged):** every file from the seven completed sessions. The merge altered
  none of `src/lib/auth-crypto.ts`, `totp-secrets.ts`, `src/app/preview-gate.ts`, `step-up.ts`, `src/adapters/*`,
  `src/routes/auth.ts`, `hooks.ts` or any migration through `0037_deploy_secret_fingerprints.sql`.

### Integration changes made in this PR

| Change | Why |
|---|---|
| `migrations/0037_portfolio_demos.sql` → `0038_portfolio_demos.sql` | Both branches created a `0037_*`. Wrangler tracks by filename, so both would apply, but a unique, ordered number keeps staging and the later production release unambiguous. Additive only (nullable columns + CHECKs). |
| `PORTFOLIO_DEMO_ORIGINS` added to `[env.staging]` vars | Without it staging refuses to frame any demo. Same four origins the preview used. Production still has none. |
| `[env.frontend-preview]` removed from `wrangler.toml`; `deploy-frontend-preview.yml`, `scripts/frontend-preview-access.ts`, `scripts/frontend-preview-check.ts` removed from `main` | `main` can now deploy only staging and production. The preview Worker itself is untouched and can still be redeployed from `claude/frontend-redesign` (rollback, §4). |
| `deploy-staging.yml`: new step **Portfolio projects and their isolated demos** | Every deploy, with `--preserve-edits`: full setup only for rows nobody has documented yet (the migration-0005 placeholders); afterwards only demo verification is refreshed, so Staff → Portfolio edits (copy, order, unpublishing, posters) are never overwritten. A demo is marked ready only if, from the runner, it answers `/__demo/info` and its `frame-ancestors` names the **staging** origin. |
| `deploy-staging.yml`: new step **Frontend assets and homepage served by this commit** | sha256 of 10 key assets must equal the commit's files; gated homepage must contain the v3 markers; 9 public pages must return 200. No secrets. |
| `deploy-staging.yml`: new step **Frontend browser verification on staging** + artifact `staging-frontend-browser` | The preview's real-browser suite, now against staging. Installs Playwright with no secrets in the step (F-24); screenshots are written under `evidence/` (INFRA-002 upload rule). |
| `scripts/frontend-preview-browser.mjs` → `scripts/frontend-browser-check.mjs`; contact submission opt-in (`ALLOW_TEST_SUBMISSION=1`) | Staging's database persists and Resend is live, so the browser suite fills the contact form but never submits it there. |
| `portfolio-demo-isolation-audit.yml` triggers on `main` | Its old trigger branch is being retired. Read-only audit; deploys nothing. |
| `docs/frontend/HANDOFF.md` retirement steps replaced by §5 here | The old steps included `wrangler d1 delete`, which this consolidation forbids. |

Security posture is unchanged: no test was weakened; CSP, `X-Frame-Options: DENY`, HSTS, preview gate (fails closed),
MFA, step-up, encryption and secret scoping are as on `main`.

## 3. Verification

### Done before merge (this PR, local)

| Check | Result |
|---|---|
| Typecheck `tsc -p tsconfig.json` | 0 errors (branch and `main` baseline) |
| `npm test` | **441 passed, 0 failed** (`main`: 420 passed). Includes F-23/F-24/INFRA-002 workflow-security tests on the new steps. |
| `npm run e2e` (local Chromium) | **34 passed, 0 failed, 38 skipped** (skipped = staging-only journeys that need the deployed URL) |
| Frontend browser suite against a local server of the merged code, seeded with the staging seed + portfolio setup | **176 passed, 0 failed** (desktop + phone, all 10 public pages, pricing inheritance, services, About diagram, portfolio explorer, assistant launcher, contact form) |
| Portfolio setup on a migrated database | First run publishes the 4 projects with posters; after a Founder unpublish + rename, the next run keeps both and only updates demo status; idempotent, no slug conflicts with migration 0005 rows |
| Security headers on `/`, `/portfolio`, `/login`, `/api/health` | CSP, `X-Frame-Options: DENY`, HSTS, nosniff present; no demo origin in `frame-src` while none is verified |
| `[env.production]` block | byte-identical to `main` |

The preview's 256 hosted checks included ~80 interactive-demo checks that run only when a demo is embeddable; with no
demo verified for staging they are skipped and the explorer shows posters (§5 blocker B1, resolved 2026-10-29: the demos now allow the staging origin).

### Done after merge (live, by `deploy-staging.yml` on push to `main`)

Restore point (D1 Time Travel bookmark) → migrations (0038) → deploy → access rotation checks → smoke →
**frontend assets/markers** → existing staging E2E (`staging*.e2e.ts`: auth, MFA, journeys, quality/axe) →
**frontend browser suite** → evidence posted to the readiness command center.

### Carried into the next production release (not deployed by this PR)

Production receives this code only through a Founder-approved release. When that happens:
- migration 0038 applies to the production database (additive);
- `POST /api/assistant` exists but stays unavailable unless `AI_PROVIDER=anthropic`, an API key and a monthly budget are set;
- a bundled `/assets/portfolio/*.webp` poster counts as the genuine screenshot required to publish a portfolio project
  (`publishBlockers`), a policy change from today's production behavior;
- production has no `PORTFOLIO_DEMO_ORIGINS`, so it frames no demo (posters only).

## 4. Rollback

- **Code:** revert the merge commit on `main`; `deploy-staging.yml` redeploys the previous staging build. Or
  `wrangler versions deploy <previous-version>@100% --env staging` (the mechanism rehearsed by `staging-rollback-rehearsal.yml`).
- **Database:** migration 0038 is additive (old code ignores the new columns). The deploy records a D1 Time Travel
  bookmark before migrating; `docs/BACKUP-RECOVERY.md` covers restore.
- **Preview fallback:** until §5 is complete, `crestmont-platform-frontend-preview` stays deployed and can be redeployed
  from `claude/frontend-redesign` (its workflow still lives there).

## 5. Retiring `crestmont-platform-frontend-preview`

### Blockers found (must be cleared first)

| # | Dependency on the preview URL | Action |
|---|---|---|
| B1 | **Resolved 2026-10-29.** Live checks showed all four demo Workers' `frame-ancestors` already include `https://crestmont-platform-staging.partners-df4.workers.dev`, so staging can embed them; the *Deploy staging* step *Portfolio projects and their isolated demos* verifies this on every deploy. *Original finding:* all four demo Workers allowed framing **only** by `https://crestmont-platform-frontend-preview.partners-df4.workers.dev` and the production domain (`DEMO_FRAME_ANCESTORS` in each repo's `portfolio-demo/wrangler.jsonc`; confirmed in `glassly@crestmont/portfolio-demo`). Staging could not embed them. | Done. Original action: in `glassly`, `better-lansing-mechanics` and `lansing-car-rentals` (two demo branches), replace the preview origin with `https://crestmont-platform-staging.partners-df4.workers.dev`, redeploy each demo, then re-run *Deploy staging* and confirm the Portfolio summary says "demo verified for staging" for all four. |
| B2 | GitHub environment `frontend-preview` and its secrets `FRONTEND_PREVIEW_PASSWORD` / `FRONTEND_PREVIEW_DEMO_PASSWORD` | Remove after retirement (Settings → Environments). Staging is public and its demo accounts use their own sealed access notes. |
| B3 | Bookmarks or links shared with reviewers | Tell them to use the staging URL and staging access. |

From the repository side nothing else depends on the preview: it had no R2 binding and no cron triggers, its workflow
set no secret other than its gate password (so it held no Stripe, Resend or Retell key), and its D1 database was
disposable seed data. Provider dashboards (Stripe, Resend, Retell) could not be inspected from this session; before
step 5, confirm none of them lists a `crestmont-platform-frontend-preview` URL as a webhook or callback.

### Founder approval steps

1. **Review and merge this PR** into `main` (this is the approval to deploy the consolidated code to staging only).
2. Open *Actions → Deploy staging* for the merge commit and confirm green: *Frontend assets and homepage*, *Browser
   journey*, *Frontend browser verification*; download `staging-frontend-browser` to see the screenshots.
3. Open the staging URL (public since 2026-10-28; no preview password) and review the site (and `/login` → 2FA).
4. ~~Clear **B1**~~ — resolved 2026-10-29 (see the table above); confirm the latest *Deploy staging* summary lists "demo verified for staging" for all four projects.
5. Reply with the written authorization: **"Retire crestmont-platform-frontend-preview."**

### Retirement (only after step 5)

```bash
# Deletes the Worker script only. Does NOT delete its D1 database, any R2 bucket, or any secret store outside it.
npx wrangler delete --name crestmont-platform-frontend-preview
```

Then clear B2/B3 and delete the branch `claude/frontend-redesign` only once you no longer want the rollback path in §4.
**Do not** run `wrangler d1 delete` for `crestmont-frontend-preview` (or anything else) as part of this retirement;
removing that database is a separate decision.

Afterwards the account has exactly two Crestmont application Workers: `crestmont-platform-staging` and
`crestmont-platform-production` (plus the four isolated `*-portfolio-demo` Workers, which are separate projects).
