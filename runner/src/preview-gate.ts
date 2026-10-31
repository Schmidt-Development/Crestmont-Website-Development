// Private previews (Founder decision D3, 2026-10-28).
//
// Every preview the runner deploys is wrapped in a gate the runner generates; the agent's Wrangler config is not
// deployed as written. The gate is the Worker's entry point with `run_worker_first: true`, so EVERY request (pages,
// static assets, /api/*) passes through it, and without a valid session it answers 401 with no site content.
//
// Sign-in: the platform (src/lib/preview-token.ts) checks who is asking (staff with builds.read, or the project's own
// customer for a shared preview) and redirects to `/__crestmont/auth?t=<payload>.<sig>`, a 5-minute link signed with
// this preview's own key. The gate exchanges it for a 2-hour, host-only `__Host-` session cookie (HttpOnly, Secure,
// SameSite=Lax) and redirects to a relative path, so the token leaves the address bar.
//
// Key: HMAC-SHA256(PREVIEW_GATE_SECRET, "crestmont-preview-key:" + workerName), base64url, deployed as the Worker
// variable CRESTMONT_PREVIEW_KEY. The master secret never leaves the runner and the platform; the site's own code
// gets an env without the key and requests without the session cookie.
//
// No paid product: this uses only Workers features on the free plan. (Cloudflare Access would also work but is free
// only up to 50 users per account and customers would count as users; see docs/ai-builds/PREVIEW-DEPLOYMENT.md.)

import { createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GATE_FILE = "__crestmont_preview_gate.mjs";
export const SESSION_SECONDS = 7200;

export function previewKey(masterSecret: string, workerName: string): string {
  if (!masterSecret || masterSecret.length < 32) throw new Error("PREVIEW_GATE_SECRET must be at least 32 characters");
  return createHmac("sha256", masterSecret).update(`crestmont-preview-key:${workerName}`).digest("base64url");
}

/** JSON with comments and trailing commas (wrangler.jsonc) → value. Comments inside strings are kept. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  // Trailing commas: only outside strings (strings were copied verbatim above, so re-scan with the same rule).
  let clean = "";
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(i, j + 1);
      i = j;
    } else if (c === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
      clean += c;
    } else clean += c;
  }
  return JSON.parse(clean);
}

const TOP_KEYS = new Set(["$schema", "name", "main", "compatibility_date", "compatibility_flags", "assets", "vars", "observability", "workers_dev", "preview_urls"]);
const ASSET_KEYS = new Set(["directory", "binding", "not_found_handling", "html_handling", "run_worker_first"]);
const REL_PATH = /^(?:\.\/)?(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface GatePlan {
  config: Record<string, unknown>;
  gateSource: string;
}

/** The site's own Wrangler settings, validated (shared by private previews and customer production releases). */
export interface SiteConfig {
  main: string | null;
  /** The site's assets block as it should be deployed (binding, directory, handling), without run_worker_first. */
  assets: { directory: string; binding: string; not_found_handling?: string; html_handling?: string } | null;
  /** The site's own run_worker_first (true, patterns, or false). */
  workerFirst: true | string[] | false;
  /** A 404 from assets falls through to the site's Worker (Workers' default without not_found_handling). */
  fallThrough: boolean;
  vars: Record<string, string | number | boolean>;
  compatibilityDate: string;
  compatibilityFlags: string[];
}

/**
 * Read the agent's Wrangler config from an export. Anything the target account cannot or should not get (bindings
 * to data stores, Durable Objects, services, routes, build commands, TOML configs) is refused rather than dropped, so
 * what is deployed never behaves differently from what the owner reviewed.
 */
export function readSiteConfig(exportDir: string): { site: SiteConfig | null; problems: string[] } {
  const problems: string[] = [];
  if (existsSync(path.join(exportDir, "wrangler.toml"))) return { site: null, problems: ["wrangler.toml is not supported (use wrangler.jsonc)"] };
  const files = ["wrangler.jsonc", "wrangler.json"].filter((f) => existsSync(path.join(exportDir, f)));
  if (files.length > 1) return { site: null, problems: ["both wrangler.json and wrangler.jsonc exist"] };
  let agent: Record<string, unknown> = {};
  if (files.length) {
    const file = path.join(exportDir, files[0]);
    if (lstatSync(file).isSymbolicLink()) return { site: null, problems: [`${files[0]} is a symbolic link`] };
    try {
      const v = parseJsonc(readFileSync(file, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      agent = v as Record<string, unknown>;
    } catch (err) { return { site: null, problems: [`${files[0]} could not be read: ${(err as Error).message.slice(0, 120)}`] }; }
  }
  const extra = Object.keys(agent).filter((k) => !TOP_KEYS.has(k));
  if (extra.length) problems.push(`Wrangler config uses settings Crestmont deployments do not support: ${extra.slice(0, 8).join(", ")}`);

  let main: string | null = null;
  if (agent.main !== undefined) {
    if (typeof agent.main !== "string" || !REL_PATH.test(agent.main) || !/\.(?:m?js|ts)$/.test(agent.main)) problems.push("main must be a relative .js/.mjs/.ts path inside the project");
    else if (!existsSync(path.join(exportDir, agent.main))) problems.push(`main (${agent.main}) does not exist`);
    else main = agent.main.replace(/^\.\//, "");
  }
  const assetsIn = agent.assets as Record<string, unknown> | undefined;
  let assets: SiteConfig["assets"] = null;
  let workerFirst: true | string[] | false = false;
  let fallThrough = false;
  if (assetsIn !== undefined) {
    if (!assetsIn || typeof assetsIn !== "object" || Array.isArray(assetsIn)) problems.push("assets must be an object");
    else {
      const bad = Object.keys(assetsIn).filter((k) => !ASSET_KEYS.has(k));
      if (bad.length) problems.push(`assets uses unsupported settings: ${bad.join(", ")}`);
      const dir = assetsIn.directory;
      if (typeof dir !== "string" || !REL_PATH.test(dir)) problems.push("assets.directory must be a relative path inside the project");
      const binding = assetsIn.binding ?? "ASSETS";
      if (typeof binding !== "string" || !IDENT.test(binding) || binding === "CRESTMONT_PREVIEW_KEY") problems.push("assets.binding must be a plain identifier");
      const rwf = assetsIn.run_worker_first;
      if (rwf === true) workerFirst = true;
      else if (Array.isArray(rwf) && rwf.every((x) => typeof x === "string" && /^!?\/[A-Za-z0-9_./*-]{0,200}$/.test(x))) workerFirst = rwf as string[];
      else if (rwf !== undefined && rwf !== false) problems.push("assets.run_worker_first must be true, false or a list of path patterns");
      const nf = assetsIn.not_found_handling;
      if (nf !== undefined && !["none", "404-page", "single-page-application"].includes(nf as string)) problems.push("assets.not_found_handling is not supported");
      const hh = assetsIn.html_handling;
      if (hh !== undefined && !["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"].includes(hh as string)) problems.push("assets.html_handling is not supported");
      fallThrough = !!main && (nf === undefined || nf === "none");
      assets = { directory: String(dir), binding: String(binding), ...(nf ? { not_found_handling: String(nf) } : {}), ...(hh ? { html_handling: String(hh) } : {}) };
    }
  }
  if (!main && !assets) problems.push("nothing to serve: the Wrangler config has neither main nor assets");
  const vars: Record<string, string | number | boolean> = {};
  if (agent.vars !== undefined) {
    if (!agent.vars || typeof agent.vars !== "object" || Array.isArray(agent.vars)) problems.push("vars must be an object");
    else for (const [k, v] of Object.entries(agent.vars as Record<string, unknown>)) {
      if (!IDENT.test(k) || k.startsWith("CRESTMONT_")) { problems.push(`vars.${k.slice(0, 40)} is not allowed`); continue; }
      if (!["string", "number", "boolean"].includes(typeof v)) { problems.push(`vars.${k} must be a plain value`); continue; }
      vars[k] = v as string | number | boolean;
    }
  }
  const compatibilityDate = typeof agent.compatibility_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(agent.compatibility_date) ? agent.compatibility_date : "2025-09-01";
  const compatibilityFlags = Array.isArray(agent.compatibility_flags) ? agent.compatibility_flags.filter((f): f is string => typeof f === "string" && /^[a-z0-9_]{1,64}$/.test(f)) : [];
  if (problems.length) return { site: null, problems };
  return { site: { main, assets, workerFirst, fallThrough, vars, compatibilityDate, compatibilityFlags }, problems: [] };
}

/** Plan the gated preview deployment: the gate is the entry point for every request; the site's settings are kept. */
export function planGatedPreview(exportDir: string, workerName: string, key: string): { plan: GatePlan | null; problems: string[] } {
  const { site, problems } = readSiteConfig(exportDir);
  if (!site) return { plan: null, problems };
  const config: Record<string, unknown> = {
    name: workerName,
    main: GATE_FILE,
    compatibility_date: site.compatibilityDate,
    ...(site.compatibilityFlags.length ? { compatibility_flags: site.compatibilityFlags } : {}),
    workers_dev: true,
    preview_urls: false,
    ...(site.assets ? { assets: { ...site.assets, run_worker_first: true } } : {}),
    vars: { ...site.vars, CRESTMONT_PREVIEW_KEY: key },
  };
  return { plan: { config, gateSource: gateSource(workerName, site.main, site.assets?.binding ?? null, site.workerFirst, site.fallThrough) }, problems: [] };
}

/** Write the gate and the generated config into the export, replacing the agent's config. */
export function applyGatedPreview(exportDir: string, plan: GatePlan): void {
  for (const f of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) rmSync(path.join(exportDir, f), { force: true });
  writeFileSync(path.join(exportDir, GATE_FILE), plan.gateSource);
  writeFileSync(path.join(exportDir, "wrangler.json"), JSON.stringify(plan.config, null, 2) + "\n", { mode: 0o600 });
}

/** The gate Worker (plain JavaScript for the Workers runtime; Wrangler bundles it with the site's own module). */
export function gateSource(workerName: string, main: string | null, assetsBinding: string | null, workerFirst: true | string[] | false, fallThrough: boolean): string {
  const J = JSON.stringify;
  return `// Generated by the Crestmont build runner: private preview gate (Founder decision D3). Do not edit.
${main ? `import site from ${J("./" + main)};` : "const site = null;"}
const NAME = ${J(workerName)};
const ASSETS = ${J(assetsBinding)};
const WORKER_FIRST = ${J(workerFirst)};
const FALL_THROUGH = ${J(fallThrough)};
const COOKIE = "__Host-cm_prv";
const SESSION_SECONDS = ${SESSION_SECONDS};
const HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
const enc = new TextEncoder();
const b64u = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
const unb64u = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
async function sign(key, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data))));
}
function same(a, b) { if (typeof a !== "string" || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function open(key, purpose, token, now) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const i = token.indexOf(".");
  if (i < 1) return null;
  const payload = token.slice(0, i);
  if (!same(token.slice(i + 1), await sign(key, purpose + "." + payload))) return null;
  let o;
  try { o = JSON.parse(unb64u(payload)); } catch { return null; }
  if (!o || o.p !== NAME || typeof o.exp !== "number" || o.exp < now) return null;
  return o;
}
function readCookie(request) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return null;
}
function withoutGateCookie(request) {
  const headers = new Headers(request.headers);
  const rest = (request.headers.get("cookie") || "").split(";").filter((p) => p.split("=")[0].trim() !== COOKIE && p.trim()).join(";");
  if (rest) headers.set("cookie", rest); else headers.delete("cookie");
  return new Request(request, { headers });
}
function denied() {
  return new Response("This preview is private. Open it from your Crestmont dashboard or customer portal.\\n", { status: 401, headers: { "content-type": "text/plain; charset=utf-8", ...HEADERS } });
}
function harden(res) {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  return out;
}
function glob(pat, s) {
  const parts = pat.split("*");
  if (parts.length === 1) return pat === s;
  if (!s.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) { const j = s.indexOf(parts[i], pos); if (j < 0) return false; pos = j + parts[i].length; }
  const last = parts[parts.length - 1];
  return s.length - pos >= last.length && s.endsWith(last);
}
function workerFirst(pathname) {
  if (WORKER_FIRST === true) return true;
  if (!Array.isArray(WORKER_FIRST)) return false;
  let hit = false;
  for (const p of WORKER_FIRST) {
    const neg = p.startsWith("!");
    const pat = neg ? p.slice(1) : p;
    if (glob(pat, pathname)) hit = !neg;
  }
  return hit;
}
export default {
  async fetch(request, env, ctx) {
    const key = env.CRESTMONT_PREVIEW_KEY;
    if (typeof key !== "string" || key.length < 32) return denied();
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);
    if (url.pathname === "/__crestmont/auth") {
      const link = await open(key, "link", url.searchParams.get("t"), now);
      if (!link) return denied();
      const next = typeof link.n === "string" && /^\\/(?![\\/\\\\])\\S*$/.test(link.n) ? link.n : "/";
      const payload = b64u(enc.encode(JSON.stringify({ p: NAME, exp: now + SESSION_SECONDS, a: link.a === "customer" ? "customer" : "owner" })));
      const value = payload + "." + await sign(key, "session." + payload);
      return new Response(null, { status: 302, headers: { location: next, "set-cookie": COOKIE + "=" + value + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_SECONDS, ...HEADERS } });
    }
    if (url.pathname.startsWith("/__crestmont/")) return denied();
    if (!(await open(key, "session", readCookie(request), now))) return denied();
    const siteEnv = { ...env };
    delete siteEnv.CRESTMONT_PREVIEW_KEY;
    const inner = withoutGateCookie(request);
    const useSite = site && typeof site.fetch === "function";
    let res;
    if (useSite && (!ASSETS || workerFirst(url.pathname))) res = await site.fetch(inner, siteEnv, ctx);
    else if (ASSETS && env[ASSETS]) {
      res = await env[ASSETS].fetch(inner);
      if (res.status === 404 && useSite && FALL_THROUGH) res = await site.fetch(withoutGateCookie(request), siteEnv, ctx);
    } else return denied();
    return harden(res);
  },
};
`;
}
