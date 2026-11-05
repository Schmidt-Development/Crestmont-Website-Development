// Telling useful work apart from a session going in circles.
//
// WHY. Removing the universal 40-turn ceiling removes the thing that used to stop a session that was achieving
// nothing. A real Business build's reviewer once spent all 40 turns reading files and never answered at all --
// every turn a tool call, no content -- and the build lost its independent review. With longer, resumable
// budgets that same session would read for ever. So the ceiling is replaced by a question that is actually about
// progress: is this session still producing anything?
//
// The answers are deliberately cheap to compute and deliberately conservative. A guard that stops real work is
// worse than no guard, because the work it stops has already been paid for in GPU time.

export type Stall =
  | { kind: "repeated-tool-call"; detail: string }
  | { kind: "invalid-json"; detail: string }
  | { kind: "unchanged-output"; detail: string }
  | { kind: "ineffective-overflow"; detail: string }
  | { kind: "inspection-without-deliverable"; detail: string };

/** What to do about it. `synthesize` means: stop inspecting, answer from what you already have. */
export type Strategy = "continue" | "synthesize" | "stop";

export interface Verdict {
  stall: Stall | null;
  strategy: Strategy;
}

export interface GuardLimits {
  /** The same tool call, with the same arguments, this many times running. */
  repeatedToolCalls: number;
  /** Unparseable answers in a row. */
  invalidJson: number;
  /** Identical answers in a row. */
  unchangedOutputs: number;
  /** Overflows where the reduction freed nothing worth having. */
  ineffectiveOverflows: number;
  /** Tool calls without a single deliverable before the session is told to answer from what it has. */
  inspectionWithoutDeliverable: number;
}

export const DEFAULT_LIMITS: GuardLimits = {
  repeatedToolCalls: 3,
  invalidJson: 3,
  unchangedOutputs: 2,
  ineffectiveOverflows: 2,
  inspectionWithoutDeliverable: 25,
};

/**
 * Watches one session and says when it has stopped getting anywhere.
 *
 * Every counter resets on genuine progress, so a session that reads the same file twice and then does something
 * useful is not punished for it. Only an unbroken run of the same unproductive behaviour trips a stall.
 */
export class ProgressGuard {
  private readonly limits: GuardLimits;
  private lastToolKey: string | null = null;
  private sameToolRun = 0;
  private invalidJsonRun = 0;
  private lastOutput: string | null = null;
  private sameOutputRun = 0;
  private ineffectiveOverflowRun = 0;
  private toolCallsSinceDeliverable = 0;
  /** Every distinct tool target this session has already visited. New ground counts as progress. */
  private readonly seenTargets = new Set<string>();
  /** Everything seen, for the failure record. */
  readonly events: string[] = [];

  constructor(limits: Partial<GuardLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * A tool call the session asked for.
   *
   * Two different things are watched here. The same call repeating is a loop. But a session reading somewhere it
   * has never read before is covering new ground, and that is progress even though nothing has been produced yet
   * -- a Premium site legitimately inspects a great many files before it can answer. So a genuinely new target
   * resets the "inspecting and producing nothing" counter, while revisiting old ground does not.
   */
  toolCall(name: string, args: unknown): void {
    const key = `${name}:${JSON.stringify(args ?? null)}`;
    if (key === this.lastToolKey) this.sameToolRun++;
    else { this.lastToolKey = key; this.sameToolRun = 1; }
    if (this.seenTargets.has(key)) {
      this.toolCallsSinceDeliverable++;
    } else {
      this.seenTargets.add(key);
      this.toolCallsSinceDeliverable = 0;
    }
  }

  /** The session produced something real: an answer, a validated section, a written artefact. */
  deliverable(what = "deliverable"): void {
    this.toolCallsSinceDeliverable = 0;
    this.seenTargets.clear();
    this.invalidJsonRun = 0;
    this.sameOutputRun = 0;
    this.lastOutput = null;
    this.sameToolRun = 0;
    this.lastToolKey = null;
    this.events.push(`progress: ${what}`);
  }

  /** An answer that could not be parsed. */
  invalidJson(): void {
    this.invalidJsonRun++;
  }

  /** An answer that parsed. Identical answers in a row mean the correction is not landing. */
  output(text: string): void {
    const key = text.trim().slice(0, 2000);
    if (key && key === this.lastOutput) this.sameOutputRun++;
    else { this.lastOutput = key; this.sameOutputRun = 1; }
  }

  /**
   * A context overflow, and whether the reduction actually freed anything.
   *
   * `freedTokens <= 0` is the case that matters: the request was refused, something was done, and the request is
   * no smaller. Repeating that is the loop this prevents.
   */
  overflow(freedTokens: number): void {
    if (freedTokens > 0) this.ineffectiveOverflowRun = 0;
    else this.ineffectiveOverflowRun++;
  }

  /** Where the session stands now, and what should change if it is stuck. */
  verdict(): Verdict {
    if (this.ineffectiveOverflowRun >= this.limits.ineffectiveOverflows) {
      return { stall: { kind: "ineffective-overflow", detail: `${this.ineffectiveOverflowRun} overflow(s) in a row freed nothing` }, strategy: "stop" };
    }
    if (this.invalidJsonRun >= this.limits.invalidJson) {
      // More inspection will not fix a formatting problem. Take the tools away and ask for the answer alone.
      return { stall: { kind: "invalid-json", detail: `${this.invalidJsonRun} unparseable answer(s) in a row` }, strategy: "synthesize" };
    }
    if (this.sameOutputRun >= this.limits.unchangedOutputs) {
      return { stall: { kind: "unchanged-output", detail: `the same answer ${this.sameOutputRun} times running; the correction is not landing` }, strategy: "stop" };
    }
    if (this.sameToolRun >= this.limits.repeatedToolCalls) {
      return { stall: { kind: "repeated-tool-call", detail: `the same tool call ${this.sameToolRun} times running` }, strategy: "synthesize" };
    }
    if (this.toolCallsSinceDeliverable >= this.limits.inspectionWithoutDeliverable) {
      return { stall: { kind: "inspection-without-deliverable", detail: `${this.toolCallsSinceDeliverable} tool call(s) and nothing produced` }, strategy: "synthesize" };
    }
    return { stall: null, strategy: "continue" };
  }

  /** One line for the build record. */
  describe(): string {
    const v = this.verdict();
    return v.stall ? `${v.stall.kind}: ${v.stall.detail} — ${v.strategy}` : "progressing";
  }
}
