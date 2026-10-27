import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REQUIREMENTS } from "../requirements/inventory.ts";
import { IMPLEMENTATION } from "../requirements/status.ts";
import { createTestApp, createCustomer, TEST_PASSWORD } from "./support/app.ts";

function testSources(dir = "tests"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? testSources(join(dir, e.name)) : /\.(test|e2e)\.ts$/.test(e.name) ? [readFileSync(join(dir, e.name), "utf8")] : []);
}

test("[TEST-001] every implemented engineering or security requirement has at least one tagged unit, integration or browser test", () => {
  const src = testSources();
  // A tag only produces evidence at the start of a test title (scripts/evidence-reporter.mjs), so look for leading tag groups.
  const tagged = new Set<string>();
  for (const s of src) for (const m of s.matchAll(/(?:test|step)\(\s*["'`]((?:\[[A-Z]+-\d{3}\]\s*)+)/g)) for (const id of m[1].match(/[A-Z]+-\d{3}/g)!) tagged.add(id);
  const missing = REQUIREMENTS.filter((r) => ["engineering", "security"].includes(r.category) && IMPLEMENTATION[r.id]?.status === "implemented" && !tagged.has(r.id)).map((r) => r.id);
  assert.deepEqual(missing, [], "implemented without any test evidence");
  // Every id used in a tag exists in the inventory (no evidence for phantom requirements).
  const known = new Set(REQUIREMENTS.map((r) => r.id));
  assert.deepEqual([...tagged].filter((id) => !known.has(id)), []);
});

test("[BRAND-002] design tokens: colour, typography, spacing and breakpoints are defined once as CSS custom properties and used", () => {
  const css = readFileSync("public/assets/app.css", "utf8");
  const root = /:root\s*\{([^}]*)\}/.exec(css)![1];
  for (const t of ["--ink-0", "--gold-1", "--white", "--text", "--ok", "--warn", "--bad", "--focus", "--font-display", "--font-body", "--fs-xs", "--s-1", "--radius", "--max"]) assert.match(root, new RegExp(`${t}\\s*:`), t);
  for (const t of ["--gold-1", "--ink-0", "--font-body", "--s-1"]) assert.ok(css.split(`var(${t})`).length > 3, `${t} is used`);
  assert.ok((css.match(/@media[^{]*\((max|min)-width:/g) ?? []).length >= 3, "responsive breakpoints");
});

test("[INFRA-001] [DOC-001] the stack ADR and the repository build ledger exist and are current", () => {
  const adr = readFileSync("docs/adr/0001-stack.md", "utf8");
  assert.match(adr, /Cloudflare/);
  assert.match(adr, /D1/);
  assert.ok(existsSync("docs/adr/0002-authentication-provider.md"));
  const ledger = readFileSync("docs/BUILD_LEDGER.md", "utf8");
  assert.match(ledger, /## Session 3/);
});

test("[WEB-006] [CAT-003] registration, sign-in and checkout pages render; custom work is quoted separately, never sold through package checkout", async () => {
  const t = await createTestApp();
  const anon = t.client();
  for (const p of ["/register", "/login", "/pricing", "/quote"]) assert.equal((await anon.get(p)).status, 200, p);
  // Checkout needs an account; anonymous visitors are sent to sign in.
  const r = await anon.get("/checkout/starter");
  assert.ok([302, 303].includes(r.status), `anonymous checkout redirects (${r.status})`);
  const c = await createCustomer(t.db, "cat3@example.com");
  const cust = await t.client().login(c.email, TEST_PASSWORD);
  assert.equal((await cust.get("/checkout/starter")).status, 200);
  assert.equal((await cust.get("/checkout/custom")).status, 404, "custom work has no package checkout");
  const pricing = await (await anon.get("/pricing")).text();
  assert.match(pricing, /href="\/quote/, "custom work routes to a quote request");
});
