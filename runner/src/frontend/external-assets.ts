// The external things an uploaded frontend depends on: finding them, and rewriting them once they are local.
//
// WHY THIS EXISTS. The design measurement runs in a container with `--network none`. That is right: an approved
// design has to be reproducible, and a measurement that reaches the internet measures whatever the internet said
// that minute. But the consequence was silent and wrong. A site whose typography comes from a font CDN and whose
// photographs come from an image host was measured with none of them -- the fallback font, the empty image boxes
// -- and that became the approved baseline. The owner approved a design they had never seen.
//
// The fix is not to open the network in the measurement container. It is to resolve each dependency ONCE, during
// ingestion, by the platform (which already has `fetch` and R2, and no private network to be tricked into
// reaching), write the bytes into the artifact, and rewrite the reference to point at the local copy. Every later
// step -- measurement, approved baseline, Model B's build, the final visual check -- then reads the same pinned
// bytes, and none of them fetches anything.
//
// WHAT IS FOUND, AND WHAT IS NOT. Images, fonts and stylesheets are visual dependencies and are resolved. A
// remote SCRIPT is not: pinning somebody's analytics bundle would mean running code we fetched, inside a page we
// then approve, and a script that draws the page is a different kind of problem from a font that renders it. A
// remote script is reported as an unresolved dependency with its visual impact stated, and the owner decides.
//
// This module is pure. It reads strings and returns strings; the fetching is the platform's and the writing is
// the import worker's.

/** What an external reference is for, which decides whether its absence is a visual defect. */
export type AssetKind = "image" | "font" | "stylesheet" | "script" | "other";

export interface ExternalRef {
  /** The absolute URL exactly as the artifact wrote it. */
  url: string;
  kind: AssetKind;
  /** The artifact file that referenced it, relative to the extraction root. */
  referencedBy: string;
  /** The exact substring to replace when the asset is local. Never a re-serialised version of the document. */
  raw: string;
}

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg|ico|bmp)(?:[?#]|$)/i;
const CSS_EXT = /\.css(?:[?#]|$)/i;
const JS_EXT = /\.(m?js)(?:[?#]|$)/i;

/** What a URL is for, from the markup that referenced it and then from the URL itself. */
export function classify(url: string, hint?: AssetKind): AssetKind {
  if (hint && hint !== "other") return hint;
  if (FONT_EXT.test(url)) return "font";
  if (IMAGE_EXT.test(url)) return "image";
  if (CSS_EXT.test(url)) return "stylesheet";
  if (JS_EXT.test(url)) return "script";
  // A font CDN that serves its stylesheet from an extensionless path is the common case worth naming.
  if (/fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net|fonts\.gstatic\.com/i.test(url)) return "stylesheet";
  return "other";
}

/** Absolute http(s) URLs only. A protocol-relative `//host/x` is normalised to https, which is how a page loads it. */
function absolute(raw: string): string | null {
  const v = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!v || v.startsWith("#") || v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("mailto:") || v.startsWith("tel:")) return null;
  if (v.startsWith("//")) return `https:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  return null;   // relative: already inside the artifact
}

/**
 * Every external reference in one HTML document.
 *
 * Attribute-by-attribute rather than by parsing the document, because the rewrite has to put back exactly what
 * was there: re-serialising somebody's hand-written HTML would change the thing we are about to measure.
 */
export function refsInHtml(html: string, file: string): ExternalRef[] {
  const out: ExternalRef[] = [];
  const add = (raw: string, hint: AssetKind) => {
    const url = absolute(raw);
    if (url) out.push({ url, kind: classify(url, hint), referencedBy: file, raw: raw.trim().replace(/^['"]|['"]$/g, "") });
  };

  // <img src>, <source src>, <video poster>, <embed src>, <iframe src> -- anything that paints.
  for (const m of html.matchAll(/<(img|source|video|audio|embed|iframe|input)\b[^>]*>/gi)) {
    const tag = m[0];
    for (const attr of ["src", "poster"]) {
      const a = new RegExp(`\\b${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
      if (a) add(a[1], "image");
    }
    // srcset carries several candidates with descriptors: "a.png 1x, b.png 2x".
    const ss = /\bsrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
    if (ss) {
      for (const part of ss[1].replace(/^['"]|['"]$/g, "").split(",")) {
        const candidate = part.trim().split(/\s+/)[0];
        if (candidate) add(candidate, "image");
      }
    }
  }

  // <link href>: a stylesheet, a font preload, an icon. `rel` decides, and an unknown rel is classified by URL.
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
    if (!href) continue;
    const rel = (/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag)?.[1] ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
    const as = (/\bas\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag)?.[1] ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
    const hint: AssetKind = /stylesheet/.test(rel) ? "stylesheet"
      : as === "font" ? "font"
      : /icon|apple-touch/.test(rel) ? "image"
      : as === "image" ? "image"
      : "other";
    // A preconnect or dns-prefetch is not a dependency, it is a hint about one.
    if (/preconnect|dns-prefetch|canonical|alternate|manifest/.test(rel)) continue;
    add(href[1], hint);
  }

  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi)) {
    add(m[1], "script");
  }

  // Inline <style> blocks reference fonts and images exactly as a stylesheet does.
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    out.push(...refsInCss(m[1], file));
  }

  return dedupe(out);
}

/** Every external reference in a stylesheet: `url(...)` and `@import`. */
export function refsInCss(css: string, file: string): ExternalRef[] {
  const out: ExternalRef[] = [];
  const add = (raw: string, hint: AssetKind) => {
    const url = absolute(raw);
    if (url) out.push({ url, kind: classify(url, hint), referencedBy: file, raw: raw.trim().replace(/^['"]|['"]$/g, "") });
  };
  for (const m of css.matchAll(/url\(\s*("[^"]*"|'[^']*'|[^)]+)\s*\)/gi)) add(m[1], "other");
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?("[^"]*"|'[^']*')/gi)) add(m[1], "stylesheet");
  return dedupe(out);
}

function dedupe(refs: ExternalRef[]): ExternalRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.referencedBy}|${r.url}|${r.raw}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Where a pinned asset lives inside the artifact. By content hash, so the same bytes are written once. */
export const PINNED_DIR = "_crestmont-assets";

export function pinnedPath(sha256: string, contentType: string, url: string): string {
  const ext = extensionFor(contentType, url);
  return `${PINNED_DIR}/${sha256.slice(0, 32)}${ext}`;
}

const BY_TYPE: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/avif": ".avif",
  "image/gif": ".gif", "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico",
  "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf",
  "application/font-woff2": ".woff2", "application/font-woff": ".woff", "application/x-font-ttf": ".ttf",
  "text/css": ".css",
};

export function extensionFor(contentType: string, url: string): string {
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (BY_TYPE[t]) return BY_TYPE[t];
  const fromUrl = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1];
  // Never take an extension from the URL that would make the file executable or a document.
  if (fromUrl && /^(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|css)$/i.test(fromUrl)) return `.${fromUrl.toLowerCase()}`;
  return ".bin";
}

/**
 * Point a document's references at the local copies.
 *
 * Replaces the exact substrings that were found, which is why `raw` is carried through discovery. A stylesheet
 * inside the artifact gets a path relative to ITSELF; a path relative to the document would break for a
 * stylesheet in a subdirectory.
 */
export function rewriteReferences(
  content: string,
  file: string,
  pinned: readonly { url: string; raw: string; localPath: string }[],
): { content: string; replaced: number } {
  let out = content;
  let replaced = 0;
  const depth = file.includes("/") ? file.split("/").length - 1 : 0;
  const up = "../".repeat(depth);

  // Longest raw first: a URL that is a prefix of another must not be rewritten inside it.
  for (const p of [...pinned].sort((a, b) => b.raw.length - a.raw.length)) {
    if (!p.raw || !out.includes(p.raw)) continue;
    const target = `${up}${p.localPath}`;
    const before = out;
    out = out.split(p.raw).join(target);
    if (out !== before) replaced++;
  }
  return { content: out, replaced };
}

/** Does a missing asset of this kind change what the page looks like? */
export function isVisual(kind: AssetKind): boolean {
  return kind === "image" || kind === "font" || kind === "stylesheet";
}

/** What a missing dependency does to the design, in words the owner can act on. */
export function visualImpact(kind: AssetKind, url: string): string {
  const host = (() => { try { return new URL(url).host; } catch { return "an external host"; } })();
  switch (kind) {
    case "font": return `the typeface served by ${host} is not available, so this text renders in a fallback font: different letterforms, widths and line breaks`;
    case "image": return `the image served by ${host} is not available, so this element renders empty or with its alternative text`;
    case "stylesheet": return `the stylesheet served by ${host} is not available, so everything it styles renders unstyled — this usually changes the whole page`;
    case "script": return `the script served by ${host} is not pinned; anything it draws or changes after load is not part of the measured design`;
    default: return `the resource served by ${host} is not available`;
  }
}
