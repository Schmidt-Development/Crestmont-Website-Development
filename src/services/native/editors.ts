// Structured, idempotent edits of the two framework-neutral header files the native automation supports. Each parses
// the file, changes only the entries Crestmont manages, and serialises it again — never a free-text substitution
// inside code. Running an edit on its own output returns the same text (no duplicates, no churn).
//   vercel.json  (Vercel, any framework): `headers` entries whose only header is the Crestmont frame-ancestors CSP;
//   _headers     (Cloudflare Pages): one block between Crestmont marker comments.
// A file that cannot be parsed is never rewritten: the edit refuses with a reason.

export class EditError extends Error {}
const SAFE_PATH = /^\/[A-Za-z0-9/_.~-]*$/;

/** vercel.json: removes Crestmont's previous entries (identified by their exact frame-ancestors value or the earlier
 *  value for the same origins) and adds one per public path; every other key and header rule is kept as it was. */
export function editVercelJson(current: string | null, paths: string[], frameAncestors: string): string {
  let doc: Record<string, unknown> = {};
  if (current !== null && current.trim()) {
    try { doc = JSON.parse(current); } catch { throw new EditError("vercel.json is not valid JSON, so Crestmont did not change it"); }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new EditError("vercel.json is not a JSON object, so Crestmont did not change it");
  }
  if (doc.headers !== undefined && !Array.isArray(doc.headers)) throw new EditError("vercel.json `headers` is not a list, so Crestmont did not change it");
  if (doc.routes !== undefined) throw new EditError("vercel.json uses legacy `routes`, which cannot be combined with `headers`; the header change must be made by hand");
  const isOurs = (h: unknown) => {
    const e = h as { headers?: { key?: string; value?: string }[] };
    return Array.isArray(e?.headers) && e.headers.length === 1 && /^content-security-policy$/i.test(e.headers[0]?.key ?? "") && /^frame-ancestors\s+https:\/\/\S+(\s+https:\/\/\S+)*$/.test(e.headers[0]?.value ?? "") && /crestmont/i.test(e.headers[0]?.value ?? "");
  };
  const kept = ((doc.headers as unknown[]) ?? []).filter((h) => !isOurs(h));
  const ours = [...new Set(paths)].filter((p) => SAFE_PATH.test(p)).sort().map((p) => ({ source: p, headers: [{ key: "Content-Security-Policy", value: frameAncestors }] }));
  if (!ours.length) throw new EditError("No public page to open");
  doc.headers = [...kept, ...ours];
  return JSON.stringify(doc, null, 2) + "\n";
}

export const HEADERS_START = "# crestmont-native-embedding:start — managed by Crestmont: public pages may be shown in Crestmont's portfolio";
export const HEADERS_END = "# crestmont-native-embedding:end";
/** Cloudflare Pages _headers: replaces Crestmont's marked block (or appends it); on its public paths it detaches any
 *  X-Frame-Options set by an earlier rule and adds the frame-ancestors CSP. Sensitive paths are never listed. */
export function editPagesHeaders(current: string | null, paths: string[], frameAncestors: string): string {
  const text = (current ?? "").replace(/\r\n/g, "\n");
  const s = text.indexOf(HEADERS_START), e = text.indexOf(HEADERS_END);
  if ((s === -1) !== (e === -1) || (s !== -1 && e < s)) throw new EditError("_headers has an incomplete Crestmont block, so Crestmont did not change it");
  const before = s === -1 ? text : text.slice(0, s), after = s === -1 ? "" : text.slice(e + HEADERS_END.length).replace(/^\n/, "");
  const list = [...new Set(paths)].filter((p) => SAFE_PATH.test(p)).sort();
  if (!list.length) throw new EditError("No public page to open");
  const block = [HEADERS_START, ...list.flatMap((p) => [p, "  ! X-Frame-Options", `  Content-Security-Policy: ${frameAncestors}`]), HEADERS_END].join("\n");
  const head = before.replace(/\n*$/, "");
  return `${head ? head + "\n\n" : ""}${block}\n${after ? "\n" + after.replace(/^\n+/, "") : ""}`;
}
