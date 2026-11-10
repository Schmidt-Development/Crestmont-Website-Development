// Retry/backoff policy and windowless command-line construction for the Windows background workers.
//
// Same functions as runner/windows/BackgroundTask.ps1 (Get-CrestmontBackoffDelay, Test-CrestmontRestartBudget,
// Get-CrestmontQuotedArgument, Get-CrestmontHiddenArgument). runner/test/background-task.test.ts unit-tests these
// and compares them with the PowerShell implementations wherever pwsh is available (CI's windows-scripts job and
// the Windows PowerShell 5.1 job). The PowerShell side is what actually runs on the build machine; this file
// exists so the policy can be tested without Windows.

/**
 * Quotes one argument for a Windows command line (mirrors Get-CrestmontQuotedArgument).
 *
 * These are the CommandLineToArgvW rules, which CreateProcess and therefore both consumers here - the scheduled
 * task's -Argument string and the command line the launcher hands to WshShell.Run - parse by. Escaping only the
 * quotes is not enough: inside a quoted argument a run of backslashes that meets a quote is itself an escape, so
 * a Windows path ending in a backslash ("C:\Crestmont Runner\") would have its trailing backslash escape the
 * CLOSING quote and swallow the next argument. Each run of backslashes that precedes a quote - including the
 * closing one - is therefore doubled, and each embedded quote is escaped after that doubling.
 */
export function quoteArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let out = '"';
  let i = 0;
  while (i < value.length) {
    let slashes = 0;
    while (i < value.length && value[i] === "\\") {
      slashes++;
      i++;
    }
    if (i >= value.length) {
      // Backslashes right before the closing quote: double them so they stay literal.
      out += "\\".repeat(slashes * 2);
      break;
    }
    if (value[i] === '"') out += "\\".repeat(slashes * 2 + 1) + '"';
    else out += "\\".repeat(slashes) + value[i];
    i++;
  }
  return out + '"';
}

/** Arguments that run a PowerShell script non-interactively, no profile, no window (Get-CrestmontHiddenArgument). */
export function hiddenArgument(scriptPath: string, scriptArguments: readonly string[] = []): string {
  return [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File",
    quoteArgument(scriptPath),
    ...scriptArguments.map(quoteArgument),
  ].join(" ");
}

/**
 * Seconds to wait before restart attempt `attempt` (1-based): exponential, capped, no jitter.
 *
 * The PowerShell function adds +/- jitter by default so that several workers recovering from one outage do not
 * retry in lockstep; with -JitterPercent 0 it returns exactly this, which is the form the parity test compares.
 */
export function backoffDelaySeconds(attempt: number, baseSeconds = 5, capSeconds = 300): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be an integer >= 1 (got ${attempt})`);
  if (baseSeconds < 1 || capSeconds < 1) throw new Error("baseSeconds and capSeconds must be >= 1");
  const exponent = Math.min(attempt - 1, 30);
  return Math.max(1, Math.round(Math.min(capSeconds, baseSeconds * Math.pow(2, exponent))));
}

export interface RestartBudget {
  /** Whether one more restart is allowed. */
  allowed: boolean;
  /** The attempt timestamps to persist: those still inside the window, plus `now` when the restart was allowed. */
  kept: Date[];
}

/**
 * Bounded retries: at most `maxRestarts` restarts per `windowMinutes` rolling window (Test-CrestmontRestartBudget).
 *
 * Attempts outside the window are dropped. When the budget is exhausted the caller stops instead of restarting, so
 * a job that fails instantly can never become an unbounded spawn loop.
 */
export function restartBudget(
  timestamps: readonly string[],
  now: Date,
  maxRestarts = 10,
  windowMinutes = 60,
): RestartBudget {
  if (maxRestarts < 1 || windowMinutes < 1) throw new Error("maxRestarts and windowMinutes must be >= 1");
  const cutoff = now.getTime() - windowMinutes * 60_000;
  const kept = timestamps
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => Date.parse(t))
    .filter((ms) => Number.isFinite(ms) && ms > cutoff)
    .map((ms) => new Date(ms));
  if (kept.length >= maxRestarts) return { allowed: false, kept };
  return { allowed: true, kept: [...kept, now] };
}
