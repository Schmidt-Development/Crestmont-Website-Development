// Which images actually reached which model. (V5 correction §3, §8.)
//
// WHY A MANIFEST AND NOT A LOG LINE. Every claim in this area is of the form "the model saw X", and every one of
// them was previously unfalsifiable. bld_10e2c6007686faee0ab64d45 recorded that six Design Gallery references were
// retrieved; what it could not say was which of them survived the request budget into Model A's actual request,
// which concept of a three-concept sheet was being referred to, or -- the gap this correction exists to close --
// that Model B received none of them, ever, because the builder's provider had no image path at all.
//
// So delivery is recorded where it happens, from what the request ACTUALLY carried, with the sha256 of the exact
// bytes sent. An image that the budget dropped is recorded as an exclusion with the reason. "Model B was shown the
// approved reference" then has a file behind it that can be opened and checked, or it is not said.
//
// The manifest also keeps the chain back to the original: the gallery file is never modified, and a crop or
// downscale sent to a model records its relationship to the original it came from (image-fit.ts). That matters for
// rights as much as for provenance -- a reference may be looked at and may not be published, and the manifest is
// where "looked at" is written down.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const REFERENCE_MANIFEST_SCHEMA = "crestmont.reference-manifest/1";

/** Who can be shown an image, and therefore what a delivery claim can be about. */
export type Recipient = "architect" | "builder" | "reviewer";

export interface Delivery {
  to: Recipient;
  at: string;
  /** What the model was given: the original, or a crop/downscale of it. */
  sentPath: string;
  sentSha256: string;
  width: number;
  height: number;
  tokens: number;
  /** image-fit.ts operation; "none" when the original file itself was sent. */
  operation: string;
  /** The concept selected from a multi-concept sheet, when one was. */
  concept?: string;
  /** The relationship between what was sent and the original, in words. */
  note: string;
  /** The phase or call this delivery belongs to, so a repair cycle's inputs can be found again. */
  context: string;
}

export interface Exclusion {
  to: Recipient;
  at: string;
  reason: string;
  context: string;
}

export interface ReferenceEntry {
  /** Gallery reference id, or a synthetic id for a rendered screenshot. */
  id: string;
  kind: "gallery_reference" | "customer_upload" | "rendered_screenshot";
  title: string;
  /** The untouched file on disk. Never modified; crops are written elsewhere. */
  originalPath: string;
  originalSha256: string;
  originalWidth: number | null;
  originalHeight: number | null;
  /** For a rendered screenshot: the commit whose source produced it, and the viewport it was taken at. */
  sourceCommit?: string | null;
  viewport?: string | null;
  /** When the sheet holds several designs, which one this build approved. */
  concept?: string | null;
  /** What the approved blueprint took from it. */
  blueprintRelation?: string | null;
  /** Whether this file may appear in the customer's published website. A gallery reference never may. */
  publishable: boolean;
  deliveries: Delivery[];
  exclusions: Exclusion[];
}

export interface ReferenceManifest {
  schema: typeof REFERENCE_MANIFEST_SCHEMA;
  jobId: string;
  attempt: number;
  updatedAt: string;
  references: ReferenceEntry[];
}

export const MANIFEST_FILE = "reference-manifest.json";

export const sha256File = (file: string): string => {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return ""; }
};

export function newManifest(jobId: string, attempt: number): ReferenceManifest {
  return { schema: REFERENCE_MANIFEST_SCHEMA, jobId, attempt, updatedAt: new Date().toISOString(), references: [] };
}

/**
 * Load the manifest for this job, or start one.
 *
 * Kept in the job directory, OUTSIDE the customer's repository: it records files the customer may not publish, and
 * a manifest of another studio's screenshots has no business being committed to their website.
 */
export function loadManifest(dir: string, jobId: string, attempt: number): ReferenceManifest {
  const file = path.join(dir, MANIFEST_FILE);
  if (!existsSync(file)) return newManifest(jobId, attempt);
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as ReferenceManifest;
    if (v?.schema !== REFERENCE_MANIFEST_SCHEMA || !Array.isArray(v.references)) return newManifest(jobId, attempt);
    // A later attempt continues the same manifest: the references are the same files and the delivery history of
    // earlier attempts is exactly what makes "which concept has this build been working from" answerable.
    return { ...v, attempt, references: v.references };
  } catch { return newManifest(jobId, attempt); }
}

export function saveManifest(dir: string, m: ReferenceManifest): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ ...m, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch { /* the manifest is evidence, not a dependency: a build never stops because it could not be written */ }
}

export function upsert(m: ReferenceManifest, e: Omit<ReferenceEntry, "deliveries" | "exclusions"> & Partial<Pick<ReferenceEntry, "deliveries" | "exclusions">>): ReferenceEntry {
  const found = m.references.find((r) => r.id === e.id && r.kind === e.kind);
  if (found) {
    // Re-seeding must never erase the delivery history, and must notice a file that changed underneath us.
    Object.assign(found, { ...e, deliveries: found.deliveries, exclusions: found.exclusions });
    return found;
  }
  const entry: ReferenceEntry = { ...e, deliveries: e.deliveries ?? [], exclusions: e.exclusions ?? [] };
  m.references.push(entry);
  return entry;
}

/** Record that a model's request actually carried this image. Called from where the request is built. */
export function recordDelivery(m: ReferenceManifest, id: string, d: Omit<Delivery, "at">): void {
  const ref = m.references.find((r) => r.id === id);
  if (!ref) return;
  ref.deliveries.push({ ...d, at: new Date().toISOString() });
  if (d.concept && !ref.concept) ref.concept = d.concept;
}

/** Record that an image was NOT sent, and why. An exclusion is evidence too -- it is what makes a claim refutable. */
export function recordExclusion(m: ReferenceManifest, id: string, x: Omit<Exclusion, "at">): void {
  const ref = m.references.find((r) => r.id === id);
  if (!ref) return;
  ref.exclusions.push({ ...x, at: new Date().toISOString() });
}

/** What the approved blueprint says each reference contributed, written back onto the manifest. */
export function noteBlueprint(m: ReferenceManifest, uses: readonly { referenceId: string; borrowed: string; appliesTo: string; concept?: string }[]): void {
  for (const u of uses) {
    const ref = m.references.find((r) => r.id === u.referenceId);
    if (!ref) continue;
    ref.blueprintRelation = `${u.borrowed} — applied to ${u.appliesTo}`;
    if (u.concept) ref.concept = u.concept;
  }
}

/** Has this recipient actually been given this reference at any point in the build? */
export function wasDelivered(m: ReferenceManifest, id: string, to: Recipient): boolean {
  return !!m.references.find((r) => r.id === id)?.deliveries.some((d) => d.to === to);
}

/** One-line summaries for the build log and the completion report; counts only, never impressions. */
export function manifestSummary(m: ReferenceManifest): string {
  const g = m.references.filter((r) => r.kind === "gallery_reference");
  const shots = m.references.filter((r) => r.kind === "rendered_screenshot");
  const seenBy = (to: Recipient, from: ReferenceEntry[]) => from.filter((r) => r.deliveries.some((d) => d.to === to)).length;
  return [
    `${g.length} gallery reference(s): architect saw ${seenBy("architect", g)}, builder saw ${seenBy("builder", g)}, reviewer saw ${seenBy("reviewer", g)}`,
    shots.length ? `${shots.length} rendered screenshot(s): builder saw ${seenBy("builder", shots)}, reviewer saw ${seenBy("reviewer", shots)}` : "no rendered screenshots delivered yet",
    `${m.references.reduce((n, r) => n + r.exclusions.length, 0)} exclusion(s) recorded`,
  ].join("; ");
}

/**
 * The paths that must NEVER appear in the customer's published website.
 *
 * Visual access is not permission to publish: the builder may study a gallery reference and may not ship it. The
 * check is by sha256 as well as by path, because a copy under a different name is the same infringement.
 */
export function unpublishable(m: ReferenceManifest): { paths: string[]; hashes: string[] } {
  const refs = m.references.filter((r) => !r.publishable);
  return {
    paths: refs.flatMap((r) => [r.originalPath, ...r.deliveries.map((d) => d.sentPath)]),
    hashes: [...new Set(refs.flatMap((r) => [r.originalSha256, ...r.deliveries.map((d) => d.sentSha256)]).filter(Boolean))],
  };
}
