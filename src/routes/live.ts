// Live updates without page reloads (PORTAL-005). app.js polls GET /live/unread every 30 s while the tab
// is visible and updates any element marked data-live="messages" / data-live="notifications", and on a
// conversation page offers "New messages — refresh" when the count grows. Without JavaScript the
// pages work exactly as before. Polling is passive: it never refreshes the session idle timer
// (src/services/auth.ts loadSession), so an unattended tab still times out (ASVS F-07).
import type { Router } from "../lib/router.ts";
import { HttpError, jsonResponse } from "../app/http.ts";
import { requireUser } from "../app/app.ts";
import { can } from "../domain/authz.ts";
import { STAFF_ROLES } from "../domain/authz.ts";
import * as M from "../services/messages.ts";
import { unreadNotificationCount } from "../services/notifications.ts";

export function register(r: Router): void {
  r.get("/live/unread", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const me = ctx.user.id;
    const notifications = await unreadNotificationCount(ctx.db, me);
    let messages = 0;
    if (ctx.user.isStaff) {
      if (can(ctx.actor, "delivery.access")) {
        const ids = can(ctx.actor, "project.read_all") ? "all" as const : (await ctx.db.prepare(`SELECT p.id FROM projects p
            WHERE p.project_manager_id = ? OR EXISTS (SELECT 1 FROM assignments a WHERE a.subject_type = 'project' AND a.subject_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)
               OR EXISTS (SELECT 1 FROM assignments a JOIN tasks t ON t.id = a.subject_id WHERE a.subject_type = 'task' AND t.project_id = p.id AND a.user_id = ? AND a.ended_at IS NULL)`)
          .bind(me, me, me).all<{ id: string }>()).results.map((x) => x.id);
        messages += await M.unreadCountForStaff(ctx.db, me, ids);
        // "all" already includes general (non-project) conversations; don't count them twice.
        if (ids !== "all" && can(ctx.actor, "customers.read")) messages += await M.generalUnreadForStaff(ctx.db, me);
      } else if (can(ctx.actor, "customers.read")) messages += await M.generalUnreadForStaff(ctx.db, me);
    } else {
      for (const m of ctx.user.memberships.filter((x) => !(STAFF_ROLES as readonly string[]).includes(x.role))) messages += await M.unreadCountForCustomer(ctx.db, me, m.organizationId);
    }
    return jsonResponse(ctx, 200, { messages, notifications }, { "cache-control": "no-store, private" });
  });
}
