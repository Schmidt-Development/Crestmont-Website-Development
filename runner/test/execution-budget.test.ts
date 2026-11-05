import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SEGMENT_TURNS, MAX_TOTAL_TURNS, MIN_SEGMENT_TURNS, allowanceFor, complexityFromBrief } from "../src/orchestrator/execution-budget.ts";
import { DEFAULT_LIMITS, ProgressGuard } from "../src/orchestrator/progress-guard.ts";

test("[BUDGET-001] a Premium or Custom project is allowed more work than a Starter brochure", () => {
  const starter = allowanceFor({ packageId: "starter", pages: 5 });
  const business = allowanceFor({ packageId: "business", pages: 7 });
  const premium = allowanceFor({ packageId: "premium", pages: 20, integrations: 4, roles: 3, auth: true, payments: true });
  const custom = allowanceFor({ packageId: "custom", pages: 25, integrations: 6, roles: 5, auth: true, payments: true });

  assert.ok(starter.totalTurns < business.totalTurns, `starter ${starter.totalTurns} < business ${business.totalTurns}`);
  assert.ok(business.totalTurns < premium.totalTurns, `business ${business.totalTurns} < premium ${premium.totalTurns}`);
  assert.ok(premium.totalTurns <= custom.totalTurns, `premium ${premium.totalTurns} <= custom ${custom.totalTurns}`);

  // The old universal ceiling was 40 for everything. A Premium site must be able to exceed it across the task.
  assert.ok(premium.totalTurns > 40, `a Premium project gets more than the old 40-turn ceiling (${premium.totalTurns})`);
  assert.ok(business.totalTurns > 40, `and so does a Business one (${business.totalTurns})`);

  // The reason is written in plain words for the build record.
  assert.match(premium.reason, /premium package/);
  assert.match(premium.reason, /authentication/);
  assert.match(premium.reason, /payments/);
});

test("[BUDGET-002] nothing is unlimited: every allowance stays inside its hard bounds", () => {
  const absurd = allowanceFor({ packageId: "custom", pages: 9999, components: 9999, integrations: 9999, roles: 9999, auth: true, payments: true, reviewTasks: 9999 });
  assert.ok(absurd.segmentTurns <= MAX_SEGMENT_TURNS, `segment capped (${absurd.segmentTurns})`);
  assert.ok(absurd.totalTurns <= MAX_TOTAL_TURNS, `total capped (${absurd.totalTurns})`);

  const empty = allowanceFor({ packageId: "starter" });
  assert.ok(empty.segmentTurns >= MIN_SEGMENT_TURNS, "and a floor below which nothing useful can be done");
  assert.ok(empty.totalTurns >= empty.segmentTurns, "a task always gets at least one whole segment");

  // An unknown package must not crash or become unlimited.
  const unknown = allowanceFor({ packageId: "enterprise-plus" });
  assert.ok(unknown.totalTurns > 0 && unknown.totalTurns <= MAX_TOTAL_TURNS);
});

test("[BUDGET-003] complexity is read from the brief without depending on its exact shape", () => {
  const c = complexityFromBrief({
    package: { id: "premium" },
    customerData: { pages: ["Home", "About", "Shop"], functionality: ["contact_form", "Online store", "Customer portal"] },
  }, "business");
  assert.equal(c.packageId, "premium");
  assert.equal(c.pages, 3);
  assert.equal(c.payments, true, "an online store means payments");
  assert.equal(c.auth, true, "a customer portal means authentication");

  // A brief missing everything must still plan, not throw.
  assert.doesNotThrow(() => complexityFromBrief(undefined, "starter"));
  assert.doesNotThrow(() => complexityFromBrief({ customerData: null }, "starter"));
  assert.equal(complexityFromBrief({}, "starter").packageId, "starter");
});

test("[GUARD-001] repeated identical tool calls stop the inspection and force an answer", () => {
  const g = new ProgressGuard();
  assert.equal(g.verdict().strategy, "continue", "a fresh session is progressing");

  for (let i = 0; i < DEFAULT_LIMITS.repeatedToolCalls; i++) g.toolCall("read_file", { path: "src/a.ts" });
  const v = g.verdict();
  assert.equal(v.stall?.kind, "repeated-tool-call");
  assert.equal(v.strategy, "synthesize", "reading the same file again will not help; answer from what is already read");
});

test("[GUARD-002] real progress clears the counters: reading a file twice is not a stall", () => {
  const g = new ProgressGuard();
  g.toolCall("read_file", { path: "a" });
  g.toolCall("read_file", { path: "a" });
  g.deliverable("blueprint section: colour system");
  g.toolCall("read_file", { path: "a" });
  assert.equal(g.verdict().stall, null, "the run was broken by genuine progress");
  assert.match(g.events.join(" "), /blueprint section: colour system/);
});

test("[GUARD-003] unparseable answers ask for synthesis; an unchanged answer stops", () => {
  const json = new ProgressGuard();
  for (let i = 0; i < DEFAULT_LIMITS.invalidJson; i++) json.invalidJson();
  assert.equal(json.verdict().stall?.kind, "invalid-json");
  assert.equal(json.verdict().strategy, "synthesize", "a formatting problem is not fixed by more reading");

  const same = new ProgressGuard();
  for (let i = 0; i < DEFAULT_LIMITS.unchangedOutputs; i++) same.output("{\"brand\": \"identical every time\"}");
  const v = same.verdict();
  assert.equal(v.stall?.kind, "unchanged-output");
  assert.equal(v.strategy, "stop", "the correction is not landing; continuing only spends GPU time");
});

test("[GUARD-004] an overflow that frees nothing stops; one that frees something does not", () => {
  const stuck = new ProgressGuard();
  for (let i = 0; i < DEFAULT_LIMITS.ineffectiveOverflows; i++) stuck.overflow(0);
  assert.equal(stuck.verdict().stall?.kind, "ineffective-overflow");
  assert.equal(stuck.verdict().strategy, "stop");

  const recovering = new ProgressGuard();
  recovering.overflow(0);
  recovering.overflow(12_000);   // a reduction that actually freed room
  recovering.overflow(0);
  assert.equal(recovering.verdict().stall, null, "an effective reduction breaks the run");
});

test("[GUARD-005] re-reading ground it has already covered, with nothing produced, is told to answer", () => {
  // A real reviewer once spent every turn reading files and never answered at all, and the build lost its
  // independent review. But reading many DIFFERENT files is how a large site is understood, so only revisiting
  // ground already covered counts against the session.
  const g = new ProgressGuard();
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
  for (const f of files) g.toolCall("read_file", { path: f });
  assert.equal(g.verdict().stall, null, "covering new ground is progress, not a stall");

  // Now round and round the same three, never consecutively (so this is not the repeated-call rule firing).
  for (let i = 0; i < DEFAULT_LIMITS.inspectionWithoutDeliverable + 1; i++) g.toolCall("read_file", { path: files[i % files.length] });
  const v = g.verdict();
  assert.equal(v.stall?.kind, "inspection-without-deliverable");
  assert.equal(v.strategy, "synthesize");
  assert.match(g.describe(), /inspection-without-deliverable/);
});

test("[GUARD-006] a long exploration of new ground is never mistaken for a loop", () => {
  // The premise of the larger budgets: a Premium site may genuinely inspect a great many files before it can
  // answer. If that tripped the guard, the bigger allowance would be worthless.
  const g = new ProgressGuard();
  for (let i = 0; i < 200; i++) g.toolCall("read_file", { path: `src/area-${i}.ts` });
  assert.equal(g.verdict().stall, null, "200 distinct reads is exploration, not a stall");
  assert.equal(g.verdict().strategy, "continue");
});
