import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, describe as describePlan, isContextOverflow, layersOf, measure, overflowFacts, RECOVERY_ROUNDS } from "../src/orchestrator/context-recovery.ts";
import type { ChatMessage, ContentPart } from "../src/providers/openai-client.ts";

/** A data URL of roughly the byte size a prepared reference crop has. */
const image = (kb: number): ContentPart => ({ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(Math.round(kb * 1024 * 4 / 3)) } });
const user = (text: string, ...imgs: ContentPart[]): ChatMessage =>
  imgs.length ? { role: "user", content: [{ type: "text", text }, ...imgs] } : { role: "user", content: text };
const tool = (text: string): ChatMessage => ({ role: "tool", tool_call_id: "c" + Math.random().toString(16).slice(2), name: "read_file", content: text });
const assistant = (name: string): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: name }) } }] });

test("[CTX-001] the provider's own overflow message is recognised, with its numbers", () => {
  // The exact 400 that cost Summit Haul Co. its Design Blueprint, twice.
  const real = 'model server answered 400: {"error":{"message":"request (65569 tokens) exceeds the available context size (65536 tokens), try increasing it","type":"invalid_request_error"}}';
  const f = overflowFacts(real);
  assert.ok(f, "the real failure is recognised as an overflow");
  assert.equal(f.requested, 65569);
  assert.equal(f.available, 65536);
  assert.equal(f.requested - f.available, 33, "thirty-three tokens is what the blueprint was thrown away for");

  // Other providers phrase it the other way round.
  const vllm = overflowFacts("This model's maximum context length is 65536 tokens, however you requested 70000 tokens");
  assert.equal(vllm?.available, 65536);
  assert.equal(vllm?.requested, 70000);

  // A 400 that is NOT an overflow must not be treated as one: compacting a malformed request forever is its own bug.
  assert.equal(isContextOverflow("model server answered 400: Multimodal data provided, but model does not support multimodal requests."), false);
  assert.equal(isContextOverflow("model server answered 500: internal error"), false);
  assert.equal(isContextOverflow(new Error("no such column: count")), false);
});

test("[CTX-002] a request over by 33 tokens is recovered, and the task survives the reduction", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "S".repeat(4000) },
    user("The customer brief and the approved design direction. " + "B".repeat(4000)),
    assistant("src/a.ts"), tool("A".repeat(70000)),
    assistant("src/b.ts"), tool("B".repeat(70000)),
    assistant("src/c.ts"), tool("C".repeat(70000)),
    user("Answer now with the single JSON object only."),
  ];
  const budget = 65536 - 8192;
  const before = measure(messages, { reservedOutput: 8192 });
  assert.ok(before > budget, "the fixture really is too large");

  const plan = compact(messages, { budget, reservedOutput: 8192 });
  assert.equal(plan.fits, true, `the reduced request must fit: ${describePlan(plan)}`);
  assert.equal(plan.changed, true);
  assert.ok(plan.after < plan.before);

  // What must survive: the task itself, at both ends.
  assert.equal(plan.messages[0].role, "system", "the system prompt is never given up");
  const last = plan.messages[plan.messages.length - 1];
  assert.match(typeof last.content === "string" ? last.content : "", /single JSON object only/, "the instruction being answered survives");
  assert.ok(plan.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("approved design direction")),
    "the accepted design direction is not inspection history and must not be dropped");
});

test("[CTX-003] a reduction that changes nothing reports it, so the identical request is never resent", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "S".repeat(60000) },
    user("answer now"),
  ];
  // Nothing here is reducible: it is all permanent. The caller must be able to tell.
  const plan = compact(messages, { budget: 1000 });
  assert.equal(plan.changed, false, "nothing was reduced");
  assert.equal(plan.fits, false, "and it still does not fit");
  assert.match(describePlan(plan), /nothing could be reduced/);
  assert.ok(RECOVERY_ROUNDS >= 1 && RECOVERY_ROUNDS <= 3, "recovery is bounded");
});

test("[CTX-004] images survive an ordinary reduction, and a last-resort drop is reported rather than silent", () => {
  const ref = image(90);
  const shot = image(90);
  const messages: ChatMessage[] = [
    { role: "system", content: "S".repeat(2000) },
    user("DESIGN REFERENCE and YOUR OWN WEBSITE", ref, shot),
    assistant("src/a.ts"), tool("A".repeat(60000)),
    user("Answer now with the single JSON object only."),
  ];

  // The caller states what the images really cost, exactly as planVisionRequest measures them.
  const knownImageTokens = 2346 + 1578;

  // Round 1 gives up inspection history, never the images.
  const r1 = compact(messages, { budget: 40000, round: 1, knownImageTokens });
  assert.equal(r1.imagesDropped, 0, "an ordinary reduction must not blind the model");
  assert.equal(r1.imagesKept, 2);

  // Round 2, with a budget that the text alone nearly fills, may give one up -- and must say so.
  const r2 = compact(messages, { budget: 4000, round: 2, knownImageTokens });
  assert.ok(r2.imagesDropped >= 1, "the harder round may give up an image");
  assert.ok(r2.imagesKept >= 1, "but never all of them: one reference is the point of the request");
  assert.match(r2.actions.join(" "), /gave up \d+ image/, "the caller is told, so it can restore the right crop");
});

test("[CTX-005] the layering puts inspection history first and the task last", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    user("brief"),
    user("look at this", image(1)),
    assistant("src/a.ts"),
    tool("file contents"),
    user("answer now"),
  ];
  assert.deepEqual(layersOf(messages), ["permanent", "durable", "visual", "temporary", "temporary", "permanent"]);
});
