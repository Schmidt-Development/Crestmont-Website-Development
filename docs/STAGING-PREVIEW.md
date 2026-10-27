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
6. **Run it** — **Actions → Deploy staging → Run workflow** (it also runs on every push to `main`).

## What you get

When the run finishes, open it and download the **staging-preview-access** artifact (private to repository
members, kept 7 days). It contains the preview URL, the preview password (if generated) and one demo account
per role: Owner (all 32 modules), Administrator, Sales, Developer, Project Manager, Support, and two customer
accounts. Staff accounts use two-factor authentication: add the listed setup key to an authenticator app.

- Lost the password? Re-run the workflow with **rotate_preview_password** ticked.
- Want fresh demo accounts? Re-run with **reseed_demo_accounts** ticked.
- R2 (file uploads) is optional: if it is not enabled on the account the preview works and file pages say
  storage is not configured. Enable R2 in the dashboard to turn uploads on (R2 asks for a payment method even
  on its free tier — that is your decision).

## Safety properties (verified by tests)

- The whole site is behind the preview password; staging stays **locked** if no password is configured.
- The preview gate is an extra outer lock: portal and staff sign-in, MFA and permissions still apply.
- Demo accounts use the reserved `.test` domain, so no email can ever reach a real inbox.
- Turnstile uses Cloudflare's documented always-pass **test** keys on staging only.
- Staging has its own database; production is never touched by this workflow.
