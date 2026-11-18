<#
.SYNOPSIS
  Starts (or restarts after a reboot) the Crestmont build runner: Docker Desktop, Ollama, then `docker compose up -d`.
  Run by the "CrestmontRunner-Start" scheduled task at logon and again every 5 minutes as its own watchdog; safe to
  run by hand at any time (idempotent).
  Containers also restart on their own (restart: unless-stopped) once the Docker engine is up.
  An in-flight build interrupted by a reboot is recovered by the platform: its lease expires, the build is requeued
  with its resume data, and the runner restores the checkpoint (git + agent transcript) when it claims it again.

.DESCRIPTION
  The task keeps the triggers, arguments and settings it has always had - at logon plus a 5-minute repetition, one
  instance at a time - and only the way it is LAUNCHED changed: through the hidden wscript.exe shim, so no terminal
  window appears on any run. BackgroundTask.ps1 explains why -WindowStyle Hidden could not do that.

  Running every 5 minutes is what makes this a watchdog, and it is safe because every step is a no-op once the thing
  it checks is already running: Docker Desktop and Ollama are started only if their processes are absent, and
  `docker compose up -d` does nothing to containers that are already up. In the steady state the run does nothing
  at all. The two GUI programs are started minimised so that, on the rare run that does start them, neither takes
  focus from whatever is on screen.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [switch]$OllamaInDocker,
  # Shared native Ollama (Node 1: HQ/JARVIS): never start or stop it from here.
  [switch]$NoOllamaStart,
  [int]$WaitMinutes = 10
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "BackgroundTask.ps1")

$log = Join-Path $InstallDir "logs\start.log"
$jsonLog = Join-Path $InstallDir "logs\start.jsonl"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log([string]$m) {
  $line = "{0} {1}" -f (Get-Date).ToString("o"), $m
  Add-Content -Path $log -Value $line
  Write-Host $line
  # Structured sibling log, for machine reading; the plain one above stays for operators reading it by eye.
  Write-CrestmontLogLine -Path $jsonLog -Level "info" -Message $m
}
# Keep the logs small (rotation: last ~2000 lines of the plain log, ~5000 of the structured one).
Invoke-CrestmontLogRotation -Path $log -MaxBytes 1MB -KeepLines 2000
Invoke-CrestmontLogRotation -Path $jsonLog -MaxBytes 4MB -KeepLines 5000

# One at a time. The 5-minute trigger fires while a slow run may still be waiting for the Docker engine; the task's
# -MultipleInstances IgnoreNew covers the scheduled copies and this also covers a copy started by hand. Released by
# the OS when this process ends, so there is no stale lock to clear after a crash or a kill.
$lock = Enter-CrestmontSingleInstance -Name "runner-start" -StateDir (Join-Path $InstallDir "state")
if (-not $lock) {
  Log "another start run is already in progress; leaving it to finish"
  exit 0
}
try {
  if (-not (Assert-CrestmontNotNested -Name "runner-start")) { Log "refusing to run nested inside another start run"; exit 0 }
  Log "start requested"

  # Started only when absent, and minimised so neither takes focus.
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

  $deadline = (Get-Date).AddMinutes($WaitMinutes)
  do {
    & docker.exe info --format "{{.OSType}}" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { Log "Docker engine did not come up within $WaitMinutes minutes"; exit 1 }

  $compose = Join-Path $InstallDir "compose"
  $composeArgs = @("compose", "-f", (Join-Path $compose "docker-compose.yml"), "--project-directory", $compose)
  if ($OllamaInDocker) { $composeArgs += @("--profile", "ollama-in-docker") }
  & docker.exe @($composeArgs + @("up", "-d")) 2>&1 | ForEach-Object { Log $_ }
  if ($LASTEXITCODE -ne 0) { Log "docker compose up failed ($LASTEXITCODE)"; exit 1 }
  Log "runner stack is up"
}
finally { Exit-CrestmontSingleInstance -Handle $lock }
