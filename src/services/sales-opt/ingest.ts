// Retell call-event ingestion for the SALES agent (SALESOPT-001). Runs on POST /api/webhooks/retell AFTER the
// signature check and AFTER the existing voice handler (which owns the calls row, consent-gated transcript and
// CRM effects). It only records structured facts in so_call_facts; it never changes receptionist behaviour.
//
//  - Only calls whose agent_id is a registered sales target (so_targets) are recorded; everything else is ignored.
//  - Only events signed by the SALES (outbound) Retell workspace are recorded (src/adapters/retell-workspaces.ts). The
//    route accepts both workspaces' call events, so an event signed by the receptionist's key naming the sales agent id
//    (a mis-registered or receptionist-workspace agent) is refused and audited: it must never feed sales metrics,
//    experiments or the automatic safety rollback.
//  - Replay: an exact replay of an already-processed signed delivery (same X-Retell-Signature) is ignored.
//    The receipt is written only after successful processing, so a delivery that failed is processed on retry.
//  - Duplicates and out-of-order delivery: one row per call; each event has a rank (started 1 < ended 2 <
//    analyzed 3). A lower-ranked event arriving late only fills fields that are still empty.
//  - No tool arguments, phone numbers or transcripts are copied here. Transcripts stay in calls.transcript
//    (stored only with recording consent; purged by retention.voice_transcripts_days).
import type { Db } from "../../lib/db.ts";
import { nowIso } from "../../lib/db.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { audit } from "../security.ts";
import { ensureCall } from "../voice.ts";
import { envMismatch, RETELL_PROVIDER, type RetellCtx } from "../../adapters/retell.ts";
import { deployedVersion, stageForAgent } from "./registry.ts";
import type { RetellWorkspace } from "../../adapters/retell-workspaces.ts";

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const str = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const num = (o: Obj, k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);

export const EVENT_RANK: Readonly<Record<string, number>> = { call_started: 1, call_ended: 2, call_analyzed: 3 };

/** Disconnection reasons where nobody was reached (Retell call object, disconnection_reason). */
export const NOT_CONNECTED = new Set(["dial_failed", "dial_no_answer", "dial_busy", "voicemail_reached", "invalid_destination", "telephony_provider_permission_denied",
  "telephony_provider_unavailable", "sip_routing_error", "marked_as_spam", "user_declined", "network_blocked", "no_valid_payment", "concurrency_limit_reached", "scam_detected"]);

export type IngestResult = { recorded: false; reason: "not_sales_agent" | "wrong_workspace" | "environment_mismatch" | "unsupported_event" | "replay" } | { recorded: true; callId: string; stage: string; rank: number };

const SAFE = /^[A-Za-z0-9._:-]{1,120}$/;
const SEGMENT = /^[a-z0-9_-]{1,40}$/;

/** `workspace` is the Retell workspace whose key verified X-Retell-Signature (verifyRetellWorkspace); required, so a caller cannot skip it. */
export async function ingestSalesEvent(db: Db, raw: string, signatureHeader: string | null, ctx: RetellCtx, workspace: RetellWorkspace): Promise<IngestResult> {
  const json = obj(JSON.parse(raw));
  const event = str(json, "event") ?? "";
  const rank = EVENT_RANK[event];
  const call = obj(json.call);
  const stage = await stageForAgent(db, str(call, "agent_id"));
  if (!stage) return { recorded: false, reason: "not_sales_agent" };
  if (workspace !== "outbound") {
    await audit(db, { actorKind: "webhook", action: "salesopt.wrong_workspace", subjectType: "call", subjectId: str(call, "call_id")?.slice(0, 120) ?? null, details: { event: event.slice(0, 40), stage, workspace } });
    return { recorded: false, reason: "wrong_workspace" };
  }
  if (!rank) return { recorded: false, reason: "unsupported_event" };
  if (envMismatch(call, ctx)) return { recorded: false, reason: "environment_mismatch" };
  const receipt = await sha256Hex(`${signatureHeader ?? ""}`);
  if (signatureHeader && await db.prepare(`SELECT 1 AS x FROM so_webhook_receipts WHERE signature_sha256 = ?`).bind(receipt).first()) {
    await audit(db, { actorKind: "webhook", action: "salesopt.webhook_replay_ignored", subjectType: "call", subjectId: str(call, "call_id")?.slice(0, 120) ?? null, details: { event } });
    return { recorded: false, reason: "replay" };
  }
  const providerCallId = str(call, "call_id");
  if (!providerCallId || !SAFE.test(providerCallId)) throw new Error("call.call_id missing or invalid");
  const meta = obj(call.metadata);
  const isTest = str(call, "call_type") === "web_call" || meta.crestmont_test === true || meta.crestmont_test === "true";
  // Normally the voice handler already created the row; call_analyzed can arrive first, so make sure it exists.
  const { call: row } = await ensureCall(db, RETELL_PROVIDER, providerCallId, {
    direction: str(call, "direction") === "outbound" ? "outbound" : "inbound", isTest, agentVersion: null,
    environment: str(meta, "crestmont_env") ?? null,
  });

  // Server-side record of what the agent actually did (voice_events written by the voice service).
  const kinds = (await db.prepare(`SELECT kind, status FROM voice_events WHERE call_id = ? AND kind LIKE 'fn:%'`).bind(row.id).all<{ kind: string; status: string }>()).results;
  const tools = new Map<string, boolean>();
  for (const k of kinds) tools.set(k.kind.slice(3), (tools.get(k.kind.slice(3)) ?? false) || k.status === "ok");
  // Outbound sales agent (src/services/sales-functions.ts): its custom functions are recorded per Retell call id in
  // sales_function_events (refusals are stored as 'error', so a refused checkout never counts as generated).
  const salesFns = (await db.prepare(`SELECT name, status, result_json FROM sales_function_events WHERE provider_call_id = ?`).bind(providerCallId).all<{ name: string; status: string; result_json: string | null }>()).results;
  for (const f of salesFns) tools.set(f.name, (tools.get(f.name) ?? false) || f.status === "ok");
  const outboundLinkDelivered = salesFns.some((f) => f.status === "ok" && /"checkout_link_sent":true/.test(f.result_json ?? "") && /"delivery":"(sent|queued)"/.test(f.result_json ?? ""));
  // Retell built-in tools (end_call, transfer_call) appear only in transcript_with_tool_calls.
  for (const t of Array.isArray(call.transcript_with_tool_calls) ? call.transcript_with_tool_calls.slice(0, 500) : []) {
    const o = obj(t);
    if (str(o, "role") === "tool_call_invocation") {
      const name = str(o, "name");
      if (name && /^[a-z_]{2,40}$/.test(name) && !tools.has(name)) tools.set(name, true);
    }
  }
  const has = (n: string) => tools.has(n);
  const reason = str(call, "disconnection_reason");
  const callRow = await db.prepare(`SELECT lead_id, escalated_at, to_number FROM calls WHERE id = ?`).bind(row.id).first<{ lead_id: string | null; escalated_at: string | null; to_number: string | null }>();
  const dnc = callRow?.to_number ? !!(await db.prepare(`SELECT 1 AS x FROM voice_dnc WHERE phone_e164 = ?`).bind(callRow.to_number).first()) : false;
  const transfers = (await db.prepare(`SELECT COUNT(*) AS n FROM voice_events WHERE call_id = ? AND kind LIKE 'transfer_%'`).bind(row.id).first<{ n: number }>())!.n;
  const duration = num(call, "duration_ms") ?? (num(call, "end_timestamp") && num(call, "start_timestamp") ? num(call, "end_timestamp")! - num(call, "start_timestamp")! : undefined);
  const connected = rank >= 2 && reason ? (NOT_CONNECTED.has(reason) || reason.startsWith("error") ? 0 : 1) : null;

  // Version attribution: signed metadata from the platform wins (it set it when the call was created); otherwise
  // the version verified on this stage when the call was first seen.
  const metaVersion = str(meta, "crestmont_so_version");
  const versionId = metaVersion && /^sov_[A-Za-z0-9_-]{1,60}$/.test(metaVersion) && await db.prepare(`SELECT 1 AS x FROM so_versions WHERE id = ?`).bind(metaVersion).first()
    ? metaVersion : (await deployedVersion(db, stage))?.id ?? null;
  const expId = str(meta, "crestmont_so_experiment");
  const exp = expId && SAFE.test(expId) ? await db.prepare(`SELECT id, baseline_version_id, candidate_version_id FROM so_experiments WHERE id = ?`).bind(expId).first<{ id: string; baseline_version_id: string; candidate_version_id: string }>() : null;
  const arm = exp ? (versionId === exp.candidate_version_id ? "candidate" : versionId === exp.baseline_version_id ? "baseline" : null) : null;
  const metaLead = str(meta, "crestmont_lead_id");
  const leadId = callRow?.lead_id ?? (metaLead && SAFE.test(metaLead) && await db.prepare(`SELECT 1 AS x FROM leads WHERE id = ?`).bind(metaLead).first() ? metaLead : null);
  const seg = str(meta, "crestmont_segment");
  const analysis = obj(call.call_analysis);
  const sentiment = str(analysis, "user_sentiment");
  const iso = (ms: number | undefined) => (ms && ms > 1e12 && ms < 1e13 ? new Date(ms).toISOString() : null);
  const at = nowIso();

  await db.prepare(`INSERT INTO so_call_facts (call_id, provider_call_id, stage, agent_id, retell_agent_version, version_id, experiment_id, arm, lead_id, segment, is_test, started_at, ended_at, duration_ms,
        dial_outcome, connected, call_status, tools_json, pricing_discussed, checkout_link_generated, checkout_link_delivered, follow_up_requested, opt_out, human_escalation, user_sentiment, error, last_event, last_event_rank, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(call_id) DO UPDATE SET
        retell_agent_version = COALESCE(so_call_facts.retell_agent_version, excluded.retell_agent_version),
        version_id = COALESCE(so_call_facts.version_id, excluded.version_id),
        experiment_id = COALESCE(so_call_facts.experiment_id, excluded.experiment_id), arm = COALESCE(so_call_facts.arm, excluded.arm),
        lead_id = COALESCE(so_call_facts.lead_id, excluded.lead_id), segment = COALESCE(so_call_facts.segment, excluded.segment),
        started_at = COALESCE(so_call_facts.started_at, excluded.started_at),
        ended_at = CASE WHEN excluded.last_event_rank >= so_call_facts.last_event_rank THEN COALESCE(excluded.ended_at, so_call_facts.ended_at) ELSE COALESCE(so_call_facts.ended_at, excluded.ended_at) END,
        duration_ms = CASE WHEN excluded.last_event_rank >= so_call_facts.last_event_rank THEN COALESCE(excluded.duration_ms, so_call_facts.duration_ms) ELSE COALESCE(so_call_facts.duration_ms, excluded.duration_ms) END,
        dial_outcome = CASE WHEN excluded.last_event_rank >= so_call_facts.last_event_rank THEN COALESCE(excluded.dial_outcome, so_call_facts.dial_outcome) ELSE COALESCE(so_call_facts.dial_outcome, excluded.dial_outcome) END,
        connected = CASE WHEN excluded.last_event_rank >= so_call_facts.last_event_rank THEN COALESCE(excluded.connected, so_call_facts.connected) ELSE COALESCE(so_call_facts.connected, excluded.connected) END,
        call_status = CASE WHEN excluded.last_event_rank >= so_call_facts.last_event_rank THEN COALESCE(excluded.call_status, so_call_facts.call_status) ELSE COALESCE(so_call_facts.call_status, excluded.call_status) END,
        tools_json = CASE WHEN length(excluded.tools_json) >= length(so_call_facts.tools_json) THEN excluded.tools_json ELSE so_call_facts.tools_json END,
        pricing_discussed = MAX(so_call_facts.pricing_discussed, excluded.pricing_discussed),
        checkout_link_generated = MAX(so_call_facts.checkout_link_generated, excluded.checkout_link_generated),
        checkout_link_delivered = MAX(so_call_facts.checkout_link_delivered, excluded.checkout_link_delivered),
        follow_up_requested = MAX(so_call_facts.follow_up_requested, excluded.follow_up_requested),
        opt_out = MAX(so_call_facts.opt_out, excluded.opt_out), human_escalation = MAX(so_call_facts.human_escalation, excluded.human_escalation),
        user_sentiment = COALESCE(excluded.user_sentiment, so_call_facts.user_sentiment), error = COALESCE(so_call_facts.error, excluded.error),
        last_event = CASE WHEN excluded.last_event_rank > so_call_facts.last_event_rank THEN excluded.last_event ELSE so_call_facts.last_event END,
        last_event_rank = MAX(so_call_facts.last_event_rank, excluded.last_event_rank), updated_at = excluded.updated_at`)
    .bind(row.id, providerCallId, stage, str(call, "agent_id")!, num(call, "agent_version") ?? null, versionId, exp?.id ?? null, arm, leadId,
      seg && SEGMENT.test(seg) ? seg : null, isTest ? 1 : 0, iso(num(call, "start_timestamp")) ?? (rank === 1 ? at : null), iso(num(call, "end_timestamp")) ?? (rank >= 2 ? at : null),
      duration !== undefined && duration >= 0 ? Math.round(duration) : null, rank >= 2 ? (reason && /^[a-z_]{1,60}$/.test(reason) ? reason : null) : null, connected,
      str(call, "call_status")?.slice(0, 30) ?? null, JSON.stringify([...tools].map(([name, ok]) => ({ name, ok })).slice(0, 60)),
      // Receptionist-vocabulary names (the original sales-agent contract) and the outbound sales agent's names are both recognised.
      has("get_published_pricing") || has("get_packages_pricing") ? 1 : 0,
      has("send_checkout_link") || tools.get("create_checkout_session") === true ? 1 : 0,
      tools.get("send_checkout_link") === true || outboundLinkDelivered ? 1 : 0,
      has("request_callback") || has("book_consultation") || tools.get("schedule_sales_followup") === true ? 1 : 0,
      has("record_opt_out") || has("record_do_not_call") || reason === "user_requested_dnc" || dnc ? 1 : 0,
      has("escalate") || has("transfer_call") || transfers > 0 || !!callRow?.escalated_at ? 1 : 0,
      sentiment && /^[A-Za-z ]{1,20}$/.test(sentiment) ? sentiment : null,
      str(call, "call_status") === "error" || (reason ?? "").startsWith("error") ? `Retell: ${(reason ?? "error").slice(0, 80)}` : null, event, rank, at).run();

  if (signatureHeader) {
    await db.prepare(`INSERT INTO so_webhook_receipts (signature_sha256, event, provider_call_id, received_at) VALUES (?,?,?,?) ON CONFLICT(signature_sha256) DO NOTHING`)
      .bind(receipt, event, providerCallId, at).run();
  }
  return { recorded: true, callId: row.id, stage, rank };
}

/** Receipts older than the signature tolerance window can no longer be replayed (the signature check rejects them). */
export async function pruneReceipts(db: Db, now = new Date()): Promise<number> {
  return (await db.prepare(`DELETE FROM so_webhook_receipts WHERE received_at < ?`).bind(new Date(now.getTime() - 24 * 3_600_000).toISOString()).run()).meta.changes;
}
