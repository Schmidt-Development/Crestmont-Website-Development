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
  only the model choice: driver, disk, WSL and Docker blockers still stop the install.
.PARAMETER SecretFile
  Path of a file holding BUILD_RUNNER_SECRET (copied into the secrets folder). Otherwise you are prompted (hidden input).
.PARAMETER ExtraEgressDomains
  Extra hosts the runner may reach (e.g. github.com api.github.com api.cloudflare.com for repos/previews). Each must be
  a plain host name; hosted AI API domains are refused (SquidConf.ps1).
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
  [string]$SecretFile = "",
  [string]$RunnerId = ("win-" + $env:COMPUTERNAME.ToLower()),
  [string[]]$ExtraEgressDomains = @(),
  [switch]$OllamaInDocker,
  [string]$OllamaImage = "ollama/ollama:0.32.0@sha256:57f573b47f1f71ebb445789f279fe3e596a8beab182f7cf486db9205bad87c5a",
  [switch]$SkipModelPull,
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
$selected = if ($Model) { $Model } else { $rec.model }
$ctx = [int]$rec.contextTokens
if ($ctx -lt 16384) { $ctx = 32768 }

# -- 6. Ollama --
if ($OllamaInDocker) {
  Step "Ollama in Docker (profile ollama-in-docker; GPU passthrough needs NVIDIA + WSL 2 backend)"
  $modelBase = "http://ollama:11434/v1"
} else {
  Step "Ollama (native, localhost only)"
  $ollamaEnv = [ordered]@{
    OLLAMA_HOST = "127.0.0.1:11434"          # bind to localhost only (Ollama's default, set explicitly)
    OLLAMA_CONTEXT_LENGTH = "$ctx"
    OLLAMA_NUM_PARALLEL = "$($rec.ollama.numParallel)"
    OLLAMA_MAX_LOADED_MODELS = "1"
    OLLAMA_KEEP_ALIVE = "$($rec.ollama.keepAlive)"
    OLLAMA_FLASH_ATTENTION = $(if ($rec.ollama.flashAttention) { "1" } else { "0" })
    OLLAMA_KV_CACHE_TYPE = "$($rec.ollama.kvCacheType)"
  }
  $changed = $false
  foreach ($k in $ollamaEnv.Keys) {
    if ([Environment]::GetEnvironmentVariable($k, "User") -ne $ollamaEnv[$k]) { [Environment]::SetEnvironmentVariable($k, $ollamaEnv[$k], "User"); $changed = $true }
    Set-Item -Path "Env:$k" -Value $ollamaEnv[$k]
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
  if (-not $SkipModelPull) {
    Write-Host "    Pulling $selected (this can take a long time)"
    if (-not $ollamaCli) { Fail "The ollama CLI was not found (open a new elevated PowerShell after installing Ollama, then re-run)."; Exit-WithProblem }
    Invoke-Checked $ollamaCli @("pull", $selected) "ollama pull $selected"
  }
  if (-not $ollamaCli) { Fail "The ollama CLI was not found (open a new elevated PowerShell after installing Ollama, then re-run)."; Exit-WithProblem }
  # Exact tag match on the NAME column (a bare name means :latest), not a substring of the listing.
  $names = @(& $ollamaCli list | Select-Object -Skip 1 | ForEach-Object { ("$_".Trim() -split '\s+')[0] } | Where-Object { $_ })
  $want = if ($selected.Contains(":")) { $selected } else { "${selected}:latest" }
  if (-not ($names -contains $want)) { Fail "Model $want is not in 'ollama list' (found: $($names -join ', '))."; Exit-WithProblem }
  Ok "Model $selected available"
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
)
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
$composeEnv = @("OLLAMA_IMAGE=$OllamaImage", "OLLAMA_CONTEXT_LENGTH=$ctx", "OLLAMA_NUM_PARALLEL=$($rec.ollama.numParallel)", "OLLAMA_KV_CACHE_TYPE=$($rec.ollama.kvCacheType)")
$composeEnv | Set-Content -Encoding ascii (Join-Path $Compose ".env")
Ok "Wrote docker-compose.yml, proxy\squid.conf, runner.env (managed, no secret values); runner.local.env kept"
# Tool scripts next to the install, whether or not auto-start is registered (Get-RunnerHealth, Collect-Evidence, ...).
foreach ($tool in @("Start-CrestmontRunner.ps1", "Get-RunnerHealth.ps1", "Collect-Evidence.ps1", "Discover-Hardware.ps1")) {
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
  if (-not $SkipModelPull) { Invoke-Checked "docker.exe" ($composeArgs + @("exec", "ollama", "ollama", "pull", $selected)) "ollama pull (container)" }
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
Invoke-Checked "docker.exe" ($composeArgs + @("run", "--rm", "--no-deps", "runner", "node", "--no-warnings", "src/main.ts", "--preflight")) "runner --preflight"
Ok "Runner preflight passed"

# -- 9. start + auto-start --
if (-not $NoStart) {
  Step "Starting the runner"
  Invoke-Checked "docker.exe" ($composeArgs + @("up", "-d")) "docker compose up"
  Ok "Runner started (restart policy: unless-stopped)"
}
if (-not $NoAutoStart) {
  Step "Auto-start after reboot"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -InstallDir `"{1}`"{2}" -f (Join-Path $InstallDir "Start-CrestmontRunner.ps1"), $InstallDir, $(if ($OllamaInDocker) { " -OllamaInDocker" } else { "" }))
  # Docker Desktop and the Ollama tray app run in a user session, so the task runs at this user's logon.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName "CrestmontRunner-Start" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
  Ok "Scheduled task 'CrestmontRunner-Start' runs at logon of $env:USERNAME (see WINDOWS-SUPERCOMPUTER.md for unattended reboots)"
}

Step "Health"
if ($NoStart) {
  Write-Host ""
  Write-Host "Configured (not started: -NoStart). Model: $selected  Provider: local (paid API disabled)." -ForegroundColor Green
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
Write-Host "Done. Model: $selected  Provider: local (paid API disabled)  No ports published, no firewall rules added." -ForegroundColor Green
