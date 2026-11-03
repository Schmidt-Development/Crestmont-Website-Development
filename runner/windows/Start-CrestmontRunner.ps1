<#
.SYNOPSIS
  Starts (or restarts after a reboot) the Crestmont build runner: Docker Desktop, Ollama, then `docker compose up -d`.
  Run by the "CrestmontRunner-Start" scheduled task at logon and, with -NoGuiLaunch, by "CrestmontRunner-Watchdog"
  every few minutes. Safe to run by hand at any time (idempotent).
  Containers also restart on their own (restart: unless-stopped) once the Docker engine is up.
  An in-flight build interrupted by a reboot is recovered by the platform: its lease expires, the build is requeued
  with its resume data, and the runner restores the checkpoint (git + agent transcript) when it claims it again.

.DESCRIPTION
  Neither task opens a terminal window: the logon task runs through the hidden launcher and the watchdog runs in
  session 0 (see BackgroundTask.ps1 for why -WindowStyle Hidden alone does not do this). Only one copy runs at a
  time, enforced by a lock file as well as by -MultipleInstances IgnoreNew, so a hand-run copy cannot race the
  scheduled one into `docker compose up` twice.

.PARAMETER NoGuiLaunch
  Do not start Docker Desktop or the Ollama tray app, and do not wait long for the engine. This is what the
  repeating watchdog uses: it runs in session 0, where a GUI program has no desktop to appear on, and where
  launching one would either fail or (worse) steal focus from whatever the Founder is doing. If the engine is not
  up, the watchdog logs it and leaves it to the next logon, which is the only place those GUI programs belong.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [switch]$OllamaInDocker,
  # Shared native Ollama (Node 1: HQ/JARVIS): never start or stop it from here.
  [switch]$NoOllamaStart,
  [switch]$NoGuiLaunch,
  [int]$WaitMinutes = 10
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "BackgroundTask.ps1")

$log = Join-Path $InstallDir "logs\start.log"
$state = Join-Path $InstallDir "state"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log([string]$m) {
  $line = "{0} {1}" -f (Get-Date).ToString("o"), $m
  Add-Content -Path $log -Value $line
  Write-Host $line
  # Structured sibling log, for machine reading (the plain one above stays for operators reading it by eye).
  Write-CrestmontLogLine -Path (Join-Path $InstallDir "logs\start.jsonl") -Level "info" -Message $m -Data @{ mode = $(if ($NoGuiLaunch) { "watchdog" } else { "logon" }) }
}
# Keep the logs small (rotation: last ~2000 lines of each).
Invoke-CrestmontLogRotation -Path $log -MaxBytes 1MB -KeepLines 2000
Invoke-CrestmontLogRotation -Path (Join-Path $InstallDir "logs\start.jsonl") -MaxBytes 4MB -KeepLines 5000

# One at a time. The watchdog fires every few minutes and `docker compose up` can take longer than that; without
# this, a slow run and the next trigger would overlap. Released automatically when this process ends.
$lock = Enter-CrestmontSingleInstance -Name "runner-start" -StateDir $state
if (-not $lock) {
  Log "another start/watchdog run is already in progress; leaving it to finish"
  exit 0
}
try {
  if (-not (Assert-CrestmontNotNested -Name "runner-start")) { Log "refusing to run nested inside another start run"; exit 0 }
  Log "start requested (NoGuiLaunch=$([bool]$NoGuiLaunch))"

  if (-not $NoGuiLaunch) {
    # GUI programs, and only from the logon task: they need the Founder's own session. Started hidden/minimised so
    # neither one takes focus while the desktop is in use.
    $dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue) -and (Test-Path $dockerDesktop)) {
      Log "starting Docker Desktop"
      Start-Process -FilePath $dockerDesktop -WindowStyle Minimized | Out-Null
    }
    if (-not $OllamaInDocker -and -not $NoOllamaStart) {
      $app = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
      if (-not (Get-Process "ollama" -ErrorAction SilentlyContinue) -and (Test-Path $app)) {
        Log "starting Ollama"
        Start-Process -FilePath $app -WindowStyle Minimized | Out-Null
      }
    }
  }

  # Wait for the engine. The watchdog does not wait: in session 0 it cannot start Docker Desktop, so if the engine
  # is down there is nothing for it to do but say so and let the next logon handle it.
  $waitMinutes = if ($NoGuiLaunch) { [Math]::Min($WaitMinutes, 1) } else { $WaitMinutes }
  $deadline = (Get-Date).AddMinutes($waitMinutes)
  do {
    & docker.exe info --format "{{.OSType}}" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) {
    if ($NoGuiLaunch) { Log "Docker engine is not up; the watchdog cannot start Docker Desktop from session 0, so this is left to the next logon"; exit 0 }
    Log "Docker engine did not come up within $waitMinutes minutes"
    exit 1
  }

  $compose = Join-Path $InstallDir "compose"
  $composeArgs = @("compose", "-f", (Join-Path $compose "docker-compose.yml"), "--project-directory", $compose)
  if ($OllamaInDocker) { $composeArgs += @("--profile", "ollama-in-docker") }
  & docker.exe @($composeArgs + @("up", "-d")) 2>&1 | ForEach-Object { Log $_ }
  if ($LASTEXITCODE -ne 0) { Log "docker compose up failed ($LASTEXITCODE)"; exit 1 }
  Log "runner stack is up"
}
finally { Exit-CrestmontSingleInstance -Handle $lock }
