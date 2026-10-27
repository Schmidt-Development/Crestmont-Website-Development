// Full notification history for staff (/staff/notifications) and customers (/portal/notifications)
// (EMP-003, PORTAL-005). Dashboards show only the latest few; these pages page through everything,
// filter to unread, mark one or all read, and link each notification to its subject.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, label } from "../lib/html.ts";
import { HttpError, htmlResponse, redirect } from "../app/http.ts";
import { requireStaff, requireCustomerOrg } from "../app/app.ts";
import { appLayout } from "../ui/layout.ts";
import { actionForm, badge, emptyState, pageHead, pagination, pageParam, table, tabs } from "../ui/components.ts";
import { staffNav, portalNav } from "./nav.ts";
import { markNotificationsRead, notificationHref, pageNotifications, unreadNotificationCount } from "../services/notifications.ts";

async function notificationsPage(ctx: AppContext, area: "staff" | "portal") {
  const base = `/${area}/notifications`;
  const unreadOnly = ctx.url.searchParams.get("unread") === "1";
  const { page, limit, offset } = pageParam(ctx);
  const rows = await pageNotifications(ctx.db, ctx.user!.id, { unreadOnly, limit: limit + 1, offset });
  const unread = await unreadNotificationCount(ctx.db, ctx.user!.id);
  const body = html`${pageHead("Notifications", unread ? actionForm(ctx, `/${area}/notifications/read`, "Mark all read", { variant: "ghost", hidden: { back: base } }) : undefined, `${unread} unread`)}
${tabs([{ href: base, label: "All", current: !unreadOnly }, { href: `${base}?unread=1`, label: `Unread (${unread})`, current: unreadOnly }], "Notification views")}
${table(rows.slice(0, limit), [
    { header: "", cell: (n) => (n.read_at ? "" : badge("new", "New")) },
    { header: "Notification", cell: (n) => { const href = notificationHref(n, area); return href ? html`<a href="${href}">${n.body}</a>` : n.body; } },
    { header: "Type", cell: (n) => label(n.kind.replace(/\./g, "_")) },
    { header: "When", cell: (n) => formatDateTime(n.created_at) },
    { header: "", cell: (n) => (n.read_at ? html`<span class="faint">Read ${formatDateTime(n.read_at)}</span>` : actionForm(ctx, `/${area}/notifications/${n.id}/read`, "Mark read", { variant: "ghost" })) },
  ], { empty: emptyState(unreadOnly ? "No unread notifications" : "No notifications yet", area === "staff" ? "Assignments, customer messages, approvals and escalations appear here." : "Project updates, messages, approvals and support replies appear here."), caption: "Notifications" })}
${pagination(ctx, page, rows.length > limit)}`;
  const layout = area === "staff"
    ? appLayout(ctx, { title: "Notifications", nav: staffNav(ctx), home: "/staff", area: "Crestmont staff" }, body)
    : appLayout(ctx, { title: "Notifications", nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body);
  return htmlResponse(ctx, layout);
}

async function markOne(ctx: AppContext, area: "staff" | "portal", id: string) {
  const row = await ctx.db.prepare(`SELECT id FROM notifications WHERE id = ? AND user_id = ?`).bind(id, ctx.user!.id).first<{ id: string }>();
  if (!row) throw new HttpError(404, "Notification not found."); // never reveals other users' notifications
  await markNotificationsRead(ctx.db, ctx.user!.id, id);
  return redirect(ctx, `/${area}/notifications`, { kind: "success", text: "Notification marked as read." });
}

export function register(r: Router): void {
  r.get("/staff/notifications", (ctx) => { requireStaff(ctx); return notificationsPage(ctx, "staff"); });
  r.post("/staff/notifications/:id/read", (ctx, p) => { requireStaff(ctx); return markOne(ctx, "staff", p.id); });
  r.get("/portal/notifications", (ctx) => { requireCustomerOrg(ctx); return notificationsPage(ctx, "portal"); });
  r.post("/portal/notifications/:id/read", (ctx, p) => { requireCustomerOrg(ctx); return markOne(ctx, "portal", p.id); });
}
