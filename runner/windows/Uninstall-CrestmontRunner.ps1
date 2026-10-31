<#
.SYNOPSIS
  Stops, rolls back or removes the Crestmont build runner on a Windows machine. Never touches Ollama, its models or
  settings, or any other application (Node 1: HQ/JARVIS and its processes are left alone).

.DESCRIPTION
  Default (no switch): stop. Stops the runner stack (`docker compose down`; a running build is released and requeued
  by the platform without spending an attempt) and disables the scheduled tasks. Nothing is deleted. Undo with
  Start-CrestmontRunner.ps1 and `Enable-ScheduledTask CrestmontRunner-Start`.

  -Rollback: return to the images and runner.env that were in use before the last installer run (the installer keeps
  them as <image>:1-previous and state\runner.env.previous), then start the stack again.

  -Remove: stop, unregister the scheduled tasks, remove the runner containers, the compose networks and the three
  Crestmont images. -InstallDir is kept unless -DeleteInstallDir is given; even then the secrets folder is deleted
  only with -DeleteSecrets (rotate BUILD_RUNNER_SECRET on staging afterwards if the machine is retired). The workspace
  volume (crestmont-workspaces, build checkpoints) is kept unless -DeleteWorkspaces is given.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Uninstall-CrestmontRunner.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Uninstall-CrestmontRunner.ps1 -Rollback
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Uninstall-CrestmontRunner.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [switch]$Rollback,
  [switch]$Remove,
  [switch]$DeleteInstallDir,
  [switch]$DeleteSecrets,
  [switch]$DeleteWorkspaces
)
$ErrorActionPreference = "Continue"
if ($Rollback -and $Remove) { throw "Use either -Rollback or -Remove, not both" }
$Compose = Join-Path $InstallDir "compose"
$State = Join-Path $InstallDir "state"
$composeFile = Join-Path $Compose "docker-compose.yml"
$composeArgs = @("compose", "-f", $composeFile, "--project-directory", $Compose, "--profile", "ollama-in-docker")
# How it was installed (written by the installer at the end of a successful run).
$mode = $null
foreach ($f in @((Join-Path $State "install.json"))) { if (Test-Path $f) { try { $mode = Get-Content $f -Raw | ConvertFrom-Json } catch { $mode = $null } } }
$images = @("crestmont-ai-runner", "crestmont-build-sandbox", "crestmont-egress-proxy")
$tasks = @("CrestmontRunner-Start", "CrestmontRunner-GpuTelemetry")
function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }

Say "Stopping the Crestmont runner stack (a running build is released and requeued by the platform)"
foreach ($t in $tasks) { if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $t | Out-Null; Write-Host "    disabled task $t" } }
if (Test-Path $composeFile) {
  # Grace for the runner to checkpoint and release (stop_grace_period in docker-compose.yml).
  & docker.exe @($composeArgs + @("down", "--timeout", "300")) 2>&1 | ForEach-Object { Write-Host "    $_" }
} else { Write-Host "    no compose file at $composeFile (nothing running from this install)" }
# Per-build sandbox containers the runner may have left (named cm-job-*); only Crestmont's own.
$left = @(& docker.exe ps -aq --filter "name=^cm-job-" 2>$null)
if ($left.Count) { & docker.exe rm -f @left 2>&1 | Out-Null; Write-Host "    removed $($left.Count) leftover build sandbox container(s)" }

if ($Rollback) {
  Say "Rolling back to the previous images and runner.env"
  foreach ($img in $images) {
    & docker.exe image inspect "${img}:1-previous" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { & docker.exe tag "${img}:1-previous" "${img}:1" | Out-Null; Write-Host "    ${img}:1 <- ${img}:1-previous" }
    else { Write-Host "    ${img}: no previous image kept; current one stays" -ForegroundColor Yellow }
  }
  $prevEnv = Join-Path $State "runner.env.previous"
  if (Test-Path $prevEnv) { Copy-Item -Force $prevEnv (Join-Path $Compose "runner.env"); Write-Host "    runner.env restored" }
  foreach ($t in $tasks) { if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $t | Out-Null } }
  $startArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $InstallDir "Start-CrestmontRunner.ps1"), "-InstallDir", $InstallDir)
  # Same Ollama mode as the install; never start a shared Ollama (unknown mode = do not start it).
  if ($mode -and $mode.ollamaInDocker) { $startArgs += "-OllamaInDocker" } elseif (-not $mode -or $mode.preserveOllamaConfig) { $startArgs += "-NoOllamaStart" }
  & powershell.exe @startArgs
  Say "Rolled back. Check: powershell -NoProfile -ExecutionPolicy Bypass -File $InstallDir\Get-RunnerHealth.ps1"
  exit 0
}

if ($Remove) {
  Say "Removing the Crestmont runner (Ollama, its models and other applications are not touched)"
  foreach ($t in $tasks) { if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host "    unregistered task $t" } }
  foreach ($img in $images) { foreach ($tag in @("1", "1-previous")) { & docker.exe image rm "${img}:$tag" 2>&1 | Out-Null } }
  Write-Host "    removed Crestmont images (if present)"
  foreach ($n in @("crestmont_runner", "crestmont_install", "crestmont_egress")) { & docker.exe network rm $n 2>&1 | Out-Null }
  if ($DeleteWorkspaces) { & docker.exe volume rm crestmont-workspaces 2>&1 | Out-Null; Write-Host "    deleted volume crestmont-workspaces" }
  else { Write-Host "    kept volume crestmont-workspaces (build checkpoints); -DeleteWorkspaces removes it" }
  if ($DeleteInstallDir -and (Test-Path $InstallDir)) {
    $keep = if ($DeleteSecrets) { @() } else { @("secrets") }
    Get-ChildItem -Force $InstallDir | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force
    Write-Host "    deleted $InstallDir contents$(if ($keep.Count) { ' except secrets\ (use -DeleteSecrets; then rotate BUILD_RUNNER_SECRET on staging)' })"
  } else { Write-Host "    kept $InstallDir (logs, evidence, state, secrets)" }
  Say "Removed."
  exit 0
}

Say "Stopped. Nothing was deleted. Start again with: powershell -NoProfile -ExecutionPolicy Bypass -File $InstallDir\Start-CrestmontRunner.ps1; then Enable-ScheduledTask CrestmontRunner-Start"
