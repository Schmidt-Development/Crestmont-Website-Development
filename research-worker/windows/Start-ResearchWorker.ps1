<#
.SYNOPSIS
  Runs the Crestmont research worker with its settings and DPAPI-protected secret; restarts it after a crash with
  backoff; writes JSON-lines logs to logs\worker-YYYYMMDD.log (14 days kept). -Preflight runs the checks once.
#>
[CmdletBinding()]
param([string]$InstallDir = "C:\CrestmontResearch", [switch]$Preflight)
$ErrorActionPreference = "Stop"
$settings = @{}
foreach ($line in Get-Content (Join-Path $InstallDir "settings.env")) { if ($line -match '^([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] } }
foreach ($k in $settings.Keys) { if ($k -ne "REPO_PATH") { [Environment]::SetEnvironmentVariable($k, $settings[$k], "Process") } }
$sec = Get-Content (Join-Path $InstallDir "secrets\research_runner_secret.dpapi") -Raw | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { [Environment]::SetEnvironmentVariable("RESEARCH_RUNNER_SECRET", [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr), "Process") }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$main = Join-Path $settings["REPO_PATH"] "research-worker\src\main.ts"
$logs = Join-Path $InstallDir "logs"
if ($Preflight) { & node --no-warnings $main --preflight; exit $LASTEXITCODE }
Get-ChildItem $logs -Filter "worker-*.log" -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force
$delay = 5
while ($true) {
  $log = Join-Path $logs ("worker-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
  $started = Get-Date
  & node --no-warnings $main *>> $log
  $code = $LASTEXITCODE
  Add-Content -Path $log -Value ('{{"ts":"{0}","level":"warn","msg":"worker exited","code":{1}}}' -f (Get-Date).ToUniversalTime().ToString("o"), $code)
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 5 } else { $delay = [Math]::Min(300, $delay * 2) }
  Start-Sleep -Seconds $delay
}
