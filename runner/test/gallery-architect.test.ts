// The Design Gallery reaching the model that makes the design decisions (Founder directive, 2026-11-03).
//
// `LocalModelAdvisor.architect()` used to call `ask()` with no images at all. A vision-capable Model A therefore
// never saw the Design Gallery, and never saw the customer's own uploaded references either -- only their file
// names went into the prompt as JSON metadata. Passing an image PATH to a model is not visual interpretation, and
// the directive is explicit that it must not be reported as such.
//
// These tests inspect the request that actually reaches the OpenAI-compatible client, so they fail if the images
// stop being attached, whatever the prompt claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalModelAdvisor, architectPrompt, galleryBlock, safeImageFile } from "../src/orchestrator/advisors.ts";
import type { ArchitectInput, GalleryReferenceInput } from "../src/orchestrator/contracts.ts";
import type { ModelProfile } from "../src/config.ts";

const SPEC = {
  schema: "crestmont.master-spec/1", designSpec: "red white and blue, bold", masterPrompt: "build it",
  tasks: [], acceptanceCriteria: [], integrations: [], risks: [],
};

const model = (vision: boolean): ModelProfile =>
  ({ tag: vision ? "qwen3.8:27b-q4_K_M" : "text-only-model", role: "architect_reviewer", contextTokens: 8192, vramMb: 0, quantization: null, reasoning: null, vision, license: null });

/** A real PNG header on disk: the adapter reads and base64-encodes whatever it is given. */
function pngs(n: number): { dir: string; files: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "gallery-"));
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `ref${i}.png`);
    writeFileSync(p, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    files.push(p);
  }
  return { dir, files };
}

const ref = (id: string, industry: string, relevance: number, p: string | null): GalleryReferenceInput => ({
  id, title: `${industry} reference ${id}`, industry, relevance, why: `${industry} match`, tags: ["bold"],
  notes: { typography: "condensed display", layout: "full-bleed hero", color: null, animation: null, responsive: null, quality: null },
  path: p, variant: p ? "desktop" : null,
});

/** Captures the request the adapter builds, then answers with a valid specification. */
function capture() {
  const seen: { messages: unknown[] }[] = [];
  const client = {
    async chat(req: { messages: unknown[] }) {
      seen.push(req);
      return { content: JSON.stringify(SPEC), toolCalls: [], usage: null, ms: 1 };
    },
  };
  return { client, seen };
}

const parts = (seen: { messages: unknown[] }[]) => {
  const user = (seen[0].messages as { role: string; content: unknown }[]).find((m) => m.role === "user")!;
  return Array.isArray(user.content) ? user.content as { type: string; text?: string; image_url?: { url: string } }[] : [];
};

const input = (galleryReferences: GalleryReferenceInput[]): ArchitectInput => ({
  brief: { customerData: { business: { name: "Junk in the Trunk", industry: "Junk removal and hauling" } } },
  referenceImages: [], referenceUrls: [], maxSessions: 1, galleryReferences,
});

test("[GALLERY-ARCH] a vision architect is sent the gallery images themselves, in relevance order", async () => {
  const { files } = pngs(3);
  const { client, seen } = capture();
  const advisor = new LocalModelAdvisor({ client: client as never, scheduler: null, projectId: "prj_t", model: model(true), repo: process.cwd(), maxTurns: 4, maxOutputTokens: 512, temperature: 0 });

  const refs = [ref("dr_1", "construction", 1, files[0]), ref("dr_2", "home-services", 0.7, files[1]), ref("dr_3", "minimalist", 0.15, files[2])];
  await advisor.architect(input(refs));

  const content = parts(seen);
  const images = content.filter((p) => p.type === "image_url");
  assert.equal(images.length, 3, "every retrieved gallery image is attached to the request");
  assert.ok(images.every((i) => i.image_url!.url.startsWith("data:image/png;base64,")), "as real bytes, not as a path");
  // The labels must name the images in the order the prompt refers to them, or "Image 2" means nothing.
  const labels = content.filter((p) => p.type === "text" && /gallery reference image/.test(p.text ?? "")).map((p) => p.text);
  assert.deepEqual(labels, ["gallery reference image 1", "gallery reference image 2", "gallery reference image 3"]);
  assert.deepEqual(advisor.lastArchitectImages.map((i) => i.referenceId), ["dr_1", "dr_2", "dr_3"],
    "and the adapter reports exactly what it sent, which is what the platform records as seen");
});

test("[GALLERY-ARCH] a text-only architect is sent no images and the prompt says so, rather than implying it looked", async () => {
  const { files } = pngs(2);
  const { client, seen } = capture();
  const advisor = new LocalModelAdvisor({ client: client as never, scheduler: null, projectId: "prj_t", model: model(false), repo: process.cwd(), maxTurns: 4, maxOutputTokens: 512, temperature: 0 });

  await advisor.architect(input([ref("dr_1", "construction", 1, files[0]), ref("dr_2", "home-services", 0.7, files[1])]));

  const user = (seen[0].messages as { role: string; content: unknown }[]).find((m) => m.role === "user")!;
  assert.equal(typeof user.content, "string", "a text-only model gets a plain prompt, never an image part");
  assert.match(user.content as string, /CANNOT SEE IMAGES/, "and is told plainly that it is not looking at them");
  assert.equal(advisor.lastArchitectImages.length, 0, "nothing is reported as seen");
});

test("[GALLERY-ARCH] a reference whose image could not be retrieved is named as unseen, never quietly described", () => {
  const block = galleryBlock([ref("dr_1", "construction", 1, "C:/tmp/a.png"), ref("dr_2", "luxury", 0, null)], ["dr_1"], true).join("\n");
  assert.match(block, /Image 1: "construction reference dr_1"/, "only the attached reference is numbered");
  assert.match(block, /NOT attached here/);
  assert.match(block, /luxury reference dr_2.*image could not be retrieved/, "and it says WHY it is not being looked at");
  // The written notes must survive into the prompt: they are all the model has for an unattached reference.
  assert.match(block, /full-bleed hero/);
  assert.match(block, /RIGHTS: inspiration only/, "and the rights restriction travels with them");
});

// Numbering must describe THIS message. A reference that exists on disk but did not fit the image budget is a
// different case from one that could never be fetched, and calling it "Image 3" would point the model at an
// image that is not there.
test("[GALLERY-ARCH] a retrieved reference that was not attached is numbered nowhere and says so", () => {
  const refs = [ref("dr_1", "construction", 1, "C:/tmp/a.png"), ref("dr_2", "construction", 1, "C:/tmp/b.png")];
  const block = galleryBlock(refs, ["dr_1"], true).join("\n");
  assert.match(block, /1 reference image\(s\) are ATTACHED/);
  assert.match(block, /Image 1: "construction reference dr_1"/);
  assert.doesNotMatch(block, /Image 2:/, "the unattached reference is never given an image number");
  assert.match(block, /construction reference dr_2.*not attached to this message/);
});

test("[GALLERY-ARCH] the three-concept instruction and the no-copy rule are in the architect's prompt", () => {
  const p = architectPrompt(input([ref("dr_1", "construction", 1, "C:/tmp/a.png")]), ["dr_1"]);
  assert.match(p, /TWO OR THREE separate design concepts/, "the templates are not treated as one layout");
  assert.match(p, /Never merge three unrelated palettes/);
  assert.match(p, /real hex values/, "the design spec must be implementable, not adjectives");
  assert.match(p, /builder model CANNOT see these images/, "the architect knows it is the only one that can look");
  assert.doesNotMatch(architectPrompt(input([]), []), /DESIGN REFERENCES/, "no gallery, no claim of one");
});

test("[GALLERY-ARCH] a planted symbolic link is never read as a reference image", () => {
  const { dir, files } = pngs(1);
  const link = path.join(dir, "link.png");
  try { symlinkSync(files[0], link); } catch { return; } // Windows without developer mode: nothing to test
  assert.equal(safeImageFile(files[0]), true, "a real file is fine");
  assert.equal(safeImageFile(link), false, "a symbolic link is refused, as for screenshots");
  assert.equal(safeImageFile(path.join(dir, "missing.png")), false);
});
