// Native-embedding standard for every website Crestmont builds (Owner, 2026-11-18) — identical copy in each starter
// (runner/test/embedding-standard.test.ts keeps them identical and in step with the platform's src/services/native/).
//   • every page refuses framing by default (`X-Frame-Options: DENY`);
//   • the site's PUBLIC, read-only pages (its built .html files that are not sensitive) may be framed by Crestmont's
//     portfolio only: `Content-Security-Policy: frame-ancestors https://crestmontwebsitedevelopment.com
//     https://www.crestmontwebsitedevelopment.com` as an additional policy (the site's own CSP is never detached or
//     changed), with X-Frame-Options detached there — never `*`, never another site;
//   • sign-in, admin, account, booking/quote/apply, checkout, payment, token pages and the API keep refusing.
// The rules live in public/_headers (Workers static assets serve them); the block between the markers is generated
// from the built pages, so a page added later is covered on the next build. Only these framing headers are set here.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const PORTFOLIO_ORIGINS = ["https://crestmontwebsitedevelopment.com", "https://www.crestmontwebsitedevelopment.com"];
export const ALLOW = `frame-ancestors ${PORTFOLIO_ORIGINS.join(" ")}`;
export const SENSITIVE = /(^|\/)(log-?in|log-?out|sign-?in|sign-?up|sign-?out|register|auth|oauth|sso|account|accounts|my-account|portal|owner|admin|staff|dashboard|checkout|cart|billing|pay|payment|payments|subscribe|subscription|reset-password|password|token|api|book|booking|bookings|appointment|apply|application|applications|quote|quotes|reserve|reservation|reservations|invoice|invoices|order|orders|manage|confirm|confirmation|verify|unsubscribe|_next\/data|graphql|wp-admin|wp-login\.php)(\/|$|\.)/i;
export const START = "# crestmont-native-embedding:start — managed by Crestmont: public pages may be shown in Crestmont's portfolio";
export const END = "# crestmont-native-embedding:end";
const DEFAULT = ["/*", "  X-Frame-Options: DENY"].join("\n");

function htmlFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, base, out);
    else if (name.endsWith(".html")) out.push("/" + relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** URL paths of the public pages: "/index.html" → "/", "/about.html" → "/about" and "/about.html", "/x/index.html" →
 *  "/x/" and "/x". Error pages and every sensitive path are excluded. */
export function publicPages(publicDir) {
  const set = new Set();
  for (const f of htmlFiles(publicDir)) {
    if (/^\/(404|50\d)\.html$/.test(f) || SENSITIVE.test(f) || !/^\/[A-Za-z0-9/_.~-]+$/.test(f)) continue;
    if (f === "/index.html") set.add("/");
    else if (f.endsWith("/index.html")) { const d = f.slice(0, -"index.html".length); set.add(d); set.add(d.slice(0, -1)); }
    else { set.add(f); set.add(f.slice(0, -5)); }
  }
  return [...set].filter((p) => !SENSITIVE.test(p)).sort();
}

export function renderBlock(paths) {
  return [START, DEFAULT, ...paths.flatMap((p) => [p, "  ! X-Frame-Options", `  Content-Security-Policy: ${ALLOW}`]), END].join("\n");
}

/** Compares (or, with write, updates) public/_headers. Text outside the markers is kept exactly as it is. */
export function syncHeaders(publicDir, { write = false } = {}) {
  const file = join(publicDir, "_headers");
  const current = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
  const s = current.indexOf(START), e = current.indexOf(END);
  const problems = [];
  if ((s === -1) !== (e === -1) || (s !== -1 && e < s)) problems.push("public/_headers has an incomplete Crestmont block");
  const paths = publicPages(publicDir);
  const block = renderBlock(paths);
  const before = s === -1 ? current : current.slice(0, s), after = s === -1 ? "" : current.slice(e + END.length).replace(/^\n/, "");
  const head = before.replace(/\n*$/, "");
  const next = `${head ? head + "\n\n" : ""}${block}\n${after ? "\n" + after.replace(/^\n+/, "") : ""}`;
  for (const p of paths) if (SENSITIVE.test(p)) problems.push(`${p} is sensitive and must not be framable`);
  if (!paths.includes("/")) problems.push("the homepage (index.html) is missing, so nothing can be shown in the portfolio");
  // Outside the managed block: nobody may open framing more widely, and no rule may set frame-ancestors on a public page
  // (a second policy there would refuse the portfolio). Rules elsewhere (e.g. "/admin/*  frame-ancestors 'none'") stay.
  let rule = null;
  for (const line of (before + "\n" + after).split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { rule = line.trim(); continue; }
    if (!/frame-ancestors/i.test(line)) continue;
    if (!/frame-ancestors\s+'none'/i.test(line)) problems.push(`public/_headers opens framing outside Crestmont's block: "${rule}: ${line.trim()}"`);
    else if (rule && paths.some((p) => rule === p || (rule.endsWith("*") && p.startsWith(rule.slice(0, -1))))) problems.push(`public/_headers rule "${rule}" sets frame-ancestors on public page(s), which would refuse Crestmont's portfolio — scope it to the sensitive paths`);
  }
  const inSync = current === next;
  if (write && !problems.length && !inSync) writeFileSync(file, next);
  return { ok: !problems.length && (inSync || write), inSync, paths, problems, next };
}

// `node scripts/lib/embedding.mjs [public-dir] [--write]` — regenerate (with --write) or check the block.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "public";
  const r = syncHeaders(dir, { write: process.argv.includes("--write") });
  for (const p of r.problems) console.error(`embedding: ${p}`);
  if (!r.inSync && !process.argv.includes("--write")) console.error("embedding: public/_headers is out of date — run `node scripts/lib/embedding.mjs public --write`");
  console.log(`embedding: ${r.paths.length} public path(s) may be shown in Crestmont's portfolio: ${r.paths.join(" ")}`);
  process.exit(r.problems.length || (!r.inSync && !process.argv.includes("--write")) ? 1 : 0);
}
