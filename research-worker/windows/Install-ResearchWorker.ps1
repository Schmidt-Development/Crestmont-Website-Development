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
    6. Scheduled task "CrestmontResearch-Worker": starts at logon, restarts on failure, no time limit.
  It opens NO inbound firewall ports. The health endpoint listens on 127.0.0.1 only. Ollama must stay on 127.0.0.1.

.PARAMETER PlatformUrl
  https origin of the Crestmont platform. Use STAGING first; production only after the Founder's approval.
.PARAMETER States
  Comma-separated state codes to research first (e.g. "MI,OH"); empty = all states.
.PARAMETER Model
  Ollama model tag for optional drafts (must already be pulled, e.g. a Qwen instruct model). Empty = no drafts.

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
  [string]$SecretFile = "",
  [string]$RunnerId = ("research-" + $env:COMPUTERNAME.ToLower()),
  [string]$DuckDbPath = "duckdb",
  [string]$LighthousePath = "",
  [switch]$Install,
  [switch]$NoAutoStart
)
$ErrorActionPreference = "Stop"
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

Step "4. settings.env"
$settings = @(
  "CRESTMONT_URL=$PlatformUrl", "RESEARCH_RUNNER_ID=$RunnerId", "RESEARCH_DATA_DIR=$Data", "RESEARCH_STATES=$States",
  "DUCKDB_PATH=$($duck.Source)", "OLLAMA_URL=http://127.0.0.1:11434", "RESEARCH_MODEL=$Model", "LIGHTHOUSE_PATH=$LighthousePath",
  "OVERTURE=on", "COMMON_CRAWL=on", "FOURSQUARE_OS=off", "OSM=off", "HEALTH_PORT=8789"
)
$settings | Set-Content -Path (Join-Path $InstallDir "settings.env") -Encoding ASCII
Copy-Item (Join-Path $PSScriptRoot "Start-ResearchWorker.ps1") $InstallDir -Force
Copy-Item (Join-Path $PSScriptRoot "Get-ResearchWorkerHealth.ps1") $InstallDir -Force
"REPO_PATH=$RepoPath" | Add-Content -Path (Join-Path $InstallDir "settings.env") -Encoding ASCII
Ok "settings.env written (no secrets inside)"

Step "5. Preflight"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir "Start-ResearchWorker.ps1") -InstallDir $InstallDir -Preflight
if ($LASTEXITCODE -ne 0) { Fail "Preflight failed: fix the items marked MISSING/FAILED above, then re-run" }
Ok "Preflight passed"

if (-not $NoAutoStart) {
  Step "6. Scheduled task"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -InstallDir `"{1}`"" -f (Join-Path $InstallDir "Start-ResearchWorker.ps1"), $InstallDir)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "CrestmontResearch-Worker" -Action $action -Trigger $trigger -Settings $taskSettings -RunLevel Limited -Force | Out-Null
  Start-ScheduledTask -TaskName "CrestmontResearch-Worker"
  Ok "Task registered and started. Health: $InstallDir\Get-ResearchWorkerHealth.ps1"
}
Write-Host "`nResearch on the platform starts PAUSED. Resume it in /staff/research (Owner) after reviewing the sources." -ForegroundColor Cyan
