// Stage D: does this page belong to this business? Compares what the page says (visible text, title, schema.org
// LocalBusiness JSON-LD) with the source record. Pure functions, no network. A similar NAME alone is never enough:
// a page is official only with a phone or street-address match, or when an independent source lists the domain AND
// the name matches.
import { normName, phoneE164 } from "../../src/domain/research.ts";
import type { Candidate } from "./sources/types.ts";

export interface PageFacts { title: string; text: string; phones: string[]; jsonLd: { name?: string; telephone?: string[]; street?: string; city?: string; region?: string }[]; generator: string | null; siteName: string | null; h1: string | null }

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/**
 * Decodes HTML character references in ONE pass: every reference in the input is replaced exactly once and the
 * output is never scanned again, so "&amp;lt;" becomes the literal text "&lt;" (not "<"). Numeric references that
 * are not valid Unicode scalar values (0, surrogates, > U+10FFFF) become U+FFFD. Unknown names are left as written.
 * Callers strip tags BEFORE decoding, so decoded "<" / ">" can never form markup.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z]{2,8}));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\uFFFD";
  });
}
const tagText = (html: string, tag: string) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html); return m ? decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : null; };
const meta = (html: string, key: string) => {
  const m = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, "i").exec(html);
  const c = m ? /content=["']([^"']*)["']/i.exec(m[0]) : null;
  return c ? decodeEntities(c[1]).trim() : null;
};

export function pageFacts(html: string): PageFacts {
  const noScript = html.replace(/<script(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = decodeEntities(noScript.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200_000);
  const telLinks = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]);
  const phoneLike = [...text.matchAll(/(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}\b/g)].map((m) => m[0]);
  const phones = [...new Set([...telLinks, ...phoneLike].map(phoneE164).filter((p): p is string => !!p))].slice(0, 50);
  const jsonLd: PageFacts["jsonLd"] = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o: unknown): void => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!o || typeof o !== "object") return;
        const r = o as Record<string, unknown>;
        if (r["@graph"]) walk(r["@graph"]);
        const addr = (r.address && typeof r.address === "object" ? r.address : {}) as Record<string, unknown>;
        if (r.telephone || r.address || /business|organization|store|restaurant|service/i.test(String(r["@type"] ?? ""))) {
          jsonLd.push({ name: typeof r.name === "string" ? r.name : undefined, telephone: [r.telephone].flat().filter((t): t is string => typeof t === "string"),
            street: typeof addr.streetAddress === "string" ? addr.streetAddress : undefined, city: typeof addr.addressLocality === "string" ? addr.addressLocality : undefined, region: typeof addr.addressRegion === "string" ? addr.addressRegion : undefined });
        }
      };
      walk(JSON.parse(m[1]));
    } catch { /* malformed JSON-LD is ignored */ }
    if (jsonLd.length > 20) break;
  }
  return { title: tagText(html, "title") ?? "", text, phones, jsonLd, generator: meta(html, "generator"), siteName: meta(html, "og:site_name"), h1: tagText(html, "h1") };
}

const tokens = (s: string) => new Set(normName(s).split(" ").filter((t) => t.length > 1));
/** Share of the business name's tokens that appear in the text (0..1). */
export function nameOverlap(name: string, text: string): number {
  const n = tokens(name);
  if (!n.size) return 0;
  const t = tokens(text);
  let hit = 0;
  for (const x of n) if (t.has(x)) hit++;
  return hit / n.size;
}

/** "120 Main St" → number + first street word, which tolerates St/Street/Ave abbreviations. */
export function streetKey(line: string | null): { num: string; word: string } | null {
  const m = /^\s*(\d{1,6})\s+(?:[NSEW]\.?\s+)?([A-Za-z0-9]+)/.exec(line ?? "");
  return m ? { num: m[1], word: m[2].toLowerCase() } : null;
}

export interface IdentityResult { score: number; official: boolean; signals: string[]; contradictions: string[] }

/**
 * Weighs identity evidence. listedBy = independent sources that list this domain for this business record.
 * Official requires a hard signal (phone or street address) with score ≥ 0.6 — or listing by a source plus a strong
 * name match and no contradicting contact details. A different phone with no shared signal is a contradiction (likely a different business).
 */
export function identity(c: Candidate, f: PageFacts, listedBy: string[]): IdentityResult {
  const signals: string[] = [], contradictions: string[] = [];
  let score = 0, hard = false;
  const pagePhones = new Set([...f.phones, ...f.jsonLd.flatMap((j) => (j.telephone ?? []).map(phoneE164).filter((p): p is string => !!p))]);
  if (c.phones.some((p) => pagePhones.has(p))) { score += 0.45; hard = true; signals.push("phone on page matches the listing"); }
  else if (c.phones.length && pagePhones.size) contradictions.push("page shows different phone numbers than the listing");
  const sk = streetKey(c.address.line);
  const textLower = f.text.toLowerCase();
  if (sk && new RegExp(`\\b${sk.num}\\s+(?:[nsew]\\.?\\s+)?${sk.word}`, "i").test(textLower + " " + f.jsonLd.map((j) => j.street ?? "").join(" ").toLowerCase())) { score += 0.25; hard = true; signals.push("street address on page matches"); }
  if (c.address.city && textLower.includes(c.address.city.toLowerCase())) { score += 0.1; signals.push("city on page matches"); }
  const nameScore = Math.max(nameOverlap(c.name, `${f.title} ${f.siteName ?? ""} ${f.h1 ?? ""} ${f.jsonLd.map((j) => j.name ?? "").join(" ")}`), nameOverlap(c.name, f.text.slice(0, 5000)) * 0.8);
  if (nameScore >= 0.6) { score += 0.2 * nameScore; signals.push(`business name on page (${Math.round(nameScore * 100)}% of name words)`); }
  if (listedBy.length) { score += Math.min(0.3, 0.15 * listedBy.length); signals.push(`listed as this business's website by ${listedBy.join(", ")}`); }
  score = Math.min(1, Math.round(score * 100) / 100);
  // Hard evidence (phone / street) with enough total weight; or an independent listing plus a strong name match and no
  // contradicting contact details on the page.
  const official = (hard && score >= 0.6) || (!hard && listedBy.length > 0 && nameScore >= 0.6 && !contradictions.length);
  return { score, official, signals, contradictions };
}

/** Parked / for-sale / placeholder pages: the listed domain does not carry the business's site. */
export function parkedPage(f: PageFacts): string | null {
  const t = `${f.title} ${f.text.slice(0, 4000)}`.toLowerCase();
  const m = /(this domain (is|may be) for sale|buy this domain|domain parking|parked free|is parked|godaddy\.com\/domainsearch|sedo\.com|hugedomains|dan\.com|future home of something quite cool|website coming soon|account (has been )?suspended|this site is under construction|default web site page|welcome to nginx|apache2 (ubuntu|debian) default page|it works!)/.exec(t);
  return m ? m[0] : null;
}
