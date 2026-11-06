// Outbound calling modes and capacity — pure rules (no I/O). Founder directive 2026-11-06 (final master prompt
// parts 2–4, 9). The dialler (src/services/sales-outbound.ts) applies these; the atomic reservation itself lives in
// the database (outbound_call_slots, migration 0090), so this file only decides how many may be held.
//
//   Mode A — Scheduled AI Callbacks: calls a prospect asked for (an AI Outbound Calendar appointment). Launch: ON.
//   Mode B — AI Cold Outreach: proactive calls to eligible Approved-CRM leads. Launch: OFF.
//
// Capacity (Founder allocation): cold outreach ≤ 15 concurrent, 5 concurrent slots reserved for callbacks, 20 in all —
// a desired MAXIMUM, never permission to oversubscribe Retell. When inbound receptionist calls share the provider's
// limit, the outbound room shrinks first for cold outreach; the callback reservation is honoured within whatever
// outbound room remains, and cold outreach never borrows it, even while no callback is waiting.

export type OutboundMode = "cold" | "callback";
export const OUTBOUND_MODES: readonly OutboundMode[] = ["cold", "callback"];
export const MODE_LABELS: Record<OutboundMode, string> = { callback: "Scheduled AI Callbacks", cold: "AI Cold Outreach" };

/** Hard ceilings from the Founder's allocation (the slot table holds exactly this many rows per mode). */
export const COLD_MAX_CONCURRENT = 15;
export const CALLBACK_RESERVED_MAX = 5;

export interface CapacityInput {
  providerLimit: number;          // Retell's real concurrency limit for the sales workspace
  inboundSharesCapacity: boolean; // inbound receptionist calls count against the same limit
  activeInbound: number;          // inbound (and receptionist follow-up) calls in progress now
  inboundHeadroom: number;        // lines kept free for new inbound callers when shared
  coldMax: number;                // Owner setting, ≤ 15
  callbackReserved: number;       // Owner setting, 1–5
  activeCold: number;
  activeCallback: number;
}

export interface CapacityPlan {
  /** Outbound calls the provider can carry right now. */
  outboundRoom: number;
  /** Concurrent calls each mode may hold right now (including those already active). */
  limit: Record<OutboundMode, number>;
  /** New dials each mode may start now. */
  free: Record<OutboundMode, number>;
  notes: string[];
}

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

export function capacityPlan(i: CapacityInput): CapacityPlan {
  const notes: string[] = [];
  const coldMax = clampInt(i.coldMax, 0, COLD_MAX_CONCURRENT);
  const reserved = clampInt(i.callbackReserved, 0, CALLBACK_RESERVED_MAX);
  const provider = clampInt(i.providerLimit, 0, 1000);
  const inboundUse = i.inboundSharesCapacity ? clampInt(i.activeInbound, 0, 1000) + clampInt(i.inboundHeadroom, 0, 1000) : 0;
  const outboundRoom = Math.max(0, provider - inboundUse);
  if (i.inboundSharesCapacity && inboundUse > 0) notes.push(`${i.activeInbound} inbound call(s) + ${i.inboundHeadroom} line(s) kept for inbound share the provider limit of ${provider}`);
  // Callbacks: their reservation, within the room left after the cold calls already on the line (a call in progress is
  // never interrupted, so a burst of inbound calls can push callbacks below their reservation until cold calls end).
  const callbackLimit = Math.min(reserved, Math.max(0, outboundRoom - i.activeCold));
  // Cold: never more than its maximum, and never into the callback reservation — reserved even when unused.
  const coldLimit = Math.min(coldMax, Math.max(0, outboundRoom - reserved));
  if (coldLimit < coldMax) notes.push(`cold outreach limited to ${coldLimit} of ${coldMax}: ${reserved} slot(s) stay reserved for callbacks within ${outboundRoom} outbound`);
  if (callbackLimit < reserved) notes.push(`callbacks limited to ${callbackLimit} of ${reserved} reserved by the provider limit`);
  const limit = { cold: coldLimit, callback: callbackLimit };
  return {
    outboundRoom, limit, notes,
    free: { cold: Math.max(0, coldLimit - i.activeCold), callback: Math.max(0, callbackLimit - i.activeCallback) },
  };
}

/** What the Founder's 15 + 5 allocation needs from the provider, and whether the configured limit allows it. */
export function allocationShortfall(providerLimit: number, inboundShares: boolean, inboundHeadroom: number, coldMax: number, reserved: number): string | null {
  const need = clampInt(coldMax, 0, COLD_MAX_CONCURRENT) + clampInt(reserved, 0, CALLBACK_RESERVED_MAX) + (inboundShares ? clampInt(inboundHeadroom, 0, 1000) : 0);
  if (providerLimit >= need) return null;
  return `The provider limit (${providerLimit}) is below what ${coldMax} cold + ${reserved} reserved callback calls${inboundShares ? ` + ${inboundHeadroom} inbound line(s)` : ""} need (${need}). `
    + "Outbound dialling is reduced automatically; buying more Retell concurrency needs the Founder's approval.";
}

// ───────────── Cold-outreach ramp (Founder authorises activation and every increase) ─────────────

export const COLD_STAGES = ["launch", "pilot", "stage_2", "stage_3", "stage_4", "stage_5"] as const;
export type ColdStage = (typeof COLD_STAGES)[number];
export const COLD_STAGE_LABELS: Record<ColdStage, string> = { launch: "Launch", pilot: "Pilot", stage_2: "Stage 2", stage_3: "Stage 3", stage_4: "Stage 4", stage_5: "Stage 5" };
export const DEFAULT_COLD_STAGE_LIMITS: Record<ColdStage, number> = { launch: 0, pilot: 10, stage_2: 25, stage_3: 50, stage_4: 100, stage_5: 200 };
export const COLD_STAGE_MAX = 1000;

export function parseStageLimits(json: string | null | undefined): Record<ColdStage, number> {
  const out = { ...DEFAULT_COLD_STAGE_LIMITS };
  try {
    const o = JSON.parse(json ?? "{}") as Record<string, unknown>;
    for (const s of COLD_STAGES) if (Number.isInteger(o[s]) && (o[s] as number) >= 0 && (o[s] as number) <= COLD_STAGE_MAX) out[s] = o[s] as number;
  } catch { /* defaults */ }
  out.launch = 0; // the launch stage is always zero calls: activation is a separate, deliberate step
  return out;
}

/** Problems with an edited set of stage limits (each stage must not exceed the next one). */
export function stageLimitProblems(limits: Record<string, number>): string[] {
  const p: string[] = [];
  let prev = -1;
  for (const s of COLD_STAGES) {
    const v = limits[s];
    if (!Number.isInteger(v) || v < 0 || v > COLD_STAGE_MAX) { p.push(`${COLD_STAGE_LABELS[s]} must be a whole number of calls per day (0–${COLD_STAGE_MAX})`); continue; }
    if (s === "launch" && v !== 0) p.push("The Launch stage is always 0 cold calls per day");
    if (v < prev) p.push(`${COLD_STAGE_LABELS[s]} (${v}) is lower than the stage before it (${prev})`);
    prev = v;
  }
  return p;
}

/** Moving to a higher stage is an increase the Founder must authorise; the caller records who did it. */
export const isStageIncrease = (from: ColdStage, to: ColdStage) => COLD_STAGES.indexOf(to) > COLD_STAGES.indexOf(from);

// ───────────── Scheduled callbacks ─────────────

/** A callback more than this late is never dialled: it is marked missed and handed to a person instead. */
export const CALLBACK_GRACE_MS = 30 * 60_000;
/** A callback that rang out gets one more try a few minutes later (inside the appointment), then goes to a person. */
export const CALLBACK_MAX_ATTEMPTS = 2;
export const CALLBACK_RETRY_MS = 10 * 60_000;

/** Federal TCPA calling hours (8 a.m.–9 p.m. recipient-local). Callbacks are requested calls; cold calls use the
 *  narrower sales window in src/domain/sales-eligibility.ts. Counsel must confirm both (not legal advice). */
export function withinCallbackHours(at: Date, tz: string): boolean {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
    const m = Number(p.hour) * 60 + Number(p.minute);
    return m >= 8 * 60 && m < 21 * 60;
  } catch { return false; }
}

export interface CallbackGateFacts {
  phoneE164: string | null;
  onDnc: boolean;
  suppressedInCrm: boolean;
  leadMerged: boolean;
  /** The person asked for this call: a recorded callback consent (voice_call_consents) or sales written consent. */
  consentEvidence: string | null;
  timeZone: string | null;
  attemptsSoFar: number;
  maxAttempts: number;
}

/** Every condition must hold; an unknown is a block. A callback never needs the cold-outreach compliance approval. */
export function callbackEligibility(f: CallbackGateFacts, now: Date): { eligible: boolean; reasons: string[] } {
  const r: string[] = [];
  if (!f.phoneE164) r.push("No dialable number");
  else if (!f.phoneE164.startsWith("+1")) r.push("Only US (+1) numbers can be called");
  if (f.onDnc) r.push("Number is on the internal do-not-call list");
  if (f.suppressedInCrm) r.push("The CRM has this contact suppressed");
  if (f.leadMerged) r.push("Lead was merged into another lead");
  if (!f.consentEvidence) r.push("No recorded request or consent for this callback from this number");
  if (!f.timeZone) r.push("No time zone known for the callback");
  else if (!withinCallbackHours(now, f.timeZone)) r.push("Outside 8 a.m.–9 p.m. in the recipient's time zone");
  if (f.attemptsSoFar >= f.maxAttempts) r.push(`Attempt limit reached (${f.maxAttempts})`);
  return { eligible: r.length === 0, reasons: r };
}

/** Whether a queued callback is too late to dial (its appointment time passed by more than the grace period). */
export const callbackMissed = (notBefore: string | null, now: Date) => !!notBefore && now.getTime() - Date.parse(notBefore) > CALLBACK_GRACE_MS;
