# AI Builds runner: Founder setup

The build runner (`runner/`) is a separate Node 22 process. It pulls eligible paid-intake build jobs from the Crestmont
control plane (the Worker, see `RUNNER-PROTOCOL.md`), runs a coding agent in an isolated workspace per job attempt,
and reports progress, checkpoints and an owner report back. It never publishes to production, changes domains, takes
payments or emails customers. Every build lands in **owner review**.

**Agent providers.**
- **`local` (default): self-hosted model, zero per-token fees.** An in-house tool-using agent talks to a model
  server you run (Ollama) through its OpenAI-compatible API. Every command, install, build, test and browser check
  runs in a per-build container sandbox. The supported deployment is the company's Windows build machine:
  **follow `WINDOWS-SUPERCOMPUTER.md`**, then validate with `LOCAL-VALIDATION.md`. Sections 3–6 and 9–10 below apply
  to it too. Sections 2, 8 (SDK part) and 11 apply only to the optional adapter.
- **`claude-agent-sdk` (optional, paid): the original Claude Agent SDK adapter.** It is off unless you set
  **both** `RUNNER_AGENT_PROVIDER=claude-agent-sdk` and `RUNNER_ALLOW_PAID_PROVIDER=true`. It is never used as a
  fallback when the local provider fails. A failing local build fails honestly.

Nothing in this document has been run against real accounts or the Windows machine yet. The runner's automated
tests use a fake control plane, a fake OpenAI-compatible model server, a fake Docker executor and a fake Agent SDK.
The first real build is the acceptance test (`LOCAL-VALIDATION.md` for local; section 9 for the SDK adapter).

## 1. Where to run it (optional Agent SDK adapter on a Linux host)

The local provider runs on the Windows build machine (`WINDOWS-SUPERCOMPUTER.md`). The rest of this section is for
the optional paid adapter.


Run it on a small Linux host you control, in Docker, one job at a time:

- A VM (any provider) with 2 vCPU, 4 GB RAM and 40 GB disk is enough for one concurrent job. Anthropic's hosting
  guide suggests 1 GiB RAM, 5 GiB disk and 1 CPU per agent as a starting floor, and the browser checks need more
  ([hosting guide](https://code.claude.com/docs/en/agent-sdk/hosting#resources)).
- Prefer a VM dedicated to the runner. It holds customer project data and an Anthropic API key.
- Cloudflare Workers cannot host it (the Agent SDK spawns a Claude Code subprocess and needs a writable disk, git
  and npm). Cloudflare Containers might work later; that is unverified and not part of this setup.

Outbound HTTPS the host needs: `api.anthropic.com`, the platform URL (control plane), `registry.npmjs.org`, and when
enabled, `github.com` / `api.github.com` (project repositories) and `api.cloudflare.com` (previews). Nothing inbound.

## 2. Anthropic API key (optional paid adapter only)

Skip this section for the local provider: it never reads `ANTHROPIC_API_KEY`, and its egress proxy denies
`anthropic.com`.


1. In the Claude Console (console.anthropic.com; Anthropic's docs now link it as platform.claude.com), create a
   dedicated **workspace** named for example `crestmont-ai-builds`.
2. Set a **monthly spend limit** on that workspace. This is the hard ceiling; everything else below is a soft control.
3. Create an **API key** in that workspace. Store it in a file only you can read, for example
   `/srv/crestmont/secrets/anthropic_api_key`.

Use an API key. Do not run unattended builds on a claude.ai Pro/Max subscription login: the runner supports only
`ANTHROPIC_API_KEY` (optionally `ANTHROPIC_BASE_URL`).

## 3. Shared runner secret

Generate one secret and give it to both sides:

```sh
openssl rand -hex 32 > /srv/crestmont/secrets/build_runner_secret
chmod 600 /srv/crestmont/secrets/build_runner_secret
# Easiest: add it as the GitHub repository secret BUILD_RUNNER_SECRET; the next "Deploy staging" run installs it on
# the staging Worker. Or directly, from the platform repo:
npx wrangler secret put BUILD_RUNNER_SECRET --env staging     # paste the same value
```

Without the Worker secret every runner endpoint answers `503 Build runner not configured`.

## 4. Project repositories (optional, recommended)

Without this, each build's commits stay in the runner workspace and in the checkpoint git bundle, and the owner
report says so.

1. Create a **dedicated GitHub organization** (for example `crestmont-builds`) used only for AI build repositories.
   Do not reuse the platform's organization.
2. Create a **fine-grained personal access token**:
   - Resource owner: that organization only. Expiration: 90 days or less.
   - Repository access: *All repositories* (needed so the runner can create one private repository per project).
   - Repository permissions: *Contents: Read and write*, *Administration: Read and write* (repository creation),
     *Metadata: Read*. Nothing else.
   - Confirm the permission names against GitHub's current fine-grained token documentation when you create it.
3. Save it as `/srv/crestmont/secrets/project_repo_token`.
4. Stricter alternative: create each project repository by hand (`crestmont-build-<projectId>`) and give the token
   access to only those repositories, without *Administration*. The runner then only pushes.

The token is used only by the runner process (git push / repository creation) through a per-command environment.
It is never written to `.git/config` and never reaches the agent. Branches pushed: `ai-build/first-build`,
`ai-build/revision-<n>`.

## 5. Preview deploys (optional)

Without this, reports say "Preview unavailable".

1. Create a **separate Cloudflare account** for previews only (for example "Crestmont Previews"). Never the
   production account. Enable its `workers.dev` subdomain.
2. Create an **API token** scoped to that account with *Workers Scripts: Edit* (add *Account Settings: Read* if
   Wrangler asks for it). No zone, DNS or other permissions.
3. Save the token and account id as files: `/srv/crestmont/secrets/cloudflare_api_token`,
   `/srv/crestmont/secrets/cloudflare_account_id`.
4. Set the deploy command (pin an exact Wrangler version you have checked):

   ```sh
   PREVIEW_DEPLOY_COMMAND='npx --yes wrangler@<exact version> deploy --name "$CRESTMONT_PREVIEW_NAME"'
   PREVIEW_DEPLOY_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
   ```

The runner (not the agent) runs the command in the job repository after the acceptance checks pass, with only
`CRESTMONT_PREVIEW_NAME`, `CRESTMONT_JOB_ID`, `CRESTMONT_PROJECT_ID` and the variables named in
`PREVIEW_DEPLOY_ENV` added to a secret-free environment. It reads the URL from a `PREVIEW_URL=https://…` line or the
last `*.workers.dev` URL in the output. It refuses to deploy when the project's Wrangler config has a custom
`build` command, routes or custom domains. `workers.dev` previews are public to anyone with the link; put Cloudflare
Access in front of the preview account if that matters.

## 6. Curated skills

Put the toolkit skills on the host, one directory per skill, each containing its `SKILL.md`, under
`/srv/crestmont/skills/` with the directory names from `runner/skills/manifest.json` (`source` field):
`frontend-design`, `ui-ux-pro-max`, `design-taste-frontend`, `impeccable`, `emil-design-eng`, `design-auditor`,
`web-design-guidelines`, `design-md-library`, `image-to-code`, `webapp-testing`, `playwright-skill`.

Required per workflow (a missing one fails the job at preflight):

| Workflow | Required | Optional |
| --- | --- | --- |
| Standard brochure (starter / business / premium) | Frontend Design, Web Design Guidelines, Webapp Testing, Playwright | UI/UX Pro Max, Taste Skill, Impeccable, Emil design engineering, Design Auditor, DESIGN.md references, Image to Code |
| Custom app | Frontend Design, Webapp Testing, Playwright | Web Design Guidelines, UI/UX Pro Max, Impeccable, Design Auditor, Image to Code |

Change `required` flags in the manifest if you decide otherwise. To pin a reviewed version, set `sha256` to the
SHA-256 of that skill's `SKILL.md` (`sha256sum SKILL.md`); a mismatch counts as missing. Only the listed skills are
copied into each workspace, and only their names are enabled for the session.

## 7. Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CONTROL_PLANE_URL` | yes | | Platform base URL, for example `https://crestmont.example` |
| `BUILD_RUNNER_SECRET` or `BUILD_RUNNER_SECRET_FILE` | yes | | Shared HMAC secret (prefer `_FILE`) |
| `RUNNER_AGENT_PROVIDER` | no | `local` | `local` (self-hosted model) or `claude-agent-sdk` (paid, optional) |
| `RUNNER_ALLOW_PAID_PROVIDER` | no | `false` | Must be `true` before the paid adapter starts. Never a fallback. |
| `LOCAL_MODEL` | local: yes | | Model tag on the model server, e.g. `qwen3-coder:30b` (see `WINDOWS-SUPERCOMPUTER.md`) |
| `LOCAL_MODEL_BASE_URL` | no | `http://host.docker.internal:11434/v1` | OpenAI-compatible endpoint; hosted AI APIs and `*-cloud` models are refused |
| *(local provider, sandbox, AI drafts)* | no | | Full list in `WINDOWS-SUPERCOMPUTER.md` § "Configuration added for the local provider" |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE` | SDK adapter only | | Console API key for the paid adapter (prefer `_FILE`); not read by the local provider |
| `ANTHROPIC_BASE_URL` | no | | Optional proxy that injects the key outside the host |
| `RUNNER_WORKSPACES` | yes | `/workspaces` in the image | Job workspaces; must not be inside any git repository |
| `SKILLS_SOURCE_DIR` | yes | `/skills` in the image | Curated skill sources (section 6) |
| `RUNNER_ID` | no | `runner-<hostname>` | Identifies this runner in claims (≤ 64 chars) |
| `PROJECT_REPO_OWNER` | no | | GitHub organization (or user) for project repositories |
| `PROJECT_REPO_TOKEN` or `PROJECT_REPO_TOKEN_FILE` | no | | Fine-grained token (section 4) |
| `PROJECT_REPO_OWNER_TYPE` | no | `org` | `user` when the owner is a user account |
| `PROJECT_REPO_PREFIX` | no | `crestmont-build-` | Repository name prefix (+ project id) |
| `PREVIEW_DEPLOY_COMMAND` | no | | Preview deploy command (section 5) |
| `PREVIEW_DEPLOY_ENV` | no | | Comma list of variables passed only to the preview command; each may use `<NAME>_FILE` |
| `PREVIEW_DEPLOY_TIMEOUT_SECONDS` | no | `600` | |
| `RUNNER_SANDBOX` | no | `on` | SDK adapter: Claude Code OS sandbox for agent shell commands (section 8). The local provider always uses per-build containers. |
| `RUNNER_ALLOWED_DOMAINS` | no | `registry.npmjs.org` | Sandbox network allowlist for agent shell commands |
| `RUNNER_FETCH_REFERENCES` | no | off | `1` lets the agent WebFetch only the brief's reference-site hosts |
| `RUNNER_MAX_BUDGET_USD` | no | `50` | SDK adapter: per-attempt spend cap (the stricter of this and the server's limits wins). Local inference costs $0. |
| `RUNNER_MAX_TURNS` | no | `300` | Local per-attempt turn cap |
| `RUNNER_MAX_RUNTIME_MINUTES` | no | `180` | Local per-attempt wall-clock cap |
| `RUNNER_HEARTBEAT_SECONDS` | no | server value | Override the heartbeat interval |
| `RUNNER_POLL_MIN_SECONDS` / `RUNNER_POLL_MAX_SECONDS` | no | `15` / `300` | Idle polling backoff |
| `RUNNER_CHECK_TIMEOUT_SECONDS` | no | `300` | Per acceptance check |
| `RUNNER_MAX_CUSTOMER_FILE_MB` | no | `25` | Largest customer file downloaded into a workspace |
| `RUNNER_SECRETS_DIR` | no | `/run/secrets` | Directory the agent is denied (mount secrets here) |
| `CRESTMONT_PLATFORM_REPO_PATTERNS` | no | `Crestmont-Website-Development,crestmont-platform` | Remotes that mark a platform checkout (startup refusal) |
| `RUNNER_GIT_NAME` / `RUNNER_GIT_EMAIL` | no | `Crestmont AI Builds` / noreply | Commit identity |
| `LOG_LEVEL` | no | `info` | `debug` adds agent stderr lines |

## 8. Build, check and start

**Local provider:** use `runner/windows/Install-CrestmontRunner.ps1` (`WINDOWS-SUPERCOMPUTER.md`). It builds the
images, writes the compose stack (runner + egress proxy), runs `--preflight` and starts it. On a Linux host the same
`runner/windows/docker-compose.yml` works with Docker Engine >= 26. Write `runner.env` and `proxy/squid.conf` by hand
from the installer's steps 7-8.

**Optional paid adapter (Linux host):** the image needs `--build-arg INSTALL_AGENT_SDK=true` (which requires a
reviewed `runner/agent-sdk/package-lock.json`, section 12) and the environment
`RUNNER_AGENT_PROVIDER=claude-agent-sdk RUNNER_ALLOW_PAID_PROVIDER=true`:

```sh
# On the host, from a checkout of the platform repository (the image itself contains only runner/):
docker build --build-arg INSTALL_AGENT_SDK=true -t crestmont-ai-runner -f runner/Dockerfile runner

docker volume create crestmont-ai-workspaces

docker run --rm \
  -v crestmont-ai-workspaces:/workspaces -v /srv/crestmont/skills:/skills:ro -v /srv/crestmont/secrets:/run/secrets:ro \
  -e CONTROL_PLANE_URL=https://<platform domain> \
  -e BUILD_RUNNER_SECRET_FILE=/run/secrets/build_runner_secret \
  -e RUNNER_AGENT_PROVIDER=claude-agent-sdk -e RUNNER_ALLOW_PAID_PROVIDER=true \
  -e ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key \
  crestmont-ai-runner node --no-warnings src/main.ts --preflight
```

`--preflight` verifies isolation and every required skill for both workflows, then the provider. SDK adapter: every
tool (git, node, npm, tar, Playwright Chromium, and bubblewrap/socat when the sandbox is on). Local provider: the model
is pulled on the model server and the sandbox image exists. It exits non-zero on any failure. Then start it:

```sh
docker run -d --name crestmont-ai-runner --restart unless-stopped --memory 4g --cpus 2 \
  -v crestmont-ai-workspaces:/workspaces -v /srv/crestmont/skills:/skills:ro -v /srv/crestmont/secrets:/run/secrets:ro \
  -e CONTROL_PLANE_URL=https://<platform domain> \
  -e BUILD_RUNNER_SECRET_FILE=/run/secrets/build_runner_secret \
  -e RUNNER_AGENT_PROVIDER=claude-agent-sdk -e RUNNER_ALLOW_PAID_PROVIDER=true \
  -e ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key \
  -e PROJECT_REPO_OWNER=crestmont-builds -e PROJECT_REPO_TOKEN_FILE=/run/secrets/project_repo_token \
  -e PREVIEW_DEPLOY_COMMAND='npx --yes wrangler@<exact version> deploy --name "$CRESTMONT_PREVIEW_NAME"' \
  -e PREVIEW_DEPLOY_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID \
  -e CLOUDFLARE_API_TOKEN_FILE=/run/secrets/cloudflare_api_token -e CLOUDFLARE_ACCOUNT_ID_FILE=/run/secrets/cloudflare_account_id \
  crestmont-ai-runner
```

**Sandbox.** With `RUNNER_SANDBOX=on` (default) the agent's shell commands run in Claude Code's OS sandbox
(bubblewrap + socat on Linux) with network limited to `RUNNER_ALLOWED_DOMAINS`, and the session fails rather than
running unsandboxed. Bubblewrap inside Docker usually needs user namespaces that Docker's default seccomp/AppArmor
profiles block; if the first build fails with a sandbox error, either add
`--security-opt seccomp=unconfined --security-opt apparmor=unconfined` (the container and VM remain the outer
boundary) or set `RUNNER_SANDBOX=off` and enforce egress with a host firewall that allows only the domains in
section 1. Which of these works on your host is not verified yet.

**Stop.** `docker stop -t 300 crestmont-ai-runner` (local stack: `docker compose stop runner`). On SIGTERM the runner
stops claiming, interrupts the running agent, commits, checkpoints and completes the job as `released` (protocol
v1.1), which requeues it without spending an attempt; the next attempt resumes the session from the checkpoint. A plain kill leaves the lease to expire on the server.
**Pause new work** from the owner dashboard (server-side pause); the runner keeps polling and receives
`{"job":null,"reason":"paused"}`. `--once` runs at most one job and exits.

## 9. First real run (acceptance)

1. Run `--preflight` (section 8) until it passes.
2. In the platform, queue one internal test project on the Starter package with a low run budget (for example $5).
3. Watch `docker logs -f crestmont-ai-runner` and the owner dashboard: stages preparing → building → verifying,
   heartbeats with cost, then `ready_for_review` (or an honest `failed` / `needs_information`).
4. Open the owner report: check statuses, the checks list, the preview link and the repository branch.
5. Compare the reported cost (Agent SDK client-side estimate) with the Claude Console usage page.

## 10. What is logged

JSON lines on stdout: timestamps, runner id, job id and attempt, workspace path, stage changes, outcomes, cost and
turn totals, control-plane retries and errors, preflight results. With `LOG_LEVEL=debug`, also the agent CLI's
stderr. Not logged: brief content, prompts, tool inputs (heartbeat activity carries only a tool name and its target
path, sanitized again server-side). Registered secret values and common token shapes are redacted from every line.

Workspaces under `/workspaces` contain customer project data (brief, files, code, session transcripts) and are kept
after each attempt for resume and debugging. Delete old ones according to `docs/RETENTION-SCHEDULE.md`, for example
`find /var/lib/docker/volumes/crestmont-ai-workspaces/_data -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} +`.

## 11. Cost controls (from hardest to softest)

Local provider: there is no per-token cost. `runCostUsd` is always 0, and the owner report lists tokens, model calls
and model wall time instead. Turn, runtime and output-token caps still apply. The items below concern the optional
paid adapter.


1. Claude Console workspace spend limit (section 2): the only control that cannot be exceeded.
2. Control-plane budgets: per run and per project, enforced on every heartbeat (`continue:false, reason:"budget"`).
3. Runner caps: each agent phase gets `maxBudgetUsd` = the stricter remaining budget (run, project,
   `RUNNER_MAX_BUDGET_USD`) and `maxTurns` within the turn cap; wall-clock cap `RUNNER_MAX_RUNTIME_MINUTES`.
4. Costs reported by the runner are the Agent SDK's client-side estimates, known at phase boundaries (plan, build,
   verify), and can overshoot a cap by up to one model response
   ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)). Authoritative billing is the Console.

## 12. Dependency locking and image builds

Every npm install in the images is `npm ci` from a committed lockfile (a test in `runner/test/supply-chain.test.ts`
fails on `npm install`, `npx --yes` or `curl | sh` in a Dockerfile).

| Manifest | What it installs | Lockfile |
| --- | --- | --- |
| `runner/package.json` | Nothing: the local default (agent loop, model client, sandbox, drafts) uses only Node built-ins. | `runner/package-lock.json`, committed. Generated with `npm install --package-lock-only --offline` (there is nothing to resolve). The runner image runs `npm ci --omit=dev --ignore-scripts`, which fails if the two disagree. |
| `runner/sandbox/package.json` | `playwright` 1.63.0 (exact) for `browser-check.mjs`; the image then downloads that Playwright's Chromium. 1.63.0 is the version the real-Chromium browser-check test ran with. | `runner/sandbox/package-lock.json`: **not committed yet** (no registry access where this was written; a hand-written lockfile would be fabricated). |
| `runner/agent-sdk/package.json` | Optional paid adapter only: `@anthropic-ai/claude-agent-sdk` and `playwright` (exact). Moved out of `optionalDependencies` so the default lockfile is complete. | `runner/agent-sdk/package-lock.json`: not committed. `--build-arg INSTALL_AGENT_SDK=true` refuses to build without it. |

To create a missing lockfile: take it from the `runner-lockfiles` artifact of the CI job `runner-images` (CI
generates it for that build and prints a warning), or on any machine with registry access run
`cd runner/sandbox && npm install --package-lock-only --ignore-scripts`. Review it (every `resolved` URL is
`https://registry.npmjs.org/...`, every entry has a `sha512-` integrity) and commit it; the supply-chain test then
validates it on every run. `Install-CrestmontRunner.ps1` stops before building when a lockfile is missing.

**Base images** are exact version tags, never floating: `node:22.23.4-bookworm-slim` (runner and sandbox; the Node
version the tests ran on), `docker:27.5.1-cli` (Docker CLI copied into the runner), `debian:12.12-slim` (proxy),
`ollama/ollama:0.32.0` (optional ollama-in-docker profile; the installer's `-OllamaImage`). They are `ARG`s at the top
of each Dockerfile. Digests could not be fetched here (Docker Hub was unreachable), so they are **not** pinned by
digest yet: the `runner-images` job writes the digest each tag resolved to into its job summary. After reviewing a
green build, append them (`ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:<digest>`); the test accepts
`tag@sha256:<digest>`. Debian packages are not version-pinned (bookworm security updates win); hadolint's DL3008 is
ignored inline for that reason only.

**CI image build** (`.github/workflows/ci.yml`, job `runner-images`, `contents: read`, nothing pushed): hadolint
2.14.0 (checksum-verified binary) on all three Dockerfiles; `docker buildx build` of the runner (default build, no
paid SDK), the sandbox and the egress proxy; then `runner/ci/sandbox-self-check.ts` (drives the runner's own
`JobSandbox` with the real docker CLI, so the container gets the production flags, and checks uid 10001, no network
tools, no setuid binaries, no network, read-only root, no capabilities, timeout kill, the locked Playwright, and
`browser-check.mjs` passing the brochure starter in offline Chromium) and `runner/ci/runner-image-self-check.ts`
(uid, Node >= 22.21, docker CLI >= 26, no SDK, the paid adapter refused without opt-in, `select-model.ts` run the
installer's way, `squid -k parse` of the rendered allow-list inside the proxy image) and `runner/ci/egress-e2e.ts`
(starts the proxy on the real compose networks and checks from both internal networks that hosted AI APIs get 403,
the runner reaches the platform and a fake model server, installs reach only the npm registry, nothing leaves without
the proxy, and the validation tripwire fails when the proxy is down). Job `windows-scripts` parses
every PowerShell script and runs PSScriptAnalyzer with Windows PowerShell 5.1 compatibility rules
(`runner/windows/Test-WindowsScripts.ps1`); job `windows-powershell-51` (workflow `windows-powershell.yml`, only when `runner/windows/**` changes) repeats the parse with the 5.1 parser on a
GitHub-hosted Windows VM and runs the read-only `Discover-Hardware.ps1` into `select-model.ts` there.

## 13. Known limits and residual risks

Local provider: see `WINDOWS-SUPERCOMPUTER.md` § "Isolation details" (Docker socket held by the runner; Docker
Desktop VM as the boundary). The points below concern the optional SDK adapter.


- The agent and the checks it writes run as the same OS user as the runner. Secrets are read from files and are
  not in the agent's environment. The agent is denied the secrets directory by permission rules and, with the
  sandbox on, by OS-level read denial; `/proc`, `/etc` and `/root` reads are denied by permission rules only, which
  cover Claude's file tools and recognized shell file commands, not arbitrary scripts. Acceptance checks and the
  preview command run outside the sandbox.
  For stronger isolation run one container per job.
- The agent necessarily has its own `ANTHROPIC_API_KEY`. Use a dedicated, spend-limited workspace key, or
  `ANTHROPIC_BASE_URL` with a key-injecting proxy.
- Resuming on a different host needs the proposed checkpoint-fetch endpoint (see the runner's protocol change
  proposals); without it the runner restores from the project repository and starts a new session, and says so.
