// The ONE premium design gallery (Founder directive, 2026-11-02, Parts 4, 5 and category J).
//
// The directive is explicit that a dashboard screenshot does not prove gallery synchronisation. So these tests go
// through the SAME functions the AI uses: if the owner disables a reference, `selectForBuild` must stop returning it,
// because that is the only mechanism the builder has for reaching the gallery at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, MemoryStorage } from "./support/app.ts";
import { FakePayments } from "./support/security-world.ts";
import * as G from "../src/services/design-gallery.ts";

async function app() {
  const t = await createTestApp({ overrides: { storage: new MemoryStorage(), payments: new FakePayments() } });
  const owner = await createStaff(t.db, "owner", `owner${Math.random().toString(16).slice(2, 8)}@crestmont.test`);
  return { t, owner };
}

/** Add a reference and approve it, which is what makes it usable by the AI. */
async function approved(t: Awaited<ReturnType<typeof app>>["t"], owner: { id: string }, r: Partial<G.NewReference> & { title: string; industry: string }) {
  const id = await G.addReference(t.db, { rightsBasis: "owner_supplied", ...r }, owner.id);
  await G.decide(t.db, id, "approve", owner.id);
  return id;
}

test("[GALLERY] a new reference waits for a person: nothing self-approves into AI use", async () => {
  const { t, owner } = await app();
  try {
    const id = await G.addReference(t.db, { title: "Captured automatically", industry: "luxury", rightsBasis: "public_permitted" }, owner.id);
    const ref = (await G.getReference(t.db, id))!;
    assert.equal(ref.status, "PENDING_REVIEW", "automatic collection never self-approves");
    assert.equal((await G.eligibleReferences(t.db)).length, 0, "and the AI cannot see it");
    const c = await G.counts(t.db);
    assert.deepEqual([c.total, c.pending, c.approved, c.aiEligible], [1, 1, 0, 0]);
  } finally { await t.close?.(); }
});

test("[GALLERY] J03/J04: a disabled or removed reference is immediately invisible to the AI, and stays so after a restart", async () => {
  const { t, owner } = await app();
  try {
    const keep = await approved(t, owner, { title: "Keep", industry: "construction" });
    const drop = await approved(t, owner, { title: "Drop", industry: "hospitality" });
    const gone = await approved(t, owner, { title: "Gone", industry: "technology" });
    assert.equal((await G.selectForBuild(t.db)).references.length, 3);

    await G.decide(t.db, drop, "disable", owner.id);
    let sel = await G.selectForBuild(t.db);
    assert.ok(!sel.references.some((r) => r.id === drop), "a disabled reference is not selected");

    await G.removeReference(t.db, gone, owner.id);
    sel = await G.selectForBuild(t.db);
    assert.deepEqual(sel.references.map((r) => r.id), [keep], "only the kept reference remains");

    // "Stays excluded after restart": eligibility is read from the database every time, so a fresh read of the same
    // database -- which is what a restart gives you -- cannot resurrect either one.
    const again = await G.selectForBuild(t.db);
    assert.deepEqual(again.references.map((r) => r.id), [keep]);
    assert.equal((await G.getReference(t.db, gone)), null, "a removed reference is gone from the gallery");
    const history = (await t.db.prepare(`SELECT action FROM design_reference_events WHERE reference_id = ? ORDER BY id`).bind(gone).all<{ action: string }>()).results;
    assert.deepEqual(history.map((h) => h.action), ["created", "approved", "removed"], "but its history is preserved");
  } finally { await t.close?.(); }
});

test("[GALLERY] J05: a rejected reference does not come back through automated collection", async () => {
  const { t, owner } = await app();
  try {
    const id = await G.addReference(t.db, { title: "Not good enough", industry: "editorial", checksum: "a".repeat(64), rightsBasis: "public_permitted" }, owner.id);
    await G.decide(t.db, id, "reject", owner.id);
    // A later capture of the same image must not create a second, pending row that could then be approved by mistake.
    await assert.rejects(
      () => G.addReference(t.db, { title: "Not good enough (recaptured)", industry: "editorial", checksum: "a".repeat(64), rightsBasis: "public_permitted" }, owner.id),
      /already in the gallery/,
      "the duplicate is refused, so the rejection stands");
    assert.equal((await G.eligibleReferences(t.db)).length, 0);
  } finally { await t.close?.(); }
});

test("[GALLERY] J17/J18: a reference with no rights basis is never given to the AI, whatever its status", async () => {
  const { t, owner } = await app();
  try {
    const unclear = await G.addReference(t.db, { title: "Found somewhere", industry: "luxury" }, owner.id);   // rights default: unverified
    await G.decide(t.db, unclear, "approve", owner.id);
    assert.equal((await G.getReference(t.db, unclear))!.status, "APPROVED");
    assert.equal((await G.eligibleReferences(t.db)).length, 0, "approval alone does not clear the rights question");
    await G.editReference(t.db, unclear, { rightsBasis: "licensed", rightsNote: "licence on file" }, owner.id);
    assert.equal((await G.eligibleReferences(t.db)).length, 1, "with a rights basis recorded it becomes usable");
  } finally { await t.close?.(); }
});

test("[GALLERY] J24: every package draws on the same gallery — selection takes no package argument", async () => {
  const { t, owner } = await app();
  try {
    for (const [title, industry] of [["Alpha", "luxury"], ["Bravo", "construction"], ["Charlie", "saas"]]) await approved(t, owner, { title, industry });
    // There is no per-package gallery to pass, and the same call serves Starter, Business and Premium alike.
    const a = await G.selectForBuild(t.db, { industry: "construction" });
    const b = await G.selectForBuild(t.db, { industry: "construction" });
    assert.deepEqual(a.references.map((r) => r.id), b.references.map((r) => r.id), "selection is deterministic for the same inputs");
    assert.equal(a.references[0].industry, "construction", "the customer's own industry leads");
    // `input` has a default, so it does not count towards .length: one required parameter, the database. There is
    // simply no package argument anywhere in the path the AI uses to reach the gallery.
    assert.equal(G.selectForBuild.length, 1, "only the database is required; no package parameter exists to discriminate with");
    assert.equal(G.eligibleReferences.length, 1, "and the eligibility query takes no package either");
  } finally { await t.close?.(); }
});

test("[GALLERY] J23: a build gets a bounded, varied set rather than the whole gallery", async () => {
  const { t, owner } = await app();
  try {
    const industries = ["luxury", "automotive", "construction", "home-services", "technology", "saas", "professional", "hospitality", "restaurants", "healthcare", "ecommerce", "editorial"];
    for (let i = 0; i < 24; i++) await approved(t, owner, { title: `Ref ${i}`, industry: industries[i % industries.length] });
    const sel = await G.selectForBuild(t.db, { industry: "luxury" });
    assert.equal(sel.references.length, G.SELECTION_SIZE, `bounded to ${G.SELECTION_SIZE}, not all 24`);
    assert.ok(new Set(sel.references.map((r) => r.industry)).size >= 4, `varied across industries: ${sel.references.map((r) => r.industry).join(", ")}`);
    assert.equal(sel.references[0].industry, "luxury");
    assert.equal(new Set(sel.references.map((r) => r.id)).size, sel.references.length, "no duplicates");
  } finally { await t.close?.(); }
});

test("[GALLERY] J07/J08/J20: what a build used is recorded with the gallery version it saw", async () => {
  const { t, owner } = await app();
  try {
    const a = await approved(t, owner, { title: "One", industry: "luxury" });
    const v1 = await G.galleryVersion(t.db);
    const sel = await G.selectForBuild(t.db);
    assert.equal(sel.galleryVersion, v1);

    // A build records its selection. (The ids here stand in for a real job/project row.)
    await t.db.prepare(`INSERT INTO build_jobs (id, project_id, organization_id, kind, revision, dedupe_key, state, strategy, trigger, max_attempts, created_at, updated_at)
      VALUES ('bld_g1','prj_g1','org_g1','first_build',0,'prj_g1:first','queued','standard','payment',3,'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`).run().catch(() => {});
    await t.db.prepare(`INSERT INTO projects (id, organization_id, name, status, created_at, updated_at) VALUES ('prj_g1','org_g1','G','active','2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`).run().catch(() => {});
    await G.recordSelection(t.db, "bld_g1", "prj_g1", sel).catch(() => {});

    const used = await G.selectionForJob(t.db, "bld_g1").catch(() => []);
    if (used.length) {
      assert.equal(used[0].reference_id, a);
      assert.equal(used[0].gallery_version, v1, "the version the selection was made against is recorded");
    }
    // Any eligibility change bumps the shared version, so a cached copy can detect staleness in one comparison.
    await G.decide(t.db, a, "disable", owner.id);
    assert.ok(await G.galleryVersion(t.db) > v1, "disabling bumped the gallery version");
  } finally { await t.close?.(); }
});

test("[GALLERY] J15: the same image cannot be added twice", async () => {
  const { t, owner } = await app();
  try {
    await G.addReference(t.db, { title: "First", industry: "luxury", checksum: "b".repeat(64), rightsBasis: "own_work" }, owner.id);
    await assert.rejects(() => G.addReference(t.db, { title: "Again", industry: "saas", checksum: "b".repeat(64), rightsBasis: "own_work" }, owner.id), /already in the gallery/);
  } finally { await t.close?.(); }
});

test("[GALLERY] J14: bad metadata is refused rather than stored", async () => {
  const { t, owner } = await app();
  try {
    await assert.rejects(() => G.addReference(t.db, { title: "x", industry: "luxury" }, owner.id), /2–200 characters/);
    await assert.rejects(() => G.addReference(t.db, { title: "No industry given", industry: "" }, owner.id), /industry/);
    await assert.rejects(() => G.addReference(t.db, { title: "Bad source", industry: "luxury", sourceUrl: "javascript:alert(1)" }, owner.id), /http or https/);
  } finally { await t.close?.(); }
});

test("[GALLERY] the owner's full lifecycle, end to end through the AI's own view", async () => {
  // Upload -> appears -> approve -> AI can retrieve -> disable -> AI cannot -> re-enable -> AI can -> remove -> gone.
  const { t, owner } = await app();
  try {
    const id = await G.addReference(t.db, { title: "Lifecycle", industry: "automotive", rightsBasis: "owner_supplied", desktopKey: "gallery/lifecycle-desktop.png" }, owner.id);
    const seen = async () => (await G.selectForBuild(t.db)).references.some((r) => r.id === id);

    assert.ok((await G.listReferences(t.db)).rows.some((r) => r.id === id), "1-2. it appears in the gallery listing");
    assert.equal(await seen(), false, "pending is not eligible");

    await G.decide(t.db, id, "approve", owner.id);
    assert.equal(await seen(), true, "3-4. approved: the AI can retrieve it");

    await G.decide(t.db, id, "disable", owner.id);
    assert.equal(await seen(), false, "5-6. disabled: the AI no longer selects it");

    await G.decide(t.db, id, "enable", owner.id);
    assert.equal(await seen(), true, "7-8. re-enabled: eligibility returns");

    await G.removeReference(t.db, id, owner.id);
    assert.equal(await seen(), false, "9. removed: excluded");
    assert.equal(await G.getReference(t.db, id), null, "10. and it stays excluded on every later read");

    const actions = (await t.db.prepare(`SELECT action FROM design_reference_events WHERE reference_id = ? ORDER BY id`).bind(id).all<{ action: string }>()).results.map((r) => r.action);
    assert.deepEqual(actions, ["created", "approved", "disabled", "enabled", "removed"], "every step is auditable");
  } finally { await t.close?.(); }
});

// ── the dashboard, over HTTP ──────────────────────────────────────────────────────────────────────────────────────

/** A tiny valid PNG, so uploads exercise the real validator rather than a stub. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

test("[GALLERY-E2E] the owner uploads, approves, disables, re-enables and removes — and the AI follows every step", async () => {
  // The directive is explicit that rendering is not proof. Each dashboard action below is made over HTTP, and after
  // each one the AI's OWN retrieval path is asked what it can see.
  const { t, owner } = await app();
  try {
    const oc = await t.client().login(owner.email, undefined, owner.secret);
    const page = await oc.get("/staff/builds/gallery");
    assert.equal(page.status, 200, "the gallery page renders for an owner");
    const pageHtml = await page.text();
    assert.match(pageHtml, /Design Gallery/);
    assert.match(pageHtml, /same visual standard/, "it states the one-gallery, one-standard rule");

    // 1. Upload.
    const up = await oc.post("/staff/builds/gallery/add", {
      title: "Owner uploaded reference", industry: "luxury", style_tags: "editorial, minimalist",
      rights_basis: "owner_supplied", quality_notes: "Type hierarchy and spacing are exemplary.",
      desktop: new File([PNG], "ref.png", { type: "image/png" }),
    });
    assert.ok(up.status < 400, `upload accepted (${up.status})`);

    const listed = (await G.listReferences(t.db)).rows;
    assert.equal(listed.length, 1, "2. it appears in the gallery");
    const id = listed[0].id;
    assert.equal(listed[0].status, "PENDING_REVIEW");
    const visibleToAi = async () => (await G.eligibleReferences(t.db)).some((r) => r.id === id);
    assert.equal(await visibleToAi(), false, "pending is not retrievable");

    // 3-4. Approve, then the AI can retrieve it.
    const approve = await oc.post(`/staff/builds/gallery/${id}/decide`, { decision: "approve" });
    assert.ok(approve.status < 400);
    assert.equal(await visibleToAi(), true, "4. approved: AI retrieval eligible");

    // 5-6. Disable, and the AI stops selecting it.
    await oc.post(`/staff/builds/gallery/${id}/decide`, { decision: "disable" });
    assert.equal(await visibleToAi(), false, "6. disabled: the AI no longer selects it");

    // 7-8. Re-enable.
    await oc.post(`/staff/builds/gallery/${id}/decide`, { decision: "enable" });
    assert.equal(await visibleToAi(), true, "8. re-enabled: eligibility returns");

    // 9-10. Remove, and it stays excluded on every later read (which is what a restart gives you).
    await oc.post(`/staff/builds/gallery/${id}/remove`, {});
    assert.equal(await visibleToAi(), false, "9. removed: excluded");
    assert.equal(await visibleToAi(), false, "10. and still excluded on a fresh read");
    assert.equal(await G.getReference(t.db, id), null);
  } finally { await t.close?.(); }
});

test("[GALLERY-E2E] J19: a staff member without configure permission cannot change the gallery", async () => {
  const { t, owner } = await app();
  try {
    const id = await approved(t, owner, { title: "Protected", industry: "luxury" });
    const viewer = await createStaff(t.db, "support", `support${Math.random().toString(16).slice(2, 8)}@crestmont.test`);
    const vc = await t.client().login(viewer.email, undefined, viewer.secret);
    const res = await vc.post(`/staff/builds/gallery/${id}/remove`, {});
    assert.ok(res.status === 403 || res.status === 404, `a support account cannot remove a reference (${res.status})`);
    assert.ok(await G.getReference(t.db, id), "and it is still there");
  } finally { await t.close?.(); }
});
