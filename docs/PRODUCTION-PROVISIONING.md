# Production provisioning, deployment and launch

Three separate stages. Each one needs the Founder; none happens on a push.

| Stage | What it does | How | Reversible? |
|---|---|---|---|
| **1. Provision** | Creates the D1 database `crestmont-production` and the Worker `crestmont-platform-production` as an empty draft holding its secrets (Turnstile, evidence, MFA encryption key); checks the R2 bucket `crestmont-files-production`. No code, no domain, no DNS, no migrations, no public URL. | Actions → **Provision production** (`.github/workflows/provision-production.yml`) | Yes: the draft Worker and empty database can be deleted in the dashboard. |
| **2. Deploy** | Uploads the approved commit, applies migrations, attaches `crestmontwebsitedevelopment.com`, runs post-deploy checks, rolls back on failure. | Actions → **Deploy production** (`deploy-production.yml`), after the Founder approves the release candidate | Code: `wrangler rollback`. Migrations are additive and are not rolled back. |
| **3. Open to customers** | Real email, `www` redirect, HSTS, Owner account, and the authentication items in `docs/AUTH-PRODUCTION.md`. | Founder decisions and configuration | — |

## Current state (2026-11-05)

| Resource | State | Evidence |
|---|---|---|
| D1 `crestmont-production` | Created, empty, `database_id` committed (`c667f1a9-…`) | Provision run [40614532868](https://github.com/Schmidt-Development/Crestmont-Website-Development/actions/runs/40614532868) |
| R2 `crestmont-files-production` | Present (Founder-created), checked | same run |
| Worker `crestmont-platform-production` | Empty draft; workers.dev and preview URLs off | same run |
| Secrets `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` (production widget), `EVIDENCE_INGEST_SECRET` (production-only) | Installed | same run |
| `MFA_ENCRYPTION_KEY` | **Not installed**: run 1 predates the MFA step. Re-run [41962310037](https://github.com/Schmidt-Development/Crestmont-Website-Development/actions/runs/41962310037) is waiting for the Founder's `production` approval (analysis below). | — |
| Phased launch | `AI_BUILD_AUTOMATION = "off"` committed for production ([PHASED-LAUNCH.md](PHASED-LAUNCH.md)) | `tests/ai-build-gate.test.ts` |

No code, migration, domain or DNS has been applied to production. No payment, email, voice or AI secret exists there.

### The waiting re-run (41962310037), read from its pinned commit `4bffc25`

- **What waits:** the single `provision` job, at the `production` environment gate. No step has run.
- **What approving changes:** installs `MFA_ENCRYPTION_KEY` from `PRODUCTION_MFA_ENCRYPTION_KEY` if that environment
  secret exists and is valid (base64, exactly 32 bytes, not low-entropy); if it is absent the step warns and changes
  nothing; if malformed the job fails before writing. The Turnstile keys and `EVIDENCE_INGEST_SECRET` are kept
  (`replace_turnstile` is false). The D1 database is found, not recreated, and must match the committed id. R2 is only checked.
- **Exposure:** none. The last step forces the workers.dev and preview URLs **off** and fails unless they read back off.
  No code, route, domain or migration is touched.
- **One edge case at that commit:** if `wrangler secret list` failed transiently, the step treated the Worker as having no
  secrets and would re-put the Turnstile keys (same values) and generate a new production `EVIDENCE_INGEST_SECRET`.
  Nothing reads that value (every evidence post goes to `READINESS_URL`, i.e. staging), so even then nothing breaks.
  The workflow on `main` after #148 fails closed instead.
- **Another run needed?** Only to add `CRM_ERASURE_HMAC_KEY` (introduced in #148; it keys the erasure tombstones that stop an
  erased person being re-imported by automated intake, all of which is off in phase 1). Not a phase 1 blocker; the
  next provisioning run after #148 merges installs it, and re-running is safe.

### Production Worker secrets (names only)

| Secret | Phase 1 | Installed by | State |
|---|---|---|---|
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | required | provision workflow (from environment secrets) | installed |
| `EVIDENCE_INGEST_SECRET` | required | provision workflow (generated) | installed |
| `MFA_ENCRYPTION_KEY` | **required** — the deploy now refuses without it | provision workflow (from `PRODUCTION_MFA_ENCRYPTION_KEY`) | **missing** |
| `CRM_ERASURE_HMAC_KEY` | recommended | provision workflow (generated, never replaced) | missing |
| `FILE_SCANNER_SECRET` | recommended (closes F-02 on production) | provision workflow, from the `production` environment secret `PRODUCTION_FILE_SCANNER_SECRET` (`openssl rand -hex 32`, saved in the password manager first; the same value goes into the Node 1 scanner's `scanner.env`). Installed once, never generated | not set: `/api/scan/*` answer 503, files stay `pending`, quarantined from share links and never labelled clean. The scanner (`scanner/`, ClamAV) has its own credential, so phase 1 keeps `BUILD_RUNNER_SECRET` forbidden |
| `FOUNDER_EMAIL` | recommended | Founder (`wrangler secret put`) | not set; launch approvals are recorded on staging, so it does not block production |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (+ `EMAIL_FROM` var) | at customer activation | Founder, after the Resend account (BLK-005) | not set |
| `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET` (+ `PAYMENTS_LIVE_AUTHORIZED = "yes"` var) | at customer activation | Founder, separate authorization | not set: production refuses every Stripe event until then |
| `BUILD_*`, `AI_BUILD_AUTOMATION`, `ANTHROPIC_API_KEY`, `RETELL_*`, `RESEARCH_*`, `CRM_IMPORT_SECRET`, `PAYMENT_SIMULATION_ENABLED`, `STAGING_ACCESS_PASSWORD` | **forbidden in phase 1** | — | provisioning warns; the deploy refuses the AI/Retell ones while deferred |

### Monitoring and backups before launch

- `/api/health` reports `aiBuildAutomation`. The post-deploy checks require it to equal the released configuration (a
  mismatch rolls the deploy back), and `production-health-monitor.yml` fails if the running Worker is more open than
  committed — the only way a Worker secret override of `AI_BUILD_AUTOMATION` would otherwise go unnoticed.
- `production-health-monitor.yml` and scheduled `production-backup.yml` runs skip until the **repository** variable
  `PRODUCTION_URL` exists (set it at launch). Before #148 every daily backup asked for a `production` approval; the
  stale ones (2026-10-30 and 11-04) were cancelled. The backup still needs its off-Cloudflare destination
  (`BACKUP_S3_*`, `BACKUP_SEAL_PASSPHRASE`, docs/BACKUP-RECOVERY.md §3.2) before its first real run.

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
  - `PRODUCTION_FILE_SCANNER_SECRET` (optional until the scanner runs against production) — output of `openssl rand -hex 32`, saved in the password manager first; the provision workflow installs it once as the Worker's `FILE_SCANNER_SECRET`, and the Node 1 scanner (`scanner/windows/Install-CrestmontScanner.ps1`) uses the same value.
  - `PRODUCTION_MFA_ENCRYPTION_KEY` — output of `openssl rand -base64 32`, saved in the password manager **before** it is added here. It encrypts every stored two-factor secret on production; the workflow installs it once and never replaces it (a different value would make every enrolled authenticator unreadable). Without it, two-factor enrolment on production fails closed, so no Owner account can be completed.
- **Environment variables** (needed by Stage 2, harmless now): `PRODUCTION_URL` = `https://crestmontwebsitedevelopment.com`, `READINESS_URL` = `https://crestmont-platform-staging.partners-df4.workers.dev`.

### Run it
Actions → **Provision production** → *Run workflow* (branch `main`) → confirmation `provision crestmont-platform-production` → approve the `production` deployment when GitHub asks. The run summary shows the D1 `database_id` (not a secret) and the secret **names** installed. Re-running is safe and changes no existing Worker secret (a changed secret blocks rollbacks, Cloudflare 10220); to replace the Turnstile keys, tick *replace_turnstile*, and do it only between deploys.

Then commit that `database_id` into `[env.production]` of `wrangler.toml` through a pull request; `deploy-production.yml` refuses to run until it is committed.

## Stage 2 — before the first production deploy
- Stage 1 complete and the `database_id` committed.
- `EVIDENCE_INGEST_SECRET` repository secret set, staging redeployed with it, fingerprints match (`docs/DEPLOYMENT.md` §5).
- Staging credentials rotated after the public-artifact exposure, so the staging Owner account used for release approval is trustworthy again.
- A release tag, the candidate approved at `/staff/readiness/approve` (Owner + MFA).
- DNS: screenshot the apex records, then remove any CNAME on the apex (a custom domain cannot be created on a hostname with a CNAME). SSL/TLS: Full (strict), minimum TLS 1.2, Always Use HTTPS. No HSTS yet.

## Stage 3 — before opening to customers
- Transactional email (Resend) authorised and configured: without it, sign-up confirmation and password-reset links are only recorded in the outbox, not delivered.
- Production Owner account bootstrapped (`scripts/bootstrap-owner.ts --email <founder> --print-sql --url https://crestmontwebsitedevelopment.com`; `--url` is required), MFA enrolled. AI website generation is off by configuration (`AI_BUILD_AUTOMATION = "off"`, [PHASED-LAUNCH.md](PHASED-LAUNCH.md)); the Owner's switch in Owner → AI builds cannot reopen it.
- `www` → apex redirect rule, then HSTS (short max-age first).
- The authentication gaps in `docs/AUTH-PRODUCTION.md` closed or accepted.
- Live payments, calls and AI builds stay off until separately authorised (no secrets for them are installed by any workflow).
