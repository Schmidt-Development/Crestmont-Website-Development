// AI Build preview — collect the rendered frontend of one revision for the platform to store.
//
// The Founder watches a build in the AI Build tab, so each meaningful revision has to leave something they can look
// at. This reads the generated website out of the workspace and hands it to the control plane; the platform decides
// what it will accept (src/services/build-revisions.ts) and refuses anything outside a plain relative website path.
//
// Deliberately NOT included: the generated backend, migrations, tests, node_modules, lockfiles, or anything else the
// preview does not render. The platform would refuse them anyway; not reading them keeps a snapshot small and makes
// it obvious that a preview is a view of the frontend, not a deployment of the website.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Extensions the preview serves. Kept in step with TYPES in src/services/build-revisions.ts. */
const KEEP = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ico", ".woff", ".woff2", ".txt", ".xml", ".webmanifest", ".map"]);

/** Bounds that match the platform's, so a snapshot is trimmed here rather than refused in one piece there. */
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 25_000_000;

export interface SnapshotFile { path: string; base64: string }
export interface Snapshot { files: SnapshotFile[]; bytes: number; skipped: string[] }

function walk(root: string, dir: string, depth: number, out: string[]): void {
  if (depth > 6 || out.length > MAX_FILES * 4) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries.sort()) {
    if (e === "node_modules" || e === ".git" || e === ".wrangler") continue;
    const p = path.join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    // Only regular files and directories: a symlink the agent planted must not pull bytes in from outside.
    if (st.isDirectory()) walk(root, p, depth + 1, out);
    else if (st.isFile()) out.push(p);
  }
}

/**
 * The website as it stands in the workspace, plus this cycle's screenshots.
 *
 * Returns relative, forward-slash paths: the platform stores them as the preview's own URLs, so a page's
 * `href="assets/site.css"` has to resolve the same way it does on the real site.
 */
/**
 * `siteRoot` names where the rendered site actually is, relative to the repo.
 *
 * It defaults to "public", which is where the retired autonomous starter put it. A DESIGN-LOCKED build does not
 * use that starter: the Founder's artifact is served from the build output -- the repo root for a static document,
 * `dist` for a bundled project -- so with the default this found nothing and the revision was stored with an
 * empty file list. The platform refuses that ("files must be a non-empty array"), which is why a design-locked
 * build has never had a stored website snapshot, and why delivery reported "no finished build with a stored
 * website snapshot was found" at the start of this work.
 */
export function collectSnapshot(repo: string, siteRoot = "public"): Snapshot {
  const files: SnapshotFile[] = [];
  const skipped: string[] = [];
  let bytes = 0;

  const add = (abs: string, rel: string) => {
    if (files.length >= MAX_FILES) { skipped.push(rel); return; }
    const ext = path.extname(rel).toLowerCase();
    if (!KEEP.has(ext)) return;                       // not part of the rendered site; silently out of scope
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { skipped.push(rel); return; }
    if (buf.length > MAX_FILE_BYTES || bytes + buf.length > MAX_TOTAL_BYTES) { skipped.push(rel); return; }
    bytes += buf.length;
    files.push({ path: rel, base64: buf.toString("base64") });
  };

  const pub = siteRoot === "" || siteRoot === "." ? repo : path.join(repo, siteRoot);
  if (existsSync(pub)) {
    const found: string[] = [];
    walk(pub, pub, 0, found);
    for (const abs of found) add(abs, path.relative(pub, abs).split(path.sep).join("/"));
  }
  // The review cycle's desktop and mobile captures belong to the revision: they are what the reviewer actually saw.
  const shots = path.join(repo, ".crestmont", "screenshots");
  if (existsSync(shots)) {
    const found: string[] = [];
    walk(shots, shots, 0, found);
    for (const abs of found) add(abs, `.crestmont/screenshots/${path.relative(shots, abs).split(path.sep).join("/")}`);
  }
  return { files, bytes, skipped };
}
