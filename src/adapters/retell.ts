// Retell AI → Crestmont voice envelope (VOICE-003). Translation only: every business rule (idempotency
// per call, published-pricing-only, lead/callback/support/escalation handling, consent-gated transcripts)
// lives in src/services/voice.ts#handleVoiceEvent and is reused unchanged.
//
// Sources (checked 2026-10-27; see docs/voice/RETELL-INTEGRATION.md):
//  - Secure webhook:  https://docs.retellai.com/features/secure-webhook.md
//      Header `X-Retell-Signature: v=<unix ms>,d=<hex>`; d = HMAC-SHA256(key = Retell API key with the
//      webhook badge, message = rawBody + v); reject when v is more than 5 minutes from now.
//  - Webhook events:  https://docs.retellai.com/features/webhook-overview.md
//      Body `{ event, call }`; events call_started, call_ended, call_analyzed (default subscriptions);
//      2xx expected, 10 s timeout, up to 3 retries → consumers must be idempotent.
//  - Custom functions: https://docs.retellai.com/build/single-multi-prompt/custom-function.md
//      POST body `{ name, call, args }` (default, not "args only"), signed with the same X-Retell-Signature;
//      the response body is stringified and given to the agent's LLM.
//  - Call object:     https://docs.retellai.com/api-references/get-call.md
//      call_cost.combined_cost is "in cents"; call_type web_call | phone_call; call_status; disconnection_reason.
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { VOICE_FUNCTIONS, VOICEMAIL_MODE_EVENT, ensureCall, recordCallEvent, type CallOutcome } from "../services/voice.ts";
import { loadVoiceConfig, hoursStatus, transferAvailability, describeHours } from "../services/voice-settings.ts";
import { addLeadTask, notifyOwners, redactSensitive } from "../services/voice-common.ts";
import { audit } from "../services/security.ts";
import { voiceBudget, budgetOpen, noteBudgetClosed } from "../services/voice-budget.ts";

/** Environment the request is being processed in (env.ENVIRONMENT). */
export interface RetellCtx { environment: "development" | "staging" | "production"; now?: () => Date }

export const RETELL_PROVIDER = "retell";
export const RETELL_TOLERANCE_MS = 5 * 60 * 1000;

export class RetellAuthError extends Error {}

/** Signs exactly as Retell does (used by tests and the documentation's curl example). */
export async function signRetell(apiKey: string, rawBody: string, nowMs = Date.now()): Promise<string> {
  return `v=${nowMs},d=${await hmacSha256Hex(apiKey, rawBody + String(nowMs))}`;
}

/** Fails closed: no key → every request refused. */
export async function verifyRetellSignature(apiKey: string | undefined, rawBody: string, header: string | null, nowMs = Date.now()): Promise<void> {
  if (!apiKey) throw new RetellAuthError("Retell webhook key not configured (RETELL_API_KEY)");
  const m = /^v=(\d{10,16}),d=([0-9a-f]{64})$/.exec((header ?? "").trim());
  if (!m) throw new RetellAuthError("Missing or malformed X-Retell-Signature");
  if (Math.abs(nowMs - Number(m[1])) > RETELL_TOLERANCE_MS) throw new RetellAuthError("Signature timestamp outside tolerance");
  if (!timingSafeEqualHex(m[2], await hmacSha256Hex(apiKey, rawBody + m[1]))) throw new RetellAuthError("Signature mismatch");
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const str = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

export interface RetellCall {
  call_id?: string; call_type?: string; from_number?: string; call_status?: string; disconnection_reason?: string;
  transcript?: string; recording_url?: string; call_cost?: { combined_cost?: number }; call_analysis?: { call_summary?: string };
  metadata?: Obj; retell_llm_dynamic_variables?: Obj;
}

const callIdOf = (call: Obj): string => {
  const id = str(call, "call_id");
  if (!id || !/^[A-Za-z0-9._:-]{1,120}$/.test(id)) throw new RetellPayloadError("call.call_id missing or invalid");
  return id;
};
export class RetellPayloadError extends Error {}

/** Web calls are Retell dashboard / web-SDK test calls; a phone call can also be flagged via metadata. */
const isTest = (call: Obj) => { const t = obj(call.metadata).crestmont_test; return str(call, "call_type") === "web_call" || t === true || t === "true"; };

/** Combined cost is reported in cents (possibly fractional) → integer micro-USD; anything else → unknown (null). */
export function retellCostMicroUsd(call: Obj): number | null {
  const c = obj(call.call_cost).combined_cost;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? Math.round(c * 10_000) : null;
}

async function consentFor(db: Db, callId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT consent FROM retell_call_consents WHERE provider_call_id = ?`).bind(callId).first<{ consent: number }>();
  return row?.consent === 1;
}

/**
 * Outcome for call_ended, derived from what the platform already recorded for this call (read-only
 * look at voice_events written by handleVoiceEvent), in order of importance.
 */
async function deriveOutcome(db: Db, callId: string, call: Obj): Promise<CallOutcome> {
  const status = str(call, "call_status");
  const reason = str(call, "disconnection_reason") ?? "";
  if (status === "error" || reason.startsWith("error")) return "error";
  const rows = (await db.prepare(`SELECT e.kind, e.result_json FROM voice_events e JOIN calls c ON c.id = e.call_id WHERE c.provider = ? AND c.provider_call_id = ? AND e.status = 'ok'`)
    .bind(RETELL_PROVIDER, callId).all<{ kind: string; result_json: string | null }>()).results;
  const kinds = new Set(rows.map((r) => r.kind));
  // schedule_consultation only lists times unless it booked one.
  const booked = rows.some((r) => r.kind === "fn:schedule_consultation" && /"booked":true/.test(r.result_json ?? ""));
  if (kinds.has("fn:escalate")) return "escalated";
  if (kinds.has("fn:route_support") || kinds.has("fn:create_support_ticket")) return "support_routed";
  if (kinds.has("fn:create_lead") || kinds.has("fn:crm_upsert_lead") || kinds.has("fn:book_consultation") || booked || kinds.has("fn:create_checkout_session")) return "lead_captured";
  if (kinds.has("fn:request_callback")) return "callback_requested";
  const talked = (str(call, "transcript") ?? "").trim().length > 0 || [...kinds].some((k) => k.startsWith("fn:"));
  return talked ? "info_only" : "abandoned";
}

export type Translated =
  | { kind: "envelope"; body: string }
  | { kind: "ack"; body: Record<string, unknown>; status?: number };

/**
 * Production-safe separation: the inbound webhook and outbound creation stamp `metadata.crestmont_env`.
 * A call stamped for another environment (e.g. a staging agent pointed at production by mistake) is
 * refused here, before any business logic runs. Unstamped calls (dashboard web calls) are allowed.
 */
export function envMismatch(call: Obj, ctx: RetellCtx): string | null {
  const stamped = obj(call.metadata).crestmont_env;
  return typeof stamped === "string" && stamped !== ctx.environment ? stamped.slice(0, 20) : null;
}

const TRANSFER_EVENTS = new Set(["transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"]);
const num = (o: Obj, k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);

/** Retell call webhook (`{event, call}`) → Crestmont voice envelope JSON. */
export async function translateRetellEvent(db: Db, raw: string, ctx: RetellCtx): Promise<Translated> {
  const json = obj(JSON.parse(raw));
  const event = str(json, "event");
  const call = obj(json.call);
  const callId = callIdOf(call);
  const other = envMismatch(call, ctx);
  if (other) {
    await audit(db, { actorKind: "webhook", action: "voice.environment_mismatch", subjectType: "call", subjectId: callId, details: { stamped: other, here: ctx.environment, event } });
    return { kind: "ack", body: { ok: true, ignored: "environment_mismatch" } };
  }
  const base = {
    provider: RETELL_PROVIDER, call_id: callId, test: isTest(call), from_number: str(call, "from_number"), to_number: str(call, "to_number"),
    direction: str(call, "direction") === "outbound" ? "outbound" : "inbound", environment: str(obj(call.metadata), "crestmont_env"),
    outbound_request_id: str(obj(call.metadata), "crestmont_outbound_request_id"),
  };
  if (event && TRANSFER_EVENTS.has(event)) return transferEvent(db, event, call, callId, base);
  switch (event) {
    case "call_started":
      return { kind: "envelope", body: JSON.stringify({ ...base, event: "call_started", recording_consent: await consentFor(db, callId) }) };
    case "call_ended":
      return { kind: "envelope", body: JSON.stringify({
        ...base, event: "call_ended", outcome: await deriveOutcome(db, callId, call),
        recording_consent: await consentFor(db, callId),
        cost_microusd: retellCostMicroUsd(call) ?? undefined,
        duration_ms: num(call, "duration_ms"), disconnection_reason: str(call, "disconnection_reason"),
        // handleVoiceEvent discards these unless consent was recorded for the call (VOICE-006).
        transcript: str(call, "transcript"), recording_url: str(call, "recording_url"),
        error: str(call, "call_status") === "error" || (str(call, "disconnection_reason") ?? "").startsWith("error") ? `Retell: ${str(call, "disconnection_reason") ?? "error"}` : undefined,
      }) };
    case "call_analyzed": {
      // call_ended already closed the call in the voice service; analysis only fills two fields that
      // call_ended does not carry. The summary is written only when the call row records consent.
      const raw = str(obj(call.call_analysis), "call_summary");
      const summary = raw === undefined ? null : redactSensitive(raw.slice(0, 4000));
      const cost = retellCostMicroUsd(call);
      // Outbound cost often arrives only with the analysis; record it once on the request.
      if (cost !== null) await db.prepare(`UPDATE voice_outbound_requests SET cost_microusd = ? WHERE cost_microusd IS NULL AND id = (SELECT outbound_request_id FROM calls WHERE provider = ? AND provider_call_id = ?)`).bind(cost, RETELL_PROVIDER, callId).run();
      const res = await db.prepare(`UPDATE calls SET summary = CASE WHEN recording_consent = 1 AND summary IS NULL THEN ? ELSE summary END,
          cost_microusd = COALESCE(cost_microusd, ?) WHERE provider = ? AND provider_call_id = ?`).bind(summary, cost, RETELL_PROVIDER, callId).run();
      return { kind: "ack", body: { ok: true, applied: res.meta.changes === 1 } };
    }
    default:
      // transcript_updated, transfer_* and chat events are not used by the platform.
      return { kind: "ack", body: { ok: true, ignored: event ?? "unknown" } };
  }
}

/**
 * transfer_started / transfer_bridged / transfer_cancelled / transfer_ended. Deduplicated on
 * event + call_id + start_timestamp (+ destination), as Retell documents: a call can hold several attempts.
 * A cancelled (failed) transfer becomes a callback task and an Owner alert, so the caller is not lost.
 */
async function transferEvent(db: Db, event: string, call: Obj, callId: string, base: Record<string, unknown>): Promise<Translated> {
  const { call: row } = await ensureCall(db, RETELL_PROVIDER, callId, {
    from: base.from_number as string | undefined, to: base.to_number as string | undefined, direction: base.direction as "inbound" | "outbound",
    environment: base.environment as string | undefined, isTest: !!base.test, agentVersion: null,
  });
  const dest = obj(call.transfer_destination);
  const key = `${event}:${num(call, "start_timestamp") ?? ""}:${str(dest, "number") ?? ""}${str(dest, "extension") ?? ""}`;
  const fresh = await recordCallEvent(db, row.id, key, event, { event });
  if (!fresh) return { kind: "ack", body: { ok: true, duplicate: true } };
  if (event === "transfer_cancelled") {
    const who = str(call, "from_number") ?? "the caller";
    const text = `${base.test ? "[TEST] " : ""}A live transfer from the AI receptionist did not connect. Call back ${who} as soon as possible.`;
    if (row.lead_id) await addLeadTask(db, row.lead_id, text, 2);
    await notifyOwners(db, "voice_transfer_failed", text, "call", row.id);
  }
  return { kind: "ack", body: { ok: true, recorded: event } };
}

/**
 * Inbound call webhook (`{ event: "call_inbound", call_inbound: { call_id, from_number, to_number, agent_id? } }`),
 * configured per phone number in Retell. Answers within Retell's 10 s timeout with
 * `{ call_inbound: { dynamic_variables, metadata, override_agent_id? } }` or `{ call_inbound: { reject: true } }`.
 * Source (checked 2026-10-28): https://docs.retellai.com/features/inbound-call-webhook.md
 *
 * - Emergency stop: inbound.mode = "reject" hangs up before any agent runs.
 * - Number binding: once this environment lists its numbers, a call to any other number is rejected, so a
 *   number from another business or workspace can never reach Crestmont's data.
 * - The call is stamped with this environment (metadata.crestmont_env) for envMismatch().
 * - Dynamic variables are strings (Retell requirement). transfer_number is present only when a
 *   Founder-approved number is configured AND the business is open; otherwise it is an empty string.
 */
export async function translateRetellInbound(db: Db, raw: string, ctx: RetellCtx): Promise<Translated> {
  const json = obj(JSON.parse(raw));
  if (str(json, "event") !== "call_inbound") return { kind: "ack", body: {} };
  const inbound = obj(json.call_inbound);
  const callId = callIdOf(inbound);
  const to = str(inbound, "to_number") ?? "";
  const from = str(inbound, "from_number");
  const cfg = await loadVoiceConfig(db);
  const now = ctx.now?.() ?? new Date();
  const reject = async (why: string) => {
    await audit(db, { actorKind: "webhook", action: "voice.inbound_rejected", subjectType: "call", subjectId: callId, details: { why } });
    return { kind: "ack" as const, body: { call_inbound: { reject: true } } };
  };
  if (cfg.inbound.mode === "reject") return reject("receptionist paused");
  if (cfg.inbound.numbers.length && !cfg.inbound.numbers.includes(to)) return reject("number not bound to this environment");
  const { call: row } = await ensureCall(db, RETELL_PROVIDER, callId, { from: from && /^[+0-9 ().-]{7,40}$/.test(from) ? from : null, to: to || null, direction: "inbound", environment: ctx.environment, isTest: false, agentVersion: null });
  const h = hoursStatus(cfg, now);
  // Cost control (CREST-GAP-053): without an Owner budget, or once this month's spend reaches it, the call is
  // answered in "voicemail" mode only. The voice service also refuses every other function on such a call.
  const budget = await voiceBudget(db, now);
  const closed = !budgetOpen(budget);
  if (closed) {
    await recordCallEvent(db, row.id, VOICEMAIL_MODE_EVENT, "inbound_mode", { mode: "voicemail", budget: budget.state });
    await noteBudgetClosed(db, budget);
  }
  const t = closed ? { available: false } : transferAvailability(cfg, now);
  const body: Record<string, unknown> = {
    dynamic_variables: {
      crestmont_env: ctx.environment,
      receptionist_mode: closed ? "voicemail" : "full",
      business_open_now: String(h.open),
      business_hours_configured: String(h.configured),
      business_hours: describeHours(cfg),
      transfer_available: String(t.available),
      transfer_number: t.available ? cfg.transfer.number! : "",
      scheduling_available: String(!closed && cfg.scheduling.enabled && !!cfg.timezone),
    },
    metadata: { crestmont_env: ctx.environment },
  };
  if (cfg.inbound.agent_id) body.override_agent_id = cfg.inbound.agent_id;
  // Documented per-call overrides (agent_override.agent.max_call_duration_ms, agent_override.retell_llm.begin_message).
  if (closed) body.agent_override = { agent: { max_call_duration_ms: VOICEMAIL_MAX_CALL_MS }, retell_llm: { begin_message: VOICEMAIL_GREETING } };
  return { kind: "ack", body: { call_inbound: body } };
}

export const VOICEMAIL_MAX_CALL_MS = 180_000;
export const VOICEMAIL_GREETING = "Thank you for calling Crestmont Website Development. I'm an AI assistant and I can only take a message right now. Please tell me your name, your phone number and a short message, and a team member will call you back during staffed hours.";

/** Retell-only consent capture: the agent calls `record_consent` after asking the caller (VOICE-006). */
export const RETELL_ONLY_FUNCTIONS = ["record_consent"] as const;

/**
 * Retell custom function (`{name, call, args}`) → Crestmont `function_call` envelope.
 * Retell sends no invocation id, so the idempotency key is a hash of the function name and its
 * arguments: a retried request (max_retry) returns the stored result instead of acting twice.
 */
export async function translateRetellFunction(db: Db, raw: string, ctx: RetellCtx): Promise<Translated> {
  const json = obj(JSON.parse(raw));
  const name = str(json, "name");
  const call = obj(json.call);
  if (!name) throw new RetellPayloadError("name missing: configure the function with the default payload (not \"args only\")");
  const callId = callIdOf(call);
  const other = envMismatch(call, ctx);
  if (other) {
    await audit(db, { actorKind: "webhook", action: "voice.environment_mismatch", subjectType: "call", subjectId: callId, details: { stamped: other, here: ctx.environment, function: name.slice(0, 60) } });
    return { kind: "ack", status: 409, body: { result: { error: "This line is not set up correctly. Apologise and end the call politely." } } };
  }
  const args = obj(json.args);
  if (name === "record_consent") {
    if (typeof args.consent !== "boolean") throw new RetellPayloadError("args.consent must be true or false");
    // Grant-only, like the voice service: a later "false" never erases an earlier recorded "true".
    await db.prepare(`INSERT INTO retell_call_consents (provider_call_id, consent, recorded_at) VALUES (?,?,?)
        ON CONFLICT(provider_call_id) DO UPDATE SET consent = MAX(consent, excluded.consent), recorded_at = excluded.recorded_at`)
      .bind(callId, args.consent ? 1 : 0, nowIso()).run();
    return { kind: "ack", body: { ok: true, result: { recorded: true, message: args.consent ? "Thank you. This call may be recorded and transcribed." : "Understood. This call will not be recorded or transcribed." } } };
  }
  const eventId = `retell-${(await sha256Hex(`${name}\n${JSON.stringify(args)}`)).slice(0, 40)}`;
  return { kind: "envelope", body: JSON.stringify({
    provider: RETELL_PROVIDER, call_id: callId, event: "function_call", event_id: eventId, test: isTest(call), from_number: str(call, "from_number"),
    to_number: str(call, "to_number"), direction: str(call, "direction") === "outbound" ? "outbound" : "inbound", environment: str(obj(call.metadata), "crestmont_env"),
    function: { name: (VOICE_FUNCTIONS as readonly string[]).includes(name) ? name : name.slice(0, 60), arguments: args },
  }) };
}


// ───────────── Outbound API (create-phone-call) ─────────────
// Source (checked 2026-10-28): https://docs.retellai.com/api-references/create-phone-call.md
//  POST https://api.retellai.com/v2/create-phone-call, `Authorization: Bearer <API key>`, 201 → call object.
//  Fields used: from_number, to_number (E.164; Retell numbers dial US only), override_agent_id, metadata,
//  retell_llm_dynamic_variables (string values only), idempotency_key (5–255 chars [A-Za-z0-9_-]: repeating
//  the same key within an hour never creates a second call), honor_internal_dnc (400 when the contact is DNC).
//  Documented errors: 400, 401, 402, 422, 429, 500. Retell publishes no API rate-limit figure, so 429 and
//  5xx are retried a bounded number of times with the SAME idempotency key (safe by the contract above).
export const RETELL_API_BASE = "https://api.retellai.com";

export interface CreatePhoneCallRequest {
  from_number: string; to_number: string; override_agent_id?: string;
  metadata?: Record<string, string>; retell_llm_dynamic_variables?: Record<string, string>;
  idempotency_key: string; honor_internal_dnc?: boolean;
}
export type CreatePhoneCallResult =
  | { ok: true; callId: string; status: number; attempts: number }
  | { ok: false; status: number | null; retryable: boolean; error: string; attempts: number };

export async function createRetellPhoneCall(opts: {
  apiKey: string | undefined; fetch: typeof fetch; body: CreatePhoneCallRequest;
  timeoutMs?: number; maxRetries?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<CreatePhoneCallResult> {
  if (!opts.apiKey) return { ok: false, status: null, retryable: false, error: "RETELL_API_KEY is not configured", attempts: 0 };
  if (!/^[A-Za-z0-9_-]{5,255}$/.test(opts.body.idempotency_key)) return { ok: false, status: null, retryable: false, error: "invalid idempotency_key", attempts: 0 };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = Math.min(Math.max(opts.maxRetries ?? 2, 0), 3);
  let last: CreatePhoneCallResult = { ok: false, status: null, retryable: true, error: "not attempted", attempts: 0 };
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await opts.fetch(`${RETELL_API_BASE}/v2/create-phone-call`, {
        method: "POST", signal: ac.signal,
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(opts.body),
      });
      const text = await res.text();
      if (res.status === 201 || res.status === 200) {
        let id: unknown;
        try { id = (JSON.parse(text) as { call_id?: unknown }).call_id; } catch { /* handled below */ }
        if (typeof id === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(id)) return { ok: true, callId: id, status: res.status, attempts: attempt };
        return { ok: false, status: res.status, retryable: false, error: "Retell response had no valid call_id", attempts: attempt };
      }
      // Never echo the response body verbatim: it could contain request data. Keep a short, sanitised reason.
      const reason = text.replace(/[^\x20-\x7E]/g, " ").slice(0, 200);
      const retryable = res.status === 429 || res.status >= 500;
      last = { ok: false, status: res.status, retryable, error: `Retell ${res.status}: ${reason}`, attempts: attempt };
      if (!retryable) return last;
    } catch (e) {
      last = { ok: false, status: null, retryable: true, error: (e as Error).name === "AbortError" ? "Retell request timed out" : `Retell request failed: ${(e as Error).message}`.slice(0, 200), attempts: attempt };
    } finally {
      clearTimeout(timer);
    }
    if (attempt <= maxRetries) await sleep(500 * 2 ** (attempt - 1));
  }
  return last;
}

// ───────────── Prompt synchronisation API (CREST-GAP-053) ─────────────
// Sources (checked 2026-10-29):
//  - https://docs.retellai.com/api-references/get-agent         GET   /get-agent/{agent_id}
//      → { agent_id, version, is_published, response_engine: { type: "retell-llm", llm_id, version } | … }
//  - https://docs.retellai.com/api-references/update-retell-llm PATCH /update-retell-llm/{llm_id}  body { general_prompt }
//      → RetellLLMResponse { llm_id, version, is_published, general_prompt, last_modification_timestamp }
//  - https://docs.retellai.com/api-references/get-retell-llm    GET   /get-retell-llm/{llm_id}  (same response shape)
//  Auth `Authorization: Bearer <API key>`; errors `{ status: "error", message }` with 400/401/404/412/422/500.
// Only `general_prompt` is written. The agent is never published from here (publish-agent-version is a
// dashboard decision), so a push changes nothing beyond the LLM's draft prompt. Tests use a fake fetch;
// nothing in the test suite reaches api.retellai.com.

export type RetellApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number | null; error: string };

export interface RetellAgentInfo { agent_id?: string; version?: number; is_published?: boolean; response_engine?: { type?: string; llm_id?: string; version?: number } }
export interface RetellLlmInfo { llm_id?: string; version?: number; is_published?: boolean; general_prompt?: string | null }

const RETELL_ID = /^[A-Za-z0-9_-]{4,80}$/;

async function retellRequest<T>(opts: { apiKey: string; fetch: typeof fetch; method: "GET" | "PATCH"; path: string; body?: unknown; timeoutMs?: number }): Promise<RetellApiResult<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await opts.fetch(`${RETELL_API_BASE}${opts.path}`, {
      method: opts.method, signal: ac.signal,
      headers: { authorization: `Bearer ${opts.apiKey}`, ...(opts.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    if (res.status < 200 || res.status > 299) {
      let msg = "";
      try { const m = (JSON.parse(text) as { message?: unknown }).message; if (typeof m === "string") msg = m; } catch { /* not JSON */ }
      return { ok: false, status: res.status, error: `Retell ${res.status}${msg ? `: ${msg.replace(/[^\x20-\x7E]/g, " ").slice(0, 160)}` : ""}` };
    }
    try { return { ok: true, status: res.status, body: JSON.parse(text) as T }; } catch { return { ok: false, status: res.status, error: "Retell returned a response that is not JSON" }; }
  } catch (e) {
    return { ok: false, status: null, error: (e as Error).name === "AbortError" ? "Retell request timed out" : `Retell request failed: ${(e as Error).message}`.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export function getRetellAgent(o: { apiKey: string; fetch: typeof fetch; agentId: string }): Promise<RetellApiResult<RetellAgentInfo>> {
  if (!RETELL_ID.test(o.agentId)) return Promise.resolve({ ok: false, status: null, error: "invalid agent id" });
  return retellRequest<RetellAgentInfo>({ apiKey: o.apiKey, fetch: o.fetch, method: "GET", path: `/get-agent/${o.agentId}` });
}

export function getRetellLlm(o: { apiKey: string; fetch: typeof fetch; llmId: string }): Promise<RetellApiResult<RetellLlmInfo>> {
  if (!RETELL_ID.test(o.llmId)) return Promise.resolve({ ok: false, status: null, error: "invalid llm id" });
  return retellRequest<RetellLlmInfo>({ apiKey: o.apiKey, fetch: o.fetch, method: "GET", path: `/get-retell-llm/${o.llmId}` });
}

export function updateRetellLlmPrompt(o: { apiKey: string; fetch: typeof fetch; llmId: string; generalPrompt: string }): Promise<RetellApiResult<RetellLlmInfo>> {
  if (!RETELL_ID.test(o.llmId)) return Promise.resolve({ ok: false, status: null, error: "invalid llm id" });
  return retellRequest<RetellLlmInfo>({ apiKey: o.apiKey, fetch: o.fetch, method: "PATCH", path: `/update-retell-llm/${o.llmId}`, body: { general_prompt: o.generalPrompt } });
}
