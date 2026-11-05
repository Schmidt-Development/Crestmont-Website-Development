// Planning (the architect) and phase-aware execution scheduling.
//
// Why these tests exist. On bld_e65768e6b0853a425095a1f6 the architect ran once per segment -- three times -- and
// never produced a specification. The runner cast its reply with `spec = raw as MasterSpec`, so `null` and any
// stray JSON passed straight through; when the reply was unparseable the error became a session note nobody could
// read, and the build carried on as though architecture had succeeded, deciding its own structure. Three segments,
// 16.3 million input tokens, no specification, no imagery, no design score.
//
// The cause was the ask, not the model: MASTER_SPEC_JSON_SCHEMA required thirteen top-level fields in one JSON
// object -- including a complete file-by-file implementation prompt -- from a reasoning model whose thinking
// tokens share one 8,192-token output budget with its answer. Planning is now staged: a validated minimum DESIGN
// specification first, with the implementation-only fields completed deterministically.
//
// The model is a FAKE OpenAI-compatible server. These are mock/unit tests of the runner's contracts and
// scheduling; they are NOT GPU evidence about any real model's planning ability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runJob } from "../src/job.ts";
import type { JobDeps } from "../src/job.ts";
import { ControlPlaneClient } from "../src/control-plane.ts";
import { silentLogger } from "../src/log.ts";
import { DESIGN_SPEC_JSON_SCHEMA, SPEC_SCHEMA, validateDesignSpec } from "../src/orchestrator/contracts.ts";
import { SECTION_ORDER } from "../src/orchestrator/blueprint-sections.ts";
import type { Job } from "../src/protocol.ts";
import type { RunnerConfig } from "../src/config.ts";
import {
  SECRET, claimFrom, fakeDocker, makeConfig, makeJob, makeSkillsDir, startFakeControlPlane, startFakeModel, testManifest, POLLUTED_ENV,
} from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest, FakeCP, FakeModel, FakeDocker } from "./helpers.ts";

const manifest = testManifest();

/** A design specification that satisfies the contract: the shape a real Model A reply has to reach. */
const GOOD = {
  schema: SPEC_SCHEMA,
  projectSpec: "A junk removal website for a local hauling company; the primary conversion goal is qualified quote requests.",
  designSpec: "Sitemap: Home, Services, About, Contact, Request a Quote, Privacy Policy. Home leads with a hero and the quote call to action; Services gives each service its own card. Brand: red #B22234, white, blue #0A3161, a 1.25 type scale and an 8px spacing rhythm. Imagery: a hero image plus one per service. Responsive at 1366, 768 and 390 with no horizontal scroll.",
  phasePlan: {
    designDeliverables: [
      "Six pages built and styled from the approved sitemap",
      "A type scale, colour roles and spacing rhythm as design tokens",
      "Hero and per-service imagery placed at all three widths",
    ],
    designDependentInteractions: [{ component: "Quote form", states: ["empty", "invalid", "success"], mock: "static fixture, no backend" }],
    deferredBackend: [{ capability: "Quote request storage", dependsOnDesign: "Quote form", realImplementation: "POST handler writing to D1 with server-side validation" }],
    finalQuality: ["Accessible labels", "Technical SEO"],
  },
  acceptanceCriteria: [
    { id: "ac-pages", text: "All six pages exist and are styled", verification: "screenshot" },
    { id: "ac-phone", text: "The public phone number appears on every page", verification: "automated" },
    { id: "ac-nav", text: "Primary navigation is a horizontal bar at 1366px", verification: "screenshot" },
  ],
  assumptions: ["Draft copy is provisional"],
};

// ── 9, 10, 11: a missing or malformed specification is detected and never silently accepted ──

test("[AIB-PLAN] a missing, null or non-object architect reply is rejected with a reason (it can no longer be cast to a specification)", () => {
  for (const bad of [null, undefined, 42, "a string", [], true]) {
    const v = validateDesignSpec(bad);
    assert.equal(v.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(v.spec, null);
    assert.ok(v.problems.length > 0, "and must say why");
  }
  assert.match(validateDesignSpec(null).problems.join(" "), /not a JSON object/);
});

test("[AIB-PLAN] a specification missing the design-critical fields is refused, and every problem is named so the retry can be corrective", () => {
  // The thin shape that used to pass straight through as a valid specification.
  const v = validateDesignSpec({ schema: SPEC_SCHEMA, projectSpec: "Plumbing website", designSpec: "Clean, trustworthy" });
  assert.equal(v.ok, false);
  const all = v.problems.join(" | ");
  assert.match(all, /"projectSpec" must be a string of at least 40/);
  assert.match(all, /"designSpec" must be a string of at least 120/);
  assert.match(all, /designDeliverables" must list at least 3/);
  assert.match(all, /"acceptanceCriteria" must list at least 3/);
});

test("[AIB-PLAN] a plan with no screenshot-verifiable criterion is refused: a design is certified from screenshots", () => {
  const v = validateDesignSpec({ ...GOOD, acceptanceCriteria: GOOD.acceptanceCriteria.map((a) => ({ ...a, verification: "automated" })) });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /verification "screenshot"/);
});

test("[AIB-PLAN] the wrong schema string is refused", () => {
  assert.equal(validateDesignSpec({ ...GOOD, schema: "something.else/9" }).ok, false);
});

// ── 12, 13: what the design phase receives, and what is excluded from it ──

test("[AIB-PLAN] a valid design plan is completed into one MasterSpec: site-specific deliverables reach the builder and deferred backend is marked DEFERRED", () => {
  const v = validateDesignSpec(GOOD);
  assert.equal(v.ok, true, v.problems.join("; "));
  const s = v.spec!;
  assert.equal(s.schema, SPEC_SCHEMA);
  assert.equal(s.phasePlan!.designDeliverables.length, 3);
  assert.equal(s.phasePlan!.deferredBackend[0].capability, "Quote request storage");
  // The builder's prompt is derived from the architect's own plan, not invented.
  assert.match(s.masterPrompt, /Build the approved visual design first/);
  assert.match(s.masterPrompt, /Six pages built and styled from the approved sitemap/, "the site-specific deliverables are in the builder's prompt");
  assert.match(s.masterPrompt, /Quote form: empty, invalid, success/, "component states to show with mock data");
  assert.match(s.masterPrompt, /DEFERRED until the design is certified/);
  assert.match(s.masterPrompt, /Quote request storage/);
  assert.doesNotMatch(s.masterPrompt, /^$/);
  // Implementation-only fields are empty rather than fabricated: "not planned yet" is the truth at this stage.
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.integrations, []);
  assert.deepEqual(s.securityRequirements, []);
});

test("[AIB-PLAN] the stage-1 schema asks for the design only: no implementation prompt, task list or technical architecture is required", () => {
  const req = DESIGN_SPEC_JSON_SCHEMA.required as readonly string[];
  assert.deepEqual([...req].sort(), ["acceptanceCriteria", "assumptions", "designSpec", "phasePlan", "projectSpec", "schema"]);
  for (const heavy of ["masterPrompt", "tasks", "technicalArchitecture", "integrations", "testingRequirements", "securityRequirements"]) {
    assert.ok(!req.includes(heavy), `${heavy} must NOT be required of the first planning stage`);
  }
});

test("[AIB-PLAN] values are clamped and defaulted rather than trusted: ids are filled, unknown verifications become manual, oversized lists are bounded", () => {
  const v = validateDesignSpec({
    ...GOOD,
    acceptanceCriteria: [
      { id: "", text: "no id given", verification: "screenshot" },
      { id: "ac-2", text: "bad verification", verification: "telepathy" },
      { id: "ac-3", text: "ok", verification: "automated" },
    ],
    assumptions: Array.from({ length: 200 }, (_, i) => `a${i}`),
  });
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.spec!.acceptanceCriteria[0].id, "ac-1", "a missing id is filled deterministically");
  assert.equal(v.spec!.acceptanceCriteria[1].verification, "manual", "an unknown verification falls back to manual");
  assert.ok(v.spec!.assumptions.length <= 60, `assumptions are bounded (${v.spec!.assumptions.length})`);
});

// ── full-job behaviour: the planning gate, early preview and phase scheduling ──

interface Rig { cp: FakeCP; model: FakeModel; docker: FakeDocker; cfg: RunnerConfig; client: ControlPlaneClient; job: Job }

async function rig(o: { handler: (r: FakeModelRequest, n: number) => FakeModelReply; job?: Partial<Job>; architect?: "local" | "none" }): Promise<Rig> {
  const cp = await startFakeControlPlane({ jobs: [makeJob(o.job)] });
  const model = await startFakeModel(o.handler);
  const docker = fakeDocker();
  const base = makeConfig({ controlPlaneUrl: cp.url, skillsSourceDir: "x" });
  const cfg = makeConfig({
    controlPlaneUrl: cp.url, skillsSourceDir: makeSkillsDir(manifest),
    local: { ...base.local, baseUrl: model.url },
    advisor: { ...base.advisor, architect: o.architect ?? "local" },
  });
  const client = new ControlPlaneClient({ baseUrl: cp.url, secret: SECRET, runnerId: cfg.runnerId, sleep: async () => {}, retry: { attempts: 2, baseMs: 1 } });
  return { cp, model, docker, cfg, client, job: await claimFrom(cp) };
}
const deps = (r: Rig): JobDeps => ({
  cfg: r.cfg, client: r.client, manifest, logger: silentLogger, heartbeatMs: 25, interruptGraceMs: 200, processEnv: POLLUTED_ENV,
  dockerExecutor: r.docker.executor,
});
const isArchitect = (r: FakeModelRequest) => /website architect session/.test(String(r.messages[0]?.content ?? ""));
/** The blueprint stage identifies itself in its own first line; everything else from the architect is stage 1 or 3. */
// Blueprint work arrives two ways: the whole document in one answer, and -- when that does not come -- one
// section at a time. Both are the blueprint stage, so both are counted as it; otherwise a section request would
// be miscounted as a design-specification attempt.
const isBlueprint = (r: FakeModelRequest) => isArchitect(r) && /Your job now is the DESIGN BLUEPRINT|ONE section of the DESIGN BLUEPRINT/.test(r.messages.map((m) => String(m.content ?? "")).join("\n"));
const isDesignSpec = (r: FakeModelRequest) => isArchitect(r) && !isBlueprint(r);
const call = (name: string, args: Record<string, unknown>): FakeModelReply => ({ toolCalls: [{ name, arguments: args }] });
/** Runner instructions the builder was actually given (one per scheduled phase). */
const builderInstructions = (m: FakeModel): string[] => {
  const seen = new Set<string>();
  for (const r of m.requests) {
    if (isArchitect(r)) continue;
    for (const msg of r.messages) {
      const c = String(msg.content ?? "");
      if (msg.role === "user" && /^(Phase \d|Repair|This build is continuing)/.test(c)) seen.add(c.split("\n")[0].slice(0, 40));
    }
  }
  return [...seen];
};

test("[AIB-PLAN] the planner cannot silently proceed: an architect that never returns a valid specification fails the build BEFORE any implementation turn, with an actionable diagnosis", async () => {
  let builderCalls = 0;
  const r = await rig({
    handler: (q) => {
      // The real failure mode: a reply truncated mid-object, so the last "}" is an inner brace.
      if (isArchitect(q)) return { content: '{"schema":"crestmont.master-spec/1","projectSpec":"A junk removal website for a local hauling company","designSpec":"Sitemap: Home, Services' };
      builderCalls++;
      return call("finish", { summary: "should never run" });
    },
  });
  try {
    const s = await runJob(r.job, deps(r));
    assert.equal(s.outcome, "failed", String(s.complete?.error));
    assert.equal(s.stopReason, "architect_failed");
    const err = String(s.complete?.error);
    assert.match(err, /could not produce a valid design specification in 3 attempts/);
    assert.match(err, /No implementation turns were spent/);
    assert.match(err, /LOCAL_MODEL_MAX_OUTPUT_TOKENS/, "the diagnosis names the setting to change");
    assert.equal(builderCalls, 0, "not one builder turn was spent on an unplanned build");
    // The architect tried more than once, and every failure is reported where a person can read it.
    const architectCalls = r.model.requests.filter(isArchitect).length;
    assert.ok(architectCalls >= 3, `the architect was retried (${architectCalls} sessions)`);
    const notes = JSON.stringify(r.cp.calls.filter((c) => c.path.endsWith("/heartbeat")).map((c) => c.body));
    assert.match(notes, /invalid design specification|did not produce a valid specification/, "the reason reached the platform, not just a local note");
  } finally { await r.model.close(); await r.cp.close(); }
});

test("[AIB-PLAN] malformed output gets a bounded corrective retry: the problems are fed back, and a corrected reply is accepted and stored", async () => {
  let attempt = 0;
  const seenCorrections: string[] = [];
  const r = await rig({
    handler: (q) => {
      if (isArchitect(q)) {
        attempt++;
        const last = String(q.messages.at(-1)?.content ?? "") + String(q.messages[1]?.content ?? "");
        if (/previous reply was REJECTED/.test(last)) seenCorrections.push(last);
        // First attempt: valid JSON but missing the design-critical fields. Second: corrected.
        return { content: attempt === 1 ? JSON.stringify({ schema: SPEC_SCHEMA, projectSpec: "too short", designSpec: "short" }) : JSON.stringify(GOOD) };
      }
      return call("finish", { summary: "built" });
    },
  });
  try {
    const s = await runJob(r.job, deps(r));
    assert.notEqual(s.stopReason, "architect_failed", "the corrected plan was accepted");
    assert.ok(seenCorrections.length >= 1, "the second architect call carried the rejection and its reasons");
    assert.match(seenCorrections[0], /"designSpec" must be a string of at least 120/, "the specific problems were fed back");
    assert.match(seenCorrections[0], /return the corrected JSON object only/);
    // The accepted plan is on disk for the builder and was offered to the platform.
    const repo = path.join(s.workspace!, "repo");
    assert.ok(existsSync(path.join(repo, "SPEC.json")), "SPEC.json was written");
    const spec = JSON.parse(readFileSync(path.join(repo, "SPEC.json"), "utf8"));
    assert.equal(spec.phasePlan.designDeliverables.length, 3);
    assert.ok(r.cp.calls.some((c) => c.path.endsWith("/pipeline/spec")), "the specification was sent to the platform");
    // Planning is bounded, not an open loop -- per STAGE. The design specification took two attempts (one
    // rejection, one corrected). The blueprint stage is bounded too, but its bound is now three whole-document
    // attempts PLUS at most one pass over the sections: when the single enormous answer does not arrive, the
    // blueprint is asked for a section at a time rather than abandoned. That is still a fixed, small number of
    // requests -- a blueprint that never validates is never retried forever.
    assert.ok(r.model.requests.filter(isDesignSpec).length <= 3, "the design specification stage is bounded");
    assert.ok(r.model.requests.filter(isBlueprint).length <= 3 + SECTION_ORDER.length,
      `the blueprint stage is bounded (${r.model.requests.filter(isBlueprint).length} requests)`);
  } finally { await r.model.close(); await r.cp.close(); }
});

// ── 14, 16, 22: the first preview is captured early, and the design phase schedules design work only ──

test("[AIB-PLAN] in the design phase the runner schedules the build only — no full-stack verify phase — and stores the first frontend preview before any review", async () => {
  const r = await rig({
    job: { phase: "design" },
    architect: "none", // planning is covered above; this test is about scheduling
    handler: (q) => {
      void q;
      return call("finish", { summary: "built" });
    },
  });
  try {
    const s = await runJob(r.job, deps(r));
    void s;
    const instructions = builderInstructions(r.model);
    assert.ok(instructions.some((i) => /^Phase 2/.test(i)), `the build phase ran (${instructions.join(" | ")})`);
    assert.ok(!instructions.some((i) => /^Phase 3/.test(i)), `the design phase does NOT run the full-stack verify phase (${instructions.join(" | ")})`);
    // The first preview is stored, and it is stored BEFORE any review cycle is submitted. On the real build the
    // snapshot sat behind the full acceptance block, the platform's turn limit tripped first, and nothing was
    // ever stored: 0 revisions, 0 cycles, 0 scorecards.
    const paths = r.cp.calls.map((c) => c.path);
    const firstStore = paths.findIndex((p) => p.endsWith("/revisions/store"));
    const firstSubmit = paths.findIndex((p) => p.endsWith("/cycles/submit"));
    assert.ok(firstStore >= 0, `a revision was stored (${[...new Set(paths)].join(", ")})`);
    if (firstSubmit >= 0) assert.ok(firstStore < firstSubmit, "the preview is stored before the first review cycle");
    const stored = r.cp.calls.find((c) => c.path.endsWith("/revisions/store"))!;
    assert.equal(stored.body.cycle, 0, "the first preview is revision 0");
    assert.ok(Array.isArray(stored.body.files) && (stored.body.files as unknown[]).length > 0, "it carries real files");
  } finally { await r.model.close(); await r.cp.close(); }
});

test("[AIB-PLAN] a platform that reports no phase keeps the original plan/build/verify sequence (legacy builds are unchanged)", async () => {
  const r = await rig({
    job: { phase: undefined },
    architect: "none",
    handler: () => call("finish", { summary: "ok" }),
  });
  try {
    await runJob(r.job, deps(r));
    const instructions = builderInstructions(r.model);
    assert.ok(instructions.some((i) => /^Phase 2/.test(i)), "the build phase ran");
    assert.ok(instructions.some((i) => /^Phase 3/.test(i)), `a build with no reported phase still verifies (${instructions.join(" | ")})`);
  } finally { await r.model.close(); await r.cp.close(); }
});

// ── Failure B: retries are classified, and an overflow comes back SMALLER ──

test("[AIB-PLAN] a context overflow shrinks the next request instead of repeating it, and the correction text is not appended", async () => {
  const sizes: number[] = [];
  const sawCorrection: boolean[] = [];
  let architectCall = 0;
  const r = await rig({
    handler: (q) => {
      if (!isArchitect(q)) return call("finish", { summary: "built" });
      architectCall++;
      const parts = Array.isArray(q.messages[1]?.content) ? q.messages[1].content as { type: string }[] : [];
      sizes.push(parts.filter((p) => p.type === "image_url").length);
      sawCorrection.push(/previous reply was REJECTED/.test(JSON.stringify(q.messages)));
      // The model server refuses the first two attempts for context size, exactly as Ollama did.
      if (architectCall <= 2) return { status: 400, body: JSON.stringify({ error: { message: "request (49186 tokens) exceeds the available context size (49152 tokens), try increasing it", type: "invalid_request_error" } }) };
      return { content: JSON.stringify(GOOD) };
    },
  });
  try {
    const s = await runJob(r.job, deps(r));
    // The build is not expected to succeed here; what matters is HOW it retried.
    void s;
    assert.ok(sizes.length >= 2, `the architect was called more than once (${sizes.length})`);
    // An overflow must never be resubmitted unchanged: the image cap halves each time.
    assert.ok(sizes[1] <= sizes[0], `attempt 2 carried no more images than attempt 1 (${sizes[0]} -> ${sizes[1]})`);
    if (sizes.length >= 3) assert.ok(sizes[2] <= sizes[1], `and attempt 3 shrank again (${sizes[1]} -> ${sizes[2]})`);
    // Appending the rejection text is what tipped the real request over the window, so an overflow retry must not.
    assert.ok(!sawCorrection[1], "the overflow retry does not append the rejection text");
    // The classification is recorded where a person can read it.
    const notes = JSON.stringify(r.cp.calls.filter((c) => c.path.endsWith("/heartbeat")).map((c) => c.body));
    assert.match(notes, /\[overflow\]/, "the failure is classified as an overflow in the build's own notes");
    // And so is the change that made the next request smaller. There are now two remedies, and either is valid:
    // the session reduces itself and carries on (clipping tool output, dropping inspection turns, and only as a
    // last resort an image), or -- when it cannot be reduced far enough -- the attempt-level handler halves the
    // image cap and tries again. The first is preferred because it keeps the inspection already paid for; before
    // it existed, a request 33 tokens over the window threw away nine minutes of architect work on
    // bld_dcb3063d445e6f8890d66516 and the build finished with no Design Blueprint at all.
    assert.match(notes, /images capped at|clipped \d+ tool output|dropped \d+ inspection message|gave up \d+ image/,
      "and the change made so the next request is smaller is recorded");
  } finally { await r.model.close(); await r.cp.close(); }
});

test("[AIB-PLAN] a permission failure is not retried: it cannot fix itself and each attempt costs a model load", async () => {
  let architectCalls = 0;
  const r = await rig({
    handler: (q) => {
      if (!isArchitect(q)) return { toolCalls: [{ name: "finish", arguments: { summary: "x" } }] };
      architectCalls++;
      return { status: 401, body: JSON.stringify({ error: { message: "unauthorized: bad api key" } }) };
    },
  });
  try {
    const s = await runJob(r.job, deps(r));
    assert.equal(s.stopReason, "architect_failed");
    assert.equal(architectCalls, 1, `a permission failure is attempted once, not three times (${architectCalls})`);
    const notes = JSON.stringify(r.cp.calls.filter((c) => c.path.endsWith("/heartbeat")).map((c) => c.body));
    assert.match(notes, /\[permission\]/);
    assert.match(notes, /not retried/);
  } finally { await r.model.close(); await r.cp.close(); }
});

test("[AIB-PLAN] a RESUMED build with a stored specification still gets its design blueprint", async () => {
  // The blueprint stage used to sit inside `if (!spec && architect)`, so a resumed build -- which already has a
  // stored specification and skips planning entirely -- never produced one. That is exactly the path a retry of
  // bld_10e2c6007686faee0ab64d45 takes: it has a specification from attempt 1 and a saved checkpoint, so the one
  // build this work exists to fix would have resumed with no blueprint at all.
  const stored = validateDesignSpec(GOOD).spec!;
  let blueprintAsked = 0;
  const r = await rig({
    job: { spec: { version: 1, content: stored as unknown as Record<string, unknown> } } as Partial<Job>,
    handler: (q) => {
      if (isBlueprint(q)) { blueprintAsked++; return { content: "{}" }; }   // rejected, but it was ASKED
      if (isArchitect(q)) return { content: JSON.stringify(GOOD) };
      return call("finish", { summary: "built" });
    },
  });
  try {
    await runJob(r.job, deps(r));
    assert.ok(blueprintAsked >= 1, "the blueprint stage must run for a build that already has a specification");
    assert.ok(r.model.requests.filter(isDesignSpec).length === 0, "and planning itself must NOT re-run: the specification is already stored");
  } finally { await r.model.close(); await r.cp.close(); }
});
