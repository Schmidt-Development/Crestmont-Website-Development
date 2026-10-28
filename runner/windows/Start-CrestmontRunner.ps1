<#
.SYNOPSIS
  Starts (or restarts after a reboot) the Crestmont build runner: Docker Desktop, Ollama, then `docker compose up -d`.
  Run by the "CrestmontRunner-Start" scheduled task at logon; safe to run by hand at any time (idempotent).
  Containers also restart on their own (restart: unless-stopped) once the Docker engine is up.
  An in-flight build interrupted by a reboot is recovered by the platform: its lease expires, the build is requeued
  with its resume data, and the runner restores the checkpoint (git + agent transcript) when it claims it again.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [switch]$OllamaInDocker,
  [int]$WaitMinutes = 10
)
$ErrorActionPreference = "Continue"
$log = Join-Path $InstallDir "logs\start.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log([string]$m) { $line = "{0} {1}" -f (Get-Date).ToString("o"), $m; Add-Content -Path $log -Value $line; Write-Host $line }
# Keep the start log small (rotation: last ~2000 lines).
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Get-Content $log -Tail 2000 | Set-Content "$log.tmp"; Move-Item -Force "$log.tmp" $log }

Log "start requested"
$dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue) -and (Test-Path $dockerDesktop)) { Log "starting Docker Desktop"; Start-Process $dockerDesktop | Out-Null }
$claudeMode = Test-Path (Join-Path $InstallDir "compose\docker-compose.claude.yml")
if (-not $OllamaInDocker -and -not $claudeMode) {
  $app = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
  if (-not (Get-Process "ollama" -ErrorAction SilentlyContinue) -and (Test-Path $app)) { Log "starting Ollama"; Start-Process $app | Out-Null }
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
# Founder V3 (-Provider ClaudeCode): the Claude account workers instead of the local-model runner; no Ollama.
if ($claudeMode) { $composeArgs += @("-f", (Join-Path $compose "docker-compose.claude.yml")) }
& docker.exe @($composeArgs + @("up", "-d")) 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { Log "docker compose up failed ($LASTEXITCODE)"; exit 1 }
Log "runner stack is up"
