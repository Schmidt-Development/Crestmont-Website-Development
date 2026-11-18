// Post-deployment check of the native-embedding standard (runner/starters/*/scripts/embedding.mjs, Owner 2026-11-18):
// after a customer site goes live, its homepage must permit Crestmont's portfolio to frame it and a sensitive page must
// still refuse every frame. Read from the live responses' own headers, the way a browser decides:
//   CSP frame-ancestors (every policy that has one must allow the origin) wins; otherwise X-Frame-Options DENY/SAMEORIGIN
//   refuses. Only releases built with the standard (public/_headers carries Crestmont's block) are checked.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PORTFOLIO_ORIGIN = "https://crestmontwebsitedevelopment.com";
const START = "# crestmont-native-embedding:start";

export function framingAllows(headers: Headers, origin: string): boolean {
  const lists = (headers.get("content-security-policy") ?? "").split(",").flatMap((pol) => pol.split(";").map((d) => d.trim()).filter((d) => /^frame-ancestors(\s|$)/i.test(d)).map((d) => d.split(/\s+/).slice(1)));
  if (lists.length) return lists.every((src) => !src.includes("'none'") && (src.includes(origin) || src.includes("*") || src.includes("https:")));
  return !/deny|sameorigin/i.test(headers.get("x-frame-options") ?? "");
}

/** The sensitive page to probe in a release (one that exists in its public/ folder), or null. */
export function sensitiveProbe(exportDir: string): string | null {
  for (const [file, url] of [["public/admin/index.html", "admin/"], ["public/booking/manage.html", "booking/manage.html"], ["public/account/index.html", "account/"]] as const)
    if (existsSync(path.join(exportDir, file))) return url;
  return null;
}
export const usesStandard = (exportDir: string) => { const f = path.join(exportDir, "public", "_headers"); return existsSync(f) && readFileSync(f, "utf8").includes(START); };

export async function checkLiveEmbedding(siteUrl: string, sensitive: string | null, fetchImpl: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  const get = async (u: string) => { const r = await fetchImpl(u, { redirect: "follow", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) }); await r.body?.cancel().catch(() => undefined); return r; };
  try {
    const home = await get(siteUrl);
    const pub = framingAllows(home.headers, PORTFOLIO_ORIGIN);
    let priv = true, privDetail = "no sensitive page in this site";
    if (sensitive) { const r = await get(new URL(sensitive, siteUrl).href); priv = !framingAllows(r.headers, PORTFOLIO_ORIGIN) && !framingAllows(r.headers, "https://unrelated.example"); privDetail = `${sensitive} ${priv ? "refuses framing" : "PERMITS framing"}`; }
    const open = framingAllows(home.headers, "https://unrelated.example");
    const ok = pub && priv && !open;
    return { ok, detail: `homepage ${pub ? "permits" : "does NOT permit"} Crestmont's portfolio${open ? " and ALSO other sites" : ""}; ${privDetail}` };
  } catch (e) { return { ok: false, detail: `embedding check failed: ${(e as Error).message}`.slice(0, 200) }; }
}
