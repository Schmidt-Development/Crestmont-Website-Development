// DuckDB through its CLI (a free single executable; no npm package). SQL runs in a child process; results are
// written by DuckDB itself (COPY ... TO) and streamed back from disk, so memory stays flat for millions of rows.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, renameSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

export interface SqlRunner {
  /** Runs a SQL script; resolves with stdout. Rejects with stderr on a non-zero exit. */
  exec(sql: string, opts?: { timeoutMs?: number }): Promise<string>;
}

export class DuckDbCli implements SqlRunner {
  readonly path: string;
  readonly memoryLimit: string;
  constructor(path: string, memoryLimit = "8GB") { this.path = path; this.memoryLimit = memoryLimit; }
  exec(sql: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      // Script on stdin (no shell, no quoting issues); -bail stops at the first error.
      const p = spawn(this.path, ["-bail", "-noheader", "-csv"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "", err = "";
      const timer = opts.timeoutMs ? setTimeout(() => { p.kill(); reject(new Error(`duckdb timed out after ${opts.timeoutMs} ms`)); }, opts.timeoutMs) : null;
      p.stdout.on("data", (d) => { if (out.length < 5_000_000) out += d; });
      p.stderr.on("data", (d) => { if (err.length < 20_000) err += d; });
      p.on("error", (e) => { if (timer) clearTimeout(timer); reject(new Error(`cannot start DuckDB (${this.path}): ${e.message}`)); });
      p.on("close", (code) => { if (timer) clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`duckdb exited ${code}: ${err.trim().slice(0, 2000)}`)); });
      p.stdin.end(`SET memory_limit='${this.memoryLimit}';\nSET preserve_insertion_order=false;\n${sql}\n`);
    });
  }
}

/** SQL string literal (single quotes doubled). */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Forward slashes work for DuckDB on Windows too and avoid escaping. */
export const sqlPath = (p: string) => lit(p.replace(/\\/g, "/"));

/** Writes a query result to `target` atomically: COPY to a temp file, then rename (an interrupted run leaves no half file). */
export async function copyAtomic(db: SqlRunner, query: string, target: string, format: "PARQUET" | "JSON", timeoutMs?: number, preamble = ""): Promise<void> {
  const tmp = `${target}.tmp`;
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  await db.exec(`${preamble}\nCOPY (${query}) TO ${sqlPath(tmp)} (FORMAT ${format}${format === "PARQUET" ? ", COMPRESSION ZSTD" : ""});`, { timeoutMs });
  renameSync(tmp, target);
}

/** Streams a newline-delimited JSON file written by COPY ... (FORMAT JSON). */
export async function* readJsonLines<T>(path: string): AsyncIterable<T> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line) as T;
}

/** Parses DuckDB -csv output of a one-column query into strings (no header). */
export const csvColumn = (out: string): string[] => out.split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
