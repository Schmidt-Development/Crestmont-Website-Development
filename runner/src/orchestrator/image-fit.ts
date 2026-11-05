// Making an image small enough to show the builder, without making it unreadable. (V5 correction §3, §4.)
//
// WHY THIS EXISTS, in measured numbers from bld_10e2c6007686faee0ab64d45 on Node 1:
//
//   a Design Gallery reference  1670x941   ->  2,346 tokens
//   index-desktop.png (full page) 1366x3608 ->  7,270 tokens
//   Model B's window                           65,536 tokens, of which ~49,000 were already in use after a reset
//
// So "attach the reference and the rendered page to the builder" is, unmodified, an 9,600-token addition to every
// single call in a context that was already resetting 55 times per attempt. Attaching them unbudgeted would undo
// the context repair; dropping them because they do not fit would leave the builder blind again.
//
// The way out is the one the directive names: bounded, purposeful images. A full-page screenshot is mostly the
// parts nobody is working on. The viewport crop -- what a visitor sees before scrolling -- is a fifth of the cost
// and carries the composition that actually decides whether a design looks professional. An overview downscale
// keeps the whole composition at a readable size. Both record what they did to the original, so the manifest can
// state the relationship rather than implying the builder saw the original file.
//
// THE LEGIBILITY FLOOR is the point of the whole module. A resampler asked to hit a token budget will happily
// return a 180-pixel-wide thumbnail of a three-concept reference, in which the typography, spacing and layout the
// builder is supposed to study no longer exist. Below MIN_READABLE_WIDTH this module REFUSES and says why, so the
// caller drops the image honestly instead of attaching something that cannot be read.
//
// Pure TypeScript over node:zlib: no native image dependency is added to the runner image.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import path from "node:path";

/** 8-bit RGB pixels, three bytes per pixel, row-major. */
export interface RasterImage { width: number; height: number; rgb: Uint8Array }

/**
 * Narrower than a photograph of text, wider than a thumbnail: below this, a website screenshot's body copy and
 * spacing rhythm stop being judgeable, which makes attaching it worse than saying it did not fit.
 */
export const MIN_READABLE_WIDTH = 640;

/** The token cost model the rest of the pipeline uses (orchestrator/vision.ts): a 28x28 patch grid, 1.15 safety. */
const PATCH = 28;
const SAFETY = 1.15;
export const tokensFor = (w: number, h: number): number => Math.min(16_384, Math.ceil(Math.ceil(w / PATCH) * Math.ceil(h / PATCH) * SAFETY));
/** The largest pixel count that fits a token budget under that model. */
const pixelsFor = (tokens: number): number => Math.max(1, Math.floor((tokens / SAFETY) * PATCH * PATCH));

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const paeth = (a: number, b: number, c: number): number => {
  const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode a non-interlaced, 8-bit PNG in greyscale, truecolour, greyscale+alpha or truecolour+alpha.
 *
 * That is what the two producers here actually emit -- Chromium's screenshots and the gallery's stored references
 * are both `bitDepth 8, colorType 2, interlace 0`, verified on the real files. Anything else returns null, which
 * the caller reports as "could not be prepared" rather than guessing at the pixels.
 */
export function decodePng(buf: Buffer): RasterImage | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || !width || !height) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels || !idat.length) return null;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  // Undo the per-row filters in place, then drop alpha and expand grey to RGB.
  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      const x = src[i];
      cur[i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c) : x) & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels, d = i * 3;
    if (channels >= 3) { rgb[d] = lines[s]; rgb[d + 1] = lines[s + 1]; rgb[d + 2] = lines[s + 2]; }
    else { rgb[d] = rgb[d + 1] = rgb[d + 2] = lines[s]; }
  }
  return { width, height, rgb };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit truecolour PNG, filter 0 (the bytes are re-compressed, so the filter choice costs only size). */
export function encodePng(img: RasterImage): Buffer {
  const { width: w, height: h, rgb } = img;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (1 + w * 3) + 1 + i] = v; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Top-left anchored crop. */
export function crop(img: RasterImage, x: number, y: number, w: number, h: number): RasterImage {
  const cw = Math.max(1, Math.min(w, img.width - x)), ch = Math.max(1, Math.min(h, img.height - y));
  const out = new Uint8Array(cw * ch * 3);
  for (let r = 0; r < ch; r++) {
    const from = ((y + r) * img.width + x) * 3;
    out.set(img.rgb.subarray(from, from + cw * 3), r * cw * 3);
  }
  return { width: cw, height: ch, rgb: out };
}

/**
 * Area-average downscale.
 *
 * Averaged, not sampled: nearest-neighbour on a page of 16px body copy produces aliased noise that a model reads
 * as a rendering defect. Averaging keeps the type grey but legible, which is what judging a type scale needs.
 */
export function downscale(img: RasterImage, w: number, h: number): RasterImage {
  if (w >= img.width && h >= img.height) return img;
  const out = new Uint8Array(w * h * 3);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        let i = (yy * img.width + x0) * 3;
        for (let xx = x0; xx < x1 && xx < img.width; xx++, i += 3) { r += img.rgb[i]; g += img.rgb[i + 1]; b += img.rgb[i + 2]; n++; }
      }
      const d = (y * w + x) * 3;
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n); out[d + 2] = Math.round(b / n);
    }
  }
  return { width: w, height: h, rgb: out };
}

/**
 * One concept within a multi-concept reference sheet, in fractions of the whole image.
 *
 * Fractions rather than pixels because the caller knows "the left of three", not "x=0..557" -- and because the
 * same selection then survives a reference being re-captured at a different size.
 */
export interface ConceptRegion { x: number; y: number; width: number; height: number; label: string }

/** The nth of `count` concepts laid out side by side, which is how the gallery's multi-concept sheets are built. */
export function conceptColumn(index: number, count: number): ConceptRegion {
  const n = Math.max(1, Math.floor(count));
  const i = Math.max(0, Math.min(n - 1, Math.floor(index)));
  return { x: i / n, y: 0, width: 1 / n, height: 1, label: `concept ${i + 1} of ${n} (${i === 0 ? "left" : i === n - 1 ? "right" : "middle"})` };
}

/** What was done to an original file to make it showable, recorded so nothing has to be taken on trust. */
export interface FitRecord {
  /** "none" when the original fitted and is sent unchanged. */
  operation: "none" | "overview" | "viewport-crop" | "viewport-crop+overview" | "concept-crop" | "concept-crop+overview";
  /** The concept selected from a multi-concept sheet, when one was. */
  concept?: string;
  from: { path: string; width: number; height: number; bytes: number; sha256: string };
  to: { path: string; width: number; height: number; bytes: number; sha256: string; tokens: number };
  /** Plain-language relationship between the two, for the manifest and the report. */
  note: string;
}

export interface FitRefusal { refused: true; reason: string; from: { path: string; width: number; height: number } | null }

/** A filename-safe form of a concept label, so three crops of one sheet cannot overwrite each other. */
const slug = (s: string | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "region";

const sha = (b: Uint8Array | Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Prepare one image for a model request within a token budget.
 *
 * `purpose`:
 *   "overview"  - the whole composition, downscaled as little as the budget allows. For a gallery reference: the
 *                 point is the composition, and cropping one would hide the very thing being referenced.
 *   "viewport"  - what a visitor sees before scrolling, at native resolution where possible. For a rendered page:
 *                 a 1366x3608 full-page capture costs 7,270 tokens and is mostly footer.
 *
 * Returns a refusal rather than an unreadable image: below MIN_READABLE_WIDTH there is nothing to study.
 */
export function fitForVision(
  file: string,
  outDir: string,
  o: { maxTokens: number; purpose: "overview" | "viewport"; viewportHeight?: number; minWidth?: number; region?: ConceptRegion },
): (FitRecord & { refused?: false }) | FitRefusal {
  let buf: Buffer;
  try { buf = readFileSync(file); } catch (err) { return { refused: true, reason: `could not be read: ${err instanceof Error ? err.message : String(err)}`, from: null }; }
  const img = decodePng(buf);
  if (!img) return { refused: true, reason: "not a non-interlaced 8-bit PNG, so it could not be prepared without guessing at its pixels", from: null };
  const from = { path: file, width: img.width, height: img.height, bytes: buf.length, sha256: sha(buf) };
  const minWidth = o.minWidth ?? MIN_READABLE_WIDTH;

  // The concept selection happens before anything else: everything after it is about the one design in question.
  let work = img;
  let operation: FitRecord["operation"] = "overview";
  let concept: string | undefined;
  if (o.region) {
    const r = o.region;
    work = crop(img, Math.round(r.x * img.width), Math.round(r.y * img.height), Math.round(r.width * img.width), Math.round(r.height * img.height));
    operation = "concept-crop";
    concept = r.label;
  }

  if (tokensFor(work.width, work.height) <= o.maxTokens) {
    if (!o.region) return { operation: "none", from, to: { ...from, tokens: tokensFor(img.width, img.height) }, note: `sent unchanged: ${img.width}x${img.height} costs ${tokensFor(img.width, img.height)} tokens, within the ${o.maxTokens}-token budget` };
    const outC = encodePng(work);
    const nameC = `${path.basename(file, path.extname(file))}--${slug(concept)}-${work.width}x${work.height}.png`;
    const destC = path.join(outDir, nameC);
    writeFileSync(destC, outC);
    return {
      operation: "concept-crop", concept, from,
      to: { path: destC, width: work.width, height: work.height, bytes: outC.length, sha256: sha(outC), tokens: tokensFor(work.width, work.height) },
      note: `${concept} of the ${img.width}x${img.height} reference sheet, at native resolution (${work.width}x${work.height}); the original file is unchanged on disk and the other concepts were not sent`,
    };
  }

  if (o.purpose === "viewport" && !o.region) {
    const vh = Math.min(work.height, o.viewportHeight ?? Math.round(work.width * 0.75));
    if (vh < work.height) { work = crop(work, 0, 0, work.width, vh); operation = "viewport-crop"; }
  }

  // Downscale only as far as the budget demands, preserving the aspect ratio.
  const budgetPixels = pixelsFor(o.maxTokens);
  if (work.width * work.height > budgetPixels) {
    // The patch grid rounds UP on each axis, so the pixel-count inverse alone can still land a few tokens over
    // budget (measured: a 2,000-token budget produced 2,034). Step down until the REAL cost fits, so "within the
    // budget" is true of the file that is actually sent rather than of the arithmetic that chose its size.
    let k = Math.sqrt(budgetPixels / (work.width * work.height));
    let w = Math.max(1, Math.floor(work.width * k)), h = Math.max(1, Math.floor(work.height * k));
    for (let guard = 0; guard < 24 && tokensFor(w, h) > o.maxTokens && w > 1 && h > 1; guard++) {
      k *= 0.97;
      w = Math.max(1, Math.floor(work.width * k)); h = Math.max(1, Math.floor(work.height * k));
    }
    if (w < minWidth) {
      return {
        refused: true,
        from: { path: file, width: img.width, height: img.height },
        reason: `${img.width}x${img.height} would have to be reduced to ${w}px wide to fit ${o.maxTokens} tokens, below the ${minWidth}px at which a website's typography and spacing can still be judged. It is left out rather than sent unreadable.`,
      };
    }
    work = downscale(work, w, h);
    operation = operation === "viewport-crop" ? "viewport-crop+overview" : operation === "concept-crop" ? "concept-crop+overview" : "overview";
  }

  const out = encodePng(work);
  const name = `${path.basename(file, path.extname(file))}--${operation.replace(/\+/g, "-")}${concept ? `-${slug(concept)}` : ""}-${work.width}x${work.height}.png`;
  const dest = path.join(outDir, name);
  writeFileSync(dest, out);
  const to = { path: dest, width: work.width, height: work.height, bytes: out.length, sha256: sha(out), tokens: tokensFor(work.width, work.height) };
  if (operation === "concept-crop+overview") {
    return { operation, concept, from, to, note: `${concept} of the ${img.width}x${img.height} reference sheet, reduced to ${work.width}x${work.height} to fit ${o.maxTokens} tokens; the original file is unchanged on disk and the other concepts were not sent` };
  }
  const note = operation === "viewport-crop"
    ? `the top ${work.height}px of ${img.width}x${img.height} at native resolution (what a visitor sees before scrolling); the original file is unchanged on disk`
    : operation === "viewport-crop+overview"
      ? `the top of ${img.width}x${img.height}, cropped and then reduced to ${work.width}x${work.height} to fit ${o.maxTokens} tokens; the original file is unchanged on disk`
      : `the whole of ${img.width}x${img.height} reduced to ${work.width}x${work.height} to fit ${o.maxTokens} tokens, keeping the full composition; the original file is unchanged on disk`;
  return { operation, from, to, note };
}
