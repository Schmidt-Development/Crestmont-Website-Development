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
    7. Compose files: docker-compose.yml, proxy\squid.conf (allow-list), runner.env (no secrets inline).
    8. Checks: containers can reach Ollama via host.docker.internal; `--preflight` inside the runner image.
    9. Start (docker compose up -d) and auto-start at logon (Scheduled Task running Start-CrestmontRunner.ps1).
  It creates NO inbound firewall rules and publishes NO ports. All communication with Crestmont is outbound polling.

.PARAMETER PlatformUrl
  The platform base URL (control plane), e.g. https://staging.crestmont.example
.PARAMETER Install
  Allow installing missing prerequisites with winget / wsl --install. Without it the script only reports.
.PARAMETER Model
  Override the recommended model tag (e.g. qwen3-coder:30b). Use only after reading the recommendation.
.PARAMETER SecretFile
  Path of a file holding BUILD_RUNNER_SECRET (copied into the secrets folder). Otherwise you are prompted (hidden input).
.PARAMETER ExtraEgressDomains
  Extra hosts the runner may reach (e.g. github.com api.github.com api.cloudflare.com for repos/previews).

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
  [switch]$SkipModelPull,
  [switch]$NoAutoStart,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$script:Problems = New-Object System.Collections.ArrayList

function Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "    OK   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "    WARN $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "    FAIL $Text" -ForegroundColor Red; [void]$script:Problems.Add($Text) }
function Stop-WithProblems {
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
try { $uri = [Uri]$PlatformUrl } catch { }
if (-not $uri -or $uri.Scheme -ne "https") { throw "-PlatformUrl must be an https:// URL" }
$PlatformHost = $uri.Host
$Compose = Join-Path $InstallDir "compose"
$State = Join-Path $InstallDir "state"
$Secrets = Join-Path $InstallDir "secrets"
$Skills = Join-Path $InstallDir "skills"
$Logs = Join-Path $InstallDir "logs"
$RunnerSrc = Join-Path $RepoPath "runner"

# ── 1. prerequisites ──
Step "Prerequisites"
if (-not (Test-Admin)) { Fail "Run this script from an elevated PowerShell (needed for folder ACLs and the scheduled task)."; Stop-WithProblems }
if (-not (Test-Path (Join-Path $RunnerSrc "Dockerfile"))) { Fail "runner\Dockerfile not found under -RepoPath $RepoPath"; Stop-WithProblems }
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19045) { Fail "Windows build ${build}: Ollama documents Windows 10 22H2 (build 19045) or newer." } else { Ok "Windows build $build" }

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$wslOk = $false
if ($wsl) { $st = ((& wsl.exe --status 2>&1) | Out-String) -replace "`0", ""; $wslOk = ($LASTEXITCODE -eq 0) }
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
if ($script:Problems.Count) { Stop-WithProblems }

# Docker engine up (start Docker Desktop if needed) and using Linux containers.
& docker.exe info --format "{{.OSType}}" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Warn "Starting Docker Desktop and waiting for the engine (up to 5 minutes)"
  Start-Process -FilePath $dockerDesktop | Out-Null
  $deadline = (Get-Date).AddMinutes(5)
  do { Start-Sleep -Seconds 5; & docker.exe info --format "{{.OSType}}" 2>$null | Out-Null } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
}
$osType = (& docker.exe info --format "{{.OSType}}" 2>$null | Out-String).Trim()
if ($osType -ne "linux") { Fail "Docker engine not reachable or not in Linux-container mode (got '$osType'). Use the WSL 2 backend with Linux containers."; Stop-WithProblems }
$serverVersion = (& docker.exe version --format "{{.Server.Version}}" | Out-String).Trim()
if ([int]($serverVersion.Split(".")[0]) -lt 26) { Fail "Docker Engine ${serverVersion}: 26.0 or newer is required (volume-subpath mounts). Update Docker Desktop."; Stop-WithProblems }
Ok "Docker Engine $serverVersion (linux)"

# ── 2. hardware discovery ──
Step "Hardware discovery (read-only)"
foreach ($d in @($InstallDir, $Compose, $State, $Secrets, $Skills, $Logs, (Join-Path $InstallDir "evidence"))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
& (Join-Path $PSScriptRoot "Discover-Hardware.ps1") -PlatformUrl $PlatformUrl | Out-File -Encoding utf8 (Join-Path $State "hardware.json")
$hw = Get-Content (Join-Path $State "hardware.json") -Raw | ConvertFrom-Json
Ok ("CPU {0} ({1} threads), RAM {2} GB, GPUs: {3}" -f $hw.cpu.name, $hw.cpu.logicalProcessors, $hw.memory.totalGB, (($hw.gpus | ForEach-Object { "$($_.name) $($_.vramGB) GB" }) -join "; "))
if ($hw.network.platform -and -not $hw.network.platform.reachable) { Fail "The platform URL $PlatformUrl is not reachable from this machine."; Stop-WithProblems }

# ── 3. directories, ACLs, secret ──
Step "Folders and secrets ($InstallDir)"
# Only SYSTEM, Administrators and the installing user; inheritance removed. Secrets get the same, nothing broader.
foreach ($d in @($InstallDir, $Secrets)) {
  & icacls.exe $d /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "icacls on $d failed"; Stop-WithProblems }
}
$secretPath = Join-Path $Secrets "build_runner_secret"
if (-not (Test-Path $secretPath)) {
  if ($SecretFile) { $value = (Get-Content $SecretFile -Raw).Trim() }
  else {
    $sec = Read-Host -AsSecureString "Paste BUILD_RUNNER_SECRET (the same value as the platform's Worker secret; input hidden)"
    $value = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if ($value.Length -lt 32) { Fail "BUILD_RUNNER_SECRET looks too short (< 32 characters)."; Stop-WithProblems }
  [IO.File]::WriteAllText($secretPath, $value)   # no BOM, no newline
  $value = $null
  Ok "Secret written to $secretPath (not displayed)"
} else { Ok "Secret file already present (unchanged)" }
if (-not (Get-ChildItem $Skills -Directory -ErrorAction SilentlyContinue)) { Warn "No curated skills in $Skills yet (see RUNNER-SETUP.md section 6); required ones fail preflight." }

# ── 4. images ──
Step "Building images (runner, sandbox, egress proxy)"
Invoke-Checked "docker.exe" @("build", "-t", "crestmont-ai-runner:1", "-f", (Join-Path $RunnerSrc "Dockerfile"), $RunnerSrc) "docker build runner"
Invoke-Checked "docker.exe" @("build", "-t", "crestmont-build-sandbox:1", "-f", (Join-Path $RunnerSrc "sandbox\Dockerfile"), (Join-Path $RunnerSrc "sandbox")) "docker build sandbox"
Copy-Item -Force (Join-Path $PSScriptRoot "docker-compose.yml") (Join-Path $Compose "docker-compose.yml")
New-Item -ItemType Directory -Force -Path (Join-Path $Compose "proxy") | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "proxy\Dockerfile") (Join-Path $Compose "proxy\Dockerfile")
Ok "Images built"

# ── 5. model selection ──
Step "Model selection"
& docker.exe run --rm --network none -v "${State}:/in:ro" --entrypoint node crestmont-ai-runner:1 --no-warnings windows/select-model.ts /in/hardware.json | Out-File -Encoding utf8 (Join-Path $State "recommendation.json")
$selectExit = $LASTEXITCODE
$rec = Get-Content (Join-Path $State "recommendation.json") -Raw | ConvertFrom-Json
Write-Host "    $($rec.summary)"
foreach ($w in $rec.warnings) { Warn $w }
foreach ($b in $rec.blockers) { Fail $b }
if ($Model) { Warn "Using -Model $Model instead of the recommendation ($($rec.model))."; $script:Problems.Clear() }
elseif ($selectExit -ne 0 -or -not $rec.model) { Stop-WithProblems }
$selected = if ($Model) { $Model } else { $rec.model }
$ctx = [int]$rec.contextTokens
if ($ctx -lt 16384) { $ctx = 32768 }

# ── 6. Ollama ──
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
  if (-not $listen) { Fail "Ollama is not listening on port 11434."; Stop-WithProblems }
  $public = @($listen | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
  if ($public.Count) { Fail "Ollama listens on $($public.LocalAddress -join ', '): it must be localhost only. Remove OLLAMA_HOST overrides (system scope too)."; Stop-WithProblems }
  Ok "Ollama listening on localhost only"
  if (-not $SkipModelPull) {
    Write-Host "    Pulling $selected (this can take a long time)"
    Invoke-Checked "ollama" @("pull", $selected) "ollama pull $selected"
  }
  $have = (& ollama list | Out-String)
  if ($have -notmatch [Regex]::Escape(($selected -split ":")[0])) { Fail "Model $selected is not in 'ollama list'."; Stop-WithProblems }
  Ok "Model $selected available"
  $modelBase = "http://host.docker.internal:11434/v1"
}

# ── 7. compose files ──
Step "Compose configuration"
$extra = @($ExtraEgressDomains | Where-Object { $_ }) -join " "
if (-not $extra) { $extra = "none.invalid" }
$pull = if ($OllamaInDocker) { "registry.ollama.ai .ollama.com .r2.cloudflarestorage.com" } else { "none.invalid" }
$squid = Get-Content (Join-Path $PSScriptRoot "proxy\squid.conf.template") -Raw
$squid = $squid.Replace("__PLATFORM_HOST__", $PlatformHost).Replace("__RUNNER_EXTRA_DOMAINS__", $extra).Replace("__OLLAMA_PULL_DOMAINS__", $pull)
# Squid expects LF line endings; write without BOM.
[IO.File]::WriteAllText((Join-Path $Compose "proxy\squid.conf"), ($squid -replace "`r`n", "`n"))
$runnerEnv = @(
  "CONTROL_PLANE_URL=$PlatformUrl"
  "BUILD_RUNNER_SECRET_FILE=/run/secrets/build_runner_secret"
  "RUNNER_ID=$RunnerId"
  "RUNNER_AGENT_PROVIDER=local"
  "RUNNER_ALLOW_PAID_PROVIDER=false"
  "LOCAL_MODEL=$selected"
  "LOCAL_MODEL_BASE_URL=$modelBase"
  "LOCAL_MODEL_CONTEXT_TOKENS=$ctx"
  "RUNNER_SANDBOX_IMAGE=crestmont-build-sandbox:1"
  "RUNNER_JOB_CPUS=$($rec.jobLimits.cpus)"
  "RUNNER_JOB_MEMORY=$($rec.jobLimits.memoryGB)g"
  "RUNNER_JOB_DISK_MB=$([int]$rec.jobLimits.diskGB * 1024)"
  "RUNNER_SERVE_AI_DRAFTS=true"
  "LOG_LEVEL=info"
)
$runnerEnv | Set-Content -Encoding ascii (Join-Path $Compose "runner.env")
$composeEnv = @("OLLAMA_CONTEXT_LENGTH=$ctx", "OLLAMA_NUM_PARALLEL=$($rec.ollama.numParallel)", "OLLAMA_KV_CACHE_TYPE=$($rec.ollama.kvCacheType)")
$composeEnv | Set-Content -Encoding ascii (Join-Path $Compose ".env")
Ok "Wrote docker-compose.yml, proxy\squid.conf, runner.env (no secret values)"

# ── 8. checks ──
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
  Stop-WithProblems
}
Ok "Model server reachable from the container network"
Invoke-Checked "docker.exe" ($composeArgs + @("run", "--rm", "--no-deps", "runner", "node", "--no-warnings", "src/main.ts", "--preflight")) "runner --preflight"
Ok "Runner preflight passed"

# ── 9. start + auto-start ──
if (-not $NoStart) {
  Step "Starting the runner"
  Invoke-Checked "docker.exe" ($composeArgs + @("up", "-d")) "docker compose up"
  Ok "Runner started (restart policy: unless-stopped)"
}
if (-not $NoAutoStart) {
  Step "Auto-start after reboot"
  Copy-Item -Force (Join-Path $PSScriptRoot "Start-CrestmontRunner.ps1") (Join-Path $InstallDir "Start-CrestmontRunner.ps1")
  Copy-Item -Force (Join-Path $PSScriptRoot "Get-RunnerHealth.ps1") (Join-Path $InstallDir "Get-RunnerHealth.ps1")
  Copy-Item -Force (Join-Path $PSScriptRoot "Collect-Evidence.ps1") (Join-Path $InstallDir "Collect-Evidence.ps1")
  Copy-Item -Force (Join-Path $PSScriptRoot "Discover-Hardware.ps1") (Join-Path $InstallDir "Discover-Hardware.ps1")
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -InstallDir `"{1}`"{2}" -f (Join-Path $InstallDir "Start-CrestmontRunner.ps1"), $InstallDir, $(if ($OllamaInDocker) { " -OllamaInDocker" } else { "" }))
  # Docker Desktop and the Ollama tray app run in a user session, so the task runs at this user's logon.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName "CrestmontRunner-Start" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
  Ok "Scheduled task 'CrestmontRunner-Start' runs at logon of $env:USERNAME (see WINDOWS-SUPERCOMPUTER.md for unattended reboots)"
}

Step "Health"
Start-Sleep -Seconds 10
& (Join-Path $PSScriptRoot "Get-RunnerHealth.ps1") -InstallDir $InstallDir
Write-Host ""
Write-Host "Done. Model: $selected  Provider: local (paid API disabled)  No ports published, no firewall rules added." -ForegroundColor Green
