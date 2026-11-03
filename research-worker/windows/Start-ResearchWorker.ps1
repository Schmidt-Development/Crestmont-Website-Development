<#
.SYNOPSIS
  Runs the Crestmont research worker with its settings and DPAPI-protected secret; restarts it after a crash with
  bounded retries and exponential backoff; writes JSON-lines logs to logs\worker-YYYYMMDD.log (14 days kept) and a
  supervisor log to logs\supervisor.jsonl. -Preflight runs the checks once.

.DESCRIPTION
  Started by the "CrestmontResearch-Worker" scheduled task, which runs in session 0 and therefore never opens a
  terminal window (BackgroundTask.ps1 explains why -WindowStyle Hidden alone does not achieve that).

  Restarts are BOUNDED. Before each restart the supervisor asks Test-CrestmontRestartBudget for permission: at most
  -MaxRestarts restarts per -RestartWindowMinutes. A worker that fails instantly therefore stops instead of
  spinning, and the scheduled task's own small RestartCount is the only thing left to retry it. A worker that has
  been healthy for -HealthyMinutes resets the backoff, so a crash after a week of uptime is not treated as part of
  a crash loop. Nothing here can spawn a second worker: the single-instance lock covers a hand-run copy, and the
  nesting guard covers a worker that somehow re-launches its own supervisor.

  Resource limits: the node heap is capped (-NodeHeapMb) and the supervisor lowers its own priority class before
  launching, which the worker inherits, so research never competes with the desktop for CPU.

  Queues, progress, credentials and resumable work are untouched by this script: they live in RESEARCH_DATA_DIR,
  the DuckDB database and secrets\research_runner_secret.dpapi, none of which it writes.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontResearch",
  [switch]$Preflight,
  [ValidateRange(1, 1000)][int]$MaxRestarts = 10,
  [ValidateRange(1, 10080)][int]$RestartWindowMinutes = 60,
  [ValidateRange(1, 3600)][int]$BackoffBaseSeconds = 5,
  [ValidateRange(1, 86400)][int]$BackoffCapSeconds = 300,
  [ValidateRange(1, 1440)][int]$HealthyMinutes = 10,
  [ValidateRange(256, 65536)][int]$NodeHeapMb = 4096,
  [ValidateSet("Idle", "BelowNormal", "Normal")][string]$Priority = "BelowNormal"
)
$ErrorActionPreference = "Stop"

# BackgroundTask.ps1 sits next to this script once installed; in a repository checkout it is in the runner kit.
$module = Join-Path $PSScriptRoot "BackgroundTask.ps1"
if (-not (Test-Path $module)) { $module = Join-Path $PSScriptRoot "..\..\runner\windows\BackgroundTask.ps1" }
. $module

$settings = @{}
foreach ($line in Get-Content (Join-Path $InstallDir "settings.env")) { if ($line -match '^([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] } }
foreach ($k in $settings.Keys) { if ($k -ne "REPO_PATH") { [Environment]::SetEnvironmentVariable($k, $settings[$k], "Process") } }
$sec = Get-Content (Join-Path $InstallDir "secrets\research_runner_secret.dpapi") -Raw | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { [Environment]::SetEnvironmentVariable("RESEARCH_RUNNER_SECRET", [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr), "Process") }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$main = Join-Path $settings["REPO_PATH"] "research-worker\src\main.ts"
$logs = Join-Path $InstallDir "logs"
$supervisorLog = Join-Path $logs "supervisor.jsonl"

if ($Preflight) { & node --no-warnings $main --preflight; exit $LASTEXITCODE }

# One worker at a time: the scheduled task carries -MultipleInstances IgnoreNew, and this also stops a copy started
# by hand from racing it over the same queue and DuckDB database. Released by the OS when this process ends.
$lock = Enter-CrestmontSingleInstance -Name "research-worker" -StateDir (Join-Path $InstallDir "state")
if (-not $lock) {
  Write-CrestmontLogLine -Path $supervisorLog -Level "warn" -Message "another research worker is already running; this copy is exiting"
  exit 0
}
try {
  if (-not (Assert-CrestmontNotNested -Name "research-worker")) {
    Write-CrestmontLogLine -Path $supervisorLog -Level "error" -Message "refusing to run nested inside another research worker supervisor"
    exit 0
  }
  Invoke-CrestmontLogRotation -Path $supervisorLog -MaxBytes 4MB -KeepLines 5000 -DailyPattern "worker-*.log" -KeepDays 14
  # Research is background work; the worker inherits this priority class from the supervisor.
  try { (Get-Process -Id $PID).PriorityClass = [System.Diagnostics.ProcessPriorityClass]$Priority } catch { $null = $_ }

  $budgetFile = Join-Path $InstallDir "state\worker-restarts.txt"
  $attempt = 0
  $supervising = $true
  Write-CrestmontLogLine -Path $supervisorLog -Level "info" -Message "supervisor started" -Data @{
    maxRestarts = $MaxRestarts; windowMinutes = $RestartWindowMinutes; heapMb = $NodeHeapMb; priority = $Priority
  }

  while ($supervising) {
    $log = Join-Path $logs ("worker-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
    $started = Get-Date
    & node --no-warnings "--max-old-space-size=$NodeHeapMb" $main *>> $log
    $code = $LASTEXITCODE
    $ranMinutes = ((Get-Date) - $started).TotalMinutes
    Add-Content -Path $log -Value ('{{"ts":"{0}","level":"warn","msg":"worker exited","code":{1}}}' -f (Get-Date).ToUniversalTime().ToString("o"), $code)
    Write-CrestmontLogLine -Path $supervisorLog -Level "warn" -Message "worker exited" -Data @{ code = $code; ranMinutes = [Math]::Round($ranMinutes, 2) }

    # A worker that stayed up is not part of a crash loop: start the backoff from the beginning again.
    if ($ranMinutes -gt $HealthyMinutes) { $attempt = 0 }

    if (-not (Test-CrestmontRestartBudget -StateFile $budgetFile -MaxRestarts $MaxRestarts -WindowMinutes $RestartWindowMinutes)) {
      Write-CrestmontLogLine -Path $supervisorLog -Level "error" -Message "restart budget exhausted; the supervisor is stopping instead of restarting" -Data @{
        maxRestarts = $MaxRestarts; windowMinutes = $RestartWindowMinutes; budgetFile = $budgetFile
      }
      $supervising = $false
      break
    }
    $attempt = $attempt + 1
    $delay = Get-CrestmontBackoffDelay -Attempt $attempt -BaseSeconds $BackoffBaseSeconds -CapSeconds $BackoffCapSeconds
    Write-CrestmontLogLine -Path $supervisorLog -Level "info" -Message "restarting worker after backoff" -Data @{ attempt = $attempt; delaySeconds = $delay }
    Start-Sleep -Seconds $delay
  }
  # Non-zero tells Task Scheduler this run did not end cleanly, so its own bounded RestartCount applies; once that
  # is spent the task waits for the next trigger rather than retrying forever.
  exit 1
}
finally { Exit-CrestmontSingleInstance -Handle $lock }
