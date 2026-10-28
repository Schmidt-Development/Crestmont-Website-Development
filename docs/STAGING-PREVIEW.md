# Staging preview — setup (one time, about 10 minutes)

The staging preview is the real Crestmont platform running on Cloudflare with sample data, behind a private
preview password. No real payments, emails or phone calls happen there. Everything except the steps below is
automated by `.github/workflows/deploy-staging.yml`.

## What you do (once)

1. **Cloudflare account** — sign in or create one at https://dash.cloudflare.com (the free plan is enough).
2. **workers.dev subdomain** — in the dashboard open **Workers & Pages**. If asked, choose a subdomain
   (for example `crestmont`). The preview will live at `https://crestmont-platform-staging.<subdomain>.workers.dev`.
3. **API token** — **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, then
   **+ Add more → Account → D1 → Edit**. Account resources: your account. Zone resources: none needed.
   Create the token and copy it (it is shown once).
4. **Account ID** — on the dashboard home page (right-hand column, "Account ID").
5. **GitHub secrets** — in `Schmidt-Development/Crestmont-Website-Development` → **Settings → Secrets and variables
   → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token from step 3
   - `CLOUDFLARE_ACCOUNT_ID` = the ID from step 4
   - optional `STAGING_PREVIEW_PASSWORD` = a preview password you choose (otherwise one is generated)
   - **`ACCESS_ARTIFACT_PASSPHRASE`** = a long passphrase you keep in your password manager. **Required while the
     repository is public**: artifacts of a public repository can be downloaded by anyone signed in to GitHub, so the
     access notes are encrypted with this passphrase, and are not issued at all without it.
   - **`EVIDENCE_INGEST_SECRET`** = `openssl rand -hex 32`, set once (docs/DEPLOYMENT.md §5). The same value is used
     by every workflow; without it staging uses a key derived from the Cloudflare token, and CI, releases and production release authorization cannot sign against staging.
6. **Run it** — **Actions → Deploy staging → Run workflow** (it also runs on every push to `main`).

## What you get

Each successful run downloads as a **staging-preview-access** artifact (kept 7 days). In a public repository it
contains `staging-access.md.enc`; decrypt it locally (Git Bash on Windows, Terminal on macOS):

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in staging-access.md.enc -out staging-access.md
```

and enter `ACCESS_ARTIFACT_PASSPHRASE`. Delete the decrypted file when done. The notes hold, at the top: the website URL, the preview password, the Owner email, the Owner
password and the Owner 2FA authenticator setup key, followed by every other demo account.

The artifact is issued **only after the run has verified the whole sequence on the live site**: preview
password → Owner email and password → a valid 2FA code → all 32 Owner modules loading. If that check fails the
run fails and no artifact is issued, so an artifact never holds credentials that do not work.

How the credentials stay in sync: every run derives the preview password and all demo credentials from the
`CLOUDFLARE_API_TOKEN` secret plus a random salt kept in the staging database, and re-applies them to the
Worker secret and the demo accounts. The newest artifact is therefore always correct, and credentials do not
change between runs unless they are rotated.

- **Rotate everything** (preview password, all demo passwords and 2FA keys; old sessions are signed out):
  re-run with **rotate_credentials** ticked. Re-add the Owner key to your authenticator afterwards.
- Rotating the Cloudflare API token also changes the derived credentials on the next run.
- Want fresh sample data? Re-run with **reseed_demo_accounts** ticked.
- Choosing your own preview password: set the `STAGING_PREVIEW_PASSWORD` repository secret; it is used as-is.
- R2 (file uploads) is optional: if it is not enabled on the account the preview works and file pages say
  storage is not configured. Enable R2 in the dashboard to turn uploads on (R2 asks for a payment method even
  on its free tier — that is your decision).

## Staging browser evidence

After verification, every run also drives a real Chromium browser through the preview: the gate, every public page
linked from the homepage, the customer portal (with tenant isolation) and every Owner module. Results are
recorded as **staging** evidence for TEST-002. The journey is read-only; it never submits business forms.
Rehearse locally with `tests/e2e/staging.e2e.ts` (see its header for the three variables).

## Safety properties (verified by tests)

- The whole site is behind the preview password; staging stays **locked** if no password is configured.
- The preview gate is an extra outer lock: portal and staff sign-in, MFA and permissions still apply.
- Demo accounts use the reserved `.test` domain, so no email can ever reach a real inbox.
- Turnstile uses Cloudflare's documented always-pass **test** keys on staging only.
- Staging has its own database; production is never touched by this workflow.
