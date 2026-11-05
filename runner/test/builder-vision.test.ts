// Can the model that WRITES the website actually see? (V5 correction §1-§6.)
//
// The gap these close, as it stood before this change:
//
//   runner/src/providers/local.ts -- the builder's entire production path -- did not contain the word "image".
//   Model A was shown the Design Gallery references; Model B was shown Model A's prose about them, and was never
//   shown what its own code rendered. It was then asked, cycle after cycle, to close a visual gap it had no way
//   to perceive. Measured on bld_10e2c6007686faee0ab64d45: nine repair cycles, one rendered change.
//
// So these tests assert on the REAL request. The fake model server records exactly what the client POSTed, and
// `imageParts()` reads the multimodal parts out of it: an assertion here fails if the image does not reach the
// wire, which is the one claim that was previously impossible to check.
//
// No GPU and no real model. The separate live check against the installed qwen3.6:35b-a3b-q4_K_M on Node 1 is
// what proves the model INTERPRETS what it is sent; these prove the runner sends it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalProvider } from "../src/providers/local.ts";
import { RunTracker, StopSwitch } from "../src/agent.ts";
import { createWorkspace } from "../src/workspace.ts";
import { writeBriefFiles } from "../src/prompt.ts";
import { silentLogger } from "../src/log.ts";
import type { PhaseRequest } from "../src/providers/types.ts";
import type { RunnerConfig } from "../src/config.ts";
import { makeConfig, makeJob, tmp, startFakeModel, fakeDocker, imageParts } from "./helpers.ts";
import type { FakeModelReply, FakeModelRequest } from "./helpers.ts";
import { planBuilderVision, approvedReference } from "../src/orchestrator/builder-vision.ts";
import { fitForVision, conceptColumn, decodePng, encodePng, tokensFor, MIN_READABLE_WIDTH } from "../src/orchestrator/image-fit.ts";
import { loadManifest, recordDelivery, recordExclusion, saveManifest, upsert, wasDelivered, unpublishable, manifestSummary } from "../src/orchestrator/reference-manifest.ts";
import { BLUEPRINT_SCHEMA, type DesignBlueprint } from "../src/orchestrator/blueprint.ts";

const BUILDER = "test-coder:30b";
const finish = (summary = "done"): FakeModelReply => ({ toolCalls: [{ name: "finish", arguments: { summary } }] });

/** A real PNG of a given size, so every token number here comes from genuine pixel dimensions. */
function png(file: string, w: number, h: number, shade = 0x40): string {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i += 3) { rgb[i] = shade; rgb[i + 1] = (i / 3) % 256; rgb[i + 2] = 0xa0; }
  writeFileSync(file, encodePng({ width: w, height: h, rgb }));
  return file;
}

/** A dual-model configuration whose BUILDER is vision-capable, unless the caller supplies its own. */
function visionConfig(over: Partial<RunnerConfig> = {}): Partial<RunnerConfig> {
  if (over.models) return over;
  const b = { tag: BUILDER, role: "builder" as const, contextTokens: 65_536, vramMb: 0, quantization: null, reasoning: null, vision: true, license: null };
  const a = { ...b, tag: "test-architect:27b", role: "architect_reviewer" as const };
  return { ...over, models: { a, b, mode: "dual" as const } };
}

/** The same, with a chosen window, for the budgeting tests. */
function windowOf(contextTokens: number): Partial<RunnerConfig> {
  const b = { tag: BUILDER, role: "builder" as const, contextTokens, vramMb: 0, quantization: null, reasoning: null, vision: true, license: null };
  return { models: { a: { ...b, tag: "test-architect:27b", role: "architect_reviewer" as const }, b, mode: "dual" as const } };
}

async function setup(handler: (req: FakeModelRequest, n: number) => FakeModelReply, over: Partial<RunnerConfig> = {}, caps: Record<string, string[]> = { [BUILDER]: ["completion", "vision", "tools"] }) {
  const model = await startFakeModel((r, n) => handler(r, n), [BUILDER, "test-architect:27b"], caps);
  const docker = fakeDocker();
  const base = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp(), ...visionConfig(over), local: { ...base.local, model: BUILDER, baseUrl: model.url } });
  const ws = createWorkspace(tmp("aib-ws-"), { id: "bld_vision", attempt: 1 });
  mkdirSync(path.join(ws.repo, "public"), { recursive: true });
  writeFileSync(path.join(ws.repo, "public", "index.html"), "<h1>Hello</h1>\n");
  const job = makeJob();
  writeBriefFiles(ws.repo, job, job.requirements);
  const provider = new LocalProvider({ cfg, executor: docker.executor, log: silentLogger, clientRetries: 0 });
  await provider.prepare({ job, ws, skillNames: [], referenceDomains: [], processEnv: {}, systemPromptAppend: "" });
  return { model, docker, cfg, ws, job, provider };
}

const req = (over: Partial<PhaseRequest> = {}): PhaseRequest =>
  ({ phase: "build", prompt: "Phase 2 of 3: build.", maxTurns: 4, maxBudgetUsd: 0, maxWallMs: 30_000, resumeSessionId: null, tracker: new RunTracker(), stop: new StopSwitch(), model: BUILDER, ...over });

const dir = () => mkdtempSync(path.join(tmpdir(), "bvision-"));

// ── the request itself ───────────────────────────────────────────────────────────────────────────────────────────

test("[MODELB-VISION] the measured gap: images given to the builder reach its REAL model request as image parts", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 560, 940);
  const shot = png(path.join(d, "index-desktop.png"), 1366, 768, 0x80);
  const { model, provider } = await setup(() => finish());
  try {
    const out = provider.setVisualContext({
      images: [{ path: ref, label: "DESIGN REFERENCE — concept 1 of 3" }, { path: shot, label: "YOUR OWN WEBSITE AS IT RENDERS NOW — index at desktop" }],
      note: "Look at the images below before you edit anything.",
    });
    assert.equal(out.delivered.length, 2, out.dropped.map((x) => x.reason).join(" | "));
    const res = await provider.run(req());
    assert.equal(res.status, "success");
    const imgs = imageParts(model.requests[0]);
    assert.equal(imgs.length, 2, "both images must be on the wire");
    assert.ok(imgs.every((i) => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(i.url)), "each must be a real base64 PNG data URL");
    // The labels travel with them, in the same message and in the same order.
    const text = model.requests[0].messages.map((m) => m.content ?? "").join("\n");
    assert.match(text, /1\. DESIGN REFERENCE — concept 1 of 3 \(560x940\)/);
    assert.match(text, /2\. YOUR OWN WEBSITE AS IT RENDERS NOW — index at desktop \(1366x768\)/);
    assert.ok(text.indexOf("DESIGN REFERENCE") < text.indexOf("YOUR OWN WEBSITE"), "label order must match attachment order");
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] the images survive a context reset: they are pinned, not history", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 560, 940);
  // Force a reset by returning a very large tool result, then let the loop finish.
  const { model, provider } = await setup((_r, n) => n === 1
    ? { toolCalls: [{ name: "run_command", arguments: { command: "echo hi" } }] }
    : finish());
  try {
    provider.setVisualContext({ images: [{ path: ref, label: "DESIGN REFERENCE" }], note: "look" });
    await provider.run(req({ maxTurns: 3 }));
    assert.ok(model.requests.length >= 2, "the loop must have made more than one request");
    for (const [i, r] of model.requests.entries()) {
      assert.equal(imageParts(r).length, 1, `request ${i + 1} must still carry the reference`);
    }
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] a dropped image is reported as dropped and never claimed as delivered", async () => {
  const d = dir();
  // Far more than the window can hold: 4000x4000 is about 23,000 tokens before the cap.
  const huge = png(path.join(d, "huge.png"), 2600, 2600);
  const small = png(path.join(d, "small.png"), 400, 300);
  const { model, provider } = await setup(() => finish(), windowOf(16_384));
  try {
    const out = provider.setVisualContext({ images: [{ path: huge, label: "HUGE" }, { path: small, label: "SMALL" }], note: "n" });
    assert.ok(out.dropped.some((x) => x.label === "HUGE"), `expected HUGE to be dropped, got delivered=${out.delivered.map((d2) => d2.label)}`);
    assert.ok(!out.delivered.some((x) => x.label === "HUGE"), "a dropped image must never appear as delivered");
    await provider.run(req());
    const text = model.requests[0].messages.map((m) => m.content ?? "").join("\n");
    assert.match(text, /did not fit this request and are NOT attached/);
    assert.match(text, /Do not claim to have seen them/);
    assert.equal(imageParts(model.requests[0]).length, out.delivered.length);
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] image tokens are measured from pixels, not as the six characters of \"[image]\"", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 1366, 768);
  const { model, provider } = await setup(() => finish());
  try {
    const before = provider.measure(BUILDER, [{ role: "system", content: "s" }, { role: "user", content: "u" }], null, 0, 65_536);
    provider.setVisualContext({ images: [{ path: ref, label: "R" }], note: "n" });
    const after = provider.measure(BUILDER, [{ role: "system", content: "s" }, { role: "user", content: "u" }], null, 0, 65_536);
    const expected = tokensFor(1366, 768);
    assert.equal(after.pinned - before.pinned, expected, `a 1366x768 image must cost ${expected} tokens, not a handful`);
    assert.ok(expected > 1000, "sanity: a full-viewport screenshot is expensive and must be budgeted for");
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] a builder model without vision is not sent images, and says so instead of claiming delivery", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 560, 940);
  const { model, provider } = await setup(() => finish(), {}, { [BUILDER]: ["completion", "tools"] });
  try {
    await provider.preflight();
    const status = provider.visionStatus();
    assert.equal(status.capable, false);
    assert.match(status.reason, /do NOT include vision/);
    const out = provider.setVisualContext({ images: [{ path: ref, label: "R" }], note: "n" });
    assert.equal(out.delivered.length, 0);
    assert.match(out.dropped[0].reason, /cannot be shown images/);
    await provider.run(req());
    assert.equal(imageParts(model.requests[0]).length, 0, "nothing may be attached to a model that cannot see");
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] the server's capability answer overrides a missing config flag, which is the Node 1 state", async () => {
  // LOCAL_MODEL_A_VISION=true was set on Node 1 and LOCAL_MODEL_B_VISION was never set, so the runner believed its
  // builder was text-only -- while Ollama reported qwen3.6:35b-a3b-q4_K_M as ["completion","vision","tools",...].
  const b = { tag: BUILDER, role: "builder" as const, contextTokens: 65_536, vramMb: 0, quantization: null, reasoning: null, vision: false, license: null };
  const { model, provider } = await setup(() => finish(), { models: { a: { ...b, tag: "test-architect:27b", role: "architect_reviewer" as const }, b, mode: "dual" as const } });
  try {
    assert.equal(provider.visionStatus().capable, false, "before the probe, an unset flag is taken at face value");
    await provider.preflight();
    const status = provider.visionStatus();
    assert.equal(status.capable, true);
    assert.match(status.reason, /a missing flag is not evidence that the model cannot see/);
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] a server that refuses multimodal input does not kill the phase", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 560, 940);
  let refused = 0;
  const { model, provider } = await setup((r, n) => {
    if (imageParts(r).length) { refused++; return { status: 400, body: JSON.stringify({ error: { message: "Multimodal data provided, but model does not support multimodal requests." } }) }; }
    return finish(`text-only turn ${n}`);
  });
  try {
    provider.setVisualContext({ images: [{ path: ref, label: "R" }], note: "n" });
    const res = await provider.run(req());
    assert.equal(refused, 1, "the image request must have been attempted exactly once");
    assert.equal(res.status, "success", "the phase continues text-only rather than failing");
    assert.equal(provider.visionStatus().capable, false);
    assert.match(provider.visionStatus().reason, /refused the image input/);
  } finally { await provider.close(); await model.close(); }
});

test("[MODELB-VISION] clearing the context removes the images from the next request", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 560, 940);
  const { model, provider } = await setup(() => finish());
  try {
    provider.setVisualContext({ images: [{ path: ref, label: "R" }], note: "n" });
    await provider.run(req());
    assert.equal(imageParts(model.requests[0]).length, 1);
    provider.setVisualContext(null);
    assert.deepEqual(provider.visualContext(), []);
    await provider.run(req({ prompt: "Phase 3 of 3: verify and report." }));
    assert.equal(imageParts(model.requests.at(-1)!).length, 0);
  } finally { await provider.close(); await model.close(); }
});

// ── choosing and preparing what to show ──────────────────────────────────────────────────────────────────────────

const blueprint = (over: Partial<DesignBlueprint["referenceMapping"][number]> = {}): DesignBlueprint => ({
  schema: BLUEPRINT_SCHEMA,
  visualIdentity: { palette: { background: "#fff", surface: "#fff", text: "#111", brand: "#1f4d3c" }, headingFont: "Fraunces", bodyFont: "Inter", fontSource: "Google Fonts", typeScale: [], spacingBase: "0.5rem", spacingScale: [1, 2, 3, 5], radius: "0", elevation: "none", density: "balanced", intent: "x" },
  pages: [], components: [], visualAssets: [],
  referenceMapping: [{ referenceId: "gal-2", borrowed: "the full-bleed photographic hero", appliesTo: "home-hero", conceptIndex: 2, conceptCount: 3, ...over }],
});

test("[VISION-PLAN] a build phase shows the approved reference; a repair also shows what the code rendered", () => {
  const d = dir();
  const refs = [{ id: "gal-1", title: "A", path: png(path.join(d, "a.png"), 1670, 941) }, { id: "gal-2", title: "B", path: png(path.join(d, "b.png"), 1670, 941) }];
  const shots = [
    { page: "index", viewport: "desktop", path: png(path.join(d, "index-desktop.png"), 1366, 3608) },
    { page: "index", viewport: "mobile", path: png(path.join(d, "index-mobile.png"), 390, 5169) },
  ];
  const build = planBuilderVision({ phase: "build", workDir: path.join(d, "out"), blueprint: blueprint(), references: refs, screenshots: shots, budgetTokens: 5000 });
  assert.equal(build.images.length, 1, "nothing is rendered yet in a build phase; the standard is what helps");
  assert.match(build.images[0].label, /DESIGN REFERENCE/);
  assert.match(build.note, /LOOK AT THE IMAGE BELOW BEFORE YOU EDIT ANYTHING/);

  const repair = planBuilderVision({ phase: "repair", workDir: path.join(d, "out"), blueprint: blueprint(), references: refs, screenshots: shots, budgetTokens: 5000 });
  const labels = repair.images.map((i) => i.label);
  assert.ok(labels.some((l) => /YOUR OWN WEBSITE AS IT RENDERS NOW — index at desktop/.test(l)), labels.join(" | "));
  assert.ok(labels.some((l) => /DESIGN REFERENCE/.test(l)), labels.join(" | "));
  assert.match(repair.note, /Name the differences that MATTER/);
  assert.match(repair.note, /a repair that changes no\s*\n?\s*rendered pixel is recorded as ineffective/);
});

test("[VISION-PLAN] the blueprint's cited reference and concept are what the builder is shown", () => {
  const d = dir();
  const refs = [{ id: "gal-1", title: "A", path: png(path.join(d, "a.png"), 1670, 941) }, { id: "gal-2", title: "B", path: png(path.join(d, "b.png"), 1670, 941) }];
  const picked = approvedReference(blueprint(), refs);
  assert.equal(picked?.ref.id, "gal-2", "not simply the first reference: the one the blueprint cites");
  assert.equal(picked?.region?.label, "concept 2 of 3 (middle)");
  const plan = planBuilderVision({ phase: "build", workDir: path.join(d, "out"), blueprint: blueprint(), references: refs, screenshots: [], budgetTokens: 5000 });
  assert.match(plan.images[0].label, /concept 2 of 3 \(middle\)/);
  assert.equal(plan.prepared[0].concept, "concept 2 of 3 (middle)");
  assert.match(plan.prepared[0].note, /the original file is unchanged on disk and the other concepts were not sent/);
});

test("[VISION-PLAN] the reference is labelled as another studio's work that must never be published", () => {
  const d = dir();
  const refs = [{ id: "gal-2", title: "B", path: png(path.join(d, "b.png"), 1670, 941) }];
  const plan = planBuilderVision({ phase: "build", workDir: path.join(d, "out"), blueprint: blueprint(), references: refs, screenshots: [], budgetTokens: 5000 });
  assert.match(plan.images[0].label, /NOT this customer's website and NEVER to be copied or published/);
  assert.match(plan.note, /not licensed for this website/);
  assert.match(plan.note, /Build an original website/);
});

test("[VISION-PLAN] the whole plan stays inside its token budget", () => {
  const d = dir();
  const refs = [{ id: "gal-2", title: "B", path: png(path.join(d, "b.png"), 1670, 941) }];
  const shots = [{ page: "index", viewport: "desktop", path: png(path.join(d, "index-desktop.png"), 1366, 3608) }, { page: "index", viewport: "mobile", path: png(path.join(d, "index-mobile.png"), 390, 5169) }];
  for (const budget of [1500, 3000, 5000]) {
    const plan = planBuilderVision({ phase: "repair", workDir: path.join(d, "out"), blueprint: blueprint(), references: refs, screenshots: shots, budgetTokens: budget });
    const spent = plan.prepared.reduce((n, x) => n + x.tokens, 0);
    assert.ok(spent <= budget, `budget ${budget}: spent ${spent} on ${plan.prepared.length} image(s)`);
  }
});

// ── image preparation ────────────────────────────────────────────────────────────────────────────────────────────

test("[IMAGE-FIT] a full-page screenshot is cropped to the viewport rather than shrunk into illegibility", () => {
  const d = dir();
  const full = png(path.join(d, "index-desktop.png"), 1366, 3608);
  assert.ok(tokensFor(1366, 3608) > 7000, "sanity: the full page is genuinely expensive");
  const r = fitForVision(full, d, { maxTokens: 2000, purpose: "viewport", viewportHeight: 768 });
  assert.ok(!r.refused);
  assert.equal(r.operation, "viewport-crop");
  assert.equal(r.to.width, 1366, "native resolution is kept: the crop is what made it affordable");
  assert.equal(r.to.height, 768);
  assert.ok(r.to.tokens <= 2000);
  assert.match(r.note, /the original file is unchanged on disk/);
});

test("[IMAGE-FIT] a three-concept sheet is cropped to ONE concept at native resolution", () => {
  const d = dir();
  const sheet = png(path.join(d, "sheet.png"), 1670, 941);
  const r = fitForVision(sheet, d, { maxTokens: 1400, purpose: "overview", region: conceptColumn(1, 3) });
  assert.ok(!r.refused);
  assert.equal(r.operation, "concept-crop");
  assert.equal(r.to.width, 557, "one third of 1670 (rounded), at native resolution");
  assert.equal(r.to.height, 941);
  assert.equal(r.concept, "concept 2 of 3 (middle)");
});

test("[IMAGE-FIT] three concepts of one sheet produce three distinct files, not one overwritten one", () => {
  const d = dir();
  const sheet = png(path.join(d, "sheet.png"), 1670, 941);
  const paths = [0, 1, 2].map((i) => {
    const r = fitForVision(sheet, d, { maxTokens: 1400, purpose: "overview", region: conceptColumn(i, 3) });
    assert.ok(!r.refused);
    return r.to.path;
  });
  assert.equal(new Set(paths).size, 3, paths.join(" | "));
});

test("[IMAGE-FIT] rather than send an unreadable thumbnail, it refuses and says why", () => {
  const d = dir();
  const sheet = png(path.join(d, "sheet.png"), 1670, 941);
  const r = fitForVision(sheet, d, { maxTokens: 150, purpose: "overview" });
  assert.ok(r.refused);
  assert.match(r.reason, new RegExp(`below the ${MIN_READABLE_WIDTH}px at which a website's typography and spacing can still be judged`));
  assert.match(r.reason, /left out rather than sent unreadable/);
});

test("[IMAGE-FIT] the prepared image is a real PNG that decodes back to the stated size", () => {
  const d = dir();
  const full = png(path.join(d, "p.png"), 1366, 2000);
  const r = fitForVision(full, d, { maxTokens: 1200, purpose: "overview" });
  assert.ok(!r.refused);
  const back = decodePng(readFileSync(r.to.path));
  assert.ok(back, "the file written must be a decodable PNG");
  assert.equal(back!.width, r.to.width);
  assert.equal(back!.height, r.to.height);
});

// ── the manifest ────────────────────────────────────────────────────────────────────────────────────────────────

test("[MANIFEST] delivery is recorded per recipient, with the hash of the bytes actually sent", () => {
  const d = dir();
  const m = loadManifest(d, "bld_x", 1);
  upsert(m, { id: "gal-2", kind: "gallery_reference", title: "B", originalPath: "/g/b.png", originalSha256: "aaa", originalWidth: 1670, originalHeight: 941, publishable: false });
  assert.equal(wasDelivered(m, "gal-2", "builder"), false);
  recordDelivery(m, "gal-2", { to: "architect", sentPath: "/g/b.png", sentSha256: "aaa", width: 1670, height: 941, tokens: 2346, operation: "none", note: "unchanged", context: "architect attempt 1" });
  assert.equal(wasDelivered(m, "gal-2", "builder"), false, "the architect seeing it says nothing about the builder");
  recordDelivery(m, "gal-2", { to: "builder", sentPath: "/w/b-concept.png", sentSha256: "bbb", width: 556, height: 941, tokens: 782, operation: "concept-crop", concept: "concept 2 of 3 (middle)", note: "one concept", context: "build phase" });
  assert.equal(wasDelivered(m, "gal-2", "builder"), true);
  assert.equal(m.references[0].concept, "concept 2 of 3 (middle)");
  assert.match(manifestSummary(m), /architect saw 1, builder saw 1, reviewer saw 0/);
});

test("[MANIFEST] an exclusion is recorded as an exclusion, never as a quiet absence", () => {
  const d = dir();
  const m = loadManifest(d, "bld_x", 1);
  upsert(m, { id: "gal-1", kind: "gallery_reference", title: "A", originalPath: "/g/a.png", originalSha256: "aaa", originalWidth: 1670, originalHeight: 941, publishable: false });
  recordExclusion(m, "gal-1", { to: "builder", reason: "dropped by the provider's context budget", context: "repair phase" });
  assert.equal(wasDelivered(m, "gal-1", "builder"), false);
  assert.equal(m.references[0].exclusions.length, 1);
  assert.match(manifestSummary(m), /1 exclusion\(s\) recorded/);
});

test("[MANIFEST] gallery references and their crops are listed as never publishable", () => {
  const d = dir();
  const m = loadManifest(d, "bld_x", 1);
  upsert(m, { id: "gal-1", kind: "gallery_reference", title: "A", originalPath: "/g/a.png", originalSha256: "aaa", originalWidth: 1, originalHeight: 1, publishable: false });
  upsert(m, { id: "render:index:desktop", kind: "rendered_screenshot", title: "index", originalPath: "/r/index.png", originalSha256: "ccc", originalWidth: 1, originalHeight: 1, publishable: true });
  recordDelivery(m, "gal-1", { to: "builder", sentPath: "/w/a-crop.png", sentSha256: "bbb", width: 1, height: 1, tokens: 1, operation: "concept-crop", note: "n", context: "c" });
  const u = unpublishable(m);
  assert.ok(u.paths.includes("/g/a.png") && u.paths.includes("/w/a-crop.png"));
  assert.ok(u.hashes.includes("aaa") && u.hashes.includes("bbb"), "a copy under another name is the same infringement");
  assert.ok(!u.paths.includes("/r/index.png"), "the customer's own rendered page is publishable");
});

test("[MANIFEST] reloading keeps the delivery history and the concept chosen earlier in the build", () => {
  const d = dir();
  const m = loadManifest(d, "bld_x", 1);
  upsert(m, { id: "gal-2", kind: "gallery_reference", title: "B", originalPath: "/g/b.png", originalSha256: "aaa", originalWidth: 1, originalHeight: 1, publishable: false });
  recordDelivery(m, "gal-2", { to: "builder", sentPath: "/w/b.png", sentSha256: "bbb", width: 1, height: 1, tokens: 1, operation: "concept-crop", concept: "concept 2 of 3 (middle)", note: "n", context: "c" });
  saveManifest(d, m);
  const again = loadManifest(d, "bld_x", 2);
  assert.equal(again.attempt, 2, "a later attempt continues the same manifest");
  assert.equal(again.references[0].concept, "concept 2 of 3 (middle)", "the build must not pick a different concept each attempt");
  assert.equal(wasDelivered(again, "gal-2", "builder"), true);
  // Re-seeding the same reference must not wipe what it has already been used for.
  upsert(again, { id: "gal-2", kind: "gallery_reference", title: "B", originalPath: "/g/b.png", originalSha256: "aaa", originalWidth: 1, originalHeight: 1, publishable: false });
  assert.equal(again.references[0].deliveries.length, 1);
});

test("[MODELB-VISION] the budget and the capability follow the model about to run, not the previous one", async () => {
  const d = dir();
  const ref = png(path.join(d, "ref.png"), 560, 940);
  // Model A can see; a deliberately text-only Model B cannot. A repair that escalates to A must still get images.
  const b = { tag: BUILDER, role: "builder" as const, contextTokens: 65_536, vramMb: 0, quantization: null, reasoning: null, vision: false, license: null };
  const a = { ...b, tag: "test-architect:27b", role: "architect_reviewer" as const, vision: true };
  const { model, provider } = await setup(() => finish(), { models: { a, b, mode: "dual" as const } }, { [BUILDER]: ["completion", "tools"], "test-architect:27b": ["completion", "vision", "tools"] });
  try {
    await provider.preflight();
    assert.equal(provider.visionStatus(BUILDER).capable, false, "the builder genuinely cannot see");
    assert.equal(provider.visionStatus("test-architect:27b").capable, true, "the escalation model can");
    const toB = provider.setVisualContext({ images: [{ path: ref, label: "R" }], note: "n", model: BUILDER });
    assert.equal(toB.delivered.length, 0, "nothing is sent to the model that cannot see");
    const toA = provider.setVisualContext({ images: [{ path: ref, label: "R" }], note: "n", model: "test-architect:27b" });
    assert.equal(toA.delivered.length, 1, "the escalation model is shown the reference");
    await provider.run(req({ model: "test-architect:27b" }));
    assert.equal(imageParts(model.requests.at(-1)!).length, 1);
  } finally { await provider.close(); await model.close(); }
});
