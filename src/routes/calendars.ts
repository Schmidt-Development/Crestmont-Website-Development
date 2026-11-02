// The two internal calendars (Founder requirement; routing rules in src/domain/calendars.ts, schema in migration 0065).
// Staff-only, read-only views of upcoming entries:
//  GET /staff/calendars/ai-follow-up      Calendar A "AI Follow-Up"     lead.read_all (Owner, Administrator)
//  GET /staff/calendars/founder-callback  Calendar B "Founder Callback"  voice.manage  (Owner)
// Entries are worked from the linked CRM lead (tasks) or the receptionist operations page (consultations).
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import type { Permission } from "../domain/authz.ts";
import { can } from "../domain/authz.ts";
import { html, formatDateTime, label } from "../lib/html.ts";
import { requireStaff } from "../app/app.ts";
import { badge, table, emptyState, pageHead, tabs } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { CALENDARS, CALENDAR_LABELS, CUSTOMER_REQUESTED_FOUNDER, type CalendarId } from "../domain/calendars.ts";
import { upcomingEntries } from "../services/calendars.ts";

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

export function register(r: Router): void {
  for (const id of CALENDARS) r.get(`/staff/calendars/${CALENDAR_LABELS[id].slug}`, (ctx) => calendarPage(ctx, id));
}
