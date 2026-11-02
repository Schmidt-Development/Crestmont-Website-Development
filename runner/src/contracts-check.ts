// Cross-file contract checks (Founder directive, 2026-11-02, Part 3.1/3.2, failure modes B01, B02, B07, B11).
//
// Both confirmed quote-form failures were the same mistake in different places: the generated files each looked
// correct on their own and disagreed with each other about a name.
//
//   Run 1 (bld_d6090c28f8e6923c75223307): contact.js validated getElementById("q-items"); the textarea was
//     id="q-message". Every submit threw a TypeError, so nothing reached the server and the visitor saw nothing.
//     Separately the Worker read body.items while the form posted `message`, so real submissions got 422.
//   Run 2 (bld_e6dc3027869629b9fcab79a9): the HTML action and the Worker route both said /api/contact, but the
//     JavaScript posted to /api/quote, which no route served, so every submission 404'd.
//
// Nothing caught either one: the HTML parsed, the JS parsed, the Worker parsed, every page rendered and every link
// resolved. These are consistency facts between files, which is exactly what a static check can decide with
// certainty -- no browser, no model, no GPU, no guesswork. Deterministic checks are preferred to more AI here.
//
// Deliberately conservative: it reports only what it can prove from the source. An id built at runtime, a route
// assembled from variables or a field read dynamically is not flagged, because a false failure that blocks a correct
// build is worse than a miss. The browser-level form submission check in sandbox/browser-check.mjs covers what this
// cannot see.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CheckOutcome } from "./checks.ts";

export interface ContractFinding { severity: "error" | "warn"; file: string; message: string }

/** Every file under `dir` matching `test`, at most `max`, skipping node_modules and dot directories. */
function filesUnder(dir: string, test: RegExp, max = 400, depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= max) break;
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, test, max - out.length, depth + 1));
    else if (e.isFile() && test.test(e.name)) { try { if (statSync(p).size < 2_000_000) out.push(p); } catch { /* vanished */ } }
  }
  return out;
}

const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
/** Strip comments and string-ish noise that would otherwise produce phantom matches. */
const stripComments = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/** Element ids defined in the HTML (id="x"). */
function htmlIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const m of html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) ids.add(m[1]);
  return ids;
}

/** `name="x"` on form controls, which is what a backend receives. */
function formFieldNames(html: string): Set<string> {
  const names = new Set<string>();
  for (const m of html.matchAll(/<(?:input|select|textarea)\b[^>]*\sname\s*=\s*["']([^"']+)["'][^>]*>/gi)) names.add(m[1]);
  return names;
}

/** Literal `getElementById("x")` / `querySelector("#x")` lookups a script performs. */
function referencedIds(js: string): { id: string; how: string }[] {
  const out: { id: string; how: string }[] = [];
  for (const m of js.matchAll(/getElementById\(\s*["'`]([A-Za-z0-9_:.\-]+)["'`]\s*\)/g)) out.push({ id: m[1], how: `getElementById("${m[1]}")` });
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*["'`]#([A-Za-z0-9_:.\-]+)["'`]\s*\)/g)) out.push({ id: m[1], how: `querySelector("#${m[1]}")` });
  return out;
}

/**
 * Same-origin paths a script fetches. Only a COMPLETE literal argument counts: the trailing `[,)]` is what keeps
 * `fetch("/api/" + kind)` out, where the literal is just a prefix of a path assembled at runtime and nothing can be
 * concluded about the route.
 */
function requestedPaths(js: string): { p: string; how: string }[] {
  const out: { p: string; how: string }[] = [];
  for (const m of js.matchAll(/fetch\(\s*["'`](\/[A-Za-z0-9_\-/.]*)["'`]\s*[,)]/g)) out.push({ p: m[1], how: `fetch("${m[1]}")` });
  // fetch(form.action) and friends are resolved at runtime; they are not flagged here.
  return out;
}

/**
 * Routes a server serves: exact path comparisons, and PREFIXES from `startsWith`, which serve everything beneath
 * them. Keeping the two apart matters -- treating a prefix as an exact route would report a served path as missing.
 */
function servedPaths(serverJs: string): { exact: Set<string>; prefixes: Set<string> } {
  const exact = new Set<string>(), prefixes = new Set<string>();
  for (const m of serverJs.matchAll(/pathname\s*===?\s*["'`](\/[A-Za-z0-9_\-/.]*)["'`]/g)) exact.add(m[1]);
  for (const m of serverJs.matchAll(/pathname\.startsWith\(\s*["'`](\/[A-Za-z0-9_\-/.]*)["'`]/g)) {
    // A `startsWith` branch that answers 404 is a REJECTION catch-all, not a route that serves anything beneath it.
    // Run 2's Worker had exactly this (`if (pathname.startsWith("/api/")) return json(404, ...)`) and reading it as a
    // serving prefix made the real /api/quote defect invisible -- worse than the false positive it was meant to stop.
    const tail = serverJs.slice(m.index ?? 0, (m.index ?? 0) + 160);
    if (/404|not\s*found/i.test(tail)) continue;
    prefixes.add(m[1]);
  }
  for (const m of serverJs.matchAll(/(?:router|app)\.(?:post|get|all|put)\(\s*["'`](\/[A-Za-z0-9_\-/.]*)["'`]/gi)) exact.add(m[1]);
  return { exact, prefixes };
}

/** Fields the server reads out of a submitted body: body.get("x"), data.x after a formData loop, etc. */
function serverReadFields(serverJs: string): Set<string> {
  const names = new Set<string>();
  for (const m of serverJs.matchAll(/\.get\(\s*["'`]([A-Za-z0-9_\-]+)["'`]\s*\)/g)) names.add(m[1]);
  // `body.items`, `data.email` -- only for identifiers that look like a submitted payload.
  for (const m of serverJs.matchAll(/\b(?:body|data|fields|form|payload|input)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) names.add(m[1]);
  return names;
}

/**
 * Compare what the generated files assume about each other.
 *
 * `repo` is the project root: static pages under public/, scripts under public/, and the server under src/ or
 * worker.js. Returns findings, empty when everything lines up.
 */
export function contractFindings(repo: string): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const pub = path.join(repo, "public");
  if (!existsSync(pub)) return findings;

  const htmlFiles = filesUnder(pub, /\.html$/i);
  if (!htmlFiles.length) return findings;
  const scripts = filesUnder(pub, /\.m?js$/i);
  const serverFiles = [...filesUnder(path.join(repo, "src"), /\.m?js$|\.ts$/i), ...["worker.js", "worker.mjs", "index.js"].map((f) => path.join(repo, f)).filter(existsSync)];

  // Ids and field names defined anywhere in the site's HTML. A script is usually shared across pages, so the union
  // is the right comparison: flagging an id that exists on another page would be a false failure.
  const allIds = new Set<string>();
  const allFieldNames = new Set<string>();
  const actions = new Set<string>();
  for (const f of htmlFiles) {
    const html = read(f);
    for (const id of htmlIds(html)) allIds.add(id);
    for (const n of formFieldNames(html)) allFieldNames.add(n);
    for (const m of html.matchAll(/<form\b[^>]*\saction\s*=\s*["'](\/[^"']*)["']/gi)) actions.add(m[1].split("?")[0]);
  }

  // B01: a script reads an element id the HTML never defines. This is the run 1 defect exactly.
  for (const f of scripts) {
    const js = stripComments(read(f));
    const rel = path.relative(repo, f).split(path.sep).join("/");
    const seen = new Set<string>();
    for (const r of referencedIds(js)) {
      if (seen.has(r.id) || allIds.has(r.id)) continue;
      seen.add(r.id);
      findings.push({
        severity: "error", file: rel,
        message: `${r.how} refers to an element id that no page defines. The lookup returns null, so the first use of it throws and everything after it in that handler never runs.`,
      });
    }
  }

  // B11: a script posts to a path the server does not serve. This is the run 2 defect exactly.
  const served = new Set<string>();
  const servedPrefixes = new Set<string>();
  for (const f of serverFiles) {
    const s = servedPaths(stripComments(read(f)));
    for (const p of s.exact) served.add(p);
    for (const p of s.prefixes) servedPrefixes.add(p);
  }
  const isServed = (p: string) => served.has(p) || [...servedPrefixes].some((pre) => p.startsWith(pre));
  if (served.size || servedPrefixes.size) {
    for (const f of scripts) {
      const js = stripComments(read(f));
      const rel = path.relative(repo, f).split(path.sep).join("/");
      for (const r of requestedPaths(js)) {
        if (!r.p.startsWith("/api/")) continue;           // only the application's own endpoints
        if (isServed(r.p)) continue;
        findings.push({
          severity: "error", file: rel,
          message: `${r.how} but no server route handles ${r.p}. Served routes are: ${[...served].join(", ") || "(none found)"}. Every submission would get a 404.`,
        });
      }
    }
    for (const a of actions) {
      if (!a.startsWith("/api/") || isServed(a)) continue;
      findings.push({ severity: "error", file: "public/", message: `a form posts to action="${a}" but no server route handles it. Served routes are: ${[...served].join(", ")}.` });
    }
  }

  // B02: the server requires a field the form never sends. This is the other half of the run 1 defect.
  if (serverFiles.length && allFieldNames.size) {
    const serverFields = new Set<string>();
    for (const f of serverFiles) for (const n of serverReadFields(stripComments(read(f)))) serverFields.add(n);
    // Only fields the server treats as REQUIRED are worth failing on: an optional read of a missing field is fine.
    const requiredByServer = new Set<string>();
    for (const f of serverFiles) {
      const js = stripComments(read(f));
      for (const m of js.matchAll(/if\s*\(\s*!\s*(?:body|data|fields|form|payload|input)\.([A-Za-z_][A-Za-z0-9_]*)/g)) requiredByServer.add(m[1]);
      for (const m of js.matchAll(/if\s*\(\s*!\s*\w+\.get\(\s*["'`]([A-Za-z0-9_\-]+)["'`]\s*\)/g)) requiredByServer.add(m[1]);
    }
    const ignore = new Set(["length", "ok", "status", "json", "text", "method", "url", "headers", "entries", "keys", "values", "get", "has", "errors", "message$"]);
    for (const field of requiredByServer) {
      if (ignore.has(field) || allFieldNames.has(field)) continue;
      findings.push({
        severity: "error", file: "src/",
        message: `the server requires a submitted field "${field}", but no form control is named "${field}". Form controls are named: ${[...allFieldNames].slice(0, 20).join(", ")}. Every real submission would be rejected.`,
      });
    }
    void serverFields;
  }

  return findings;
}

/**
 * The acceptance check. `null` when the project has no static pages (nothing to compare), otherwise a pass/fail
 * outcome in the same shape as the other runner checks.
 */
export function contractCheck(repo: string): CheckOutcome | null {
  const pub = path.join(repo, "public");
  if (!existsSync(pub) || !filesUnder(pub, /\.html$/i).length) return null;
  const findings = contractFindings(repo);
  const errors = findings.filter((f) => f.severity === "error");
  const tail = errors.length
    ? errors.map((f) => `ERROR ${f.file}: ${f.message}`).join("\n")
    : "the scripts, the pages and the server agree on element ids, form field names and endpoint paths";
  return {
    id: "contract-check",
    label: "runner: cross-file contracts (element ids, form fields, endpoint paths)",
    command: "runner: contract check",
    ok: errors.length === 0,
    code: errors.length === 0 ? 0 : 1,
    timedOut: false,
    outputTail: tail.slice(0, 4000),
  };
}
