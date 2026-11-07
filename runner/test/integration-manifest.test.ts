// The plan for making an approved frontend work, validated before any of it runs.
//
// The manifest is the only thing that authorises content change (the design lock reads it) and the only thing
// that makes "nothing was left as a dead button" checkable. Both of those are worthless if a malformed or
// self-contradictory plan is accepted, so this is where that is settled. §17 items 11-15.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_SCHEMA, coverage, declaredChanges, describeManifest, describeManifestProblems,
  executionOrder, requiresRelease, validateManifest,
} from "../src/frontend/integration-manifest.ts";
import type { IntegrationManifest, IntegrationOperation, InteractionItem } from "../src/frontend/integration-manifest.ts";
import { captureBaseline, compareToBaseline, describeDrift } from "../src/frontend/design-lock.ts";
import type { DesignSignature } from "../src/frontend/design-lock.ts";

const DESIGN = "d".repeat(64);
const ART = "a".repeat(64);
const PAGES = ["index", "services", "quote", "contact"];

const op = (over: Partial<IntegrationOperation> = {}): IntegrationOperation => ({
  id: "op-quote-form",
  page: "quote",
  element: "form#quote-request",
  kind: "form-submit",
  behaviour: "Submit a haul quote request, store it, and email the operator.",
  expectChange: "content",
  acceptance: ["a submitted request appears in the operator inbox", "an invalid postcode shows the form's own error style"],
  dataModel: [{ table: "quote_requests", fields: ["name", "phone", "postcode", "load_size"] }],
  ...over,
});

const manifest = (ops: IntegrationOperation[] = [op()], over: Partial<IntegrationManifest> = {}): IntegrationManifest => ({
  schema: MANIFEST_SCHEMA, artifactSha: ART, designFingerprint: DESIGN, operations: ops, ...over,
});

const valid = (m: unknown) => validateManifest(m, { approvedPages: PAGES, designFingerprint: DESIGN, artifactSha: ART });
const codes = (p: { code: string }[]) => p.map((x) => x.code);

test("[IM-001] a well-formed plan validates, and the schema version is not optional", () => {
  const r = valid(manifest());
  assert.equal(r.ok, true, describeManifestProblems(r.problems));
  assert.ok(r.manifest, "the validated manifest is handed back");
  assert.deepEqual(r.problems, []);

  assert.equal(valid({ ...manifest(), schema: "crestmont.integration-manifest/2" }).ok, false, "a version this code does not understand is not guessed at");
  assert.ok(codes(valid({ ...manifest(), schema: undefined }).problems).includes("schema"));
  assert.equal(valid("a plan, honestly").ok, false);
  assert.ok(codes(valid({ schema: MANIFEST_SCHEMA }).problems).includes("no-operations"));
  assert.ok(codes(valid(manifest([])).problems).includes("empty-plan"), "a plan that would make nothing functional is not a plan");
});

test("[IM-002] the plan must be for the approved design, and may not invent pages", () => {
  // A plan written against an earlier baseline would authorise content change on pages since re-approved.
  const stale = valid({ ...manifest(), designFingerprint: "e".repeat(64) });
  assert.equal(stale.ok, false);
  assert.ok(codes(stale.problems).includes("design-mismatch"), describeManifestProblems(stale.problems));
  assert.match(stale.problems[0].detail, /eeeeeeeeeeee/, "both fingerprints are named so the mismatch is actionable");

  const wrongArtifact = valid({ ...manifest(), artifactSha: "b".repeat(64) });
  assert.ok(codes(wrongArtifact.problems).includes("artifact-mismatch"));

  const invented = valid(manifest([op({ page: "admin-dashboard" })]));
  assert.equal(invented.ok, false);
  const p = invented.problems.find((x) => x.code === "unapproved-page")!;
  assert.match(p.detail, /"admin-dashboard", which is not a page of the approved design/);
  assert.equal(p.operationId, "op-quote-form", "the problem is attributed to the operation that caused it");
});

test("[IM-003] an operation nobody could verify is rejected, not planned", () => {
  const noAcceptance = valid(manifest([op({ acceptance: [] })]));
  assert.equal(noAcceptance.ok, false);
  assert.ok(codes(noAcceptance.problems).includes("no-acceptance"));
  assert.match(noAcceptance.problems[0].detail, /no way to tell whether it works/);

  assert.ok(codes(valid(manifest([op({ acceptance: ["   "] })])).problems).includes("no-acceptance"), "whitespace is not a criterion");

  // The other fields that make an operation meaningful.
  assert.ok(codes(valid(manifest([op({ behaviour: "" })])).problems).includes("operation-behaviour"));
  assert.ok(codes(valid(manifest([op({ element: "" })])).problems).includes("operation-element"));
  assert.ok(codes(valid(manifest([op({ kind: "vibes" as never })])).problems).includes("operation-kind"));
  assert.ok(codes(valid(manifest([op({ id: undefined as never })])).problems).includes("operation-id"));

  // expectChange is what the design lock reads. Leaving it out would make drift unclassifiable.
  const noExpect = valid(manifest([op({ expectChange: undefined as never })]));
  assert.ok(codes(noExpect.problems).includes("expect-change"));
  assert.match(noExpect.problems[0].detail, /changes the page's content/);

  // A data write with no table named is a warning: the plan is still executable, just vaguer than it should be.
  const vague = valid(manifest([op({ dataModel: undefined })]));
  assert.equal(vague.ok, true, "a warning does not block the plan");
  assert.deepEqual(codes(vague.problems), ["no-data-model"]);
});

test("[IM-004] duplicate ids, dangling dependencies and dependency loops are all caught", () => {
  const dupe = valid(manifest([op({ id: "x" }), op({ id: "x", page: "contact" })]));
  assert.ok(codes(dupe.problems).includes("duplicate-id"));

  const dangling = valid(manifest([op({ id: "a", dependsOn: ["ghost"] })]));
  assert.ok(codes(dangling.problems).includes("unknown-dependency"));
  assert.match(dangling.problems[0].detail, /depends on "ghost", which is not in the plan/);

  // A loop means no operation can ever start, and a topological sort would silently drop all of them.
  const loop = valid(manifest([
    op({ id: "a", dependsOn: ["c"] }),
    op({ id: "b", page: "contact", dependsOn: ["a"] }),
    op({ id: "c", page: "services", dependsOn: ["b"] }),
  ]));
  assert.equal(loop.ok, false);
  const cyc = loop.problems.find((x) => x.code === "dependency-cycle")!;
  assert.match(cyc.detail, /a → c → b → a|c → b → a → c|b → a → c → b/, cyc.detail);
  assert.equal(executionOrder(manifest([op({ id: "a", dependsOn: ["b"] }), op({ id: "b", dependsOn: ["a"] })])), null, "and no order is invented for it");
});

test("[IM-005] execution order puts dependencies first without reshuffling the rest", () => {
  const m = manifest([
    op({ id: "quote-form", dependsOn: ["db-schema"] }),
    op({ id: "db-schema", page: "index", kind: "data-write", element: "n/a", expectChange: "none" }),
    op({ id: "service-list", page: "services", kind: "data-read", element: "ul.services", expectChange: "content" }),
  ]);
  const order = executionOrder(m)!.map((o) => o.id);
  assert.deepEqual(order, ["db-schema", "quote-form", "service-list"]);
  assert.equal(order.length, m.operations.length, "every operation appears exactly once");
});

test("[IM-006] the manifest is what tells the design lock which pages may change", () => {
  const m = manifest([
    op({ id: "quote-form", page: "quote", expectChange: "content" }),
    op({ id: "quote-validate", page: "quote", element: "input#postcode", kind: "data-read", expectChange: "none" }),
    op({ id: "phone-link", page: "contact", element: "a.tel", kind: "navigation", expectChange: "none", acceptance: ["the number dials"] }),
  ]);
  const d = declaredChanges(m);

  // One entry per PAGE, because the lock compares pages. A page with any content operation is declared changing.
  assert.equal(d.length, 2);
  const quote = d.find((x) => x.page === "quote")!;
  assert.equal(quote.expect, "content");
  assert.match(quote.reason!, /quote-form \(form#quote-request\)/, "the reason names the operation, so a drift report says why");
  assert.ok(!quote.reason!.includes("quote-validate"), "and only the operations that actually change content");

  assert.equal(d.find((x) => x.page === "contact")!.expect, "none");
});

test("[IM-007] the two modules interlock: a declared change passes the lock, an undeclared one does not", () => {
  const sig = (page: string): DesignSignature => ({
    page, viewport: "desktop",
    skeleton: ["header.nav", "main.stack", "footer.foot"],
    palette: ["rgb(31, 61, 43)", "rgb(217, 131, 36)"],
    fonts: ["Inter"], typeScale: [16, 40],
    landmarks: [{ sel: "header", x: 0, y: 0, w: 1440, h: 88 }, { sel: "main", x: 0, y: 88, w: 1440, h: 2000 }, { sel: "footer", x: 0, y: 2088, w: 1440, h: 200 }],
    docHeight: 2288,
  });
  const baseline = captureBaseline({
    artifactSha: ART, sourceFingerprint: "src", approvedBy: "Founder (Noah)",
    signatures: [sig("quote"), sig("contact")],
    renders: [{ page: "quote", viewport: "desktop", sha: "q1" }, { page: "contact", viewport: "desktop", sha: "c1" }],
  });

  const m = manifest([
    op({ id: "quote-form", page: "quote", expectChange: "content" }),
    op({ id: "phone-link", page: "contact", element: "a.tel", kind: "navigation", expectChange: "none", acceptance: ["the number dials"] }),
  ]);
  const check = validateManifest(m, { approvedPages: ["quote", "contact"], designFingerprint: baseline.fingerprint, artifactSha: ART });
  assert.equal(check.ok, false, "the fixture's placeholder fingerprint is not this baseline's — the mismatch IS caught");

  // Written against the real baseline, the plan validates and its declarations satisfy the lock.
  const real = { ...m, designFingerprint: baseline.fingerprint };
  const ok = validateManifest(real, { approvedPages: ["quote", "contact"], designFingerprint: baseline.fingerprint, artifactSha: ART });
  assert.equal(ok.ok, true, describeManifestProblems(ok.problems));

  // The quote page now renders real data; contact is untouched. Design intact on both.
  const after = compareToBaseline(baseline, [sig("quote"), sig("contact")], {
    declared: declaredChanges(ok.manifest!),
    renders: [{ page: "quote", viewport: "desktop", sha: "q2" }, { page: "contact", viewport: "desktop", sha: "c1" }],
  });
  assert.equal(after.ok, true, describeDrift(after));
  assert.deepEqual(after.findings.map((f) => f.kind), ["declared-content"]);

  // The same rendering change on contact, which the plan said would NOT change, is a finding.
  const sneaky = compareToBaseline(baseline, [sig("quote"), sig("contact")], {
    declared: declaredChanges(ok.manifest!),
    renders: [{ page: "quote", viewport: "desktop", sha: "q2" }, { page: "contact", viewport: "desktop", sha: "c9" }],
  });
  assert.equal(sneaky.ok, false);
  assert.ok(sneaky.findings.some((f) => f.kind === "undeclared-content" && f.page === "contact"));
});

test("[IM-008] an interaction the plan forgot is reported, so nothing ships as a dead button", () => {
  const inventory: InteractionItem[] = [
    { page: "quote", element: "form#quote-request", role: "form", needsBackend: true },
    { page: "services", element: "button#book-now", role: "button", needsBackend: true },
    { page: "contact", element: "a.tel", role: "link", needsBackend: false },
    { page: "index", element: "button.menu-toggle", role: "button", needsBackend: false },
  ];
  const c = coverage(manifest([op()]), inventory);

  assert.equal(c.needingBackend, 2, "the phone link and the menu toggle need no backend and are not counted against the plan");
  assert.equal(c.covered, 1);
  assert.deepEqual(c.uncovered.map((i) => i.element), ["button#book-now"], "the booking button nobody planned for");
  assert.match(describeManifest(manifest([op()]), c), /1 interaction\(s\) needing a backend are NOT in the plan: services\/book-now|button#book-now/);

  // A complete plan says so.
  const full = manifest([op(), op({ id: "book", page: "services", element: "button#book-now", kind: "data-write", acceptance: ["a booking is stored"], dataModel: [{ table: "bookings", fields: ["slot"] }] })]);
  const cf = coverage(full, inventory);
  assert.deepEqual(cf.uncovered, []);
  assert.match(describeManifest(full, cf), /every interaction needing a backend is covered \(2\/2\)/);

  // And an operation aimed at an element that is not in the approved frontend at all.
  const ghost = coverage(manifest([op({ page: "quote", element: "form#does-not-exist" })]), inventory);
  assert.deepEqual(ghost.unmatched.map((o) => o.element), ["form#does-not-exist"]);
});

test("[IM-009] operations that spend money or grant access are flagged for a person to release", () => {
  const m = manifest([
    op({ id: "pay", page: "quote", element: "button#pay", kind: "payment", acceptance: ["a test charge succeeds"], dataModel: [{ table: "payments", fields: ["amount"] }] }),
    op({ id: "login", page: "index", element: "form#login", kind: "auth", acceptance: ["a known user signs in"] }),
    op({ id: "list", page: "services", element: "ul.services", kind: "data-read", expectChange: "content", acceptance: ["real services are listed"] }),
  ]);
  const gated = requiresRelease(m).map((o) => o.id);
  assert.deepEqual(gated.sort(), ["login", "pay"], "reading a list is not release-gated; taking a payment and signing a user in are");

  const desc = describeManifest(m);
  assert.match(desc, /2 need a person to release them/);
  assert.match(desc, /payment|auth/);
  assert.match(describeManifest(m), /3 operation\(s\) across 3 page\(s\)/);

  // Out-of-scope work is stated in the plan rather than discovered at the end.
  assert.match(describeManifest({ ...m, outOfScope: ["no live Stripe keys until release"] }), /out of scope: no live Stripe keys until release/);
});

test("[IM-010] an acceptance probe must point at a criterion that exists and a surface the contract declared", () => {
  // A probe is the executable form of a written criterion. Pointed at the wrong index it would silently establish a
  // different criterion from the one it checked; pointed at an undeclared path it would verify the contract against
  // an endpoint the contract never agreed to. Either turns the gate into a thing that reports rather than checks.
  const apis = [{ method: "POST", path: "/api/quotes", auth: "public" as const, success: 201, invalid: 422 }];

  const good = valid(manifest([op({ acceptanceProbes: [{ criterion: 1, as: "anonymous", path: "/api/quotes", method: "POST", expect: 422 }] })], { apis } as never));
  assert.ok(good.ok, codes(good.problems).join(","));

  const outOfRange = valid(manifest([op({ acceptanceProbes: [{ criterion: 7, as: "anonymous", path: "/api/quotes", expect: 422 }] })], { apis } as never));
  assert.ok(codes(outOfRange.problems).includes("probe-criterion"), codes(outOfRange.problems).join(","));

  const undeclared = valid(manifest([op({ acceptanceProbes: [{ criterion: 0, as: "anonymous", path: "/api/not-declared", expect: 422 }] })], { apis } as never));
  assert.ok(codes(undeclared.problems).includes("probe-path"), codes(undeclared.problems).join(","));

  const twice = valid(manifest([op({ acceptanceProbes: [
    { criterion: 0, as: "anonymous", path: "/api/quotes", expect: 422 },
    { criterion: 0, as: "customer", path: "/api/quotes", expect: 401 },
  ] })], { apis } as never));
  assert.ok(codes(twice.problems).includes("probe-duplicate"), codes(twice.problems).join(","));

  // Deliberately not one of the three sessions, which is the whole point of the check.
  const noSession = valid(manifest([op({ acceptanceProbes: [{ criterion: 0, as: "nobody" as never, path: "/api/quotes", expect: 422 }] })], { apis } as never));
  assert.ok(codes(noSession.problems).includes("probe-session"), codes(noSession.problems).join(","));

  const notAStatus = valid(manifest([op({ acceptanceProbes: [{ criterion: 0, as: "anonymous", path: "/api/quotes", expect: 4220 }] })], { apis } as never));
  assert.ok(codes(notAStatus.problems).includes("probe-status"), codes(notAStatus.problems).join(","));
});

test("[IM-011] a declared visual state must name an approved page and a role, once each", () => {
  // The declaration is what makes a gated page comparable at all, so a wrong one is not a detail: an unapproved
  // page cannot be compared with anything, and a blank role would capture anonymously -- the exact thing the
  // declaration exists to stop, and it would then look as though the state had been honoured.
  const good = valid(manifest([op()], { visualStates: [{ page: "quote", session: "staff", mask: [".card p"] }] } as never));
  assert.ok(good.ok, codes(good.problems).join(","));

  const unapproved = valid(manifest([op()], { visualStates: [{ page: "dashboard", session: "staff" }] } as never));
  assert.ok(codes(unapproved.problems).includes("visual-state-page"), codes(unapproved.problems).join(","));

  const twice = valid(manifest([op()], { visualStates: [{ page: "quote", session: "staff" }, { page: "quote", session: "customer" }] } as never));
  assert.ok(codes(twice.problems).includes("visual-state-duplicate"), codes(twice.problems).join(","));

  const noRole = valid(manifest([op()], { visualStates: [{ page: "quote", session: "" }] } as never));
  assert.ok(codes(noRole.problems).includes("visual-state-session"), codes(noRole.problems).join(","));

  const shouty = valid(manifest([op()], { visualStates: [{ page: "quote", session: "STAFF" }] } as never));
  assert.ok(codes(shouty.problems).includes("visual-state-session"), "the role is lower case, so it matches one value everywhere");

  const emptyMask = valid(manifest([op()], { visualStates: [{ page: "quote", session: "staff", mask: ["  "] }] } as never));
  assert.ok(codes(emptyMask.problems).includes("visual-state-mask"), codes(emptyMask.problems).join(","));
});
