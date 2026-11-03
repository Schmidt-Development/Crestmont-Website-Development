<#
.SYNOPSIS
  Writes the GPU telemetry the build runner reports to the platform (Founder V4: VRAM, utilization, GPU name).
  Runs every minute as the scheduled task "CrestmontRunner-GpuTelemetry" (registered by Install-CrestmontRunner.ps1),
  in session 0 so it never opens a terminal window: see BackgroundTask.ps1 for why -WindowStyle Hidden is not enough.

.DESCRIPTION
  The runner lives in a Linux container and cannot query the Windows GPU itself. This script runs
    nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits
  and writes <InstallDir>\state\telemetry\gpu.json, mounted read-only into the runner at /run/crestmont/gpu.json.
  If nvidia-smi is missing or fails, no file is written: the dashboard then shows "not reported" (never a guess).
  Read-only on the GPU; no network; Windows PowerShell 5.1 and PowerShell 7. ASCII only.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner"
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "BackgroundTask.ps1")
$dir = Join-Path $InstallDir "state\telemetry"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# One sampler at a time. The task already carries -MultipleInstances IgnoreNew; this also covers a hand-run copy,
# so two writers can never interleave on gpu.json. Quietly does nothing if another sampler holds the lock.
function Get-TelemetryNumber([string]$v) { $d = 0.0; if ([double]::TryParse($v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d } return $null }
$lock = Enter-CrestmontSingleInstance -Name "gpu-telemetry" -StateDir (Join-Path $InstallDir "state")
if (-not $lock) { exit 0 }
try {
  $smi = (Get-Command "nvidia-smi.exe" -ErrorAction SilentlyContinue).Source
  if (-not $smi) { $candidate = Join-Path $env:SystemRoot "System32\nvidia-smi.exe"; if (Test-Path $candidate) { $smi = $candidate } }
  if (-not $smi) { exit 0 }
  $line = & $smi "--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu" "--format=csv,noheader,nounits" 2>$null | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or -not $line) { exit 0 }
  $p = @("$line".Split(",") | ForEach-Object { $_.Trim() })
  if ($p.Count -lt 5) { exit 0 }
  $sample = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    name = $p[0]
    driver = $p[1]
    memoryTotalMb = Get-TelemetryNumber $p[2]
    memoryUsedMb = Get-TelemetryNumber $p[3]
    utilizationPercent = Get-TelemetryNumber $p[4]
  }
  # Write atomically (temp file, then rename) so the runner never reads half a file.
  $tmp = Join-Path $dir "gpu.json.tmp"
  [IO.File]::WriteAllText($tmp, ($sample | ConvertTo-Json -Compress))
  Move-Item -Force $tmp (Join-Path $dir "gpu.json")
}
finally { Exit-CrestmontSingleInstance -Handle $lock }
