// Taking a Founder-approved frontend archive in: the scanning gate, the verdict, then extraction.
//
// ORDER MATTERS, and it is the whole design:
//
//   1. the malware-scanning gate, which is about the FILE and is decided by the platform, not by this code;
//   2. the ZIP central directory is parsed — no byte is decompressed yet;
//   3. `validateArtifact` reaches a verdict from the listing and the text of the manifests and source;
//   4. only then is anything written to disk, and only entries whose paths were re-checked at write time.
//
// Nothing here says a customer upload is safe. The scanning gate is a fact this module reads and records; if a
// caller has no clean verdict to show, extraction does not happen, and the import record says why.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describeProblems, unsafePath, validateArtifact } from "./artifact.ts";
import type { ArtifactProblem, ArtifactVerdict, Framework } from "./artifact.ts";
import { ZipArchive, ZipError } from "./zip.ts";

/**
 * Where the archive came from.
 *
 * `customer-upload` is anything a person outside the platform supplied, and it cannot be extracted without a
 * clean scan. `internal-fixture` is a file this repository ships (the proof-of-concept frontend, test fixtures);
 * it skips the gate, and the import record says so in those words so that no later report can imply it was
 * scanned when it was not.
 */
export type ArtifactSource = "customer-upload" | "internal-fixture";

/** The platform's scan verdict for this file, as `files.scan_status` records it. */
export interface ScanGate {
  status: "pending" | "clean" | "infected" | "failed" | (string & {});
  fileId?: string | null;
  engine?: string | null;
  scannedAt?: string | null;
}

export interface IngestResult {
  ok: boolean;
  /** sha256 of the archive exactly as uploaded. The identity every later record refers to. */
  artifactSha: string;
  source: ArtifactSource;
  /** True only when a real clean verdict was presented. `internal-fixture` imports are false, never "assumed". */
  scanned: boolean;
  scanStatus: string;
  framework: Framework | null;
  /** The directory prefix inside the archive that everything shared, stripped before validation. "" when none. */
  archiveRoot: string;
  problems: ArtifactProblem[];
  verdict: ArtifactVerdict | null;
  /** Set only when extraction actually happened. */
  extracted: { dir: string; files: number; bytes: number } | null;
  /** True when the artifact must be kept for inspection rather than discarded. */
  quarantine: boolean;
}

export const EXTRACT_LIMITS = {
  maxFiles: 20_000,
  maxBytes: 250 * 1024 * 1024,
} as const;

/**
 * The single directory every entry sits under, if there is one.
 *
 * This is not cosmetic. A ZIP made by right-clicking a project folder contains `my-site/package.json`, not
 * `package.json`, so without this every real upload would be refused as "no package.json and no index.html".
 */
export function commonRoot(paths: readonly string[]): string {
  const real = paths.filter((p) => p && !p.startsWith("__MACOSX/") && p !== ".DS_Store");
  if (real.length < 2) return "";
  const first = real[0].split("/")[0];
  if (!first || first === real[0]) return "";          // the first entry is a bare file at the top level
  for (const p of real) {
    if (p !== first && !p.startsWith(`${first}/`)) return "";
  }
  return first;
}

/** Noise some archivers add that is never part of the website. */
const NOISE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\.AppleDouble\/)/;

export function ingestArtifact(o: {
  bytes: Buffer;
  /** Where the frontend should end up. Created if missing; must be empty or new. */
  destDir: string;
  source: ArtifactSource;
  scan?: ScanGate;
  /** Set false to reach a verdict without writing anything (a dry run). */
  extract?: boolean;
}): IngestResult {
  const artifactSha = createHash("sha256").update(o.bytes).digest("hex");
  const problems: ArtifactProblem[] = [];
  const scanStatus = o.scan?.status ?? "pending";

  const fail = (partial: Partial<IngestResult> = {}): IngestResult => ({
    ok: false, artifactSha, source: o.source, scanned: false, scanStatus,
    framework: null, archiveRoot: "", problems, verdict: null, extracted: null, quarantine: false,
    ...partial,
  });

  // ── 1. the scanning gate ──────────────────────────────────────────────────────────────────────────────────────
  //
  // Stricter than `services/builds.ts`, which refuses only 'infected'. That is defensible for a file a person
  // will look at; this archive's contents are about to be installed and executed, so 'pending' and 'failed' are
  // refused too. A file nobody has scanned is not a file this pipeline runs.
  let scanned = false;
  if (o.source === "customer-upload") {
    if (scanStatus === "clean") {
      scanned = true;
    } else if (scanStatus === "infected") {
      problems.push({ severity: "quarantine", code: "scan-infected", detail: `the uploaded archive is flagged as infected${o.scan?.engine ? ` by ${o.scan.engine}` : ""}; it is quarantined and a person must replace it` });
      return fail({ quarantine: true });
    } else if (scanStatus === "failed") {
      problems.push({ severity: "reject", code: "scan-failed", detail: "the malware scan of this archive failed, so there is no verdict; the import does not proceed on a missing verdict" });
      return fail();
    } else {
      problems.push({ severity: "reject", code: "scan-required", detail: `the archive's scan status is "${scanStatus}"; a customer upload is extracted only once a scanner has returned "clean"` });
      return fail();
    }
  }

  // ── 2. the central directory ──────────────────────────────────────────────────────────────────────────────────
  let zip: ZipArchive;
  try {
    zip = ZipArchive.open(o.bytes);
  } catch (err) {
    const why = err instanceof ZipError ? err.message : `the archive could not be read: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
    problems.push({ severity: "reject", code: "unreadable-archive", detail: why });
    return fail({ scanned });
  }

  const archiveRoot = commonRoot(zip.entries.map((e) => e.path));
  const strip = (p: string): string => (archiveRoot && p.startsWith(`${archiveRoot}/`) ? p.slice(archiveRoot.length + 1) : p);

  // The listing is judged at its logical paths, but every RAW path is checked too: stripping a prefix must not
  // be able to turn an unsafe entry into a safe-looking one.
  const rawUnsafe = zip.entries.filter((e) => unsafePath(e.path) !== null);
  const listing = zip.listing()
    .filter((e) => !NOISE.test(e.path))
    .map((e) => ({ ...e, path: unsafePath(e.path) !== null ? e.path : strip(e.path) }))
    .filter((e) => e.path !== "");

  const text: Record<string, string> = {};
  for (const [p, body] of Object.entries(zip.textFiles({ skip: (p) => NOISE.test(p) || unsafePath(p) !== null }))) {
    text[strip(p)] = body;
  }

  // ── 3. the verdict ────────────────────────────────────────────────────────────────────────────────────────────
  const verdict = validateArtifact({ entries: listing, text, compressedBytes: zip.compressedBytes });
  problems.push(...verdict.problems);
  if (rawUnsafe.length && !verdict.problems.some((p) => p.code === "unsafe-path")) {
    // Defensive: a raw path that `artifact.ts` did not already name.
    problems.push({ severity: "quarantine", code: "unsafe-path", detail: `${rawUnsafe.length} entr(ies) have paths that are not safe to extract`, path: rawUnsafe[0].path });
  }

  const quarantine = problems.some((p) => p.severity === "quarantine");
  if (!verdict.ok || quarantine) {
    return fail({ scanned, framework: verdict.framework, archiveRoot, verdict, quarantine });
  }

  if (o.extract === false) {
    return { ok: true, artifactSha, source: o.source, scanned, scanStatus, framework: verdict.framework, archiveRoot, problems, verdict, extracted: null, quarantine: false };
  }

  // ── 4. extraction ─────────────────────────────────────────────────────────────────────────────────────────────
  const dest = path.resolve(o.destDir);
  mkdirSync(dest, { recursive: true });
  let files = 0;
  let bytes = 0;

  for (const e of zip.entries) {
    if (e.type !== "file") continue;                 // directories are implied; links never reach here
    if (NOISE.test(e.path)) continue;
    const rel = strip(e.path);

    // Re-checked at write time, not only at verdict time. This is the check that actually protects the disk, and
    // it runs against the same raw string the writer is about to use.
    if (unsafePath(e.path) !== null || unsafePath(rel) !== null || rel === "") {
      throw new Error(`refusing to extract "${e.path}": the path is not safe, and the verdict should have stopped this`);
    }

    const target = path.resolve(dest, rel);
    // Belt and braces: even with a clean path, the resolved result must still be inside the destination.
    if (target !== dest && !target.startsWith(dest + path.sep)) {
      throw new Error(`refusing to extract "${e.path}": it resolves outside the destination directory`);
    }

    const body = zip.read(e);
    bytes += body.length;
    files++;
    if (files > EXTRACT_LIMITS.maxFiles) throw new Error(`the archive holds more than ${EXTRACT_LIMITS.maxFiles} files`);
    if (bytes > EXTRACT_LIMITS.maxBytes) throw new Error(`the archive expands past ${Math.round(EXTRACT_LIMITS.maxBytes / 1024 / 1024)} MB`);

    mkdirSync(path.dirname(target), { recursive: true });
    // 0o644 always: nothing out of an uploaded archive is executable, whatever mode it recorded.
    writeFileSync(target, body, { mode: 0o644, flag: "wx" });
  }

  return {
    ok: true, artifactSha, source: o.source, scanned, scanStatus,
    framework: verdict.framework, archiveRoot, problems, verdict,
    extracted: { dir: dest, files, bytes }, quarantine: false,
  };
}

/** The import in words, for the build record. Says plainly whether the archive was scanned. */
export function describeIngest(r: IngestResult): string {
  const gate = r.source === "internal-fixture"
    ? "internal fixture, not scanned (no customer upload)"
    : r.scanned ? "scanned clean" : `NOT scanned (status "${r.scanStatus}")`;
  if (!r.ok) return `import refused — ${gate}\n${describeProblems(r.verdict ?? { ok: false, framework: null, problems: r.problems, assets: [], entryPoints: [] })}`;
  const where = r.extracted ? `${r.extracted.files} file(s), ${Math.round(r.extracted.bytes / 1024)} KB` : "verdict only, nothing written";
  return `imported as a ${r.framework} project — ${gate}; ${where}${r.archiveRoot ? `; archive root "${r.archiveRoot}/" stripped` : ""}${r.problems.length ? `\n${describeProblems(r.verdict!)}` : ""}`;
}
