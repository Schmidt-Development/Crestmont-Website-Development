// The 104-finding closeout register must stay complete, honest and in sync with its rendered markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRegister, validate, render, AUDIT_PATH, MARKDOWN_PATH, type Register } from "../scripts/closeout-register.ts";

const audit = readFileSync(AUDIT_PATH, "utf8");

test("[TEST-001] closeout register: exactly the 104 original audit findings, each with a valid, evidence-backed disposition", () => {
  const problems = validate(loadRegister(), audit);
  assert.deepEqual(problems, []);
});

test("[TEST-001] closeout register: the rendered markdown is up to date", () => {
  assert.equal(readFileSync(MARKDOWN_PATH, "utf8"), render(loadRegister()));
});

test("[TEST-001] closeout register validator refuses unsupported closures and missing ids", () => {
  const reg = loadRegister();
  const clone = (): Register => JSON.parse(JSON.stringify(reg));
  const a = clone(); a.findings[0].disposition = "CLOSED — VERIFIED"; a.findings[0].commit = null;
  assert.ok(validate(a, audit).some((p) => p.includes("needs commit")));
  const b = clone(); b.findings.pop();
  assert.ok(validate(b, audit).some((p) => p.includes("expected 104")));
  const c = clone(); c.findings[1].id = c.findings[0].id;
  assert.ok(validate(c, audit).some((p) => p.includes("duplicate")));
  const d = clone(); const blocked = d.findings.find((f) => f.disposition.startsWith("BLOCKED"))!; blocked.unblockAction = null;
  assert.ok(validate(d, audit).some((p) => p.includes("unblock action")));
  const e = clone(); e.findings[2].currentPriority = "P4";
  assert.ok(validate(e, audit).some((p) => p.includes("priority changed")));
  const f = clone(); f.findings[3].originalDescription += " (edited)";
  assert.ok(validate(f, audit).some((p) => p.includes("differs from the audit")));
});
