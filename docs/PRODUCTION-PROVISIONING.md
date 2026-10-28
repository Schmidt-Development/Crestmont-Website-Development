# Production provisioning, deployment and launch

Three separate stages. Each one needs the Founder; none happens on a push.

| Stage | What it does | How | Reversible? |
|---|---|---|---|
| **1. Provision** | Creates the D1 database `crestmont-production` and the Worker `crestmont-platform-production` as an empty draft holding its secrets; checks the R2 bucket `crestmont-files-production`. No code, no domain, no DNS, no migrations, no public URL. | Actions → **Provision production** (`.github/workflows/provision-production.yml`) | Yes: the draft Worker and empty database can be deleted in the dashboard. |
| **2. Deploy** | Uploads the approved commit, applies migrations, attaches `crestmontwebsitedevelopment.com`, runs post-deploy checks, rolls back on failure. | Actions → **Deploy production** (`deploy-production.yml`), after the Founder approves the release candidate | Code: `wrangler rollback`. Migrations are additive and are not rolled back. |
| **3. Open to customers** | Real email, `www` redirect, HSTS, Owner account, and the authentication items in `docs/AUTH-PRODUCTION.md`. | Founder decisions and configuration | — |

## Stage 1 — prerequisites (GitHub and Cloudflare settings only)

### Cloudflare API token (production only)
Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**:

| Scope | Permission | Used by |
|---|---|---|
| Account → Workers Scripts | Edit | draft Worker, secrets, deploy, rollback, workers.dev switch |
| Account → D1 | Edit | create database, migrations, pre-deploy export |
| Account → Workers R2 Storage | Edit | bucket check, private pre-deploy export copy |
| Account → Account Settings | Read | `wrangler whoami` |
| Zone → Workers Routes | Edit | the apex custom domain at deploy time (Stage 2) |

Account Resources: **Include → the Crestmont account** only. Zone Resources: **Include → Specific zone → crestmontwebsitedevelopment.com**. Keep it separate from the staging token.

### GitHub `production` environment
<https://github.com/Schmidt-Development/Crestmont-Website-Development/settings/environments> → **New environment** → `production`:

- **Required reviewers:** the Founder. Leave *Prevent self-review* **off** while the Founder is the only reviewer (it would block approving runs the Founder starts).
- **Deployment branches and tags:** *Selected branches and tags* → add `main`.
- **Environment secrets:**
  - `CLOUDFLARE_API_TOKEN` — the production token above
  - `CLOUDFLARE_ACCOUNT_ID` — `df441806863a7fd3f26dea4e782a25fc`
  - `PRODUCTION_TURNSTILE_SITE_KEY`, `PRODUCTION_TURNSTILE_SECRET` — the production widget's keys (the workflow refuses Cloudflare test keys and staging's keys)
- **Environment variables** (needed by Stage 2, harmless now): `PRODUCTION_URL` = `https://crestmontwebsitedevelopment.com`, `READINESS_URL` = `https://crestmont-platform-staging.partners-df4.workers.dev`.

### Run it
Actions → **Provision production** → *Run workflow* (branch `main`) → confirmation `provision crestmont-platform-production` → approve the `production` deployment when GitHub asks. The run summary shows the D1 `database_id` (not a secret) and the secret **names** installed. Re-running is safe.

Then commit that `database_id` into `[env.production]` of `wrangler.toml` through a pull request; `deploy-production.yml` refuses to run until it is committed.

## Stage 2 — before the first production deploy
- Stage 1 complete and the `database_id` committed.
- `EVIDENCE_INGEST_SECRET` repository secret set, staging redeployed with it, fingerprints match (`docs/DEPLOYMENT.md` §5).
- Staging credentials rotated after the public-artifact exposure, so the staging Owner account used for release approval is trustworthy again.
- A release tag, the candidate approved at `/staff/readiness/approve` (Owner + MFA).
- DNS: screenshot the apex records, then remove any CNAME on the apex (a custom domain cannot be created on a hostname with a CNAME). SSL/TLS: Full (strict), minimum TLS 1.2, Always Use HTTPS. No HSTS yet.

## Stage 3 — before opening to customers
- Transactional email (Resend) authorised and configured: without it, sign-up confirmation and password-reset links are only recorded in the outbox, not delivered.
- Production Owner account bootstrapped (`scripts/bootstrap-owner.ts --print-sql`), MFA enrolled; AI-build automation paused in Owner → AI builds until approved.
- `www` → apex redirect rule, then HSTS (short max-age first).
- The authentication gaps in `docs/AUTH-PRODUCTION.md` closed or accepted.
- Live payments, calls and AI builds stay off until separately authorised (no secrets for them are installed by any workflow).
