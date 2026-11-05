// Reads a `wrangler tail` capture and reports what the Worker itself said, redacted.
//
// Why this exists. A 500 on staging has had two possible explanations and no way to tell them apart:
//   · an unhandled exception, which app.ts records in app_errors AND console.errors; or
//   · D1 faulting, in which case recordAppError's own INSERT fails too — so app_errors holds nothing, and
//     the deploy's error-log step correctly reports "no application errors" for pages that plainly failed.
// Deploy #159 is exactly the second shape: four consecutive Owner modules at 500 and an empty error log.
// The deploy's own message already says "check wrangler tail before concluding the pages were healthy",
// which nobody could do, because that needs a live stream at the moment of failure. This makes the deploy
// take the stream itself.
//
// It needs no D1 and no Cloudflare metrics, so it still works in precisely the case that blinds the other
// instrument. It sees both of app.ts's unconditional console.error for every unhandled error, and
// recordAppError's "app_errors write failed" line when the error log itself could not be written.
//
// REDACTION IS NOT OPTIONAL HERE. app.ts logs the raw message and stack, this repository is public, and a
// workflow log is readable by anyone (F-18/F-19). Every line goes through the platform's own redact() before
// it is printed, and nothing is printed verbatim.
//
// Usage: node --no-warnings scripts/worker-faults.ts <capture file> [--title "..."]
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redact } from "../src/services/monitoring.ts";

export interface Fault { level: string; path: string | null; message: string; count: number }

/** One `wrangler tail --format json` line, defensively: the shape has changed between versions. */
interface TailLine {
  outcome?: string; eventTimestamp?: number;
  event?: { request?: { url?: string; method?: string } };
  logs?: { level?: string; message?: unknown[] }[];
  exceptions?: { name?: string; message?: string }[];
}

const ERROR_LEVELS = new Set(["error", "warn"]);

/** The path of a tail line's request, without the origin, or null. */
export function requestPath(url: string | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.pathname + (u.search ? "?" : ""); } catch { return null; }
}

/**
 * Faults from a capture, newest first, deduplicated by (level, path, message) with a count. Lines that are
 * not JSON are kept as raw text rather than dropped: a crash can print something that is not a log line, and
 * that is exactly when this is worth reading.
 */
export function parseFaults(capture: string): Fault[] {
  const seen = new Map<string, Fault>();
  const add = (level: string, path: string | null, message: string) => {
    const text = redact(message).slice(0, 600).replace(/\s+/g, " ").trim();
    if (!text) return;
    const k = `${level}\u0001${path ?? ""}\u0001${text}`;
    const hit = seen.get(k);
    if (hit) { hit.count++; return; }
    seen.set(k, { level, path, message: text, count: 1 });
  };

  for (const raw of capture.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("{")) {
      // wrangler's own banner and connection notices are noise; anything else is kept.
      if (/^(⛅|🪵|Successfully created|Connected to|wrangler |\s*$)/.test(line)) continue;
      add("raw", null, line);
      continue;
    }
    let o: TailLine;
    try { o = JSON.parse(line) as TailLine; } catch { add("raw", null, line); continue; }
    const path = requestPath(o.event?.request?.url);
    for (const ex of o.exceptions ?? []) add("exception", path, `${ex.name ?? "Error"}: ${ex.message ?? ""}`);
    for (const log of o.logs ?? []) {
      const level = (log.level ?? "log").toLowerCase();
      if (!ERROR_LEVELS.has(level)) continue;
      add(level, path, (log.message ?? []).map((m) => typeof m === "string" ? m : JSON.stringify(m)).join(" "));
    }
    // An exception that wrangler reports only as an outcome still matters.
    if (o.outcome && o.outcome !== "ok" && o.outcome !== "canceled" && !(o.exceptions ?? []).length) {
      add("outcome", path, `request outcome: ${o.outcome}`);
    }
  }
  return [...seen.values()];
}

/** True when a fault is recordAppError reporting that it could not write the error log — i.e. D1 was faulting. */
export function isLostErrorRecord(f: Fault): boolean {
  return /app_errors write failed/.test(f.message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const titleArg = process.argv.indexOf("--title");
  const title = titleArg > 0 ? process.argv[titleArg + 1] ?? "Worker fault" : "Worker fault";
  if (!file || !existsSync(file)) { console.log(`::warning title=${title}::No Worker log capture was written, so the Worker's own account of these failures is not available.`); process.exit(0); }
  const faults = parseFaults(readFileSync(file, "utf8"));
  if (!faults.length) {
    console.log(`::warning title=${title}::The Worker logged nothing at error level while this ran. With an empty app_errors as well, the failures were not unhandled exceptions in the Worker at all — look outside it (the edge, or the request never arriving).`);
    process.exit(0);
  }
  const lost = faults.filter(isLostErrorRecord);
  if (lost.length) {
    console.log(`::error title=${title}: the error log itself could not be written::${lost.length} fault(s) report "app_errors write failed", so D1 was refusing writes. That is why app_errors is empty for these failures; it is not evidence the pages were healthy.`);
  }
  const e = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const f of faults) {
    const where = f.path ? ` ${f.path}` : "";
    const n = f.count > 1 ? ` (x${f.count})` : "";
    console.log(`::error title=${title} [${f.level}]${where}${n}::${e(f.message)}`);
  }
  console.log(`${faults.length} distinct Worker fault(s) captured${lost.length ? `, ${lost.length} of them a lost error record` : ""}.`);
}
