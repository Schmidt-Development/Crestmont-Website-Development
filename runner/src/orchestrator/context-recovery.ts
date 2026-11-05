// Recovering a model request that is too large, instead of throwing the session away.
//
// WHY THIS EXISTS. Summit Haul Co. (bld_dcb3063d445e6f8890d66516) lost its Design Blueprint to this, twice:
//
//   design blueprint attempt 2 failed [overflow]: model server answered 400:
//     request (65569 tokens) exceeds the available context size (65536 tokens)
//
// Thirty-three tokens. The architect had spent nine minutes reading the repository, and all of it was discarded
// because one request was 0.05% too big. Attempt 3 did the same, the stage gave up, and the build proceeded with
// no blueprint at all -- "the visual result cannot be checked against named layouts, exact colours or planned
// photography". The builder has had compaction and checkpoints for a long time (it performed four context resets
// in this very build and kept going); the advisor sessions had none of it. This module is that missing half.
//
// WHAT IT DOES NOT DO. It never invents content. Only messages the session actually received are preserved;
// nothing reconstructs "what the model was probably about to say". A reduction that changes nothing reports
// `changed: false` so the caller can refuse to send the identical oversized request again.
import { estimateImageTokens } from "./vision.ts";
import { contentText, type ChatMessage, type ContentPart } from "../providers/openai-client.ts";

/** chars → tokens, the same ratio the local provider uses (providers/local.ts). */
export const CHARS_PER_TOKEN = 3.5;
/** Per-message framing the server adds (role, delimiters). The provider uses the same figure. */
export const MESSAGE_OVERHEAD = 8;
/** How many reductions one rejected request gets: a normal one, then a harder one. Never unbounded. */
export const RECOVERY_ROUNDS = 2;

export interface OverflowFacts {
  /** Tokens the provider said the request was, when it said so. */
  requested: number | null;
  /** The window the provider said it had. */
  available: number | null;
}

/**
 * The provider's own account of an over-long request, or null.
 *
 * Deliberately matches on the SHAPE of the message rather than a status code alone: a 400 can mean many things,
 * and treating every 400 as an overflow would turn a malformed request into an endless compaction loop.
 */
export function overflowFacts(err: unknown): OverflowFacts | null {
  const text = typeof err === "string" ? err : String((err as { message?: unknown })?.message ?? "");
  if (!text) return null;
  // llama.cpp / Ollama: "request (65569 tokens) exceeds the available context size (65536 tokens)"
  const pair = /request\s*\((\d+)\s*tokens?\)\s*exceeds[^(]*\((\d+)\s*tokens?\)/i.exec(text);
  if (pair) return { requested: Number(pair[1]), available: Number(pair[2]) };
  // vLLM / OpenAI-compatible: "maximum context length is 65536 tokens, however you requested 65569"
  const reversed = /maximum context length is\s*(\d+)[^.]*?requested\s*(\d+)/i.exec(text);
  if (reversed) return { requested: Number(reversed[2]), available: Number(reversed[1]) };
  if (/exceeds the available context size|maximum context length|context window.*exceed|too many tokens|reduce the length of the messages/i.test(text)) {
    return { requested: null, available: null };
  }
  return null;
}

/** Is this the provider refusing a request for being too long, as opposed to any other 400? */
export function isContextOverflow(err: unknown): boolean {
  return overflowFacts(err) !== null;
}

/**
 * Which layer a message belongs to, which is what decides the order things are given up in.
 *
 * - permanent: the system prompt and the instruction being answered right now. Never removed; without them the
 *   session is not a smaller version of the task, it is a different task.
 * - visual:    a user message carrying images. Given up only in the last round, and the caller is told, so it can
 *   restore a correctly sized crop before the next step that needs to see something.
 * - temporary: the inspection history -- assistant tool calls and their outputs. Given up first, oldest first.
 * - durable:   everything else the session was told along the way.
 */
export type Layer = "permanent" | "visual" | "durable" | "temporary";

export function layersOf(messages: readonly ChatMessage[]): Layer[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((m, i) => {
    if (i === 0 || m.role === "system") return "permanent";
    if (i === lastUser) return "permanent";
    if (m.role === "assistant" || m.role === "tool") return "temporary";
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) return "visual";
    return "durable";
  });
}

const textOf = (m: ChatMessage): string =>
  m.role === "assistant" ? (m.content ?? "") + (m.tool_calls ?? []).map((t) => t.function.name + t.function.arguments).join("") : contentText(m.content);

/** Images carried by a message, with the token cost of each. */
export function imagesIn(m: ChatMessage): { part: ContentPart; tokens: number }[] {
  if (!Array.isArray(m.content)) return [];
  return m.content.flatMap((p) => {
    if (p.type !== "image_url") return [];
    // The data URL does not carry dimensions, so the cost is taken from the encoded size: a PNG of W*H pixels is
    // what it is, and base64 length tracks it closely enough to budget with. A caller that knows the real pixel
    // dimensions should pass `knownImageTokens` instead of relying on this.
    const b64 = p.image_url.url.length;
    const bytes = Math.max(0, Math.floor(b64 * 0.75) - 32);
    return [{ part: p, tokens: Math.max(256, Math.round(bytes / 640)) }];
  });
}

export interface MeasureOptions {
  /** Real image cost when the caller knows it (from vision.ts planning). Overrides the estimate from byte size. */
  knownImageTokens?: number;
  /** The provider's learned chars/token correction, when there is one. */
  calibration?: number;
  /** Tool schemas sent with the request. */
  toolsJson?: string | null;
  /** Tokens held back for the reply. A request that leaves no room for an answer is as useless as one that is refused. */
  reservedOutput?: number;
}

/** What this request will cost, by the same arithmetic the provider uses to decide a context reset. */
export function measure(messages: readonly ChatMessage[], o: MeasureOptions = {}): number {
  const cal = o.calibration ?? 1;
  const est = (s: string) => Math.ceil((s.length / CHARS_PER_TOKEN) * cal);
  const text = messages.reduce((n, m) => n + est(textOf(m)) + MESSAGE_OVERHEAD, 0);
  const images = o.knownImageTokens ?? messages.reduce((n, m) => n + imagesIn(m).reduce((k, i) => k + i.tokens, 0), 0);
  const tools = o.toolsJson ? est(o.toolsJson) : 0;
  return text + images + tools + (o.reservedOutput ?? 0);
}

export { estimateImageTokens };

export interface CompactionPlan {
  /** The reduced request. Safe to send only when `fits` is true and `changed` is true. */
  messages: ChatMessage[];
  /** Estimated tokens before and after, and the budget they had to fit inside. */
  before: number;
  after: number;
  budget: number;
  /** Does the reduced request actually fit? Checked here so nothing is sent on hope. */
  fits: boolean;
  /** Did anything actually change? False means: do not resend, this request is already as small as this round makes it. */
  changed: boolean;
  /** What was done, in order, for the failure record. */
  actions: string[];
  /** Images still attached, and any given up -- the caller restores what the next visual step needs. */
  imagesKept: number;
  imagesDropped: number;
}

export interface CompactOptions extends MeasureOptions {
  /** The ceiling the reduced request must fit under. */
  budget: number;
  /** 1 = ordinary reduction. 2 = harder: fewer turns kept, and images may be given up. */
  round?: number;
  /** Newest tool outputs kept in full. Older ones become a marker. */
  keepRecentToolOutputs?: number;
  /** Newest inspection turns kept at all. Older assistant/tool messages are dropped outright. */
  keepRecentTurns?: number;
}

const CLIPPED = "[earlier tool output removed to fit the context]";

/**
 * Reduce a rejected request so it fits, giving up the least useful thing first.
 *
 * The order is the point: inspection history is replaceable (the model can read the file again), the task and the
 * decisions are not. Images are given up only when a second round could not otherwise fit, and the caller is told
 * how many went so it can restore the right one rather than quietly continuing blind.
 */
export function compact(messages: readonly ChatMessage[], o: CompactOptions): CompactionPlan {
  const round = o.round ?? 1;
  const keepTools = o.keepRecentToolOutputs ?? (round >= 2 ? 1 : 3);
  const keepTurns = o.keepRecentTurns ?? (round >= 2 ? 2 : 6);
  const before = measure(messages, o);
  const actions: string[] = [];
  const layers = layersOf(messages);
  let out: ChatMessage[] = messages.map((m) => ({ ...m }) as ChatMessage);

  // ── 1. older tool outputs become a marker, oldest first, until it fits ──────────────────────────────────────
  // Budget-driven, not count-driven. An earlier version stopped once "keep the newest N" was satisfied and
  // returned a request that still did not fit -- which is the same as not recovering at all.
  const toolIdx = out.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const clippable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepTools));
  let clipped = 0;
  for (const i of clippable) {
    if (measure(out, o) <= o.budget) break;
    const m = out[i] as { role: "tool"; content: string };
    if (m.content !== CLIPPED && m.content.length > CLIPPED.length) { m.content = CLIPPED; clipped++; }
  }
  // Still too big with the newest ones intact? Then they go too: a marker still says a file was read.
  for (const i of toolIdx.slice(Math.max(0, toolIdx.length - keepTools))) {
    if (measure(out, o) <= o.budget) break;
    const m = out[i] as { role: "tool"; content: string };
    if (m.content !== CLIPPED && m.content.length > CLIPPED.length) { m.content = CLIPPED; clipped++; }
  }
  if (clipped) actions.push(`clipped ${clipped} tool output(s)`);

  // ── 2. still too big: drop whole inspection turns, oldest first ─────────────────────────────────────────────
  // Dropped as GROUPS: an assistant message carrying tool_calls goes with the tool replies that answer it, or the
  // request becomes invalid (a tool message whose call is gone).
  if (measure(out, o) > o.budget) {
    const groups: number[][] = [];
    for (let i = 0; i < out.length; i++) {
      if (layers[i] !== "temporary") continue;
      const m = out[i];
      if (m.role === "assistant") {
        const g = [i];
        for (let j = i + 1; j < out.length && out[j].role === "tool"; j++) g.push(j);
        groups.push(g);
        i = g[g.length - 1];
      } else if (m.role === "tool" && !groups.some((g) => g.includes(i))) {
        groups.push([i]);
      }
    }
    const keep = Math.max(0, Math.min(keepTurns, groups.length));
    const drop = new Set<number>();
    for (const g of groups.slice(0, Math.max(0, groups.length - keep))) {
      if (measure(out.filter((_, i) => !drop.has(i)), o) <= o.budget) break;
      for (const i of g) drop.add(i);
    }
    // Last ditch within this layer: the newest turns too, rather than hand back something that will be refused.
    if (measure(out.filter((_, i) => !drop.has(i)), o) > o.budget) {
      for (const g of groups.slice(Math.max(0, groups.length - keep))) {
        if (measure(out.filter((_, i) => !drop.has(i)), o) <= o.budget) break;
        for (const i of g) drop.add(i);
      }
    }
    if (drop.size) {
      out = out.filter((_, i) => !drop.has(i));
      actions.push(`dropped ${drop.size} inspection message(s), oldest first`);
    }
  }

  // ── 3. last resort: give up images, the last one kept ───────────────────────────────────────────────────────
  // Image cost is taken from what the caller measured when it prepared them (orchestrator/vision.ts), not guessed
  // from the encoded byte size: a 2.3 MB reference is 2,346 tokens and a 62 KB screenshot is 1,578, which byte
  // length does not predict. Dropping one therefore returns its share of the known total.
  const countImages = (ms: readonly ChatMessage[]) => ms.reduce((n, m) => n + imagesIn(m).length, 0);
  const imagesBefore = countImages(out);
  const imageTotal = o.knownImageTokens ?? out.reduce((n, m) => n + imagesIn(m).reduce((k, i) => k + i.tokens, 0), 0);
  const perImage = imagesBefore > 0 ? imageTotal / imagesBefore : 0;
  let imagesDropped = 0;
  const withImages = () => measure(out, { ...o, knownImageTokens: imageTotal - imagesDropped * perImage });

  if (round >= 2 && withImages() > o.budget) {
    for (let i = 0; i < out.length && withImages() > o.budget; i++) {
      const m = out[i];
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      const parts = m.content as ContentPart[];
      // Never the last one: a request that was sent to have something looked at is pointless without it, and a
      // silently blind model is exactly the failure this whole pipeline exists to prevent.
      while (imagesBefore - imagesDropped > 1 && parts.some((p) => p.type === "image_url") && withImages() > o.budget) {
        const first = parts.findIndex((p) => p.type === "image_url");
        if (first < 0) break;
        parts.splice(first, 1);
        imagesDropped++;
      }
    }
    if (imagesDropped) actions.push(`gave up ${imagesDropped} image(s); the caller must restore what the next visual step needs`);
  }

  const after = withImages();
  const changed = actions.length > 0;
  return {
    messages: out, before, after, budget: o.budget, fits: after <= o.budget, changed, actions,
    imagesKept: imagesBefore - imagesDropped, imagesDropped,
  };
}

/** One line for the build event / failure record. Never contains message text, only sizes and what was done. */
export function describe(p: CompactionPlan): string {
  return `${p.before} → ${p.after} tokens against a ${p.budget} budget (${p.fits ? "fits" : "STILL TOO LARGE"}): ${p.actions.join("; ") || "nothing could be reduced"}`;
}
