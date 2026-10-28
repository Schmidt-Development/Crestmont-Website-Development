# Crestmont integration closeout — audit and plan

Owner: integration session (branch `claude/crestmont-integration-closeout`).
Audit snapshot: 2026-10-28 ~06:30 UTC. Every SHA and run ID below was read from Git or the GitHub API at that time.
Re-run the commands in §9 before acting on anything here; the other sessions are still pushing.

This document plans the integration. It merges nothing, deploys nothing, and changes no secret.

## 0. Delta at 07:15 UTC (supersedes §1–§7 where they differ)

- `main` is now `17c38f0`: **#14 merged** (email isolation, env-tagged Resend webhooks) and **#15 merged** (restore drill imports in dependency order).
- **Restore drill passed** on `17c38f0` (07:06 UTC). CI on `main` passed; Deploy staging passed.
- The runner CI flake (§5) was addressed on `main` by `2149384` (lease-watchdog fixture race). Watch the next few runs before calling it closed.
- Frontend is now `efc1665` (29 ahead / 7 behind `main`, still merges cleanly): cumulative pricing model, real-device-width portfolio framing, live links, read-only isolation audit for demo branches.
- New branches: `claude/ai-website-builder-readiness` (PR #16, open) and `claude/staging-mfa-encryption`; both merge cleanly with `main`. No new migrations on either.
- **#8 is still unmerged, and live plaintext `staging-preview-access` artifacts rose from 14 to 16.** §4 remains the top priority.
- Remaining stack order for `main`: #12 → #8 → #13, then #16 (pending its owner), then the frontend integration PR.

## 1. Repository and branch map

| Branch | Head | vs `main` (ahead / behind) | Owner (inferred from commits/PRs) | State |
|---|---|---|---|---|
| `main` | `85819b8` | — | backend | Deployed to staging (run 40641507127) |
| `claude/frontend-redesign` | `c2c444b` | 22 / 8 | frontend | Deployed to frontend preview (run 40630538991); still in development |
| `claude/production-d1-id` (PR #12) | `e578623` | 1 / 4 | infrastructure | Open |
| `claude/production-readiness` (PR #8) | `6886025` | 5 / 4 | infrastructure | Open, contains #12 |
| `claude/production-mfa-key` (PR #13) | `3effe3b` | 7 / 4 | infrastructure | Open, contains #12 and #8 |
| `claude/staging-email-recipient-guard` (PR #14) | `86b9b82` | 2 / 1 | backend | Open, newest work (06:17 UTC) |
| `claude/frontend-preview-encrypt-access` (PR #9) | `3e8c0ea` | targets frontend: 1 / 39 | infrastructure | Open, **superseded** (see §3) |
| `claude/backend-pending` | `cd38a36` | 0 / 4 | backend | Fully merged; can be deleted |
| `claude/production-provisioning` (PR #10) | `4ebbf8c` | 0 / 15 | infrastructure | Merged 01:12 UTC; can be deleted |
| `claude/ci-dom-iterable` (PR #1) | `c9828a3` | merged | — | Can be deleted |
| `wip/workstreams-3`, `wip/parallel-areas` | `9e431a8`, `817fda1` | 1 / 79, 1 / 90 | snapshots | Stale WIP, "not for main"; do not integrate |
| Dependabot PRs #3, #5, #6, #7 | — | — | dependabot | Open; action major-version bumps |

## 2. What triggers what (deployment safety)

| Event | Workflows that run | Effect |
|---|---|---|
| Push/merge to `main` | CI, **Deploy staging**, then (on success) **Staging restore drill** and **Staging rollback rehearsal** | Migrations applied to `crestmont-staging`, Worker `crestmont-platform-staging` redeployed, demo access re-applied, **access artifact uploaded (see §4)** |
| Push to `claude/frontend-redesign` | Deploy frontend preview | Only `--env frontend-preview` (guard step refuses other targets) |
| Pull request | CI, Windows scripts (path-filtered) | No deploy |
| Tag `v*` | Release | GitHub prerelease + readiness candidate; no deploy |
| Manual only | Deploy production, Provision production, CodeQL, portfolio screenshots | Production deploy requires the `production` environment reviewers and Founder approval of the exact commit |

Merging any PR into `main` deploys staging immediately. No merge deploys production.
PR #8 adds the production apex route and `APP_URL`; these only take effect inside `deploy-production.yml`, so merging #8 changes no DNS.

Infrastructure names in `wrangler.toml` match the intended set: staging `crestmont-platform-staging` / `crestmont-staging` / `crestmont-files-staging`;
production `crestmont-platform-production` / `crestmont-production` / `crestmont-files-production`; preview `crestmont-platform-frontend-preview` / `crestmont-frontend-preview` (frontend branch only).
On `main` the staging and production `database_id` values are empty; the staging deploy fills staging at run time and PR #12 pins production.
I could not verify these against the Cloudflare account itself (no Cloudflare access in this session).

## 3. Open PRs and merge order

| PR | Base | GitHub mergeable | CI `test` | Notes |
|---|---|---|---|---|
| #12 Pin production D1 id | `main` | yes | fail (runner flake, §5) | Bottom of the stack |
| #8 Production readiness | `main` | yes | fail (runner flake) | Contains #12. **Fixes the plaintext access artifact (§4)** |
| #13 Production MFA key | `main` | yes, clean | pass | Contains #12 and #8 |
| #14 Staging email isolation + env-tagged Resend webhooks | `main` | yes | fail (runner flake) | Independent of the stack; merges cleanly before or after it |
| #9 Encrypt frontend-preview notes | `claude/frontend-redesign` | GitHub says yes against a stale base (`333add2`) | pass | Conflicts with current frontend head in `deploy-frontend-preview.yml`. Superseded by `54b85f9` (no credential artifacts at all); the frontend session said so on the PR. **Recommend closing, not merging** |
| #3, #5, #6, #7 Dependabot | `main` | — | fail (same flake) | Hold until after integration; take as one batch |

Recommended order for `main`: **#12 → #8 → #13 → #14**, then the frontend integration PR. Each merge triggers a staging deploy, so the stack can also be merged as #13 alone (it contains #12 and #8) to deploy staging once; merge #12 and #8 first only if the Founder wants them recorded as merged.

## 4. Security finding — plaintext staging credentials in public artifacts (open)

The repository is public. On `main`, `deploy-staging.yml` uploads `access/README.md` as the artifact `staging-preview-access`.
`scripts/staging-access.ts` (`accessReadme`) writes the staging preview password, the staging Owner password and the Owner TOTP setup key into that file.
At the audit time **14 such artifacts were unexpired** (runs from 00:31 to 06:17 UTC on 2026-10-28, expiring 2026-11-04). Every merge to `main` adds another.
Scope: staging and its demo accounts only. Production is untouched.

Remediation (Founder or infrastructure session; this session will not delete artifacts or rotate credentials):
1. Merge #12 → #8 (→ #13). #8 uploads only an encrypted copy (needs repository secret `ACCESS_ARTIFACT_PASSPHRASE`) or nothing.
2. Delete every existing `staging-preview-access` artifact.
3. Run *Deploy staging* with `rotate_credentials = true` so all exposed staging passwords and 2FA keys stop working.
4. Confirm the next deploy's artifact list has no plaintext `staging-preview-access`.

## 5. CI: intermittent runner failure (open, not caused by any PR)

The `test` job fails only at *Build runner (AI Builds) — typecheck and mock tests*, intermittently, on `main` and on PRs that do not touch `runner/`
(e.g. `9cf8ff4` passed and `cfd344e` failed with no `runner/` diff; #14's `a941a44` passed and `86b9b82` failed with no `runner/` diff).
The failure annotation points to log line ~610, i.e. inside the runner test output, after the typecheck.
Locally the suite passes 9 of 9 runs (92 pass, 4 skipped for missing pwsh/squid/lockfiles), including 3 runs pinned to one CPU under load.
GitHub reports that `ubuntu-latest` began migrating to Ubuntu 26 on 2026-10-19, so jobs may be landing on two different images; this is a hypothesis, not confirmed.
Job logs are hosted on a domain this session cannot reach. Next step for whoever owns the runner: open a failing job's log and record the failing subtest.
Until fixed, a red `test` check on a PR whose only failed step is this one is not evidence against the PR.

## 6. Conflicts and contracts found by trial integration

Trial branch (local only, never pushed): `origin/main` + #13 stack + #14 + `claude/frontend-redesign`.
- All three merges resolve automatically. Overlapping files: `src/app/app.ts`, `src/app/context.ts`, `tests/support/route-inventory.ts`, `tests/support/security-scenarios.ts`, `wrangler.toml`, `docs/DEPLOYMENT.md`, staging workflows.
- Platform typecheck: pass. Runner typecheck: pass. `npm test`: **411 passed, 0 failed, 0 skipped** (474 evidence entries, all passed).
- Baselines on the same machine, all 0 failed: `main` 392, frontend 393, #13 stack 395, #14 395.
  Every test name from every branch appears in the trial run (none dropped); no test exists only in the trial.
- **Migration number collision:** `main` has `0037_deploy_secret_fingerprints.sql`, the frontend adds `0037_portfolio_demos.sql`.
  They touch unrelated tables (`deploy_secret_fingerprints` new table vs `portfolio_projects` new columns), sort deterministically, and Wrangler records applied migrations by full filename, so both apply.
  **Do not rename either file:** the frontend preview database has already recorded `0037_portfolio_demos`, and staging has recorded `0037_deploy_secret_fingerprints`; a rename would make Wrangler re-run an `ALTER TABLE … ADD COLUMN` and fail. New migrations should start at `0038`.
- Merging the frontend into `main` applies `0037_portfolio_demos` to staging on the next deploy (the frontend docs list this as a backend decision).
- After integration, `deploy-frontend-preview.yml` lives on `main` but only triggers on pushes to `claude/frontend-redesign`; it stays dispatchable and cannot target staging or production.

Caveat: CI pins `typescript@5` and `@types/node@22`; the npm registry is unreachable from this session, so the local typechecks used TypeScript 6.0.3 with `@types/node` 26.6.3.

## 7. Workstream status (evidence on pushed branches only)

Frontend (`c2c444b`):
- Done and deployed to the preview: design system v3, dark colourway, service visuals, horizontal portfolio explorer, preview access without credential artifacts.
- Portfolio demos (4): explorer built; demo Workers **not deployed**. Glassly is blocked on `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets in its repository; the other three are blocked until Cloudflare/Netlify branch builds exclude `crestmont/*` (Founder actions, `docs/frontend/PORTFOLIO.md`).
- No evidence yet on the pushed branch of: a dedicated AI Receptionist service page and demo, the persistent Crestmont AI chatbot, the About and Contact redesigns, or the pricing inheritance comparison. They may exist unpushed in the frontend session.

Backend (`main` `85819b8` + #14):
- Staging deploy: green, including D1 migrations, Worker deploy, cron verification, access verification, smoke checks and the browser journey.
- R2: the deploy step "File storage (R2) if available, otherwise disable uploads honestly" succeeded, which does not by itself prove R2 is bound. Unconfirmed.
- D1 restore drill: **has not passed** in the last 10 runs (latest failure at the "Restore into a scratch database and compare" step after `85819b8`). Backend session is on it.
- Resend: #14 adds environment tags and per-environment webhook filtering; open, awaiting merge.
- Staging health monitor: only one recent run visible (failure, 01:43 UTC) despite a 30-minute schedule; worth checking.
- AI-provider inventory, paid-AI budget enforcement, credential rotation: not verified by this audit.

Deferred by the Founder (not touched): AI intake → Claude build workflow; Retell AI Receptionist; Stripe.

## 8. Integration sequence (when the Founder says the sessions are done)

Readiness gates, all required:
- [ ] §4 remediated (artifacts deleted, credentials rotated, #8 merged).
- [ ] #12/#8/#13 and #14 merged (or explicitly deferred) by the Founder.
- [ ] Frontend session declares its branch final and stops pushing.
- [ ] Backend session declares the restore drill green, or the Founder accepts it as a known gap.
- [ ] #9 closed.

Steps:
1. `git fetch --prune`; re-run §9; confirm no new branches or PRs.
2. In this worktree, bring `claude/crestmont-integration-closeout` up to date with `git merge --ff-only origin/main` (never a reset, so nothing on this branch is lost).
3. `git merge --no-ff origin/claude/frontend-redesign`; resolve any conflict keeping both sides; never drop a migration.
4. Typecheck (platform and runner), `npm test`, runner tests, and the frontend preview browser checks; record counts.
5. Confirm `migrations/` is a superset of every branch's migrations and none is renamed.
6. Confirm no workflow change makes a push deploy production (`deploy-production.yml` stays `workflow_dispatch`).
7. Open the integration PR to `main` with this checklist and the test evidence. **Founder approves and merges.**
8. The merge deploys staging. Verify: Deploy staging green; access verification and browser journey green; restore drill and rollback rehearsal results; frontend pages on staging; Resend environment tagging.
9. Record the evidence in `docs/integration/CLOSEOUT.md`. Production stays untouched until separate Founder authorization.

## 9. Re-audit commands

```sh
git fetch --all --prune
git for-each-ref --sort=-committerdate refs/remotes --format='%(refname:short) %(objectname:short) %(committerdate:iso) %(subject)'
git rev-list --left-right --count origin/main...origin/claude/frontend-redesign
git merge-tree --write-tree --name-only origin/main origin/claude/frontend-redesign
gh api 'repos/Schmidt-Development/Crestmont-Website-Development/pulls?state=open' --jq '.[]|"#\(.number) \(.head.ref)@\(.head.sha[0:7]) -> \(.base.ref)"'
gh api 'repos/Schmidt-Development/Crestmont-Website-Development/actions/artifacts?name=staging-preview-access' --jq '[.artifacts[]|select(.expired==false)]|length'
```
