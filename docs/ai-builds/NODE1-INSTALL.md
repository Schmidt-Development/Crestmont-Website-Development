# Node 1 — runner installation, staging connection and hardware certification

Founder P0 directive, 2026-10-30. Target: the Crestmont AI runner permanently on Node 1 (Windows, RTX 5090 32 GB),
connected to **staging** only. **Production is not touched by anything in this document.**

> **Status when this was written: nothing here has run on Node 1.** Every step that changes Node 1 waits for your
> authorization (marked **APPROVAL**). Node 1 counts as connected only when the D01–D13 diagnostic on staging passes.

## 1. What was reconciled (engineering, done)

| Item | Finding | Resolution |
|---|---|---|
| Runner implementation | One runner: `runner/` (Node 22, Docker sandboxes, egress proxy, native Ollama). The installer is `runner/windows/Install-CrestmontRunner.ps1`. | Kept. No second runner was created. |
| PR #52 (D01–D13) | Already on `main` (merged through #64), so staging has it. | — |
| PR #16 (dual-model V4) | Not merged. It predates #52, and its migrations 0041–0043 collide with `main` (0041–0050 are already on staging). | Branch `claude/node1-runner-integration`: `main` merged in, 10 conflicts resolved, migrations renumbered to **0051–0053**, D07 computer-name evidence (`RUNNER_HOST_LABEL`) restored in the installer. |
| PR #51 (simulated purchase) | Stacked on #16. Its `0044_simulated_payments` collides, and its payment handler conflicts with `main`'s idempotent CREST-GAP-006 rework. | Branch `claude/node1-e2e-integration`: migration renumbered to **0054**, payment path rebuilt on `main`'s idempotent follow-ups, and no receipt is sent for a simulated payment (also in the repair sweep). |
| Staging protocol vs V4 runner | V4 additions are additive (v1.5). The runner works with today's staging in single-runner mode (no GPU worker id). | You install now against staging as it is. Worker enrollment comes after #16 is merged (§8). |
| HQ/JARVIS safety | The installer rewrote Ollama's global settings and force-restarted Ollama. The GPU scheduler unloaded *any* model that didn't fit, including JARVIS's. | `-PreserveOllamaConfig`: Ollama is not changed or restarted. The scheduler only ever unloads Crestmont's own Model A/B (regression test). |
| Rollback | There was none. | Images are kept as `:1-previous` before each rebuild, and `Uninstall-CrestmontRunner.ps1` offers stop, `-Rollback` and `-Remove`. |
| Crash/restart | Containers restart on crash. Nothing restarted a stopped Docker Desktop or compose stack. | The start task also runs every 5 minutes as a watchdog while you are signed in. With `-PreserveOllamaConfig` it never starts Ollama. |

Tests on the integration branches: platform 690/690 (`node1-runner-integration`) and 694/694 (`node1-e2e-integration`).
Runner: 161 passed, 0 failed, 4 skipped. The skipped tests need PowerShell or Squid and run in the repository's Windows CI
on push. **PowerShell parsing and PSScriptAnalyzer did not run where this was prepared.** They run in
`windows-powershell.yml` when the branch is pushed. Don't run the installer until that job is green.

## 2. Models (verified on ollama.com, 2026-10-30)

| Role | Ollama tag (exact) | Download | Notes |
|---|---|---|---|
| Model A: architecture, review, difficult repairs | `qwen3.8:27b-q4_K_M` | 18 GB | 256K context, text and image input |
| Model B: primary website generation | `qwen3.6:35b-a3b-q4_K_M` | 24 GB | 256K context, text and image input. Badges: tools, thinking, vision |

No substitution was made. The library pages state no minimum Ollama version, so update Ollama if `ollama pull`
rejects a model. The models don't fit in 32 GB together (18 + 24 GB plus KV cache), so the runner keeps one in memory at a time.

**GPU sharing with HQ/JARVIS (Founder decision).** JARVIS's `qwen3:30b-a3b` (about 19 GB) and Model B (24 GB) don't fit
together either. Crestmont never unloads JARVIS's model. But when Crestmont loads Model B, Ollama may evict JARVIS's
model if it is idle, and JARVIS then reloads it on its next request. If JARVIS is busy at that moment, Model B can
partly spill to the CPU, and diagnostic step D09 fails (it requires ≥ 95 % in VRAM). Options:
(a) accept time-sharing, (b) run Crestmont jobs when JARVIS is quiet, or (c) give JARVIS a smaller model.

## 3. APPROVAL checklist (yours)

1. **Push and merge.** Let Claude push the two integration branches and open their PRs. Merging them is a separate
   decision (§8), and Phase 5 doesn't need it.
2. **Software on Node 1.** If the read-only report (step A) shows WSL 2 or Docker Desktop missing, the installer
   installs them with `-Install` (winget), and a reboot follows. Docker Desktop is free only for small businesses
   (fewer than 250 employees and less than $10M revenue); check that this applies.
3. **Download about 42 GB** (both models, step C).
4. **Staging secret** (step D).
5. **Pause AI builds on staging** during certification: Owner → AI builds → global pause. The diagnostic still runs
   (draft channel), and no staging build is claimed while the curated skills are missing.
6. **Unattended operation** (§7). Nothing is changed in Windows settings without your decision.

## 4. Installation (elevated PowerShell on Node 1, in this order)

**A. Read-only report** (changes nothing, installs nothing):
```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
$branch = "claude/node1-runner-integration"
$zip = "$env:TEMP\crestmont-runner.zip"; $root = "C:\CrestmontRunner-src"
Invoke-WebRequest "https://github.com/Schmidt-Development/Crestmont-Website-Development/archive/refs/heads/$branch.zip" -OutFile $zip -UseBasicParsing
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue; Expand-Archive $zip $root -Force
$src = (Get-ChildItem $root -Directory | Select-Object -First 1).FullName
& "$src\runner\windows\Discover-Hardware.ps1" -PlatformUrl https://crestmont-platform-staging.partners-df4.workers.dev | Out-File -Encoding utf8 "$env:TEMP\hw.json"
Get-Content "$env:TEMP\hw.json"
```
Check `docker`, `virtualization` and `gpus` in the output. Attach `hw.json` to the conversation if anything is unclear.

**B. Staging secret status** (no credential is sent):
```powershell
try { Invoke-WebRequest -Method Post -Uri https://crestmont-platform-staging.partners-df4.workers.dev/api/builds/runner/claim -Body '{}' -ContentType application/json -UseBasicParsing | Out-Null } catch { "HTTP $([int]$_.Exception.Response.StatusCode)" }
```
`HTTP 503` means `BUILD_RUNNER_SECRET` is **not set** on staging. `HTTP 401` means it is set.

**C. APPROVAL: download the models** (Ollama only downloads them; nothing is loaded and JARVIS is unaffected):
```powershell
ollama pull qwen3.8:27b-q4_K_M
ollama pull qwen3.6:35b-a3b-q4_K_M
ollama show qwen3.8:27b-q4_K_M; ollama show qwen3.6:35b-a3b-q4_K_M
```

**D. APPROVAL: the secret** (never shown on screen, in logs, in chat or in GitHub):
- *If B said 401*, take the existing value from wherever you keep it. The installer prompts for it with hidden input.
- *If B said 503*, generate it on Node 1. It goes straight to the secrets file and the clipboard:
  ```powershell
  New-Item -ItemType Directory -Force C:\CrestmontRunner\secrets | Out-Null
  $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $v = ([Convert]::ToBase64String($b) -replace '[+/=]', ''); [IO.File]::WriteAllText("C:\CrestmontRunner\secrets\build_runner_secret", $v)
  Set-Clipboard -Value $v; $v = $null; $b = $null
  ```
  In GitHub, go to **Settings → Environments → staging → Add secret**, name it `BUILD_RUNNER_SECRET` and paste the
  value. Then run `Set-Clipboard -Value " "` to clear the clipboard, and re-run **Actions → Deploy staging**. Repeat B
  until it says 401.

**E. Install** (add `-Install` only if step A showed WSL or Docker Desktop missing and you approved it):
```powershell
& "$src\runner\windows\Install-CrestmontRunner.ps1" -PlatformUrl https://crestmont-platform-staging.partners-df4.workers.dev `
  -ModelA qwen3.8:27b-q4_K_M -ModelB qwen3.6:35b-a3b-q4_K_M -Slots 1 -GpuConcurrency 1 `
  -PreserveOllamaConfig -SkipModelPull -AllowMissingSkills
```
The installer is idempotent, so you can re-run it after a reboot or a fix. It stops with a list of problems if something is
missing.

## 5. What the installer changes

- **Creates** `C:\CrestmontRunner\{compose,state,secrets,skills,logs,evidence}`. Inheritance is removed. Access is
  limited to SYSTEM, Administrators and your account. The secret is stored without a newline and never printed.
- **Builds** the Docker images `crestmont-ai-runner:1`, `crestmont-build-sandbox:1` and `crestmont-egress-proxy:1`
  from the committed lockfiles. The previous images are kept as `:1-previous`.
- **Creates in Docker** the networks `crestmont_runner`, `crestmont_install` and `crestmont_egress`, and the volume
  `crestmont-workspaces`. It starts the containers `egress-proxy` and `runner` (restart: unless-stopped).
- **Registers scheduled tasks.** `CrestmontRunner-Start` runs at your logon and every 5 minutes as the watchdog.
  `CrestmontRunner-GpuTelemetry` runs every minute and reads `nvidia-smi`.
- **Network.** Outbound HTTPS only, through the Squid allow-list (the staging host and the npm registry). Paid AI APIs
  are denied. **No inbound ports and no firewall rules.**
- **Doesn't change** (with the flags above): Ollama's settings, Ollama's process, models, HQ/JARVIS, Windows
  settings, power plan, auto-logon or anything outside `C:\CrestmontRunner` and Docker. Ollama stays on
  `127.0.0.1:11434`, and the installer stops if it listens anywhere else. Any Ollama setting that differs from
  Crestmont's recommendation is only recorded, in `state\ollama-settings.json`.
- **Duplicate execution** is prevented by platform leases (one lease per job, compare-and-set claims). A diagnostic
  whose lease expires is failed, never re-run.

## 6. Verify, then certify (Phase 5)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Get-RunnerHealth.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Test-Node1Dispatch.ps1 -InferenceProbe
```
Success means L1–L8 PASS (L5 shows the last claim succeeded) and the probe shows Model B at 100 % GPU with VRAM rising
in the `nvidia-smi` samples. Then go to staging **Owner → AI builds → Node diagnostics → Queue diagnostic job**. All of
D01–D13 must pass, D07 must name Node 1's computer name, and D09 must show ≥ 95 % in VRAM. Attach
`C:\CrestmontRunner\state\diagnostics\node1-diagnostic-*.txt` (it holds no secrets) and a screenshot of the D01–D13 page.

Recovery drills, each followed by another diagnostic job:
1. `docker exec crestmont-runner-runner-1 node -e "process.kill(1,'SIGTERM')"`: the runner process exits by itself, and `restart: unless-stopped` must bring it back within a minute (`docker ps`). Don't use `docker kill` or `docker stop` for this drill, because Docker treats those as manual stops and doesn't restart the container.
2. Unplug the network for 2 minutes, then plug it back in. L5 should recover on its own.
3. Reboot and sign in. The start task should bring the stack back without anyone acting.

## 7. Unattended start: Founder decision

Docker Desktop and the Ollama tray app only run inside a signed-in Windows session, so a true pre-logon Windows
service isn't possible with this architecture. Options:
- **(a) Recommended now:** keep Node 1 signed in and locked (JARVIS likely already relies on this). Set "never sleep on AC"
  (`powercfg /change standby-timeout-ac 0`) and Windows Update active hours. That's a Windows setting, so it's yours to
  approve.
- **(b)** Windows auto-logon for a dedicated local account. Unattended after reboots, but anyone with physical access
  gets a session.
- **(c)** Real services: Ollama via NSSM, and Docker Engine inside a WSL distro started by a boot task (no Docker
  Desktop). This is the only fully pre-logon design. It's a larger engineering change and would also move JARVIS's
  Ollama, so it isn't done here.

## 8. After certification (Phase 6 and later; each step needs your authorization)

1. Merge `claude/node1-runner-integration`, then `claude/node1-e2e-integration`, into `main`. The staging deploy
   applies migrations 0051–0054.
2. Register the worker: **Owner → AI builds → GPU workers**, "Node 1 RTX 5090", 1 concurrent build. Save the key to
   `C:\CrestmontRunner\secrets\worker_key`, then re-run step E with `-WorkerId wkr_…`.
3. Put the curated skills in `C:\CrestmontRunner\skills\` (`RUNNER-SETUP.md` §6), re-run step E without
   `-AllowMissingSkills`, and unpause builds.
4. Decide `OLLAMA_CONTEXT_LENGTH`. It applies to every Ollama user, including JARVIS. The runner assumes 64K tokens in
   dual-model mode, and if Ollama's default is smaller, long builds lose context.
5. Run the benchmark (`ORCHESTRATOR.md` §13 step 6), then the Junk in the Trunk Business build ($2,499, simulated
   payment, `E2E-BENCHMARK.md`). Customer release stays blocked until you approve it.

## 9. Upgrade and rollback

- **Upgrade:** download the newer branch or commit (step A), then re-run step E. Your settings in
  `compose\runner.local.env` are kept. The previous images and `runner.env` are kept for rollback.
- **Roll back the last upgrade:** `powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Uninstall-CrestmontRunner.ps1 -Rollback`
- **Stop** (nothing deleted; a running build is requeued without using an attempt): `…\Uninstall-CrestmontRunner.ps1`
- **Remove completely:** `…\Uninstall-CrestmontRunner.ps1 -Remove`. Add `-DeleteInstallDir`, `-DeleteSecrets` or
  `-DeleteWorkspaces` to also delete data, and rotate `BUILD_RUNNER_SECRET` on staging if secrets are deleted. Ollama,
  its models and JARVIS are never touched.
