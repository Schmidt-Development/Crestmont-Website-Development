// Handing a finished website to an existing customer project, and showing it in that customer's portal.
//
// The builder produces a complete website under one of Crestmont's own projects, because that is where an
// uploaded artifact lands. Until now there was nowhere for it to go: the only way to put it in front of the
// customer who is buying it was to create a second project, which duplicates the customer's record and loses
// which artifact, baseline and contract the website actually came from.
//
// So this is a handover, not a rebuild. It reuses what already exists -- `projects` and `organizations` for the
// customer, `build_revisions` for the stored website, and the signed `/build-preview/...` capability route for
// serving it, which already carries a sandboxing CSP and needs no cookie. Nothing new is hosted and nothing is
// provisioned.
//
// Two decisions, kept apart: assigning a website to a project, and letting the customer see it. A website sitting
// on a project is not a statement that anybody has shown it to the customer, and neither is a statement that the
// customer approved it -- only the customer can say that.

import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, safeHttpsUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, redirect, str as formStr } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { can } from "../domain/authz.ts";
import { alert, badge, button, csrf, dl, emptyState, pageHead, table } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { join } from "../lib/html.ts";
import * as WD from "../services/website-delivery.ts";
import * as BR from "../services/build-revisions.ts";
import * as B from "../services/builds.ts";

/** The acting staff user. Every delivery act is attributable, so this is never optional. */
function actorId(ctx: AppContext): string {
  const id = ctx.actor?.userId;
  if (!id) throw new HttpError(401, "Sign in again.");
  return id;
}

const str = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();

export function register(r: Router): void {
  // ── staff: assign a finished website to an existing customer project ───────────────────────────────────────
  //
  // A page of its own rather than a control on the build page, because the Founder's requirement is a real
  // workflow: search the existing projects, see which customer each belongs to, see what that project is already
  // showing, then confirm. A dropdown squeezed into a sidebar invites the one mistake that matters here --
  // delivering a website to the wrong customer.
  r.get("/staff/builds/:id/deliver", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const d = await B.buildDetail(ctx.db, p.id);
    const elig = await WD.eligibility(ctx.db, p.id);
    const q = ctx.url.searchParams.get("q") ?? "";
    const targets = await WD.assignTargets(ctx.db, { query: q });
    const already = await WD.deliveriesOfJob(ctx.db, p.id);

    const body = html`${pageHead(`Deliver ${d.summary.organizationName}'s website`,
      html`<a class="btn ghost sm" href="/staff/builds/${p.id}">Back to the build</a>`,
      "Assign this finished website to an existing customer project")}

${elig.ok
  ? alert("info", html`This build is finished and has a stored website (revision
      <code>${String(elig.revision!.attempt)}-${String(elig.revision!.cycle)}</code>). Choose the existing project it belongs to.`)
  : alert("error", html`<strong>This website cannot be delivered yet.</strong>
      <ul>${join(elig.reasons.map((x) => html`<li>${x}</li>`))}</ul>
      Staff can still inspect it from the build page; it is not a completed deliverable.`)}

${already.length
  ? html`<section class="card"><h2>Already delivered</h2>${table(already, [
      { header: "Project", cell: (x: WD.DeliveryRow) => html`<a href="/staff/builds/${p.id}/deliver?q=">${x.project_id}</a>` },
      { header: "Revision", cell: (x: WD.DeliveryRow) => html`<code>${String(x.revision_attempt)}-${String(x.revision_cycle)}</code>` },
      { header: "Status", cell: (x: WD.DeliveryRow) => badge(x.superseded_at ? "muted" : x.visible_at ? "ok" : "info", WD.DELIVERY_LABEL[x.status]) },
      { header: "Assigned", cell: (x: WD.DeliveryRow) => html`${formatDateTime(x.assigned_at)}` },
    ])}</section>`
  : ""}

<section class="card">
  <h2>Existing customer projects</h2>
  <form method="get" action="/staff/builds/${p.id}/deliver" class="row" style="gap:.5rem;align-items:end">
    <label for="f-q">Search by project or customer</label>
    <input id="f-q" name="q" value="${q}" placeholder="Vesper Rowe, law firm, …">
    ${button("Search", { variant: "secondary", size: "sm" })}
  </form>
  ${targets.length === 0
    ? emptyState("No customer project matches that search.", "Crestmont's own internal projects are not delivery targets.")
    : table(targets, [
      { header: "Customer", cell: (x: WD.AssignTarget) => html`${x.organizationName}` },
      { header: "Project", cell: (x: WD.AssignTarget) => html`${x.projectName}<br><code class="faint">${x.projectId}</code>` },
      { header: "Showing now", cell: (x: WD.AssignTarget) => x.current
          ? html`${badge(x.current.visible ? "ok" : "info", x.current.visible ? "a website the customer can see" : "a website assigned, not yet visible")}
                 <br><span class="faint">revision ${x.current.revision}</span>`
          : html`<span class="faint">nothing yet</span>` },
      { header: "", cell: (x: WD.AssignTarget) => !elig.ok ? html`` : html`<form method="post" action="/staff/builds/${p.id}/deliver" class="stack" style="gap:.25rem"
            onsubmit="return confirm('Assign this website to ${x.organizationName} — ${x.projectName}?${x.current ? " This replaces the website that project is showing." : ""}')">
          ${csrf(ctx)}
          <input type="hidden" name="projectId" value="${x.projectId}">
          <label class="faint"><input type="checkbox" name="visible" value="yes"> let the customer see it now</label>
          ${button(x.current ? "Replace" : "Assign", { variant: "primary", size: "sm" })}
        </form>` },
    ])}
</section>`;
    return staffPage(ctx, "Deliver a website", body);
  });

  r.post("/staff/builds/:id/deliver", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const form = await ctx.form();
    const projectId = str(form, "projectId");
    if (!projectId) throw new HttpError(422, "Choose the project to deliver this website to.");
    const r0 = await WD.assignToProject(ctx.db, {
      jobId: p.id, projectId, actorId: actorId(ctx),
      makeVisible: str(form, "visible") === "yes",
      note: str(form, "note") || null, ip: ctx.ip ?? null,
    });
    if (!r0.ok) throw new HttpError(409, `This website was not delivered: ${r0.why}`);
    return redirect(ctx, `/staff/builds/${p.id}/deliver`);
  });

  // Letting the customer see a website that is already on their project. Its own act, its own audit row.
  r.post("/staff/builds/:id/deliver/:deliveryId/visible", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const r0 = await WD.makeVisibleToCustomer(ctx.db, p.deliveryId, { actorId: actorId(ctx), ip: ctx.ip ?? null });
    if (!r0.ok) throw new HttpError(409, r0.why);
    return redirect(ctx, `/staff/builds/${p.id}/deliver`);
  });

  // Going back to a website this project showed before. A new delivery naming the old snapshot, never an edit of
  // the old row: what was live between two moments is history.
  r.post("/staff/projects/:projectId/deliver/rollback", async (ctx, p) => {
    requireStaff(ctx, "builds.manage");
    const form = await ctx.form();
    const deliveryId = str(form, "deliveryId");
    if (!deliveryId) throw new HttpError(422, "Choose the version to go back to.");
    const r0 = await WD.rollbackTo(ctx.db, { projectId: p.projectId, deliveryId, actorId: actorId(ctx), ip: ctx.ip ?? null });
    if (!r0.ok) throw new HttpError(409, r0.why);
    return redirect(ctx, `/staff/builds/${r0.delivery.job_id}/deliver`);
  });
}

/**
 * The website section of a customer's project page, and the link that opens it.
 *
 * Exported for `routes/portal.ts` rather than registered here, because it belongs inside the page the customer
 * already uses for that project -- and because the authorization has already been done there, against the
 * customer's own organisation.
 *
 * The preview link is the same signed capability the staff preview uses: unguessable, scoped to one stored
 * snapshot, an hour's life, and served with an opaque origin so it cannot reach the portal session. Minting it is
 * what this function does, and it only ever happens for a delivery that is visible on a project this customer
 * may read.
 */
export async function customerWebsiteSection(
  ctx: AppContext,
  organizationId: string,
  projectId: string,
): Promise<SafeHtml> {
  const d = await WD.visibleForCustomer(ctx.db, organizationId, projectId);
  if (!d) return html``;

  // Two sources, two ways of opening. An AI build is served from its stored snapshot through a freshly minted
  // signed capability. An external website is opened at its own stored HTTPS address in a new tab: never framed,
  // never proxied, and with no referrer, so the portal's address is not leaked to the host.
  let viewLink: SafeHtml;
  if (d.source === "external_url") {
    const href = safeHttpsUrl(d.website_url);
    viewLink = href !== "#"
      ? html`<p><a class="btn primary" href="${href}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-website-link>View website</a>
          <span class="faint">Opens the website in a new tab.</span></p>`
      : alert("warn", "This website cannot be opened at the moment. Please tell us and we will look.");
  } else {
    const token = await BR.previewToken(ctx.env, d.job_id!, d.revision_attempt!, d.revision_cycle!);
    const href = token ? `/build-preview/${d.job_id}/${d.revision_attempt}-${d.revision_cycle}/${token}/` : null;
    viewLink = href
      ? html`<p><a class="btn primary" href="${href}" target="_blank" rel="noopener noreferrer">View website</a>
          <span class="faint">Opens in a new tab. The link is private to you and refreshes each time you load this page.</span></p>`
      : alert("warn", "This website cannot be opened at the moment. Nobody has lost anything — the preview link could not be prepared. Please tell us and we will look.");
  }

  return html`<section class="card" data-your-website>
  <h2>Your website</h2>
  <p class="faint">${d.source === "external_url"
    ? "The website prepared for this project. Open it to look through it, then approve it or tell us what you would like changed."
    : "The website built for this project. Open it to look through it; it runs against a staging environment, so anything you submit stays here."}</p>
  ${dl([
    ["Website", d.website_name ?? "Your website"],
    ["Version", html`Version ${String(d.version)}${d.source === "ai_build" ? html` <span class="faint">(<code>${String(d.revision_attempt)}-${String(d.revision_cycle)}</code>)</span>` : ""}`],
    ["Status", badge(d.customer_decision === "approved" ? "ok" : "info", WD.DELIVERY_LABEL[d.status])],
    ["Date shared", html`${d.visible_at ? formatDateTime(d.visible_at) : "—"}`],
    ["Last updated", html`${formatDateTime(d.updated_at)}`],
  ])}
  ${viewLink}
  ${d.customer_decision
    ? alert(d.customer_decision === "approved" ? "success" : "info",
        d.customer_decision === "approved"
          ? html`You approved version ${String(d.version)} on ${formatDateTime(d.customer_reviewed_at!)}. Thank you.`
          : html`You asked for changes to version ${String(d.version)} on ${formatDateTime(d.customer_reviewed_at!)}${d.customer_note ? html`: “${d.customer_note}”` : ""}. We will share a revised version here.`)
    : html`<div class="stack" style="gap:.75rem">
        <form method="post" action="/portal/projects/${projectId}/website/decision" class="row" style="gap:.5rem">
          ${csrf(ctx)}
          <input type="hidden" name="decision" value="approved">
          ${button("Approve Website", { variant: "primary", size: "sm" })}
        </form>
        <form method="post" action="/portal/projects/${projectId}/website/decision" class="stack" style="gap:.5rem">
          ${csrf(ctx)}
          <input type="hidden" name="decision" value="revision_requested">
          <label for="f-website-note">What would you like changed?</label>
          <textarea id="f-website-note" name="note" rows="3" maxlength="1000" required placeholder="Describe the changes you would like"></textarea>
          <div class="row">${button("Request Changes", { variant: "secondary", size: "sm" })}</div>
        </form>
      </div>`}
</section>`;
}

/** Whether a staff actor may use the delivery actions at all, for the link on the build page. */
export function mayDeliver(ctx: AppContext): boolean {
  return !!ctx.actor && can(ctx.actor, "builds.manage");
}
