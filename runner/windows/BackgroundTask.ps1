<#
.SYNOPSIS
  Windowless background execution for the Crestmont Windows kit: scheduled tasks that never open a terminal window,
  single-instance locking, bounded retries with exponential backoff, resource limits and JSON-lines logging.
  Dot-sourced by Install-CrestmontRunner.ps1, Install-ResearchWorker.ps1, Start-ResearchWorker.ps1,
  Write-GpuTelemetry.ps1 and Repair-WindowsAutomation.ps1.

.DESCRIPTION
  WHY THIS FILE EXISTS: the terminal-popup defect it fixes
  -------------------------------------------------------
  powershell.exe is a CONSOLE-subsystem executable. When Task Scheduler starts one inside an interactive logon
  session - which is what LogonType Interactive means, and what Register-ScheduledTask uses by default when it is
  given no -User/-Password principal - the OS creates a console window for it in that session and shows it.
  "-WindowStyle Hidden" is an argument to the PowerShell *host*: it is parsed after the console window already
  exists, so it cannot stop the window appearing. A task that repeats therefore pops a terminal on every
  repetition, which is what made the desktop unusable (one task here repeated every single minute).

  THE FIX: a hidden launcher. wscript.exe is a GUI-subsystem host, so it owns no console at all; the shim it runs
  calls WshShell.Run with window style 0, which creates the child's console ALREADY HIDDEN - there is no window and
  no flash, as opposed to hiding a window that has already been shown. The shim passes bWaitOnReturn = True so the
  task's lifetime still matches the work, which is what keeps -MultipleInstances IgnoreNew and -ExecutionTimeLimit
  meaningful (a fire-and-forget launcher would make the task "finish" instantly and defeat both).

  This is the configuration verified working on the build machine: both runner tasks launch through
  C:\Windows\System32\wscript.exe, keeping their original triggers, arguments and settings, and the popups stopped.
  The task keeps the user's own logon session, which is what Docker Desktop and the Ollama tray app need and what
  DPAPI needs to unprotect the research worker's secret.

  The one exception is a task registered with -Credential (the research worker's -RunWhenLoggedOff, unchanged by
  this work): the account's stored password runs it in session 0, where there is no desktop for a window to appear
  on in the first place.

  An S4U principal also runs in session 0 and was tried here, but no job in this kit can use it - the GUI programs
  have no desktop there and the user's DPAPI master key is unavailable - so it was removed rather than left as an
  untested second path. Test-CrestmontTaskIsWindowless still recognises S4U and ServiceAccount as windowless, so a
  task registered that way by hand is reported correctly rather than flagged.

  Everything registered here is also single-instance (-MultipleInstances IgnoreNew, enforced below) and carries a
  bounded restart count, so a failing job can never turn into an unbounded spawn loop.

  Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only (5.1 reads BOM-less files as ANSI, where non-ASCII
  punctuation turns into quote characters and breaks parsing).
#>

$script:CrestmontShimName = "Start-CrestmontHidden.vbs"
# $env:SystemRoot is not set when these functions are dot-sourced under PowerShell 7 on Linux, which is how CI
# unit-tests the pure ones (runner/test/background-task.test.ts). Only the Windows paths below would be wrong there,
# and nothing on Linux uses them.
$script:CrestmontSystemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
$script:CrestmontPowerShellExe = "$script:CrestmontSystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$script:CrestmontWScriptExe = "$script:CrestmontSystemRoot\System32\wscript.exe"

# The launcher. Kept here (not in a separate file) so Register-CrestmontBackgroundTask can write it wherever it is
# needed and Test-WindowsScripts.ps1 / runner/test/windows.test.ts can assert its contents.
$script:CrestmontShimSource = @(
  "' Crestmont windowless launcher. Written by Register-CrestmontBackgroundTask; do not edit by hand.",
  "'",
  "' wscript.exe is a GUI-subsystem host, so this process owns no console. WshShell.Run with window style 0",
  "' creates the child's console already hidden: no terminal window appears, not even a flash. bWaitOnReturn is",
  "' True so the scheduled task stays alive as long as the work does, which is what makes -MultipleInstances",
  "' IgnoreNew and -ExecutionTimeLimit effective. The command line is read from tasks\<job>.cmdline next to this",
  "' script rather than taken from the command line, so no quoting is lost on the way through Task Scheduler.",
  "Option Explicit",
  "Dim job, base, file, fso, stream, command, shell, re",
  "If WScript.Arguments.Count <> 1 Then WScript.Quit 2",
  "job = WScript.Arguments(0)",
  "Set re = New RegExp",
  "re.Pattern = ""^[A-Za-z0-9._-]+$""",
  "If Not re.Test(job) Then WScript.Quit 3",
  "base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, ""\""))",
  "file = base & ""tasks\"" & job & "".cmdline""",
  "Set fso = CreateObject(""Scripting.FileSystemObject"")",
  "If Not fso.FileExists(file) Then WScript.Quit 4",
  "Set stream = fso.OpenTextFile(file, 1)",
  "command = Trim(stream.ReadLine())",
  "stream.Close",
  "If Len(command) = 0 Then WScript.Quit 5",
  "Set shell = CreateObject(""WScript.Shell"")",
  "WScript.Quit shell.Run(command, 0, True)"
)

function Test-CrestmontHiddenShimHost {
  <# .SYNOPSIS Whether wscript.exe is present, i.e. whether the hidden launcher can be used for desktop tasks. #>
  return (Test-Path $script:CrestmontWScriptExe)
}

function Write-CrestmontHiddenShim {
  <# .SYNOPSIS Writes the windowless launcher into $InstallDir and returns its full path. #>
  param([Parameter(Mandatory = $true)][string]$InstallDir)
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "tasks") | Out-Null
  $path = Join-Path $InstallDir $script:CrestmontShimName
  [IO.File]::WriteAllText($path, (($script:CrestmontShimSource -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))
  return $path
}

function Get-CrestmontQuotedArgument {
  <#
  .SYNOPSIS
    Quotes one command-line argument for a Windows command line, by the CommandLineToArgvW rules.
  .DESCRIPTION
    Both consumers here - the scheduled task's -Argument string, and the command line the launcher hands to
    WshShell.Run - end up in CreateProcess, which parses by those rules. Escaping only the quotes is not enough:
    inside a quoted argument a run of backslashes that meets a quote is itself an escape, so a Windows path ending
    in a backslash ("C:\Crestmont Runner\") would have its trailing backslash escape the CLOSING quote and swallow
    whatever came after it. Each run of backslashes that precedes a quote - including the closing one - is therefore
    doubled, and each embedded quote escaped after that doubling. Mirrored by background-task.ts (quoteArgument).
  #>
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $out = New-Object System.Text.StringBuilder
  [void]$out.Append('"')
  $i = 0
  while ($i -lt $Value.Length) {
    $slashes = 0
    while ($i -lt $Value.Length -and $Value[$i] -eq [char]'\') { $slashes++; $i++ }
    if ($i -ge $Value.Length) {
      # Backslashes right before the closing quote: double them so they stay literal.
      [void]$out.Append('\' * ($slashes * 2))
      break
    }
    if ($Value[$i] -eq [char]'"') { [void]$out.Append('\' * ($slashes * 2 + 1)); [void]$out.Append('"') }
    else { [void]$out.Append('\' * $slashes); [void]$out.Append($Value[$i]) }
    $i++
  }
  [void]$out.Append('"')
  return $out.ToString()
}

function Get-CrestmontHiddenArgument {
  <#
  .SYNOPSIS
    The argument string that runs a PowerShell script non-interactively, with no profile and no window.
    -WindowStyle Hidden is kept as a second line of defence; it is NOT what makes the window go away (see the
    file header) - the principal or the launcher is.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$ScriptArgument = @()
  )
  $parts = New-Object System.Collections.ArrayList
  foreach ($flag in @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File")) { [void]$parts.Add($flag) }
  [void]$parts.Add((Get-CrestmontQuotedArgument $ScriptPath))
  foreach ($a in $ScriptArgument) { [void]$parts.Add((Get-CrestmontQuotedArgument $a)) }
  return ($parts -join " ")
}

function Get-CrestmontHiddenCommandLine {
  <# .SYNOPSIS Get-CrestmontHiddenArgument with the PowerShell host in front: a complete command line. #>
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$ScriptArgument = @()
  )
  return ((Get-CrestmontQuotedArgument $script:CrestmontPowerShellExe) + " " + (Get-CrestmontHiddenArgument -ScriptPath $ScriptPath -ScriptArgument $ScriptArgument))
}

function Write-CrestmontTaskCommandLine {
  <# .SYNOPSIS Stores a job's command line in <InstallDir>\tasks\<Job>.cmdline for the launcher to read. #>
  param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Job,
    [Parameter(Mandatory = $true)][string]$CommandLine
  )
  $dir = Join-Path $InstallDir "tasks"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir ($Job + ".cmdline")
  [IO.File]::WriteAllText($path, ($CommandLine + "`r`n"), (New-Object System.Text.ASCIIEncoding))
  return $path
}

function Get-CrestmontBackgroundTaskSetting {
  <#
  .SYNOPSIS
    Default settings for a background task: single instance, bounded restarts, and no indefinite run unless asked.
  .PARAMETER RestartCount
    Bounded on purpose. Task Scheduler's own restart loop and a script-level retry loop multiply, so this stays
    small and the script-level budget (Test-CrestmontRestartBudget) does the fine-grained work.
  #>
  param(
    [ValidateRange(0, 10)][int]$RestartCount = 3,
    [ValidateRange(1, 1440)][int]$RestartIntervalMinutes = 5,
    [ValidateRange(1, 4320)][int]$ExecutionTimeLimitMinutes = 60,
    [switch]$RunIndefinitely,
    # Opt-in, because it changes when a task runs: a missed run is started late instead of skipped. Only the
    # research worker shipped with it, and each task here keeps the settings it already had.
    [switch]$StartWhenAvailable
  )
  # A zero time limit means "no limit" to Task Scheduler, so it is only ever used behind -RunIndefinitely.
  $limit = if ($RunIndefinitely) { [TimeSpan]::Zero } else { New-TimeSpan -Minutes $ExecutionTimeLimitMinutes }
  $option = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    MultipleInstances = "IgnoreNew"
    ExecutionTimeLimit = $limit
  }
  if ($StartWhenAvailable) { $option["StartWhenAvailable"] = $true }
  # Task Scheduler rejects a restart interval without a restart count, so the pair is passed only together.
  if ($RestartCount -gt 0) {
    $option["RestartCount"] = $RestartCount
    $option["RestartInterval"] = (New-TimeSpan -Minutes $RestartIntervalMinutes)
  }
  return (New-ScheduledTaskSettingsSet @option)
}

function Assert-CrestmontTaskPrerequisite {
  <#
  .SYNOPSIS
    Checks everything a task needs BEFORE any task is touched, so a half-upgraded install is never registered.
  .DESCRIPTION
    An installer that registered a task action pointing at a script it had not copied yet, or at a launcher the
    machine cannot run, would replace a working task with a broken one. Both are checked here and both throw, which
    happens before Register-CrestmontBackgroundTask changes anything.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [switch]$RequireShimHost
  )
  if (-not (Test-Path $ScriptPath)) {
    throw "Refusing to register a task for '$ScriptPath': the script is not there. Copy the scripts into the install folder before registering tasks."
  }
  if ($RequireShimHost -and -not (Test-CrestmontHiddenShimHost)) {
    throw "Refusing to register a task: the hidden launcher needs $($script:CrestmontWScriptExe), which is missing. Enable the Windows Script Host feature, or register the task with -Credential so it runs in session 0."
  }
}

function Export-CrestmontTaskBackup {
  <#
  .SYNOPSIS
    Saves a registered task's definition as XML and returns the file path, or $null when the task is not registered.
  .DESCRIPTION
    The rollback path for scheduled-task configuration. Written next to the install as
    state\task-backup\<name>-<utc>.xml, plus <name>.last.xml as the one a rollback reaches for. Task XML declares
    UTF-16, so it is written and read as Unicode.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$BackupDir
  )
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return $null }
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $xml = Export-ScheduledTask -TaskName $TaskName
  $path = Join-Path $BackupDir ("{0}-{1}.xml" -f $TaskName, (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"))
  Set-Content -Path $path -Value $xml -Encoding Unicode
  Set-Content -Path (Join-Path $BackupDir ($TaskName + ".last.xml")) -Value $xml -Encoding Unicode
  return $path
}

function Restore-CrestmontTaskBackup {
  <#
  .SYNOPSIS
    Puts a task definition back from an XML backup. $true when restored, $false when it could not be.
  .DESCRIPTION
    Used to undo a failed registration and by Repair-WindowsAutomation.ps1 -RestoreTasks. A task that ran with a
    stored password cannot be restored from XML alone (the password is not in the XML); that case says so rather
    than failing quietly, and the fix is to re-run the installer with -RunWhenLoggedOff.
  #>
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not (Test-Path $Path)) { return $false }
  if (-not $PSCmdlet.ShouldProcess($TaskName, "Restore the scheduled task from $Path")) { return $false }
  try {
    $xml = Get-Content -Path $Path -Raw -Encoding Unicode
    Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
    return $true
  } catch {
    Write-Warning ("Could not restore '{0}' from {1}: {2}" -f $TaskName, $Path, $_.Exception.Message)
    return $false
  }
}

function Register-CrestmontBackgroundTask {
  <#
  .SYNOPSIS
    Registers a scheduled task that cannot open a terminal window, and returns what was registered.

  .DESCRIPTION
    Two launch paths, and nothing else:

      HiddenShim (the default) - LogonType Interactive, action wscript.exe + Start-CrestmontHidden.vbs. This is the
      configuration verified working on the build machine: the task keeps the user's own session, which Docker
      Desktop and the Ollama tray app need and which DPAPI needs to unprotect the research secret, and the shim
      creates the child's console already hidden so no window appears.

      Session0Password (-Credential) - the account's stored password, so the task runs with nobody signed in. Only
      the research worker's -RunWhenLoggedOff uses it, exactly as it did before this change.

    An S4U principal was tried and removed: it runs in session 0, where the GUI programs have no desktop and the
    user's DPAPI master key is unavailable, so no job in this kit can use it. One launch path, the one that is
    verified, is better than two.

    Safety: prerequisites are checked before anything is touched, the existing definition is exported to XML first,
    and a failed registration puts that definition back - so a re-run can never leave a working machine with a
    broken task.

  .PARAMETER Credential
    Register the task to run whether or not the user is signed in, with the account's stored password.

  .PARAMETER NoBackup
    Skip the XML backup. For a task that is not registered yet there is nothing to back up anyway; this is for
    callers that manage their own rollback.

  .OUTPUTS
    An object with TaskName, Strategy (HiddenShim / Session0Password), LogonType, Execute, Argument and Backup
    (the XML path, or $null), so the installers can report it and Repair-WindowsAutomation.ps1 can verify it.
  #>
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$ScriptArgument = @(),
    [Parameter(Mandatory = $true)]$Trigger,
    $Settings,
    [System.Management.Automation.PSCredential]$Credential,
    [switch]$NoBackup
  )
  if (-not $Settings) { $Settings = Get-CrestmontBackgroundTaskSetting }
  # Enforced, never assumed: without this a slow run plus a repeating trigger stacks instances on top of each other.
  if ("$($Settings.MultipleInstances)" -ne "IgnoreNew") {
    throw "Task '$TaskName' must be registered with -MultipleInstances IgnoreNew (got '$($Settings.MultipleInstances)'): duplicate launches are what this kit exists to prevent."
  }
  # Before anything is touched.
  Assert-CrestmontTaskPrerequisite -ScriptPath $ScriptPath -RequireShimHost:(-not $Credential)

  $user = "$env:USERDOMAIN\$env:USERNAME"
  $argument = Get-CrestmontHiddenArgument -ScriptPath $ScriptPath -ScriptArgument $ScriptArgument
  $cmdline = (Get-CrestmontQuotedArgument $script:CrestmontPowerShellExe) + " " + $argument
  if (-not $PSCmdlet.ShouldProcess($TaskName, "Register windowless scheduled task")) { return $null }

  $backup = $null
  if (-not $NoBackup) { $backup = Export-CrestmontTaskBackup -TaskName $TaskName -BackupDir (Join-Path $InstallDir "state\task-backup") }
  $registered = $null
  try {
    if ($Credential) {
      # Session 0 with the stored password: no desktop, so no window; DPAPI user keys are available.
      $action = New-ScheduledTaskAction -Execute $script:CrestmontPowerShellExe -Argument $argument
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Credential.Password)
      try {
        $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $Trigger -Settings $Settings -User $Credential.UserName -Password $pw -RunLevel Limited -Force | Out-Null
      } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); Remove-Variable pw -ErrorAction SilentlyContinue }
      $registered = [ordered]@{ Strategy = "Session0Password"; LogonType = "Password"; Execute = $script:CrestmontPowerShellExe; Argument = $action.Arguments }
    }
    else {
      # The verified path: the user's own session, launched through the hidden shim so no window appears.
      [void](Write-CrestmontHiddenShim -InstallDir $InstallDir)
      [void](Write-CrestmontTaskCommandLine -InstallDir $InstallDir -Job $TaskName -CommandLine $cmdline)
      $shim = Join-Path $InstallDir $script:CrestmontShimName
      $action = New-ScheduledTaskAction -Execute $script:CrestmontWScriptExe -Argument ((Get-CrestmontQuotedArgument $shim) + " " + (Get-CrestmontQuotedArgument $TaskName))
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $Trigger -Settings $Settings -Principal $principal -Force | Out-Null
      $registered = [ordered]@{ Strategy = "HiddenShim"; LogonType = "Interactive"; Execute = $script:CrestmontWScriptExe; Argument = $action.Arguments }
    }
  } catch {
    # Put the working definition back rather than leaving a half-registered task behind.
    if ($backup) {
      if (Restore-CrestmontTaskBackup -TaskName $TaskName -Path $backup) { Write-Warning "Registering '$TaskName' failed; its previous definition was restored from $backup." }
      else { Write-Warning "Registering '$TaskName' failed and its previous definition could NOT be restored. The backup is at $backup." }
    }
    throw
  }
  $registered["TaskName"] = $TaskName
  $registered["Backup"] = $backup
  return (New-Object PSObject -Property $registered)
}

function Test-CrestmontTaskIsWindowless {
  <#
  .SYNOPSIS
    Verifies a registered task cannot open a terminal window: either it runs in session 0, or its action is the
    hidden launcher. Returns an object with Ok plus the reason, for Repair-WindowsAutomation.ps1 and for operators.
  #>
  param([Parameter(Mandatory = $true)][string]$TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return (New-Object PSObject -Property ([ordered]@{ TaskName = $TaskName; Ok = $false; Reason = "not registered" })) }
  $logon = "$($task.Principal.LogonType)"
  $execs = @($task.Actions | ForEach-Object { "$($_.Execute)" })
  $session0 = @("Password", "S4U", "ServiceAccount") -contains $logon
  $shimOnly = ($execs.Count -gt 0) -and -not ($execs | Where-Object { $_ -notmatch "wscript\.exe\s*$" })
  $multi = "$($task.Settings.MultipleInstances)"
  $ok = ($session0 -or $shimOnly) -and ($multi -eq "IgnoreNew")
  $reason = if ($session0) { "runs in session 0 (LogonType $logon)" } elseif ($shimOnly) { "interactive, launched through the hidden shim" } else { "LogonType $logon runs a console host ($($execs -join ', ')) on the desktop: a terminal window will appear" }
  if ($multi -ne "IgnoreNew") { $reason = $reason + "; MultipleInstances is '$multi', not IgnoreNew" }
  return (New-Object PSObject -Property ([ordered]@{ TaskName = $TaskName; Ok = $ok; LogonType = $logon; Execute = ($execs -join ", "); MultipleInstances = $multi; Reason = $reason }))
}

function Enter-CrestmontSingleInstance {
  <#
  .SYNOPSIS
    Takes the single-instance lock for $Name, or returns $null when another instance already holds it.
  .DESCRIPTION
    An exclusive FileShare::None handle under <StateDir>\locks. The OS closes the handle when the process ends, so
    the lock is released even after a crash or a kill - no stale lock file to clean up by hand. -MultipleInstances
    IgnoreNew only stops Task Scheduler starting a second copy; this also stops a hand-run copy from racing the
    scheduled one over the same queue, database or workspace.
  #>
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Name,
    [Parameter(Mandatory = $true)][string]$StateDir
  )
  $dir = Join-Path $StateDir "locks"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir ($Name + ".lock")
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    return $null
  }
  $text = "{0} pid={1} host={2}" -f (Get-Date).ToUniversalTime().ToString("o"), $PID, $env:COMPUTERNAME
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($text)
  $fs.SetLength(0)
  $fs.Write($bytes, 0, $bytes.Length)
  $fs.Flush()
  return $fs
}

function Exit-CrestmontSingleInstance {
  <# .SYNOPSIS Releases a lock taken by Enter-CrestmontSingleInstance. #>
  param($Handle)
  if (-not $Handle) { return }
  try { $Handle.Close() } catch { $null = $_ }
  try { $Handle.Dispose() } catch { $null = $_ }
}

function Assert-CrestmontNotNested {
  <#
  .SYNOPSIS
    Guards against recursive spawning: $true the first time, $false when this supervisor is already an ancestor.
  .DESCRIPTION
    A process-scoped marker, which child processes inherit. If a supervised job ever re-launches its own supervisor
    (a bad command line, a loop in a wrapper script), the inner copy sees the marker and declines instead of
    forking forever.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [ValidateRange(1, 8)][int]$MaxDepth = 1
  )
  $var = "CRESTMONT_SUPERVISOR_" + ($Name.ToUpper() -replace "[^A-Z0-9]", "_")
  $depth = 0
  $raw = [Environment]::GetEnvironmentVariable($var, "Process")
  if ($raw) { [void][int]::TryParse($raw, [ref]$depth) }
  if ($depth -ge $MaxDepth) { return $false }
  [Environment]::SetEnvironmentVariable($var, [string]($depth + 1), "Process")
  return $true
}

function Get-CrestmontBackoffDelay {
  <#
  .SYNOPSIS
    Seconds to wait before restart attempt $Attempt: exponential, capped, with optional jitter.
  .DESCRIPTION
    Mirrored by runner/windows/background-task.ts (backoffDelaySeconds); runner/test/background-task.test.ts
    compares the two wherever pwsh is available. With -JitterPercent 0 the result is exactly
    min(CapSeconds, BaseSeconds * 2^(Attempt-1)), which is the form the parity test checks. Jitter is on by
    default so several workers recovering from the same outage do not retry in lockstep.
  #>
  param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 1000)][int]$Attempt,
    [ValidateRange(1, 3600)][int]$BaseSeconds = 5,
    [ValidateRange(1, 86400)][int]$CapSeconds = 300,
    [ValidateRange(0, 100)][int]$JitterPercent = 20
  )
  $exponent = $Attempt - 1
  if ($exponent -gt 30) { $exponent = 30 }
  $delay = [double]$BaseSeconds * [Math]::Pow(2, $exponent)
  if ($delay -gt [double]$CapSeconds) { $delay = [double]$CapSeconds }
  if ($JitterPercent -gt 0) {
    $span = $delay * ($JitterPercent / 100.0)
    $delay = $delay - $span + (Get-Random -Minimum 0.0 -Maximum (2.0 * $span))
  }
  $seconds = [int][Math]::Round($delay)
  if ($seconds -lt 1) { $seconds = 1 }
  return $seconds
}

function Test-CrestmontRestartBudget {
  <#
  .SYNOPSIS
    $true when another restart is within budget, $false when the rolling window is exhausted. Records the attempt.
  .DESCRIPTION
    Bounded retries: at most $MaxRestarts restarts per $WindowMinutes. Attempt timestamps live in $StateFile (one
    ISO-8601 instant per line, pruned to the window), so the budget survives a reboot and the file doubles as a
    record of how often the job has been falling over. Mirrored by runner/windows/background-task.ts
    (restartBudget) and compared in runner/test/background-task.test.ts.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$StateFile,
    [ValidateRange(1, 1000)][int]$MaxRestarts = 10,
    [ValidateRange(1, 10080)][int]$WindowMinutes = 60
  )
  New-Item -ItemType Directory -Force -Path (Split-Path $StateFile) | Out-Null
  $now = (Get-Date).ToUniversalTime()
  $cutoff = $now.AddMinutes(-1 * $WindowMinutes)
  $kept = New-Object System.Collections.ArrayList
  if (Test-Path $StateFile) {
    foreach ($line in (Get-Content $StateFile -ErrorAction SilentlyContinue)) {
      $t = $line.Trim()
      if (-not $t) { continue }
      $parsed = [DateTime]::MinValue
      if ([DateTime]::TryParse($t, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
        if ($parsed.ToUniversalTime() -gt $cutoff) { [void]$kept.Add($parsed.ToUniversalTime()) }
      }
    }
  }
  if ($kept.Count -ge $MaxRestarts) {
    [IO.File]::WriteAllText($StateFile, (($kept | ForEach-Object { $_.ToString("o") }) -join "`r`n") + "`r`n", (New-Object System.Text.ASCIIEncoding))
    return $false
  }
  [void]$kept.Add($now)
  [IO.File]::WriteAllText($StateFile, (($kept | ForEach-Object { $_.ToString("o") }) -join "`r`n") + "`r`n", (New-Object System.Text.ASCIIEncoding))
  return $true
}

function Write-CrestmontLogLine {
  <#
  .SYNOPSIS
    Appends one JSON object to a log file (JSON lines), the same shape the workers already emit.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet("debug", "info", "warn", "error")][string]$Level = "info",
    [hashtable]$Data
  )
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $record = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString("o"); level = $Level; msg = $Message; pid = $PID }
  if ($Data) { foreach ($k in ($Data.Keys | Sort-Object)) { $record[$k] = $Data[$k] } }
  $json = ($record | ConvertTo-Json -Compress -Depth 6) -replace "[\r\n]+", " "
  Add-Content -Path $Path -Value $json -Encoding ASCII
}

function Invoke-CrestmontLogRotation {
  <# .SYNOPSIS Truncates a log to its last $KeepLines lines once it passes $MaxBytes, and deletes old daily logs. #>
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateRange(64KB, 1GB)][int]$MaxBytes = 4MB,
    [ValidateRange(100, 1000000)][int]$KeepLines = 5000,
    [string]$DailyPattern = "",
    [ValidateRange(1, 3650)][int]$KeepDays = 14
  )
  if ((Test-Path $Path) -and (Get-Item $Path).Length -gt $MaxBytes) {
    $tail = Get-Content $Path -Tail $KeepLines
    [IO.File]::WriteAllText("$Path.rotating", (($tail -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))
    Move-Item -Force "$Path.rotating" $Path
  }
  if ($DailyPattern) {
    $dir = Split-Path $Path
    Get-ChildItem -Path $dir -Filter $DailyPattern -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1 * $KeepDays) } | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-CrestmontHiddenProcess {
  <#
  .SYNOPSIS
    Starts a process with no console window (CREATE_NO_WINDOW) and returns it, or its exit code with -Wait.
  .DESCRIPTION
    For the few places that must start something from a context that DOES have a window (an operator running
    Repair-WindowsAutomation.ps1 or Uninstall-CrestmontRunner.ps1 by hand): without CreateNoWindow the child would
    inherit a visible console. UseShellExecute is false, which is what makes CreateNoWindow apply. Nothing is
    redirected, so there is no risk of a pipe deadlock; jobs log to their own files.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = "",
    [ValidateSet("", "Idle", "BelowNormal", "Normal")][string]$Priority = "",
    [switch]$Wait
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($ArgumentList | ForEach-Object { Get-CrestmontQuotedArgument $_ }) -join " ")
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($Priority) { try { $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$Priority } catch { $null = $_ } }
  if ($Wait) { $proc.WaitForExit(); return $proc.ExitCode }
  return $proc
}
