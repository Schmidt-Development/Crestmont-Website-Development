<#
.SYNOPSIS
  Finds whatever is spawning terminal windows on this machine, says exactly what it is, and converts the Crestmont
  background jobs to windowless execution. Changes nothing with -DiagnoseOnly.

.DESCRIPTION
  WHAT CAUSES THE POPUPS
  powershell.exe is a console-subsystem program. A scheduled task that runs it with LogonType Interactive (the
  default when Register-ScheduledTask is given no principal) executes inside the signed-in desktop session, so
  Windows creates and SHOWS a console window every time the task starts. "-WindowStyle Hidden" is parsed by the
  PowerShell host after that window already exists, so it cannot prevent it. Put a repeating trigger on such a task
  and it pops a terminal on every repetition - once a minute, in the case of the GPU sampler this kit used to
  register.

  WHAT THIS SCRIPT DOES
    1. Reports every scheduled task on this machine that is built that way - not only Crestmont's - with its
       trigger repetition, so the cause is identified rather than guessed at.
    2. Reports the console-host processes running right now with their parent process. A powershell.exe whose
       parent is svchost.exe was started by the Task Scheduler service: that is the fingerprint of a task popping
       windows, as opposed to something you started yourself.
    3. Re-registers ONLY the Crestmont tasks that the check says can open a window, through
       Register-CrestmontBackgroundTask: session 0 where the job needs no desktop, the hidden launcher where it
       does. A task that is already windowless is left exactly as it is.
    4. Reads every task back and reports whether it is now windowless.

  WHAT IT DOES NOT TOUCH
  Nothing is deleted. Queues, build checkpoints, the DuckDB database, logs, settings.env, DPAPI secrets, Docker
  volumes, containers, images, Docker Desktop and Ollama are all left alone, and so is every scheduled task that
  does not belong to Crestmont (those are only reported). A research task that already runs with a stored password
  is already windowless and is never re-registered, so its stored password cannot be lost.

.PARAMETER DiagnoseOnly
  Report and exit. Nothing is stopped, registered or changed.

.PARAMETER KillRunaway
  Also end the Crestmont console-host processes that are running right now, so the popups stop before the next
  logon instead of after it. Only processes whose command line names a Crestmont script are ended; the containers,
  the node worker's in-flight work, Docker Desktop and Ollama are not touched. An interrupted build is requeued
  with its checkpoint by the platform, and an interrupted research run resumes from its queue.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Repair-WindowsAutomation.ps1 -DiagnoseOnly
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Repair-WindowsAutomation.ps1 -KillRunaway
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [string]$ResearchInstallDir = "C:\CrestmontResearch",
  [switch]$DiagnoseOnly,
  [switch]$KillRunaway
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "BackgroundTask.ps1")

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "    XX  $m" -ForegroundColor Red }
function Note([string]$m) { Write-Host "    --  $m" }

$crestmontTasks = @("CrestmontRunner-Start", "CrestmontRunner-Watchdog", "CrestmontRunner-GpuTelemetry", "CrestmontResearch-Worker")
$consoleHost = @("powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe", "cscript.exe")

# ---- 1. Scheduled tasks that are built to show a window ----------------------------------------------------------
Say "Scheduled tasks that run a console program on the desktop (LogonType Interactive) - these are what pop windows"
$offenders = New-Object System.Collections.ArrayList
foreach ($task in (Get-ScheduledTask -ErrorAction SilentlyContinue)) {
  $logon = "$($task.Principal.LogonType)"
  if ($logon -ne "Interactive") { continue }
  foreach ($action in @($task.Actions)) {
    $exe = [IO.Path]::GetFileName("$($action.Execute)")
    if ($consoleHost -notcontains $exe) { continue }
    $repeat = @($task.Triggers | ForEach-Object { if ($_.Repetition -and $_.Repetition.Interval) { "$($_.Repetition.Interval)" } }) -join ", "
    $info = [ordered]@{
      TaskName = $task.TaskName
      TaskPath = $task.TaskPath
      State = "$($task.State)"
      Execute = "$($action.Execute)"
      Argument = "$($action.Arguments)"
      Repetition = $(if ($repeat) { $repeat } else { "(none)" })
      MultipleInstances = "$($task.Settings.MultipleInstances)"
      Crestmont = ($crestmontTasks -contains $task.TaskName)
    }
    [void]$offenders.Add((New-Object PSObject -Property $info))
  }
}
if ($offenders.Count -eq 0) { Ok "none found" }
else {
  $offenders | Format-Table TaskName, State, Repetition, MultipleInstances, Crestmont, Execute -AutoSize | Out-String -Width 400 | Write-Host
  foreach ($o in ($offenders | Where-Object { $_.Repetition -ne "(none)" })) {
    Bad ("{0} repeats every {1} and runs {2} on the desktop: one terminal window per repetition" -f $o.TaskName, $o.Repetition, [IO.Path]::GetFileName($o.Execute))
  }
  foreach ($o in ($offenders | Where-Object { -not $_.Crestmont })) {
    Note ("{0}{1} is NOT a Crestmont task: reported only, nothing here changes it" -f $o.TaskPath, $o.TaskName)
  }
}

# ---- 2. What is running right now, and who started it ------------------------------------------------------------
Say "Console-host processes running now (a parent of svchost.exe means the Task Scheduler service started it)"
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$byId = @{}
foreach ($p in $all) { $byId["$($p.ProcessId)"] = $p }
$live = New-Object System.Collections.ArrayList
foreach ($p in $all) {
  if ($consoleHost -notcontains "$($p.Name)") { continue }
  $parent = $byId["$($p.ParentProcessId)"]
  $cmd = "$($p.CommandLine)"
  [void]$live.Add((New-Object PSObject -Property ([ordered]@{
    Pid = $p.ProcessId
    Name = "$($p.Name)"
    Parent = $(if ($parent) { "$($parent.Name) ($($p.ParentProcessId))" } else { "(gone) ($($p.ParentProcessId))" })
    Started = $p.CreationDate
    Crestmont = ($cmd -match "Crestmont")
    CommandLine = $cmd
  })))
}
if ($live.Count -eq 0) { Ok "none running" }
else { $live | Format-Table Pid, Name, Parent, Started, Crestmont -AutoSize | Out-String -Width 400 | Write-Host }
$crestmontLive = @($live | Where-Object { $_.Crestmont })
foreach ($p in $crestmontLive) { Note ("pid {0}: {1}" -f $p.Pid, $p.CommandLine) }

# ---- 3. How each Crestmont task stands ---------------------------------------------------------------------------
Say "Crestmont tasks: can each one open a terminal window?"
$verdicts = @{}
foreach ($t in $crestmontTasks) {
  $v = Test-CrestmontTaskIsWindowless -TaskName $t
  $verdicts[$t] = $v
  if ("$($v.Reason)" -eq "not registered") { Note "$t is not registered on this machine" }
  elseif ($v.Ok) { Ok "$t is windowless: $($v.Reason)" }
  else { Bad "$t WILL open a terminal window: $($v.Reason)" }
}

if ($DiagnoseOnly) {
  Say "-DiagnoseOnly: nothing was changed. Re-run without it to convert the Crestmont tasks that need it."
  exit 0
}

# ---- 4. Stop the runaway -----------------------------------------------------------------------------------------
$toFix = @($crestmontTasks | Where-Object { $verdicts[$_] -and -not $verdicts[$_].Ok -and "$($verdicts[$_].Reason)" -ne "not registered" })
if ($toFix.Count -eq 0) { Say "Every registered Crestmont task is already windowless; nothing to convert." }
else {
  Say ("Converting {0}: {1}" -f $toFix.Count, ($toFix -join ", "))
  foreach ($t in $toFix) {
    if ($PSCmdlet.ShouldProcess($t, "Disable and stop while it is re-registered")) {
      Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      Disable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null
      Note "stopped and disabled $t"
    }
  }
  if ($KillRunaway -and $crestmontLive.Count) {
    foreach ($p in $crestmontLive) {
      if ($p.Pid -eq $PID) { continue }
      if ($PSCmdlet.ShouldProcess("pid $($p.Pid) ($($p.Name))", "End this Crestmont console-host process")) {
        Stop-Process -Id $p.Pid -Force -ErrorAction SilentlyContinue
        Note "ended pid $($p.Pid) ($($p.Name))"
      }
    }
  } elseif ($crestmontLive.Count) {
    Note "$($crestmontLive.Count) Crestmont console-host process(es) are still running; add -KillRunaway to end them now, or sign out and back in"
  }

  # ---- 5. Re-register, windowless ------------------------------------------------------------------------------
  # The install mode decides how the runner start task treats Ollama; an unknown mode never starts a shared Ollama.
  $mode = $null
  $modeFile = Join-Path $InstallDir "state\install.json"
  if (Test-Path $modeFile) { try { $mode = Get-Content $modeFile -Raw | ConvertFrom-Json } catch { $mode = $null } }
  $startArgument = @("-InstallDir", $InstallDir)
  if ($mode -and $mode.ollamaInDocker) { $startArgument += "-OllamaInDocker" } elseif (-not $mode -or $mode.preserveOllamaConfig) { $startArgument += "-NoOllamaStart" }
  $user = "$env:USERDOMAIN\$env:USERNAME"

  if ($toFix -contains "CrestmontRunner-Start") {
    $r = Register-CrestmontBackgroundTask -TaskName "CrestmontRunner-Start" -InstallDir $InstallDir `
      -ScriptPath (Join-Path $InstallDir "Start-CrestmontRunner.ps1") -ScriptArgument $startArgument `
      -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -DesktopSession `
      -Settings (Get-CrestmontBackgroundTaskSetting -RestartCount 3 -RestartIntervalMinutes 5 -ExecutionTimeLimitMinutes 60)
    Ok "CrestmontRunner-Start re-registered ($($r.Strategy)), at logon only - the repeating trigger moves to the watchdog below"
  }
  if (($toFix -contains "CrestmontRunner-Watchdog") -or ($toFix -contains "CrestmontRunner-Start")) {
    $r = Register-CrestmontBackgroundTask -TaskName "CrestmontRunner-Watchdog" -InstallDir $InstallDir `
      -ScriptPath (Join-Path $InstallDir "Start-CrestmontRunner.ps1") -ScriptArgument ($startArgument + @("-NoGuiLaunch", "-WaitMinutes", "1")) `
      -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)) `
      -Settings (Get-CrestmontBackgroundTaskSetting -RestartCount 1 -RestartIntervalMinutes 5 -ExecutionTimeLimitMinutes 15)
    Ok "CrestmontRunner-Watchdog re-registered ($($r.Strategy)), every 5 minutes in session 0, no GUI launches"
  }
  if ($toFix -contains "CrestmontRunner-GpuTelemetry") {
    $r = Register-CrestmontBackgroundTask -TaskName "CrestmontRunner-GpuTelemetry" -InstallDir $InstallDir `
      -ScriptPath (Join-Path $InstallDir "Write-GpuTelemetry.ps1") -ScriptArgument @("-InstallDir", $InstallDir) `
      -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)) `
      -Settings (Get-CrestmontBackgroundTaskSetting -RestartCount 0 -ExecutionTimeLimitMinutes 2)
    Ok "CrestmontRunner-GpuTelemetry re-registered ($($r.Strategy)), every minute in session 0 - this was the once-a-minute popup"
  }
  if ($toFix -contains "CrestmontResearch-Worker") {
    # Only reachable when the task is NOT already password-logon (that is windowless, so it never lands in $toFix),
    # which means it has no stored password to lose. The worker's secret is DPAPI-protected for this user, so it
    # must stay in this user's session; the hidden launcher keeps it windowless.
    $triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
    $r = Register-CrestmontBackgroundTask -TaskName "CrestmontResearch-Worker" -InstallDir $ResearchInstallDir `
      -ScriptPath (Join-Path $ResearchInstallDir "Start-ResearchWorker.ps1") -ScriptArgument @("-InstallDir", $ResearchInstallDir) `
      -Trigger $triggers -DesktopSession `
      -Settings (Get-CrestmontBackgroundTaskSetting -RestartCount 4 -RestartIntervalMinutes 5 -RunIndefinitely)
    Ok "CrestmontResearch-Worker re-registered ($($r.Strategy))"
    Note "for continuous operation with nobody signed in, re-run Install-ResearchWorker.ps1 -RunWhenLoggedOff (it needs the account password, which this script does not ask for)"
  }

  foreach ($t in @("CrestmontRunner-Start", "CrestmontRunner-Watchdog", "CrestmontRunner-GpuTelemetry", "CrestmontResearch-Worker")) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null }
  }
}

# ---- 6. Verify ---------------------------------------------------------------------------------------------------
Say "Verification"
$failed = 0
foreach ($t in $crestmontTasks) {
  $v = Test-CrestmontTaskIsWindowless -TaskName $t
  if ("$($v.Reason)" -eq "not registered") { Note "$t not registered (nothing to verify)"; continue }
  # ${t} is delimited on purpose: "$t:" parses as a scoped variable reference (like $env:X), not as the variable
  # followed by a colon.
  if ($v.Ok) { Ok "${t}: $($v.Reason); MultipleInstances=$($v.MultipleInstances)" }
  else { Bad "${t}: $($v.Reason)"; $failed++ }
}
Write-Host ""
if ($failed) {
  Write-Host "$failed Crestmont task(s) can still open a terminal window. The report above says why." -ForegroundColor Red
  exit 1
}
Write-Host "Every registered Crestmont task runs without a terminal window. Nothing was deleted: queues, checkpoints, logs, secrets, containers and volumes are untouched." -ForegroundColor Green
Write-Host "Watch it for a few minutes with:  Get-ScheduledTaskInfo -TaskName CrestmontRunner-GpuTelemetry" -ForegroundColor Green
exit 0
