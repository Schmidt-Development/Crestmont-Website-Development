// Verifies the complete staging access sequence over real HTTP, exactly as the Founder will use it, on the PUBLIC
// staging site (no preview password since 2026-10-28):
//   public homepage loads with no cookies → staff and portal areas refuse anonymous visitors → Owner email + password
//   → the staff area is still refused before 2FA → current 2FA code → Owner command center, with all 32 Owner modules
//   present in the navigation and each one loading (200).
// Signs out at the end. Never prints a credential; failures name the step only.
//
// CLI: node --no-warnings scripts/verify-staging-access.ts --access access/access.json --url <url> --readme access/README.md
// On success writes the private access README (the artifact) with the verification timestamp.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { totpCode } from "../src/lib/auth-crypto.ts";
import { OWNER_MODULE_LABELS } from "../src/routes/nav.ts";
import { accessReadme, type AccessResult } from "./staging-access.ts";

export interface VerifyInput { base: string; owner: { email: string; password: string; totp: string } }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A request with no cookies at all (a fresh visitor). */
async function fetchAnonymous(f: Fetch, base: string, path: string): Promise<Response> {
  const r = await f(base + path, { method: "GET", headers: { "user-agent": "crestmont-staging-verifier" }, redirect: "manual" });
  await r.arrayBuffer();
  return r;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/**
 * Decodes HTML character references in ONE pass (the platform's escapeHtml emits &amp; &lt; &gt; &quot; &#39; &#96;).
 * Each reference is replaced exactly once and the output is never rescanned, so "&amp;#39;" stays the text "&#39;".
 * Invalid code points become U+FFFD; unknown or malformed references are left as written.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z]{2,8}));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\uFFFD";
  });
}
/** Visible text of an HTML fragment: tags removed first, then entities decoded once, whitespace collapsed. */
export const decode = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

export async function verifyStagingAccess(v: VerifyInput, f: Fetch = fetch, log: (s: string) => void = () => {}): Promise<{ modules: number; pages: number }> {
  const base = v.base.replace(/\/$/, "");
  const jar = new Map<string, string>();
  const send = async (method: string, path: string, form?: Record<string, string>) => {
    const headers: Record<string, string> = { "user-agent": "crestmont-staging-verifier" };
    if (jar.size) headers.cookie = [...jar].map(([k, val]) => `${k}=${encodeURIComponent(val)}`).join("; ");
    let body: string | undefined;
    if (form) { body = new URLSearchParams(form).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; headers.origin = new URL(base).origin; }
    const res = await f(base + path, { method, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(name); else jar.set(name, decodeURIComponent(pair.slice(i + 1).trim()));
    }
    return res;
  };
  const fail = (step: string, detail: string) => { throw new Error(`${step}: ${detail}`); };
  const loc = (r: Response) => new URL(r.headers.get("location") ?? "/", base).pathname;

  // 1. The public site loads directly: no preview gate, no cookie needed.
  let r = await send("GET", "/");
  const home = await r.text();
  if (r.status !== 200) fail("public homepage", `expected 200 with no cookies, got ${r.status}`);
  if (home.includes('action="/__preview-access"')) fail("public homepage", "the preview password page is still shown");
  log("1/6 public homepage loads with no cookies or credentials");

  // 2. Protected areas refuse anonymous visitors (redirect to sign-in or refuse; never 200).
  for (const path of ["/staff", "/portal", "/account"]) {
    const a = await fetchAnonymous(f, base, path);
    if (a.status === 200) fail("anonymous access", `${path} returned 200 without a session`);
    const toLogin = a.status === 303 && new URL(a.headers.get("location") ?? "/", base).pathname === "/login";
    if (!toLogin && a.status !== 401 && a.status !== 403) fail("anonymous access", `${path} should redirect to sign-in, got HTTP ${a.status}`);
  }
  log("2/6 staff, portal and account areas refuse anonymous visitors");

  // 3. Owner email and password.
  r = await send("GET", "/login");
  // Over HTTPS the CSRF cookie is __Host-cm_csrf (CREST-GAP-086); plain HTTP keeps cm_csrf.
  const csrfToken = () => jar.get("__Host-cm_csrf") ?? jar.get("cm_csrf");
  if (r.status !== 200 || !csrfToken()) fail("sign-in page", `HTTP ${r.status}`);
  await r.arrayBuffer();
  r = await send("POST", "/login", { _csrf: csrfToken()!, email: v.owner.email, password: v.owner.password });
  if (r.status !== 303 || !loc(r).startsWith("/mfa")) fail("Owner password", `expected the 2FA step, got HTTP ${r.status} → ${r.status === 303 ? loc(r) : "page"}`);
  log("3/6 Owner email and password accepted; 2FA requested");

  // 3b. Mandatory MFA: a password-only session must not reach the staff area.
  { const pre = await send("GET", "/staff"); await pre.arrayBuffer(); if (pre.status === 200) fail("Owner MFA", "the staff area opened before the 2FA code"); }
  log("4/6 staff area still refused before 2FA");

  // 4. Current 2FA code. Wait for a fresh 30-second step if the current one is nearly over.
  if (30 - (Math.floor(Date.now() / 1000) % 30) < 5) await new Promise((res) => setTimeout(res, 6_000));
  r = await send("POST", "/mfa", { _csrf: csrfToken()!, code: await totpCode(v.owner.totp) });
  if (r.status !== 303 || !loc(r).startsWith("/staff")) fail("2FA code", `not accepted (HTTP ${r.status})`);
  log("5/6 2FA code accepted");

  // 5. Owner command center: all 32 modules in the navigation, each loads.
  r = await send("GET", "/staff");
  if (r.status !== 200) fail("Owner command center", `HTTP ${r.status}`);
  const links = new Map<string, string>();
  for (const m of (await r.text()).matchAll(/<a\b[^>]*class="side-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) links.set(decode(m[2].replace(/<span class="badge[\s\S]*?<\/span>/g, "")), decodeEntities(m[1]));
  const missing = OWNER_MODULE_LABELS.filter((l) => !links.has(l));
  if (missing.length) fail("Owner navigation", `missing modules: ${missing.join(", ")}`);
  let pages = 0;
  const broken: string[] = [];
  for (const label of OWNER_MODULE_LABELS) {
    const p = await send("GET", links.get(label)!);
    if (p.status !== 200) broken.push(`${label} (${p.status}${p.status === 303 ? " → " + loc(p) : ""})`); else pages++;
    await p.arrayBuffer();
  }
  if (broken.length) fail("Owner modules", broken.join(", "));
  log(`6/6 all ${pages} Owner modules load`);

  await send("POST", "/logout", { _csrf: csrfToken()! });
  return { modules: OWNER_MODULE_LABELS.length, pages };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const access = JSON.parse(readFileSync(arg("--access") ?? "access/access.json", "utf8")) as AccessResult;
  const url = arg("--url")!;
  const owner = access.accounts.find((a) => a.role === "owner")!;
  try {
    const res = await verifyStagingAccess({ base: url, owner: { email: owner.email, password: owner.password, totp: owner.totp! } }, fetch, console.log);
    const readme = arg("--readme");
    if (readme) writeFileSync(readme, accessReadme(url, access, new Date().toISOString()), { mode: 0o600 });
    console.log(`Verified: ${res.pages}/${res.modules} Owner modules reachable through the full access sequence (public site, MFA enforced).`);
  } catch (e) {
    console.error(`::error::Staging access verification failed at ${String((e as Error).message).slice(0, 300)}`);
    process.exit(1);
  }
}
