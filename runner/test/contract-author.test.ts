// Drafting the integration contract: what the authoring session is told, and what the loop does with a refusal.
//
// The Founder's decision of 2026-11-07 is that Model A drafts the contract for every uploaded frontend. Nothing
// in this file decides whether a draft is ACCEPTED -- that is the platform's deterministic validator, tested in
// tests/design-locked.test.ts, deliberately on the other side of the wire. What is tested here is the part the
// runner owns: that the session is given the measurement in full and told the rules it will be held to, that the
// two hashes the platform checks are stamped rather than transcribed, and that the correction loop is bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_ATTEMPTS, CONTRACT_JSON_SCHEMA, contractPrompt, draftAndSubmitContract, stamp,
  type ContractAuthoringInput, type ContractSubmission,
} from "../src/frontend/contract-author.ts";
import type { ImportInteraction, ImportRoute } from "../src/frontend/import.ts";

const route = (page: string, over: Partial<ImportRoute> = {}): ImportRoute => ({
  page, file: `${page}.html`, title: `${page} page`, navs: 1, navLinks: 4, stylesheets: 1, images: 2, headings: 3,
  overflowPx: 0, ...over,
});

const interaction = (over: Partial<ImportInteraction> = {}): ImportInteraction => ({
  page: "index", element: "form#quote", role: "form", label: "Request a quote",
  needsBackend: true, functional: false, evidence: "a form with 3 inputs and a submit button",
  viewports: ["desktop"], ...over,
});

const input = (over: Partial<ContractAuthoringInput> = {}): ContractAuthoringInput => ({
  projectId: "prj_1",
  artifactSha: "a".repeat(64),
  designFingerprint: "b".repeat(64),
  routes: [route("index"), route("contact")],
  interactions: [
    interaction({ fields: 3, fieldNames: ["name", "email", "detail"], method: "post", action: "/quote", submits: true }),
    interaction({ page: "contact", element: "form#booking", label: "Book a visit" }),
    interaction({ page: "index", element: "button.nav-toggle", role: "button", label: "Menu", needsBackend: false, functional: true }),
  ],
  ...over,
});

test("[CA-01] the session is given every measured page and element, and told which need a backend", () => {
  const p = contractPrompt(input());

  // Every page, because an operation may only name one of these and the model has no other way to know them.
  assert.match(p, /"index"/);
  assert.match(p, /"contact"/);

  // Every element, with the facts the measurement actually found. The identifier has to be copied exactly, so it
  // has to be shown exactly.
  assert.match(p, /form#quote/);
  assert.match(p, /form#booking/);
  assert.match(p, /button\.nav-toggle/);
  assert.match(p, /fields: name, email, detail/, p.slice(0, 400));
  assert.match(p, /method post/);

  // And which of them are waiting for a backend -- the distinction the coverage check is made of. An element that
  // already works is not work, and a plan that treats it as work is a plan to rewrite working behaviour.
  const quoteLine = p.split("\n").find((l) => l.includes("form#quote"))!;
  assert.match(quoteLine, /NEEDS A BACKEND/, quoteLine);
  const navLine = p.split("\n").find((l) => l.includes("button.nav-toggle"))!;
  assert.match(navLine, /ALREADY WORKS/, navLine);

  // The rules it will be judged by, stated to it rather than discovered through refusals.
  assert.match(p, /COVER THE WHOLE FRONTEND/);
  assert.match(p, /UNDETERMINED/, "it must be told why a criterion with no probe is worthless");
  assert.match(p, /DO NOT INVENT/);
  assert.match(p, /missing/, "and where a requirement it cannot establish is supposed to go");

  // The schema, so the answer has a shape. And no design work: the frontend is approved and frozen.
  assert.ok(p.includes(JSON.stringify(CONTRACT_JSON_SCHEMA)), "the schema travels with the prompt");
  assert.match(p, /not designing anything/i);
});

test("[CA-02] a refused draft comes back as corrections, and nothing else changes", () => {
  const problems = [
    "uncovered-interaction: \"form#booking\" on page \"contact\" needs a backend and no operation claims it.",
    "no-probe [quote-request]: a form-submit operation is served over HTTP.",
  ];
  const p = contractPrompt(input({ corrections: problems }));

  assert.match(p, /PREVIOUS DRAFT WAS REFUSED/);
  for (const why of problems) assert.ok(p.includes(why), `the objection must reach the session verbatim: ${why}`);
  // The one shortcut that would make a refusal disappear while making the work worse.
  assert.match(p, /do not drop an operation to make an objection go away/i);

  // A first draft is not told it was refused.
  assert.doesNotMatch(contractPrompt(input()), /REFUSED/);
});

test("[CA-03] the artifact checksum and design fingerprint are stamped, not transcribed", () => {
  const i = input();
  // A model that got them wrong, or left them out, or wrote the right ones. All three come out the same, because
  // these two values are the platform's own and a typo in a 64-character hash is not a contract defect.
  for (const draft of [
    { operations: [{ id: "x" }] },
    { operations: [{ id: "x" }], artifactSha: "wrong", designFingerprint: "also wrong" },
    { operations: [{ id: "x" }], schema: "crestmont.master-spec/1" },
  ]) {
    const m = stamp(draft, i);
    assert.equal(m.schema, "crestmont.integration-manifest/1");
    assert.equal(m.artifactSha, i.artifactSha);
    assert.equal(m.designFingerprint, i.designFingerprint);
    assert.equal(m.operations.length, 1, "and the plan itself is untouched");
  }

  // Nothing at all still produces a well-formed object for the platform to refuse on its merits, rather than a
  // crash inside the runner that would lose the import's own outcome.
  const empty = stamp(null, i);
  assert.deepEqual(empty.operations, []);
  assert.equal(empty.artifactSha, i.artifactSha);
});

test("[CA-04] the loop corrects against the validator and stops at its bound", async () => {
  const prompts: string[] = [];
  const submitted: number[] = [];
  const refusal = (n: number): ContractSubmission => ({ recorded: false, problems: [`objection ${n}`] });

  // A model that never satisfies the validator. The point is that this terminates: an unbounded correction cycle
  // is a runner spending a GPU for ever on one artifact while reporting nothing, which is worse than a project
  // that waits visibly with its reasons recorded.
  const never = await draftAndSubmitContract({
    input: input(),
    author: async (i) => { prompts.push(contractPrompt(i)); return { operations: [] }; },
    submit: async (r) => { submitted.push(r.attempt); return refusal(r.attempt); },
  });
  assert.equal(never.recorded, false);
  assert.equal(never.attempts, CONTRACT_ATTEMPTS);
  assert.deepEqual(submitted, [1, 2, 3], "three drafts, then it stops");
  assert.equal(prompts.length, 3);
  // Each draft after the first was told what the last one got wrong.
  assert.doesNotMatch(prompts[0], /objection/);
  assert.match(prompts[1], /objection 1/);
  assert.match(prompts[2], /objection 2/);
  assert.deepEqual(never.problems, ["objection 3"], "and the objections to the LAST draft are what it reports");

  // One that is accepted on the second try stops there, and reports what the platform did with it.
  let n = 0;
  const eventually = await draftAndSubmitContract({
    input: input(),
    author: async () => ({ operations: [] }),
    submit: async (r) => (++n === 1 ? refusal(r.attempt) : { recorded: true, version: 4, queued: "bld_7" }),
  });
  assert.equal(eventually.recorded, true);
  assert.equal(eventually.attempts, 2);
  assert.equal(eventually.submission?.queued, "bld_7");
});

test("[CA-05] a refusal with no reasons stops at once rather than redrafting against nothing", async () => {
  let drafts = 0;
  // What a platform with no contract channel looks like from here: not accepted, and nothing to correct. Drafting
  // again would produce the same object and the same silence, three times over, for nothing.
  const r = await draftAndSubmitContract({
    input: input(),
    author: async () => { drafts++; return { operations: [] }; },
    submit: async () => ({ recorded: false, problems: [] }),
  });
  assert.equal(r.recorded, false);
  assert.equal(drafts, 1, "one attempt, because a second could not differ");
});
