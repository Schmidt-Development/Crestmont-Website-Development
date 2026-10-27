// Structured JSON-lines logger. Logs operational metadata only (job ids, stages, costs, tool names, errors).
// Never customer brief content. Every registered secret value is redacted from every line.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const secrets = new Set<string>();

/** Register a secret value so it is replaced with [redacted] in any log line (values under 8 chars are ignored). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  // Common credential shapes, in case something unregistered slips through.
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "[redacted]");
  out = out.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]");
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]");
  out = out.replace(/(authorization:\s*)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, "$1$2 [redacted]");
  return out;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: { level?: LogLevel; sink?: (line: string) => void; base?: Record<string, unknown> } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const base = opts.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) };
    let line: string;
    try { line = JSON.stringify(entry); } catch { line = JSON.stringify({ ts: entry.ts, level, msg }); }
    sink(redact(line));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ level: opts.level, sink, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ sink: () => {} });

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
