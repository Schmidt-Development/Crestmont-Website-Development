// AI receptionist operations (Owner only: voice.manage). Business hours, transfer, inbound number binding,
// phone scheduling and outbound switches; consultation and outbound-call queues; do-not-call; caller erasure;
// and the call analytics the Owner dashboard needs.
//  GET  /staff/voice/operations
//  POST /staff/voice/operations/settings
//  POST /staff/voice/consultations/:id/decide      decision=confirm|cancel
//  POST /staff/voice/outbound                      new outbound request (awaits approval)
//  POST /staff/voice/outbound/:id/decide           decision=approve|cancel
//  POST /staff/voice/dnc                           add a number to the do-not-call list
//  POST /staff/voice/caller-erasure                erase receptionist data for one phone number
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label } from "../lib/html.ts";
import { HttpError, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { csrf, input, textarea, select, checkbox, button, formErrors, alert, badge, table, emptyState, kpi, pageHead, linkButton } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import {
  loadVoiceConfig, saveVoiceConfig, VoiceConfigError, WEEKDAYS, hoursStatus, describeHours, OUTBOUND_PURPOSES,
  type VoiceConfig, type Weekday, type OutboundPurpose,
} from "../services/voice-settings.ts";
import * as sched from "../services/voice-scheduling.ts";
import * as outbound from "../services/voice-outbound.ts";
import { voiceAnalytics, eraseCallerData } from "../services/voice-ops.ts";
import { sendMail } from "../services/mailer.ts";
import { jsonResponse } from "../app/http.ts";
import { readBody } from "./api.ts";
import { verifyEvidenceSignature, IngestAuthError } from "../readiness/ingest.ts";
import { rateLimit, audit } from "../services/security.ts";
import { auditInboundRetell } from "../services/retell-inbound-audit.ts";

const DAY_LABEL: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const microUsd = (v: number) => `$${(v / 1e6).toFixed(4)}`;
const lines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const windowsText = (c: VoiceConfig, d: Weekday) => c.hours[d].map((w) => `${w.open}-${w.close}`).join(", ");

function parseWindows(text: string): { open: string; close: string }[] | null {
  const out: { open: string; close: string }[] = [];
  for (const part of lines(text)) {
    const m = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(part);
    if (!m) return null;
    const pad = (t: string) => t.padStart(5, "0");
    out.push({ open: pad(m[1]), close: pad(m[2]) });
  }
  return out;
}

/** Builds a candidate configuration from the form. Returns problems for unparseable fields; the service validates the rest. */
function configFromForm(f: FormData, prev: VoiceConfig): { cfg: VoiceConfig; problems: string[] } {
  const problems: string[] = [];
  const hours = { ...prev.hours };
  for (const d of WEEKDAYS) {
    const w = parseWindows(str(f, `hours.${d}`));
    if (w === null) problems.push(`${DAY_LABEL[d]}: write hours like 09:00-17:00 (comma-separate several windows), or leave blank for closed.`);
    else hours[d] = w;
  }
  const int = (k: string, dflt: number) => { const v = str(f, k); return /^\d+$/.test(v) ? Number(v) : dflt; };
  const opt = (k: string) => str(f, k) || null;
  return {
    problems,
    cfg: {
      timezone: opt("timezone"),
      hours,
      holidays: lines(str(f, "holidays")),
      inbound: { mode: str(f, "inbound.mode") === "reject" ? "reject" : "answer", numbers: lines(str(f, "inbound.numbers")), agent_id: opt("inbound.agent_id") },
      transfer: { enabled: !!f.get("transfer.enabled"), number: opt("transfer.number") },
      scheduling: { enabled: !!f.get("scheduling.enabled"), duration_minutes: int("scheduling.duration_minutes", 30), min_notice_hours: int("scheduling.min_notice_hours", 24), horizon_days: int("scheduling.horizon_days", 21), auto_confirm: !!f.get("scheduling.auto_confirm") },
      outbound: {
        enabled: !!f.get("outbound.enabled"), agent_id: opt("outbound.agent_id"), from_number: opt("outbound.from_number"),
        window_start: str(f, "outbound.window_start") || "09:00", window_end: str(f, "outbound.window_end") || "20:00",
        max_per_number_per_day: int("outbound.max_per_number_per_day", 1), max_per_number_per_week: int("outbound.max_per_number_per_week", 3),
      },
    },
  };
}

async function opsPage(ctx: AppContext, errors: string[] = [], draft?: VoiceConfig, status = 200) {
  requireStaff(ctx, "voice.manage");
  const db = ctx.db;
  const now = ctx.env.overrides?.now?.() ?? new Date();
  const saved = await loadVoiceConfig(db);
  const c = draft ?? saved;
  const gate = outbound.outboundGate(ctx.env, saved);
  const hs = hoursStatus(saved, now);
  const a = await voiceAnalytics(db, new Date(now.getTime() - 30 * 86_400_000));
  const consultations = await sched.upcomingConsultations(db, now);
  const queue = await outbound.listOutbound(db);
  const dnc = (await db.prepare(`SELECT phone_e164, source, created_at FROM voice_dnc ORDER BY created_at DESC LIMIT 20`).all<{ phone_e164: string; source: string; created_at: string }>()).results;
  const body = html`${pageHead("Receptionist operations", linkButton("Calls and agent", "/staff/voice", "ghost", "sm"), "AI receptionist")}
${formErrors(errors)}
<div class="kpis grid grid-4">${kpi("Inbound calls (30 days)", a.inbound, `${a.testCallsExcluded} test calls excluded`)}${kpi("Outbound calls", a.outbound)}${kpi("Answered", a.answered)}${kpi("Missed", a.missed)}</div>
<div class="kpis grid grid-4">${kpi("Average duration", a.averageDurationSeconds === null ? "Unknown" : `${a.averageDurationSeconds}s`, a.durationUnknown ? `${a.durationUnknown} calls without a duration` : undefined)}${kpi("Leads captured", a.leadsCaptured, `${a.leadsConverted} converted`)}${kpi("Consultations booked", a.consultationsBooked)}${kpi("Support tickets", a.supportTickets)}</div>
<div class="kpis grid grid-4">${kpi("Escalations", a.escalations)}${kpi("Failed calls", a.failed)}${kpi("Failed transfers", a.transferFailures)}${kpi("Usage cost (provider-reported)", microUsd(a.costKnownMicroUsd), a.costUnknownCalls ? `${a.costUnknownCalls} calls with unknown cost` : "All call costs known")}</div>

<section class="card stack"><h2 class="card__title">Status</h2>
<p>Hours: ${hs.configured ? badge(hs.open ? "active" : "open", hs.open ? "Open now" : "Closed now") : badge("not_configured", "Not configured")} <span class="muted">${describeHours(saved)}</span></p>
<p>Live transfer: ${saved.transfer.enabled && saved.transfer.number ? badge("configured_unverified", "Configured") : badge("not_configured", "Not configured — the agent offers a callback")}</p>
<p>Phone scheduling: ${saved.scheduling.enabled ? badge("active", saved.scheduling.auto_confirm ? "On (auto-confirm)" : "On (staff confirm each booking)") : badge("not_configured", "Off")} <span class="faint">No calendar is connected; check your own calendar before confirming.</span></p>
<p>Outbound calling: ${gate.enabled ? badge("active", "Enabled") : badge("not_configured", "Disabled")} <span class="faint">${gate.reasons.join(" · ")}</span></p>
<p>Inbound: ${saved.inbound.mode === "reject" ? badge("failed", "Paused — calls are rejected") : badge("active", "Answering")} ${saved.inbound.numbers.length ? html`<span class="muted">bound to ${saved.inbound.numbers.join(", ")}</span>` : html`<span class="faint">No numbers bound yet: calls to any number reaching this environment are answered.</span>`}</p>
</section>

<form method="post" action="/staff/voice/operations/settings" class="card stack">${csrf(ctx)}
<h2 class="card__title">Business hours</h2>
${input({ name: "timezone", label: "Time zone (IANA)", value: c.timezone ?? "", maxlength: 60, placeholder: "America/Detroit", hint: "Hours, holidays and consultation slots are in this zone." })}
<div class="grid grid-2">${WEEKDAYS.map((d) => input({ name: `hours.${d}`, label: DAY_LABEL[d], value: windowsText(c, d), maxlength: 60, placeholder: "closed", hint: "e.g. 09:00-12:00, 13:00-17:00" }))}</div>
${textarea({ name: "holidays", label: "Closed dates (one per line, YYYY-MM-DD)", value: c.holidays.join("\n"), rows: 3, maxlength: 1200 })}
<h2 class="card__title">Inbound</h2>
${select({ name: "inbound.mode", label: "Receptionist", options: [{ value: "answer", label: "Answer calls" }, { value: "reject", label: "Paused: reject calls (emergency stop)" }], value: c.inbound.mode })}
${textarea({ name: "inbound.numbers", label: "Receptionist numbers for this environment (E.164, one per line)", value: c.inbound.numbers.join("\n"), rows: 2, maxlength: 400, hint: "Only numbers the Founder bought for Crestmont. Once listed, calls to any other number are rejected." })}
${input({ name: "inbound.agent_id", label: "Inbound agent id (optional override)", value: c.inbound.agent_id ?? "", maxlength: 80 })}
<h2 class="card__title">Live transfer</h2>
${checkbox("transfer.enabled", "Offer live transfer to a person during business hours", { checked: c.transfer.enabled })}
${input({ name: "transfer.number", label: "Transfer destination (E.164)", value: c.transfer.number ?? "", maxlength: 20, hint: "A Founder-approved business line. Leave blank to keep transfers off; callers get a callback instead." })}
<h2 class="card__title">Consultation scheduling</h2>
${checkbox("scheduling.enabled", "Let the receptionist book consultations inside business hours", { checked: c.scheduling.enabled })}
<div class="grid grid-3">${select({ name: "scheduling.duration_minutes", label: "Length", options: ["15", "20", "30", "45", "60", "90"].map((m) => ({ value: m, label: `${m} minutes` })), value: String(c.scheduling.duration_minutes) })}
${input({ name: "scheduling.min_notice_hours", label: "Minimum notice (hours)", value: c.scheduling.min_notice_hours, maxlength: 3 })}
${input({ name: "scheduling.horizon_days", label: "Booking horizon (days)", value: c.scheduling.horizon_days, maxlength: 2 })}</div>
${checkbox("scheduling.auto_confirm", "Confirm phone bookings automatically (otherwise they hold the slot until you confirm)", { checked: c.scheduling.auto_confirm })}
<h2 class="card__title">Outbound calling</h2>
${alert("warn", "Outbound calls need this switch AND RETELL_OUTBOUND=on in the environment. Every call also needs your approval, recorded consent for its purpose, no do-not-call entry and the recipient's calling hours.")}
${checkbox("outbound.enabled", "Allow approved outbound calls", { checked: c.outbound.enabled })}
<div class="grid grid-2">${input({ name: "outbound.from_number", label: "Caller number (E.164)", value: c.outbound.from_number ?? "", maxlength: 20 })}
${input({ name: "outbound.agent_id", label: "Outbound agent id", value: c.outbound.agent_id ?? "", maxlength: 80 })}
${input({ name: "outbound.window_start", label: "Earliest call (recipient local time)", value: c.outbound.window_start, maxlength: 5 })}
${input({ name: "outbound.window_end", label: "Latest call (recipient local time)", value: c.outbound.window_end, maxlength: 5 })}
${input({ name: "outbound.max_per_number_per_day", label: "Calls per number per day", value: c.outbound.max_per_number_per_day, maxlength: 1 })}
${input({ name: "outbound.max_per_number_per_week", label: "Calls per number per week", value: c.outbound.max_per_number_per_week, maxlength: 1 })}</div>
<div>${button("Save receptionist settings")}</div>
</form>

<section class="section--tight"><h2>Upcoming consultations</h2>${table(consultations, [
  { header: "When", cell: (r) => html`${sched.labelOf(r)}${r.is_test ? html` ${badge("in_progress", "Test")}` : ""}` },
  { header: "Caller", cell: (r) => html`${r.name}<br><span class="faint">${r.phone ?? ""} ${r.email ?? ""}</span>` },
  { header: "Topic", cell: (r) => r.topic ?? "—" },
  { header: "Status", cell: (r) => badge(r.status === "confirmed" ? "active" : "open", label(r.status)) },
  { header: "Ref", cell: (r) => html`<code>${r.confirmation_code}</code>` },
  { header: "", cell: (r) => html`<form method="post" action="/staff/voice/consultations/${r.id}/decide" class="row">${csrf(ctx)}${r.status === "requested" ? button("Confirm", { size: "sm", name: "decision", value: "confirm" }) : ""}${button("Cancel", { size: "sm", variant: "danger", name: "decision", value: "cancel" })}</form>` },
], { empty: emptyState("No upcoming consultations", saved.scheduling.enabled ? "Bookings made by phone appear here." : "Phone scheduling is off.") })}</section>

<section class="section--tight"><h2>Outbound call queue</h2>${table(queue, [
  { header: "Requested", cell: (r) => html`${formatDateTime(r.created_at)}${r.is_test ? html` ${badge("in_progress", "Test")}` : ""}` },
  { header: "Purpose", cell: (r) => label(r.purpose) },
  { header: "To", cell: (r) => html`${r.contact_name ?? "—"}<br><span class="faint">${r.phone_e164}</span>` },
  { header: "Reason", cell: (r) => r.reason },
  { header: "Status", cell: (r) => html`${badge(r.status === "completed" ? "active" : r.status === "failed" || r.status === "blocked" ? "failed" : "open", label(r.status))}<br><span class="faint">${r.status_detail ?? ""}</span>` },
  { header: "Consent", cell: (r) => (r.consent_id ? "Recorded" : "None") },
  { header: "", cell: (r) => ["pending_approval", "approved", "no_answer"].includes(r.status) ? html`<form method="post" action="/staff/voice/outbound/${r.id}/decide" class="row">${csrf(ctx)}${r.status === "pending_approval" ? button("Approve", { size: "sm", name: "decision", value: "approve" }) : ""}${button("Cancel", { size: "sm", variant: "danger", name: "decision", value: "cancel" })}</form>` : "" },
], { empty: emptyState("No outbound requests", "Callback requests from callers and staff-created requests appear here for approval.") })}
<form method="post" action="/staff/voice/outbound" class="card stack">${csrf(ctx)}<h3>Request an outbound call</h3>
<div class="grid grid-3">${select({ name: "purpose", label: "Purpose", options: OUTBOUND_PURPOSES.map((p) => ({ value: p, label: label(p) })) })}
${input({ name: "phone", label: "Number (E.164)", maxlength: 20, required: true })}${input({ name: "name", label: "Contact name", maxlength: 120 })}</div>
${textarea({ name: "reason", label: "Why (internal; never sent to the agent)", rows: 2, maxlength: 1000, required: true })}
${textarea({ name: "consent", label: "How the person asked to be called (recorded as consent for this purpose)", rows: 2, maxlength: 300, hint: "Leave blank if consent is already recorded. Approval is refused without it." })}
<div>${button("Add to queue", { variant: "secondary" })}</div></form></section>

<div class="grid grid-2">
<form method="post" action="/staff/voice/dnc" class="card stack">${csrf(ctx)}<h3>Do-not-call list</h3>
${input({ name: "phone", label: "Number", maxlength: 20, required: true })}${input({ name: "detail", label: "Reason", maxlength: 300, required: true })}
<div>${button("Add to do-not-call", { variant: "secondary" })}</div>
${dnc.length ? html`<ul class="faint">${dnc.map((d) => html`<li>${d.phone_e164} · ${label(d.source)} · ${formatDateTime(d.created_at)}</li>`)}</ul>` : html`<p class="faint">No numbers yet.</p>`}</form>
<form method="post" action="/staff/voice/caller-erasure" class="card stack">${csrf(ctx)}<h3>Erase a caller's data</h3>
<p class="muted">For callers without an account (account holders use privacy requests). Clears transcripts, recordings, summaries and the number on their calls, anonymises their consultations and the CRM contacts identified only by this number (receptionist- or research-created; customers and businesses that share the number are kept), and removes the number from CRM identity records and the duplicate review queue. A do-not-call entry is kept so the opt-out is still honoured.</p>
${input({ name: "phone", label: "Caller's number", maxlength: 20, required: true })}${textarea({ name: "note", label: "Who asked, and how", rows: 2, maxlength: 300, required: true })}
<label class="checkbox"><input type="checkbox" name="allow_reimport" value="1"> Allow research imports to add this number again (by default a one-way hash is kept so it is not re-imported)</label>
<div>${button("Erase caller data", { variant: "danger" })}</div></form>
</div>`;
  return staffPage(ctx, "Receptionist operations", body, status);
}

const back = (ctx: AppContext, text: string, kind: "success" | "error" = "success") => redirect(ctx, "/staff/voice/operations", { kind, text });
const statusOf = (e: unknown) => (e as { status?: number }).status;

export function register(r: Router): void {
  // Read-only audit of the receptionist's live Retell configuration (src/services/retell-inbound-audit.ts), run with this
  // Worker's RETELL_INBOUND_API_KEY. Machine endpoint signed like /api/scheduled/run (SCHEDULER_TRIGGER_SECRET, derived
  // from the Cloudflare token); the staging deploy calls it and prints the findings. Nothing is written to Retell.
  r.post("/api/voice/retell-audit", async (ctx) => {
    const raw = await readBody(ctx.req);
    if (!ctx.env.SCHEDULER_TRIGGER_SECRET) return jsonResponse(ctx, 503, { error: "Audit trigger not configured" });
    try { await verifyEvidenceSignature(ctx.env.SCHEDULER_TRIGGER_SECRET, raw, ctx.req.headers.get("x-crestmont-scheduler-signature")); }
    catch (e) { if (e instanceof IngestAuthError) return jsonResponse(ctx, 401, { error: e.message }); throw e; }
    const rl = await rateLimit(ctx.db, "retell-audit", 3, 300);
    if (!rl.allowed) return jsonResponse(ctx, 429, { error: "Ran recently; try again in a few minutes" });
    const result = await auditInboundRetell({ db: ctx.db, env: ctx.env, fetch: ctx.env.overrides?.fetch ?? fetch, baseUrl: ctx.baseUrl });
    await audit(ctx.db, { actorKind: "system", action: "voice.retell_audit", subjectType: "retell_agent", subjectId: result.agentId, details: { status: result.status, failed: result.findings.filter((f) => !f.ok).length, total: result.findings.length } });
    return jsonResponse(ctx, 200, result);
  });
  r.get("/staff/voice/operations", (ctx) => opsPage(ctx));

  r.post("/staff/voice/operations/settings", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const prev = await loadVoiceConfig(ctx.db);
    const { cfg, problems } = configFromForm(await ctx.form(), prev);
    if (problems.length) return opsPage(ctx, problems, cfg, 422);
    try {
      const { changed } = await saveVoiceConfig(ctx.db, ctx.user!.id, cfg);
      return back(ctx, changed.length ? `Receptionist settings saved (${changed.join(", ")}).` : "No changes.");
    } catch (e) {
      if (e instanceof VoiceConfigError) return opsPage(ctx, e.problems, cfg, 422);
      throw e;
    }
  });

  r.post("/staff/voice/consultations/:id/decide", async (ctx, p) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const decision = str(f, "decision") === "confirm" ? "confirm" : "cancel";
    try {
      const row = await sched.decide(ctx.db, ctx.user!.id, p.id, decision, str(f, "note"));
      if (row.email) {
        try { await sendMail(ctx, { template: "consultation", to: row.email, idempotencyKey: `consultation:${row.id}:${decision === "confirm" ? "confirmed" : "cancelled"}`, data: { event: decision === "confirm" ? "confirmed" : "cancelled", name: row.name, when: sched.labelOf(row), code: row.confirmation_code } }); }
        catch { /* recorded in the delivery log by the adapter */ }
      }
      return back(ctx, decision === "confirm" ? "Consultation confirmed." : "Consultation cancelled.");
    } catch (e) {
      if (e instanceof sched.ConsultationStateError) return opsPage(ctx, [e.message], undefined, 409);
      throw e;
    }
  });

  r.post("/staff/voice/outbound", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const purpose = str(f, "purpose") as OutboundPurpose;
    try {
      const row = await outbound.requestOutbound(ctx.db, { purpose, phone: str(f, "phone"), name: str(f, "name") || null, reason: str(f, "reason"), requestedBy: ctx.user!.id, consentEvidence: str(f, "consent") || null });
      return back(ctx, row.status === "blocked" ? "Request recorded but blocked: the number is on the do-not-call list." : "Outbound request added. Approve it when ready.", row.status === "blocked" ? "error" : "success");
    } catch (e) {
      if (e instanceof outbound.OutboundError) return opsPage(ctx, [e.message], undefined, e.status);
      throw e;
    }
  });

  r.post("/staff/voice/outbound/:id/decide", async (ctx, p) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const decision = str(f, "decision") === "approve" ? "approve" : "cancel";
    try {
      await outbound.decideOutbound(ctx.db, ctx.user!.id, p.id, decision, str(f, "note"));
      return back(ctx, decision === "approve" ? "Approved. It will be dialled only when outbound calling is enabled and every check passes." : "Outbound request cancelled.");
    } catch (e) {
      if (e instanceof outbound.OutboundError) { if (e.status === 404) throw new HttpError(404, e.message); return opsPage(ctx, [e.message], undefined, e.status); }
      throw e;
    }
  });

  r.post("/staff/voice/dnc", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const detail = str(f, "detail");
    if (detail.length < 3) return opsPage(ctx, ["Give a reason for the do-not-call entry."], undefined, 422);
    if (!await outbound.addDnc(ctx.db, str(f, "phone"), "staff", detail, ctx.user!.id)) return opsPage(ctx, ["Enter the number in a dialable format (e.g. +15551234567)."], undefined, 422);
    return back(ctx, "Number added to the do-not-call list.");
  });

  r.post("/staff/voice/caller-erasure", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    try {
      const n = await eraseCallerData(ctx.db, ctx.user!.id, str(f, "phone"), str(f, "note"), { blockReimport: str(f, "allow_reimport") !== "1" });
      return back(ctx, `Caller data erased: ${n.calls} calls, ${n.consultations} consultations, ${n.contacts} contacts.`);
    } catch (e) {
      if (statusOf(e) === 422) return opsPage(ctx, [(e as Error).message], undefined, 422);
      throw e;
    }
  });
}
