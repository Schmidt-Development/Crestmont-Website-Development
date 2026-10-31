// Test doubles. Every business, domain and phone number here is TEST DATA (".example" domains never resolve).
import type { FetchResult } from "../src/http.ts";
import type { Candidate } from "../src/sources/types.ts";
import type { State } from "../src/state.ts";

export const NOW = () => new Date().toISOString();

export function page(opts: { title?: string; phone?: string; street?: string; city?: string; viewport?: boolean; extra?: string; lang?: boolean } = {}): string {
  return `<!doctype html><html${opts.lang === false ? "" : ' lang="en"'}><head><title>${opts.title ?? "Riverside Plumbing | Lansing MI"}</title>
${opts.viewport === false ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">'}<meta name="description" content="Plumbing in Lansing">
</head><body><h1>${opts.title ?? "Riverside Plumbing"}</h1><p>Call <a href="tel:${opts.phone ?? "+15175552142"}">${opts.phone ?? "(517) 555-2142"}</a></p>
<p>${opts.street ?? "120 Main Street"}, ${opts.city ?? "Lansing"}, MI 48933</p>${opts.extra ?? ""}<footer>© ${new Date().getUTCFullYear()} Riverside Plumbing</footer></body></html>`;
}

export function ok(url: string, body: string, extra: Partial<FetchResult> = {}): FetchResult {
  return { url, finalUrl: url, status: 200, chain: [{ url, status: 200 }], headers: { "content-type": "text/html" }, body, bytes: body.length, ms: 120, error: null, robotsBlocked: false, ...extra };
}
export function fail(url: string, kind: "dns" | "refused" | "timeout" | "tls", extra: Partial<FetchResult> = {}): FetchResult {
  return { url, finalUrl: url, status: null, chain: [], headers: {}, body: "", bytes: 0, ms: 15000, error: { kind, message: `${kind} (fixture)` }, robotsBlocked: false, ...extra };
}
export function status(url: string, code: number): FetchResult {
  return { url, finalUrl: url, status: code, chain: [{ url, status: code }], headers: {}, body: "", bytes: 0, ms: 200, error: null, robotsBlocked: false };
}

/** Http double: answers from a URL → result map (or a function); unknown URLs fail DNS. Counts requests. */
export class FakeHttp {
  requests: string[] = [];
  private readonly routes: Map<string, FetchResult | (() => FetchResult)>;
  readonly latencyMs: number;
  constructor(routes: Record<string, FetchResult | (() => FetchResult)>, latencyMs = 0) { this.routes = new Map(Object.entries(routes)); this.latencyMs = latencyMs; }
  async get(url: string): Promise<FetchResult> {
    this.requests.push(url);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const r = this.routes.get(url);
    return r ? (typeof r === "function" ? r() : r) : fail(url, "dns");
  }
}

export function cand(over: Partial<Candidate> & { businessKey?: string } = {}): Candidate {
  const key = over.businessKey ?? "overture:t1";
  return {
    businessKey: key, name: "Riverside Plumbing", category: "plumber", address: { line: "120 Main St", city: "Lansing", state: "MI", zip: "48933" }, lat: 42.73, lon: -84.55,
    phones: ["+15175552142"], emails: [], websites: ["https://riverside-plumbing.example/"],
    sources: [{ source: "overture", sourceId: key.split(":")[1], license: "CDLA-Permissive-2.0", release: "2026-10-21.0", retrievedAt: NOW() }],
    sourceConfidence: 0.9, operatingStatus: "open", ...over,
  };
}

export const deps = (http: FakeHttp, state: State, over: Record<string, unknown> = {}) =>
  ({ http: http as never, state, cc: null, browser: null, lighthousePath: null, brokenAttempts: 2, brokenRecheckAfterMs: 1000, checkLinks: false, ...over });
