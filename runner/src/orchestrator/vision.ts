// Multimodal request budgeting: how many images fit in a model's context window, what they really are, and how
// many tokens they will actually cost.
//
// Why this exists. Build bld_889ff809c133920c929a7121 failed its third architect attempt with
//   request (49186 tokens) exceeds the available context size (49152 tokens)
// — 34 tokens over. The architect attached a fixed six gallery references with no accounting at all: not for the
// images' own token cost, not for the prompt, not for the reply's reserve, and not for the extra text a corrective
// retry appends. The sixth image tipped a request that was already at the limit.
//
// Two facts drive everything here:
//
//  1. An image's token cost comes from its PIXEL DIMENSIONS, not its file size. The gallery's references are
//     full-page desktop screenshots — tall, and far more expensive than their megabytes suggest. A 1920x4000
//     screenshot costs roughly (1920/28)*(4000/28) ~ 9,800 tokens on a Qwen-VL-style patch grid, which is why six
//     of them consumed a 49,152-token window on their own.
//  2. The format must be detected from the bytes. The adapter hardcoded `data:image/png` for every attachment,
//     while the runner saves gallery images as .jpg or .webp when that is what R2 served. A JPEG announced as a
//     PNG is a decode failure waiting to happen.
//
// Deliberately NOT done here: re-encoding or downscaling. This repository has no image library, and shrinking a
// three-concept reference layout is exactly how its important design detail becomes unreadable. Fitting the budget
// by sending FEWER references at full fidelity is both simpler and better for the design work.
import { readFileSync, statSync, existsSync, lstatSync } from "node:fs";

/** Formats a vision model can be sent. Anything else is refused rather than relabelled. */
export const ALLOWED_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"] as const);
export type ImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export interface ImageFacts {
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
  /** Conservative token estimate for this image on a patch-grid vision model. */
  tokens: number;
}

/**
 * Patch size used for the estimate. Qwen-VL-family models tokenise on a 28x28 patch grid (14px ViT patches with a
 * 2x2 merge), which is what Node 1's Model A is. A smaller number here would over-estimate and waste budget; a
 * larger one would under-estimate and risk the overflow this module exists to prevent.
 */
const PATCH = 28;
/** Safety factor on the estimate: an estimate is not a measurement, and the cost of being wrong is a failed build. */
const TOKEN_SAFETY = 1.15;
/** Hard ceiling per image, matching the "smart resize" cap these models apply before tokenising. */
const MAX_IMAGE_TOKENS = 16_384;

/** Big-endian readers that never run off the end of the buffer. */
const u32 = (b: Buffer, o: number): number => (o + 4 <= b.length ? b.readUInt32BE(o) : 0);
const u16 = (b: Buffer, o: number): number => (o + 2 <= b.length ? b.readUInt16BE(o) : 0);
const u24le = (b: Buffer, o: number): number => (o + 3 <= b.length ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) : 0);

/**
 * What an image actually is, read from its own bytes.
 *
 * Never from the file extension: the builder shares the workspace, so an extension is a claim, not evidence.
 * Returns null for anything unrecognised, truncated or zero-sized, which the caller refuses rather than guesses at.
 */
export function detectImage(buf: Buffer): { mime: ImageMime; width: number; height: number } | null {
  // PNG: 8-byte signature, then an IHDR chunk whose width/height sit at fixed offsets.
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
    const width = u32(buf, 16), height = u32(buf, 20);
    return width && height ? { mime: "image/png", width, height } : null;
  }
  // GIF: "GIF87a"/"GIF89a", then little-endian width/height.
  if (buf.length >= 10 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) {
    const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8);
    return width && height ? { mime: "image/gif", width, height } : null;
  }
  // WebP: RIFF container; the dimensions live in the VP8 / VP8L / VP8X chunk.
  if (buf.length >= 30 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = buf.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") {
      const width = u24le(buf, 24) + 1, height = u24le(buf, 27) + 1;
      return width > 1 && height > 1 ? { mime: "image/webp", width, height } : null;
    }
    if (chunk === "VP8 ") {
      const width = buf.readUInt16LE(26) & 0x3fff, height = buf.readUInt16LE(28) & 0x3fff;
      return width && height ? { mime: "image/webp", width, height } : null;
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1, height = ((bits >> 14) & 0x3fff) + 1;
      return width > 1 && height > 1 ? { mime: "image/webp", width, height } : null;
    }
    return null;
  }
  // JPEG: SOI, then walk the segment chain to a Start-Of-Frame marker. Walking (rather than scanning for bytes)
  // keeps EXIF thumbnails and comment payloads from being mistaken for the frame header.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }          // resynchronise on fill bytes
      const marker = buf[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16(buf, o + 2);
      if (len < 2) return null;
      // SOF0..SOF15, excluding DHT (C4), JPGA (C8) and DAC (CC), carry the frame dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = u16(buf, o + 5), width = u16(buf, o + 7);
        return width && height ? { mime: "image/jpeg", width, height } : null;
      }
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/** Conservative token cost of an image of these dimensions. */
export function estimateImageTokens(width: number, height: number): number {
  const patches = Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
  return Math.min(MAX_IMAGE_TOKENS, Math.ceil(patches * TOKEN_SAFETY));
}

/**
 * Read and vet one image file: a real regular file (never a symlink the agent planted), inside the size limit, in
 * a format a vision model accepts, with dimensions that parse.
 */
export function imageFacts(p: string, maxBytes = 8 * 1024 * 1024): ImageFacts | null {
  try {
    if (!existsSync(p) || !lstatSync(p).isFile()) return null;
    const bytes = statSync(p).size;
    if (bytes === 0 || bytes > maxBytes) return null;
    const d = detectImage(readFileSync(p));
    if (!d) return null;
    return { mime: d.mime, width: d.width, height: d.height, bytes, tokens: estimateImageTokens(d.width, d.height) };
  } catch { return null; }
}

/** An image the request will carry, with the data URL built from its REAL format. */
export interface PreparedImage {
  path: string;
  label: string;
  mime: ImageMime;
  width: number;
  height: number;
  tokens: number;
}

export interface VisionBudget {
  /** The model's configured context window. */
  windowTokens: number;
  /** Estimated tokens of the prompt text and system message. */
  promptTokens: number;
  /** Output capacity reserved for the reply (max_tokens). */
  reserveOutput: number;
  /** Extra headroom so a corrective retry, which APPENDS text, cannot push the request over the window. */
  reserveRetry?: number;
}

export interface VisionPlan {
  images: PreparedImage[];
  /** Images left out, and why — recorded, never silently dropped. */
  dropped: { path: string; label: string; reason: string }[];
  imageTokens: number;
  estimatedRequestTokens: number;
  budgetForImages: number;
}

/**
 * Decide which images fit, in the order given (most relevant first).
 *
 * Callers pass images in priority order and get back those that fit the budget, with every exclusion explained. An
 * image that is unreadable, oversized or of an unknown format is refused here rather than sent mislabelled.
 */
export function planVisionRequest(
  candidates: readonly { path: string; label: string }[],
  budget: VisionBudget,
  maxImages = 6,
): VisionPlan {
  const reserveRetry = budget.reserveRetry ?? 0;
  const budgetForImages = Math.max(0, budget.windowTokens - budget.promptTokens - budget.reserveOutput - reserveRetry);
  const images: PreparedImage[] = [];
  const dropped: VisionPlan["dropped"] = [];
  let imageTokens = 0;
  for (const c of candidates) {
    if (images.length >= maxImages) { dropped.push({ ...c, reason: `beyond the ${maxImages}-image limit` }); continue; }
    const f = imageFacts(c.path);
    if (!f) { dropped.push({ ...c, reason: "not a readable image in an accepted format (png, jpeg, webp, gif), or too large" }); continue; }
    if (imageTokens + f.tokens > budgetForImages) {
      dropped.push({ ...c, reason: `${f.width}x${f.height} would cost about ${f.tokens} tokens; only ${budgetForImages - imageTokens} of the ${budgetForImages}-token image budget remain` });
      continue;
    }
    imageTokens += f.tokens;
    images.push({ path: c.path, label: c.label, mime: f.mime, width: f.width, height: f.height, tokens: f.tokens });
  }
  return { images, dropped, imageTokens, estimatedRequestTokens: budget.promptTokens + imageTokens, budgetForImages };
}

/** The data URL for a prepared image, with its real MIME type. */
export function dataUrl(img: Pick<PreparedImage, "path" | "mime">): string {
  return `data:${img.mime};base64,${readFileSync(img.path).toString("base64")}`;
}
