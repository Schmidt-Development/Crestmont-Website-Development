// Did the repair change the website? (V5 §9 "no-op protection".)
//
// The failure these prevent, measured on build bld_10e2c6007686faee0ab64d45:
//
//   nine stored revisions, nine "repair" cycles, and EXACTLY ONE rendered change across all of them --
//   index-desktop.png hashed 41df475aa1 for revisions 1-6 and 12e7cbc1ed for 7-9, with revisions 2-6
//   sharing a single commit.
//
// The loop reported nine repairs because it counted cycles, not effects. Nothing compared a repair's result with
// the state before it, so a cycle that edited nothing -- or edited a file that no measured page loads -- was
// indistinguishable from a cycle that fixed the design.
//
// No GPU and no model: deterministic file-system tests over real bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyEffect, fingerprintCycle, ineffectiveFeedback, noopVerdict, renderFingerprint, sourceFingerprint,
  DEFAULT_NOOP, type CycleFingerprint,
} from "../src/orchestrator/repair-effect.ts";

function repo(): string {
  const d = mkdtempSync(path.join(tmpdir(), "effect-"));
  mkdirSync(path.join(d, "public"), { recursive: true });
  mkdirSync(path.join(d, ".crestmont", "screenshots"), { recursive: true });
  writeFileSync(path.join(d, "public", "index.html"), "<!doctype html><link rel=stylesheet href=/site.css><h1>Hi</h1>");
  writeFileSync(path.join(d, "public", "site.css"), "h1 { color: #111; }");
  return d;
}
const shot = (d: string, name: string, body: string) => writeFileSync(path.join(d, ".crestmont", "screenshots", name), Buffer.from(body));
const fp = (d: string, cycle: number, points: number | null = 20): CycleFingerprint =>
  fingerprintCycle({ repo: d, cycle, commit: `c${cycle}`.padEnd(40, "0"), targeted: ["navigation is stacked"], visualPoints: points });

test("[EFFECT] the measured failure: a cycle that edits nothing and renders identically is INEFFECTIVE", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  shot(d, "index-mobile.png", "PIXELS-B");
  const a = fp(d, 1);
  // A new cycle ran. It committed evidence (which is not source) and changed nothing else.
  const b = fp(d, 2);
  const e = classifyEffect(a, b, [a]);
  assert.equal(e.verdict, "ineffective");
  assert.equal(e.sourceChanged, false);
  assert.equal(e.renderChanged, false);
  assert.match(e.reason, /changed nothing a visitor can see/);
  assert.match(e.reason, /byte-identical/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] a different commit is NOT evidence of a change: the source is hashed, not the commit", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  const a = fingerprintCycle({ repo: d, cycle: 1, commit: "a".repeat(40), targeted: [], visualPoints: 20 });
  const b = fingerprintCycle({ repo: d, cycle: 2, commit: "b".repeat(40), targeted: [], visualPoints: 20 });
  assert.notEqual(a.commit, b.commit);
  assert.equal(a.source, b.source);
  assert.equal(classifyEffect(a, b, [a]).verdict, "ineffective");
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] a real style change that moves the pixels is EFFECTIVE, and names the pages", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  shot(d, "about-desktop.png", "PIXELS-X");
  const a = fp(d, 1);
  writeFileSync(path.join(d, "public", "site.css"), "h1 { color: #111; font: 700 3rem/1.1 Georgia, serif; }");
  shot(d, "index-desktop.png", "PIXELS-A2");
  const b = fp(d, 2, 26);
  const e = classifyEffect(a, b, [a]);
  assert.equal(e.verdict, "effective");
  assert.equal(e.sourceChanged, true);
  assert.equal(e.renderChanged, true);
  assert.deepEqual(e.changedPages, ["index (desktop)"]);
  assert.match(e.reason, /index \(desktop\)/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] editing a file that no measured page renders is INEFFECTIVE, and says why", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  const a = fp(d, 1);
  // The classic version of this defect: a stylesheet nothing links, or a component no page uses.
  writeFileSync(path.join(d, "public", "unused-theme.css"), ":root { --brand: #0a5; }");
  const b = fp(d, 2);
  const e = classifyEffect(a, b, [a]);
  assert.equal(e.verdict, "ineffective");
  assert.equal(e.sourceChanged, true);
  assert.equal(e.renderChanged, false);
  assert.match(e.reason, /edited the source but changed no rendered pixel/);
  assert.match(e.reason, /does not reach the pages that were measured/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] a cycle that reproduces an earlier cycle's rendering is a REPEAT, not progress", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  const c1 = fp(d, 1);
  writeFileSync(path.join(d, "public", "site.css"), "h1 { color: #c00; }");
  shot(d, "index-desktop.png", "PIXELS-B");
  const c2 = fp(d, 2);
  // Cycle 3 undoes cycle 2: source and pixels both move, but back to where cycle 1 already was.
  writeFileSync(path.join(d, "public", "site.css"), "h1 { color: #111; }");
  shot(d, "index-desktop.png", "PIXELS-A");
  const c3 = fp(d, 3);
  const e = classifyEffect(c2, c3, [c1, c2]);
  assert.equal(e.verdict, "ineffective");
  assert.equal(e.renderChanged, true, "pixels did move -- but to a state already seen");
  assert.equal(e.repeatOfCycle, 1);
  assert.match(e.reason, /undoing and redoing the same change/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] the first measured state is UNKNOWN, never a reported repair", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  const e = classifyEffect(null, fp(d, 1), []);
  assert.equal(e.verdict, "unknown");
  assert.match(e.reason, /nothing before it to compare/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] no screenshots and no source change is UNKNOWN, not a silent pass or a false failure", () => {
  const d = repo();
  const a = fp(d, 1);
  const b = fp(d, 2);
  assert.equal(a.render.length, 0);
  const e = classifyEffect(a, b, [a]);
  assert.equal(e.verdict, "unknown");
  assert.match(e.reason, /cannot be measured/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] a page that stops rendering is a change, and is named as one", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  shot(d, "services-desktop.png", "PIXELS-S");
  const a = fp(d, 1);
  rmSync(path.join(d, ".crestmont", "screenshots", "services-desktop.png"));
  rmSync(path.join(d, "public", "site.css"));
  const e = classifyEffect(a, fp(d, 2), [a]);
  assert.equal(e.verdict, "effective");
  assert.ok(e.changedPages.some((p) => p.includes("services") && p.includes("no longer rendered")), e.changedPages.join(","));
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] evidence under .crestmont/ is not source: writing it does not fake a change", () => {
  const d = repo();
  const before = sourceFingerprint(d);
  writeFileSync(path.join(d, ".crestmont", "defects.json"), JSON.stringify(["navigation is stacked"]));
  writeFileSync(path.join(d, ".crestmont", "review-01.md"), "# review");
  const after = sourceFingerprint(d);
  assert.equal(before.sha, after.sha);
  assert.equal(before.files, after.files);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] screenshots are hashed per page and viewport", () => {
  const d = repo();
  shot(d, "index-desktop.png", "A");
  shot(d, "index-mobile.png", "B");
  shot(d, "not-a-screenshot.txt", "C");
  const r = renderFingerprint(d);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => `${x.page}/${x.viewport}`).sort(), ["index/desktop", "index/mobile"]);
  assert.notEqual(r[0].sha, r[1].sha);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] the no-op bound escalates before it stops, and never stops on a single cycle", () => {
  assert.equal(noopVerdict(0), "ok");
  assert.equal(noopVerdict(1), "ok", "one ineffective cycle is normal and must not change the route");
  assert.equal(noopVerdict(DEFAULT_NOOP.escalateAt), "escalate");
  assert.equal(noopVerdict(DEFAULT_NOOP.stopAt), "stop");
  assert.equal(noopVerdict(DEFAULT_NOOP.stopAt + 5), "stop");
  assert.ok(DEFAULT_NOOP.escalateAt < DEFAULT_NOOP.stopAt);
});

test("[EFFECT] the next prompt states the measured fact and asks WHY the edit had no effect", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  const a = fp(d, 1);
  writeFileSync(path.join(d, "public", "unused.css"), "a{}");
  const e = classifyEffect(a, fp(d, 2), [a]);
  const text = ineffectiveFeedback(e, { consecutive: 2, targeted: ["navigation is stacked on desktop"] });
  assert.ok(text);
  assert.match(text, /did not change the website/);
  assert.match(text, /find out WHY/);
  assert.match(text, /not the one being served/);
  assert.match(text, /2 repair cycles in a row/);
  assert.match(text, /navigation is stacked on desktop/);
  rmSync(d, { recursive: true, force: true });
});

test("[EFFECT] an effective cycle gets no scolding prompt", () => {
  const d = repo();
  shot(d, "index-desktop.png", "PIXELS-A");
  const a = fp(d, 1);
  shot(d, "index-desktop.png", "PIXELS-B");
  writeFileSync(path.join(d, "public", "site.css"), "h1{color:#c00}");
  const e = classifyEffect(a, fp(d, 2), [a]);
  assert.equal(e.verdict, "effective");
  assert.equal(ineffectiveFeedback(e, { consecutive: 0, targeted: [] }), null);
  assert.equal(ineffectiveFeedback(null, { consecutive: 0, targeted: [] }), null);
  rmSync(d, { recursive: true, force: true });
});
