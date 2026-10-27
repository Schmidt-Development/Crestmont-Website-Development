# Deployment and environment provisioning

**Requirements:** INFRA-002, INFRA-005, LAUNCH-002, LAUNCH-003 · **Status: not provisioned.** No Cloudflare account is connected (BLK-003), so none of the steps below has been run. The workflows and scripts exist and are tested locally. They skip or refuse until the steps here are done. Follow this document in order once the Founder has created the accounts.

Production is **never** deployed automatically. It needs the Founder's approval of the exact release-candidate commit in the platform (`/staff/readiness/approve`) **and** the Founder's approval of the GitHub `production` environment run.

## 0. Overview

| Environment | Worker | D1 database | R2 bucket | Deployed by | URL |
|---|---|---|---|---|---|
| development | local `node dev/server.ts` | `.dev/crestmont.db` (node:sqlite) | local disk | developer | http://localhost:8787 |
| staging | `crestmont-platform-staging` | `crestmont-staging` | `crestmont-files-staging` | `.github/workflows/deploy-staging.yml` on push to `main` | `*.workers.dev`, later `staging.crestmontwebsitedevelopment.com` |
| production | `crestmont-platform-production` | `crestmont-production` | `crestmont-files-production` | `.github/workflows/deploy-production.yml`, manual, Founder-approved | `crestmontwebsitedevelopment.com` |

Staging and production never share a database, a bucket, a secret or an API token (§62).

## 1. Cloudflare account and API token (Founder)

1. Create a dedicated Cloudflare account for Crestmont, or a dedicated account inside the Founder's organisation. Note the **Account ID** (dashboard → Workers & Pages → right sidebar).
2. Create an **API token** (My Profile → API Tokens → Create custom token), limited to that account:
   - Account → Workers Scripts: Edit
   - Account → D1: Edit
   - Account → Workers R2 Storage: Edit
   - Account → Account Settings: Read
   - Zone → Workers Routes: Edit (only once the custom domain zone is on Cloudflare)
   - Optional: create a separate token per environment so a staging leak cannot touch production.
3. Store the token in the Founder's password manager. Never paste it into chat, tickets or commits.

## 2. Create resources (once per environment)

```sh
npx wrangler@4 login                       # or export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
npx wrangler@4 d1 create crestmont-staging
npx wrangler@4 d1 create crestmont-production
npx wrangler@4 r2 bucket create crestmont-files-staging
npx wrangler@4 r2 bucket create crestmont-files-production
```

- Copy each printed `database_id` into `wrangler.toml` (`[env.staging]` and `[env.production]` `d1_databases`). These ids are not secrets. Commit the change through a pull request. Both deploy workflows refuse to run while a `database_id` is empty.
- R2: turn on object versioning or a lifecycle rule keeping non-current versions for 30 days (BACKUP-RECOVERY §4). Do **not** enable public access on either bucket.
- Apply the schema the first time (later runs happen in the workflows):
  ```sh
  npx wrangler@4 d1 migrations apply crestmont-staging --remote --env staging
  ```
- Changing `wrangler.toml` changes its SHA-256, which is bound to release candidates (`scripts/release-candidate.ts --print-config-digest`). A configuration change after Founder approval therefore requires a new candidate and a new approval (§45).

## 3. Cron triggers

`wrangler.toml` declares `crons = ["*/15 * * * *", "17 11 * * *"]` in each environment. They must match `SCHEDULE` in `src/app/scheduled.ts` (tests enforce this). They are installed by `wrangler deploy`. Jobs:

| Cron | Jobs |
|---|---|
| `*/15 * * * *` | Stripe event retry, support SLA escalation, GitHub sync, **environment probe** (DNS/TLS/health of `env.<env>.url`) |
| `17 11 * * *` (daily) | requirements sync, inactivity sweep, integration health, Stripe-side reconciliation, cost import, **retention** |

Every run is recorded in `ingestion_status` as `job:<name>` and shown on the readiness feed panel.

## 4. Secrets (per environment)

Set with `npx wrangler@4 secret put <NAME> --env staging` (then again with `--env production` and a **different value**). Values are never stored in the repository. `/staff/security` shows which names are present, never the values.

| Secret | Staging | Production | Source / owner |
|---|---|---|---|
| `EVIDENCE_INGEST_SECRET` | required | required | `openssl rand -hex 32`. The same value goes into the GitHub environment secret of the same name. |
| `STRIPE_SECRET_KEY` | test key `sk_test_…` / `rk_test_…` | **test key only** until PAY-010 (the adapter refuses live keys) | Stripe (BLK-004) |
| `STRIPE_WEBHOOK_SECRET` | required with Stripe | required with Stripe | Stripe webhook endpoint `https://<host>/api/webhooks/stripe` |
| `RESEND_API_KEY` | optional | required for email | Resend (BLK-005) |
| `RESEND_WEBHOOK_SECRET` | with Resend webhooks | with Resend webhooks | Resend/Svix `whsec_…` |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | required (public forms fail closed without them) | required | Cloudflare Turnstile widget per hostname |
| `ANTHROPIC_API_KEY` | optional | optional | Anthropic Console |
| `GITHUB_TOKEN`, `GITHUB_REPO` | recommended (readiness data source) | optional | fine-grained, read-only, this repository only |
| `VOICE_WEBHOOK_SECRET`, `RETELL_API_KEY` | after the provider is approved (BLK-009) | same | voice provider |

Non-secret vars: add `APP_URL = "https://<host>"` to each environment's `vars` in `wrangler.toml` once the URL is known (links in emails use it).

## 5. GitHub environments, secrets and variables

Repository → Settings → Environments:

1. **`staging`**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EVIDENCE_INGEST_SECRET` (the staging Worker's value).
   - Variables: `STAGING_URL` (e.g. `https://crestmont-platform-staging.<subdomain>.workers.dev`), `READINESS_URL` (the staging URL; staging hosts the readiness system that CI and deploy evidence post to).
   - Deployment branches: `main` only.
2. **`production`**
   - **Required reviewers: the Founder** (and nobody else who can approve alone). Enable "Prevent self-review".
   - Deployment branches and tags: `main` only.
   - Secrets: `CLOUDFLARE_API_TOKEN` (ideally a production-only token), `CLOUDFLARE_ACCOUNT_ID`, `EVIDENCE_INGEST_SECRET` (the value of the Worker that hosts the readiness system the Founder approves in).
   - Variables: `PRODUCTION_URL` (`https://crestmontwebsitedevelopment.com`), `READINESS_URL` (where the Founder's approval is recorded: the staging readiness system until production hosts its own).
3. Repository variable `READINESS_URL` and secret `EVIDENCE_INGEST_SECRET` are also used by `ci.yml` and `release.yml`.

Until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist on `staging`, every push to `main` runs `deploy-staging.yml`, prints *"Staging deploy skipped"* and deploys nothing.

## 6. Branch protection (recommended)

Settings → Branches → rule for `main`:
- Require a pull request before merging, with 1 approval. Dismiss stale approvals on new commits.
- Require status checks: `CI / test` (and `CodeQL / analyze` once Advanced Security is available).
- Require branches to be up to date. Require linear history.
- Do not allow bypassing the above settings. Block force pushes and deletions.
- Tag protection (rulesets → tags `v*`): only maintainers may create release tags.

## 7. Custom domain (after DNS control, BLK-011)

1. Add `crestmontwebsitedevelopment.com` to the Cloudflare account and switch the registrar's nameservers.
2. Uncomment the `routes` lines in `wrangler.toml` (`custom_domain = true`) for staging (`staging.` subdomain) and production (apex + `www`). Commit through a PR. This is a configuration change, so it needs a new release candidate.
3. SSL/TLS: Full (strict). Minimum TLS 1.2. Always use HTTPS. HSTS after verification (addresses ASVS F-14).
4. Set `env.staging.url` / `env.production.url` at `/staff/ops`. The 15-minute probe then records DNS/TLS/health in the environment views.

## 8. Normal flow

1. **Merge to `main`** → `ci.yml` (tests, evidence) and `deploy-staging.yml`: typecheck, tests, D1 safety export (artifact), migrations, record *started*, `wrangler deploy --env staging`, record *succeeded*, smoke checks (`scripts/production-checks.ts --environment staging`), browser E2E against staging, post evidence, record the verification result.
2. **Tag a release** `git tag -s v1.0.0 <sha> && git push origin v1.0.0` → `release.yml` creates a GitHub pre-release with notes and, through `scripts/release-candidate.ts`, a release candidate bound to the full SHA and the `wrangler.toml` digest. The candidate can also be created by hand at `/staff/readiness/releases`.
3. **Founder reviews and approves** at `/staff/readiness/approve` (Owner + MFA only; bound to commit, config and evidence set).
4. **Run *Deploy production*** (Actions → Deploy production → Run workflow) with the full commit SHA. GitHub waits for the Founder's environment approval. The workflow then:
   - checks that the commit is on `main` and the production `database_id` is set;
   - calls `GET /api/readiness/release-authorization?commit=<sha>&config=<digest>` (signed; `scripts/release-authorization.ts`) and **stops unless `authorized: true`**;
   - runs typecheck and tests, exports the production D1 (artifact, 30 days), re-checks authorization, applies migrations, records the deployment (the platform compares the commit with the approved candidate: LAUNCH-002), deploys;
   - runs the post-deploy checks (health, home, pricing, contact, login, security headers, staff redirect, readiness health) and posts them as `production_check` evidence (Gate H);
   - on a critical failure runs `wrangler rollback --env production` and records the deployment as `rolled_back`.

## 9. Rollback

Automatic as above, or by hand:
```sh
npx wrangler@4 deployments list --env production
npx wrangler@4 rollback <version-id> --env production --message "Rollback: <reason>"
READINESS_URL=… EVIDENCE_INGEST_SECRET=… node --no-warnings scripts/post-deployment.ts --id <deployment id> --environment production \
  --commit <sha> --status rolled_back --verification failed --by "<your name>" --rollback-target <previous deployment id>
```
Code rollback does not undo migrations. Migrations must stay additive (BACKUP-RECOVERY §5).

## 10. Signed automation endpoints

All use `X-Crestmont-Signature: t=<unix>,v1=<hex HMAC-SHA256(EVIDENCE_INGEST_SECRET, "<t>.<payload>")>`, with a 10-minute tolerance. Requests fail closed (401) when the secret is unset, missing, stale or wrong.

| Endpoint | Payload signed | Script |
|---|---|---|
| `POST /api/readiness/evidence` | request body | `scripts/post-evidence.ts` |
| `POST /api/readiness/deployments` | request body | `scripts/post-deployment.ts` |
| `POST /api/readiness/release-candidates` | request body | `scripts/release-candidate.ts` |
| `GET /api/readiness/release-authorization?commit=&config=` | `GET <path>?<query>` exactly as sent (or a staff session with `readiness.read`) | `scripts/release-authorization.ts` |

The release-authorization endpoint is read-only and grants nothing. Only the Owner records approvals, in the browser, with MFA.

## 11. Readiness after provisioning

Once staging runs, record the evidence: close BLK-003 at `/staff/readiness/blockers/BLK-003` with resolution evidence (resource ids, first green `deploy-staging` run URL). INFRA-002 / INFRA-005 / READY-006 / READY-009 / LAUNCH-002 / LAUNCH-003 stay `in_progress` in `requirements/status/ops.ts` until a real staging deployment and, for production items, a real Founder-approved production deployment have run.
