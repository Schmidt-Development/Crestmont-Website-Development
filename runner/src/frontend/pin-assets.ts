// Writing an artifact's external dependencies into it, so the measurement can be offline and still be true.
//
// Two rounds, and the second one is not an optimisation. The common real case is a Google Fonts stylesheet: the
// document references `fonts.googleapis.com/css2?family=...`, and that stylesheet references woff2 files on
// `fonts.gstatic.com`. Pinning only what the document names would store the stylesheet and none of the fonts it
// exists to load, and the page would still render in a fallback face. So after the first round the newly pinned
// stylesheets are read and their own references resolved. Two rounds, then stop: a stylesheet chain deeper than
// that is not a website's typography, and an unbounded crawl is not something to run on an owner's upload.
//
// Nothing here fetches anything. Resolution is the platform's -- it has the network, the rules and the storage --
// and this module only asks, writes and rewrites.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PINNED_DIR, isVisual, refsInCss, refsInHtml, rewriteReferences, visualImpact } from "./external-assets.ts";
// Re-exported so callers and tests have one import for the whole step rather than two.
export { classify, refsInCss, refsInHtml, rewriteReferences, visualImpact, PINNED_DIR } from "./external-assets.ts";
export type { AssetKind, ExternalRef } from "./external-assets.ts";
import type { AssetKind, ExternalRef } from "./external-assets.ts";

/** What the platform answers for one dependency. */
export interface ResolvedAsset {
  url: string;
  kind: AssetKind;
  status: "pinned" | "refused";
  why?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  contentType?: string | null;
  localPath?: string | null;
  /** base64. Present on `pinned`. */
  body?: string | null;
}

export type ResolveAssets = (refs: readonly ExternalRef[]) => Promise<ResolvedAsset[]>;

export interface PinOutcome {
  /** Every dependency found, with what became of it. */
  assets: {
    url: string; kind: AssetKind; status: "pinned" | "refused"; why: string | null;
    sha256: string | null; bytes: number | null; localPath: string | null; referencedBy: string;
  }[];
  /** Visual dependencies that could not be acquired. A baseline with any of these is materially incomplete. */
  missing: { url: string; kind: AssetKind; why: string; impact: string; referencedBy: string }[];
  /** Files whose references were rewritten. */
  rewritten: string[];
  rounds: number;
}

const TEXT_EXT = /\.(html?|css)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist-ssr", PINNED_DIR]);

/** Every HTML and CSS file in the extracted artifact, relative to its root. */
export function textFilesIn(repo: string, depth = 6): string[] {
  const out: string[] = [];
  const walk = (rel: string, d: number) => {
    if (d > depth) return;
    let names: string[];
    try { names = readdirSync(path.join(repo, rel)); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".") || SKIP_DIR.has(n)) continue;
      const sub = rel ? `${rel}/${n}` : n;
      let st;
      try { st = statSync(path.join(repo, sub)); } catch { continue; }
      if (st.isDirectory()) walk(sub, d + 1);
      else if (TEXT_EXT.test(n) && st.size <= 4 * 1024 * 1024) out.push(sub);
    }
  };
  walk("", 1);
  return out.sort();
}

/** Every external reference in the artifact, by file. */
export function discoverRefs(repo: string): ExternalRef[] {
  const refs: ExternalRef[] = [];
  for (const file of textFilesIn(repo)) {
    let body: string;
    try { body = readFileSync(path.join(repo, file), "utf8"); } catch { continue; }
    refs.push(...(/\.css$/i.test(file) ? refsInCss(body, file) : refsInHtml(body, file)));
  }
  return refs;
}

/**
 * Acquire the artifact's external dependencies and make it reference them locally.
 *
 * Returns what happened to each one, including every refusal. A refused VISUAL dependency is reported with its
 * impact in words, because that is what the owner has to decide about: the alternative -- rendering a fallback
 * and calling it the approved design -- is the defect this whole path exists to remove.
 */
export async function pinExternalAssets(o: { repo: string; resolve: ResolveAssets }): Promise<PinOutcome> {
  const out: PinOutcome = { assets: [], missing: [], rewritten: [], rounds: 0 };
  const byUrl = new Map<string, ResolvedAsset>();
  const refsByUrl = new Map<string, ExternalRef>();

  let pending = dedupeByUrl(discoverRefs(o.repo));
  for (let round = 1; round <= 2 && pending.length; round++) {
    out.rounds = round;
    for (const r of pending) if (!refsByUrl.has(r.url)) refsByUrl.set(r.url, r);

    const answers = await o.resolve(pending);
    const written: { url: string; raw: string; localPath: string }[] = [];
    for (const a of answers) {
      byUrl.set(a.url, a);
      if (a.status !== "pinned" || !a.body || !a.localPath) continue;
      const target = path.resolve(o.repo, a.localPath);
      const root = path.resolve(o.repo);
      if (target !== root && !target.startsWith(root + path.sep)) {
        // The platform decides the path, and this is the check that it decided something safe.
        byUrl.set(a.url, { ...a, status: "refused", why: `the asset's local path "${a.localPath}" resolves outside the artifact` });
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, Buffer.from(a.body, "base64"), { mode: 0o644 });
      const ref = refsByUrl.get(a.url);
      if (ref) written.push({ url: a.url, raw: ref.raw, localPath: a.localPath });
    }

    // Rewrite every file that referenced anything pinned in this round.
    const touched = new Set(pending.filter((r) => byUrl.get(r.url)?.status === "pinned").map((r) => r.referencedBy));
    for (const file of touched) {
      const abs = path.join(o.repo, file);
      let body: string;
      try { body = readFileSync(abs, "utf8"); } catch { continue; }
      const forThisFile = pending
        .filter((r) => r.referencedBy === file && byUrl.get(r.url)?.status === "pinned")
        .map((r) => ({ url: r.url, raw: r.raw, localPath: byUrl.get(r.url)!.localPath! }));
      const { content, replaced } = rewriteReferences(body, file, forThisFile);
      if (replaced > 0) {
        writeFileSync(abs, content, { mode: 0o644 });
        if (!out.rewritten.includes(file)) out.rewritten.push(file);
      }
    }

    // Round two: what the stylesheets we just pinned reference themselves.
    const next: ExternalRef[] = [];
    if (round === 1) {
      for (const a of answers) {
        if (a.status !== "pinned" || a.kind !== "stylesheet" || !a.localPath) continue;
        let css: string;
        try { css = readFileSync(path.join(o.repo, a.localPath), "utf8"); } catch { continue; }
        for (const r of refsInCss(css, a.localPath)) if (!byUrl.has(r.url)) next.push(r);
      }
    }
    pending = dedupeByUrl(next);
  }

  for (const [url, a] of byUrl) {
    const ref = refsByUrl.get(url);
    out.assets.push({
      url, kind: a.kind, status: a.status, why: a.why ?? null, sha256: a.sha256 ?? null, bytes: a.bytes ?? null,
      localPath: a.localPath ?? null, referencedBy: ref?.referencedBy ?? "",
    });
    if (a.status === "refused" && isVisual(a.kind)) {
      out.missing.push({
        url, kind: a.kind, why: a.why ?? "it could not be acquired",
        impact: visualImpact(a.kind, url), referencedBy: ref?.referencedBy ?? "",
      });
    }
  }
  out.assets.sort((x, y) => x.url.localeCompare(y.url));
  return out;
}

function dedupeByUrl(refs: readonly ExternalRef[]): ExternalRef[] {
  const seen = new Set<string>();
  const out: ExternalRef[] = [];
  for (const r of refs) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/** The pinned set in words, for the import record the owner reads. */
export function describePinned(p: PinOutcome): string {
  const pinned = p.assets.filter((a) => a.status === "pinned");
  if (!p.assets.length) return "no external assets: everything this design needs is inside the archive";
  const bytes = pinned.reduce((n, a) => n + (a.bytes ?? 0), 0);
  const head = `${pinned.length} of ${p.assets.length} external asset(s) pinned into the artifact (${Math.round(bytes / 1024)} KB), `
    + `so the design is measured with them rather than without them`;
  if (!p.missing.length) return head;
  return [
    head,
    `${p.missing.length} could NOT be acquired, and the design cannot be approved until they are resolved:`,
    ...p.missing.map((m) => `- ${m.kind} ${m.url} (referenced by ${m.referencedBy}): ${m.why}. ${m.impact}`),
  ].join("\n");
}
