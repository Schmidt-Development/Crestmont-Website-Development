// Structured JSON-lines logs (operational metadata only). Registered secrets are redacted from every line.
export type Level = "debug" | "info" | "warn" | "error";
export interface Logger { debug(m: string, f?: Record<string, unknown>): void; info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void }

const secrets = new Set<string>();
export const registerSecret = (s: string | null | undefined) => { if (s && s.length >= 8) secrets.add(s); };
export function redact(s: string): string { let o = s; for (const x of secrets) o = o.split(x).join("[redacted]"); return o; }

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(opts: { level?: Level; sink?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const sink = opts.sink ?? ((l: string) => process.stdout.write(l + "\n"));
  const emit = (level: Level, msg: string, f?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    try { sink(redact(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(f ?? {}) }))); } catch { /* never throw from logging */ }
  };
  return { debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f), warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f) };
}
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
