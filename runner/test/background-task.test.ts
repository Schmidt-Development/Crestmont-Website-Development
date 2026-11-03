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

  const mod = read("BackgroundTask.ps1");
  // The three registration paths, and the only two that may be used with an interactive principal.
  assert.match(mod, /-LogonType S4U/);
  assert.match(mod, /-LogonType Interactive/);
  assert.match(mod, /CrestmontWScriptExe -Argument/, "an interactive task is launched through wscript.exe, not powershell.exe");
  const interactive = mod.slice(mod.indexOf("-LogonType Interactive") - 600, mod.indexOf("-LogonType Interactive"));
  assert.match(interactive, /CrestmontWScriptExe/, "the interactive branch executes the hidden launcher");
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
 * Every Register-CrestmontBackgroundTask call in a script, with whether it asks for the desktop and whether its
 * trigger repeats. The trigger is normally built into a variable on an earlier line, so it is resolved here.
 */
function taskRegistrations(src: string): { name: string; desktop: boolean; repeats: boolean }[] {
  const marker = /Register-CrestmontBackgroundTask -TaskName "([^"]+)"/g;
  const out: { name: string; desktop: boolean; repeats: boolean }[] = [];
  for (const m of src.matchAll(marker)) {
    const rest = src.slice(m.index!);
    const end = rest.slice(1).search(/\n\s*(?:Ok|Warn|Note) |Register-CrestmontBackgroundTask -TaskName/);
    const body = rest.slice(0, end > 0 ? end + 1 : 900);
    const trigger = /-Trigger (\$[A-Za-z0-9_]+|\([^\n]*)/.exec(body);
    let triggerText = trigger ? trigger[1] : "";
    if (triggerText.startsWith("$")) {
      // e.g. "$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ... -RepetitionInterval ..."
      const assigned = new RegExp(`\\${triggerText} = New-ScheduledTaskTrigger[^\n]*`, "g");
      triggerText = (src.match(assigned) ?? []).join(" ");
    }
    out.push({ name: m[1], desktop: /-DesktopSession/.test(body), repeats: /-RepetitionInterval/.test(triggerText) });
  }
  return out;
}

test("[AIB-RUNNER] every repeating task runs in session 0; only the logon task touches the desktop", () => {
  const install = read("Install-CrestmontRunner.ps1");
  const calls = taskRegistrations(install);
  assert.deepEqual(calls.map((c) => c.name).sort(), ["CrestmontRunner-GpuTelemetry", "CrestmontRunner-Start", "CrestmontRunner-Watchdog"]);
  for (const c of calls) {
    const { repeats, desktop } = c;
    assert.ok(!(repeats && desktop), `${c.name}: a repeating trigger must not run on the desktop - that is one window per repetition`);
    if (c.name === "CrestmontRunner-Start") {
      assert.ok(desktop && !repeats, "the logon task is the only desktop task, and it fires once per logon");
    } else {
      assert.ok(repeats && !desktop, `${c.name} repeats, so it must run in session 0`);
    }
  }
  // The watchdog must not start GUI programs: in session 0 they have no desktop, and on the desktop they steal focus.
  assert.match(install, /-NoGuiLaunch/);
  const start = read("Start-CrestmontRunner.ps1");
  const guiBlock = start.slice(start.indexOf("if (-not $NoGuiLaunch) {"), start.indexOf("# Wait for the engine"));
  assert.match(guiBlock, /Docker Desktop\.exe/);
  assert.match(guiBlock, /ollama app\.exe/);
  for (const m of start.matchAll(/Start-Process[^\n]*/g)) {
    assert.match(m[0], /-WindowStyle Minimized/, "a GUI launch must not take focus");
  }
  // Each task is read back after registration rather than assumed correct.
  assert.match(install, /Test-CrestmontTaskIsWindowless/);

  // The repair script re-registers the same tasks, so the same rule must hold there.
  for (const c of taskRegistrations(read("Repair-WindowsAutomation.ps1"))) {
    assert.ok(!(c.repeats && c.desktop), `Repair: ${c.name} must not repeat on the desktop`);
  }
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
