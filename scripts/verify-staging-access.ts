// Verifies the complete staging access sequence over real HTTP, exactly as the Founder will use it:
//   preview gate (401) → preview password → Owner email + password → current 2FA code → Owner command
//   center, with all 32 Owner modules present in the navigation and each one loading (200).
// Signs out at the end. Never prints a credential; failures name the step only.
//
// CLI: node --no-warnings scripts/verify-staging-access.ts --access access/access.json --url <url> --readme access/README.md
// On success writes the private access README (the artifact) with the verification timestamp.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { totpCode } from "../src/lib/auth-crypto.ts";
import { OWNER_MODULE_LABELS } from "../src/routes/nav.ts";
import { accessReadme, type AccessResult } from "./staging-access.ts";

export interface VerifyInput { base: string; previewPassword: string; owner: { email: string; password: string; totp: string } }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

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

  // 1. The gate is in front of the site.
  let r = await send("GET", "/");
  if (r.status !== 401) fail("preview gate", `expected 401 before the password, got ${r.status}`);
  log("1/5 preview gate is locked");

  // 2. Preview password (a propagating secret can take a few seconds to reach every edge location).
  for (let attempt = 1; ; attempt++) {
    r = await send("POST", "/__preview-access", { password: v.previewPassword, next: "/login" });
    if (r.status === 303 && jar.has("cm_preview")) break;
    if (r.status === 429) fail("preview password", "rate limited");
    if (attempt >= 6) fail("preview password", `not accepted (HTTP ${r.status})`);
    await new Promise((res) => setTimeout(res, 10_000));
  }
  log("2/5 preview password accepted");

  // 3. Owner email and password.
  r = await send("GET", "/login");
  if (r.status !== 200 || !jar.has("cm_csrf")) fail("sign-in page", `HTTP ${r.status}`);
  r = await send("POST", "/login", { _csrf: jar.get("cm_csrf")!, email: v.owner.email, password: v.owner.password });
  if (r.status !== 303 || !loc(r).startsWith("/mfa")) fail("Owner password", `expected the 2FA step, got HTTP ${r.status} → ${r.status === 303 ? loc(r) : "page"}`);
  log("3/5 Owner email and password accepted; 2FA requested");

  // 4. Current 2FA code. Wait for a fresh 30-second step if the current one is nearly over.
  if (30 - (Math.floor(Date.now() / 1000) % 30) < 5) await new Promise((res) => setTimeout(res, 6_000));
  r = await send("POST", "/mfa", { _csrf: jar.get("cm_csrf")!, code: await totpCode(v.owner.totp) });
  if (r.status !== 303 || !loc(r).startsWith("/staff")) fail("2FA code", `not accepted (HTTP ${r.status})`);
  log("4/5 2FA code accepted");

  // 5. Owner command center: all 32 modules in the navigation, each loads.
  r = await send("GET", "/staff");
  if (r.status !== 200) fail("Owner command center", `HTTP ${r.status}`);
  const links = new Map<string, string>();
  for (const m of (await r.text()).matchAll(/<a\b[^>]*class="side-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) links.set(decode(m[2].replace(/<span class="badge[\s\S]*?<\/span>/g, "")), m[1].replace(/&amp;/g, "&"));
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
  log(`5/5 all ${pages} Owner modules load`);

  await send("POST", "/logout", { _csrf: jar.get("cm_csrf")! });
  return { modules: OWNER_MODULE_LABELS.length, pages };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const access = JSON.parse(readFileSync(arg("--access") ?? "access/access.json", "utf8")) as AccessResult;
  const url = arg("--url")!;
  const owner = access.accounts.find((a) => a.role === "owner")!;
  try {
    const res = await verifyStagingAccess({ base: url, previewPassword: access.previewPassword, owner: { email: owner.email, password: owner.password, totp: owner.totp! } }, fetch, console.log);
    const readme = arg("--readme");
    if (readme) writeFileSync(readme, accessReadme(url, access, new Date().toISOString()), { mode: 0o600 });
    console.log(`Verified: ${res.pages}/${res.modules} Owner modules reachable through the full access sequence.`);
  } catch (e) {
    console.error(`::error::Staging access verification failed at ${String((e as Error).message).slice(0, 300)}`);
    process.exit(1);
  }
}
