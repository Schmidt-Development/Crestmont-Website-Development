// Owner-authorized framing permission on a client website the Owner owns and controls (Owner, 2026-11-15: "For
// websites I own and control, configure the necessary production security headers to explicitly permit framing by
// https://crestmontwebsitedevelopment.com, without broadly allowing arbitrary websites to embed them").
//
// The client site's own repository holds the change (tools/client-sites/<site>/manifest.json names the commit). This
// script brings that exact change to the site's running Cloudflare Worker WITHOUT a full redeploy: it downloads the
// Worker's current modules, applies the change, uploads content only (bindings, secrets, variables, routes and cron
// triggers are untouched) and verifies the live headers — rolling back to the downloaded modules if anything fails.
//   • When the running bundle is byte-identical to the build of the manifest's base commit (sha256), the full change
//     (headers + the site's framed-mode link handling) is applied and must produce exactly the change commit's build.
//   • Otherwise only the HEADER_RULES block is replaced, and only if the running block is exactly the expected one.
//   • Anything else: nothing is uploaded.
// Idempotent: if the live site already permits exactly the Crestmont origins, it does nothing.
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/client-site-framing.mjs tools/client-sites/lead-haven-collective
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/client-site-framing.mjs <tools/client-sites/<site>>"); process.exit(2); }
const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const API_BASE = process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4"; // overridable only for the local rehearsal
const SITE = process.env.SITE_BASE ?? m.verify.site;
const api = `${API_BASE}/accounts/${account}/workers/scripts/${encodeURIComponent(m.worker)}`;
const auth = { authorization: `Bearer ${token}` };

/** What the live site answers now: frame-ancestors on the public page, and the private pages still refusing framing. */
async function liveState() {
  const get = async (path) => {
    const r = await fetch(SITE + path, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
    await r.body?.cancel();
    const csp = r.headers.get("content-security-policy") ?? "";
    return { status: r.status, xfo: (r.headers.get("x-frame-options") ?? "").toUpperCase(), fa: (/frame-ancestors([^;,]*)/i.exec(csp)?.[1] ?? "").trim().split(/\s+/).filter(Boolean) };
  };
  const pub = await get(m.verify.publicPath);
  const priv = await Promise.all(m.verify.privatePaths.map(async (p) => ({ path: p, ...(await get(p)) })));
  const want = [...m.verify.frameAncestors].sort().join(" ");
  const publicOk = pub.status === 200 && [...pub.fa].sort().join(" ") === want && pub.xfo !== "DENY" && pub.xfo !== "SAMEORIGIN";
  const privateOk = priv.every((p) => p.xfo === "DENY" && p.fa.length === 1 && p.fa[0] === "'none'");
  return { pub, priv, publicOk, privateOk };
}
const show = (s) => `public ${m.verify.publicPath}: HTTP ${s.pub.status}, frame-ancestors [${s.pub.fa.join(" ") || "none sent"}], X-Frame-Options ${s.pub.xfo || "none"}; private: ${s.priv.map((p) => `${p.path} XFO ${p.xfo || "none"} fa [${p.fa.join(" ")}]`).join(", ")}`;

async function download() {
  for (const path of ["/content/v2", ""]) {
    const r = await fetch(api + path, { headers: auth, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) { console.log(`download ${path || "/"}: HTTP ${r.status}`); continue; }
    const type = r.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const fd = await r.formData();
      const parts = [];
      for (const [name, v] of fd.entries()) if (name !== "metadata") parts.push({ name, type: typeof v === "string" ? "text/plain" : (v.type || "application/octet-stream"), text: typeof v === "string" ? v : null, bytes: typeof v === "string" ? null : new Uint8Array(await v.arrayBuffer()) });
      return { parts, via: path || "/" };
    }
    return { parts: [{ name: m.mainModule, type: "application/javascript+module", text: await r.text(), bytes: null }], via: path || "/" };
  }
  throw new Error("could not download the running Worker's modules");
}
const textOf = (p) => p.text ?? new TextDecoder().decode(p.bytes);
const moduleType = (p) => (p.name.endsWith(".js") || p.name.endsWith(".mjs")) ? "application/javascript+module" : p.type;

async function upload(parts, mainName) {
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify({ main_module: mainName })], { type: "application/json" }));
  for (const p of parts) fd.append(p.name, new Blob([p.text ?? p.bytes], { type: moduleType(p) }), p.name);
  const r = await fetch(api + "/content", { method: "PUT", headers: auth, body: fd, signal: AbortSignal.timeout(120_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`content upload refused: HTTP ${r.status} ${(j.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ")}`);
}
async function waitFor(pred, label) {
  let s;
  for (let i = 0; i < 18; i++) { s = await liveState(); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 5000)); }
  throw Object.assign(new Error(`${label} not seen within 90 s — ${show(s)}`), { state: s });
}

const before = await liveState();
console.log(`Before: ${show(before)}`);
if (before.publicOk && before.privateOk) { console.log(`PASS ${m.verify.site} already permits framing by exactly ${m.verify.frameAncestors.join(" ")}; private pages refuse framing. Nothing changed.`); process.exit(0); }
if (!token || !account) { console.log("NOT APPLIED: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not available"); process.exit(2); }

const { parts, via } = await download();
const main = parts.find((p) => p.name === m.mainModule) ?? (parts.length === 1 ? parts[0] : null);
if (!main) { console.log(`NOT APPLIED: the running Worker has no ${m.mainModule} module (parts: ${parts.map((p) => p.name).join(", ")})`); process.exit(1); }
const current = textOf(main);
console.log(`Running Worker ${m.worker}: ${parts.length} module(s) via ${via}; ${m.mainModule} sha256 ${sha(current).slice(0, 16)}… (${current.length} chars)`);

let next, mode;
if (sha(current) === m.oldSha256) {
  const w = mkdtempSync(join(tmpdir(), "framing-"));
  writeFileSync(join(w, "index.js"), current);
  execFileSync("patch", ["--fuzz=0", "--no-backup-if-mismatch", "-s", join(w, "index.js"), join(dir, "framing.patch")], { stdio: "inherit" });
  next = readFileSync(join(w, "index.js"), "utf8");
  if (sha(next) !== m.newSha256) { console.log("NOT APPLIED: the patched bundle is not byte-identical to the change commit's build"); process.exit(1); }
  mode = `full change (byte-identical to ${m.source.repository}@${m.source.change})`;
} else if (current.split(m.oldHeaderRules).length === 2) {
  next = current.replace(m.oldHeaderRules, () => m.newHeaderRules);
  mode = "security headers only (the running bundle differs from the base build; only its HEADER_RULES block was replaced)";
} else {
  console.log("NOT APPLIED: the running Worker is neither the expected build nor carries the expected header rules — nothing was uploaded. Deploy the site from its repository instead.");
  process.exit(1);
}

const original = parts.map((p) => ({ ...p }));
const updated = parts.map((p) => (p === main ? { ...p, text: next, bytes: null } : p));
await upload(updated, main.name);
console.log(`Uploaded: ${mode}. Bindings, secrets, variables, routes and triggers were not sent and are unchanged.`);
try {
  const after = await waitFor((s) => s.publicOk && s.privateOk, "the new headers");
  console.log(`After: ${show(after)}`);
  console.log(`PASS ${m.verify.site} now permits framing by exactly ${m.verify.frameAncestors.join(" ")}; ${m.verify.privatePaths.join(", ")} still refuse all framing.`);
} catch (e) {
  console.log(`FAIL ${e.message}. Rolling back to the downloaded modules…`);
  await upload(original, main.name);
  const back = await waitFor((s) => s.pub.status === before.pub.status && s.pub.xfo === before.pub.xfo, "the original headers").catch((x) => x.state);
  console.log(`Rolled back: ${back ? show(back) : "state unknown"}`);
  process.exit(1);
}
