// D1 refuses a LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too complex:
// SQLITE_ERROR [code: 7500]"). SQLite's own limit is 50000, so before this guard a too-long pattern
// passed every local test and failed only against the deployed database — which is how a 56-byte
// pattern in migration 0068_portfolio_consent.sql reached staging and failed the deploy at
// "Apply D1 migrations" (run 41950679879), stranding every step behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { D1_MAX_LIKE_PATTERN_BYTES, likePatternParameterIndexes } from "../dev/sqlite-d1.ts";
import { likeContains, likePrefix, LIKE_PATTERN_LIMIT } from "../src/lib/db.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

test("[DATA-001] the test database enforces D1's LIKE pattern limit, so a too-long pattern cannot pass locally", async () => {
  const app = await createTestApp();
  try {
    assert.equal(LIKE_PATTERN_LIMIT, D1_MAX_LIKE_PATTERN_BYTES, "the builder and the adapter agree on the limit");
    const tooLong = `%${"a".repeat(60)}%`;
    assert.throws(
      () => app.db.prepare(`SELECT id FROM users WHERE email LIKE ? ESCAPE '\\'`).bind(tooLong),
      /LIKE or GLOB pattern of 62 bytes \(maximum 50\)/,
      "a 62-byte pattern is refused, as D1 refuses it",
    );
    // The limit applies only to the pattern operand: a long value compared with = is fine.
    const ok = app.db.prepare(`SELECT id FROM users WHERE name = ? AND email LIKE ? ESCAPE '\\'`).bind("x".repeat(300), likeContains("x".repeat(300)));
    assert.ok(ok, "a long ordinary bind is untouched");
  } finally { app.close(); }
});

test("[DATA-001] only the pattern operand of LIKE or GLOB is treated as length-limited", () => {
  assert.deepEqual(likePatternParameterIndexes(`SELECT 1 WHERE a LIKE ? ESCAPE '\\' OR b = ?`), [0]);
  assert.deepEqual(likePatternParameterIndexes("SELECT 1 WHERE a = ? AND b LIKE ? AND c LIKE ?"), [1, 2]);
  assert.deepEqual(likePatternParameterIndexes("SELECT 1 WHERE a NOT LIKE ? AND b = ?"), [0]);
  assert.deepEqual(likePatternParameterIndexes("SELECT 1 WHERE a GLOB ?"), [0]);
  // A '?' inside a comment or a string literal is not a bound parameter, so later indexes stay correct.
  assert.deepEqual(likePatternParameterIndexes("SELECT 1 WHERE a = ? -- LIKE ?\nAND b LIKE ?"), [1]);
  assert.deepEqual(likePatternParameterIndexes("SELECT 1 WHERE a LIKE 'x?y' AND b LIKE ?"), [0]);
});

test("[DATA-001] likeContains and likePrefix stay inside the limit without corrupting the pattern", () => {
  assert.equal(likeContains("Harbor Dental"), "%Harbor Dental%", "a short search is unchanged");
  assert.equal(likeContains("100%_off"), "%100\\%\\_off%", "the user's own wildcards are escaped, not stripped");

  const email = "dana.oneil+portfolio-consent@harbor-dental-group.example.com";
  for (const p of [likeContains(email), likePrefix(email)]) {
    assert.ok(bytes(p) <= LIKE_PATTERN_LIMIT, `${bytes(p)} bytes`);
    assert.ok(email.startsWith(p.replace(/^%/, "").replace(/%$/, "")), "what survives is a real prefix of the search");
  }

  // A pattern must never end in a lone backslash: that would escape the closing '%' and change its meaning.
  for (const n of [20, 23, 24, 25, 40]) {
    const p = likeContains("\\".repeat(n));
    assert.ok(bytes(p) <= LIKE_PATTERN_LIMIT, `${n} backslashes -> ${bytes(p)} bytes`);
    assert.equal((/\\+(?=%$)/.exec(p)?.[0].length ?? 0) % 2, 0, `${n} backslashes leaves no dangling escape`);
  }

  // Truncation is by UTF-8 bytes and never splits a character.
  const jp = likeContains("日本語".repeat(10));
  assert.ok(bytes(jp) <= LIKE_PATTERN_LIMIT);
  assert.ok(!jp.includes("�"));
  assert.equal(jp, `%${"日本語".repeat(5)}日%`);
});

test("[DATA-001] [CRM-003] a staff search longer than the pattern limit returns results instead of a 500", async () => {
  const app = await createTestApp();
  try {
    const owner = await createStaff(app.db, "owner", "owner@crestmont.test", "Olivia Owner");
    const client = await app.client().login(owner.email, undefined, owner.secret);

    // 242 characters, well past D1's 50-byte pattern limit, plus wildcards the user did not mean as wildcards.
    // Every one of these pages answered 500 before the cap (each built a 82-122 byte pattern).
    const long = `${"olivia".repeat(40)}%_`;
    for (const path of ["/staff/crm/contacts", "/staff/quotes", "/staff/finance/subscriptions",
                        "/staff/finance/invoices", "/staff/support", "/staff/projects", "/staff/builds"]) {
      const bare = await client.get(path);
      assert.equal(bare.status, 200, `${path} is a real page (a 404 would pass this test for the wrong reason)`);
      const res = await client.get(`${path}?q=${encodeURIComponent(long)}`);
      assert.equal(res.status, 200, `${path} answered ${res.status} for a ${long.length}-character search`);
    }

    // And a search that fits still finds its row: the cap must not break ordinary searching.
    await app.db.prepare(`INSERT INTO contacts (id, name, email, created_at) VALUES ('ctc_like','Olivia Owner','olivia@harbor-dental.example',?)`)
      .bind(new Date().toISOString()).run();
    const hit = await client.get("/staff/crm/contacts?q=Olivia");
    assert.equal(hit.status, 200);
    assert.match(await hit.text(), /Olivia Owner/);
  } finally { app.close(); }
});
