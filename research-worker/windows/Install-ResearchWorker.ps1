<#
.SYNOPSIS
  Idempotent installer for the Crestmont lead-research worker on the Windows workstation.

.DESCRIPTION
  Safe to re-run; nothing is installed unless -Install is given. Steps:
    1. Prerequisites: Node.js >= 22.18, DuckDB CLI, Ollama answering on 127.0.0.1 only (optional: Playwright, Lighthouse,
       osmium-tool). With -Install, missing Node/DuckDB are installed with winget.
    2. Folders under -InstallDir with restrictive ACLs (SYSTEM, Administrators, this user).
    3. The worker secret, stored encrypted with Windows DPAPI for this user (never printed, never on a command line).
    4. settings.env (non-secret settings).
    5. Preflight (node src/main.ts --preflight): DuckDB, Ollama model, platform connection with the secret.
    6. Scheduled task "CrestmontResearch-Worker": bounded restarts on failure, no time limit, one instance only, and
       no terminal window (session 0 with -RunWhenLoggedOff, otherwise the hidden launcher). It starts at logon, and
       with -RunWhenLoggedOff also at boot and while nobody is signed in.
  It opens NO inbound firewall ports. The health endpoint listens on 127.0.0.1 only. Ollama must stay on 127.0.0.1.

.PARAMETER PlatformUrl
  https origin of the Crestmont platform. Use STAGING first; production only after the Founder's approval.
.PARAMETER States
  Comma-separated state codes to research first (e.g. "MI,OH"); empty = all states.
.PARAMETER Model
  Ollama model tag for OPTIONAL drafts. LEAVE THIS EMPTY unless you have decided research may use the GPU: the GPU on
  this machine is shared with the AI Website Builder. Empty = no drafts and no GPU use at all, which is the
  recommended setting for a first continuous run (docs/research/RUNBOOK.md section 8). Qualification, scoring and
  packages are computed in code either way, so nothing about lead quality depends on this.
.PARAMETER Concurrency
  Simultaneous website checks (HTTP_CONCURRENCY, 1-256). Start conservative and raise it in steps once the machine is
  proven healthy; one request per host at a time with a politeness interval is enforced regardless.
.PARAMETER RunWhenLoggedOff
  Also run the worker when nobody is signed in, and start it at boot rather than only at logon. Task Scheduler then
  needs the account's Windows password, which it stores itself; this is required because the worker's platform secret
  is protected with DPAPI for this user, and a password-less (S4U) task cannot decrypt it. Without this switch the
  worker does NOT come back on its own after an unattended restart (see the warning the installer prints).

.EXAMPLE
  .\research-worker\windows\Install-ResearchWorker.ps1 -PlatformUrl https://crestmont-platform-staging.example.workers.dev -States "MI" -Install
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PlatformUrl,
  [string]$InstallDir = "C:\CrestmontResearch",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$States = "",
  [string]$Model = "",
  [int]$Concurrency = 24,
  [switch]$RunWhenLoggedOff,
  [string]$SecretFile = "",
  [string]$RunnerId = ("research-" + $env:COMPUTERNAME.ToLower()),
  [string]$DuckDbPath = "duckdb",
  [string]$LighthousePath = "",
  [switch]$Install,
  [switch]$NoAutoStart
)
$ErrorActionPreference = "Stop"
# Shared with the build-runner kit: scheduled-task registration that cannot open a terminal window, single-instance
# locking and the bounded-retry policy. One copy, in runner\windows, installed next to the worker below.
. (Join-Path $RepoPath "runner\windows\BackgroundTask.ps1")
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

if ($PlatformUrl -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?$') { Fail "PlatformUrl must be an https origin without a path" }
if ($RunnerId -notmatch '^[A-Za-z0-9._:-]{1,64}$') { Fail "RunnerId must be 1-64 characters of [A-Za-z0-9._:-]" }

Step "1. Prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node -and $Install) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Null; $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { Fail "Node.js >= 22.18 is required (winget install OpenJS.NodeJS.LTS)" }
$v = (& node --version).TrimStart("v").Split(".")
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 18)) { Fail "Node.js $((& node --version)) is too old; need >= 22.18" }
Ok "Node.js $((& node --version))"
$duck = Get-Command $DuckDbPath -ErrorAction SilentlyContinue
if (-not $duck -and $Install) { winget install --id DuckDB.cli -e --accept-source-agreements --accept-package-agreements | Out-Null; $duck = Get-Command $DuckDbPath -ErrorAction SilentlyContinue }
if (-not $duck) { Fail "DuckDB CLI is required (winget install DuckDB.cli) or pass -DuckDbPath" }
Ok "DuckDB $((& $duck.Source --version) -join ' ')"
try {
  $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
  Ok ("Ollama on 127.0.0.1 ({0} models)" -f @($tags.models).Count)
  if ($Model -and -not (@($tags.models) | Where-Object { $_.name -eq $Model -or $_.name -eq "$($Model):latest" })) { Warn "Model $Model is not pulled: run 'ollama pull $Model' (drafts stay off until then)" }
} catch { Warn "Ollama is not answering on 127.0.0.1:11434; the worker runs without drafts" }
$ollamaHost = [Environment]::GetEnvironmentVariable("OLLAMA_HOST", "User")
if ($ollamaHost -and $ollamaHost -notmatch '^(127\.0\.0\.1|localhost)(:\d+)?$') { Fail "OLLAMA_HOST=$ollamaHost exposes Ollama beyond this machine. Set it to 127.0.0.1:11434." }
if (Get-Command npx -ErrorAction SilentlyContinue) { Ok "npx present (optional Playwright: npm i -g playwright; npx playwright install chromium)" }

Step "2. Folders ($InstallDir)"
$Data = Join-Path $InstallDir "data"; $Logs = Join-Path $InstallDir "logs"; $Secrets = Join-Path $InstallDir "secrets"
foreach ($d in @($InstallDir, $Data, $Logs, $Secrets)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
foreach ($d in @($InstallDir, $Secrets)) {
  $acl = Get-Acl $d
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($who in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators", "$env:USERDOMAIN\$env:USERNAME")) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
  }
  Set-Acl $d $acl
}
Ok "Folders created; access limited to SYSTEM, Administrators and $env:USERNAME"

Step "3. Worker secret (DPAPI, this user)"
$secretPath = Join-Path $Secrets "research_runner_secret.dpapi"
if (-not (Test-Path $secretPath)) {
  if ($SecretFile) { $sec = ConvertTo-SecureString ((Get-Content $SecretFile -Raw).Trim()) -AsPlainText -Force }
  else { $sec = Read-Host -AsSecureString "Paste RESEARCH_RUNNER_SECRET (same value as the platform's Worker secret; input hidden)" }
  $plainLen = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Length
  if ($plainLen -lt 32) { Fail "The secret looks too short (< 32 characters)" }
  ConvertFrom-SecureString $sec | Set-Content -Path $secretPath -Encoding ASCII
  Ok "Secret stored encrypted at $secretPath (not displayed)"
} else { Ok "Secret already stored (unchanged)" }

if ($Concurrency -lt 1 -or $Concurrency -gt 256) { Fail "-Concurrency must be 1..256 (got $Concurrency)" }

Step "4. settings.env"
$settings = @(
  "CRESTMONT_URL=$PlatformUrl", "RESEARCH_RUNNER_ID=$RunnerId", "RESEARCH_DATA_DIR=$Data", "RESEARCH_STATES=$States",
  "DUCKDB_PATH=$($duck.Source)", "OLLAMA_URL=http://127.0.0.1:11434", "RESEARCH_MODEL=$Model", "LIGHTHOUSE_PATH=$LighthousePath",
  "OVERTURE=on", "COMMON_CRAWL=on", "FOURSQUARE_OS=off", "OSM=off", "PLAYWRIGHT=off", "HEALTH_PORT=8789",
  # Website checks run at this many at a time; one request per host with a politeness interval regardless.
  "HTTP_CONCURRENCY=$Concurrency",
  # The GPU is shared with the AI Website Builder. These keep optional drafting from ever competing with it
  # (docs/research/RUNBOOK.md section 8). With RESEARCH_MODEL empty they have nothing to do.
  "MODEL_GPU_GUARD=on", "MODEL_KEEP_ALIVE=30s", "MODEL_MAX_GPU_UTIL_PCT=25", "MODEL_MIN_FREE_VRAM_MB=8000"
)
$settings | Set-Content -Path (Join-Path $InstallDir "settings.env") -Encoding ASCII
Copy-Item (Join-Path $PSScriptRoot "Start-ResearchWorker.ps1") $InstallDir -Force
Copy-Item (Join-Path $PSScriptRoot "Get-ResearchWorkerHealth.ps1") $InstallDir -Force
Copy-Item (Join-Path $RepoPath "runner\windows\BackgroundTask.ps1") $InstallDir -Force
"REPO_PATH=$RepoPath" | Add-Content -Path (Join-Path $InstallDir "settings.env") -Encoding ASCII
Ok "settings.env written (no secrets inside)"

Step "5. Preflight"
# Run in this process (no nested powershell.exe, which would open a second console window for nothing).
& (Join-Path $InstallDir "Start-ResearchWorker.ps1") -InstallDir $InstallDir -Preflight
if ($LASTEXITCODE -ne 0) { Fail "Preflight failed: fix the items marked MISSING/FAILED above, then re-run" }
Ok "Preflight passed"

if (-not $NoAutoStart) {
  Step "6. Scheduled task"
  # An -AtLogOn trigger alone leaves the worker stopped after an unattended restart until someone signs in, which is
  # not continuous operation. -RunWhenLoggedOff adds a boot trigger and runs the task with the account's stored
  # password, which DPAPI needs to unprotect the platform secret (an S4U, password-less task cannot).
  $triggers = @(New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
  if ($RunWhenLoggedOff) { $triggers += New-ScheduledTaskTrigger -AtStartup }
  # Bounded: 4, not 999. The supervisor itself retries with exponential backoff inside a rolling budget, so a large
  # RestartCount here would multiply two retry loops together and keep a broken worker launching indefinitely.
  $taskSettings = Get-CrestmontBackgroundTaskSetting -RestartCount 4 -RestartIntervalMinutes 5 -RunIndefinitely
  if ($RunWhenLoggedOff) {
    $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message "Windows password for $env:USERNAME. Task Scheduler stores it so research keeps running with nobody signed in; it is not written to this repository or to settings.env."
    if (-not $cred) { Fail "-RunWhenLoggedOff needs the account password to register a task that runs while logged off" }
    # Session 0 with the stored password: no desktop, so no terminal window, and DPAPI still works.
    $task = Register-CrestmontBackgroundTask -TaskName "CrestmontResearch-Worker" -InstallDir $InstallDir `
      -ScriptPath (Join-Path $InstallDir "Start-ResearchWorker.ps1") -ScriptArgument @("-InstallDir", $InstallDir) `
      -Trigger $triggers -Settings $taskSettings -Credential $cred
    Ok "Task registered to run at boot and while logged off, $($task.Strategy) (no terminal window)"
  } else {
    # Without a stored password the worker has to run in this user's own logon session, because the platform secret
    # is DPAPI-protected for this user and a session-0 S4U task has no access to the user's master key. The hidden
    # launcher keeps it windowless all the same.
    $task = Register-CrestmontBackgroundTask -TaskName "CrestmontResearch-Worker" -InstallDir $InstallDir `
      -ScriptPath (Join-Path $InstallDir "Start-ResearchWorker.ps1") -ScriptArgument @("-InstallDir", $InstallDir) `
      -Trigger $triggers -Settings $taskSettings -DesktopSession
    Ok "Task registered, $($task.Strategy) (no terminal window)"
    Warn "The task runs only while $env:USERNAME is signed in: after an unattended restart research stays stopped until the next logon. Re-run with -RunWhenLoggedOff for continuous operation."
  }
  $check = Test-CrestmontTaskIsWindowless -TaskName "CrestmontResearch-Worker"
  if ($check.Ok) { Ok "CrestmontResearch-Worker opens no terminal window ($($check.Reason))" } else { Warn "CrestmontResearch-Worker could open a terminal window: $($check.Reason)" }
  Start-ScheduledTask -TaskName "CrestmontResearch-Worker"
  Ok "Task registered and started. Health: $InstallDir\Get-ResearchWorkerHealth.ps1"
  # ${Model} is delimited on purpose: "$Model:" parses as a scoped variable reference (like $env:X) and is a syntax error.
  if ($Model) { Warn "RESEARCH_MODEL=${Model}: optional drafts may use the GPU shared with the AI Website Builder. The guard defers them whenever the builder needs it (RUNBOOK section 8); leave -Model empty to keep research off the GPU entirely." }
  else { Ok "No local model configured: research uses CPU, DuckDB, disk and bounded HTTP only. The Website Builder keeps the GPU." }
}
Write-Host "`nResearch on the platform starts PAUSED. Resume it in /staff/research (Owner) after reviewing the sources." -ForegroundColor Cyan
