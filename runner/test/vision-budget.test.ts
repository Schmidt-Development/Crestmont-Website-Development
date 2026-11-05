// Multimodal request budgeting and image format handling.
//
// The failure these prevent, from build bld_889ff809c133920c929a7121:
//
//   request (49186 tokens) exceeds the available context size (49152 tokens)
//
// Six full-page gallery references were attached with no accounting for their token cost, the prompt, the reply's
// reserve, or the text a corrective retry appends — and the overflow was then retried unchanged. Separately, every
// attachment was labelled `data:image/png` regardless of what the bytes actually were.
//
// No GPU and no model: these are deterministic unit tests over real image headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectImage, estimateImageTokens, imageFacts, planVisionRequest, dataUrl, ALLOWED_IMAGE_MIME } from "../src/orchestrator/vision.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "vision-"));

/** A PNG with a real IHDR. */
function png(w: number, h: number): Buffer {
  const head = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const d = Buffer.alloc(8);
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4);
  return Buffer.concat([head, d, Buffer.alloc(5)]);
}
/** A JPEG with an APP0 segment before the SOF0, so the segment walk has to step over something first. */
function jpeg(w: number, h: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(16); return b; })(), Buffer.alloc(14)]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(9, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  return Buffer.concat([soi, app0, sof]);
}
/** A lossy WebP (VP8 chunk). */
function webp(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(24, 4); b.write("WEBP", 8, "latin1"); b.write("VP8 ", 12, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
}
/** A GIF89a. */
function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}

// ── Failure D: the format must come from the bytes ──

test("[VISION] the image format and dimensions are read from the bytes, for every accepted format", () => {
  assert.deepEqual(detectImage(png(1366, 768)), { mime: "image/png", width: 1366, height: 768 });
  assert.deepEqual(detectImage(jpeg(1920, 1080)), { mime: "image/jpeg", width: 1920, height: 1080 });
  assert.deepEqual(detectImage(webp(800, 600)), { mime: "image/webp", width: 800, height: 600 });
  assert.deepEqual(detectImage(gif(320, 240)), { mime: "image/gif", width: 320, height: 240 });
  for (const m of [detectImage(png(1, 1))!.mime, detectImage(jpeg(1, 1))!.mime]) {
    assert.ok((ALLOWED_IMAGE_MIME as readonly string[]).includes(m));
  }
});

test("[VISION] REGRESSION: a JPEG is labelled image/jpeg, not image/png — the extension is never trusted", () => {
  const d = dir();
  // Saved with a .png name while the bytes are a JPEG: the exact mislabelling the adapter used to produce, since
  // the runner names gallery files from the content type R2 reported and then hardcoded image/png anyway.
  const p = path.join(d, "reference.png");
  writeFileSync(p, jpeg(1366, 768));
  const f = imageFacts(p)!;
  assert.equal(f.mime, "image/jpeg", "the bytes decide");
  assert.ok(dataUrl({ path: p, mime: f.mime }).startsWith("data:image/jpeg;base64,"));
  // And a PNG really is a PNG.
  const q = path.join(d, "real.png");
  writeFileSync(q, png(100, 100));
  assert.ok(dataUrl({ path: q, mime: imageFacts(q)!.mime }).startsWith("data:image/png;base64,"));
});

test("[VISION] corrupt, truncated, empty and unknown files are refused rather than sent mislabelled", () => {
  const d = dir();
  const cases: [string, Buffer][] = [
    ["truncated.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], // signature + IHDR tag, no dimensions
    ["zero.png", Buffer.alloc(0)],
    ["notanimage.png", Buffer.from("this is plain text, not an image at all")],
    ["pngnoihdr.png", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("0000000d", "hex"), Buffer.from("XXXX", "latin1"), Buffer.alloc(12)])],
    ["zerodims.png", png(0, 0)],
    ["jpegnosof.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)])],
  ];
  for (const [name, bytes] of cases) {
    const p = path.join(d, name);
    writeFileSync(p, bytes);
    assert.equal(imageFacts(p), null, `${name} must be refused`);
  }
});

test("[VISION] a symbolic link is never read as an image, even when it points at a real one", () => {
  const d = dir();
  const real = path.join(d, "real.png");
  writeFileSync(real, png(100, 100));
  const link = path.join(d, "link.png");
  try { symlinkSync(real, link); } catch { return; } // Windows without developer mode cannot create one
  assert.equal(imageFacts(link), null, "the builder shares the workspace; a link is not evidence");
});

// ── Failure B: the budget ──

test("[VISION] token cost follows PIXEL DIMENSIONS, not file size: a tall full-page screenshot is the expensive case", () => {
  const screen = estimateImageTokens(1366, 768);
  const fullPage = estimateImageTokens(1920, 4000);
  assert.ok(fullPage > 6 * screen, `a full-page capture costs far more than a viewport one (${fullPage} vs ${screen})`);
  // The real gallery references are tall captures; this is why six of them filled a 49,152-token window.
  assert.ok(fullPage * 6 > 49_152, `six full-page references exceed the window on their own (${fullPage * 6})`);
  // Monotonic and capped.
  assert.ok(estimateImageTokens(4000, 4000) >= estimateImageTokens(2000, 2000));
  assert.ok(estimateImageTokens(100_000, 100_000) <= 16_384, "capped, like the models' own smart-resize limit");
});

test("[VISION] REGRESSION: the bld_889ff809 request now fits — the budget sends as many references as fit and explains every exclusion", () => {
  const d = dir();
  // Six tall full-page references, the gallery's real selection size and shape.
  const files = Array.from({ length: 6 }, (_, i) => {
    const p = path.join(d, `ref${i}.png`);
    writeFileSync(p, png(1920, 4000));
    return { path: p, label: `gallery reference image ${i + 1}` };
  });
  const plan = planVisionRequest(files, { windowTokens: 49_152, promptTokens: 2_500, reserveOutput: 8_192, reserveRetry: 2_048 });

  assert.ok(plan.images.length >= 1, "at least one reference still reaches the model");
  assert.ok(plan.images.length < 6, `not all six, because they do not fit (${plan.images.length} sent)`);
  assert.equal(plan.images.length + plan.dropped.length, 6, "every candidate is either sent or accounted for");
  for (const dr of plan.dropped) assert.ok(dr.reason.length > 10, `each exclusion says why: ${dr.reason}`);
  // The whole point: the request cannot overflow the window any more.
  assert.ok(plan.estimatedRequestTokens + 8_192 + 2_048 <= 49_152, `prompt + images + output + retry headroom fit (${plan.estimatedRequestTokens})`);
  // Order is preserved, so the most relevant references are the ones that survive.
  assert.deepEqual(plan.images.map((i) => i.label), files.slice(0, plan.images.length).map((f) => f.label));
});

test("[VISION] the output reserve and the retry headroom are both honoured: a corrective retry cannot tip the request over", () => {
  const d = dir();
  const files = Array.from({ length: 4 }, (_, i) => {
    const p = path.join(d, `r${i}.png`);
    writeFileSync(p, png(1366, 768));
    return { path: p, label: `ref ${i}` };
  });
  const window = 20_000, promptTokens = 3_000, reserveOutput = 4_096, reserveRetry = 2_048;
  const plan = planVisionRequest(files, { windowTokens: window, promptTokens, reserveOutput, reserveRetry });
  assert.equal(plan.budgetForImages, window - promptTokens - reserveOutput - reserveRetry);
  // A retry appends text; simulate it growing the prompt by the whole reserve and confirm it still fits.
  assert.ok(promptTokens + reserveRetry + plan.imageTokens + reserveOutput <= window, "the appended correction still fits");
});

test("[VISION] a smaller image cap produces a strictly smaller request, which is what an overflow retry needs", () => {
  const d = dir();
  const files = Array.from({ length: 6 }, (_, i) => {
    const p = path.join(d, `s${i}.png`);
    writeFileSync(p, png(1366, 768));
    return { path: p, label: `ref ${i}` };
  });
  const budget = { windowTokens: 49_152, promptTokens: 2_000, reserveOutput: 4_096, reserveRetry: 2_048 };
  const six = planVisionRequest(files, budget, 6);
  const three = planVisionRequest(files, budget, 3);
  const one = planVisionRequest(files, budget, 1);
  assert.ok(three.imageTokens < six.imageTokens, "halving the cap shrinks the request");
  assert.ok(one.imageTokens < three.imageTokens);
  assert.equal(one.images.length, 1);
  assert.ok(three.dropped.some((x) => /beyond the 3-image limit/.test(x.reason)), "the cap is recorded as the reason");
});

test("[VISION] a window with no room for images sends none and says so, instead of overflowing", () => {
  const d = dir();
  const p = path.join(d, "big.png");
  writeFileSync(p, png(1920, 4000));
  const plan = planVisionRequest([{ path: p, label: "ref" }], { windowTokens: 8_192, promptTokens: 3_000, reserveOutput: 4_096, reserveRetry: 1_024 });
  assert.equal(plan.images.length, 0);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].reason, /image budget remain/);
  assert.match(plan.dropped[0].reason, /1920x4000 would cost about \d+ tokens/, "the reason names the real dimensions and cost");
  assert.equal(plan.imageTokens, 0);
});

test("[VISION] an unreadable candidate is dropped with a reason and does not consume budget", () => {
  const d = dir();
  const good = path.join(d, "good.png");
  writeFileSync(good, png(800, 600));
  const bad = path.join(d, "bad.png");
  writeFileSync(bad, Buffer.from("not an image"));
  const plan = planVisionRequest([{ path: bad, label: "broken" }, { path: good, label: "fine" }], { windowTokens: 49_152, promptTokens: 1_000, reserveOutput: 2_048 });
  assert.deepEqual(plan.images.map((i) => i.label), ["fine"]);
  assert.match(plan.dropped[0].reason, /not a readable image/);
  assert.equal(plan.images[0].width, 800);
});
