// The runner-to-platform specification contract, tested end to end through the REAL platform validator and the
// REAL storage path — no mocked 200.
//
// This is the test that was missing. Build bld_889ff809c133920c929a7121 failed three times with
//
//   /api/builds/runner/pipeline/spec answered 422:
//   Invalid specification: technicalArchitecture is required; tasks must list at least one task
//
// because PR #140 changed the runner to produce a design-stage specification (technicalArchitecture "", tasks [])
// while src/services/build-pipeline.ts still demanded the full thirteen-field contract. Every existing test either
// validated the runner's builder in isolation or drove the full job with a fixture that already returned a
// complete specification, so nothing ever put the two halves together. These tests do: they import the runner's
// own validateDesignSpec and push its output through storeSpec().
//
// No GPU, no model, no network: Tier 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, MemoryStorage } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import * as PL from "../src/services/build-pipeline.ts";
import * as PH from "../src/services/build-phases.ts";
import { validateDesignSpec, validateArchitectureSpec } from "../runner/src/orchestrator/contracts.ts";
import { newId, nowIso } from "../src/lib/db.ts";

/** Exactly the shape Model A returns for a design-stage plan (see DESIGN_SPEC_JSON_SCHEMA). */
const ARCHITECT_DESIGN_REPLY = {
  schema: "crestmont.master-spec/1",
  projectSpec: "A junk removal and hauling website for a local company in Greater Lansing; the primary conversion goal is qualified quote requests.",
  designSpec: "Sitemap: Home, Services, About, Contact, Request a Quote, Privacy Policy. Home opens on a hero with the quote call to action and the phone number; Services gives each of the nine services its own card. Brand: red #B22234, white and blue #0A3161 used as accents on a neutral ground, a 1.25 type scale and an 8px spacing rhythm. Imagery: one hero plus one image per service. Responsive at 1366, 768 and 390 with no horizontal scroll and a horizontal menu bar above the mobile breakpoint.",
  phasePlan: {
    designDeliverables: [
      "Six pages built and styled from the approved sitemap",
      "A type scale, colour roles and spacing rhythm applied as design tokens",
      "Hero and per-service imagery placed and sized at all three widths",
    ],
    designDependentInteractions: [{ component: "Quote request form", states: ["empty", "invalid", "submitting", "success"], mock: "static fixture in the frontend, no backend" }],
    deferredBackend: [{ capability: "Quote request storage and notification", dependsOnDesign: "Quote request form", realImplementation: "POST handler writing to D1 with server-side validation" }],
    finalQuality: ["Accessible labels and landmarks", "Technical SEO and sitemap", "Security headers"],
  },
  acceptanceCriteria: [
    { id: "ac-pages", text: "All six approved pages exist and are styled", verification: "screenshot" },
    { id: "ac-phone", text: "The public phone number appears on every page", verification: "automated" },
    { id: "ac-nav", text: "Primary navigation is a horizontal bar at 1366px and a working toggle at 390px", verification: "screenshot" },
  ],
  assumptions: ["Draft copy is provisional"],
};

/** A complete specification of the kind stored before staged planning existed. */
const LEGACY_FULL_SPEC = {
  ...ARCHITECT_DESIGN_REPLY,
  technicalArchitecture: "Cloudflare Worker serving static assets with a D1 database for quote requests; POST /api/quote validates and persists, with a rate limit and an audit row.",
  tasks: [{ id: "t-pages", title: "Build the six pages", workstream: "frontend", paths: ["public/"], dependsOn: [] }],
  integrations: [], securityRequirements: [], testingRequirements: [], referenceImages: [],
  masterPrompt: "Build the junk removal website exactly as specified.",
};

async function world() {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: "s", overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  await createStaff(t.db, "owner", "owner@crestmont.test");
  const cu = await createCustomer(t.db, "jitt@contract.example", "Junk in the Trunk");
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
    VALUES (?,?,?,'scope_review',2,'upfront',?,?)`).bind(pid, cu.organizationId, "Junk in the Trunk", nowIso(), nowIso()).run();
  const job = newId("bld");
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, state_reason, strategy, package_id, trigger, attempts, quality_required, created_at, updated_at)
    VALUES (?,?,?,'first_build',0,?,'building','running','standard','business','sweep',1,1,?,?)`)
    .bind(job, pid, cu.organizationId, `${pid}:first`, nowIso(), nowIso()).run();
  const jobRow = { id: job, project_id: pid, organization_id: cu.organizationId, attempts: 1 };
  return { t, job, pid, jobRow };
}

test("[SPEC-CONTRACT] REGRESSION: the runner's own design-stage specification is accepted and stored while the build is in the design phase", async () => {
  const w = await world();
  // Built by the runner's real validator, not hand-written for this test.
  const v = validateDesignSpec(ARCHITECT_DESIGN_REPLY);
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.spec!.technicalArchitecture, "", "the design stage carries no backend architecture");
  assert.deepEqual(v.spec!.tasks, [], "and no task breakdown");
  assert.equal(v.spec!.specStage, "design");

  // The default phase of a new job is design, which is what the live build was in when it got its 422.
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "design");

  // THE REGRESSION: this threw HttpError 422 before the contract was made phase-aware.
  const stored = await PL.storeSpec(w.t.db, w.jobRow, v.spec, "local:qwen3.8:27b-q4_K_M");
  assert.ok(stored.specVersion >= 1, "the specification was stored");

  // It is stored as a design-stage specification, and says so.
  const pipeline = await PL.getPipeline(w.t.db, w.pid);
  const saved = JSON.parse(pipeline!.spec_json!);
  assert.equal(saved.specStage, "design");
  assert.equal(saved.designSpec, ARCHITECT_DESIGN_REPLY.designSpec, "the design plan survived storage intact");
  assert.equal(saved.phasePlan.deferredBackend.length, 1, "the deferred backend is recorded for the functionality phase");
});

test("[SPEC-CONTRACT] the stage is SERVER-authoritative: a design-stage specification is refused once the build has left the design phase", async () => {
  const w = await world();
  const v = validateDesignSpec(ARCHITECT_DESIGN_REPLY);
  await PH.setPhase(w.t.db, w.jobRow, "functionality", "fixture: design certified");
  assert.equal((await PH.phaseOf(w.t.db, w.job)).build_phase, "functionality");

  await assert.rejects(
    () => PL.storeSpec(w.t.db, w.jobRow, v.spec, "local:qwen3.8:27b-q4_K_M"),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 422);
      assert.match(e.message, /full-stage specification/);
      assert.match(e.message, /technicalArchitecture is required/);
      assert.match(e.message, /tasks must list at least one task/);
      return true;
    },
    "design-stage fields must not satisfy the backend-stage completeness check",
  );
});

test("[SPEC-CONTRACT] a runner cannot talk its way past validation: a claimed specStage is ignored in both directions", async () => {
  // Claiming "full" in the design phase does not impose full validation...
  const a = await world();
  const design = validateDesignSpec(ARCHITECT_DESIGN_REPLY).spec!;
  const storedA = await PL.storeSpec(a.t.db, a.jobRow, { ...design, specStage: "full" }, "local:model-a");
  assert.ok(storedA.specVersion >= 1);
  assert.equal(JSON.parse((await PL.getPipeline(a.t.db, a.pid))!.spec_json!).specStage, "design", "the server's phase decided, not the claim");

  // ...and claiming "design" in the functionality phase does not escape it.
  const b = await world();
  await PH.setPhase(b.t.db, b.jobRow, "functionality", "fixture");
  await assert.rejects(
    () => PL.storeSpec(b.t.db, b.jobRow, { ...design, specStage: "design" }, "local:model-a"),
    /full-stage specification/,
    "a runner-declared stage must never weaken validation",
  );
});

test("[SPEC-CONTRACT] a complete legacy specification is still accepted, in the design phase and after it", async () => {
  for (const phase of ["design", "functionality"] as const) {
    const w = await world();
    if (phase !== "design") await PH.setPhase(w.t.db, w.jobRow, phase, "fixture");
    const stored = await PL.storeSpec(w.t.db, w.jobRow, LEGACY_FULL_SPEC, "local:model-a");
    assert.ok(stored.specVersion >= 1, `a full specification stores in the ${phase} phase`);
    const saved = JSON.parse((await PL.getPipeline(w.t.db, w.pid))!.spec_json!);
    assert.equal(saved.tasks.length, 1, "its task breakdown is kept");
    assert.ok(saved.technicalArchitecture.length > 50, "and its architecture");
  }
});

test("[SPEC-CONTRACT] stage 3 completes the design plan into a full specification that the functionality phase accepts", async () => {
  const w = await world();
  const design = validateDesignSpec(ARCHITECT_DESIGN_REPLY).spec!;
  await PL.storeSpec(w.t.db, w.jobRow, design, "local:model-a");

  // What Model A returns for the functional architecture, once the design is certified.
  const architecture = {
    schema: "crestmont.master-spec/1",
    technicalArchitecture: "POST /api/quote validates name, email, phone, customer type, items, preferred date and notes, writes a row to D1 with a rate limit and an audit entry, and queues an outbox notification. GET /admin/quotes lists them behind a staff session.",
    tasks: [
      { id: "t-api", title: "Quote endpoint with server-side validation", workstream: "backend", paths: ["src/"], dependsOn: [] },
      { id: "t-admin", title: "Staff quote list", workstream: "backend", paths: ["public/admin/"], dependsOn: ["t-api"] },
    ],
    integrations: [], securityRequirements: ["Rate limit the quote endpoint"], testingRequirements: ["End-to-end quote submission"],
  };
  const full = validateArchitectureSpec(architecture, design);
  assert.equal(full.ok, true, full.problems.join("; "));
  assert.equal(full.spec!.specStage, "full");
  assert.equal(full.spec!.designSpec, design.designSpec, "the approved design is carried over unchanged, not restated by the architect");
  assert.equal(full.spec!.tasks.length, 2);

  await PH.setPhase(w.t.db, w.jobRow, "functionality", "fixture: design certified");
  const stored = await PL.storeSpec(w.t.db, w.jobRow, full.spec, "local:model-a");
  assert.ok(stored.specVersion >= 2, "the completed specification is stored as a new version");
  const saved = JSON.parse((await PL.getPipeline(w.t.db, w.pid))!.spec_json!);
  assert.equal(saved.specStage, "full");
  assert.equal(saved.tasks.length, 2);
});

test("[SPEC-CONTRACT] stage 3 is validated, not trusted: a missing architecture, no tasks, or a dangling dependency is refused", async () => {
  const design = validateDesignSpec(ARCHITECT_DESIGN_REPLY).spec!;
  const base = { schema: "crestmont.master-spec/1", technicalArchitecture: "x".repeat(100), tasks: [{ id: "t1", title: "A task", workstream: "backend", paths: [], dependsOn: [] }] };

  assert.equal(validateArchitectureSpec(null, design).ok, false);
  assert.match(validateArchitectureSpec({ ...base, technicalArchitecture: "too short" }, design).problems.join(" "), /technicalArchitecture/);
  assert.match(validateArchitectureSpec({ ...base, tasks: [] }, design).problems.join(" "), /at least one task/);
  assert.match(
    validateArchitectureSpec({ ...base, tasks: [{ id: "t1", title: "A", workstream: "backend", paths: [], dependsOn: ["nope"] }] }, design).problems.join(" "),
    /depend on ids that are not in the plan/,
  );
});

test("[SPEC-CONTRACT] a design-stage specification must carry a criterion a screenshot can settle", async () => {
  const w = await world();
  const noShot = {
    ...validateDesignSpec(ARCHITECT_DESIGN_REPLY).spec!,
    acceptanceCriteria: [{ id: "ac-1", text: "The phone number is on every page", verification: "automated" as const }],
  };
  await assert.rejects(
    () => PL.storeSpec(w.t.db, w.jobRow, noShot, "local:model-a"),
    /verification "screenshot"/,
    "a design certified from screenshots needs at least one criterion screenshots can decide",
  );
});
