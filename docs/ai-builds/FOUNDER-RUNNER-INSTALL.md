# AI Website Builder: Founder setup for the first real build

**Status (2026-10-28): nothing here has been done.** The runner has never been installed on the Windows build
machine, no real model has generated a site, and no step below has been verified on that machine. This page is the
exact order of work. The details behind each step are in `WINDOWS-SUPERCOMPUTER.md` (the Windows kit),
`RUNNER-SETUP.md` (secrets, repositories, previews) and `LOCAL-VALIDATION.md` (the first controlled build).

Nothing here turns on paid AI. The installer writes `RUNNER_ALLOW_PAID_PROVIDER=false`. The platform separately
refuses work to any runner that does not declare zero token cost unless `BUILD_ALLOW_PAID_PROVIDER=true` is set on
the Worker. Leave both off.

## A. Decisions to make first

| Decision | Options | Effect |
| --- | --- | --- |
| Where the first build runs | Staging Worker (recommended) | Staging must be provisioned first. `wrangler.toml` has an empty `database_id` (BLK-003). |
| How Ollama runs | Native Windows app (default), or `-OllamaInDocker` (NVIDIA only) | Native is simpler. The Docker option keeps the model server inside the compose stack. |
| Unattended reboots | Logon task (default), auto-logon, or NSSM service | The default task only starts at **your** logon (`WINDOWS-SUPERCOMPUTER.md` § Operations). |
| Project repositories | None (commits stay in the runner and its checkpoints), or a dedicated GitHub org + fine-grained token | Without a repository, the revision drill needs the checkpoint bundle for the diff. |
| Previews | None (builds stop at "no preview to approve"), or a separate Cloudflare preview account + Workers-only token | Approval needs a preview. `workers.dev` previews are public to anyone with the link: decide whether that is acceptable or put Cloudflare Access in front. |
| Model | The installer's recommendation (from detected VRAM/RAM), or `-Model <tag>` | Judge quality from the preview in `LOCAL-VALIDATION.md` §6. |

## B. Prepare (on a machine with registry access, then commit)

1. **Sandbox lockfile.** The installer stops at its image step without `runner/sandbox/package-lock.json`.
   - Take it from the CI artifact `runner-lockfiles`, or run `cd runner/sandbox && npm install --package-lock-only --ignore-scripts`.
   - Review it, then commit it.
   - `RUNNER-SETUP.md` §12 explains this.
2. **Curated skills.** Copy the skill folders listed in `runner/skills/manifest.json` (four are required) to
   `C:\CrestmontRunner\skills\` on the build machine. This is `RUNNER-SETUP.md` §6. Missing required skills fail preflight.
3. **Runner secret.** Generate at least 32 random characters.
   - Windows has no `openssl` by default. In PowerShell (5.1 or 7), cryptographically random:
     `$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)`.
   - Install it on the staging Worker as `BUILD_RUNNER_SECRET` (`RUNNER-SETUP.md` §3).
   - Keep the value for step C3. The Worker answers 503 on every runner endpoint until it is set.

## C. Install on the Windows machine

Use an elevated PowerShell. The administrator account should be the account that logs in day to day, because the
Ollama settings and the auto-start task are registered for it.

1. **Hardware.** Run `.\runner\windows\Discover-Hardware.ps1 -PlatformUrl https://<staging-host>`. It is read-only.
   - Requirements: Windows build 19045 or newer.
   - NVIDIA driver 551.61 or newer when there is an NVIDIA GPU.
   - Disk: the model size plus about 40 GB.
2. **Report-only pass.** Run `.\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://<staging-host>`.
   - Fix every blocker it lists.
   - Run `wsl --status` and confirm "Default Version: 2". The installer only checks that the command succeeds.
3. **Install.** Run `.\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://<staging-host> -Install`.
   - Add `-ExtraEgressDomains github.com,api.github.com,api.cloudflare.com,registry.npmjs.org` **only if** you chose
     project repositories and/or previews. The runner's network has no route out except the egress proxy, so pushes
     and preview deploys need these hosts allowed.
   - Enter the secret when prompted, or pass `-SecretFile`.
   - Reboot and re-run if WSL or Docker Desktop were just installed.
   - If `ollama` is not found right after a fresh winget install, open a new elevated window and re-run.
4. **Health.** Run `C:\CrestmontRunner\Get-RunnerHealth.ps1`. It must exit 0.
   - The installer prints "Done" even when health fails, so do not rely on "Done" alone.
   - The owner dashboard (Owner → AI builds) must show the runner as checked in, with no "Paid provider refused" banner.
5. **Optional repositories and previews.** Add the `PROJECT_REPO_*` and `PREVIEW_DEPLOY_*` lines to
   `C:\CrestmontRunner\compose\runner.env`.
   - Store the token files in `C:\CrestmontRunner\secrets\` (mounted read-only at `/run/secrets`). Refer to them as
     `PROJECT_REPO_TOKEN_FILE=/run/secrets/project_repo_token`, and the same pattern for the Cloudflare values.
   - Restart with `docker compose -f C:\CrestmontRunner\compose\docker-compose.yml up -d`.
   - **Every installer re-run rewrites `runner.env` and drops these lines.** This includes a `-Model` re-run. Keep
     a copy and re-add them.
   - The `RUNNER-SETUP.md` §4–5 examples use `/srv/crestmont/secrets`. On Windows the path is the one above.

## D. First real build

Follow `LOCAL-VALIDATION.md`:
- use the fictional sample intake (§0.1)
- start the measurement and the paid-API tripwire (§1)
- run and review the build (§2–§3)
- run the revision drill (§3a) and the cancel/crash drills (§4)
- collect the evidence (§5)
- tick the ten-point proof checklist (§5a)

Only a completed checklist counts as a passed first real build.

## E. Known installer and evidence issues (found 2026-10-28, not yet fixed in the scripts)

None of these weakens isolation or enables paid AI. They make the first install harder to get right.

| Issue | Workaround |
| --- | --- |
| `-Model <tag>` clears **every** recommendation blocker, including driver, disk and WSL blockers (`Install-CrestmontRunner.ps1`, `$script:Problems.Clear()`). | Run once without `-Model` and fix the non-model blockers first. |
| `runner.env` is rewritten on every run. | Re-add the repository and preview lines (C5). |
| The `C:\CrestmontRunner\*.ps1` tools are copied only when `-NoAutoStart` is **not** given. | Do not use `-NoAutoStart`, or run the tools from `runner\windows\`. |
| Sandbox containers are removed when a job ends, so `Collect-Evidence.ps1 -JobId` run afterwards has no `docker-inspect-cm-job-*.json`. | Run `Collect-Evidence.ps1 -JobId <bld_…>` (or `docker inspect` the `cm-job-…` container) **while** the build is running. |
| `-Monitor` and `-JobId` write separate timestamped evidence folders. The header says `health.json` but the file is `health.txt`. | Keep both folders together in the acceptance record. |
| The egress proxy log does not cover traffic from the Windows host itself. Native Ollama runs on the host. | The tripwire still proves the runner and sandbox cannot reach paid AI. For the host, check Ollama's own server log and do not sign in to Ollama cloud models. |
| Docker Desktop failing to start, WSL updates, a full disk and `docker-users` membership for the logon task are not covered by the troubleshooting docs. | Check Docker Desktop first when health fails after a reboot. |

## F. What engineering still owes before production (not needed for the first test build)

- Script fixes for section E.
- Pin base-image digests, and commit the sandbox lockfile (B1).
- Connect customer revision requests (the portal's revision rounds) to AI build revisions. Today the owner submits AI revisions by hand, and AI revisions do not count against the package's revision rounds. This is a business decision (section G of the readiness report).
- Production deployment authorization. Approval of a preview records a decision only. No production publish path exists for generated sites. This is intentional until the Founder decides the delivery process.
