# AI build previews: isolated Cloudflare account, private access, lifecycle and Founder setup

**Status (2026-10-28): prepared and tested with a fake deploy command, a fake Cloudflare API and the generated gate
executed locally; no preview account exists and nothing has been deployed.** Without the setup below, builds finish
without a preview and cannot be approved (by design).

Founder decisions implemented here: **D2** (retention: 30 days after final approval) and **D3** (private previews with
authentication). See §2a and §3.

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
| Every preview is private (D3): the runner refuses to deploy without `PREVIEW_GATE_SECRET` and replaces the site's Wrangler config with its own, whose entry point is the gate | `runner/src/preview-gate.ts`, `deployPreview`; `runner/test/preview-gate.test.ts` |

## 2a. Private previews (Founder decision D3)

**Decision: platform-authenticated gate, $0.** Cloudflare Access was evaluated first. Access protects
`workers.dev` URLs and is free up to 50 users, then billed per user per month. Every customer who opens a preview
would count as a user, so the cost grows with customers, and Access would need its own identity setup for them.
The platform already authenticates staff (with MFA) and customers, so the lowest-cost secure design uses that:

- The runner deploys every preview with a **gate** it generates (`__crestmont_preview_gate.mjs`) as the Worker's
  entry point and `assets.run_worker_first = true`, so **every** request (pages, CSS/JS/images, `/api/*`, unknown
  paths) passes through it. Without a valid session the answer is `401` with a one-line text and **no site content**.
- **Sign-in link:** the platform checks who is asking and redirects to
  `https://<preview>/__crestmont/auth?t=<payload>.<signature>`. The link is valid for **5 minutes**, names the preview
  it is for, and is signed with that preview's own key. Staff with `builds.read` get one from *Open preview*; a
  customer gets one only for a **shared**, undeleted, gated preview of **their own organization's project**.
- The gate exchanges the link for a **2-hour session cookie** `__Host-cm_prv` (HttpOnly, Secure, SameSite=Lax,
  host-only: each preview has its own host, so a session for one preview never opens another), then redirects to a
  relative path so the token leaves the address bar. Responses are `private, no-store`, `noindex`, `no-referrer`,
  `nosniff`, `DENY` framing.
- **Keys:** preview key = HMAC-SHA256(`PREVIEW_GATE_SECRET`, `"crestmont-preview-key:" + workerName`). Only the
  derived key is deployed (as `CRESTMONT_PREVIEW_KEY`); the master secret stays on the platform
  (`BUILD_PREVIEW_GATE_SECRET`) and the runner (`PREVIEW_GATE_SECRET`). The site's own Worker code receives an env
  without the key and requests without the gate cookie.
- **No build internals are deployed:** the export is the committed site only (§2); logs, reports, `.git`, env files
  and runner files never reach a preview.
- The site's own config is honoured where safe (assets directory, `run_worker_first` patterns, `not_found_handling`,
  plain `vars`); anything a preview cannot honour safely (data bindings, services, Durable Objects, routes, TOML
  configs) is **refused**, not silently dropped.
- A preview recorded by an older runner without the gate is labelled **Public (legacy)**, cannot be shared with a
  customer, and should be deleted.
- Customer flow: Owner → build → *Share private preview with customer* → the customer is notified → portal →
  Revisions → *Website previews* → *Open preview*; an account administrator records *It is ready* or *Request
  changes* (with a reason). That review is step 4 of the delivery workflow (`DELIVERY.md`).

Access remains possible later on top of the gate (defence in depth), but it is not required and is not configured.

## 3. Lifecycle (Founder decision D2: 30 days after final approval)

1. **Create:** after the checks pass, the runner commits, exports, wraps the export in the gate (§2a) and runs
   `PREVIEW_DEPLOY_COMMAND` with `CRESTMONT_PREVIEW_NAME`, `CRESTMONT_JOB_ID`, `CRESTMONT_PROJECT_ID`, the variables
   named in `PREVIEW_DEPLOY_ENV` and the runner's proxy settings. It reads the URL from a `PREVIEW_URL=https://…`
   line or the last `*.workers.dev` URL printed, and reports `previewUrl`, `previewName` and `previewGated`.
2. **Review:** Owner → AI builds → build → *Open preview*. Approve records the decision only (nothing is published).
3. **Retention (automatic, scheduled):** the 15-minute platform sweep applies these rules per project:
   - builds in progress and previews awaiting owner review **never** expire;
   - until the Owner approves a final build, nothing expires;
   - after the Owner approves the final build, every **superseded** preview of the project is deleted **30 days**
     after that approval (a later failed/canceled attempt: 30 days after it finished);
   - the **approved** preview is kept until its production deployment is verified (`DELIVERY.md`); its 30 days start
     then;
   - a preview whose source is not recoverable (no project repository and no checkpoint) is **never** deleted
     automatically or manually: it may be the only copy of the site;
   - the Owner can **Preserve** a preview (never deleted automatically), **Extend retention by 30 days**, or stop
     preserving it. The dashboard shows each preview's scheduled deletion date.
   - Retention days are an Owner setting (default 30, 1–365).
4. **Delete on request:** Owner → build → *Delete preview* (refused for the approved preview before hand-off and
   for unrecoverable previews). A build whose preview was deleted (or is being deleted) cannot be approved.
5. **Deletion is done by the runner** while idle (`previews/claim` → delete → `previews/deleted`). Each preview is
   handed out once per hour until the runner reports success; failures are logged on the build and retried safely
   (the delete is idempotent: a Worker that no longer exists counts as deleted). Every retention decision and every
   deletion is audited (`builds.preview_expired`, `builds.preview_deleted`, `builds.preview_retention_changed`).
   Deleting a preview never touches a customer's live site: previews and production sites use different accounts and
   Worker name prefixes (`cm-prv-*` vs `cm-site-*`), and the runner refuses any other name.
6. **No external cleanup infrastructure is active** until the preview account exists: without a configured runner,
   deletion requests simply wait.

## 4. Founder setup

1. **Create the preview account.** A separate Cloudflare account (for example "Crestmont Previews"), never the
   production or staging account. Enable its `workers.dev` subdomain (Workers & Pages → your subdomain).
2. **Preview gate secret (required, D3).** Generate one random value of at least 32 characters (for example
   `[Convert]::ToBase64String((1..48 | % { Get-Random -Max 256 }) -as [byte[]])` in PowerShell, or
   `openssl rand -base64 48`). Store it twice, never in a repository: as the platform Worker secret
   `BUILD_PREVIEW_GATE_SECRET` (`wrangler secret put BUILD_PREVIEW_GATE_SECRET` on the environment that will run
   builds) and on the build machine as `C:\CrestmontRunner\secrets\preview_gate_secret`. Cloudflare Access is not
   needed (§2a).
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
   PREVIEW_GATE_SECRET_FILE=/run/secrets/preview_gate_secret
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
8. **Retention.** Owner → AI builds → "Preview retention after final approval (days)": 30 by Founder decision.
9. Restart the runner: `docker compose -f C:\CrestmontRunner\compose\docker-compose.yml up -d`.

## 5. Secret and variable inventory

| Name | Kind | Lives in | Used by |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret (preview account only) | `C:\CrestmontRunner\secrets\cloudflare_api_token` → `CLOUDFLARE_API_TOKEN_FILE` | runner deploy + delete; never the agent, never the platform |
| `CLOUDFLARE_ACCOUNT_ID` | identifier | `secrets\cloudflare_account_id` → `CLOUDFLARE_ACCOUNT_ID_FILE` | runner deploy + delete |
| `PREVIEW_DEPLOY_COMMAND`, `PREVIEW_DEPLOY_ENV`, `PREVIEW_DEPLOY_TIMEOUT_SECONDS` (600) | runner settings | `runner.local.env` | runner |
| `PREVIEW_DELETE` / `PREVIEW_DELETE_COMMAND`, `PREVIEW_DELETE_TIMEOUT_SECONDS` (180) | runner settings | `runner.local.env` | runner |
| `PREVIEW_GATE_SECRET` / `BUILD_PREVIEW_GATE_SECRET` | secret (same value, ≥32 chars) | runner: `secrets\preview_gate_secret` → `PREVIEW_GATE_SECRET_FILE`; platform: Worker secret | runner derives each preview's key; platform signs sign-in links. Never deployed. |
| `BUILD_PREVIEW_HOSTS` | Worker variable (optional) | staging/production Worker config | platform: which preview URLs are recorded |
| Preview retention days | owner setting | Owner → AI builds (`build_settings.preview_retention_days`) | platform |

The staging Worker and its D1/R2/KV are not touched by any of this.

## 6. Verify the setup (no customer data)

1. With the fictional project of `LOCAL-VALIDATION.md` §0.1, let one build reach owner review.
2. The build page shows *Open preview* and **Private**. Open the raw `https://cm-prv-…-b0.<subdomain>.workers.dev`
   URL in a private window: it must answer `401` with no site content, also for `/assets/css/site.css` and
   `/api/contact`. *Open preview* from the dashboard must load the site.
3. Share it with the fictional customer; sign in as that customer: portal → Revisions → *Open preview* works. Sign in
   as another fictional customer: the preview is not listed and its portal URL answers 404.
4. Submit a revision; its preview is `…-r1`, and the first build's preview still shows the first version.
5. Press *Delete preview* on the first build. Within one idle poll the build shows "Deleted <time>" and the Worker is
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
| Report: "PREVIEW_GATE_SECRET … is not configured on the runner" | Add the secret file and `PREVIEW_GATE_SECRET_FILE` (§4.2, §4.5), restart. |
| *Open preview*: "BUILD_PREVIEW_GATE_SECRET is not configured on the platform" | Set the Worker secret (§4.2) to the same value as the runner's. |
| Preview answers 401 right after *Open preview* | The two secrets differ, or the link was older than 5 minutes; open it again from the dashboard. |
| Previews pile up | Retention applies only after a final approval; delete superseded previews from the build pages or preserve only what you need. |
