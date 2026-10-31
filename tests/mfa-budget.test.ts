// Deploy #71: the read-only two-factor budget check (scripts/wait-mfa-budget.ts) must use exactly the app's rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./support/sqlite-d1.ts";
import { rateLimit } from "../src/services/security.ts";
import { MFA_ATTEMPT_LIMIT, MFA_ATTEMPT_WINDOW_SECONDS } from "../src/services/auth.ts";
import { attemptsLeft, secondsUntil, accountEmail, type Window } from "../scripts/wait-mfa-budget.ts";

test("[TEST-002] the two-factor budget check predicts exactly what the app's rate limit allows, across window boundaries", async () => {
  const W = MFA_ATTEMPT_WINDOW_SECONDS, base = Math.floor(Date.UTC(2026, 9, 30, 22) / 1000 / W) * W * 1000;
  for (const [prevUses, curUses, at] of [[0, 0, 10], [8, 0, 60], [8, 0, 600], [12, 3, 450], [3, 5, 899], [0, 8, 5]] as const) {
    const db = createTestDb();
    const key = "mfa:usr_budget";
    for (let i = 0; i < prevUses; i++) await rateLimit(db, key, MFA_ATTEMPT_LIMIT, W, base - W * 1000 + 1000);
    for (let i = 0; i < curUses; i++) await rateLimit(db, key, MFA_ATTEMPT_LIMIT, W, base + 1000);
    const now = base + at * 1000;
    const rows = (await db.prepare(`SELECT window_start, count FROM rate_limits WHERE key = ?`).bind(key).all<Window>()).results;
    const left = attemptsLeft(rows, now);
    // Spend exactly `left` attempts: each is allowed by the app; the next one is refused.
    for (let i = 0; i < Math.max(0, left); i++) assert.equal((await rateLimit(db, key, MFA_ATTEMPT_LIMIT, W, now)).allowed, true, `prev ${prevUses} cur ${curUses} at ${at}s: attempt ${i + 1} of ${left}`);
    assert.equal((await rateLimit(db, key, MFA_ATTEMPT_LIMIT, W, now)).allowed, false, `prev ${prevUses} cur ${curUses} at ${at}s: attempt ${left + 1} is refused`);
  }
});

test("[TEST-002] the budget check waits for the window instead of retrying, and refuses a need above the limit", () => {
  const W = MFA_ATTEMPT_WINDOW_SECONDS, now = Math.floor(Date.UTC(2026, 9, 30, 22) / 1000 / W) * W * 1000 + 30_000;
  const full: Window[] = [{ window_start: now / 1000 - 30, count: 8 }];
  assert.equal(attemptsLeft(full, now), 0);
  const s = secondsUntil(full, 6, now)!;
  assert.ok(s > 0 && attemptsLeft(full, now + s * 1000) >= 6 && attemptsLeft(full, now + (s - 5) * 1000) < 6, `frees 6 attempts after ${s}s`);
  assert.equal(secondsUntil([], 6, now), 0);
  assert.equal(secondsUntil([], MFA_ATTEMPT_LIMIT + 1, now), null);
  assert.equal(accountEmail("| owner | owner@demo.test | `pw` | `ABC` |\n| sales | s@demo.test | `pw` | — |", "owner"), "owner@demo.test");
});
