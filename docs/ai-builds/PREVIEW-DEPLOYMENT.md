# AI build previews: isolated Cloudflare account, lifecycle and Founder setup

**Status (2026-10-28): prepared and tested with a fake deploy command and a fake Cloudflare API; no preview account
exists and nothing has been deployed.** Without the setup below, builds finish without a preview and cannot be
approved (by design).

## 1. What a preview is

- The generated site of **one build** (first build or revision), deployed as its own Cloudflare Worker named
  `cm-prv-<project>-b0` (first build) or `cm-prv-<project>-r<n>` (revision n), on a **separate Cloudflare account**
  used only for previews. A revision never replaces the preview an owner reviewed for an earlier build.
- The brochure starter is a static-assets Worker (`wrangler.jsonc`: `assets.directory = ./public`, `main =
  src/worker.js` for the `/api/contact` stub). **No bindings or resources:** no KV, D1, R2, queues, secrets or
  routes. The contact endpoint answers "not connected yet" (it never sends mail).
- Deployed and deleted by the **runner** (on the Windows machine), which holds the preview credential. The platform
  (Crestmont Worker) never holds a Cloudflare token; it stores the preview URL and Worker name per build and decides
  which previews to delete.

## 2. Isolation and safety (what the code enforces)

| Control | Where |
| --- | --- |
| Separate account, token scoped to Workers scripts on that account only | Founder setup (§4) |
| The agent never sees the credential (only the runner's deploy/delete commands get it) | `runner/src/job.ts` `deployPreview`, `deletePreview`; tested |
| Deploys a clean `git archive` export of the committed site with `node_modules`, `.npmrc`, `.yarnrc*`, `.pnpmfile.cjs`, `.wrangler`, `.dev.vars`, `.env*`, `.git` and links removed, so nothing the agent left behind is loaded by `npx wrangler` with the credential | `deployPreview`; `runner/test/preview.test.ts` |
| Refuses a Wrangler config with a custom `build` command, `routes` / custom domains, any path outside the project (`..`, absolute, `~`, drive paths) or a symlinked config | `previewConfigProblems`; tested |
| Deploys only after every acceptance check passed (static check, brief conformance, sandbox isolation, browser check) | `runJob` |
| Worker names are validated (`^cm-prv-[a-z0-9][a-z0-9-]{1,55}$`) before deploy and delete, on the runner and the platform | `PREVIEW_NAME` in both |
| The platform records a preview URL only on an allowed host (`BUILD_PREVIEW_HOSTS`, default `.workers.dev`, https, no credentials) | `src/services/builds.ts` |
| No production domains, routes, live payments or customer email from a preview | starter + config refusal; approval records a decision only |

## 3. Lifecycle

1. **Create:** after the checks pass, the runner commits, exports, and runs `PREVIEW_DEPLOY_COMMAND` with
   `CRESTMONT_PREVIEW_NAME`, `CRESTMONT_JOB_ID`, `CRESTMONT_PROJECT_ID`, the variables named in `PREVIEW_DEPLOY_ENV`
   and the runner's proxy settings. It reads the URL from a `PREVIEW_URL=https://…` line or the last `*.workers.dev`
   URL printed, and reports `previewUrl` + `previewName` to the platform.
2. **Review:** Owner → AI builds → build → Preview link. Approve records the decision only.
3. **Delete on request:** Owner → build → *Delete preview*. A build whose preview was deleted (or is being deleted)
   cannot be approved.
4. **Expire:** Owner → AI builds → "Delete superseded or finished previews after (days)". Empty (the default) keeps
   previews until an owner deletes them. When set, a preview expires once its build finished that many days ago AND
   the build is approved / canceled / failed or a newer build of the project exists. The preview currently in owner
   review is never expired automatically.
5. **Deletion is done by the runner** while idle (`previews/claim` → delete → `previews/deleted`). Each preview is
   handed out once per hour until the runner reports success; failures are logged on the build ("Preview deletion
   failed: …") and retried.

## 4. Founder setup

1. **Create the preview account.** A separate Cloudflare account (for example "Crestmont Previews"), never the
   production or staging account. Enable its `workers.dev` subdomain (Workers & Pages → your subdomain).
2. **Access control (recommended).** By default `workers.dev` URLs are public to anyone who has the link. Cloudflare
   Access can require a login for Workers on that account. Cloudflare documents protecting a Worker's
   `workers.dev` and preview URLs from the Worker's Access tab / Settings → Domains & Routes, and Access policies
   for all Workers, a hostname or a path; Zero Trust must be enabled on the account. Check the plan and seat cost
   with Cloudflare before enabling. Protecting **all Workers** of the preview account covers every new preview
   without per-preview steps. The runner does not configure Access.
3. **API token.** On the preview account only: *Workers Scripts: Edit* (Cloudflare's API lists Workers Scripts
   Write / Workers Admin for script deletion). Add *Account Settings: Read* only if Wrangler asks for it. No zone,
   DNS, D1, KV, R2 or other permissions. Note the 32-character account id.
4. **Secret files** on the build machine, in `C:\CrestmontRunner\secrets\` (mounted read-only at `/run/secrets`):
   `cloudflare_api_token`, `cloudflare_account_id`.
5. **Runner settings** in `C:\CrestmontRunner\compose\runner.local.env` (never in `runner.env`). Pin an exact
   Wrangler version you have checked. **Keep the single quotes around the command:** Docker Compose interpolates
   `$VARIABLES` in env files when it starts the stack, so an unquoted `"$CRESTMONT_PREVIEW_NAME"` becomes `""`
   (verified with `docker compose config`); single-quoted values are passed through literally to the runner, which
   sets the variable for each deploy.

   ```sh
   PREVIEW_DEPLOY_COMMAND='WRANGLER_SEND_METRICS=false npx --yes wrangler@<exact version> deploy --name "$CRESTMONT_PREVIEW_NAME"'
   PREVIEW_DEPLOY_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
   CLOUDFLARE_API_TOKEN_FILE=/run/secrets/cloudflare_api_token
   CLOUDFLARE_ACCOUNT_ID_FILE=/run/secrets/cloudflare_account_id
   PREVIEW_DELETE=cloudflare-api
   ```

   `PREVIEW_DELETE=cloudflare-api` uses the runner's built-in call to Cloudflare's documented
   `DELETE /accounts/{account_id}/workers/scripts/{script_name}` (no `force`; a Worker that no longer exists counts
   as deleted). `PREVIEW_DELETE_COMMAND=<shell command>` is the alternative (given `$CRESTMONT_PREVIEW_NAME` and the
   `PREVIEW_DEPLOY_ENV` variables).
6. **Egress.** Re-run the installer with `-ExtraEgressDomains api.cloudflare.com,registry.npmjs.org` (plus the
   GitHub hosts if you use project repositories). `npx` downloads Wrangler from the npm registry and Wrangler calls
   the Cloudflare API; nothing else is allowed out of the runner network.
7. **Platform.** Leave `BUILD_PREVIEW_HOSTS` unset for `*.workers.dev` previews. Set it (comma-separated host
   suffixes) only if previews move to another host.
8. **Retention.** Owner → AI builds → set the number of days, or leave it empty.
9. Restart the runner: `docker compose -f C:\CrestmontRunner\compose\docker-compose.yml up -d`.

## 5. Secret and variable inventory

| Name | Kind | Lives in | Used by |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret (preview account only) | `C:\CrestmontRunner\secrets\cloudflare_api_token` → `CLOUDFLARE_API_TOKEN_FILE` | runner deploy + delete; never the agent, never the platform |
| `CLOUDFLARE_ACCOUNT_ID` | identifier | `secrets\cloudflare_account_id` → `CLOUDFLARE_ACCOUNT_ID_FILE` | runner deploy + delete |
| `PREVIEW_DEPLOY_COMMAND`, `PREVIEW_DEPLOY_ENV`, `PREVIEW_DEPLOY_TIMEOUT_SECONDS` (600) | runner settings | `runner.local.env` | runner |
| `PREVIEW_DELETE` / `PREVIEW_DELETE_COMMAND`, `PREVIEW_DELETE_TIMEOUT_SECONDS` (180) | runner settings | `runner.local.env` | runner |
| `BUILD_PREVIEW_HOSTS` | Worker variable (optional) | staging/production Worker config | platform: which preview URLs are recorded |
| Preview retention days | owner setting | Owner → AI builds (`build_settings.preview_retention_days`) | platform |

The staging Worker and its D1/R2/KV are not touched by any of this.

## 6. Verify the setup (no customer data)

1. With the fictional project of `LOCAL-VALIDATION.md` §0.1, let one build reach owner review.
2. The build page shows a `https://cm-prv-…-b0.<subdomain>.workers.dev` preview. Open it signed out: with Access
   enabled it asks for a login; without it the page loads (record which).
3. Submit a revision; its preview is `…-r1`, and the first build's preview still shows the first version.
4. Press *Delete preview* on the first build. Within one idle poll the build shows "Deleted <time>" and the Worker is
   gone from the preview account.

## 7. Failure recovery

| Symptom | Cause / fix |
| --- | --- |
| Report: "PREVIEW_DEPLOY_COMMAND is not configured on the runner" | Add the §4.5 lines to `runner.local.env`, restart. |
| Report: "preview deploy command failed (exit …)" | Check the runner log; usually the token (permissions, wrong account) or egress (`api.cloudflare.com`, `registry.npmjs.org` not allowed). Fix, then *Retry* the build (or submit a revision). |
| Report: "refused to deploy: wrangler.jsonc …" | The agent changed the Wrangler config (build command, routes, paths outside the project). Not deployable by design: send a revision asking to restore the starter's `wrangler.jsonc`. |
| Report: "preview deploy succeeded but printed no preview URL" | The command printed no URL: make it print `PREVIEW_URL=https://…`, or check the account's `workers.dev` subdomain is enabled. |
| Build event: "Preview URL not recorded: its host is not an allowed preview host" | The URL is outside `BUILD_PREVIEW_HOSTS`; set the Worker variable if the host is intended. |
| Build event: "Preview deletion failed: Cloudflare API 403 …" | Token lacks script write/delete permission on the preview account, or the account id is wrong. It is retried hourly. |
| Previews pile up | Set the retention days, or delete previews from the build pages. |
