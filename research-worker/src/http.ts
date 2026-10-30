// Polite, safe HTTP for website verification.
//  - Identifies itself (User-Agent with contact), honours robots.txt (RFC 9309) including Crawl-delay, one request
//    at a time per host with a minimum interval, global concurrency cap, timeouts and a response-size cap.
//  - Never reaches private networks: every connection resolves DNS through a lookup hook that refuses loopback,
//    private, link-local, CGNAT and other non-public addresses (the worker runs inside the Founder's LAN). Because the
//    check happens in the socket's own lookup, a DNS answer cannot change between the check and the connection.
//  - Never submits forms, never solves CAPTCHAs, never retries around a 401/403/429 (those are recorded as-is).
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Readable } from "node:stream";

export type NetErrorKind = "dns" | "refused" | "timeout" | "tls" | "reset" | "blocked_address" | "too_large" | "other";
export interface Hop { url: string; status: number; location?: string }
export interface FetchResult {
  url: string; finalUrl: string; status: number | null; chain: Hop[]; headers: Record<string, string>; body: string; bytes: number;
  /** Wall time including robots.txt and politeness waits (for throughput accounting). */
  ms: number;
  /** Network time of the final request only (what a visitor would wait for the HTML); null when no response. */
  responseMs?: number | null;
  error: { kind: NetErrorKind; message: string } | null; robotsBlocked: boolean;
}

// ───────────── Address safety ─────────────
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;       // CGNAT
    if (a === 169 && b === 254) return false;                 // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || (b === 0 && ip.startsWith("192.0.2.")))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;    // benchmarking
    return true;
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1" || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("ff")) return false;
    const m = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(s);   // IPv4-mapped and IPv4-compatible
    if (m) return isPublicAddress(m[1]);
    if (s.startsWith("::ffff:") || s.startsWith("64:ff9b:") || s.startsWith("2002:") || s.startsWith("2001:db8:") || s.startsWith("100::")) return false; // mapped hex form, NAT64, 6to4, documentation, discard
    return true;
  }
  return false;
}

export class BlockedAddressError extends Error { code = "EBLOCKEDADDR"; }

/** dns.lookup replacement used by every socket: only public addresses are ever returned. Tests may allow loopback. */
export function safeLookup(allowLoopback = false) {
  return (host: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(host, { ...(options as object), all: true }, (err, addrs) => {
      if (err) return cb(err, "", 0);
      const list = (addrs as LookupAddress[]).filter((a) => isPublicAddress(a.address) || (allowLoopback && (a.address === "127.0.0.1" || a.address === "::1")));
      if (!list.length) return cb(new BlockedAddressError(`${host} resolves only to non-public addresses`), "", 0);
      if ((options as { all?: boolean }).all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

// ───────────── robots.txt ─────────────
export interface Robots { groups: { agents: string[]; rules: { allow: boolean; path: string }[]; crawlDelay: number | null }[] }
export function parseRobots(text: string): Robots {
  const groups: Robots["groups"] = [];
  let cur: Robots["groups"][number] | null = null, lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") { if (val || key === "allow") cur.rules.push({ allow: key === "allow", path: val }); }
    else if (key === "crawl-delay" && /^\d+(\.\d+)?$/.test(val)) cur.crawlDelay = Number(val);
  }
  return { groups };
}
function ruleMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  return re.test(path);
}
/** RFC 9309: the most specific matching group for our token (else "*"); longest matching rule wins; Allow wins ties. */
export function robotsDecision(r: Robots, token: string, path: string): { allowed: boolean; crawlDelay: number | null } {
  const t = token.toLowerCase();
  const group = r.groups.find((g) => g.agents.some((a) => a !== "*" && t.includes(a))) ?? r.groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, crawlDelay: null };
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
  }
  return { allowed: best ? best.allow : true, crawlDelay: group.crawlDelay };
}

// ───────────── Fetcher ─────────────
export interface HttpOptions { userAgent: string; robotsToken: string; timeoutMs: number; perHostIntervalMs: number; concurrency: number; maxBytes: number; allowLoopback?: boolean }

/** A Crawl-delay above this means the site does not want automated visits at our pace: treated as restricted. */
export const MAX_CRAWL_DELAY_S = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function classify(e: unknown): { kind: NetErrorKind; message: string } {
  const err = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  const code = err?.code ?? err?.cause?.code ?? "";
  const message = `${code ? code + ": " : ""}${err?.message ?? String(e)}`.slice(0, 300);
  if (code === "EBLOCKEDADDR") return { kind: "blocked_address", message };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return { kind: "dns", message };
  if (code === "ECONNREFUSED") return { kind: "refused", message };
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "TIMEOUT") return { kind: "timeout", message };
  if (code === "ECONNRESET" || code === "EPIPE") return { kind: "reset", message };
  if (/CERT|SSL|TLS|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|ALTNAME|EPROTO/i.test(code + message)) return { kind: "tls", message };
  if (code === "ETOOLARGE") return { kind: "too_large", message };
  return { kind: "other", message };
}

export class Http {
  private readonly hosts = new Map<string, { next: number; busy: boolean; robots?: { at: number; r: Robots | "deny" | "allow" } }>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  readonly opts: HttpOptions;
  requests = 0;
  constructor(opts: HttpOptions) { this.opts = opts; }

  private async slot<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const h = this.hosts.get(host) ?? this.hosts.set(host, { next: 0, busy: false }).get(host)!;
    // Wait for this host's turn BEFORE taking a global slot, so one slow host cannot hold the pool.
    for (;;) {
      while (h.busy || Date.now() < h.next) await sleep(Math.max(50, Math.min(h.next - Date.now(), 60_000)));
      while (this.active >= this.opts.concurrency) await new Promise<void>((r) => this.waiters.push(r));
      if (!h.busy && Date.now() >= h.next) break;
      this.waiters.shift()?.();
    }
    this.active++;
    try {
      h.busy = true;
      try { return await fn(); }
      finally {
        const delay = h.robots && typeof h.robots.r === "object" ? Math.max(this.opts.perHostIntervalMs, Math.min(MAX_CRAWL_DELAY_S, robotsDecision(h.robots.r, this.opts.robotsToken, "/").crawlDelay ?? 0) * 1000) : this.opts.perHostIntervalMs;
        h.next = Date.now() + delay; h.busy = false;
      }
    } finally { this.active--; this.waiters.shift()?.(); }
  }

  /** One raw request (no redirects followed), size-capped and decompressed. */
  private raw(url: URL, method: "GET" | "HEAD"): Promise<{ status: number; headers: Record<string, string>; body: string; bytes: number }> {
    return new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method, lookup: safeLookup(this.opts.allowLoopback) as never, timeout: this.opts.timeoutMs,
        headers: { "user-agent": this.opts.userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-encoding": "gzip, deflate, br", "accept-language": "en-US,en;q=0.8" },
      }, (res: IncomingMessage) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
        if (method === "HEAD") { res.resume(); return resolve({ status: res.statusCode ?? 0, headers, body: "", bytes: 0 }); }
        const enc = (headers["content-encoding"] ?? "").toLowerCase();
        let stream: Readable = res;
        if (enc.includes("gzip")) stream = res.pipe(createGunzip()); else if (enc.includes("br")) stream = res.pipe(createBrotliDecompress()); else if (enc.includes("deflate")) stream = res.pipe(createInflate());
        const chunks: Buffer[] = []; let bytes = 0;
        stream.on("data", (d: Buffer) => {
          bytes += d.length;
          if (bytes > this.opts.maxBytes) { req.destroy(Object.assign(new Error(`response over ${this.opts.maxBytes} bytes`), { code: "ETOOLARGE" })); return; }
          chunks.push(d);
        });
        stream.on("end", () => resolve({ status: res.statusCode ?? 0, headers, body: /text|html|xml|json/i.test(headers["content-type"] ?? "text/html") ? Buffer.concat(chunks).toString("utf8") : "", bytes }));
        stream.on("error", reject);
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "TIMEOUT" })));
      req.on("error", reject);
      req.end();
    });
  }

  /** robots.txt for an origin, cached 24 h. 4xx → allow all; unreachable/5xx → disallow all (RFC 9309 §2.3.1). */
  async robots(origin: URL): Promise<Robots | "deny" | "allow"> {
    const h = this.hosts.get(origin.host) ?? this.hosts.set(origin.host, { next: 0, busy: false }).get(origin.host)!;
    if (h.robots && Date.now() - h.robots.at < 86400e3) return h.robots.r;
    let r: Robots | "deny" | "allow" = "deny";
    try {
      // RFC 9309 §2.3.1.2: follow at least five redirects; a robots.txt that cannot be reached that way is "unavailable"
      // (treated like 4xx: allowed). Every hop gets the same public-address checks as page requests.
      let u = new URL("/robots.txt", origin);
      for (let hop = 0; ; hop++) {
        const lit = u.hostname.replace(/^\[|\]$/g, "");
        if ((isIP(lit) && !isPublicAddress(lit) && !(this.opts.allowLoopback && (lit === "127.0.0.1" || lit === "::1"))) || !/^https?:$/.test(u.protocol)) { r = "deny"; break; }
        const target = u;
        const res = await this.slot(target.host, () => { this.requests++; return this.raw(target, "GET"); });
        if (res.status >= 300 && res.status < 400) {
          if (hop >= 5 || !res.headers.location) { r = "allow"; break; }
          u = new URL(res.headers.location, u);
          continue;
        }
        r = res.status >= 200 && res.status < 300 ? parseRobots(res.body) : res.status >= 400 && res.status < 500 ? "allow" : "deny";
        break;
      }
    } catch { r = "deny"; }
    h.robots = { at: Date.now(), r };
    return r;
  }

  async allowed(u: URL): Promise<boolean> {
    const r = await this.robots(u);
    if (r === "allow") return true;
    if (r === "deny") return false;
    const d = robotsDecision(r, this.opts.robotsToken, u.pathname + u.search);
    return d.allowed && (d.crawlDelay ?? 0) <= MAX_CRAWL_DELAY_S;
  }

  /** GET with redirects followed manually (≤ 5 hops), robots and address checks on every hop. */
  async get(input: string, method: "GET" | "HEAD" = "GET"): Promise<FetchResult> {
    const started = Date.now();
    const chain: Hop[] = [];
    let url: URL;
    try { url = new URL(input); } catch { return { url: input, finalUrl: input, status: null, chain, headers: {}, body: "", bytes: 0, ms: 0, error: { kind: "other", message: "invalid URL" }, robotsBlocked: false }; }
    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return { url: input, finalUrl: url.href, status: null, chain, headers: {}, body: "", bytes: 0, ms: Date.now() - started, error: { kind: "other", message: `unsupported scheme ${url.protocol}` }, robotsBlocked: false };
      // Node never calls the lookup hook for IP-literal hosts, so literals (e.g. a redirect to http://192.168.1.1/) are checked here.
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && !isPublicAddress(literal) && !(this.opts.allowLoopback && (literal === "127.0.0.1" || literal === "::1"))) {
        return { url: input, finalUrl: url.href, status: null, chain, headers: {}, body: "", bytes: 0, ms: Date.now() - started, error: { kind: "blocked_address", message: `${literal} is not a public address` }, robotsBlocked: false };
      }
      if (!(await this.allowed(url))) return { url: input, finalUrl: url.href, status: null, chain, headers: {}, body: "", bytes: 0, ms: Date.now() - started, error: null, robotsBlocked: true };
      let res, reqMs = 0;
      try { res = await this.slot(url.host, async () => { this.requests++; const t = Date.now(); try { return await this.raw(url, method); } finally { reqMs = Date.now() - t; } }); }
      catch (e) { return { url: input, finalUrl: url.href, status: null, chain, headers: {}, body: "", bytes: 0, ms: Date.now() - started, error: classify(e), robotsBlocked: false }; }
      const loc = res.headers.location;
      chain.push({ url: url.href, status: res.status, ...(loc ? { location: loc } : {}) });
      if (res.status >= 300 && res.status < 400 && loc) {
        try { url = new URL(loc, url); } catch { return { url: input, finalUrl: url.href, status: res.status, chain, headers: res.headers, body: "", bytes: 0, ms: Date.now() - started, error: { kind: "other", message: "invalid redirect location" }, robotsBlocked: false }; }
        if (chain.some((c) => c.url === url.href)) return { url: input, finalUrl: url.href, status: res.status, chain, headers: res.headers, body: "", bytes: 0, ms: Date.now() - started, error: { kind: "other", message: "redirect loop" }, robotsBlocked: false };
        continue;
      }
      return { url: input, finalUrl: url.href, status: res.status, chain, headers: res.headers, body: res.body, bytes: res.bytes, ms: Date.now() - started, responseMs: reqMs, error: null, robotsBlocked: false };
    }
    return { url: input, finalUrl: url.href, status: chain.at(-1)?.status ?? null, chain, headers: {}, body: "", bytes: 0, ms: Date.now() - started, error: { kind: "other", message: "more than 5 redirects" }, robotsBlocked: false };
  }
}
