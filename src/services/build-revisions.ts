// AI Build preview — immutable per-revision snapshots of the generated website (migration 0072).
//
// The runner uploads the rendered frontend of each meaningful revision through the same signed channel it already
// uses for checkpoints; staff read it back through an authenticated route that serves each file from storage.
//
// SECURITY. These bytes are written by an AI builder and are untrusted:
//   * Only static frontend files are accepted. The generated backend is never stored here and never executed by this
//     Worker. What it does is evidenced by the runner's own gates and persistence check, inside its sandbox.
//   * Paths are validated against an allowlist, not sanitized: no traversal, no absolute path, no drive letter, and
//     an extension that matches the declared content type. A path that does not match is refused, not repaired.
//   * Snapshots are immutable. (job_id, attempt, cycle) is unique and a second upload for the same revision is
//     refused, so a later cycle cannot overwrite the evidence of an earlier one -- including a reverted revision.
//   * Serving applies a sandboxing CSP (see previewHeaders), so generated HTML and JavaScript run with an opaque
//     origin and cannot reach a staff session, its cookies or the platform API.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { HttpError } from "../app/http.ts";
import { hmacSha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { leasedJob, sanitize } from "./builds.ts";

/** Per revision. A Business site is ~12 pages plus assets; these are ceilings, not expectations. */
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 25_000_000;

/** Extension → served content type. An extension that is not here is refused: no HTML-adjacent or executable types. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

export type RevisionPhase = "build" | "repair" | "final";
export type FileKind = "page" | "asset" | "screenshot";

export interface RevisionFileInput { path: string; base64: string }

/**
 * A website-relative path this Worker will store and serve back.
 *
 * Rejects rather than rewrites: a path the builder got wrong is a fact worth seeing, and silently "fixing" one is how
 * a traversal slips through. Screenshots are the one directory outside the site root that is kept, because the
 * review cycle's desktop and mobile captures belong to the revision.
 */
export function revisionPath(raw: unknown): { path: string; kind: FileKind; contentType: string } | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().replace(/\\/g, "/");
  if (!p || p.length > 300) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;           // absolute, or a Windows drive letter
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) return null;                        // no spaces, quotes, %, #, ?, or control bytes
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  const dot = p.lastIndexOf(".");
  const ext = dot < 0 ? "" : p.slice(dot).toLowerCase();
  const contentType = TYPES[ext];
  if (!contentType) return null;
  const screenshot = p.startsWith(".crestmont/screenshots/");
  if (p.startsWith(".") && !screenshot) return null;                     // no other dotfiles: no .env, no .git
  const kind: FileKind = screenshot ? "screenshot" : ext === ".html" ? "page" : "asset";
  return { path: p, kind, contentType };
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Runner → platform: store one revision of the generated website.
 *
 * Idempotent per (job, attempt, cycle) in the safe direction: a repeat is REFUSED rather than merged, because a
 * second upload for a revision that already exists means either a retry the caller should ignore or a mistake that
 * would otherwise rewrite history.
 */
export async function saveRevision(db: Db, storage: StorageAdapter | null, b: Record<string, unknown>) {
  const job = await leasedJob(db, b.jobId, b.leaseToken);
  if (!storage) throw new HttpError(409, "File storage is not configured on this environment; revision snapshot not stored");
  const cycle = Number(b.cycle);
  if (!Number.isInteger(cycle) || cycle < 0 || cycle > 1000) throw new HttpError(422, "cycle must be an integer between 0 and 1000");
  const phase = (["build", "repair", "final"] as const).includes(b.phase as RevisionPhase) ? (b.phase as RevisionPhase) : null;
  if (!phase) throw new HttpError(422, "phase must be build, repair or final");
  const files = Array.isArray(b.files) ? b.files : null;
  if (!files || !files.length) throw new HttpError(422, "files must be a non-empty array");
  if (files.length > MAX_FILES) throw new HttpError(413, `a revision may hold at most ${MAX_FILES} files`);

  const existing = await db.prepare(`SELECT id FROM build_revisions WHERE job_id = ? AND attempt = ? AND cycle = ?`)
    .bind(job.id, job.attempts, cycle).first<{ id: string }>();
  if (existing) return { revisionId: existing.id, stored: 0, alreadyStored: true };

  // Validate and hash everything BEFORE writing a byte, so a refused upload leaves nothing behind.
  const prepared: { path: string; kind: FileKind; contentType: string; bytes: Uint8Array; sha: string }[] = [];
  let total = 0;
  for (const raw of files) {
    const f = raw as RevisionFileInput;
    const v = revisionPath(f?.path);
    if (!v) throw new HttpError(422, `refused path: ${sanitize(f?.path, 120) || "(empty)"}`);
    if (typeof f.base64 !== "string" || !f.base64) throw new HttpError(422, `missing content for ${v.path}`);
    if (f.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw new HttpError(413, `${v.path} is larger than ${MAX_FILE_BYTES} bytes`);
    let bytes: Uint8Array;
    try { bytes = b64(f.base64); } catch { throw new HttpError(422, `content for ${v.path} is not valid base64`); }
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, `${v.path} is larger than ${MAX_FILE_BYTES} bytes`);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new HttpError(413, `the revision is larger than ${MAX_TOTAL_BYTES} bytes`);
    if (prepared.some((x) => x.path === v.path)) throw new HttpError(422, `duplicate path: ${v.path}`);
    prepared.push({ ...v, bytes, sha: await sha256Hex(bytes) });
  }

  // The ratchet that nominates a best revision runs inside ONE attempt: runner/src/job.ts holds bestCard in memory,
  // so a fresh segment starts with no best and ratchetDecision returns "record-best" for its first scored cycle
  // (ratchet.ts: best === null). "The best revision this build reached" spans every attempt, and only the platform
  // sees them all -- the runner cannot, because restoreTo can revert only inside its own attempt's history. So the
  // nomination is arbitrated here instead of taken on trust. Job bld_aeadb54ca53f57afcb9969bc reached 8.4/10 on
  // attempt 1 and then showed a 6.8/10 revision as "the best verified revision the build reached".
  const score = typeof b.score === "number" && Number.isFinite(b.score) ? Math.max(0, Math.min(10, b.score)) : null;
  const incumbent = b.isBest
    ? await db.prepare(`SELECT score FROM build_revisions WHERE job_id = ? AND is_best = 1`).bind(job.id).first<{ score: number | null }>()
    : null;
  // An unscored revision never claims the flag; a measured one always beats an unmeasured incumbent; a tie goes to
  // the newer revision, so the preview follows the live work for as long as quality holds.
  const isBest = !!b.isBest && score !== null && (!incumbent || incumbent.score === null || score >= incumbent.score);

  // 0078 (V5 ss9): did this cycle actually change the website? The runner measures it -- the rendering-source
  // hash and every screenshot's hash, compared with the state before the repair -- because the commit hash
  // cannot: every cycle commits its evidence, so commits always differ. An unrecognised value is stored as NULL
  // ("not measured") rather than coerced into a verdict this revision did not earn.
  const effect = b.effect === "effective" || b.effect === "ineffective" || b.effect === "unknown" ? b.effect : null;

  const id = newId("brev");
  const at = nowIso();
  for (const f of prepared) {
    await storage.put(`builds/${job.id}/rev/${job.attempts}-${cycle}/${f.path}`, f.bytes, f.contentType);
  }
  await db.prepare(`INSERT INTO build_revisions (id, job_id, project_id, cycle, attempt, phase, commit_sha, score, decision, is_best, reverted, reverted_reason, effect, effect_reason, file_count, total_bytes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, job.id, job.project_id, cycle, job.attempts, phase,
      typeof b.commit === "string" && /^[0-9a-f]{7,64}$/i.test(b.commit) ? b.commit : null,
      score,
      typeof b.decision === "string" ? sanitize(b.decision, 40) : null,
      isBest ? 1 : 0, b.reverted ? 1 : 0,
      b.reverted && typeof b.revertedReason === "string" ? sanitize(b.revertedReason, 500) : null,
      effect, effect && typeof b.effectReason === "string" ? sanitize(b.effectReason, 500) : null,
      prepared.length, total, at).run();
  for (const f of prepared) {
    await db.prepare(`INSERT INTO build_revision_files (revision_id, path, kind, content_type, size_bytes, sha256, storage_key) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, f.path, f.kind, f.contentType, f.bytes.length, f.sha, `builds/${job.id}/rev/${job.attempts}-${cycle}/${f.path}`).run();
  }
  // Exactly one revision is the build's best, so an honoured nomination clears the previous one -- and a nomination
  // the arbitration rejected clears nothing, which is the whole point.
  if (isBest) await db.prepare(`UPDATE build_revisions SET is_best = 0 WHERE job_id = ? AND id <> ?`).bind(job.id, id).run();
  await db.prepare(`INSERT INTO build_events (job_id, at, kind, message, actor_kind, data_json) VALUES (?,?,?,?,?,?)`)
    .bind(job.id, at, "preview", `Revision snapshot stored for cycle ${cycle} (${prepared.length} file(s), ${Math.round(total / 1024)} KB)`, "runner",
      JSON.stringify({ cycle, phase, files: prepared.length, bytes: total, isBest, reverted: !!b.reverted, effect })).run();
  return { revisionId: id, stored: prepared.length, alreadyStored: false };
}

export interface RevisionRow {
  id: string; cycle: number; attempt: number; phase: RevisionPhase; commit_sha: string | null;
  score: number | null; decision: string | null; is_best: number; reverted: number; reverted_reason: string | null;
  file_count: number; total_bytes: number; created_at: string;
  /**
   * 0076: the weighted category scores this revision measured, and the design-first phase that produced it. NULL on
   * every revision stored before the weighted scorecard existed -- which is the point: a legacy revision has no
   * category breakdown and must not be shown one, rather than being backfilled with a plausible-looking split.
   */
  build_phase: string | null; design_points: number | null; functionality_points: number | null; other_points: number | null;
  is_design_baseline: number;
  /**
   * 0078: whether the cycle changed the website, and the measured reason. NULL on every revision stored before
   * the comparison existed, including the nine revisions of bld_10e2c6007686faee0ab64d45 that prompted it: those
   * were never measured this way and must read "not measured", not "effective".
   */
  effect: "effective" | "ineffective" | "unknown" | null; effect_reason: string | null;
}

const REVISION_COLUMNS = `id, cycle, attempt, phase, commit_sha, score, decision, is_best, reverted, reverted_reason, file_count, total_bytes, created_at,
    build_phase, design_points, functionality_points, other_points, is_design_baseline, effect, effect_reason`;

/** Every stored revision of a build, oldest first: the cycle history the Founder scrolls through. */
export async function listRevisions(db: Db, jobId: string): Promise<RevisionRow[]> {
  return (await db.prepare(`SELECT ${REVISION_COLUMNS}
    FROM build_revisions WHERE job_id = ? ORDER BY attempt, cycle`).bind(jobId).all<RevisionRow>()).results;
}

export async function revisionDetail(db: Db, jobId: string, attempt: number, cycle: number) {
  const rev = await db.prepare(`SELECT ${REVISION_COLUMNS}
    FROM build_revisions WHERE job_id = ? AND attempt = ? AND cycle = ?`).bind(jobId, attempt, cycle).first<RevisionRow>();
  if (!rev) return null;
  const files = (await db.prepare(`SELECT path, kind, content_type, size_bytes FROM build_revision_files WHERE revision_id = ? ORDER BY kind, path`)
    .bind(rev.id).all<{ path: string; kind: FileKind; content_type: string; size_bytes: number }>()).results;
  return { ...rev, files };
}

/** One file of a stored revision, for the authenticated preview route. */
export async function revisionFile(db: Db, storage: StorageAdapter | null, jobId: string, attempt: number, cycle: number, path: string) {
  if (!storage) return null;
  const v = revisionPath(path);
  if (!v) return null;
  const row = await db.prepare(`SELECT f.storage_key, f.content_type, f.size_bytes FROM build_revision_files f
      JOIN build_revisions r ON r.id = f.revision_id
      WHERE r.job_id = ? AND r.attempt = ? AND r.cycle = ? AND f.path = ?`)
    .bind(jobId, attempt, cycle, v.path).first<{ storage_key: string; content_type: string; size_bytes: number }>();
  if (!row) return null;
  const obj = await storage.get(row.storage_key);
  if (!obj) return null;
  return { body: obj.body, contentType: row.content_type, size: row.size_bytes };
}

/**
 * A short-lived capability for ONE stored revision, carried in the preview's own URLs.
 *
 * WHY THE STAFF COOKIE CANNOT DO THIS JOB. previewHeaders sends a CSP `sandbox` directive, which is what stops
 * generated JavaScript reaching a staff session -- and it does that by giving the document an OPAQUE origin. An
 * opaque-origin document has no site, so every subresource request it makes counts as cross-site, and the session
 * cookie is `SameSite=Lax`: the browser correctly withholds it. So `<link rel=stylesheet>` arrived at the preview
 * route unauthenticated, requireStaff answered `303 -> /login`, and the browser refused an HTML document in place
 * of a stylesheet (ERR_BLOCKED_BY_ORB). The page rendered with no CSS, no fonts and no layout at all.
 *
 * Measured in Microsoft Edge against the stored bytes of bld_50e28bbd1cd033ad9ddfad02 revision 1-3:
 *   with `sandbox`      document 200, tokens.css/site.css/app.js 303 -> ERR_BLOCKED_BY_ORB, body font Times New
 *                       Roman, link colour rgb(0,0,238), nav list-style disc  (the Founder's screenshot)
 *   without `sandbox`   all four 200, body font Open Sans, header rgb(10,49,97), nav list-style none
 * The CSP source list was never the cause: the requests were *made* and redirected, so `'self'` had already
 * matched. Widening it to the exact prefix changed nothing while `sandbox` stayed. Only the cookie mattered.
 *
 * A capability in the path removes the dependency on a cookie the browser is right to withhold, and leaves the
 * sandbox -- and the boundary it enforces -- exactly as it was. The token authorises precisely one thing: reading
 * the stored files of one (job, attempt, cycle). It cannot name another revision, another job, or any other route.
 */
const TOKEN_KEY_LABEL = "crestmont-build-preview-file-key:v1";
export const PREVIEW_TOKEN_TTL_S = 3600;

export interface PreviewSecretEnv { BUILD_PREVIEW_FILE_SECRET?: string; BUILD_RUNNER_SECRET?: string }

/**
 * A domain-separated subkey, never the root secret itself. A build revision cannot exist unless the runner
 * authenticated with BUILD_RUNNER_SECRET to upload it, so previews work in every environment that can have one,
 * with nothing new to provision; BUILD_PREVIEW_FILE_SECRET overrides it where the two are kept apart.
 */
async function tokenKey(env: PreviewSecretEnv): Promise<string | null> {
  const root = env.BUILD_PREVIEW_FILE_SECRET || env.BUILD_RUNNER_SECRET;
  return root ? await hmacSha256Hex(root, TOKEN_KEY_LABEL) : null;
}

const tokenPayload = (jobId: string, attempt: number, cycle: number, exp: number) => `${jobId}|${attempt}|${cycle}|${exp}`;

/** `<expiry>-<mac>`; null when no secret is configured, so the caller can say so rather than serve a broken page. */
export async function previewToken(env: PreviewSecretEnv, jobId: string, attempt: number, cycle: number, now = Date.now()): Promise<string | null> {
  const key = await tokenKey(env);
  if (!key) return null;
  const exp = Math.floor(now / 1000) + PREVIEW_TOKEN_TTL_S;
  return `${exp}-${(await hmacSha256Hex(key, tokenPayload(jobId, attempt, cycle, exp))).slice(0, 48)}`;
}

export async function previewTokenValid(env: PreviewSecretEnv, jobId: string, attempt: number, cycle: number, token: unknown, now = Date.now()): Promise<boolean> {
  const key = await tokenKey(env);
  if (!key || typeof token !== "string") return false;
  const m = /^(\d{10,13})-([0-9a-f]{48})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  // Expiry is inside the signed payload, so a forged expiry changes the MAC; the check below is still the one
  // that decides, and this only avoids serving a correctly signed but stale link.
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const want = (await hmacSha256Hex(key, tokenPayload(jobId, attempt, cycle, exp))).slice(0, 48);
  return timingSafeEqualHex(m[2], want);
}

/**
 * Response headers for a served preview file.
 *
 * `sandbox` gives the document an opaque origin, so generated HTML and JavaScript cannot read a staff session's
 * cookies or script the page that framed it -- and it applies whether the preview is in an iframe or opened in its
 * own tab. `connect-src 'none'` stops the generated frontend calling the platform API; its own backend is not
 * deployed here, which is why forms are shown as exercised-by-the-runner rather than live.
 *
 * `base` is the preview's own absolute prefix. Naming it beats `'self'`, which means nothing to a document whose
 * origin is opaque: the generated page may load the files of ITS OWN revision and nothing else on this origin.
 */
export function previewHeaders(contentType: string, base?: string): Record<string, string> {
  const src = base ? base.replace(/\/*$/, "/") : "'self'";
  return {
    "content-type": contentType,
    "content-security-policy": [
      "sandbox allow-scripts allow-forms allow-popups",
      `default-src ${src}`, `img-src ${src} data:`, `style-src ${src} 'unsafe-inline'`,
      `script-src ${src} 'unsafe-inline'`, `font-src ${src} data:`, "connect-src 'none'",
      "form-action 'none'", "base-uri 'none'", "object-src 'none'", "frame-src 'none'", "frame-ancestors 'self'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // Snapshots are immutable, so they cache hard; but never in a shared cache, since reading one needs a session.
    "cache-control": "private, max-age=31536000, immutable",
  };
}

/**
 * Resolve a requested preview path against what the snapshot actually holds.
 *
 * The full-stack starter publishes root-relative, EXTENSIONLESS URLs -- `/about`, `/services` -- which its deployed
 * Worker maps onto `about.html`. A snapshot holds the files, so the preview has to do the same mapping or every
 * in-page link 404s. This is resolution, not rewriting: the bytes served are the bytes stored.
 */
export function resolveRequested(requested: string, has: (p: string) => boolean): string | null {
  const raw = requested.replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = raw === "" ? ["index.html"] : [raw, `${raw}.html`, `${raw}/index.html`];
  for (const c of candidates) if (revisionPath(c) && has(c)) return c;
  return null;
}

/**
 * Point a revision's root-relative URLs at the prefix the preview is served under.
 *
 * WHY THIS IS NOT "REPAIRING THE WEBSITE". The stored snapshot is immutable and is what the customer receives; this
 * rewrites only the copy flowing to the Founder's browser, and only URLs that begin with a single "/". Without it a
 * preview served under /staff/builds/<job>/rev/<rev>/ would ask the staff origin for /assets/site.css and render
 * completely unstyled -- a screenshot would be more honest than that, and the point of a live preview is to be more
 * than a screenshot. What the builder wrote is still available byte-for-byte through the file list.
 *
 * Left alone: absolute URLs, protocol-relative URLs, fragments, mailto:, tel:, data: and anything already prefixed.
 */
export function rewriteForPrefix(contentType: string, text: string, prefix: string): string {
  const p = prefix.replace(/\/+$/, "");
  const url = (v: string) => (v.startsWith("//") || v.startsWith(`${p}/`) ? v : `${p}${v}`);
  if (contentType.startsWith("text/html")) {
    return text
      .replace(/\b(href|src|poster|action)=(["'])(\/(?!\/)[^"']*)\2/gi, (_m, a: string, q: string, v: string) => `${a}=${q}${url(v)}${q}`)
      .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_m, q: string, v: string) => `srcset=${q}${v.split(",").map((part) => {
        const s = part.trim();
        const sp = s.indexOf(" ");
        const link = sp < 0 ? s : s.slice(0, sp);
        return link.startsWith("/") && !link.startsWith("//") ? `${url(link)}${sp < 0 ? "" : s.slice(sp)}` : s;
      }).join(", ")}${q}`)
      .replace(/url\(\s*(["']?)(\/(?!\/)[^)"']*)\1\s*\)/gi, (_m, q: string, v: string) => `url(${q}${url(v)}${q})`);
  }
  if (contentType.startsWith("text/css")) {
    return text.replace(/url\(\s*(["']?)(\/(?!\/)[^)"']*)\1\s*\)/gi, (_m, q: string, v: string) => `url(${q}${url(v)}${q})`);
  }
  return text;
}

/** Content types whose text is rewritten for the preview prefix; everything else is served byte-for-byte. */
export const REWRITTEN = (contentType: string) => contentType.startsWith("text/html") || contentType.startsWith("text/css");

/**
 * Everything the preview route needs for one request: resolve, fetch, rewrite if it is markup, and head it safely.
 *
 * Returns null when the revision does not hold that path, so the caller answers 404 rather than guessing.
 */
export async function servePreviewFile(db: Db, storage: StorageAdapter | null, jobId: string, attempt: number, cycle: number, requested: string, prefix: string, origin?: string) {
  if (!storage) return null;
  const rev = await db.prepare(`SELECT id FROM build_revisions WHERE job_id = ? AND attempt = ? AND cycle = ?`).bind(jobId, attempt, cycle).first<{ id: string }>();
  if (!rev) return null;
  const paths = new Set((await db.prepare(`SELECT path FROM build_revision_files WHERE revision_id = ?`).bind(rev.id).all<{ path: string }>()).results.map((r) => r.path));
  const path = resolveRequested(requested, (p) => paths.has(p));
  if (!path) return null;
  const row = await db.prepare(`SELECT storage_key, content_type FROM build_revision_files WHERE revision_id = ? AND path = ?`).bind(rev.id, path).first<{ storage_key: string; content_type: string }>();
  if (!row) return null;
  const obj = await storage.get(row.storage_key);
  if (!obj) return null;
  const headers = previewHeaders(row.content_type, origin ? `${origin}${prefix}/` : undefined);
  if (!REWRITTEN(row.content_type)) return { body: obj.body as BodyInit, headers };
  const bytes = obj.body instanceof Uint8Array ? obj.body : new Uint8Array(await new Response(obj.body as BodyInit).arrayBuffer());
  return { body: rewriteForPrefix(row.content_type, new TextDecoder().decode(bytes), prefix) as BodyInit, headers };
}
