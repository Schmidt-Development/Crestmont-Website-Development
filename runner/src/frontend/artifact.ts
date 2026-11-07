// Accepting a Founder-approved frontend artifact, before anything in it is built or run.
//
// WHY THIS IS STRICT. An artifact is an archive from outside the platform, and the next thing that happens to it
// is `npm install` and a build inside a sandbox. Every check here runs on the archive's own listing and file
// contents BEFORE a single entry is written to disk, because a `../` entry or a symlink pointing at
// /run/secrets is a problem at extraction time, not at build time.
//
// WHAT THIS IS NOT. It does not judge how the frontend looks. The Founder decided that. This module decides
// whether the package is safe to unpack, what framework it is, and whether it is complete enough to build.

/** One entry as the archive lists it, before extraction. */
export interface ArchiveEntry {
  /** The path exactly as the archive records it. Not normalised: that is the point. */
  path: string;
  size: number;
  /** "file", "dir", "symlink", or anything else the archive claims. */
  type: string;
  /** Symlink target, when the entry is one. */
  linkTarget?: string;
}

export type Framework = "react" | "react-ts" | "vite" | "static";

export interface ArtifactProblem {
  /** `reject` stops the import. `quarantine` stops it and keeps the artifact for inspection. `warn` does not. */
  severity: "reject" | "quarantine" | "warn";
  code: string;
  detail: string;
  path?: string;
}

export interface ArtifactVerdict {
  ok: boolean;
  framework: Framework | null;
  problems: ArtifactProblem[];
  /** Files that look like the site's own assets, for the asset manifest. */
  assets: string[];
  /** Entry point candidates found. */
  entryPoints: string[];
  /** Which document the site opens at, decided by `discoverHtmlEntry`. Absent on a verdict reached before it. */
  entry?: HtmlEntry;
}

/**
 * Which HTML document a static site opens at.
 *
 * ONE place decides this. It used to be decided in three, all by the same test -- `has(/(^|\/)index\.html?$/)`
 * for the framework, the same regex again for the entry-point list, and a third copy inside the rejection
 * message -- and all three asked the question that turned out to be wrong: is a file called `index.html` in here?
 *
 * The Founder's first real upload was one self-contained HTML file, `01-vesper-rowe-law.html`, with its CSS and
 * JavaScript inside it: a complete, valid website. It was refused in 0.55 seconds as "no supported frontend was
 * recognised ... No package.json and no index.html was found at any level" -- by the same message that lists "a
 * static HTML/CSS/JS site" as supported. The measurement instrument never needed `index.html`: it discovers
 * every .html file under the root and names each page from its path. Only this decision stood in the way.
 *
 * The rules are deterministic and ordered, because an archive with several candidate documents must not have one
 * picked for it arbitrarily:
 *
 *   index          an `index.html` at the top level. The ordinary case, and it always wins.
 *   nested-index   exactly one `index.html`, deeper in (a `dist/` or `build/` output).
 *   single         exactly one HTML file in the whole archive, named something else. Unambiguous: it is the site.
 *   ambiguous      several HTML documents and no index to choose between them. Refused, with the candidates
 *                  named, so the owner is told what to do instead of having a file picked for them.
 *   none           no HTML at all.
 */
export type HtmlEntry =
  | { kind: "index"; path: string }
  | { kind: "nested-index"; path: string }
  | { kind: "single"; path: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

const HTML_RE = /\.html?$/i;
const INDEX_RE = /(^|\/)index\.html?$/i;

export function discoverHtmlEntry(paths: readonly string[]): HtmlEntry {
  const html = paths.filter((p) => HTML_RE.test(p));
  if (!html.length) return { kind: "none" };

  const root = html.find((p) => INDEX_RE.test(p) && !p.includes("/"));
  if (root) return { kind: "index", path: root };

  const nested = html.filter((p) => INDEX_RE.test(p));
  // "Deepest first" is not a tie-break anyone could predict, so ONE nested index is accepted and several are not.
  if (nested.length === 1) return { kind: "nested-index", path: nested[0] };
  if (nested.length > 1) return { kind: "ambiguous", candidates: [...nested].sort() };

  if (html.length === 1) return { kind: "single", path: html[0] };
  return { kind: "ambiguous", candidates: [...html].sort() };
}

/** Hard ceilings. An artifact is a website, not a disk image. */
export const LIMITS = {
  totalBytes: 250 * 1024 * 1024,
  fileBytes: 50 * 1024 * 1024,
  entries: 20_000,
  /** An archive that expands far beyond its compressed size is a zip bomb. */
  maxExpansionRatio: 200,
} as const;

const ASSET_EXT = /\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|mp4|webm|pdf)$/i;
const SOURCE_EXT = /\.(jsx?|tsx?|mjs|cjs|css|scss|sass|less|html?|json|md)$/i;

/** Executables and other payloads that have no business in a frontend package. */
const UNSAFE_EXT = /\.(exe|dll|so|dylib|bat|cmd|com|scr|ps1|sh|bash|zsh|msi|app|deb|rpm|jar|class|pyc|wasm)$/i;

/**
 * Credentials committed into the package.
 *
 * Deliberately conservative: these patterns are specific enough that a match is almost certainly a real secret,
 * because a false positive here blocks a legitimate import and a Founder cannot easily argue with it.
 */
const SECRET_PATTERNS: { code: string; re: RegExp }[] = [
  { code: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "stripe-live-key", re: /\bsk_live_[0-9a-zA-Z]{20,}\b/ },
  { code: "stripe-restricted-key", re: /\brk_live_[0-9a-zA-Z]{20,}\b/ },
  { code: "github-token", re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
  { code: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { code: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { code: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { code: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/** Package scripts that run automatically on install, which is arbitrary code execution at import time. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"] as const;

/**
 * Is this path safe to extract?
 *
 * Checked against the RAW path from the archive. Normalising first and then asking is the classic mistake: it is
 * the raw entry that the extractor acts on.
 */
export function unsafePath(p: string): string | null {
  if (!p || p.trim() === "") return "an entry has no path";
  if (p.startsWith("/") || p.startsWith("\\")) return "absolute path";
  if (/^[A-Za-z]:[\\/]/.test(p)) return "drive-qualified absolute path";
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return "path traversal";
  // A NUL truncates the path for some extractors while the archive index keeps the rest.
  if (p.includes("\0")) return "embedded NUL in the path";
  if (/^\.git([\\/]|$)/.test(p)) return "git internals";
  return null;
}

export interface ArtifactInput {
  entries: readonly ArchiveEntry[];
  /** Text of the files worth reading: manifests, source, config. Binary assets are not read. */
  text: Readonly<Record<string, string>>;
  /** Compressed size of the archive, for the expansion-ratio check. */
  compressedBytes?: number;
}

/**
 * Judge an artifact. Nothing is extracted, installed or executed before this returns `ok`.
 */
export function validateArtifact(input: ArtifactInput): ArtifactVerdict {
  const problems: ArtifactProblem[] = [];
  const reject = (code: string, detail: string, path?: string) => problems.push({ severity: "reject", code, detail, path });
  const quarantine = (code: string, detail: string, path?: string) => problems.push({ severity: "quarantine", code, detail, path });
  const warn = (code: string, detail: string, path?: string) => problems.push({ severity: "warn", code, detail, path });

  const { entries, text } = input;

  // ── shape ───────────────────────────────────────────────────────────────────────────────────────────────────
  if (!entries.length) reject("empty-archive", "the archive contains no entries");
  if (entries.length > LIMITS.entries) reject("too-many-entries", `${entries.length} entries exceeds the ${LIMITS.entries} limit`);

  let total = 0;
  for (const e of entries) {
    total += Math.max(0, e.size);
    const bad = unsafePath(e.path);
    if (bad) { quarantine("unsafe-path", bad, e.path); continue; }
    if (e.size > LIMITS.fileBytes) reject("file-too-large", `${Math.round(e.size / 1024 / 1024)} MB exceeds the per-file limit`, e.path);
    if (e.type === "symlink") {
      // A symlink inside an artifact has no legitimate use and every illegitimate one.
      quarantine("symlink", `symbolic link to ${e.linkTarget ?? "(unknown)"}`, e.path);
      continue;
    }
    if (e.type !== "file" && e.type !== "dir") quarantine("unsupported-entry", `entry type "${e.type}"`, e.path);
    if (e.type === "file" && UNSAFE_EXT.test(e.path)) quarantine("executable-payload", "an executable or native binary", e.path);
  }
  if (total > LIMITS.totalBytes) reject("archive-too-large", `${Math.round(total / 1024 / 1024)} MB exceeds the ${LIMITS.totalBytes / 1024 / 1024} MB limit`);
  if (input.compressedBytes && input.compressedBytes > 0 && total / input.compressedBytes > LIMITS.maxExpansionRatio) {
    reject("expansion-ratio", `expands ${Math.round(total / input.compressedBytes)}x, above the ${LIMITS.maxExpansionRatio}x limit`);
  }

  // ── credentials ─────────────────────────────────────────────────────────────────────────────────────────────
  for (const [p, body] of Object.entries(text)) {
    for (const s of SECRET_PATTERNS) {
      // The value is never echoed: the point is that one is there, not what it is.
      if (s.re.test(body)) quarantine("embedded-credential", `a credential of type ${s.code} is committed in this file`, p);
    }
  }

  // ── package manifest and install hooks ──────────────────────────────────────────────────────────────────────
  const pkgRaw = text["package.json"];
  let pkg: Record<string, unknown> | null = null;
  if (pkgRaw) {
    try { pkg = JSON.parse(pkgRaw) as Record<string, unknown>; }
    catch { reject("invalid-package-json", "package.json is not valid JSON"); }
  }
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const hook of INSTALL_HOOKS) {
      if (typeof scripts[hook] === "string" && scripts[hook].trim()) {
        // Not a rejection: a legitimate project may have one. It is a build-time execution decision, so it is
        // surfaced for a person and the sandbox runs installs with scripts disabled.
        warn("install-hook", `package.json defines a "${hook}" script, which would run code at install time`, "package.json");
      }
    }
    const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, string>;
    for (const [name, spec] of Object.entries(deps)) {
      if (/^(?:git\+|https?:|file:|github:|ssh:)/i.test(String(spec))) {
        quarantine("unvetted-dependency", `dependency "${name}" resolves to ${String(spec).slice(0, 80)} rather than the registry`, "package.json");
      }
    }
  }

  // ── framework ───────────────────────────────────────────────────────────────────────────────────────────────
  const paths = entries.filter((e) => e.type === "file").map((e) => e.path);
  const has = (re: RegExp) => paths.some((p) => re.test(p));
  const dep = (name: string) => {
    if (!pkg) return false;
    const d = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, string>;
    return name in d;
  };

  const entry = discoverHtmlEntry(paths);

  let framework: Framework | null = null;
  const hasTs = has(/\.tsx?$/) || !!text["tsconfig.json"];
  if (dep("vite") || has(/^vite\.config\.[jt]s$/)) framework = "vite";
  else if (dep("react") || has(/\.jsx$/) || has(/\.tsx$/)) framework = hasTs ? "react-ts" : "react";
  // A site with HTML and no build tooling is a static site, whatever its document is called. `ambiguous` is still
  // a static site: it is refused below for having no single entry, not for being unrecognisable, because telling
  // an owner their multi-page website "is not a supported frontend" would send them to fix the wrong thing.
  else if (entry.kind !== "none") framework = "static";

  if (!framework) {
    reject("unsupported-framework",
      "no supported frontend was recognised. Supported: a React app, React with TypeScript, a Vite project, or a static HTML/CSS/JS site. "
      + (pkg ? "package.json lists neither react nor vite." : "No package.json and no .html document was found at any level."));
  }
  // Only when a framework WAS recognised. `framework !== "static"` was true of null as well, so an archive with
  // neither a package.json nor an index.html was refused twice -- once for being unrecognised, and once as
  // "a null project needs a package.json", which is what the Founder's rejection record actually says.
  if (framework && framework !== "static" && !pkg) {
    reject("missing-package-json", `a ${framework} project needs a package.json, and none is in the archive`);
  }
  if (framework !== "static" && pkg && !text["package-lock.json"] && !text["pnpm-lock.yaml"] && !text["yarn.lock"]) {
    warn("no-lockfile", "no dependency lockfile: the build cannot be reproduced exactly, and the baseline may drift between installs");
  }

  // ── entry points and assets ─────────────────────────────────────────────────────────────────────────────────
  const entryPoints = paths.filter((p) => /^(?:src\/)?(?:main|index|App)\.(?:[jt]sx?)$/.test(p) || INDEX_RE.test(p));
  if (framework === "static") {
    if (entry.kind === "ambiguous") {
      reject("ambiguous-entry-point",
        `this archive holds ${entry.candidates.length} HTML documents and no index.html, so which one the website opens at cannot be decided: `
        + `${entry.candidates.slice(0, 8).join(", ")}${entry.candidates.length > 8 ? ", …" : ""}. `
        + "Add an index.html at the top level, or upload a single HTML document on its own.");
    } else if (entry.kind !== "none" && !entryPoints.includes(entry.path)) {
      // A single document named something else is the entry point, so it belongs in the list the record shows.
      entryPoints.push(entry.path);
    }
  }
  const assets = paths.filter((p) => ASSET_EXT.test(p));

  const fatal = problems.some((p) => p.severity === "reject" || p.severity === "quarantine");
  return { ok: !fatal, framework, problems, assets, entryPoints, entry };
}

/** One line per problem, for the import record and for the person who has to act on it. */
export function describeProblems(v: ArtifactVerdict): string {
  if (!v.problems.length) return `accepted as a ${v.framework} project: ${v.entryPoints.length} entry point(s), ${v.assets.length} asset(s)`;
  return v.problems.map((p) => `${p.severity.toUpperCase()} ${p.code}${p.path ? ` (${p.path})` : ""}: ${p.detail}`).join("\n");
}

/** Files worth reading as text during validation. Binary assets are never read into memory. */
export function shouldReadAsText(p: string, size: number): boolean {
  if (size > 2 * 1024 * 1024) return false;
  if (ASSET_EXT.test(p)) return false;
  return SOURCE_EXT.test(p) || /(^|\/)(package|tsconfig|vite\.config|\.env[^/]*)/.test(p);
}
