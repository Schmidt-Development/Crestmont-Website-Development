// AI receptionist back end (VOICE-003..006, §52–§53). Provider-agnostic: whichever provider the
// Founder approves (docs/voice/PROVIDER-EVALUATION.md) is configured to POST signed JSON events to
// /api/webhooks/voice. Until then no provider is connected (BLK-009) and the endpoint fails closed
// unless VOICE_WEBHOOK_SECRET is set.
//
// Signature: header `x-crestmont-voice-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` over
// `${t}.${rawBody}` with VOICE_WEBHOOK_SECRET (same scheme as src/readiness/ingest.ts). A thin
// provider-specific adapter (or the provider's own custom-function feature) produces this envelope.
//
// Guardrails are enforced in code, not only in the prompt:
//  - get_published_pricing returns ONLY catalog package prices, maintenance monthly prices and the
//    payment rules. Maintenance entitlements (pending Founder approval, CAT-006) are never returned.
//  - route_support opens a ticket only for a caller matched by verified account email AND phone,
//    and the spoken response is identical whether or not a match was found (no account enumeration,
//    no customer information returned).
//  - No function exists for refunds, agreements, pricing changes, project status or delivery dates.
//  - Transcripts, summaries and recordings are stored only when recording_consent is true.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { hmacSha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import { parse, v, ValidationError } from "../lib/validate.ts";
import { PACKAGES, MAINTENANCE_PLANS, APPROVED_SERVICES } from "../domain/catalog.ts";
import { audit } from "./security.ts";
import { effectivePrices } from "./pricing-approvals.ts";

export class VoiceAuthError extends Error {}

export const CALL_OUTCOMES = ["lead_captured", "callback_requested", "support_routed", "escalated", "info_only", "abandoned", "error"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const VOICE_FUNCTIONS = ["get_published_pricing", "create_lead", "request_callback", "route_support", "escalate"] as const;
export type VoiceFunction = (typeof VOICE_FUNCTIONS)[number];

export async function signVoiceEvent(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export async function verifyVoiceSignature(secret: string | undefined, body: string, header: string | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!secret) throw new VoiceAuthError("Voice webhook secret not configured");
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) throw new VoiceAuthError("Missing or malformed signature");
  if (Math.abs(nowSeconds - Number(m[1])) > 300) throw new VoiceAuthError("Signature timestamp outside tolerance");
  if (!timingSafeEqualHex(m[2], await hmacSha256Hex(secret, `${m[1]}.${body}`))) throw new VoiceAuthError("Signature mismatch");
}

const idPattern = /^[A-Za-z0-9._:-]{1,120}$/;
const phonePattern = /^[+0-9 ().-]{7,40}$/;

const envelope = v.object({
  event: v.enumOf(["call_started", "call_ended", "function_call"] as const),
  provider: v.string({ min: 2, max: 40, pattern: /^[a-z0-9_-]+$/ }),
  call_id: v.string({ pattern: idPattern }),
  event_id: v.string({ optional: true, pattern: idPattern }),
  test: v.enumOf(["true", "false"] as const, { optional: true }),
});

export interface VoiceResult { status: number; body: Record<string, unknown> }

/**
 * Published pricing facts for the receptionist. Maintenance entitlements are deliberately absent.
 * `effective` (CREST-GAP-080): Founder-approved effective prices keyed "package:<id>" / "maintenance:<id>"
 * (src/services/pricing-approvals.ts effectivePrices); without it the catalog prices are used.
 */
export function publishedPricing(effective: Record<string, number> = {}) {
  const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const pk = (id: string, catalog: number) => effective[`package:${id}`] ?? catalog;
  const mt = (id: string, catalog: number) => effective[`maintenance:${id}`] ?? catalog;
  return {
    packages: Object.values(PACKAGES).map((p) => ({
      name: p.name, price: `${dollars(pk(p.id, p.basePriceCents))}${p.priceIsFloor ? "+" : ""}`, priceCents: pk(p.id, p.basePriceCents), startingPrice: p.priceIsFloor,
      pageLimit: p.pageLimit, revisionRounds: p.revisionRounds,
    })),
    customDevelopment: "Quoted separately after a scoping conversation; no price is given by phone.",
    maintenance: Object.values(MAINTENANCE_PLANS).map((m) => ({ name: m.name, monthly: `${dollars(mt(m.id, m.monthlyCents))}/month`, monthlyCents: mt(m.id, m.monthlyCents) })),
    maintenanceNote: "Plan details are being finalised. A team member will confirm what each plan includes.",
    paymentRules: "Standard packages are paid 100% upfront. Custom development is billed 50% deposit, 25% at design approval and 25% before launch.",
    services: [...APPROVED_SERVICES],
    rules: "Quote only these figures. Do not estimate, discount, or promise delivery dates.",
  };
}

const AMOUNTS_ALLOWED = (() => {
  const s = new Set<number>();
  for (const p of Object.values(PACKAGES)) s.add(p.basePriceCents);
  for (const m of Object.values(MAINTENANCE_PLANS)) s.add(m.monthlyCents);
  return s;
})();

/** Dollar amounts in text that are not catalog prices (used to reject invented pricing in agent configs). */
export function inventedPrices(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)) {
    const cents = Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2]) : 0);
    if (!AMOUNTS_ALLOWED.has(cents)) out.push(m[0]);
  }
  return out;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

interface CallRow { id: string; provider: string; provider_call_id: string; lead_id: string | null; recording_consent: number; is_test: number; ended_at: string | null }

async function ensureCall(db: Db, provider: string, providerCallId: string, data: { from?: string | null; consent?: boolean; isTest: boolean; agentVersion: number | null }): Promise<{ call: CallRow; created: boolean }> {
  const at = nowIso();
  const res = await db.prepare(`INSERT INTO calls (id, provider, provider_call_id, from_number, direction, recording_consent, started_at, is_test, agent_config_version, created_at)
      VALUES (?,?,?,?, 'inbound', ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_call_id) DO NOTHING`)
    .bind(newId("call"), provider, providerCallId, data.from ?? null, data.consent ? 1 : 0, at, data.isTest ? 1 : 0, data.agentVersion, at).run();
  const call = await db.prepare(`SELECT id, provider, provider_call_id, lead_id, recording_consent, is_test, ended_at FROM calls WHERE provider = ? AND provider_call_id = ?`).bind(provider, providerCallId).first<CallRow>();
  return { call: call!, created: res.meta.changes === 1 };
}

async function activeAgentVersion(db: Db): Promise<number | null> {
  return (await db.prepare(`SELECT version FROM voice_agent_configs WHERE active = 1`).first<{ version: number }>())?.version ?? null;
}

/** Claims an event key for a call. Returns the stored result when the event was already processed. */
async function claimEvent(db: Db, callId: string, key: string, kind: string): Promise<{ duplicate: true; result: Record<string, unknown> } | { duplicate: false; eventId: string }> {
  const id = newId("vev");
  const res = await db.prepare(`INSERT INTO voice_events (id, call_id, event_key, kind, status, created_at) VALUES (?,?,?,?, 'ok', ?) ON CONFLICT(call_id, event_key) DO NOTHING`)
    .bind(id, callId, key, kind, nowIso()).run();
  if (res.meta.changes === 1) return { duplicate: false, eventId: id };
  const prev = await db.prepare(`SELECT result_json FROM voice_events WHERE call_id = ? AND event_key = ?`).bind(callId, key).first<{ result_json: string | null }>();
  return { duplicate: true, result: prev?.result_json ? JSON.parse(prev.result_json) : {} };
}

async function finishEvent(db: Db, eventId: string, status: "ok" | "error", result: Record<string, unknown>, detail?: string) {
  await db.prepare(`UPDATE voice_events SET status = ?, result_json = ?, detail = ? WHERE id = ?`).bind(status, JSON.stringify(result), detail?.slice(0, 1000) ?? null, eventId).run();
}

/** Creates (or reuses) the lead attached to this call so tasks and callbacks have a CRM home. */
async function createCallLead(db: Db, call: CallRow, c: { name: string; email?: string | null; phone?: string | null; company?: string | null; interest: string; message: string }): Promise<string> {
  const at = nowIso();
  const contactId = newId("ct"), leadId = newId("ld");
  const companyId = c.company ? newId("co") : null;
  const label = call.is_test ? "[TEST CALL] " : "";
  await db.batch([
    ...(companyId ? [db.prepare(`INSERT INTO companies (id, name, created_at) VALUES (?,?,?)`).bind(companyId, c.company, at)] : []),
    db.prepare(`INSERT INTO contacts (id, company_id, name, email, phone, created_at) VALUES (?,?,?,?,?,?)`).bind(contactId, companyId, c.name, c.email ? c.email.trim().toLowerCase() : null, c.phone ?? null, at), // CREST-GAP-093
    db.prepare(`INSERT INTO leads (id, contact_id, source, stage, interest, message, created_at, updated_at) VALUES (?,?,'ai_receptionist','new',?,?,?,?)`).bind(leadId, contactId, c.interest, label + c.message, at, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'call',?,?)`).bind(newId("act"), leadId, `${label}Lead captured by AI receptionist (call ${call.provider_call_id})`, at),
    db.prepare(`UPDATE calls SET lead_id = COALESCE(lead_id, ?) WHERE id = ?`).bind(leadId, call.id),
  ]);
  await audit(db, { actorKind: "ai", action: "lead.created", subjectType: "lead", subjectId: leadId, details: { source: "ai_receptionist", call: call.id, test: !!call.is_test } });
  return leadId;
}

async function addTask(db: Db, leadId: string, body: string, dueHours = 24) {
  await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, due_at, created_at) VALUES (?,?,'task',?,?,?)`)
    .bind(newId("act"), leadId, body.slice(0, 2000), new Date(Date.now() + dueHours * 3600e3).toISOString(), nowIso()).run();
}

async function notifyOwners(db: Db, body: string, subjectId: string) {
  const owners = (await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id IN ('owner') AND u.disabled_at IS NULL`).all<{ user_id: string }>()).results;
  for (const o of owners) {
    await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,'voice_escalation','call',?,?,?)`)
      .bind(newId("ntf"), o.user_id, subjectId, body.slice(0, 500), nowIso()).run();
  }
}

const SUPPORT_RESPONSE = "Thank you. I've passed this to our support team. If we can match it to an existing account, they'll follow up through that account; otherwise someone will call you back during staffed hours.";

const fnSchemas = {
  get_published_pricing: v.object({}),
  create_lead: v.object({
    name: v.string({ min: 2, max: 120 }),
    email: v.email({ optional: true }),
    phone: v.string({ optional: true, pattern: phonePattern }),
    company: v.string({ optional: true, max: 160 }),
    interest: v.enumOf(["starter", "business", "premium", "custom", "maintenance", "other"] as const),
    requirements: v.string({ min: 5, max: 5000 }),
  }),
  request_callback: v.object({
    name: v.string({ min: 2, max: 120 }),
    phone: v.string({ pattern: phonePattern }),
    reason: v.string({ min: 3, max: 2000 }),
    preferred_time: v.string({ optional: true, max: 120 }),
  }),
  route_support: v.object({
    name: v.string({ min: 2, max: 120 }),
    email: v.email(),
    phone: v.string({ pattern: phonePattern }),
    summary: v.string({ min: 5, max: 4000 }),
  }),
  escalate: v.object({
    reason: v.string({ min: 3, max: 2000 }),
    name: v.string({ optional: true, max: 120 }),
    phone: v.string({ optional: true, pattern: phonePattern }),
  }),
};

async function runFunction(db: Db, call: CallRow, name: VoiceFunction, rawArgs: unknown): Promise<Record<string, unknown>> {
  switch (name) {
    case "get_published_pricing":
      return { pricing: publishedPricing(await effectivePrices(db)) }; // CREST-GAP-080
    case "create_lead": {
      const a = parse(fnSchemas.create_lead, rawArgs ?? {});
      if (!a.email && !a.phone) throw new ValidationError(["email or phone is required"]);
      if (call.lead_id) {
        await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'call',?,?)`).bind(newId("act"), call.lead_id, `Additional requirements from caller: ${a.requirements}`.slice(0, 4000), nowIso()).run();
        return { leadCreated: false, message: "Thanks, I've added that to your request." };
      }
      await createCallLead(db, call, { name: a.name, email: a.email, phone: a.phone, company: a.company, interest: a.interest, message: a.requirements });
      return { leadCreated: true, message: "Thank you. A Crestmont team member will follow up. I can't confirm prices beyond our published packages or commit to dates." };
    }
    case "request_callback": {
      const a = parse(fnSchemas.request_callback, rawArgs ?? {});
      const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name, phone: a.phone, interest: "other", message: `Callback requested: ${a.reason}` });
      await addTask(db, leadId, `Call back ${a.name} at ${a.phone}${a.preferred_time ? ` (preferred: ${a.preferred_time})` : ""}: ${a.reason}`);
      return { callbackRequested: true, message: "Thanks. Someone will call you back during staffed hours." };
    }
    case "route_support": {
      const a = parse(fnSchemas.route_support, rawArgs ?? {});
      // Match only on a verified account email AND a phone recorded on that user's CRM contact.
      const user = await db.prepare(`SELECT u.id FROM users u WHERE u.email = ? AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL`).bind(a.email.trim().toLowerCase()).first<{ id: string }>();
      let orgId: string | null = null;
      if (user) {
        const phones = (await db.prepare(`SELECT phone FROM contacts WHERE user_id = ? AND phone IS NOT NULL`).bind(user.id).all<{ phone: string }>()).results;
        const phoneOk = phones.some((p) => digits(p.phone).length >= 7 && digits(p.phone) === digits(a.phone));
        if (phoneOk) {
          orgId = (await db.prepare(`SELECT m.organization_id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND o.kind = 'customer' ORDER BY m.created_at LIMIT 1`).bind(user.id).first<{ organization_id: string }>())?.organization_id ?? null;
        }
      }
      if (user && orgId) {
        const at = nowIso(), ticketId = newId("tkt");
        await db.batch([
          db.prepare(`INSERT INTO tickets (id, organization_id, subject, category, priority, status, opened_by, created_at, updated_at) VALUES (?,?,?, 'other', 'normal', 'open', ?, ?, ?)`)
            .bind(ticketId, orgId, `${call.is_test ? "[TEST CALL] " : ""}Phone support request`, user.id, at, at),
          db.prepare(`INSERT INTO ticket_messages (id, ticket_id, author_user_id, body, internal, created_at) VALUES (?,?,NULL,?,0,?)`)
            .bind(newId("tm"), ticketId, `Received by the AI receptionist (call ${call.provider_call_id}). Caller's description: ${a.summary}`, at),
          db.prepare(`UPDATE calls SET outcome = COALESCE(outcome, 'support_routed') WHERE id = ?`).bind(call.id),
        ]);
        await audit(db, { actorKind: "ai", action: "ticket.created_by_receptionist", subjectType: "ticket", subjectId: ticketId, organizationId: orgId, details: { call: call.id } });
      } else {
        const leadId = call.lead_id ?? await createCallLead(db, call, { name: a.name, email: a.email, phone: a.phone, interest: "other", message: `Support callback (caller not matched to an account): ${a.summary}` });
        await addTask(db, leadId, `Support callback for ${a.name} at ${a.phone}. Caller could not be matched to an account by verified email and phone — verify identity before discussing any account details.`);
      }
      // Identical response in both branches: never confirms whether an account exists.
      return { received: true, message: SUPPORT_RESPONSE };
    }
    case "escalate": {
      const a = parse(fnSchemas.escalate, rawArgs ?? {});
      await db.prepare(`UPDATE calls SET escalated_at = COALESCE(escalated_at, ?) WHERE id = ?`).bind(nowIso(), call.id).run();
      const leadId = call.lead_id ?? (a.phone ? await createCallLead(db, call, { name: a.name ?? "Unknown caller", phone: a.phone, interest: "other", message: `Escalated call: ${a.reason}` }) : null);
      if (leadId) await addTask(db, leadId, `ESCALATION from AI receptionist: ${a.reason}`, 4);
      await notifyOwners(db, `${call.is_test ? "[TEST] " : ""}AI receptionist escalated a call: ${a.reason}`, call.id);
      await audit(db, { actorKind: "ai", action: "call.escalated", subjectType: "call", subjectId: call.id });
      return { escalated: true, message: "I'm passing this to a member of the Crestmont team who will follow up during staffed hours." };
    }
  }
}

/** Handles one verified webhook event. The caller has already checked the signature. */
export async function handleVoiceEvent(db: Db, rawBody: string): Promise<VoiceResult> {
  const json = JSON.parse(rawBody) as Record<string, unknown>;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ValidationError(["Event body must be a JSON object"]);
  const base = parse(envelope, { ...json, test: json.test === undefined ? undefined : String(json.test) });
  const isTest = base.test === "true";
  const consent = json.recording_consent === true;
  const from = typeof json.from_number === "string" && phonePattern.test(json.from_number) ? json.from_number : null;
  const { call } = await ensureCall(db, base.provider, base.call_id, { from, consent, isTest, agentVersion: await activeAgentVersion(db) });

  if (base.event === "call_started") {
    const claim = await claimEvent(db, call.id, "call_started", "call_started");
    if (claim.duplicate) return { status: 200, body: { ok: true, duplicate: true, callId: call.id } };
    // A later call_started can only grant consent, never silently revoke an earlier recorded one.
    if (consent) await db.prepare(`UPDATE calls SET recording_consent = 1 WHERE id = ?`).bind(call.id).run();
    await finishEvent(db, claim.eventId, "ok", { callId: call.id });
    return { status: 200, body: { ok: true, callId: call.id } };
  }

  if (base.event === "call_ended") {
    const claim = await claimEvent(db, call.id, "call_ended", "call_ended");
    if (claim.duplicate) return { status: 200, body: { ok: true, duplicate: true, callId: call.id } };
    const outcome = parse(v.enumOf(CALL_OUTCOMES), json.outcome);
    const consentNow = consent || call.recording_consent === 1;
    const cost = typeof json.cost_microusd === "number" && Number.isInteger(json.cost_microusd) && json.cost_microusd >= 0 ? json.cost_microusd : null;
    const str = (k: string, max: number) => (typeof json[k] === "string" ? (json[k] as string).slice(0, max) : null);
    const recording = str("recording_url", 500);
    const keep = consentNow;
    const discarded = !keep && (json.transcript || json.recording_url || json.summary) ? "transcript/recording/summary discarded: no recording consent" : undefined;
    await db.prepare(`UPDATE calls SET outcome = ?, ended_at = ?, cost_microusd = ?, recording_consent = ?, transcript = ?, recording_url = ?, summary = ?, error = ? WHERE id = ?`)
      .bind(outcome, nowIso(), cost, consentNow ? 1 : 0,
        keep ? str("transcript", 100_000) : null,
        keep && recording && /^https:\/\//.test(recording) ? recording : null,
        keep ? str("summary", 4000) : null,
        outcome === "error" ? (str("error", 1000) ?? "Provider reported an error") : null, call.id).run();
    await finishEvent(db, claim.eventId, "ok", { callId: call.id, outcome }, discarded);
    if (call.lead_id) {
      await db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'call',?,?)`).bind(newId("act"), call.lead_id, `Call ended · outcome: ${outcome}`, nowIso()).run();
    }
    return { status: 200, body: { ok: true, callId: call.id, outcome } };
  }

  // function_call
  const fn = parse(v.enumOf(VOICE_FUNCTIONS), (json.function as { name?: unknown } | undefined)?.name);
  if (!base.event_id) throw new ValidationError(["event_id is required for function calls (idempotency key)"]);
  const claim = await claimEvent(db, call.id, `fn:${base.event_id}`, `fn:${fn}`);
  if (claim.duplicate) return { status: 200, body: { ok: true, duplicate: true, result: claim.result } };
  try {
    const result = await runFunction(db, call, fn, (json.function as { arguments?: unknown }).arguments);
    await finishEvent(db, claim.eventId, "ok", result);
    return { status: 200, body: { ok: true, result } };
  } catch (e) {
    const msg = e instanceof ValidationError ? e.issues.join("; ") : (e as Error).message;
    const result = { error: "I couldn't complete that. A team member will follow up.", detail: e instanceof ValidationError ? msg : undefined };
    await finishEvent(db, claim.eventId, "error", result, msg);
    if (!(e instanceof ValidationError)) await db.prepare(`UPDATE calls SET error = ? WHERE id = ?`).bind(`${fn}: ${msg}`.slice(0, 1000), call.id).run();
    return { status: e instanceof ValidationError ? 422 : 500, body: { ok: false, result } };
  }
}

// ───────────── Agent configuration (VOICE-004) ─────────────

/** Non-negotiable guardrails, always prepended to every configuration version. */
export const VOICE_GUARDRAILS = `GUARDRAILS (platform-enforced; cannot be edited):
1. Identify yourself at the start of every call as an AI assistant for Crestmont Website Development, not a person.
2. Explain Crestmont's services and ONLY the published pricing returned by get_published_pricing. Never invent, estimate, discount or negotiate prices. Custom development is quoted separately by a person.
3. Never guarantee or estimate delivery dates, launch dates or timelines.
4. Never agree to, sign, or execute any agreement, contract, quote or change order.
5. Never approve, promise or process refunds, credits or cancellations; record the request and escalate.
6. Never reveal any customer's information (names, projects, invoices, account status, whether an account exists). Support requests go through route_support only.
7. Never describe or speculate about the status of any project.
8. Ask for consent before recording or transcribing; if the caller declines, continue without recording.
9. When unsure, or when the caller asks for a person, use escalate or request_callback.`;

export function defaultAgentPrompt(): string {
  return `You are the AI receptionist for Crestmont Website Development, a website design and development company.
Greet the caller, say you are an AI assistant, and ask how you can help.
Answer questions about services and published packages using get_published_pricing.
For new projects, collect the caller's name, email or phone, business name, which package interests them (or custom work) and their requirements, then call create_lead.
If the caller wants to speak to someone, call request_callback. For existing-customer support, call route_support. For anything complex, sensitive or outside these rules, call escalate.
Keep answers short and accurate. Staffed hours are published on the website; human staff are not available around the clock.`;
}

export function composePrompt(instructions: string): string {
  return `${VOICE_GUARDRAILS}\n\nINSTRUCTIONS:\n${instructions.trim()}`;
}

export function instructionsOf(promptText: string): string {
  const i = promptText.indexOf("\n\nINSTRUCTIONS:\n");
  return i >= 0 ? promptText.slice(i + "\n\nINSTRUCTIONS:\n".length) : promptText;
}

const CONTRADICTIONS = [
  /\b(i am|i'm) (a )?(human|real person)\b/i, /\bguarantee/i, /\brefund(s)? (are|is) approved\b/i, /\bapprove (the |a )?refund/i,
  /\bsign (the |an? )?(contract|agreement)\b/i, /\b24\/7 (human|live|staff)/i, /\bdiscount/i,
];

export function configProblems(instructions: string): string[] {
  const p: string[] = [];
  const t = instructions.trim();
  if (t.length < 40) p.push("Instructions are too short.");
  if (t.length > 8000) p.push("Instructions must be at most 8,000 characters.");
  const bad = inventedPrices(t);
  if (bad.length) p.push(`Instructions mention prices that are not published catalog prices: ${bad.join(", ")}.`);
  for (const re of CONTRADICTIONS) if (re.test(t)) p.push(`Instructions contradict a guardrail (matched “${re.source}”).`);
  return p;
}

export async function createAgentConfig(db: Db, userId: string, instructions: string, note: string): Promise<{ id: string; version: number }> {
  const problems = configProblems(instructions);
  if (note.trim().length < 3) problems.push("Describe what changed in this version.");
  if (problems.length) throw new ValidationError(problems);
  const last = await db.prepare(`SELECT MAX(version) AS v FROM voice_agent_configs`).first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;
  const id = newId("vac");
  await db.prepare(`INSERT INTO voice_agent_configs (id, version, prompt_text, change_note, created_by, created_at, active) VALUES (?,?,?,?,?,?,0)`)
    .bind(id, version, composePrompt(instructions), note.trim().slice(0, 300), userId, nowIso()).run();
  await audit(db, { actorUserId: userId, action: "voice.config_version_created", subjectType: "voice_agent_config", subjectId: id, details: { version } });
  return { id, version };
}

export async function activateAgentConfig(db: Db, userId: string, version: number): Promise<void> {
  const row = await db.prepare(`SELECT id, prompt_text FROM voice_agent_configs WHERE version = ?`).bind(version).first<{ id: string; prompt_text: string }>();
  if (!row) throw Object.assign(new Error("Version not found"), { status: 404 });
  if (!row.prompt_text.startsWith(VOICE_GUARDRAILS)) throw Object.assign(new Error("This version does not contain the platform guardrails and cannot be activated."), { status: 409 });
  await db.batch([
    db.prepare(`UPDATE voice_agent_configs SET active = 0 WHERE active = 1`),
    db.prepare(`UPDATE voice_agent_configs SET active = 1, activated_by = ?, activated_at = ? WHERE id = ?`).bind(userId, nowIso(), row.id),
  ]);
  await audit(db, { actorUserId: userId, action: "voice.config_activated", subjectType: "voice_agent_config", subjectId: row.id, details: { version } });
}

export interface DiffLine { op: " " | "+" | "-"; text: string }

/** Line diff (LCS). Inputs are bounded by configProblems (≤ 8,000 chars). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: " ", text: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}
