// Systematic defect injection (Founder directive 2026-11-02, Part 3.7; failure modes D27, D28, B30).
//
// The complaint this answers is specific and was true: build bld_d6090c28f8e6923c75223307 reported
// "static-check=PASS browser-check=PASS brief-conformance=PASS sandbox-isolation=PASS" and "44/44 requirements
// verified" while its quote form could not be submitted at all. Acceptance passing meant nothing.
//
// So acceptance is tested the way a customer's site is: take a KNOWN-GOOD project, break one critical thing, and
// require the suite to reject it. A gate that cannot fail a broken build is not a gate, and asserting "we added
// validation" is not evidence that it rejects anything.
//
// Each case names the real defect it reproduces. The deterministic checks run here; the browser-level ones
// (form submission, desktop navigation) need Chromium and are exercised by browser-check.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { contractCheck } from "../src/contracts-check.ts";
import { persistenceCheck } from "../src/persistence-check.ts";

const RUNNER_DIR = path.resolve(import.meta.dirname, "..");

/** A known-good project: the real brochure starter plus a server that genuinely stores a submission. */
function goodProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "inject-"));
  const starter = path.join(RUNNER_DIR, "starters", "brochure-v1");
  cpSync(starter, root, { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "worker.js"), `
    async function handleContact(request, env) {
      const body = await request.formData();
      const data = {};
      for (const [k, v] of body.entries()) data[k] = String(v).trim();
      if (!data.name) return json(422, { ok: false, errors: { name: 'required' } });
      if (!data.email) return json(422, { ok: false, errors: { email: 'required' } });
      // A real durable write: the record can be retrieved afterwards.
      await env.DB.prepare('INSERT INTO enquiries (name, email, message, at) VALUES (?,?,?,?)')
        .bind(data.name, data.email, data.message ?? '', new Date().toISOString()).run();
      return json(200, { ok: true, saved: true });
    }
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/api/contact' && request.method === 'POST') return handleContact(request, env);
      return env.ASSETS.fetch(request);
    } };`);
  return root;
}

/** Run every deterministic acceptance check this suite covers; returns the ones that failed. */
function acceptance(repo: string): { id: string; detail: string }[] {
  const failed: { id: string; detail: string }[] = [];
  for (const c of [contractCheck(repo), persistenceCheck(repo)]) {
    if (c && !c.ok) failed.push({ id: c.id, detail: c.outputTail });
  }
  return failed;
}

const edit = (repo: string, rel: string, fn: (s: string) => string) => {
  const f = path.join(repo, rel);
  assert.ok(existsSync(f), `fixture has ${rel}`);
  writeFileSync(f, fn(readFileSync(f, "utf8")));
};

test("[INJECT] the control: an unbroken project passes every gate", () => {
  // Without this the suite below proves nothing: a check that fails everything would "pass" all the injections.
  const repo = goodProject();
  assert.deepEqual(acceptance(repo), [], "a correct project is not rejected");
});

test("[INJECT] B01 — a script reads an element id the HTML does not define", () => {
  const repo = goodProject();
  const js = path.join("public", "assets", "js", "contact.js");
  const target = existsSync(path.join(repo, js)) ? js : null;
  if (!target) {
    // The starter keeps its script elsewhere; write the defect into a script of our own so the case still runs.
    mkdirSync(path.join(repo, "public", "assets"), { recursive: true });
    writeFileSync(path.join(repo, "public", "assets", "injected.js"), `document.getElementById('field-that-does-not-exist').value;`);
  } else {
    edit(repo, target, (s) => `${s}\ndocument.getElementById('field-that-does-not-exist').value;`);
  }
  const failed = acceptance(repo);
  assert.ok(failed.some((f) => f.id === "contract-check"), `acceptance rejected it: ${JSON.stringify(failed.map((f) => f.id))}`);
  assert.match(failed.find((f) => f.id === "contract-check")!.detail, /field-that-does-not-exist/);
});

test("[INJECT] B02 — the server requires a field the form never sends", () => {
  const repo = goodProject();
  edit(repo, path.join("src", "worker.js"), (s) => s.replace("if (!data.name)", "if (!data.items_nobody_sends)"));
  const failed = acceptance(repo);
  assert.ok(failed.some((f) => f.id === "contract-check"), `acceptance rejected it: ${JSON.stringify(failed.map((f) => f.id))}`);
  assert.match(failed.find((f) => f.id === "contract-check")!.detail, /items_nobody_sends/);
});

test("[INJECT] B11 — the client posts to an endpoint no route serves", () => {
  const repo = goodProject();
  mkdirSync(path.join(repo, "public", "assets"), { recursive: true });
  writeFileSync(path.join(repo, "public", "assets", "injected.js"), `fetch('/api/endpoint-that-does-not-exist', { method: 'POST' });`);
  const failed = acceptance(repo);
  assert.ok(failed.some((f) => f.id === "contract-check"));
  assert.match(failed.find((f) => f.id === "contract-check")!.detail, /endpoint-that-does-not-exist/);
});

test("[INJECT] B15 — the server claims a save it never performed", () => {
  // The exact shipped defect: replace the durable write with a log line and keep the success claim.
  const repo = goodProject();
  edit(repo, path.join("src", "worker.js"), (s) => s.replace(
    /await env\.DB\.prepare[\s\S]*?\.run\(\);/,
    "console.log('[quote] ' + JSON.stringify(data));"));
  const failed = acceptance(repo);
  assert.ok(failed.some((f) => f.id === "persistence-check"), `acceptance rejected it: ${JSON.stringify(failed.map((f) => f.id))}`);
  const detail = failed.find((f) => f.id === "persistence-check")!.detail;
  assert.match(detail, /saved: true/);
  assert.match(detail, /console log/, "and it names why the claim is false");
});

test("[INJECT] an honest backend is NOT rejected: refusing to claim a save is correct behaviour", () => {
  // Run 2's Worker answered {ok:false, configured:false}. That is the right thing to do with no store configured,
  // and a check that punished it would push the builder towards lying instead.
  const repo = goodProject();
  edit(repo, path.join("src", "worker.js"), (s) => s
    .replace(/await env\.DB\.prepare[\s\S]*?\.run\(\);/, "")
    .replace("{ ok: true, saved: true }", "{ ok: false, configured: false, error: 'The contact form is not connected yet.' }"));
  assert.deepEqual(acceptance(repo), [], "honesty passes");
});

test("[INJECT] several defects at once are each reported, so one fix does not mask another", () => {
  const repo = goodProject();
  mkdirSync(path.join(repo, "public", "assets"), { recursive: true });
  writeFileSync(path.join(repo, "public", "assets", "injected.js"), `
    document.getElementById('missing-id').value;
    fetch('/api/missing-route', { method: 'POST' });`);
  edit(repo, path.join("src", "worker.js"), (s) => s.replace(/await env\.DB\.prepare[\s\S]*?\.run\(\);/, "console.log(data);"));
  const failed = acceptance(repo);
  assert.deepEqual(failed.map((f) => f.id).sort(), ["contract-check", "persistence-check"], "both gates fired");
  const contract = failed.find((f) => f.id === "contract-check")!.detail;
  assert.match(contract, /missing-id/);
  assert.match(contract, /missing-route/, "both contract defects are listed, not just the first");
});

test("[INJECT] every injected defect is rejected, and the control still passes", () => {
  // The summary the directive actually asks for: acceptance demonstrably catches broken critical functionality.
  const cases: { name: string; break: (r: string) => void; gate: string }[] = [
    { name: "B01 element id", gate: "contract-check", break: (r) => { mkdirSync(path.join(r, "public", "assets"), { recursive: true }); writeFileSync(path.join(r, "public", "assets", "i.js"), `document.getElementById('nope').value;`); } },
    { name: "B02 required field", gate: "contract-check", break: (r) => edit(r, path.join("src", "worker.js"), (s) => s.replace("if (!data.name)", "if (!data.never_sent)")) },
    { name: "B11 missing route", gate: "contract-check", break: (r) => { mkdirSync(path.join(r, "public", "assets"), { recursive: true }); writeFileSync(path.join(r, "public", "assets", "i.js"), `fetch('/api/nope', { method: 'POST' });`); } },
    { name: "B15 fake persistence", gate: "persistence-check", break: (r) => edit(r, path.join("src", "worker.js"), (s) => s.replace(/await env\.DB\.prepare[\s\S]*?\.run\(\);/, "console.log(data);")) },
  ];
  const results = cases.map((c) => {
    const repo = goodProject();
    c.break(repo);
    const failed = acceptance(repo);
    return { name: c.name, rejected: failed.some((f) => f.id === c.gate), gates: failed.map((f) => f.id) };
  });
  for (const r of results) assert.ok(r.rejected, `${r.name} was rejected (gates that fired: ${r.gates.join(", ") || "none"})`);
  assert.deepEqual(acceptance(goodProject()), [], "and the unbroken control still passes, so the gates are not simply failing everything");
  process.stdout.write(`\n[INJECT] ${results.length}/${results.length} injected defects rejected; control passes\n`);
});
