# Customer production delivery (Founder decision D5)

**Status (2026-10-28): framework built and tested with controlled fixtures (a local stand-in for `wrangler deploy`
and a fake live site). No customer-hosting account exists, no runner has `PRODUCTION_DEPLOY_COMMAND`, and nothing
has been deployed.** Until the setup in §5 is done, a release can be prepared and authorized but no runner will
ever claim it.

## 1. Workflow

Approving a preview never publishes anything. The ten steps the Founder approved, and where each one lives:

| # | Step | Where |
| --- | --- | --- |
| 1 | AI generates the website | runner build (`RUNNER-PROTOCOL.md`) |
| 2 | Automated validation | runner acceptance checks (static, brief conformance, sandbox isolation, browser) |
| 3 | Owner reviews the preview | Owner → AI builds → build → *Open preview* (private, `PREVIEW-DEPLOYMENT.md` §2a) |
| 4 | Customer reviews the preview when applicable | *Share private preview with customer*; the customer records *It is ready* / *Request changes* in the portal. If the preview was not shared, the Owner records why customer review does not apply when preparing the release. |
| 5 | Owner approves the final website | *Approve preview for delivery* (records the decision only) |
| 6 | Production deployment is prepared | Owner → AI builds → project → **Production delivery** → *Prepare release* (creates numbered version vN; deploys nothing) |
| 7 | Owner explicitly authorizes | *Authorize production release*: Owner only (`builds.configure`), recent MFA step-up, and the site's Worker name typed to confirm |
| 8 | Deploy to the customer-specific environment | the build runner claims the authorized release and deploys it to `cm-site-<project>` on the customer-hosting account |
| 9 | Post-deployment verification | the runner fetches the live site and compares the index page's SHA-256 with the released file (bounded retries) |
| 10 | Status and evidence recorded | state, URL, HTTP status, hashes, attempts, event history and audit log per version |

States: `prepared → authorized → deploying → live` (verified) / `verification_failed` (deployed, content did not
match: the previous live version stays recorded as live) / `failed` / `canceled`; a live version becomes
`superseded` when a newer one is verified live.

## 2. Guarantees (enforced in code and tested)

- **Per-customer identity:** one target per project (`site_targets`), Worker name `cm-site-<project>` (unique,
  `cm-site-*` only, never containing "crestmont", never a preview `cm-prv-*` name). A customer domain is a separate,
  explicitly typed Owner authorization, unique across customers; Crestmont, `workers.dev` and `pages.dev` domains are
  refused. One release in flight per site (database constraint).
- **Credentials never in AI code or containers:** the release is deployed by the runner process only, with
  `PRODUCTION_DEPLOY_ENV` variables that must be different variables **and** values from the preview credentials
  (the runner refuses to start otherwise). The agent, the build sandbox and the deployed site never receive them
  (`PRODUCTION_*` and Cloudflare names are blocked from the agent environment).
- **Exactly what was approved:** the runner deploys the authorized commit from **this project's own repository**
  (refuses any other repository URL and checks the checked-out commit), as a clean export with a runner-generated
  config; the site cannot add routes, bindings or build commands.
- **No overwrite of another customer:** names and domains are unique per project; the runner checks the name pattern.
- **Never Crestmont production:** the platform's own Worker is not a `cm-site-*` name and lives on a different account.
- **Rollback and recovery:** *Prepare rollback to vN* creates a new version from an earlier verified version's source;
  it needs its own authorization. A runner that disappears mid-deploy leaves the release `failed` (never retried
  automatically, because the live state is unknown); the Owner checks the site and prepares again.
- **Audit:** `builds.site_target_created`, `builds.site_domain_changed`, `builds.site_release_prepared`,
  `builds.site_release_authorized`, `builds.site_release_canceled`, `builds.site_rollback_prepared`,
  `builds.site_release_live`, `builds.site_release_failed`; plus a per-version event history on the page.
- The customer is notified when a version is live and verified.
- D2 hand-off: the approved preview's 30-day retention starts only when its production deployment is verified.

## 3. Runner protocol (v1.4)

`POST /api/builds/runner/deployments/claim` (HMAC-signed, capability `production-deploy`) →
`{ deployment: { id, leaseToken, kind, version, projectId, workerName, hostname, sourceRepo, sourceCommit } | null }`.
`POST /api/builds/runner/deployments/complete` → `{ deploymentId, leaseToken, result: "deployed" | "failed",
deployedUrl, contentSha256, verification: { url, httpStatus, expectedSha256, actualSha256, matched, attempts }, error }`.
Lease: 30 minutes. A runner without the capability never receives a release.

## 4. What is not done here

No hosting plan is purchased, no customer domain or DNS is changed, no Cloudflare account is created, and no real
release is executed. Domain purchase/transfer and DNS changes at the customer's registrar stay manual Founder steps.

## 5. Founder setup (when the first customer site is ready to go live)

1. **Customer-hosting account:** a Cloudflare account used only for customer production sites (not the Crestmont
   platform account, not the preview account). Workers Free covers static-asset sites; check the plan before
   attaching custom domains at scale.
2. **API token** on that account only: *Workers Scripts: Edit*; add *Workers Routes / Zone* permissions only for zones
   whose custom domains you authorize. Store it as `C:\CrestmontRunner\secrets\site_cloudflare_api_token` and the
   account id as `secrets\site_cloudflare_account_id`.
3. **Runner settings** (`runner.local.env`, single quotes kept):

   ```sh
   PRODUCTION_DEPLOY_COMMAND='CLOUDFLARE_API_TOKEN="$SITE_CLOUDFLARE_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$SITE_CLOUDFLARE_ACCOUNT_ID" WRANGLER_SEND_METRICS=false npx --yes wrangler@<exact version> deploy'
   PRODUCTION_DEPLOY_ENV=SITE_CLOUDFLARE_API_TOKEN,SITE_CLOUDFLARE_ACCOUNT_ID
   SITE_CLOUDFLARE_API_TOKEN_FILE=/run/secrets/site_cloudflare_api_token
   SITE_CLOUDFLARE_ACCOUNT_ID_FILE=/run/secrets/site_cloudflare_account_id
   ```

   Project repositories (`PROJECT_REPO_*`) are required: releases are built from the versioned repository.
4. Restart the runner; `Get-RunnerHealth.ps1` / the startup log shows `customerDelivery: true`.
5. First release: with a fictional project, prepare → authorize → watch it go live on its `workers.dev` address,
   check the evidence, then prepare a rollback and cancel it. Only then authorize a real customer's domain.
