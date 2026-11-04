// The Design Gallery reaching the ACTUAL builder (Founder directive, 2026-11-03).
//
// The directive is explicit that confirming gallery functions exist proves nothing. Before this work
// `selectForBuild` and `recordSelection` had ZERO production callers: they were reachable only from tests, so the
// gallery was connected to its own unit tests and to nothing else. The builder never received a reference, and the
// inspect page's "references used" list was permanently empty because nothing ever recorded a selection.
//
// So these tests go through `claimJob` -- the one call a real runner makes to start work. If the gallery is not
// wired into that path, they fail, however healthy the helper functions are in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createCustomer, createStaff, MemoryStorage, TEST_PASSWORD } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import { newId, nowIso } from "../src/lib/db.ts";
import * as G from "../src/services/design-gallery.ts";
import * as B from "../src/services/builds.ts";
import { classifyIndustry, weightFor, WEIGHT } from "../src/services/industry-match.ts";

type App = Awaited<ReturnType<typeof createTestApp>>;

async function app() {
  const t = await createTestApp({ BUILD_RUNNER_SECRET: "s".repeat(32), overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  const owner = await createStaff(t.db, "owner", `owner${Math.random().toString(16).slice(2, 8)}@crestmont.test`);
  return { t, owner };
}

async function approved(t: App, owner: { id: string }, r: { title: string; industry: string } & Partial<G.NewReference>) {
  const id = await G.addReference(t.db, { rightsBasis: "owner_supplied", ...r }, owner.id);
  await G.decide(t.db, id, "approve", owner.id);
  return id;
}

/** A paid project with a submitted intake, queued and waiting for a runner -- the real precondition for a claim. */
async function queued(t: App, industry: string, extra: Record<string, unknown> = {}) {
  const cu = await createCustomer(t.db, `c${Math.random().toString(16).slice(2, 8)}@ex.example`, "Junk in the Trunk");
  const pid = newId("prj");
  await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
    VALUES (?,?,?,'development',2,'upfront',?,?)`).bind(pid, cu.organizationId, "Junk in the Trunk", nowIso(), nowIso()).run();
  const brief = {
    schema: "crestmont.build-brief/1", project: { id: pid, name: "Junk in the Trunk" }, strategy: "standard",
    package: { id: "business", name: "Business", pageLimit: 12, revisionRounds: 3, includes: [] },
    custom: null, deliverables: [], exclusions: [],
    customerData: {
      business: { name: "Junk in the Trunk", industry, publicEmail: "casey@junkinthetrunk.test", publicPhone: "+1 517 555 0142", serviceArea: "Greater Lansing, Michigan" },
      goals: "quote requests", audience: "homeowners",
      brand: { hasBranding: false, guidelines: "", style: "bold, dependable, American", colors: "red white blue", logoFileIds: [] },
      pages: ["Home"], pagesOverLimit: [], features: [], integrations: [], references: [],
      content: { source: "crestmont_draft", notes: "", imagesSource: "licensed" },
      domain: { status: "need", name: "", hosting: "crestmont" }, additionalNotes: "",
      ...extra,
    },
    files: [], missingInformation: [], assumptions: [], acceptanceCriteria: [], rules: [],
  };
  const bid = newId("brf");
  await t.db.prepare(`INSERT INTO build_briefs (id, project_id, version, content_json, sha256, created_at) VALUES (?,?,1,?,?,?)`)
    .bind(bid, pid, JSON.stringify(brief), "x".repeat(64), nowIso()).run();
  const job = newId("bld");
  await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, package_id, trigger, attempts, max_attempts, brief_id, created_at, updated_at)
    VALUES (?,?,?,'first_build',0,?,'queued','standard','business','payment',0,3,?,?,?)`)
    .bind(job, pid, cu.organizationId, `${pid}:first`, bid, nowIso(), nowIso()).run();
  return { pid, job };
}

const claim = (t: App) => B.claimJob(t.db, { runnerId: "r1", capabilities: ["local-model", "container-sandbox", "zero-token-cost", "git"] });

// ── the engine ──

test("[GALLERY-BUILD] junk removal is construction first and home services second, not a guess", () => {
  const c = classifyIndustry("Junk removal and hauling");
  assert.ok(c.confident, "the trade was recognised");
  assert.equal(c.ranked[0].category, "construction", `construction leads: ${c.ranked.map((r) => r.category).join(", ")}`);
  assert.equal(c.ranked[1].category, "home-services", "home services is the fallback the Founder asked for");
  assert.ok(weightFor(c, "construction") > weightFor(c, "home-services"), "and construction outranks it");
  // The categories the directive explicitly says not to reach for on a junk-removal site.
  for (const wrong of ["luxury", "restaurants", "automotive", "saas", "healthcare"]) {
    assert.equal(weightFor(c, wrong), WEIGHT.unrelated, `${wrong} must score nothing for junk removal`);
  }
});

test("[GALLERY-BUILD] the engine is a vocabulary, not a lookup table: unseen trades still resolve or admit they did not", () => {
  for (const [trade, want] of [["Roofing contractor", "construction"], ["Plumbing & drain", "home-services"],
    ["Auto glass replacement", "automotive"], ["Neighbourhood bakery", "restaurants"], ["Dental practice", "healthcare"],
    ["Family law attorney", "professional"], ["Online store for climbing gear", "ecommerce"], ["B2B software platform", "saas"]] as const) {
    assert.equal(classifyIndustry(trade).ranked[0].category, want, `${trade} -> ${want}`);
  }
  // A trade the vocabulary has never seen must not pretend: no confidence, and only design patterns offered.
  const unknown = classifyIndustry("Competitive falconry outfitter");
  assert.equal(unknown.confident, false, "an unknown trade is admitted, not guessed");
  assert.ok(unknown.ranked.every((r) => r.weight <= WEIGHT.pattern), "and nothing is claimed as a trade match");
  assert.match(unknown.reason, /matched no trade/);
});

// ── the production path ──

test("[GALLERY-BUILD] claiming a job selects, records and delivers gallery references — the path a runner actually takes", async () => {
  const { t, owner } = await app();
  try {
    const built = await approved(t, owner, { title: "Contractor Pro", industry: "construction", styleTags: ["bold"], layoutNotes: "full-bleed hero over a service grid" });
    await approved(t, owner, { title: "Home Services Clean", industry: "home-services" });
    await approved(t, owner, { title: "Fashion House", industry: "luxury" });
    await approved(t, owner, { title: "Bistro", industry: "restaurants" });
    const { job } = await queued(t, "Junk removal and hauling");

    const res = await claim(t);
    assert.ok(res.job, "a runner claimed the job");
    const d = res.job!.design;
    assert.ok(d, "the claim carries the gallery selection: without this the builder never sees a reference");
    assert.equal(d!.industryMatch.confident, true);
    assert.equal(d!.references[0].industry, "construction", "the customer's own trade leads");
    assert.equal(d!.references[0].id, built);
    assert.equal(d!.references[1].industry, "home-services", "then the related trade");
    const rel = d!.references.map((r) => r.relevance);
    assert.deepEqual([...rel].sort((a, b) => b - a), rel, "references arrive in relevance order");
    assert.ok(d!.references.every((r) => r.rights !== "unverified"), "only rights-cleared references travel");

    // Recorded against the job, with the relevance that produced it: this is the audit the directive asks for,
    // and it is also what the staff inspect page reads -- it was always empty before.
    const audit = await G.selectionAudit(t.db, job);
    assert.equal(audit.length, d!.references.length, "every delivered reference is recorded");
    assert.equal(audit[0].reference_id, built);
    assert.equal(audit[0].matched_category, "construction");
    assert.ok((audit[0].relevance ?? 0) >= WEIGHT.related);
    assert.equal(audit[0].image_delivered, 0, "nothing claims delivery until the runner actually fetches it");
    assert.equal(audit[0].model_saw, 0, "and nothing claims a model saw it until the runner says so");
  } finally { await t.close?.(); }
});

test("[GALLERY-BUILD] relevance outranks variety: a trade with enough references fills the whole set", async () => {
  const { t, owner } = await app();
  try {
    for (let i = 0; i < 8; i++) await approved(t, owner, { title: `Construction ${i}`, industry: "construction" });
    for (const other of ["luxury", "restaurants", "automotive", "healthcare", "saas", "ecommerce"]) {
      await approved(t, owner, { title: `Other ${other}`, industry: other });
    }
    await queued(t, "Junk removal and hauling");
    const d = (await claim(t)).job!.design!;
    // The old behaviour took the best reference PER INDUSTRY first, so this set would have been one construction
    // reference and five unrelated sectors. That is the defect the Founder named.
    assert.equal(d.references.length, G.SELECTION_SIZE);
    assert.ok(d.references.every((r) => r.industry === "construction"),
      `every reference is from the customer's trade, got: ${d.references.map((r) => r.industry).join(", ")}`);
  } finally { await t.close?.(); }
});

test("[GALLERY-BUILD] when the trade runs out, design patterns fill before unrelated sectors", async () => {
  const { t, owner } = await app();
  try {
    await approved(t, owner, { title: "Only Construction", industry: "construction" });
    await approved(t, owner, { title: "Minimal", industry: "minimalist" });
    await approved(t, owner, { title: "Bold", industry: "bold-contemporary" });
    await approved(t, owner, { title: "Fashion", industry: "luxury" });
    await approved(t, owner, { title: "Bistro", industry: "restaurants" });
    await queued(t, "Junk removal and hauling");
    const d = (await claim(t)).job!.design!;
    assert.equal(d.references[0].industry, "construction");
    const patterns = d.references.slice(1, 3).map((r) => r.industry);
    assert.ok(patterns.every((p) => ["minimalist", "bold-contemporary"].includes(p)),
      `design patterns come before unrelated sectors, got: ${d.references.map((r) => r.industry).join(", ")}`);
    const luxuryAt = d.references.findIndex((r) => r.industry === "luxury");
    const minimalAt = d.references.findIndex((r) => r.industry === "minimalist");
    assert.ok(luxuryAt > minimalAt, "luxury is an unrelated sector here, not a design pattern");
  } finally { await t.close?.(); }
});

test("[GALLERY-BUILD] an owner's decision binds the builder: a disabled reference never reaches a claim", async () => {
  const { t, owner } = await app();
  try {
    const gone = await approved(t, owner, { title: "Withdrawn", industry: "construction" });
    const stays = await approved(t, owner, { title: "Kept", industry: "construction" });
    await G.decide(t.db, gone, "disable", owner.id);
    await queued(t, "Junk removal and hauling");
    const d = (await claim(t)).job!.design!;
    assert.deepEqual(d.references.map((r) => r.id), [stays], "only the reference the owner still approves is delivered");
  } finally { await t.close?.(); }
});

test("[GALLERY-BUILD] an empty gallery costs the customer nothing: the build is claimed and says it had no references", async () => {
  const { t } = await app();
  try {
    await queued(t, "Junk removal and hauling");
    const res = await claim(t);
    assert.ok(res.job, "the build still starts");
    assert.equal(res.job!.design, null, "and reports honestly that it had no references, rather than implying some");
  } finally { await t.close?.(); }
});

test("[GALLERY-BUILD] image bytes are scoped to the job that was given them, and delivery is recorded only when it happens", async () => {
  const { t, owner } = await app();
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const mine = await approved(t, owner, { title: "Mine", industry: "construction" });
    const notMine = await approved(t, owner, { title: "Not mine", industry: "construction" });
    await t.db.prepare(`UPDATE design_references SET desktop_key = ? WHERE id = ?`).bind(`design-gallery/${mine}/desktop.png`, mine).run();
    await t.db.prepare(`UPDATE design_references SET desktop_key = ? WHERE id = ?`).bind(`design-gallery/${notMine}/desktop.png`, notMine).run();
    await t.env.overrides!.storage!.put(`design-gallery/${mine}/desktop.png`, png, "image/png");
    await t.env.overrides!.storage!.put(`design-gallery/${notMine}/desktop.png`, png, "image/png");

    const { job } = await queued(t, "Junk removal and hauling");
    const d = (await claim(t)).job!.design!;
    const given = d.references[0].id;
    const withheld = [mine, notMine].find((x) => !d.references.some((r) => r.id === x));

    const img = await G.galleryImageForJob(t.db, t.env.overrides!.storage!, job, given, "desktop");
    assert.ok(img, "a reference this job was given can be fetched");
    assert.equal(img!.contentType, "image/png");
    assert.equal(Buffer.from(img!.base64, "base64").length, png.length, "the real bytes come back");
    assert.equal((await G.selectionAudit(t.db, job)).find((a) => a.reference_id === given)!.image_delivered, 1,
      "fetching the bytes is what records delivery");

    if (withheld) {
      assert.equal(await G.galleryImageForJob(t.db, t.env.overrides!.storage!, job, withheld, "desktop"), null,
        "a reference this job was NOT given is never served: a runner cannot walk the gallery");
    }
  } finally { await t.close?.(); }
});

test("[GALLERY-BUILD] a model only counts as having seen an image that was actually delivered to it", async () => {
  const { t, owner } = await app();
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const a = await approved(t, owner, { title: "Reference A", industry: "construction" });
    const b = await approved(t, owner, { title: "Reference B", industry: "construction" });
    await t.db.prepare(`UPDATE design_references SET desktop_key = ? WHERE id = ?`).bind(`design-gallery/${a}/desktop.png`, a).run();
    await t.env.overrides!.storage!.put(`design-gallery/${a}/desktop.png`, png, "image/png");
    const { job } = await queued(t, "Junk removal and hauling");
    await claim(t);

    await G.galleryImageForJob(t.db, t.env.overrides!.storage!, job, a, "desktop");
    // The runner claims both; only the one whose bytes were really delivered may be recorded as seen.
    const updated = await G.markImagesSeen(t.db, job, [a, b], "qwen3.8:27b-q4_K_M");
    assert.equal(updated, 1, "a reference with no delivered image cannot be marked as seen");
    const audit = await G.selectionAudit(t.db, job);
    assert.equal(audit.find((x) => x.reference_id === a)!.model_saw, 1);
    assert.equal(audit.find((x) => x.reference_id === a)!.seen_by_model, "qwen3.8:27b-q4_K_M");
    assert.equal(audit.find((x) => x.reference_id === b)!.model_saw, 0, "and B, never delivered, stays unseen");
  } finally { await t.close?.(); }
});
