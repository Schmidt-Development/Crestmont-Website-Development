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
- R2: turn on object versioning or a lifecycle rule keeping non-current versions for 30 days (BACKUP-RECOVERY §4). Do **not** enable public access on either bucket. On `crestmont-files-production` also add a lifecycle rule *prefix `_backups/` → delete objects after 30 days* (pre-deploy database exports written by `deploy-production.yml`).
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
| `EVIDENCE_INGEST_SECRET` | required — installed by `deploy-staging.yml` from the GitHub secret of the same name (§5) | required — its **own** value (`openssl rand -hex 32`), set by hand once | Staging: the readiness system that CI, releases and production authorization sign against. Production: used only when production hosts its own readiness system; never staging's value. |
| `STRIPE_SECRET_KEY` | test key `sk_test_…` / `rk_test_…` (live keys are refused) | **do not set a test key.** Leave unset until the Founder authorises live payments (PAY-010); then set the **live** key `sk_live_…` / `rk_live_…` together with the plain var `PAYMENTS_LIVE_AUTHORIZED = "yes"`. Production refuses test keys and `livemode:false` events, and without the flag it refuses every key and every Stripe event (payments show as unavailable). | Stripe (BLK-004) |
| `STRIPE_WEBHOOK_SECRET` | required with Stripe | required with Stripe (the **live-mode** endpoint's secret) | Stripe webhook endpoint `https://<host>/api/webhooks/stripe` |

Payments mode per environment (`src/domain/payments-mode.ts`, CREST-GAP-007/008): development and staging use Stripe **test mode only**; production uses **live mode only**, and only when the Founder sets the non-secret var `PAYMENTS_LIVE_AUTHORIZED` to exactly `yes` (production `vars` or a plain-text variable). Nothing defaults to live. Even with live payments authorised, production checkout stays closed — package buttons lead to `/quote` and `POST /checkout` is refused — while the legal policies carry the draft banner or the legal business name is not recorded in Business settings (CREST-GAP-010).
| `RESEND_API_KEY` | optional — a **separate** Resend API key (sending access, domain `crestmontwebsitedevelopment.com`) | required for email — its own key | Resend (BLK-005). Staging mails only `EMAIL_RECIPIENT_ALLOWLIST` (below); reserved test addresses (`.test`, `.invalid`, `example.com` …) are never mailed anywhere. |
| `RESEND_WEBHOOK_SECRET` | the signing secret of the **staging** webhook endpoint | the signing secret of the **production** webhook endpoint | Resend/Svix `whsec_…`, shown on each endpoint in Resend → Webhooks. Receiver: `POST /api/webhooks/resend`. |

Non-secret email vars (set in `wrangler.toml` `vars` or as plain-text variables): `EMAIL_FROM` (default `Crestmont <support@crestmontwebsitedevelopment.com>`), and on staging `EMAIL_RECIPIENT_ALLOWLIST` (comma-separated addresses and/or `@domain` entries; default `@crestmontwebsitedevelopment.com`). Without `RESEND_API_KEY` every message stays in the outbox (never sent).
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | required (public forms, `/register` and `/password/forgot` fail closed without them) | required | Cloudflare Turnstile widget per hostname. Staging uses Cloudflare's always-pass test keys in `wrangler.toml`. |
| `MFA_ENCRYPTION_KEY` | **required** (set manually; not derived by the deploy workflow) | **required**, different value | `openssl rand -base64 32` (exactly 32 bytes). AES-GCM key for TOTP secrets at rest. Without it, two-factor *enrolment* is refused on staging/production (existing users keep signing in). Never rotate in place (RUNBOOK §4). |
| `FOUNDER_EMAIL` | optional (unset: demo `@crestmont-preview.test` Owners are still refused) | **required before launch** | The Founder's sign-in address. When set, only that account can record a production launch approval, and `GET /api/readiness/release-authorization` refuses any other approver ("approver is not the Founder", CREST-GAP-020). Set with `wrangler secret put FOUNDER_EMAIL --env production` (a personal address is not committed to this public repository). |
| `ANTHROPIC_API_KEY` | optional | optional | Anthropic Console (console.anthropic.com → API keys; separate key per environment, workspace spend limit). Used **only** when the var `AI_PROVIDER = "anthropic"` is also set **and** the Owner sets a monthly AI budget at /staff/ai; a key alone never enables paid AI. Default backend is the self-hosted model (`AI_PROVIDER = "local-runner"` + `BUILD_RUNNER_SECRET`). |
| `GITHUB_TOKEN`, `GITHUB_REPO` | recommended (readiness data source) | optional | fine-grained, read-only, this repository only |
| `VOICE_WEBHOOK_SECRET`, `RETELL_API_KEY` | after the provider is approved (BLK-009) | same | voice provider |
| `RETELL_OUTBOUND` (`on`) | only to test outbound with the Founder's own phone (`docs/voice/RETELL-CONNECTION-GUIDE.md` step 16) | only after separate Founder approval of outbound calling | voice provider |

**`MFA_ENCRYPTION_KEY` rollout (once per environment, in this order).** (1) `openssl rand -base64 32 | npx wrangler@4 secret put MFA_ENCRYPTION_KEY --env <env>` and store the same value in the Founder's password manager; (2) deploy the release that contains migration `0036` (apply migrations first, as always); (3) re-encrypt the rows written before the key existed: `MFA_ENCRYPTION_KEY=<same value> node --no-warnings scripts/encrypt-totp-secrets.ts --remote --database crestmont-<env> --env <env>` (dry run, prints counts only), then again with `--yes`. Until step 3, plaintext rows keep working and are re-encrypted at each user's next successful sign-in; nobody is locked out at any step. The staging deploy workflow does not derive this key from `ACCESS_ROOT_KEY` on purpose: that root is the rotatable Cloudflare API token, and a key that changes with it would make every stored secret unreadable. `scripts/staging-access.ts` writes a demo account's TOTP key only when it actually changes (rotation, a new or reset account; tracked by an HMAC fingerprint in `_staging_access`), so a redeploy never overwrites a value the Worker has already encrypted. If the optional GitHub secret `STAGING_MFA_ENCRYPTION_KEY` is set — it must be the **same** value as the staging Worker's `MFA_ENCRYPTION_KEY` — the keys it does write are stored encrypted — but only once the deploy has **proven** that value is the Worker's key, by decrypting a two-factor secret the Worker itself already encrypted (AES-GCM is authenticated, so a different key cannot succeed; nothing is printed or compared outside the deploy). Until such a secret exists it writes plaintext and says so; a value that does not match, or is malformed, stops the deploy before anything is written. Without the secret they are written in plaintext and encrypted at the next sign-in or by step 3. On production, a missing key makes the `mfa-key:production` health feed **failing** (it alerts); on staging it is `unavailable` while being rolled out.

**Re-encryption safeguards (`--remote`).** The script refuses unless (a) `--env` is `staging` or `production`; (b) `--database` equals the `database_name` wrangler.toml binds for `[env.<env>]`; (c) that database's own succeeded `deployments` rows name exactly that one environment (none, or any other, is refused); and (d) for production, both `--confirm-production crestmont-production` and `CRESTMONT_CONFIRM_PRODUCTION_MFA_MIGRATION=crestmont-production` are given. It prints `Target confirmed: …` before the dry run.

**Stripe API version.** Every request the platform makes sends `Stripe-Version: 2025-02-24.acacia` (`STRIPE_API_VERSION` in `src/adapters/payments.ts`). Webhook events are rendered in the *webhook endpoint's* version: when creating the endpoint, choose the same version (Dashboard → Developers → Webhooks → Add endpoint → API version), or create it with `api_version=2025-02-24.acacia`. The handler also accepts newer (basil+) payloads: when an `invoice.paid` payload omits the PaymentIntent it looks it up with the pinned version, and fails the event for retry rather than record a payment that refunds and disputes could not find (`tests/stripe-versions.test.ts`). Events to enable: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `invoice.voided`, `invoice.marked_uncollectible`, `charge.refunded`, `charge.dispute.created|updated|closed`.

Non-secret vars: add `APP_URL = "https://<host>"` to each environment's `vars` in `wrangler.toml` once the URL is known (links in emails use it).

## 5. GitHub environments, secrets and variables

Repository → Settings → Environments:

1. **`staging`**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (`EVIDENCE_INGEST_SECRET` comes from the repository secret below).
   - Variables: `STAGING_URL` (e.g. `https://crestmont-platform-staging.<subdomain>.workers.dev`), `READINESS_URL` (the staging URL; staging hosts the readiness system that CI and deploy evidence post to).
   - Deployment branches: `main` only.
   - **Evidence secret (stable):** the repository secret `EVIDENCE_INGEST_SECRET` (Settings → Secrets and variables → Actions → *Repository secrets*) is the one value every GitHub-side workflow signs with (`ci.yml`, `release.yml`, `deploy-production.yml`). `deploy-staging.yml` installs exactly that value on the staging Worker through `scripts/evidence-secret.ts`, and only when it changed (`scripts/staging-secrets.ts`: a changed secret blocks rollbacks, Cloudflare 10220); the restore drill and rollback rehearsal reuse it and never touch the Worker. Generate it once with `openssl rand -hex 32`. Until it exists, staging uses the key derived from the Cloudflare token and warns *"EVIDENCE_INGEST_SECRET not configured"*: staging's own evidence keeps working, but CI evidence, release candidates and production release authorization cannot sign against staging. Setting it changes the staging secret once (rollbacks to versions older than that deploy are then refused, as for any secret change). Do not define a different `EVIDENCE_INGEST_SECRET` on the `staging` or `production` *environments* (an environment secret overrides the repository secret in that environment's jobs). Each staging and production run prints a 12-character **fingerprint** (never the value); they must match.
2. **`production`**
   - **Required reviewers: the Founder** (and nobody else who can approve alone). Enable "Prevent self-review".
   - Deployment branches and tags: `main` only.
   - Secrets: `CLOUDFLARE_API_TOKEN` (a production-only token, §1), `CLOUDFLARE_ACCOUNT_ID`. `EVIDENCE_INGEST_SECRET` is inherited from the repository secret (the staging readiness system's value); do not add a different one here.
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
2. **Production apex** — `wrangler.toml` `[env.production]` already declares `routes = [{ pattern = "crestmontwebsitedevelopment.com", custom_domain = true }]`. The custom domain (DNS record and certificate) is created by the approved `deploy-production.yml` run itself. Before that run, the apex must have **no CNAME record** (Cloudflare refuses a custom domain on a hostname with a CNAME); note and remove any parked A/AAAA/CNAME records for the apex in DNS → Records (screenshot them first: that is the DNS rollback).
3. **www → apex** — not a Worker hostname. Add a proxied placeholder record (`AAAA www 100::`, Proxy status *Proxied*) and a Redirect Rule (Rules → Redirect Rules → *Redirect from WWW to root* template, or a single redirect: hostname equals `www.crestmontwebsitedevelopment.com` → dynamic `concat("https://crestmontwebsitedevelopment.com", http.request.uri.path)`, status 301, preserve query string). Do this only after the apex answers.
4. **Staging** `staging.crestmontwebsitedevelopment.com` — uncomment the staging `routes` line through a PR. The next staging deploy after the merge attaches it (that merge is the DNS change). The workers.dev address keeps working because `workers_dev = true` stays. Staging stays behind the preview gate; its Turnstile keys are test keys, so keep the gate on.
5. SSL/TLS: Full (strict). Minimum TLS 1.2. Always use HTTPS. **HSTS only after** HTTPS on the apex and the www redirect are verified (addresses ASVS F-14); start with a short max-age.
6. Set `env.staging.url` / `env.production.url` at `/staff/ops`. The 15-minute probe then records DNS/TLS/health in the environment views.

## 8. Normal flow

1. **Merge to `main`** → `ci.yml` (tests, evidence) and `deploy-staging.yml`: typecheck, tests, D1 Time Travel bookmark, migrations, record *started*, `wrangler deploy --env staging`, record *succeeded*, smoke checks (`scripts/production-checks.ts --environment staging`), browser E2E against staging, post evidence, record the verification result.
2. **Tag a release** `git tag -s v1.0.0 <sha> && git push origin v1.0.0` → `release.yml` creates a GitHub pre-release with notes and, through `scripts/release-candidate.ts`, a release candidate bound to the full SHA and the `wrangler.toml` digest. The candidate can also be created by hand at `/staff/readiness/releases`.
3. **Founder reviews and approves** at `/staff/readiness/approve` (Owner + MFA only; bound to commit, config and evidence set).
4. **Run *Deploy production*** (Actions → Deploy production → Run workflow) with the full commit SHA. GitHub waits for the Founder's environment approval. The workflow then:
   - checks that the commit is on `main` and the production `database_id` is set;
   - calls `GET /api/readiness/release-authorization?commit=<sha>&config=<digest>` (signed; `scripts/release-authorization.ts`) and **stops unless `authorized: true`**;
   - runs typecheck and tests, exports the production D1 to the private production bucket under `_backups/` (never a workflow artifact: the repository is public; skipped only for an empty database on the first release), re-checks authorization, applies migrations, records the deployment (the platform compares the commit with the approved candidate: LAUNCH-002), deploys;
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
