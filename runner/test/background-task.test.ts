// The Windows background-execution kit: the retry/backoff policy (unit + parity with PowerShell), and static
// regression guards for the terminal-window defect.
//
// The defect: a scheduled task that runs powershell.exe with LogonType Interactive executes in the signed-in
// desktop session, where Windows creates and shows a console window for it. "-WindowStyle Hidden" is parsed by the
// PowerShell host after that window exists and cannot prevent it, so a repeating task of that shape popped a
// terminal on every repetition (the GPU sampler repeats every minute). The guards below fail if any task in the
// kit goes back to that shape. PowerShell is not available in this test environment, so the static checks do NOT
// prove the scripts run; CI's windows-scripts job parses them with real PowerShell and the
// windows-powershell-51 job runs them on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { backoffDelaySeconds, restartBudget, quoteArgument, hiddenArgument } from "../windows/background-task.ts";
import { RUNNER_DIR, REPO_ROOT, tmp, readText } from "./helpers.ts";

const WIN = path.join(RUNNER_DIR, "windows");
const RESEARCH_WIN = path.join(REPO_ROOT, "research-worker", "windows");
const read = (f: string): string => readText(path.join(WIN, f));
const readResearch = (f: string): string => readText(path.join(RESEARCH_WIN, f));

test("[AIB-RUNNER] backoff is exponential, capped and bounded below", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((a) => backoffDelaySeconds(a)), [5, 10, 20, 40, 80, 160, 300, 300]);
  assert.equal(backoffDelaySeconds(1, 1, 60), 1);
  assert.equal(backoffDelaySeconds(40, 5, 300), 300, "a huge attempt number still caps, it does not overflow");
  assert.equal(backoffDelaySeconds(3, 2, 1000), 8);
  assert.equal(backoffDelaySeconds(1, 1, 1), 1, "never below one second");
  assert.throws(() => backoffDelaySeconds(0), /attempt/);
  assert.throws(() => backoffDelaySeconds(1.5), /attempt/);
});

test("[AIB-RUNNER] restart budget bounds retries over a rolling window and ages old attempts out", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  // Empty history: allowed, and the attempt is recorded.
  const first = restartBudget([], now, 3, 60);
  assert.equal(first.allowed, true);
  assert.equal(first.kept.length, 1);

  // Three attempts inside the window: exhausted, and nothing new is recorded.
  const full = restartBudget([iso(5), iso(10), iso(15)], now, 3, 60);
  assert.equal(full.allowed, false);
  assert.equal(full.kept.length, 3, "the exhausted budget keeps the window, it does not grow");

  // The same three, but older than the window: they age out, so a restart is allowed again.
  const aged = restartBudget([iso(90), iso(120), iso(600)], now, 3, 60);
  assert.equal(aged.allowed, true);
  assert.equal(aged.kept.length, 1, "only the new attempt survives");

  // Exactly at the boundary is outside the window (strictly greater than the cutoff).
  assert.equal(restartBudget([iso(60), iso(61), iso(62)], now, 3, 60).allowed, true);
  // Blank and unparseable lines are ignored rather than counted.
  assert.equal(restartBudget(["", "   ", "not a date", iso(1)], now, 2, 60).kept.length, 2);
  assert.throws(() => restartBudget([], now, 0, 60), /maxRestarts/);
});

test("[AIB-RUNNER] windowless command line: arguments are quoted and the host is never interactive", () => {
  assert.equal(quoteArgument("plain"), "plain");
  assert.equal(quoteArgument(""), '""');
  assert.equal(quoteArgument(String.raw`C:\Program Files\x.ps1`), String.raw`"C:\Program Files\x.ps1"`);
  assert.equal(quoteArgument('say "hi"'), String.raw`"say \"hi\""`);
  const arg = hiddenArgument(String.raw`C:\CrestmontRunner\Write-GpuTelemetry.ps1`, ["-InstallDir", String.raw`C:\Crestmont Runner`]);
  assert.equal(arg, String.raw`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\CrestmontRunner\Write-GpuTelemetry.ps1 -InstallDir "C:\Crestmont Runner"`);
  assert.match(arg, /-NonInteractive/, "a background job must never wait for input it cannot receive");
});

/** Drops <# block #> and # line comments, so a rule about what a script DOES is not tripped by prose about it. */
function withoutComments(src: string): string {
  return src.replace(/<#[\s\S]*?#>/g, "").replace(/(^|\n)[^\n'"]*?#[^\n]*/g, "$1");
}

test("[AIB-RUNNER] Register-ScheduledTask is called in exactly one place, and it registers nothing on the desktop", () => {
  const files = [
    ...readdirSync(WIN).filter((f) => f.endsWith(".ps1")).map((f) => ({ name: f, src: read(f) })),
    ...readdirSync(RESEARCH_WIN).filter((f) => f.endsWith(".ps1")).map((f) => ({ name: f, src: readResearch(f) })),
  ];
  const callers = files.filter((f) => /\bRegister-ScheduledTask\b/.test(withoutComments(f.src))).map((f) => f.name);
  assert.deepEqual(callers, ["BackgroundTask.ps1"], "every task goes through Register-CrestmontBackgroundTask");

  for (const f of files.filter((f) => f.name !== "BackgroundTask.ps1")) {
    const code = withoutComments(f.src);
    assert.doesNotMatch(code, /New-ScheduledTaskAction/, `${f.name} must not build a task action itself`);
    assert.doesNotMatch(code, /New-ScheduledTaskPrincipal/, `${f.name} must not build a task principal itself`);
  }

  const mod = withoutComments(read("BackgroundTask.ps1"));
  // Two launch paths and no others: the hidden shim (the verified one), and a stored password for the research
  // worker's -RunWhenLoggedOff. An S4U principal was removed because no job here can use it.
  assert.doesNotMatch(mod, /-LogonType S4U/, "S4U was removed: it cannot reach the GUI programs or the user's DPAPI key");
  assert.match(mod, /-LogonType Interactive/);
  const interactive = mod.slice(mod.indexOf("-LogonType Interactive") - 700, mod.indexOf("-LogonType Interactive"));
  assert.match(interactive, /CrestmontWScriptExe -Argument/, "the interactive branch executes the hidden launcher, not a console host");
  // The only powershell.exe action is the one behind -Credential, which runs in session 0 where no window exists.
  const psActions = [...mod.matchAll(/New-ScheduledTaskAction -Execute \$script:CrestmontPowerShellExe[^\n]*/g)];
  assert.equal(psActions.length, 1, "powershell.exe may only be a task action on the stored-password (session 0) path");
  assert.match(mod.slice(0, mod.indexOf(psActions[0][0])), /if \(\$Credential\) \{/, "and that path is guarded by -Credential");
  // Single instance is enforced, not just defaulted.
  assert.match(mod, /MultipleInstances = "IgnoreNew"/);
  assert.match(mod, /must be registered with -MultipleInstances IgnoreNew/, "a caller passing anything else is refused");
});

test("[AIB-RUNNER] the hidden launcher creates the console already hidden and waits for the child", () => {
  const mod = read("BackgroundTask.ps1");
  const shim = mod.slice(mod.indexOf("$script:CrestmontShimSource"), mod.indexOf("function Test-CrestmontHiddenShimHost"));
  // Window style 0 = SW_HIDE, bWaitOnReturn True. Hiding after the fact would flash; not waiting would make the
  // task "finish" instantly and defeat IgnoreNew and ExecutionTimeLimit.
  assert.match(shim, /shell\.Run\(command, 0, True\)/);
  assert.match(shim, /Option Explicit/);
  assert.match(shim, /re\.Pattern = ""\^\[A-Za-z0-9\._-\]\+\$""/, "the job name is validated, so it cannot escape the tasks folder");
  assert.doesNotMatch(shim, /, 1, /, "window style 1 would show the window");
});

/**
 * Every Register-CrestmontBackgroundTask call in a script, with the text of its trigger and settings. The trigger
 * is normally built into a variable on an earlier line, so it is resolved here.
 */
function taskRegistrations(src: string): { name: string; body: string; trigger: string; settings: string }[] {
  const out: { name: string; body: string; trigger: string; settings: string }[] = [];
  for (const m of src.matchAll(/Register-CrestmontBackgroundTask -TaskName "([^"]+)"/g)) {
    const rest = src.slice(m.index!);
    const end = rest.slice(1).search(/\n\s*(?:Ok|Warn|Note|Fail) |Register-CrestmontBackgroundTask -TaskName/);
    const body = rest.slice(0, end > 0 ? end + 1 : 900);
    const trigger = /-Trigger (@\([^\n]*|\$[A-Za-z0-9_]+|\([^\n]*)/.exec(body);
    let triggerText = trigger ? trigger[1] : "";
    // Resolve every $variable the trigger expression names to its New-ScheduledTaskTrigger assignment.
    for (const v of triggerText.matchAll(/\$[A-Za-z0-9_]+/g)) {
      const assigned = src.match(new RegExp(`\\${v[0]} = New-ScheduledTaskTrigger[^\n]*`, "g"));
      if (assigned) triggerText += " " + assigned.join(" ");
    }
    // Settings are either inline or built into a variable on an earlier line; resolve both.
    let settings = /Get-CrestmontBackgroundTaskSetting[^)\n]*/.exec(body)?.[0] ?? "";
    if (!settings) {
      const named = /-Settings (\$[A-Za-z0-9_]+)/.exec(body);
      if (named) settings = (src.match(new RegExp(`\\${named[1]} = Get-CrestmontBackgroundTaskSetting[^\n]*`, "g")) ?? []).join(" ");
    }
    out.push({ name: m[1], body, trigger: triggerText, settings });
  }
  return out;
}

test("[AIB-RUNNER] the runner tasks keep the triggers, arguments and settings they shipped with, and only the launch path changed", () => {
  const install = read("Install-CrestmontRunner.ps1");
  const calls = taskRegistrations(install);
  // Exactly the two tasks that already existed. Nothing extra is registered: no second watchdog, no new service.
  assert.deepEqual(calls.map((c) => c.name).sort(), ["CrestmontRunner-GpuTelemetry", "CrestmontRunner-Start"]);

  const start = calls.find((c) => c.name === "CrestmontRunner-Start")!;
  // At logon AND every 5 minutes, both on this one task, exactly as before.
  assert.match(start.trigger, /-AtLogOn -User "\$env:USERDOMAIN\\\$env:USERNAME"/);
  assert.match(start.trigger, /-RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(start.settings, /-RestartCount 3 -RestartIntervalMinutes 5 -ExecutionTimeLimitMinutes 60/);
  assert.doesNotMatch(start.settings, /-StartWhenAvailable/, "this task never had StartWhenAvailable");
  assert.match(start.body, /-ScriptArgument \$startArgument/);

  const gpu = calls.find((c) => c.name === "CrestmontRunner-GpuTelemetry")!;
  assert.match(gpu.trigger, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(gpu.settings, /-RestartCount 0 -ExecutionTimeLimitMinutes 1/, "no restart count and a one-minute limit, as before");
  assert.doesNotMatch(gpu.settings, /-StartWhenAvailable/);
  assert.match(gpu.body, /-ScriptArgument @\("-InstallDir", \$InstallDir\)/);

  // The arguments the start task passes are the ones it always passed; -NoGuiLaunch was an invention and is gone.
  assert.match(install, /\$startArgument = @\("-InstallDir", \$InstallDir\)/);
  assert.match(install, /if \(\$OllamaInDocker\) \{ \$startArgument \+= "-OllamaInDocker" \} elseif \(\$PreserveOllamaConfig\) \{ \$startArgument \+= "-NoOllamaStart" \}/);
  for (const f of ["Install-CrestmontRunner.ps1", "Start-CrestmontRunner.ps1", "Repair-WindowsAutomation.ps1"]) {
    assert.doesNotMatch(read(f), /-NoGuiLaunch/, `${f}: the session-0 watchdog split was reverted`);
  }
  // No task asks for the desktop explicitly any more: the shim is the default path.
  assert.doesNotMatch(withoutComments(install), /-DesktopSession/);
  // Each task is read back after registration, and a task that could open a window stops the install.
  assert.match(install, /Test-CrestmontTaskIsWindowless/);
  assert.match(install, /else \{ Fail "\$t could open a terminal window/);
  assert.match(install, /if \(\$script:Problems\.Count\) \{ Exit-WithProblem \}[\s\S]{0,400}CrestmontRunner-Watchdog/);
  // The GUI programs are started only when absent, and minimised, so a 5-minute run cannot take focus.
  const startScript = read("Start-CrestmontRunner.ps1");
  for (const m of startScript.matchAll(/Start-Process[^\n]*/g)) {
    assert.match(m[0], /-WindowStyle Minimized/, "a GUI launch must not take focus");
  }
  assert.match(startScript, /if \(-not \(Get-Process "Docker Desktop"[\s\S]{0,120}Start-Process/);
  assert.match(startScript, /if \(-not \(Get-Process "ollama"[\s\S]{0,120}Start-Process/);

  // The repair script re-registers the same two tasks the same way.
  const repair = taskRegistrations(read("Repair-WindowsAutomation.ps1"));
  const rStart = repair.find((c) => c.name === "CrestmontRunner-Start")!;
  assert.match(rStart.trigger, /-AtLogOn/);
  assert.match(rStart.trigger, /-RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(rStart.settings, /-RestartCount 3 -RestartIntervalMinutes 5 -ExecutionTimeLimitMinutes 60/);
  const rGpu = repair.find((c) => c.name === "CrestmontRunner-GpuTelemetry")!;
  assert.match(rGpu.settings, /-RestartCount 0 -ExecutionTimeLimitMinutes 1/);
});

test("[AIB-RUNNER] the research worker task keeps its settings, with the restart count bounded", () => {
  const install = readResearch("Install-ResearchWorker.ps1");
  const calls = taskRegistrations(install);
  assert.deepEqual(calls.map((c) => c.name), ["CrestmontResearch-Worker", "CrestmontResearch-Worker"], "the credential and no-credential paths");
  for (const c of calls) {
    // As before: starts when available, no time limit, one instance. Only RestartCount changed, 999 -> 4.
    assert.match(c.settings, /-RestartCount 4 -RestartIntervalMinutes 1 -RunIndefinitely -StartWhenAvailable/);
    assert.match(c.body, /-ScriptArgument @\("-InstallDir", \$InstallDir\)/);
  }
  // Only the -RunWhenLoggedOff path stores a password, and it is the only one that passes -Credential.
  assert.equal([...install.matchAll(/-Credential \$cred/g)].length, 1);
  assert.match(install, /\$triggers = @\(New-ScheduledTaskTrigger -AtLogOn -User "\$env:USERDOMAIN\\\$env:USERNAME"\)/);
  assert.match(install, /if \(\$RunWhenLoggedOff\) \{ \$triggers \+= New-ScheduledTaskTrigger -AtStartup \}/);
});

test("[AIB-RUNNER] the research worker supervisor has bounded retries, one instance, and no unbounded loop", () => {
  const sup = readResearch("Start-ResearchWorker.ps1");
  assert.doesNotMatch(sup, /while \(\$true\)/, "an unbounded restart loop is what turned a crashing worker into a spawn storm");
  assert.match(sup, /Test-CrestmontRestartBudget/, "a restart must ask the budget first");
  assert.match(sup, /Get-CrestmontBackoffDelay/);
  assert.match(sup, /\$supervising = \$false/, "the loop ends when the budget is exhausted");
  assert.match(sup, /Enter-CrestmontSingleInstance -Name "research-worker"/);
  assert.match(sup, /Assert-CrestmontNotNested/, "a worker must not be able to launch its own supervisor");
  assert.match(sup, /--max-old-space-size=\$NodeHeapMb/, "the worker heap is capped");
  assert.match(sup, /PriorityClass/, "research runs below the desktop in priority");
  assert.match(sup, /Write-CrestmontLogLine -Path \$supervisorLog/, "structured file logging");
  // Credentials and queues are read, never rewritten, by the supervisor.
  assert.match(sup, /research_runner_secret\.dpapi/);
  assert.doesNotMatch(sup, /Remove-Item[^\n]*(secrets|data|duckdb)/i);

  const install = readResearch("Install-ResearchWorker.ps1");
  const restart = /-RestartCount (\d+)/.exec(install);
  assert.ok(restart && Number(restart[1]) <= 10, `the task restart count must stay small (got ${restart?.[1]}); it multiplies with the supervisor's own budget`);
  assert.doesNotMatch(install, /& powershell\.exe/, "a nested powershell.exe opens a second console window");
  assert.match(install, /Register-CrestmontBackgroundTask -TaskName "CrestmontResearch-Worker"/);
});

test("[AIB-RUNNER] long-running and repeating scripts take a single-instance lock", () => {
  for (const [file, lock] of [["Start-CrestmontRunner.ps1", "runner-start"], ["Write-GpuTelemetry.ps1", "gpu-telemetry"]] as const) {
    assert.match(read(file), new RegExp(`Enter-CrestmontSingleInstance -Name "${lock}"`), `${file} must be single-instance`);
    assert.match(read(file), /Exit-CrestmontSingleInstance/, `${file} must release its lock`);
  }
  const mod = read("BackgroundTask.ps1");
  assert.match(mod, /\[System\.IO\.FileShare\]::None/, "the lock is an exclusive handle, released by the OS even after a kill");
});

test("[AIB-RUNNER] Repair-WindowsAutomation.ps1 diagnoses before it changes anything, and deletes nothing", () => {
  const repair = read("Repair-WindowsAutomation.ps1");
  assert.match(repair, /\$DiagnoseOnly/);
  assert.match(repair, /Win32_Process/, "it reports the live processes and their parents");
  assert.match(repair, /ParentProcessId/);
  assert.match(repair, /Get-ScheduledTask -ErrorAction SilentlyContinue/, "it looks at every task, not only Crestmont's");
  assert.match(repair, /Test-CrestmontTaskIsWindowless/);
  assert.match(repair, /is NOT a Crestmont task: reported only/, "unrelated tasks are reported, never changed");
  // Nothing destructive: no deletes, no docker teardown, and it only ends processes it has identified as Crestmont's.
  assert.doesNotMatch(repair, /Remove-Item/);
  assert.doesNotMatch(repair, /Unregister-ScheduledTask/);
  assert.doesNotMatch(repair, /docker\.exe|docker compose/i, "the repair must not stop containers or tear the stack down");
  assert.match(repair, /\$KillRunaway/);
  assert.match(repair, /if \(\$p\.Pid -eq \$PID\) \{ continue \}/, "it must not kill itself");
  // Only tasks that actually fail the check are touched.
  assert.match(repair, /\$toFix = @\(\$crestmontTasks \| Where-Object \{ \$verdicts\[\$_\] -and -not \$verdicts\[\$_\]\.Ok/);
});

test("[AIB-RUNNER] every Windows script is ASCII (5.1 reads BOM-less files as ANSI)", () => {
  for (const [dir, names] of [[WIN, readdirSync(WIN)], [RESEARCH_WIN, readdirSync(RESEARCH_WIN)]] as const) {
    for (const f of names.filter((n) => n.endsWith(".ps1"))) {
      const bytes = readFileSync(path.join(dir, f));
      const bad = [...bytes].filter((b) => b > 127).length;
      assert.equal(bad, 0, `${f}: ${bad} non-ASCII bytes`);
    }
  }
});

test("[AIB-RUNNER] GPU telemetry never pipes nvidia-smi into Select-Object, which set $LASTEXITCODE to -1 on valid data", () => {
  const src = read("Write-GpuTelemetry.ps1");
  const code = withoutComments(src);

  // THE DEFECT. `Select-Object -First 1` short-circuits its upstream (StopUpstreamCommandsException since PS 3.0).
  // With a NATIVE command upstream the process is torn down instead of exiting, and $LASTEXITCODE comes back -1
  // even though nvidia-smi printed valid data - so the guard below it skipped writing gpu.json.
  const invocation = /^.*&\s*\$smi.*$/m.exec(code);
  assert.ok(invocation, "the script still invokes nvidia-smi");
  assert.doesNotMatch(invocation[0], /Select-Object/, "nvidia-smi must not be piped into Select-Object: that is the defect");
  assert.doesNotMatch(code, /&\s*\$smi[^\n]*\|[^\n]*Select-Object/, "no native-command pipeline into Select-Object anywhere");
  // Select-Object on an in-memory array is fine, and is how the first row is picked.
  assert.match(code, /\$raw = @\(& \$smi @query 2>&1/, "output is collected into an array first");
  assert.match(code, /\$exit = \$LASTEXITCODE/, "the real exit code is captured straight after the call");

  // Diagnosable instead of misleadingly successful: nvidia-smi absent is exit 0, nvidia-smi broken is exit 1.
  const missing = code.slice(code.indexOf("if (-not $smi) {\n    Write-CrestmontLogLine"));
  assert.match(missing.slice(0, 300), /no GPU telemetry on this machine"\s*\n\s*exit 0/, "no NVIDIA GPU is not a fault");
  for (const failure of ["nvidia-smi failed", "nvidia-smi printed nothing", "nvidia-smi output had no usable GPU row", "nvidia-smi could not be run"]) {
    const at = code.indexOf(failure);
    assert.ok(at > 0, `reports: ${failure}`);
    assert.match(code.slice(at, at + 400), /exit 1/, `${failure} must exit non-zero so LastTaskResult shows it`);
  }
  assert.match(code, /Write-CrestmontLogLine -Path \$log/, "every outcome is written to a structured log");

  // Under Windows PowerShell 5.1 with ErrorActionPreference Stop, native stderr becomes a terminating error, so
  // 2>&1 is only safe with the preference relaxed around the call.
  assert.match(code, /\$previous = \$ErrorActionPreference\s*\n\s*\$ErrorActionPreference = "Continue"/);
  assert.match(code, /finally \{ \$ErrorActionPreference = \$previous \}/);

  // Schema, destination and atomic write unchanged - the runner and the GPU workers page already read these.
  for (const key of ["at = (Get-Date).ToUniversalTime().ToString(\"o\")", "name = $row[0]", "driver = $row[1]", "memoryTotalMb", "memoryUsedMb", "utilizationPercent"]) {
    assert.ok(code.includes(key), `schema key: ${key}`);
  }
  assert.match(code, /\$dir = Join-Path \$InstallDir "state\\telemetry"/);
  assert.match(code, /\$tmp = Join-Path \$dir "gpu\.json\.tmp"[\s\S]{0,200}Move-Item -Force \$tmp \(Join-Path \$dir "gpu\.json"\)/, "written to a temp file and renamed");

  // One sampler at a time, so the GPU is never queried twice over and two writers cannot interleave on gpu.json.
  assert.match(code, /Enter-CrestmontSingleInstance -Name "gpu-telemetry"/);
  assert.match(code, /if \(-not \$lock\) \{[\s\S]{0,200}exit 0/, "a sampler that finds the lock held does nothing and reports success");
  // A test seam, not a behaviour change: nothing on a real machine passes it.
  assert.match(code, /\[string\]\$NvidiaSmiPath = ""/);
});

test("[AIB-RUNNER] a re-install validates prerequisites first and can roll the task configuration back", () => {
  const mod = withoutComments(read("BackgroundTask.ps1"));
  // Prerequisites are checked before the first state change, so a half-copied install never replaces a task.
  const reg = mod.slice(mod.indexOf("function Register-CrestmontBackgroundTask"));
  const prereqAt = reg.indexOf("Assert-CrestmontTaskPrerequisite");
  const firstWrite = Math.min(...["Export-CrestmontTaskBackup", "Register-ScheduledTask", "Write-CrestmontHiddenShim"].map((m) => {
    const i = reg.indexOf(m);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }));
  assert.ok(prereqAt > 0 && prereqAt < firstWrite, "prerequisites are asserted before anything is written or registered");
  assert.match(mod, /if \(-not \(Test-Path \$ScriptPath\)\) \{\s*\n\s*throw/, "a task is never pointed at a script that is not there");
  assert.match(mod, /RequireShimHost -and -not \(Test-CrestmontHiddenShimHost\)/, "the launcher host is checked too");

  // The existing definition is exported before being replaced, and put back if registration throws.
  assert.match(reg, /\$backup = Export-CrestmontTaskBackup -TaskName \$TaskName -BackupDir \(Join-Path \$InstallDir "state\\task-backup"\)/);
  assert.match(reg, /\} catch \{[\s\S]{0,400}Restore-CrestmontTaskBackup -TaskName \$TaskName -Path \$backup[\s\S]{0,400}throw/, "a failed registration restores the previous definition and still fails loudly");
  assert.match(mod, /\$TaskName \+ "\.last\.xml"/, "a stable name for the definition a rollback reaches for");
  assert.match(mod, /Set-Content -Path \$path -Value \$xml -Encoding Unicode/, "task XML declares UTF-16");
  assert.match(mod, /Get-Content -Path \$Path -Raw -Encoding Unicode/, "and is read back the same way");

  // The operator-facing rollback.
  const repair = read("Repair-WindowsAutomation.ps1");
  assert.match(repair, /\[switch\]\$RestoreTasks/);
  assert.match(repair, /Restore-CrestmontTaskBackup -TaskName \$t -Path \$path/);
  assert.match(repair, /if \(\$RestoreTasks\) \{[\s\S]{0,2000}exit 0\n\}/, "the rollback path reports and exits without converting anything");
  // Rolling back only touches task definitions: no file is written, no process stopped, no secret read.
  const rollback = repair.slice(repair.indexOf("if ($RestoreTasks) {"), repair.indexOf("# ---- 4."));
  for (const forbidden of [/Remove-Item/, /Set-Content/, /\bdocker\.exe\b/, /Stop-Process/, /ConvertTo-SecureString/, /Unregister-ScheduledTask/]) {
    assert.doesNotMatch(rollback, forbidden, `the rollback must not use ${forbidden}`);
  }
  // Re-running the installer is safe: every registration replaces in place rather than failing on an existing task.
  const registrations = [...mod.matchAll(/Register-ScheduledTask[^\n]*/g)].map((m) => m[0]);
  assert.ok(registrations.length >= 3, "the credential path, the shim path and the restore path");
  for (const r of registrations) assert.match(r, /-Force/, `registration must replace in place: ${r.slice(0, 60)}`);
});

test("[AIB-RUNNER] nothing new is launched or scheduled: only the two existing runner tasks and the two GUI programs", () => {
  const install = withoutComments(read("Install-CrestmontRunner.ps1"));
  const names = [...install.matchAll(/Register-CrestmontBackgroundTask -TaskName "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ["CrestmontRunner-GpuTelemetry", "CrestmontRunner-Start"]);
  // No Windows service is created or started, and no third-party supervisor is introduced.
  for (const forbidden of [/New-Service/, /nssm/i, /sc\.exe/, /Set-Service/, /Start-Service/]) {
    assert.doesNotMatch(install, forbidden, `no service management: ${forbidden}`);
  }
  // The superseded watchdog task from the earlier revision is removed rather than left to duplicate work.
  assert.match(install, /Unregister-ScheduledTask -TaskName "CrestmontRunner-Watchdog"/);
  assert.match(install, /Export-CrestmontTaskBackup -TaskName "CrestmontRunner-Watchdog"/, "its definition is kept before it goes");
  // The only processes the start script launches are the two that were always launched.
  const started = [...read("Start-CrestmontRunner.ps1").matchAll(/Start-Process -FilePath (\$[A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual(started.sort(), ["$app", "$dockerDesktop"]);
  assert.match(read("Repair-WindowsAutomation.ps1"), /\$supersededTasks = @\("CrestmontRunner-Watchdog"\)/, "and the repair script reports an orphan");
});

/** pwsh on PATH, or PWSH=<path> (CI sets PWSH=powershell for Windows PowerShell 5.1); null when not installed. */
function findPwsh(): string | null {
  for (const c of [process.env.PWSH, "pwsh"].filter(Boolean) as string[]) {
    const r = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 60_000 });
    if (r.status === 0) return c;
  }
  return null;
}
const PWSH = findPwsh();

test("[AIB-RUNNER] BackgroundTask.ps1 retry policy and quoting match background-task.ts", { skip: PWSH ? false : "pwsh not installed (runs in CI's windows-scripts job and wherever PWSH is set)" }, () => {
  const dir = tmp("aib-bgtask-ps-");
  const script = path.join(dir, "probe.ps1");
  const budgetFile = path.join(dir, "attempts.txt");
  writeFileSync(script, [
    "param([string]$Out, [string]$BudgetFile)",
    "$ErrorActionPreference = 'Stop'",
    `. '${path.join(WIN, "BackgroundTask.ps1").replaceAll("'", "''")}'`,
    // Jitter off, so the comparison is exact; the jittered form is the same number plus noise.
    "$delays = @(1, 2, 3, 4, 5, 6, 7, 8 | ForEach-Object { Get-CrestmontBackoffDelay -Attempt $_ -JitterPercent 0 })",
    "$quoted = @('plain', '', 'C:\\Program Files\\x.ps1', 'say \"hi\"' | ForEach-Object { Get-CrestmontQuotedArgument $_ })",
    "$argline = Get-CrestmontHiddenArgument -ScriptPath 'C:\\CrestmontRunner\\Write-GpuTelemetry.ps1' -ScriptArgument @('-InstallDir', 'C:\\Crestmont Runner')",
    // Four restarts against a budget of three: the fourth must be refused.
    "$budget = @(1, 2, 3, 4 | ForEach-Object { [bool](Test-CrestmontRestartBudget -StateFile $BudgetFile -MaxRestarts 3 -WindowMinutes 60) })",
    "$r = [ordered]@{ delays = $delays; quoted = $quoted; argline = $argline; budget = $budget }",
    "[IO.File]::WriteAllText($Out, ($r | ConvertTo-Json -Depth 5 -Compress))",
  ].join("\n"));
  const outFile = path.join(dir, "out.json");
  const r = spawnSync(PWSH!, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", outFile, "-BudgetFile", budgetFile], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const ps = JSON.parse(readText(outFile).replace(/^\uFEFF/, "")) as { delays: number[]; quoted: string[]; argline: string; budget: boolean[] };

  assert.deepEqual(ps.delays, [1, 2, 3, 4, 5, 6, 7, 8].map((a) => backoffDelaySeconds(a)));
  assert.deepEqual(ps.quoted, ["plain", "", String.raw`C:\Program Files\x.ps1`, 'say "hi"'].map(quoteArgument));
  assert.equal(ps.argline, hiddenArgument(String.raw`C:\CrestmontRunner\Write-GpuTelemetry.ps1`, ["-InstallDir", String.raw`C:\Crestmont Runner`]));
  assert.deepEqual(ps.budget, [true, true, true, false], "the fourth restart in the window is refused");

  // The TypeScript mirror reaches the same verdict from the file the PowerShell run left behind.
  const recorded = readText(budgetFile).split("\n").filter((l) => l.trim().length > 0);
  assert.equal(recorded.length, 3);
  assert.equal(restartBudget(recorded, new Date(), 3, 60).allowed, false);
});
