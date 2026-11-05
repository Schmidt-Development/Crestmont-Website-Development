// An advisor session surviving an oversized request, through the real LocalModelAdvisor path.
//
// bld_dcb3063d445e6f8890d66516 lost its Design Blueprint three times over. Attempts 2 and 3 were this exact 400:
//
//   request (65569 tokens) exceeds the available context size (65536 tokens)
//
// Thirty-three tokens, after nine minutes of the architect reading the repository — and the stage then gave up, so
// the design phase ran with no blueprint and "the visual result cannot be checked against named layouts, exact
// colours or planned photography". These tests drive the real adapter and fail if that behaviour comes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalModelAdvisor } from "../src/orchestrator/advisors.ts";
import { RECOVERY_ROUNDS } from "../src/orchestrator/context-recovery.ts";
import type { ArchitectInput, GalleryReferenceInput } from "../src/orchestrator/contracts.ts";
import type { ModelProfile } from "../src/config.ts";

const SPEC = {
  schema: "crestmont.master-spec/1", designSpec: "forest green, warm sand, amber accents", masterPrompt: "build it",
  tasks: [], acceptanceCriteria: [], integrations: [], risks: [],
};

/** The real failure text the provider returned, verbatim. */
const OVERFLOW = 'model server answered 400: {"error":{"message":"request (65569 tokens) exceeds the available context size (65536 tokens), try increasing it","type":"invalid_request_error","param":null,"code":null}}';

const model = (): ModelProfile =>
  ({ tag: "qwen3.8:27b-q4_K_M", role: "architect_reviewer", contextTokens: 65_536, vramMb: 0, quantization: null, reasoning: null, vision: true, license: null });

/** A PNG with a real IHDR, so the request budgeter can read its dimensions. */
function png(width = 1670, height = 941): string {
  const dir = mkdtempSync(path.join(tmpdir(), "adv-rec-"));
  const p = path.join(dir, "ref.png");
  const head = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  writeFileSync(p, Buffer.concat([head, dims, Buffer.alloc(5)]));
  return p;
}

const ref = (id: string, p: string): GalleryReferenceInput => ({
  id, title: `Construction Template ${id}`, industry: "construction", relevance: 1, why: "trade match", tags: ["bold"],
  notes: { typography: "condensed display", layout: "full-bleed hero", color: null, animation: null, responsive: null, quality: null },
  path: p, variant: "desktop",
});

const input = (galleryReferences: GalleryReferenceInput[]): ArchitectInput => ({
  brief: { customerData: { business: { name: "Summit Haul Co.", industry: "Junk removal and hauling" } } },
  referenceImages: [], referenceUrls: [], maxSessions: 1, galleryReferences,
});

const advisorFor = (client: unknown, repo = process.cwd()) =>
  new LocalModelAdvisor({ client: client as never, scheduler: null, projectId: "prj_t", model: model(), repo, maxTurns: 8, maxOutputTokens: 2048, temperature: 0 });

const sizeOf = (req: { messages: { content: unknown; tool_calls?: unknown }[] }): number =>
  JSON.stringify(req.messages).length;

test("[CTX-010] an architect session recovers from the real overflow and finishes the SAME task", async () => {
  const sent: { messages: { role: string; content: unknown; tool_calls?: unknown }[] }[] = [];
  let n = 0;
  const client = {
    async chat(req: { messages: { role: string; content: unknown }[] }) {
      sent.push(JSON.parse(JSON.stringify(req)));
      n++;
      // 1: read a file (builds up inspection history). 2: the provider refuses the request. 3: answer.
      if (n === 1) return { content: null, toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "package.json" } }], usage: null, ms: 1 };
      if (n === 2) throw new Error(OVERFLOW);
      return { content: JSON.stringify(SPEC), toolCalls: [], usage: null, ms: 1 };
    },
  };

  const advisor = advisorFor(client);
  const spec = await advisor.architect(input([ref("1", png()), ref("2", png())]));

  assert.ok(spec, "the session completed instead of being thrown away");
  assert.equal(n, 3, "one tool turn, one refusal, one answer — the task was not restarted from nothing");

  // The retry must be a genuinely SMALLER request, not the same one sent again.
  assert.ok(sizeOf(sent[2]) < sizeOf(sent[1]), `the retry must be smaller: ${sizeOf(sent[1])} → ${sizeOf(sent[2])}`);

  // And it must still be the same task: system prompt and the gallery images survive an ordinary reduction.
  assert.equal(sent[2].messages[0].role, "system");
  const images = sent[2].messages.flatMap((m) => (Array.isArray(m.content) ? m.content as { type: string }[] : [])).filter((p) => p.type === "image_url");
  assert.equal(images.length, 2, "the references the architect was asked to look at are still attached");

  const s = advisor.lastSession!;
  assert.equal(s.overflows, 1, "the overflow is recorded");
  assert.equal(s.recoveries.length, 1);
  // The record states the sizes, the budget and what was given up. It does NOT have to claim the reduced request
  // "fits": that is our estimate speaking, and the provider has just shown the two can disagree by a wide margin.
  assert.match(s.recoveries[0], /^\d+ → \d+ tokens against a \d+ budget/, s.recoveries[0]);
  assert.match(s.recoveries[0], /clipped|dropped|gave up/, "and names what it gave up");
  assert.equal(s.outcome, "answered");
});

test("[CTX-011] an irreducible request is not sent again and again", async () => {
  let n = 0;
  const client = {
    async chat() { n++; throw new Error(OVERFLOW); },
  };
  // No tool history to give up: nothing is reducible, so the adapter must stop rather than resend.
  const advisor = advisorFor(client);
  await assert.rejects(() => advisor.architect(input([ref("1", png())])), /too large to reduce|could not be reduced/);
  assert.ok(n <= RECOVERY_ROUNDS + 1, `at most ${RECOVERY_ROUNDS + 1} attempts, got ${n}`);

  const s = advisor.lastSession!;
  assert.equal(s.outcome, "overflow-unrecoverable");
  assert.ok(s.overflows >= 1);
});

test("[CTX-012] a failed session records what it actually did, instead of a fixed sentence", async () => {
  let n = 0;
  const client = {
    async chat() { n++; return { content: "I think the design should be green. (no JSON here)", toolCalls: [], usage: null, ms: 1 }; },
  };
  const advisor = advisorFor(client);
  await assert.rejects(() => advisor.architect(input([])), (err: Error) => {
    // The old message said "within 40 turns" whatever happened — a number nothing had measured.
    assert.match(err.message, /produced no valid JSON after \d+ turn\(s\) and \d+ model call\(s\)/, err.message);
    // Either ending is a real measurement rather than a fixed sentence: three unparseable answers, or the
    // progress guard noticing the model is repeating the identical answer and stopping sooner.
    assert.match(err.message, /unparseable answers|unchanged-output/, "it says what actually ended the session");
    return true;
  });

  const s = advisor.lastSession!;
  assert.equal(s.outcome, "no-json");
  assert.ok(s.jsonFailures >= 1, `json failures counted: ${s.jsonFailures}`);
  assert.ok(s.turns >= 1 && s.modelCalls >= 1, "turns and model calls are real measurements");
  assert.match(s.detail ?? "", /design should be green/, "the last thing the model actually said is kept");
  assert.ok(s.turns <= 8, "and it is bounded by the session's own turn budget");
});

test("[CTX-013] a long planning task continues past 40 turns across segments instead of failing at a ceiling", async () => {
  // The old behaviour: one ceiling of 40, and reaching it threw the session away with
  // "did not return a valid JSON answer within 40 turns". A Premium site genuinely needs more thinking than a
  // Starter brochure, and running out of turns while still making progress is a reason to preserve and continue.
  let n = 0;
  const INSPECTION_TURNS = 52;
  const client = {
    async chat() {
      n++;
      // Keep inspecting, reading a DIFFERENT file each turn so the progress guard sees real work.
      if (n <= INSPECTION_TURNS) {
        return { content: null, toolCalls: [{ id: `c${n}`, name: "read_file", arguments: { path: `src/area-${n}.ts` } }], usage: null, ms: 1 };
      }
      return { content: JSON.stringify(SPEC), toolCalls: [], usage: null, ms: 1 };
    },
  };

  const advisor = new LocalModelAdvisor({
    client: client as never, scheduler: null, projectId: "prj_t", model: model(), repo: process.cwd(),
    maxTurns: 40, maxOutputTokens: 2048, temperature: 0,
    // A Premium-sized allowance: segments of 20, 120 across the whole task.
    allowance: { segmentTurns: 20, totalTurns: 120, reason: "premium package" },
  });

  const spec = await advisor.architect(input([]));
  assert.ok(spec, "the task completed");

  const s = advisor.lastSession!;
  assert.ok(s.turns > 40, `the task ran past the old 40-turn ceiling (${s.turns} turns)`);
  assert.ok(s.modelCalls > 40, `and really made that many model calls (${s.modelCalls})`);
  assert.ok(s.segments >= 2, `across more than one segment (${s.segments})`);
  assert.ok(s.turns <= 120, "and stayed inside the project ceiling");
  assert.equal(s.outcome, "answered");
});

test("[CTX-014] the project ceiling is still enforced, and a stalled session stops early", async () => {
  // Removing the fixed ceiling must not create an endless session.
  let n = 0;
  const client = {
    async chat() {
      n++;
      // Never answers, and always asks for the SAME file: this is a loop, not work.
      return { content: null, toolCalls: [{ id: `c${n}`, name: "read_file", arguments: { path: "package.json" } }], usage: null, ms: 1 };
    },
  };
  const advisor = new LocalModelAdvisor({
    client: client as never, scheduler: null, projectId: "prj_t", model: model(), repo: process.cwd(),
    maxTurns: 40, maxOutputTokens: 2048, temperature: 0,
    allowance: { segmentTurns: 20, totalTurns: 120, reason: "premium package" },
  });

  await assert.rejects(() => advisor.architect(input([])), (err: Error) => {
    assert.match(err.message, /produced no valid JSON/, err.message);
    return true;
  });

  const s = advisor.lastSession!;
  assert.ok(s.turns < 120, `it stopped well before the ceiling rather than burning it (${s.turns} turns)`);
  assert.match(s.stall ?? "", /repeated-tool-call|inspection-without-deliverable/, `the stall is named: ${s.stall}`);
});
