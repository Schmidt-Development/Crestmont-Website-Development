// Cross-file contract checks (Founder directive 2026-11-02, Part 3.1/3.2; failure modes B01, B02, B07, B11).
//
// These are regression tests for defects that REALLY SHIPPED. Both confirmed quote-form failures passed every other
// gate: the HTML parsed, the JavaScript parsed, the Worker parsed, every page rendered, every link resolved, and the
// acceptance suite reported 44/44. The fixtures below reproduce each defect exactly, so if the check ever stops
// catching them the tests fail rather than the next customer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { contractCheck, contractFindings } from "../src/contracts-check.ts";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "contract-"));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  return root;
}

/** A correct small site: ids match, field names match, the posted path is served. */
const GOOD = {
  "public/index.html": `<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1></body></html>`,
  "public/contact.html": `<!doctype html><html lang="en"><head><title>Contact</title></head><body>
    <form id="quote-form" action="/api/contact" method="post">
      <label for="q-name">Name</label><input id="q-name" name="name">
      <label for="q-email">Email</label><input id="q-email" name="email">
      <label for="q-message">What needs removing?</label><textarea id="q-message" name="message"></textarea>
      <button type="submit">Send</button>
    </form><script src="/assets/contact.js"></script></body></html>`,
  "public/assets/contact.js": `
    var form = document.getElementById('quote-form');
    function validate() {
      var name = document.getElementById('q-name').value.trim();
      var email = document.getElementById('q-email').value.trim();
      var message = document.getElementById('q-message').value.trim();
      return name && email && message;
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validate()) return;
      fetch('/api/contact', { method: 'POST', body: new FormData(form) });
    });`,
  "src/worker.js": `
    function validateQuote(body) {
      const errors = {};
      if (!body.name) errors.name = 'required';
      if (!body.email) errors.email = 'required';
      if (!body.message) errors.message = 'required';
      return errors;
    }
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/api/contact' && request.method === 'POST') return handleContact(request, env);
      return env.ASSETS.fetch(request);
    } };`,
};

test("[CONTRACT] a site whose files agree passes, so a correct build is never blocked", () => {
  const r = contractCheck(project(GOOD));
  assert.ok(r, "a project with pages produces an outcome");
  assert.equal(r!.ok, true, r!.outputTail);
  assert.equal(r!.id, "contract-check");
  assert.match(r!.outputTail, /agree on element ids/);
});

test("[CONTRACT] B01: the run 1 defect — a script reads an element id no page defines", () => {
  // Exactly what shipped: validate() read q-items; the textarea was q-message. Every submit threw a TypeError,
  // nothing reached the server, and the visitor saw neither an error nor a confirmation.
  const broken = { ...GOOD, "public/assets/contact.js": GOOD["public/assets/contact.js"].replace("getElementById('q-message')", "getElementById('q-items')") };
  const r = contractCheck(project(broken))!;
  assert.equal(r.ok, false);
  assert.match(r.outputTail, /q-items/);
  assert.match(r.outputTail, /no page defines/);
  assert.match(r.outputTail, /throws/, "the message says why it matters, not just that ids differ");
});

test("[CONTRACT] B02: the other half of run 1 — the server requires a field the form never sends", () => {
  const broken = { ...GOOD, "src/worker.js": GOOD["src/worker.js"].replace("if (!body.message)", "if (!body.items)") };
  const r = contractCheck(project(broken))!;
  assert.equal(r.ok, false);
  assert.match(r.outputTail, /requires a submitted field "items"/);
  assert.match(r.outputTail, /name, email, message/, "it lists what the form actually sends");
  assert.match(r.outputTail, /rejected/);
});

test("[CONTRACT] B11: the run 2 defect — the script posts to a path no route serves", () => {
  const broken = { ...GOOD, "public/assets/contact.js": GOOD["public/assets/contact.js"].replace("fetch('/api/contact'", "fetch('/api/quote'") };
  const r = contractCheck(project(broken))!;
  assert.equal(r.ok, false);
  assert.match(r.outputTail, /\/api\/quote/);
  assert.match(r.outputTail, /no server route handles/);
  assert.match(r.outputTail, /\/api\/contact/, "it names the routes that ARE served, so the fix is obvious");
});

test("[CONTRACT] a form action pointing at an unserved endpoint is caught too", () => {
  const broken = { ...GOOD, "public/contact.html": GOOD["public/contact.html"].replace('action="/api/contact"', 'action="/api/send"') };
  const r = contractCheck(project(broken))!;
  assert.equal(r.ok, false);
  assert.match(r.outputTail, /action="\/api\/send"/);
});

test("[CONTRACT] all three confirmed defects at once are each reported, not just the first", () => {
  const broken = {
    ...GOOD,
    "public/assets/contact.js": GOOD["public/assets/contact.js"].replace("getElementById('q-message')", "getElementById('q-items')").replace("fetch('/api/contact'", "fetch('/api/quote'"),
    "src/worker.js": GOOD["src/worker.js"].replace("if (!body.message)", "if (!body.items)"),
  };
  const findings = contractFindings(project(broken));
  assert.equal(findings.length, 3, `three distinct problems: ${JSON.stringify(findings.map((f) => f.message.slice(0, 60)))}`);
  assert.ok(findings.some((f) => /q-items/.test(f.message)));
  assert.ok(findings.some((f) => /\/api\/quote/.test(f.message)));
  assert.ok(findings.some((f) => /"items"/.test(f.message)));
});

// ── the check must stay quiet where it cannot be certain ───────────────────────────────────────────────────────────

test("[CONTRACT] an id defined on ANOTHER page is not a defect: scripts are shared across pages", () => {
  const multi = {
    ...GOOD,
    "public/about.html": `<!doctype html><html lang="en"><head><title>About</title></head><body><div id="team-grid"></div></body></html>`,
    "public/assets/contact.js": `${GOOD["public/assets/contact.js"]}\nvar t = document.getElementById('team-grid');`,
  };
  assert.equal(contractCheck(project(multi))!.ok, true, "an id on about.html is a real element, even if contact.html lacks it");
});

test("[CONTRACT] runtime-built ids, routes and fields are not guessed at", () => {
  const dynamic = {
    ...GOOD,
    "public/assets/contact.js": `${GOOD["public/assets/contact.js"]}
      var n = 3;
      document.getElementById('row-' + n);
      document.querySelector('#' + key);
      fetch('/api/' + kind, { method: 'POST' });
      fetch(form.action, { method: 'POST' });`,
  };
  assert.equal(contractCheck(project(dynamic))!.ok, true, "a false failure that blocks a correct build is worse than a miss");
});

// The fullstack-v1 starter -- the one every Business and Premium build uses -- serves its API from a TABLE of regex
// routes and calls it through a wrapper, not fetch(). Neither was recognised, so the endpoint half of this check went
// SILENT on exactly the projects that need it most: nothing was requested, nothing was served, nothing compared.
test("[CONTRACT] a regex route table counts as serving its paths", () => {
  const table = {
    ...GOOD,
    "src/worker.js": `const ROUTES = [
      ["POST", /^\\/api\\/contact$/, (env, req) => handleContact(env, req)],
      ["GET", /^\\/api\\/bookings\\/(BK-[A-Z0-9]{8})$/, (env, req) => getBooking(env, req)],
    ];
    export default { fetch: (request, env) => handle(request, env) };`,
    "public/assets/contact.js": `const api = (p, o) => fetch(p, o);
      api("/api/contact", { method: "POST", body: JSON.stringify({ name: "a", email: "b", message: "c" }) });`,
  };
  assert.equal(contractCheck(project(table))!.ok, true, "the route regex serves /api/contact, so the wrapped request is fine");
});

test("[CONTRACT] a wrapped request to a path NO route serves is still caught", () => {
  const broken = {
    ...GOOD,
    "src/worker.js": `const ROUTES = [["POST", /^\\/api\\/contact$/, (env, req) => handleContact(env, req)]];
    export default { fetch: (request, env) => handle(request, env) };`,
    "public/assets/contact.js": `const api = (p, o) => fetch(p, o);
      api("/api/quote", { method: "POST" });`,
  };
  const out = contractCheck(project(broken));
  assert.equal(out!.ok, false, "/api/quote is served by no route and the call is wrapped, not a bare fetch()");
  assert.match(contractFindings(project(broken)).map((f) => f.message).join(" "), /\/api\/quote/);
});

test("[CONTRACT] comments never produce phantom findings", () => {
  const commented = {
    ...GOOD,
    "public/assets/contact.js": `// getElementById('q-nonexistent') was the old name
      /* fetch('/api/removed') is gone */
      ${GOOD["public/assets/contact.js"]}`,
  };
  assert.equal(contractCheck(project(commented))!.ok, true);
});

test("[CONTRACT] a project with no pages is not judged", () => {
  assert.equal(contractCheck(project({ "src/worker.js": "export default {};" })), null);
  assert.equal(contractCheck(project({})), null);
});

test("[CONTRACT] with no server in the project, endpoint paths are not guessed", () => {
  const noServer = { "public/index.html": GOOD["public/index.html"], "public/contact.html": GOOD["public/contact.html"], "public/assets/contact.js": GOOD["public/assets/contact.js"] };
  assert.equal(contractCheck(project(noServer))!.ok, true, "nothing is known about routes, so nothing is claimed about them");
});

test("[CONTRACT] a startsWith branch that answers 404 is a rejection, not a route that serves everything under it", () => {
  // Run 2's Worker: `if (pathname === "/api/contact") ... ; if (pathname.startsWith("/api/")) return 404`.
  // Reading that prefix as "serves /api/*" hid the real /api/quote defect, which is worse than a false positive.
  const withCatchAll = {
    ...GOOD,
    "public/assets/contact.js": GOOD["public/assets/contact.js"].replace("fetch('/api/contact'", "fetch('/api/quote'"),
    "src/worker.js": `export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/api/contact") return handleContact(request, env);
      if (url.pathname.startsWith("/api/")) return json(404, { ok: false, error: "Not found" });
      return env.ASSETS.fetch(request);
    } };`,
  };
  const r = contractCheck(project(withCatchAll))!;
  assert.equal(r.ok, false, "the 404 catch-all must not make an unserved endpoint look served");
  assert.match(r.outputTail, /\/api\/quote/);
  assert.match(r.outputTail, /Served routes are: \/api\/contact/, "and the catch-all is not listed as a served route");
});

test("[CONTRACT] a genuine serving prefix still counts as serving", () => {
  const prefixRouter = {
    ...GOOD,
    // The form action moves with the script: leaving it on the old endpoint would be a real defect, and the check
    // would be right to flag it.
    "public/contact.html": GOOD["public/contact.html"].replace('action="/api/contact"', 'action="/api/forms/quote"'),
    "public/assets/contact.js": GOOD["public/assets/contact.js"].replace("fetch('/api/contact'", "fetch('/api/forms/quote'"),
    "src/worker.js": `export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/forms/")) return handleForm(request, env);
      return env.ASSETS.fetch(request);
    } };`,
  };
  assert.equal(contractCheck(project(prefixRouter))!.ok, true, "a prefix that dispatches real work serves the paths beneath it");
});
