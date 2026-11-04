<#
.SYNOPSIS
  Writes the GPU telemetry the build runner reports to the platform (Founder V4: VRAM, utilization, GPU name).
  Runs every minute as the scheduled task "CrestmontRunner-GpuTelemetry" (registered by Install-CrestmontRunner.ps1),
  launched through the hidden wscript.exe shim so it never opens a terminal window (BackgroundTask.ps1 explains why
  -WindowStyle Hidden is not enough on its own).

.DESCRIPTION
  The runner lives in a Linux container and cannot query the Windows GPU itself. This script runs
    nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits
  and writes <InstallDir>\state\telemetry\gpu.json, mounted read-only into the runner at /run/crestmont/gpu.json.
  Read-only on the GPU; no network; Windows PowerShell 5.1 and PowerShell 7. ASCII only.

  THE PIPELINE DEFECT THIS FIXES (verified on the build machine)
  -------------------------------------------------------------
  This script used to read nvidia-smi like this:

    $line = & $smi "--query-gpu=..." "--format=csv,noheader,nounits" 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $line) { exit 0 }

  `Select-Object -First 1` stops the pipeline as soon as it has its one object, and since PowerShell 3.0 it does
  that by throwing StopUpstreamCommandsException upstream. When the upstream is a NATIVE command, the process is
  torn down rather than left to exit on its own, and $LASTEXITCODE comes back as -1 even though nvidia-smi ran
  correctly and printed valid data. The guard above then treated that -1 as a failure and exited WITHOUT writing
  gpu.json - so telemetry silently stopped updating while the task still reported success.

  The fix, verified on the build machine (task result 0, gpu.json updated in the same second): never pipe a native
  command into Select-Object. The output is collected into an array first and the first usable row is picked from
  that array, where short-circuiting cannot reach the process.

  Failures are now diagnosable instead of silent. Every outcome is written to <InstallDir>\logs\gpu-telemetry.jsonl,
  and the exit code distinguishes the two kinds of "no telemetry":
    exit 0 - nvidia-smi is not installed. Expected on a machine without an NVIDIA GPU; the dashboard shows
             "not reported", which is correct and not a fault.
    exit 1 - nvidia-smi IS installed but failed, printed nothing, or printed something unusable. That is a real
             fault, so the scheduled task's LastTaskResult shows it. The task carries no restart count, so a
             non-zero result never turns into a retry loop.
  gpu.json is only ever replaced by a complete, validated sample, written to a temporary file and renamed, so the
  runner never reads a half-written or half-valid file.

.PARAMETER NvidiaSmiPath
  Use this nvidia-smi instead of looking for one. Exists so the Windows CI job can drive the script with a stub
  that prints known output and returns a known exit code; nothing on a real machine sets it.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [string]$NvidiaSmiPath = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "BackgroundTask.ps1")

$dir = Join-Path $InstallDir "state\telemetry"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $InstallDir "logs\gpu-telemetry.jsonl"
Invoke-CrestmontLogRotation -Path $log -MaxBytes 2MB -KeepLines 4000

function Get-TelemetryNumber([string]$v) {
  $d = 0.0
  if ([double]::TryParse($v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
  return $null
}

# One sampler at a time. The task already carries -MultipleInstances IgnoreNew; this also covers a copy started by
# hand, so two writers can never interleave on gpu.json and the GPU is never queried twice at once. A sampler that
# finds the lock held does nothing and reports success: the other one is about to write the same sample.
$lock = Enter-CrestmontSingleInstance -Name "gpu-telemetry" -StateDir (Join-Path $InstallDir "state")
if (-not $lock) {
  Write-CrestmontLogLine -Path $log -Level "debug" -Message "another sampler holds the lock; skipping this run"
  exit 0
}
try {
  $smi = $NvidiaSmiPath
  if (-not $smi) { $smi = (Get-Command "nvidia-smi.exe" -ErrorAction SilentlyContinue).Source }
  if (-not $smi) { $candidate = Join-Path $env:SystemRoot "System32\nvidia-smi.exe"; if (Test-Path $candidate) { $smi = $candidate } }
  if (-not $smi) {
    Write-CrestmontLogLine -Path $log -Level "info" -Message "nvidia-smi not found; no GPU telemetry on this machine"
    exit 0
  }
  if (-not (Test-Path $smi)) {
    Write-CrestmontLogLine -Path $log -Level "error" -Message "nvidia-smi path does not exist" -Data @{ smi = $smi }
    exit 1
  }

  # No `| Select-Object -First 1` here: see the header. stderr is folded into the output so a failure can be
  # reported, and under Windows PowerShell 5.1 with ErrorActionPreference Stop native stderr becomes a terminating
  # error, so the preference is relaxed around the call only.
  $query = @("--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits")
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $exit = $null
  try {
    $raw = @(& $smi @query 2>&1 | ForEach-Object { "$_" })
    $exit = $LASTEXITCODE
  } catch {
    Write-CrestmontLogLine -Path $log -Level "error" -Message "nvidia-smi could not be run" -Data @{ smi = $smi; error = "$($_.Exception.Message)" }
    exit 1
  } finally { $ErrorActionPreference = $previous }

  $lines = @($raw | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($exit -ne 0) {
    Write-CrestmontLogLine -Path $log -Level "error" -Message "nvidia-smi failed" -Data @{ smi = $smi; exitCode = $exit; output = (($lines | Select-Object -First 5) -join " | ") }
    exit 1
  }
  if ($lines.Count -eq 0) {
    Write-CrestmontLogLine -Path $log -Level "error" -Message "nvidia-smi printed nothing" -Data @{ smi = $smi; exitCode = $exit }
    exit 1
  }

  # The first row that looks like the five requested fields. Anything else nvidia-smi printed (a driver warning on
  # stderr, for instance) is skipped rather than parsed as data.
  $row = $null
  foreach ($line in $lines) {
    $fields = @($line.Split(",") | ForEach-Object { $_.Trim() })
    if ($fields.Count -lt 5) { continue }
    if ($null -eq (Get-TelemetryNumber $fields[2])) { continue }
    if (-not $fields[0]) { continue }
    $row = $fields
    break
  }
  if (-not $row) {
    Write-CrestmontLogLine -Path $log -Level "error" -Message "nvidia-smi output had no usable GPU row" -Data @{ smi = $smi; lineCount = $lines.Count; first = $lines[0] }
    exit 1
  }

  # Schema unchanged (crestmont GPU telemetry as the runner and the GPU workers page already read it). memoryUsedMb
  # and utilizationPercent stay nullable: some GPUs report [N/A] for them, and a null is honest where a zero would
  # be a guess. memoryTotalMb and name are required, and were validated when the row was chosen.
  $sample = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    name = $row[0]
    driver = $row[1]
    memoryTotalMb = Get-TelemetryNumber $row[2]
    memoryUsedMb = Get-TelemetryNumber $row[3]
    utilizationPercent = Get-TelemetryNumber $row[4]
  }
  $missing = @(@("memoryUsedMb", "utilizationPercent") | Where-Object { $null -eq $sample[$_] })
  if ($missing.Count) { Write-CrestmontLogLine -Path $log -Level "warn" -Message "GPU reported no value for some fields; written as null" -Data @{ fields = ($missing -join ",") } }

  # Write atomically (temp file, then rename) so the runner never reads half a file.
  $tmp = Join-Path $dir "gpu.json.tmp"
  [IO.File]::WriteAllText($tmp, ($sample | ConvertTo-Json -Compress))
  Move-Item -Force $tmp (Join-Path $dir "gpu.json")
  Write-CrestmontLogLine -Path $log -Level "info" -Message "gpu.json updated" -Data @{ name = $sample.name; memoryTotalMb = $sample.memoryTotalMb; utilizationPercent = $sample.utilizationPercent }
  exit 0
}
finally { Exit-CrestmontSingleInstance -Handle $lock }
