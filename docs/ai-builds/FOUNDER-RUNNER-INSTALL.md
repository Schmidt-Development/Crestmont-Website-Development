# AI Website Builder: Founder setup for the first real build

**Status (2026-10-28): nothing on this page has been done on the build machine.** The runner has never been
installed there, no real model has generated a site, and no step below has been verified on that machine. The
repository work it depends on is finished and CI-tested (lockfile, image digests, installer fixes, isolation evidence,
customer revisions, preview lifecycle). This page is the exact order of the remaining work. Details:
`WINDOWS-SUPERCOMPUTER.md` (Windows kit), `RUNNER-SETUP.md` (secrets, repositories), `PREVIEW-DEPLOYMENT.md`
(previews) and `LOCAL-VALIDATION.md` (the first controlled build).

Nothing here turns on paid AI. The installer writes `RUNNER_ALLOW_PAID_PROVIDER=false` into the managed `runner.env`
and refuses that key in your own `runner.local.env`. The platform separately refuses work to any runner that does
not declare zero token cost unless `BUILD_ALLOW_PAID_PROVIDER=true` is set on the Worker. Leave both off.

## A. Decisions to make first

| Decision | Options | Effect |
| --- | --- | --- |
| Where the first build runs | Staging Worker (recommended) | Staging must be provisioned first. `wrangler.toml` has an empty `database_id` (BLK-003). |
| How Ollama runs | Native Windows app (default), or `-OllamaInDocker` (NVIDIA only, needs the WSL 2 backend) | Native is simpler. The Docker option keeps the model server inside the compose stack. |
| Unattended reboots | Logon task (default), auto-logon, or NSSM service | The default task only starts at **your** logon (`WINDOWS-SUPERCOMPUTER.md` § Operations). |
| Project repositories | None (commits stay in the runner and its checkpoints), or a dedicated GitHub org + fine-grained token | Without a repository, the revision drill needs the checkpoint bundle for the diff. |
| Previews | None (builds cannot be approved), or a separate Cloudflare preview account (`PREVIEW-DEPLOYMENT.md`) | Approval needs a preview. Decided (D3): previews are private behind the platform's gate; set the preview gate secret. |
| Customer revision policy | Decided (D1): `owner_approval` (default) | Each request waits for you to approve or reject it. |
| Preview retention | Decided (D2): 30 days after final approval (default setting) | `PREVIEW-DEPLOYMENT.md` §3. |
| Model | The installer's recommendation (from detected VRAM/RAM), or `-Model <tag>` | `-Model` overrides only the model choice; driver, disk, WSL and Docker blockers still stop the install. |

## B. Prepare

1. **Curated skills.** Copy the skill folders listed in `runner/skills/manifest.json` (four are required) to
   `C:\CrestmontRunner\skills\` on the build machine (`RUNNER-SETUP.md` §6). Missing required skills fail preflight.
2. **Runner secret.** Generate at least 32 random characters.
   - Windows has no `openssl` by default. In PowerShell (5.1 or 7), cryptographically random:
     `$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)`.
   - Install it on the staging Worker as `BUILD_RUNNER_SECRET` (`RUNNER-SETUP.md` §3).
   - Keep the value for step C3. The Worker answers 503 on every runner endpoint until it is set.
3. **Already done in the repository (nothing to do):** `runner/sandbox/package-lock.json` is committed (CI's image
   build verifies every hash with `npm ci`), and every base image is pinned by tag and digest.

## C. Install on the Windows machine

Use an elevated PowerShell. The administrator account should be the account that logs in day to day, because the
Ollama settings and the auto-start task are registered for it.

1. **Hardware.** Run `.\runner\windows\Discover-Hardware.ps1 -PlatformUrl https://<staging-host>`. It is read-only.
   - Requirements: Windows build 19045 or newer.
   - NVIDIA driver 551.61 or newer when there is an NVIDIA GPU.
   - Disk: the model size plus about 40 GB.
2. **Report-only pass.** Run `.\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://<staging-host>`.
   - Fix every blocker it lists. It checks Docker Engine 26+, Docker Compose 2.24+ and whether Docker Desktop runs on
     the WSL 2 backend (from its VM kernel).
3. **Install.** Run `.\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://<staging-host> -Install`.
   - Add `-ExtraEgressDomains github.com,api.github.com,api.cloudflare.com,registry.npmjs.org` **only if** you chose
     project repositories and/or previews. The runner's network has no route out except the egress proxy; git pushes
     and preview deploys use that proxy (never the agent).
   - Enter the secret when prompted, or pass `-SecretFile`.
   - Reboot and re-run if WSL or Docker Desktop were just installed.
4. **Health.** The installer ends with "Done" only when `Get-RunnerHealth.ps1` passes; otherwise it says the health
   check failed and exits 1. The owner dashboard (Owner → AI builds) must show the runner as checked in, with no
   "Paid provider refused" banner.
5. **Optional repositories and previews.** Put your settings in `C:\CrestmontRunner\compose\runner.local.env`
   (created by the installer with commented examples). Never edit `runner.env`: it is rewritten on every run.
   - Store token files in `C:\CrestmontRunner\secrets\` (mounted read-only at `/run/secrets`) and refer to them with
     `<NAME>_FILE=/run/secrets/<file>`, e.g. `PROJECT_REPO_TOKEN_FILE=/run/secrets/project_repo_token`.
   - Previews: `PREVIEW-DEPLOYMENT.md` lists every variable.
   - Restart with `docker compose -f C:\CrestmontRunner\compose\docker-compose.yml up -d`.
   - Re-running the installer (for example with `-Model`) keeps `runner.local.env`; if an older `runner.env` had
     your own lines, they are moved into `runner.local.env` and the old file is backed up as `runner.env.<time>.bak`.
     The installer stops if `runner.local.env` sets an installer-managed key or one that would weaken the sandbox or
     enable a paid provider.

## D. First real build

Follow `LOCAL-VALIDATION.md`:
- use the fictional sample intake (§0.1)
- start the measurement and the paid-API tripwire (§1); pass `-EvidenceDir` to keep all evidence in one folder
- run and review the build (§2–§3)
- run the revision drill (§3a, from the customer portal) and the cancel/crash drills (§4)
- collect the evidence (§5)
- tick the ten-point proof checklist (§5a)

Only a completed checklist counts as a passed first real build.

## E. Installer and evidence issues found on 2026-10-28: status

| Issue | Status |
| --- | --- |
| `-Model` cleared every blocker | Fixed: only model-choice blockers (`modelChoiceBlockers`) are overridden. |
| `runner.env` rewritten on every run, dropping hand-added lines | Fixed: managed `runner.env` + never-overwritten `runner.local.env`; old lines moved; backup on change. |
| Tool scripts copied only without `-NoAutoStart` | Fixed: always copied. |
| Isolation evidence lost when the job ends | Fixed: the runner records `docker inspect` of every build container in the job directory (`evidence/sandbox-isolation-NN.json`); the owner report shows `check:sandbox-isolation`; `Collect-Evidence.ps1 -JobId` copies the records. |
| Evidence split across folders; `health.json` named wrongly | Fixed: `-EvidenceDir` (one folder), the latest monitor's `utilization.csv` copied otherwise, `EVIDENCE-INDEX.txt`. |
| `ollama` not on PATH right after a winget install; model check matched a substring | Fixed: full path; exact tag match. |
| "Done" printed when health failed | Fixed. |
| Egress proxy log does not cover traffic from the Windows host itself (native Ollama) | Unchanged (inherent): the tripwire proves the runner and sandbox cannot reach paid AI; for the host, check Ollama's server log and do not sign in to Ollama cloud models. |
| Troubleshooting for Docker Desktop not starting, WSL updates, full disk, `docker-users` for the logon task | Not covered: check Docker Desktop first when health fails after a reboot. |

## F. What is still open before production (not needed for the first test build)

- The first real build itself (this page, then `LOCAL-VALIDATION.md`).
- Customer production delivery (D5): the framework exists (`DELIVERY.md`); the customer-hosting account and the
  runner's `PRODUCTION_DEPLOY_COMMAND` are not set up, so nothing can be published yet.
- Whether AI revisions should be charged differently from staff-delivered rounds: today the existing allowance and
  change-order rules decide entitlement; the AI builder adds no pricing.

## G. Who does what (Founder decisions of 2026-10-28)

**A. Engineering Claude finishes in the repository (done on PR #16, CI-tested):** D1 revision approval queue; D2
retention policy and scheduled cleanup; D3 private-preview gate and signed sign-in links; D4 native-Ollama health
(model availability, GPU residency) and isolation invariants; D5 delivery framework (targets, versions, Owner
authorization with MFA step-up, runner deploy + verification, rollback, audit); docs below.

**B. Configuration Claude can do with access it already has:** none at the moment. The staging Worker is frozen for
the credential-exposure remediation, and Claude has no access to the build machine or to Cloudflare accounts.

**C. Founder-only actions, in order:**

| # | Action | Where |
| --- | --- | --- |
| 1 | Finish the staging credential remediation; then merge PR #16 when you choose | GitHub |
| 2 | Provision staging D1 (`wrangler d1 create`, put the id in `wrangler.toml`, apply migrations up to 0042) | `RUNNER-SETUP.md` §2 |
| 3 | Generate and set `BUILD_RUNNER_SECRET` on the staging Worker | §B2 above |
| 4 | Install native Ollama and the runner kit on the Windows machine; confirm `ollama ps` shows `100% GPU` and `Get-RunnerHealth.ps1` reports GPU residency 100% | §C above, `WINDOWS-SUPERCOMPUTER.md` |
| 5 | Create the preview Cloudflare account and token; generate the preview gate secret; set it as `BUILD_PREVIEW_GATE_SECRET` (Worker) and `secrets\preview_gate_secret` (runner) | `PREVIEW-DEPLOYMENT.md` §4 |
| 6 | Run the first real build with the fictional intake and tick the proof checklist | `LOCAL-VALIDATION.md` |
| 7 | Later, for the first real customer: customer-hosting Cloudflare account, token, `PRODUCTION_DEPLOY_*` settings, a fictional release drill | `DELIVERY.md` §5 |
