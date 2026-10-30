// Waits until a demo account has enough second-factor attempts left in the app's rate window for this deploy's
// credentialed checks (deploy #71: back-to-back deploys and the CRM E2E exhausted the Owner's 8 codes per 15 minutes,
// so browser journeys failed with "Too many codes entered"). Read-only: it reads rate_limits through the same D1 the
// Worker uses and applies the app's own sliding-window rule (rateLimitEffective). It never changes a limit or a count.
//
//   node --no-warnings scripts/wait-mfa-budget.ts --accounts access/demo-accounts.md --role owner --need 6 [--timeout 1920]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rateLimitEffective } from "../src/services/security.ts";
import { MFA_ATTEMPT_LIMIT, MFA_ATTEMPT_WINDOW_SECONDS, mfaRateKey } from "../src/services/auth.ts";
import { wranglerOps, type D1Ops } from "./staging-access.ts";

export type Window = { window_start: number; count: number };

/** Attempts still available now under the app's rule, given this key's rate_limits rows. */
export function attemptsLeft(rows: Window[], now = Date.now(), limit = MFA_ATTEMPT_LIMIT, windowSeconds = MFA_ATTEMPT_WINDOW_SECONDS): number {
  const start = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const cur = rows.find((r) => Number(r.window_start) === start)?.count ?? 0;
  const prev = rows.find((r) => Number(r.window_start) === start - windowSeconds)?.count ?? 0;
  return Math.floor(limit - rateLimitEffective(Number(cur), Number(prev), now, windowSeconds));
}

/** Seconds until at least `need` attempts are available, assuming no other use meanwhile (null: never, need > limit). */
export function secondsUntil(rows: Window[], need: number, now = Date.now(), limit = MFA_ATTEMPT_LIMIT, windowSeconds = MFA_ATTEMPT_WINDOW_SECONDS): number | null {
  if (need > limit) return null;
  for (let s = 0; s <= 2 * windowSeconds; s += 5) if (attemptsLeft(rows, now + s * 1000, limit, windowSeconds) >= need) return s;
  return 2 * windowSeconds;
}

export function accountEmail(markdown: string, role: string): string {
  const m = [...markdown.matchAll(/^\| (\w+) \| (\S+) \| `[^`]+` \|/gm)].find((x) => x[1] === role);
  if (!m) throw new Error(`no ${role} account in the accounts file`);
  return m[2]!;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
async function windows(ops: D1Ops, email: string): Promise<Window[]> {
  const ids = await ops.query<{ id: string }>(`SELECT id FROM users WHERE email = ${lit(email.toLowerCase())}`);
  if (!ids[0]) throw new Error("the account was not found in staging D1");
  return ops.query<Window>(`SELECT window_start, count FROM rate_limits WHERE key = ${lit(mfaRateKey(ids[0].id))}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const role = arg("--role") ?? "owner", need = Number(arg("--need") ?? "6"), timeout = Number(arg("--timeout") ?? "1920");
  try {
    const email = accountEmail(readFileSync(arg("--accounts") ?? "access/demo-accounts.md", "utf8"), role);
    const ops = wranglerOps();
    const until = Date.now() + timeout * 1000;
    for (;;) {
      const rows = await windows(ops, email);
      const left = attemptsLeft(rows);
      if (left >= need) { console.log(`${role}: ${left} of ${MFA_ATTEMPT_LIMIT} two-factor attempts available in the rate window (this run needs ${need})`); break; }
      const wait = secondsUntil(rows, need);
      if (wait === null) throw new Error(`this run needs ${need} attempts but the limit is ${MFA_ATTEMPT_LIMIT}`);
      if (Date.now() + wait * 1000 > until) throw new Error(`${role}: only ${left} two-factor attempts available and ${need} needed; the window frees them in ${wait}s, past the ${timeout}s limit (another deploy or session is using this account)`);
      console.log(`${role}: ${left} of ${MFA_ATTEMPT_LIMIT} two-factor attempts available, ${need} needed; waiting ${wait + 5}s for the rate window`);
      await new Promise((ok) => setTimeout(ok, (wait + 5) * 1000));
    }
  } catch (e) {
    console.log(`::error title=Two-factor budget::${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    process.exit(1);
  }
}
