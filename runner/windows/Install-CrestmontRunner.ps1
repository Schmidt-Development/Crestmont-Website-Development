<#
.SYNOPSIS
  Idempotent installer for the Crestmont self-hosted AI build runner on a Windows machine (Docker Desktop + WSL 2,
  Ollama native on Windows for GPU access).

.DESCRIPTION
  Safe to re-run: every step checks the current state first. Nothing is installed unless -Install is given.
  Steps:
    1. Prerequisites: Windows build, virtualization/WSL 2, Docker Desktop (Linux containers), Ollama.
       With -Install, missing Docker Desktop / Ollama are installed with winget; WSL with `wsl --install`.
    2. Hardware discovery (Discover-Hardware.ps1, read-only) -> state\hardware.json.
    3. Directories under -InstallDir with restrictive ACLs; the shared runner secret file (never printed).
    4. Images: runner, per-build sandbox, egress proxy (docker build from -RepoPath\runner).
    5. Model selection (windows/select-model.ts inside the runner image) -> state\recommendation.json; -Model overrides.
    6. Ollama: user environment (OLLAMA_HOST=127.0.0.1:11434 = localhost only, context length, parallelism,
       keep-alive, flash attention, KV cache type), restart, pull the selected model.
    7. Compose files: docker-compose.yml, proxy\squid.conf (allow-list), runner.env (managed, no secrets inline) and
       runner.local.env (your own settings: created once, never overwritten; see RunnerEnv.ps1). An existing runner.env
       is backed up when it changes, and keys the installer does not manage are moved to runner.local.env.
    8. Checks: containers can reach Ollama via host.docker.internal; `--preflight` inside the runner image.
    9. Start (docker compose up -d) and auto-start at logon (Scheduled Task running Start-CrestmontRunner.ps1).
  It creates NO inbound firewall rules and publishes NO ports. All communication with Crestmont is outbound polling.

.PARAMETER PlatformUrl
  The platform base URL (control plane), e.g. https://staging.crestmont.example
.PARAMETER Install
  Allow installing missing prerequisites with winget / wsl --install. Without it the script only reports.
.PARAMETER Model
  Override the recommended model tag (e.g. qwen3-coder:30b). Use only after reading the recommendation. It overrides
  only the model choice: driver, disk, WSL and Docker blockers still stop the install. Single-model mode.
.PARAMETER ModelA
  Founder V4 dual-model mode: Model A, the architect/reviewer (e.g. qwen3.8:27b-q4_K_M). Give it together with -ModelB.
  Both models are pulled; the runner loads one at a time when they do not fit together (32 GB: 18 + 24 GB do not).
.PARAMETER ModelB
  Founder V4 dual-model mode: Model B, the builder (e.g. qwen3.6:35b-a3b-q4_K_M).
.PARAMETER NoReviewerVision
  Dual-model mode: give the Model A reviewer the screenshot list only, not the images (if image input fails on Node 1).
.PARAMETER Slots
  Website builds this runner works on at the same time (1-16). Start with 1; raise it from the concurrency benchmark.
.PARAMETER GpuConcurrency
  Concurrent model requests on the GPU (OLLAMA_NUM_PARALLEL and the runner's GPU queue; 1-8). Set from the benchmark.
.PARAMETER WorkerId
  The GPU worker id from Owner > AI builds > GPU workers (wkr_...). Its enrollment key goes in
  <InstallDir>\secrets\worker_key (one line). Omit for single-runner mode.
.PARAMETER SecretFile
  Path of a file holding BUILD_RUNNER_SECRET (copied into the secrets folder). Otherwise you are prompted (hidden input).
.PARAMETER ExtraEgressDomains
  Extra hosts the runner may reach (e.g. github.com api.github.com api.cloudflare.com for repos/previews). Each must be
  a plain host name; hosted AI API domains are refused (SquidConf.ps1).
.PARAMETER PreserveOllamaConfig
  Native Ollama shared with other applications (Node 1: HQ/JARVIS): do NOT change Ollama's environment and do NOT stop
  or restart Ollama. The values the runner would normally set are compared with the current ones and every difference
  is reported (state\ollama-settings.json); the localhost-only check still applies. The runner's context size follows
  an existing OLLAMA_CONTEXT_LENGTH so it never assumes more context than Ollama gives.
.PARAMETER AllowMissingSkills
  Node 1 hardware certification before the curated skills are in place: when the runner preflight fails AND required
  skills are missing from <InstallDir>\skills, continue with a warning instead of stopping. Any other preflight failure
  still stops. Keep AI builds paused on the platform until the skills are installed: builds need them, the
  D01-D13 diagnostic (draft channel) does not.
.PARAMETER OllamaImage
  Image for the optional ollama-in-docker profile, pinned by tag AND digest (repo:tag@sha256:...), written to
  compose\.env as OLLAMA_IMAGE. Get a digest with: docker buildx imagetools inspect ollama/ollama:<tag>

.EXAMPLE
  # From an elevated PowerShell in a checkout of the platform repository:
  .\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://staging.crestmont.example -Install
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PlatformUrl,
  [string]$InstallDir = "C:\CrestmontRunner",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$Install,
  [string]$Model = "",
  [string]$ModelA = "",
  [string]$ModelB = "",
  [switch]$NoReviewerVision,
  [ValidateRange(1, 16)][int]$Slots = 1,
  [ValidateRange(1, 8)][int]$GpuConcurrency = 1,
  [string]$WorkerId = "",
  [string]$SecretFile = "",
  [string]$RunnerId = ("win-" + $env:COMPUTERNAME.ToLower()),
  [string[]]$ExtraEgressDomains = @(),
  [switch]$OllamaInDocker,
  [string]$OllamaImage = "ollama/ollama:0.32.0@sha256:57f573b47f1f71ebb445789f279fe3e596a8beab182f7cf486db9205bad87c5a",
  [switch]$SkipModelPull,
  [switch]$PreserveOllamaConfig,
  [switch]$AllowMissingSkills,
  [switch]$NoAutoStart,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$script:Problems = New-Object System.Collections.ArrayList
. (Join-Path $PSScriptRoot "SquidConf.ps1")
. (Join-Path $PSScriptRoot "RunnerEnv.ps1")

function Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "    OK   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "    WARN $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "    FAIL $Text" -ForegroundColor Red; [void]$script:Problems.Add($Text) }
function Exit-WithProblem {
  Write-Host ""
  Write-Host "Stopped. Fix the problems above and run the script again (it is safe to re-run):" -ForegroundColor Red
  foreach ($p in $script:Problems) { Write-Host "  - $p" -ForegroundColor Red }
  exit 1
}
function Invoke-Checked([string]$Exe, [string[]]$Arguments, [string]$What) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$uri = $null
try { $uri = [Uri]$PlatformUrl } catch { $uri = $null }
if (-not $uri -or $uri.Scheme -ne "https") { throw "-PlatformUrl must be an https:// URL" }
$PlatformHost = $uri.Host
# Validate the allow-list inputs before anything is installed (host names only; no hosted AI APIs).
$null = Assert-CrestmontDomain -Domain $PlatformHost -Label "-PlatformUrl host"
foreach ($d in @($ExtraEgressDomains | Where-Object { $_ })) { $null = Assert-CrestmontDomain -Domain $d -Label "-ExtraEgressDomains" }
if ($OllamaImage -cnotmatch '^[a-z0-9./_-]+:[0-9][0-9A-Za-z._-]*@sha256:[0-9a-f]{64}$') { throw "-OllamaImage must be pinned by tag and digest, e.g. ollama/ollama:0.32.0@sha256:<64 hex> (docker buildx imagetools inspect ollama/ollama:<tag>)" }
# -Model ends up in runner.env and on the ollama command line: an Ollama tag only (no spaces, quotes or newlines).
if ($Model -and $Model -cnotmatch '^[a-z0-9][a-z0-9._-]{0,80}(:[A-Za-z0-9._-]{1,60})?$') { throw "-Model must be an Ollama model tag such as qwen3-coder:30b" }
foreach ($m in @($ModelA, $ModelB)) { if ($m -and $m -cnotmatch '^[a-z0-9][a-z0-9._-]{0,80}(:[A-Za-z0-9._-]{1,60})?$') { throw "-ModelA / -ModelB must be Ollama model tags such as qwen3.8:27b-q4_K_M" } }
if ([bool]$ModelA -ne [bool]$ModelB) { throw "Dual-model mode needs both -ModelA (architect/reviewer) and -ModelB (builder)" }
if ($ModelA -and $Model) { throw "Use either -Model (one model) or -ModelA with -ModelB (dual-model), not both" }
if ($ModelA -and $ModelA -eq $ModelB) { throw "-ModelA and -ModelB are the same tag: use -Model for single-model mode" }
$DualMode = [bool]$ModelA
if ($WorkerId -and $WorkerId -cnotmatch '^wkr_[A-Za-z0-9]+$') { throw "-WorkerId must be a worker id (wkr_...) from Owner > AI builds > GPU workers" }
if ($RunnerId -cnotmatch '^[A-Za-z0-9._:-]{1,64}$') { throw "-RunnerId must be 1-64 characters of A-Z a-z 0-9 . _ : -" }
$Compose = Join-Path $InstallDir "compose"
$State = Join-Path $InstallDir "state"
$Secrets = Join-Path $InstallDir "secrets"
$Skills = Join-Path $InstallDir "skills"
$Logs = Join-Path $InstallDir "logs"
$RunnerSrc = Join-Path $RepoPath "runner"

# -- 1. prerequisites --
Step "Prerequisites"
if (-not (Test-Admin)) { Fail "Run this script from an elevated PowerShell (needed for folder ACLs and the scheduled task)."; Exit-WithProblem }
if (-not (Test-Path (Join-Path $RunnerSrc "Dockerfile"))) { Fail "runner\Dockerfile not found under -RepoPath $RepoPath"; Exit-WithProblem }
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19045) { Fail "Windows build ${build}: Ollama documents Windows 10 22H2 (build 19045) or newer." } else { Ok "Windows build $build" }

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$wslOk = $false
if ($wsl) { $null = & wsl.exe --status 2>&1; $wslOk = ($LASTEXITCODE -eq 0) }
if (-not $wslOk) {
  if ($Install) {
    Warn "Installing WSL (wsl --install --no-distribution). A REBOOT is required afterwards; then run this script again."
    Invoke-Checked "wsl.exe" @("--install", "--no-distribution") "wsl --install"
    exit 2
  }
  Fail "WSL 2 is not installed/enabled. Re-run with -Install, or run 'wsl --install' and reboot."
} else { Ok "WSL available"; & wsl.exe --update 2>&1 | Out-Null }

$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
function Install-WithWinget([string]$Id, [string]$Name) {
  if (-not $Install) { Fail "$Name is not installed. Re-run with -Install to install it with winget (package $Id)."; return }
  if (-not $winget) { Fail "winget is not available; install $Name manually."; return }
  Warn "Installing $Name with winget ($Id)"
  Invoke-Checked "winget.exe" @("install", "--exact", "--id", $Id, "--accept-package-agreements", "--accept-source-agreements", "--silent") "winget install $Id"
}

$dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
if (-not (Test-Path $dockerDesktop)) { Install-WithWinget "Docker.DockerDesktop" "Docker Desktop" }
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $docker -and (Test-Path "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe")) { $env:Path += ";$env:ProgramFiles\Docker\Docker\resources\bin" }

$ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not $OllamaInDocker -and -not (Test-Path $ollamaExe) -and -not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) { Install-WithWinget "Ollama.Ollama" "Ollama" }
# The ollama CLI by full path: right after a winget install it is not on this session's PATH yet.
$ollamaCli = if (Test-Path $ollamaExe) { $ollamaExe } else { (Get-Command ollama.exe -ErrorAction SilentlyContinue).Source }
if ($script:Problems.Count) { Exit-WithProblem }

# Docker engine up (start Docker Desktop if needed) and using Linux containers.
& docker.exe info --format "{{.OSType}}" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Warn "Starting Docker Desktop and waiting for the engine (up to 5 minutes)"
  Start-Process -FilePath $dockerDesktop | Out-Null
  $deadline = (Get-Date).AddMinutes(5)
  do { Start-Sleep -Seconds 5; & docker.exe info --format "{{.OSType}}" 2>$null | Out-Null } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
}
$osType = (& docker.exe info --format "{{.OSType}}" 2>$null | Out-String).Trim()
if ($osType -ne "linux") { Fail "Docker engine not reachable or not in Linux-container mode (got '$osType'). Use the WSL 2 backend with Linux containers."; Exit-WithProblem }
$serverVersion = (& docker.exe version --format "{{.Server.Version}}" | Out-String).Trim()
if ([int]($serverVersion.Split(".")[0]) -lt 26) { Fail "Docker Engine ${serverVersion}: 26.0 or newer is required (volume-subpath mounts). Update Docker Desktop."; Exit-WithProblem }
Ok "Docker Engine $serverVersion (linux)"
$composeVersion = (& docker.exe compose version --short 2>$null | Out-String).Trim().TrimStart("v")
$cv = $composeVersion.Split(".")
if ($cv.Count -lt 2 -or -not ($cv[0] -match '^\d+$') -or -not ($cv[1] -match '^\d+$') -or ([int]$cv[0] -lt 2) -or ([int]$cv[0] -eq 2 -and [int]$cv[1] -lt 24)) {
  Fail "Docker Compose ${composeVersion}: 2.24 or newer is required (optional runner.local.env). Update Docker Desktop."; Exit-WithProblem
}
Ok "Docker Compose $composeVersion"
# WSL 2 backend: Docker Desktop's VM kernel name says which backend runs the Linux containers.
$kernel = (& docker.exe info --format "{{.KernelVersion}}" 2>$null | Out-String).Trim()
if ($kernel -match "WSL2") { Ok "Docker Desktop uses the WSL 2 backend ($kernel)" }
elseif ($OllamaInDocker) { Fail "Docker Desktop is not using the WSL 2 backend (kernel '$kernel'); GPU passthrough for -OllamaInDocker needs it. Settings > General > Use the WSL 2 based engine." }
else { Warn "Docker Desktop does not report the WSL 2 backend (kernel '$kernel'). The documented setup is the WSL 2 based engine (Settings > General)." }
if ($script:Problems.Count) { Exit-WithProblem }

# -- 2. hardware discovery --
Step "Hardware discovery (read-only)"
foreach ($d in @($InstallDir, $Compose, $State, $Secrets, $Skills, $Logs, (Join-Path $InstallDir "evidence"))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
& (Join-Path $PSScriptRoot "Discover-Hardware.ps1") -PlatformUrl $PlatformUrl | Out-File -Encoding utf8 (Join-Path $State "hardware.json")
$hw = Get-Content (Join-Path $State "hardware.json") -Raw | ConvertFrom-Json
Ok ("CPU {0} ({1} threads), RAM {2} GB, GPUs: {3}" -f $hw.cpu.name, $hw.cpu.logicalProcessors, $hw.memory.totalGB, (($hw.gpus | ForEach-Object { "$($_.name) $($_.vramGB) GB" }) -join "; "))
if ($hw.network.platform -and -not $hw.network.platform.reachable) { Fail "The platform URL $PlatformUrl is not reachable from this machine."; Exit-WithProblem }

# -- 3. directories, ACLs, secret --
Step "Folders and secrets ($InstallDir)"
# Only SYSTEM, Administrators and the installing user; inheritance removed. Secrets get the same, nothing broader.
foreach ($d in @($InstallDir, $Secrets)) {
  & icacls.exe $d /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "icacls on $d failed"; Exit-WithProblem }
}
$secretPath = Join-Path $Secrets "build_runner_secret"
if (-not (Test-Path $secretPath)) {
  if ($SecretFile) { $value = (Get-Content $SecretFile -Raw).Trim() }
  else {
    $sec = Read-Host -AsSecureString "Paste BUILD_RUNNER_SECRET (the same value as the platform's Worker secret; input hidden)"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if ($value.Length -lt 32) { Fail "BUILD_RUNNER_SECRET looks too short (< 32 characters)."; Exit-WithProblem }
  [IO.File]::WriteAllText($secretPath, $value)   # no BOM, no newline
  $value = $null
  Ok "Secret written to $secretPath (not displayed)"
} else { Ok "Secret file already present (unchanged)" }
if (-not (Get-ChildItem $Skills -Directory -ErrorAction SilentlyContinue)) { Warn "No curated skills in $Skills yet (see RUNNER-SETUP.md section 6); required ones fail preflight." }

# -- 4. images --
Step "Building images (runner, sandbox, egress proxy)"
# The images install npm packages with `npm ci` only: the committed lockfiles are what gets built.
foreach ($lock in @("package-lock.json", "sandbox\package-lock.json")) {
  if (-not (Test-Path (Join-Path $RunnerSrc $lock))) {
    Fail ("runner\$lock is missing. Generate it on a machine with registry access (cd runner\" + (Split-Path $lock -Parent) +
      "; npm install --package-lock-only --ignore-scripts), or take it from the CI 'runner-lockfiles' artifact, review and commit it. See RUNNER-SETUP.md section 12.")
  }
}
if ($script:Problems.Count) { Exit-WithProblem }
# Rollback point: keep the images currently in use as :1-previous before rebuilding (Uninstall-CrestmontRunner.ps1 -Rollback).
# Only a COMPLETED install is a rollback point (state\install.json is written at the end of a successful run), so a re-run
# after a failed run never replaces the good :1-previous with the failed build. `image ls -q` writes nothing to stderr
# when the image is absent (stderr from a native command is a terminating error under Stop in Windows PowerShell 5.1).
$installRecord = Join-Path $State "install.json"
if (Test-Path $installRecord) {
  foreach ($img in @("crestmont-ai-runner", "crestmont-build-sandbox", "crestmont-egress-proxy")) {
    if (& docker.exe image ls -q "${img}:1") { & docker.exe tag "${img}:1" "${img}:1-previous" | Out-Null }
  }
  if (Test-Path (Join-Path $Compose "runner.env")) { Copy-Item -Force (Join-Path $Compose "runner.env") (Join-Path $State "runner.env.previous") }
  Remove-Item -Force $installRecord
}
Invoke-Checked "docker.exe" @("build", "-t", "crestmont-ai-runner:1", "-f", (Join-Path $RunnerSrc "Dockerfile"), $RunnerSrc) "docker build runner"
Invoke-Checked "docker.exe" @("build", "-t", "crestmont-build-sandbox:1", "-f", (Join-Path $RunnerSrc "sandbox\Dockerfile"), (Join-Path $RunnerSrc "sandbox")) "docker build sandbox"
Copy-Item -Force (Join-Path $PSScriptRoot "docker-compose.yml") (Join-Path $Compose "docker-compose.yml")
New-Item -ItemType Directory -Force -Path (Join-Path $Compose "proxy") | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "proxy\Dockerfile") (Join-Path $Compose "proxy\Dockerfile")
Ok "Images built"

# -- 5. model selection --
Step "Model selection"
& docker.exe run --rm --network none -v "${State}:/in:ro" --entrypoint node crestmont-ai-runner:1 --no-warnings windows/select-model.ts /in/hardware.json | Out-File -Encoding utf8 (Join-Path $State "recommendation.json")
$selectExit = $LASTEXITCODE
$rec = Get-Content (Join-Path $State "recommendation.json") -Raw | ConvertFrom-Json
Write-Host "    $($rec.summary)"
foreach ($w in $rec.warnings) { Warn $w }
foreach ($b in $rec.blockers) { Fail $b }
if ($Model) {
  # -Model overrides the model choice only. Every other blocker (driver, disk, WSL, Docker) still stops the install.
  Warn "Using -Model $Model instead of the recommendation ($($rec.model))."
  foreach ($b in @($rec.modelChoiceBlockers)) { if ($b) { [void]$script:Problems.Remove($b); Warn "Overridden by -Model: $b" } }
  if ($script:Problems.Count) { Exit-WithProblem }
}
elseif ($selectExit -ne 0 -or -not $rec.model) { Exit-WithProblem }
$selected = if ($DualMode) { $ModelB } elseif ($Model) { $Model } else { $rec.model }
$ctx = [int]$rec.contextTokens
if ($ctx -lt 16384) { $ctx = 32768 }
$numParallel = [int]$rec.ollama.numParallel
$keepAlive = "$($rec.ollama.keepAlive)"
if ($DualMode) {
  # Both models share one context length (OLLAMA_CONTEXT_LENGTH). KV cache grows with context x parallel requests, so
  # more parallel requests get a shorter context. Estimates only: the Node 1 benchmark (ORCHESTRATOR.md) sets the values.
  $ctx = if ($GpuConcurrency -le 1) { 65536 } else { 32768 }
  $numParallel = $GpuConcurrency
  $keepAlive = "30m"
  Warn "Dual-model mode: Model A $ModelA (architect/reviewer), Model B $ModelB (builder); context $ctx, $GpuConcurrency parallel request(s) on the GPU, $Slots website slot(s). Both models are pulled (about 42 GB for the Q4 pair)."
}
$pullList = @(if ($DualMode) { $ModelA, $ModelB } else { $selected })
$vramTotalMb = 0
# GPU size for the runner's "do both models fit?" check: only a reliable figure (nvidia-smi / registry), else 0 = unknown.
try { $hw = Get-Content (Join-Path $State "hardware.json") -Raw | ConvertFrom-Json; $g = @($hw.gpus | Where-Object { $_.vramReliable -and $_.vramGB })[0]; if ($g) { $vramTotalMb = [int]([double]$g.vramGB * 1024) } } catch { $vramTotalMb = 0 }

# -- 6. Ollama --
if ($OllamaInDocker) {
  Step "Ollama in Docker (profile ollama-in-docker; GPU passthrough needs NVIDIA + WSL 2 backend)"
  $modelBase = "http://ollama:11434/v1"
} else {
  Step "Ollama (native, localhost only)"
  $ollamaEnv = [ordered]@{
    OLLAMA_HOST = "127.0.0.1:11434"          # bind to localhost only (Ollama's default, set explicitly)
    OLLAMA_CONTEXT_LENGTH = "$ctx"
    OLLAMA_NUM_PARALLEL = "$numParallel"
    OLLAMA_MAX_LOADED_MODELS = "1"            # the runner's GPU scheduler decides which model is loaded
    OLLAMA_KEEP_ALIVE = "$keepAlive"
    OLLAMA_FLASH_ATTENTION = $(if ($rec.ollama.flashAttention) { "1" } else { "0" })
    OLLAMA_KV_CACHE_TYPE = "$($rec.ollama.kvCacheType)"
  }
  $changed = $false
  if ($PreserveOllamaConfig) {
    # Shared Ollama (another application depends on it): report, never change or restart.
    $drift = [ordered]@{}
    foreach ($k in $ollamaEnv.Keys) {
      $cur = [Environment]::GetEnvironmentVariable($k, "User"); if (-not $cur) { $cur = [Environment]::GetEnvironmentVariable($k, "Machine") }
      if ("$cur" -ne $ollamaEnv[$k]) { $drift[$k] = [ordered]@{ current = $(if ($cur) { "$cur" } else { "(Ollama default)" }); recommended = $ollamaEnv[$k] }; Warn "$k is '$(if ($cur) { $cur } else { 'unset (Ollama default)' })'; Crestmont would use '$($ollamaEnv[$k])'. Left unchanged (-PreserveOllamaConfig)." }
    }
    $curCtx = [Environment]::GetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "User"); if (-not $curCtx) { $curCtx = [Environment]::GetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "Machine") }
    if ($curCtx -match '^[0-9]+$' -and [int]$curCtx -lt $ctx) { Warn "Runner context lowered from $ctx to Ollama's OLLAMA_CONTEXT_LENGTH $curCtx (never assume more context than Ollama gives)."; $ctx = [int]$curCtx }
    elseif (-not $curCtx) { Warn "OLLAMA_CONTEXT_LENGTH is not set: Ollama's default context may be smaller than the runner's $ctx tokens. Long builds can lose context; set it deliberately (Founder decision, affects every Ollama user) before Phase 6." }
    [IO.File]::WriteAllText((Join-Path $State "ollama-settings.json"), (([ordered]@{ preserved = $true; at = (Get-Date).ToUniversalTime().ToString("o"); differences = $drift; runnerContextTokens = $ctx }) | ConvertTo-Json -Depth 4))
    Ok "Ollama configuration left unchanged; $($drift.Count) difference(s) recorded in state\ollama-settings.json"
  } else {
    foreach ($k in $ollamaEnv.Keys) {
      if ([Environment]::GetEnvironmentVariable($k, "User") -ne $ollamaEnv[$k]) { [Environment]::SetEnvironmentVariable($k, $ollamaEnv[$k], "User"); $changed = $true }
      Set-Item -Path "Env:$k" -Value $ollamaEnv[$k]
    }
  }
  if ($changed) {
    Warn "Ollama settings changed: restarting Ollama"
    Get-Process -Name "ollama app", "ollama" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $app = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
    if (Test-Path $app) { Start-Process -FilePath $app | Out-Null } else { Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden | Out-Null }
    Start-Sleep -Seconds 5
  }
  $listen = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
  if (-not $listen) { Fail "Ollama is not listening on port 11434."; Exit-WithProblem }
  $public = @($listen | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
  if ($public.Count) { Fail "Ollama listens on $($public.LocalAddress -join ', '): it must be localhost only. Remove OLLAMA_HOST overrides (system scope too)."; Exit-WithProblem }
  Ok "Ollama listening on localhost only"
  if (-not $ollamaCli) { Fail "The ollama CLI was not found (open a new elevated PowerShell after installing Ollama, then re-run)."; Exit-WithProblem }
  if (-not $SkipModelPull) {
    foreach ($m in $pullList) {
      Write-Host "    Pulling $m (this can take a long time)"
      Invoke-Checked $ollamaCli @("pull", $m) "ollama pull $m"
    }
  }
  # Exact tag match on the NAME column (a bare name means :latest), not a substring of the listing.
  $names = @(& $ollamaCli list | Select-Object -Skip 1 | ForEach-Object { ("$_".Trim() -split '\s+')[0] } | Where-Object { $_ })
  foreach ($m in $pullList) {
    $want = if ($m.Contains(":")) { $m } else { "${m}:latest" }
    if (-not ($names -contains $want)) { Fail "Model $want is not in 'ollama list' (found: $($names -join ', '))."; Exit-WithProblem }
  }
  Ok "Model(s) available: $($pullList -join ', ')"
  $modelBase = "http://host.docker.internal:11434/v1"
}

# -- 7. compose files --
Step "Compose configuration"
$template = Get-Content (Join-Path $PSScriptRoot "proxy\squid.conf.template") -Raw
$squid = ConvertTo-SquidConf -Template $template -PlatformHost $PlatformHost -ExtraDomains $ExtraEgressDomains -OllamaInDocker:$OllamaInDocker
# Squid expects LF line endings (ConvertTo-SquidConf normalizes them); write without BOM.
[IO.File]::WriteAllText((Join-Path $Compose "proxy\squid.conf"), $squid)
$managed = @(
  [pscustomobject]@{ key = "CONTROL_PLANE_URL"; value = $PlatformUrl }
  [pscustomobject]@{ key = "BUILD_RUNNER_SECRET_FILE"; value = "/run/secrets/build_runner_secret" }
  [pscustomobject]@{ key = "RUNNER_ID"; value = $RunnerId }
  [pscustomobject]@{ key = "RUNNER_HOST_LABEL"; value = $env:COMPUTERNAME }
  [pscustomobject]@{ key = "RUNNER_AGENT_PROVIDER"; value = "local" }
  [pscustomobject]@{ key = "RUNNER_ALLOW_PAID_PROVIDER"; value = "false" }
  [pscustomobject]@{ key = "LOCAL_MODEL"; value = $selected }
  [pscustomobject]@{ key = "LOCAL_MODEL_BASE_URL"; value = $modelBase }
  [pscustomobject]@{ key = "LOCAL_MODEL_CONTEXT_TOKENS"; value = "$ctx" }
  [pscustomobject]@{ key = "RUNNER_SANDBOX_IMAGE"; value = "crestmont-build-sandbox:1" }
  [pscustomobject]@{ key = "RUNNER_JOB_CPUS"; value = "$($rec.jobLimits.cpus)" }
  [pscustomobject]@{ key = "RUNNER_JOB_MEMORY"; value = "$($rec.jobLimits.memoryGB)g" }
  [pscustomobject]@{ key = "RUNNER_JOB_DISK_MB"; value = "$([int]$rec.jobLimits.diskGB * 1024)" }
  [pscustomobject]@{ key = "RUNNER_SERVE_AI_DRAFTS"; value = "true" }
  [pscustomobject]@{ key = "LOG_LEVEL"; value = "info" }
  # Founder V4: dual-model, slots, GPU queue, GPU telemetry, GPU worker identity (empty values = not used).
  [pscustomobject]@{ key = "LOCAL_MODEL_A"; value = $(if ($DualMode) { $ModelA } else { "" }) }
  [pscustomobject]@{ key = "LOCAL_MODEL_B"; value = $(if ($DualMode) { $ModelB } else { "" }) }
  [pscustomobject]@{ key = "LOCAL_MODEL_A_VISION"; value = $(if ($DualMode -and -not $NoReviewerVision) { "true" } else { "false" }) }
  [pscustomobject]@{ key = "RUNNER_SLOTS"; value = "$Slots" }
  [pscustomobject]@{ key = "INFERENCE_MAX_CONCURRENT"; value = "$numParallel" }
  [pscustomobject]@{ key = "GPU_VRAM_TOTAL_MB"; value = "$vramTotalMb" }
  [pscustomobject]@{ key = "GPU_TELEMETRY_FILE"; value = "/run/crestmont/gpu.json" }
  [pscustomobject]@{ key = "BUILD_WORKER_ID"; value = $WorkerId }
  [pscustomobject]@{ key = "BUILD_WORKER_KEY_FILE"; value = $(if ($WorkerId) { "/run/secrets/worker_key" } else { "" }) }
)
if ($WorkerId -and -not (Test-Path (Join-Path $Secrets "worker_key"))) {
  Fail "GPU worker key missing: save the enrollment key shown when you registered $WorkerId as $(Join-Path $Secrets 'worker_key') (one line), then re-run."
  Exit-WithProblem
}
$runnerEnvPath = Join-Path $Compose "runner.env"
$localEnvPath = Join-Path $Compose "runner.local.env"
$oldRunnerEnv = $null; if (Test-Path $runnerEnvPath) { $oldRunnerEnv = [IO.File]::ReadAllText($runnerEnvPath) }
$oldLocalEnv = $null; if (Test-Path $localEnvPath) { $oldLocalEnv = [IO.File]::ReadAllText($localEnvPath) }
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$merged = Merge-CrestmontRunnerEnv -Managed $managed -ExistingRunnerEnv $oldRunnerEnv -ExistingLocalEnv $oldLocalEnv -Stamp $stamp
if (@($merged.conflicts).Count) {
  Fail ("runner.local.env (or a hand edit of runner.env) sets keys the installer manages or that would weaken the build sandbox / enable a paid provider: " +
    (@($merged.conflicts) -join ", ") + ". Remove them from $localEnvPath (use installer parameters for managed values) and re-run.")
  Exit-WithProblem
}
# Never overwrite silently: back up an existing runner.env that is about to change, and say what moved where.
if ($null -ne $oldRunnerEnv -and $oldRunnerEnv -cne $merged.runnerEnv) {
  $backup = Join-Path $Compose "runner.env.$stamp.bak"
  Copy-Item -Force $runnerEnvPath $backup
  Warn "runner.env changes (backup: $backup). Changed managed keys: $(if (@($merged.changed).Count) { @($merged.changed) -join ', ' } else { 'none' })"
}
if (@($merged.moved).Count) { Warn "Moved your own settings from runner.env to runner.local.env: $(@($merged.moved) -join ', ')" }
if ($null -eq $oldLocalEnv -or $oldLocalEnv -cne $merged.localEnv) { [IO.File]::WriteAllText($localEnvPath, $merged.localEnv) }
[IO.File]::WriteAllText($runnerEnvPath, $merged.runnerEnv)
$composeEnv = @("OLLAMA_IMAGE=$OllamaImage", "OLLAMA_CONTEXT_LENGTH=$ctx", "OLLAMA_NUM_PARALLEL=$numParallel", "OLLAMA_KEEP_ALIVE=$keepAlive", "OLLAMA_KV_CACHE_TYPE=$($rec.ollama.kvCacheType)")
$composeEnv | Set-Content -Encoding ascii (Join-Path $Compose ".env")
Ok "Wrote docker-compose.yml, proxy\squid.conf, runner.env (managed, no secret values); runner.local.env kept"
# Tool scripts next to the install, whether or not auto-start is registered (Get-RunnerHealth, Collect-Evidence, ...).
New-Item -ItemType Directory -Force -Path (Join-Path $State "telemetry") | Out-Null
foreach ($tool in @("Start-CrestmontRunner.ps1", "Get-RunnerHealth.ps1", "Collect-Evidence.ps1", "Discover-Hardware.ps1", "Write-GpuTelemetry.ps1", "Test-Node1Dispatch.ps1", "Uninstall-CrestmontRunner.ps1")) {
  Copy-Item -Force (Join-Path $PSScriptRoot $tool) (Join-Path $InstallDir $tool)
}

# -- 8. checks --
Step "Connectivity and preflight"
$composeArgs = @("compose", "-f", (Join-Path $Compose "docker-compose.yml"), "--project-directory", $Compose)
if ($OllamaInDocker) { $composeArgs += @("--profile", "ollama-in-docker") }
Invoke-Checked "docker.exe" ($composeArgs + @("build", "egress-proxy")) "docker compose build egress-proxy"
Invoke-Checked "docker.exe" ($composeArgs + @("up", "-d", "egress-proxy")) "start egress proxy"
if ($OllamaInDocker) {
  Invoke-Checked "docker.exe" ($composeArgs + @("up", "-d", "ollama")) "start ollama container"
  if (-not $SkipModelPull) { foreach ($m in $pullList) { Invoke-Checked "docker.exe" ($composeArgs + @("exec", "ollama", "ollama", "pull", $m)) "ollama pull $m (container)" } }
}
# Does the model server answer through the proxy, exactly as the runner will call it?
$probe = "fetch(process.env.U+'/models').then(r=>r.json()).then(j=>{console.log((j.data||[]).map(m=>m.id).join(','));process.exit(0)},e=>{console.error(String(e));process.exit(1)})"
& docker.exe run --rm --network crestmont_runner -e "U=$modelBase" -e NODE_USE_ENV_PROXY=1 -e HTTP_PROXY=http://egress-proxy:3128 -e HTTPS_PROXY=http://egress-proxy:3128 --entrypoint node crestmont-ai-runner:1 -e $probe
if ($LASTEXITCODE -ne 0) {
  Fail ("Containers cannot reach the model server at $modelBase through the proxy. With native Ollama this usually means " +
    "host.docker.internal does not reach a localhost-only listener on this Docker Desktop version; re-run with -OllamaInDocker " +
    "(see WINDOWS-SUPERCOMPUTER.md, 'Ollama native vs in Docker').")
  Exit-WithProblem
}
Ok "Model server reachable from the container network"
$missingSkills = @()
try {
  $manifest = Get-Content (Join-Path $RunnerSrc "skills\manifest.json") -Raw | ConvertFrom-Json
  $required = @($manifest.workflows.PSObject.Properties | ForEach-Object { $_.Value.skills } | Where-Object { $_.required } | ForEach-Object { $_.name } | Sort-Object -Unique)
  foreach ($n in $required) { $src = $manifest.skills.$n.source; if (-not (Test-Path (Join-Path $Skills "$src\SKILL.md"))) { $missingSkills += $n } }
} catch { Warn "Could not read runner\skills\manifest.json to check the skills folder: $($_.Exception.Message)" }
# stderr is captured, not fatal: under Stop, Windows PowerShell 5.1 turns native stderr into a terminating error.
$eap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
$pfOut = @(& docker.exe @($composeArgs + @("run", "--rm", "--no-deps", "runner", "node", "--no-warnings", "src/main.ts", "--preflight")) 2>&1 | ForEach-Object { "$_" })
$pfExit = $LASTEXITCODE
$ErrorActionPreference = $eap
$pfOut | ForEach-Object { Write-Host "    $_" }
# Every error the preflight logged (JSON lines "preflight" and "preflight provider"); only "Required skill ..." errors may be waived.
$pfErrors = @(foreach ($l in $pfOut) { try { $j = $l | ConvertFrom-Json -ErrorAction Stop; if ("$($j.msg)" -like "preflight*" -and $j.errors) { $j.errors } } catch { $null = $_ } })
$otherErrors = @($pfErrors | Where-Object { "$_" -notlike "Required skill *" })
if ($pfExit -eq 0) { Ok "Runner preflight passed" }
elseif ($AllowMissingSkills -and $missingSkills.Count -and $pfErrors.Count -and -not $otherErrors.Count) {
  Warn ("Runner preflight failed with required skills missing ($($missingSkills -join ', ')). Continuing (-AllowMissingSkills): " +
    "keep AI builds PAUSED on the platform until the skills are in $Skills; the diagnostic job does not need them.")
} else { throw "runner --preflight failed (exit $pfExit)$(if ($otherErrors.Count) { "; not only skills: $($otherErrors -join ' | ')" } elseif ($missingSkills.Count) { "; required skills missing: $($missingSkills -join ', ')" })" }

# -- 9. start + auto-start --
if (-not $NoStart) {
  Step "Starting the runner"
  Invoke-Checked "docker.exe" ($composeArgs + @("up", "-d")) "docker compose up"
  Ok "Runner started (restart policy: unless-stopped)"
}
if (-not $NoAutoStart) {
  Step "Auto-start after reboot"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -InstallDir `"{1}`"{2}" -f (Join-Path $InstallDir "Start-CrestmontRunner.ps1"), $InstallDir, $(if ($OllamaInDocker) { " -OllamaInDocker" } elseif ($PreserveOllamaConfig) { " -NoOllamaStart" } else { "" }))
  # Docker Desktop and the Ollama tray app run in a user session, so the task runs at this user's logon.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  # Watchdog: the same idempotent start script every 5 minutes while the user is signed in, so a stopped Docker Desktop
  # or compose stack comes back on its own (crashed containers restart by themselves: restart unless-stopped). It does
  # not help before logon after a reboot (Docker Desktop needs a session; NODE1-INSTALL.md section 7).
  # With -PreserveOllamaConfig it never starts Ollama either (-NoOllamaStart): a shared Ollama belongs to its owner.
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "CrestmontRunner-Start" -Action $action -Trigger @($trigger, $watchdog) -Settings $settings -RunLevel Limited -Force | Out-Null
  Ok "Scheduled task 'CrestmontRunner-Start' runs at logon of $env:USERNAME (see WINDOWS-SUPERCOMPUTER.md for unattended reboots)"
  # V4: GPU telemetry every minute (nvidia-smi on the host -> state\telemetry\gpu.json, read-only in the runner).
  $gAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -InstallDir `"{1}`"" -f (Join-Path $InstallDir "Write-GpuTelemetry.ps1"), $InstallDir)
  $gTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $gSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "CrestmontRunner-GpuTelemetry" -Action $gAction -Trigger $gTrigger -Settings $gSettings -RunLevel Limited -Force | Out-Null
  Ok "Scheduled task 'CrestmontRunner-GpuTelemetry' samples nvidia-smi every minute"
}

Step "Health"
if ($NoStart) {
  Write-Host ""
  Write-Host "Configured (not started: -NoStart). Model(s): $($pullList -join ', ')  Provider: local (paid API disabled)." -ForegroundColor Green
  exit 0
}
Start-Sleep -Seconds 10
& (Join-Path $PSScriptRoot "Get-RunnerHealth.ps1") -InstallDir $InstallDir
$healthExit = $LASTEXITCODE
Write-Host ""
if ($healthExit -ne 0) {
  Write-Host "Installed, but the health check FAILED (see above). The runner is not ready: fix the reported problem and run Get-RunnerHealth.ps1 again." -ForegroundColor Red
  exit 1
}
[IO.File]::WriteAllText((Join-Path $State "install.json"), (([ordered]@{ completedAt = (Get-Date).ToUniversalTime().ToString("o"); ollamaInDocker = [bool]$OllamaInDocker; preserveOllamaConfig = [bool]$PreserveOllamaConfig; dualModel = [bool]$DualMode }) | ConvertTo-Json))
Write-Host "Done. Model(s): $($pullList -join ', ')  Slots: $Slots  GPU concurrency: $numParallel  Provider: local (paid API disabled)  No ports published, no firewall rules added." -ForegroundColor Green
