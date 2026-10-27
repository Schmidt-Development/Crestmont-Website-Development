// Browser E2E harness: starts the real development server (dev/server.ts) on a throwaway database
// and drives Chromium via Playwright. Evidence from these runs is environment "development";
// only runs against the deployed staging URL count as staging evidence.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PW = process.env.PLAYWRIGHT_MODULE ?? "/opt/node22/lib/node_modules/playwright/index.mjs";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "crestmont-e2e-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dbPath = join(dir, "e2e.db");
  const proc: ChildProcess = spawn(process.execPath, ["--no-warnings", "dev/server.ts", "--port", String(port), "--db", dbPath], {
    env: { ...process.env, CRESTMONT_FILES: join(dir, "files"), STRIPE_WEBHOOK_SECRET: "whsec_e2e_test_secret", EVIDENCE_INGEST_SECRET: "e2e-ingest-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error("dev server did not start:\n" + log);
  }
  const db = new DatabaseSync(dbPath);
  return {
    base, db, log: () => log,
    async stop() { proc.kill(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function launchBrowser() {
  const { chromium } = await import(PW);
  return chromium.launch();
}

export function latestEmail(db: DatabaseSync, to: string): { template: string; text_body: string } | undefined {
  return db.prepare(`SELECT d.template, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = ? ORDER BY d.rowid DESC LIMIT 1`).get(to) as never;
}

export const linkIn = (text: string, base: string, path: string) => {
  const m = new RegExp(`${base.replace(/[.:/]/g, (c) => "\\" + c)}(${path}[^\\s]*)`).exec(text);
  if (!m) throw new Error(`no ${path} link in ${text}`);
  return base + m[1];
};
