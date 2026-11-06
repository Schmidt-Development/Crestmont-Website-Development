// The two internal calendars (Founder requirement; routing rules in src/domain/calendars.ts, schema in migration 0083).
// Staff-only, read-only views of upcoming entries:
//  GET /staff/calendars/ai-follow-up      Calendar A "AI Follow-Up"     lead.read_all (Owner, Administrator)
//  GET /staff/calendars/founder-callback  Calendar B "Founder Callback"  voice.manage  (Owner)
//  GET  /staff/calendars/founder-callback/google            Google Calendar connection (Owner)
//  POST /staff/calendars/founder-callback/google/connect    start Google's consent (Owner) → Google
//  GET  /oauth/google/founder-calendar/callback             Google's redirect back (Owner session + one-time state)
//  POST /staff/calendars/founder-callback/google/check      live check: calendar + free/busy (Owner)
//  POST /staff/calendars/founder-callback/google/disconnect revoke and forget the authorisation (Owner)
// Entries are worked from the linked CRM lead (tasks) or the receptionist operations page (consultations).
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import type { Permission } from "../domain/authz.ts";
import { can } from "../domain/authz.ts";
import { html, formatDateTime, label } from "../lib/html.ts";
import { requireStaff } from "../app/app.ts";
import { audit } from "../services/security.ts";
import { badge, table, emptyState, pageHead, tabs } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { CALENDARS, CALENDAR_LABELS, CUSTOMER_REQUESTED_FOUNDER, type CalendarId } from "../domain/calendars.ts";
import { upcomingEntries } from "../services/calendars.ts";
import { redirect, str } from "../app/http.ts";
import { csrf, input, button, alert, formErrors } from "../ui/components.ts";
import { loadVoiceConfig } from "../services/voice-settings.ts";
import * as FC from "../services/founder-calendar.ts";
import { FOUNDER_CALENDAR_NAME, GOOGLE_SCOPES } from "../adapters/google-calendar.ts";

export const CALENDAR_PERMISSION: Record<CalendarId, Permission> = { ai_follow_up: "lead.read_all", founder_callback: "voice.manage" };

const reasonText = (r: string | null) => (r === null ? "—" : r === CUSTOMER_REQUESTED_FOUNDER ? "Customer asked for the Founder" : `Approved escalation rule ${r.slice(5)}`);
const KIND_LABEL: Record<string, string> = {
  consultation: "Consultation", callback: "Callback", escalation: "Escalation callback", support_callback: "Support callback",
  sales_staff_callback: "Sales callback", sales_ai_follow_up: "AI follow-up call",
};

async function calendarPage(ctx: AppContext, id: CalendarId) {
  requireStaff(ctx, CALENDAR_PERMISSION[id]);
  const now = ctx.env.overrides?.now?.() ?? new Date();
  const meta = CALENDAR_LABELS[id];
  const rows = await upcomingEntries(ctx.db, id, now);
  const nav = tabs(CALENDARS.filter((c) => can(ctx.actor!, CALENDAR_PERMISSION[c])).map((c) => ({ href: `/staff/calendars/${CALENDAR_LABELS[c].slug}`, label: CALENDAR_LABELS[c].name, current: c === id })), "Calendars");
  const body = html`${pageHead(`${meta.name} calendar`, undefined, "Internal calendar")}
${nav}
<p class="muted">${meta.purpose} Internal only: customers never see this calendar. Every entry below exists in the database; nothing is listed that was not recorded.</p>
${id === "founder_callback" ? html`<p><a href="/staff/calendars/founder-callback/google">Google Calendar connection, real availability and notifications</a></p>` : ""}
${table(rows, [
    { header: "When", cell: (r) => html`${r.when_at ? formatDateTime(r.when_at) : "No date agreed"}${r.is_test ? html` ${badge("in_progress", "Test")}` : ""}` },
    { header: "Type", cell: (r) => KIND_LABEL[r.kind] ?? label(r.kind) },
    { header: "Contact", cell: (r) => (r.lead_id ? html`<a href="/staff/crm/leads/${r.lead_id}">${r.contact_name ?? "Lead"}</a>` : r.contact_name ?? "—") },
    { header: "Details", cell: (r) => html`${r.detail ?? "—"}${r.reference ? html`<br><span class="faint">Ref <code>${r.reference}</code></span>` : ""}` },
    { header: "Status", cell: (r) => badge(r.status === "confirmed" || r.status === "scheduled" ? "active" : "open", label(r.status)) },
    { header: "Source", cell: (r) => label(r.source) },
    ...(id === "founder_callback" ? [{ header: "Why on this calendar", cell: (r: { founder_reason: string | null }) => reasonText(r.founder_reason) }] : []),
  ], { caption: `${meta.name} calendar`, empty: emptyState(`Nothing on the ${meta.name} calendar`, id === "founder_callback" ? "Callers who specifically ask to speak with the Founder appear here." : "Callbacks, follow-ups and consultations recorded by the AI agents appear here.") })}`;
  return staffPage(ctx, `${meta.name} calendar`, body);
}

const GOOGLE_PAGE = "/staff/calendars/founder-callback/google";
const callbackUrl = (ctx: AppContext) => `${ctx.baseUrl.replace(/\/$/, "")}/oauth/google/founder-calendar/callback`;
const gfetch = (ctx: AppContext) => ctx.env.overrides?.fetch ?? fetch;

async function googlePage(ctx: AppContext, errors: string[] = [], status = 200) {
  requireStaff(ctx, "voice.manage");
  const c = await FC.loadConnection(ctx.db);
  const setup = FC.setupProblems(ctx.env);
  const sync = (await ctx.db.prepare(`SELECT google_sync_status AS s, COUNT(*) AS n FROM consultations WHERE calendar = 'founder_callback' AND status IN ('requested','confirmed') GROUP BY google_sync_status`).all<{ s: string | null; n: number }>()).results;
  const body = html`${pageHead("Founder Calendar — Google", undefined, "Internal calendar")}
${formErrors(errors)}
<p class="muted">Founder appointments (only when a prospect asks for the Founder) stay recorded here. Google Calendar adds real availability (free/busy of your primary calendar and "${FOUNDER_CALENDAR_NAME}": times only, never titles or details) and shows every appointment on the dedicated calendar. You are emailed for every new, moved, confirmed and cancelled appointment.</p>
${setup.length ? alert("warn", html`Before connecting: ${setup.join(" · ")}. Create a free OAuth client (Web application) in Google Cloud Console with the redirect URI <code>${callbackUrl(ctx)}</code>, then set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on this Worker.`) : ""}
${c ? html`<section class="card stack" data-google-connected><h2 class="card__title">Connected</h2>
<p>${badge("active", "Connected")} Google account <strong>${c.account_email}</strong> · calendar ${c.calendar_id ? html`<code>${c.calendar_id}</code> (${c.calendar_created ? "created by Crestmont" : "existing calendar reused"})` : "missing"} · connected ${formatDateTime(c.connected_at)}</p>
<p>Live check: ${c.last_check_at ? html`${c.last_check_ok ? badge("active", "OK") : badge("failed", "Failed")} ${c.last_check_detail ?? ""} <span class="faint">(${formatDateTime(c.last_check_at)})</span>` : "not run yet"}</p>
<p class="faint">Appointments on Google: ${sync.length ? sync.map((x) => `${x.s ?? "not synced"} ${x.n}`).join(" · ") : "none active"}</p>
<div class="row"><form method="post" action="${GOOGLE_PAGE}/check">${csrf(ctx)}${button("Run the live check", { variant: "secondary", size: "sm" })}</form>
<form method="post" action="${GOOGLE_PAGE}/disconnect">${csrf(ctx)}${button("Disconnect", { variant: "danger", size: "sm" })}</form></div></section>`
  : html`<form method="post" action="${GOOGLE_PAGE}/connect" class="card stack">${csrf(ctx)}<h2 class="card__title">Connect Google Calendar</h2>
${input({ name: "account", label: "Your Google account (the calendar must belong to it)", type: "email", required: true, maxlength: 120 })}
<p class="faint">Permissions requested: ${GOOGLE_SCOPES.map((x) => x.replace("https://www.googleapis.com/auth/", "")).join(", ")}. Crestmont can create and manage only the calendar it creates, and read only busy times elsewhere.</p>
<div class="form-actions">${button("Connect with Google", { variant: setup.length ? "secondary" : "primary" })}</div></form>`}`;
  return staffPage(ctx, "Founder Calendar — Google", body, status);
}

export function register(r: Router): void {
  for (const id of CALENDARS) r.get(`/staff/calendars/${CALENDAR_LABELS[id].slug}`, (ctx) => calendarPage(ctx, id));
  r.get(GOOGLE_PAGE, (ctx) => googlePage(ctx));
  r.post(`${GOOGLE_PAGE}/connect`, async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const f = await ctx.form();
    const account = str(f, "account").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) return googlePage(ctx, ["Enter the Google account the calendar must belong to"], 422);
    try {
      const url = await FC.startConnect(ctx.db, ctx.env, ctx.user!.id, callbackUrl(ctx), account, ctx.env.overrides?.now?.() ?? new Date());
      await ctx.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('founder_calendar.expected_account', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(account, new Date().toISOString()).run();
      return new Response(null, { status: 303, headers: { location: url } });
    } catch (e) { if (e instanceof FC.FounderCalendarError) return googlePage(ctx, [e.message], 422); throw e; }
  });
  r.get("/oauth/google/founder-calendar/callback", async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const err = ctx.url.searchParams.get("error");
    if (err) return redirect(ctx, GOOGLE_PAGE, { kind: "error", text: err === "access_denied" ? "Google access was not granted; nothing was connected." : `Google returned an error (${err.slice(0, 60)}).` });
    const state = ctx.url.searchParams.get("state") ?? "", code = ctx.url.searchParams.get("code") ?? "";
    if (!state || !code) return googlePage(ctx, ["Google's answer was incomplete (no authorisation code); nothing was connected. Start the connection again."]);
    const expected = (await ctx.db.prepare(`SELECT value FROM business_settings WHERE key = 'founder_calendar.expected_account'`).first<{ value: string }>())?.value ?? null;
    try {
      const c = await FC.completeConnect(ctx.db, ctx.env, gfetch(ctx), { userId: ctx.user!.id, state, code, redirectUri: callbackUrl(ctx), timeZone: (await loadVoiceConfig(ctx.db)).timezone ?? "America/New_York", expectedAccount: expected, now: ctx.env.overrides?.now?.() ?? new Date() });
      return redirect(ctx, GOOGLE_PAGE, { kind: c.last_check_ok ? "success" : "error", text: c.last_check_ok ? `Connected ${c.account_email}; the live check passed.` : `Connected ${c.account_email}, but the live check failed: ${c.last_check_detail ?? ""}` });
    } catch (e) {
      if (e instanceof FC.FounderCalendarError || (e as Error).name === "GoogleCalendarError" || (e as { status?: unknown }).status !== undefined) return googlePage(ctx, [(e as Error).message], 422);
      throw e;
    }
  });
  r.post(`${GOOGLE_PAGE}/check`, async (ctx) => {
    requireStaff(ctx, "voice.manage");
    const res = await FC.checkConnection(ctx.db, ctx.env, gfetch(ctx), ctx.env.overrides?.now?.() ?? new Date());
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "founder_calendar.checked", subjectType: "google_calendar", subjectId: "1", details: { ok: res.ok } });
    return redirect(ctx, GOOGLE_PAGE, { kind: res.ok ? "success" : "error", text: res.detail });
  });
  r.post(`${GOOGLE_PAGE}/disconnect`, async (ctx) => {
    requireStaff(ctx, "voice.manage");
    await FC.disconnect(ctx.db, ctx.env, gfetch(ctx), ctx.user!.id);
    return redirect(ctx, GOOGLE_PAGE, { kind: "success", text: "Disconnected. Founder availability uses your configured windows only until you connect again." });
  });
}
