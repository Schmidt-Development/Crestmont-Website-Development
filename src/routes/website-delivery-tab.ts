// Website Delivery: the Staff Dashboard tab for handing a hosted website to an existing customer project.
//
// The workflow a non-technical staff member follows: build the website with any tool, deploy it to any host, open
// Website Delivery, choose the existing customer and project, paste the HTTPS address, and Save & Share. The
// customer then sees it on the project page they already use, opens it in a new tab, and approves it or asks for
// changes -- and staff see that decision here.
//
// INDEPENDENT OF THE AI BUILDERS. Nothing in this file reads or writes a build job, revision, artifact, baseline or
// contract, and nothing here needs the AI Website Builder or the Artifact Builder to be running. Deliveries that
// did come from an AI build (source = 'ai_build') are listed alongside, so one page shows every website a customer
// has been given, and the share / archive / restore actions work on them too; assigning a NEW AI build still
// happens from that build's own page (/staff/builds/:id/deliver), unchanged.
//
// Every route requires the `website_delivery.manage` permission, every POST is CSRF-checked by the central request
// pipeline, and every state change writes an audit row. External addresses are validated (src/domain/external-url.ts)
// and are never fetched, framed or proxied by Crestmont.

import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, safeHttpsUrl, type SafeHtml } from "../lib/html.ts";
import { HttpError, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { actionForm, alert, badge, button, csrf, dl, emptyState, formErrors, input, linkButton, pageHead, pagination, pageParam, select, table, textarea } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import * as WD from "../services/website-delivery.ts";
import { notifyCustomer } from "../services/notifications.ts";

const BASE = "/staff/website-delivery";
const PERM = "website_delivery.manage" as const;

function actorId(ctx: AppContext): string {
  const id = ctx.actor?.userId;
  if (!id) throw new HttpError(401, "Sign in again.");
  return id;
}

async function deliveryOr404(ctx: AppContext, id: string): Promise<WD.DeliveryRow> {
  const d = await WD.byId(ctx.db, id);
  if (!d) throw new HttpError(404, "That website delivery does not exist.");
  return d;
}

/** Where an inline action returns to: the list it was pressed on, or the delivery's own page. */
function back(form: FormData, id: string): string {
  return str(form, "back") === "list" ? BASE : `${BASE}/${id}`;
}

const STATUS_OPTIONS = [
  { value: "", label: "Any status" }, { value: "draft", label: "Draft (staff only)" }, { value: "shared", label: "Shared with customer" },
  { value: "approved", label: "Approved" }, { value: "revision_requested", label: "Changes requested" }, { value: "archived", label: "Archived" },
];
const APPROVAL_OPTIONS = [
  { value: "", label: "Any approval" }, { value: "awaiting", label: "Awaiting customer" }, { value: "approved", label: "Approved" },
  { value: "revision_requested", label: "Changes requested" }, { value: "not_shared", label: "Not shared yet" },
];
const pick = <T extends string>(v: string | null, allowed: { value: string }[]): T => (allowed.some((o) => o.value === v) ? v : "") as T;

function statusBadge(d: WD.DeliveryRow): SafeHtml {
  if (d.status === "archived") return badge("archived", "Archived");
  if (d.superseded_at) return badge("superseded", "Replaced");
  if (d.customer_decision === "approved") return badge("approved", "Approved");
  if (d.customer_decision === "revision_requested") return badge("requested", "Changes requested");
  return d.visible_at ? badge("sent", "Shared with customer") : badge("draft", "Draft");
}

function approvalBadge(d: WD.DeliveryRow): SafeHtml {
  const l = WD.approvalLabel(d);
  return badge(d.customer_decision === "approved" ? "approved" : d.customer_decision === "revision_requested" ? "requested" : l === "Awaiting customer" ? "pending_customer" : "", l);
}

/** The website itself: the external address (opened in a new tab, never framed), or the AI build it came from. */
function websiteLink(d: WD.DeliveryRow, short = false): SafeHtml {
  if (d.source === "external_url" && d.website_url) {
    const text = short ? d.website_url.replace(/^https:\/\//, "").slice(0, 60) : d.website_url;
    return html`<a href="${safeHttpsUrl(d.website_url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${text}</a>`;
  }
  return html`<span class="faint">AI build preview</span> <a href="/staff/builds/${d.job_id ?? ""}/deliver"><code>${d.job_id ?? ""}</code></a>
    <span class="faint">rev ${String(d.revision_attempt ?? "")}-${String(d.revision_cycle ?? "")}</span>`;
}

const sourceLabel = (d: WD.DeliveryRow) => (d.source === "external_url" ? "Hosted website (external URL)" : "AI build");

/** The customer is told once per version that a website is ready for their review (email + portal notice). */
async function tellCustomer(ctx: AppContext, d: { id: string; project_id: string; visible_at: string | null }) {
  if (!d.visible_at) return;
  await notifyCustomer(ctx, d.project_id, { kind: "project", mail: { template: "project_update", data: { event: "preview_shared" } }, path: `/portal/projects/${d.project_id}`, key: `wdshare:${d.id}` });
}

export function register(r: Router): void {
  // ── Dashboard ────────────────────────────────────────────────────────────────────────────────────────────────
  r.get(BASE, async (ctx) => {
    requireStaff(ctx, PERM);
    const sp = ctx.url.searchParams;
    const q = (sp.get("q") ?? "").slice(0, 200);
    const status = pick<WD.StatusFilter>(sp.get("status"), STATUS_OPTIONS);
    const approval = pick<WD.ApprovalFilter>(sp.get("approval"), APPROVAL_OPTIONS);
    const { page, limit, offset } = pageParam(ctx);
    const { rows, total } = await WD.dashboard(ctx.db, { q, status, approval, limit, offset });

    const body = html`${pageHead("Website Delivery", linkButton("+ Add Website", `${BASE}/new`), "Hosted websites on customer projects")}
<p class="lede">Attach a website hosted anywhere (Cloudflare Pages, Vercel, the customer's own domain, …) to an existing customer
  project, share it in that customer's portal, and see their approval or requested changes here.</p>
<section class="card">
  <form method="get" action="${BASE}" class="row" style="gap:.75rem;align-items:end;flex-wrap:wrap" role="search">
    ${input({ name: "q", label: "Search customer, project or website", value: q, placeholder: "Harbor Dental, law firm, …", maxlength: 200 })}
    ${select({ name: "status", label: "Delivery status", options: STATUS_OPTIONS, value: status })}
    ${select({ name: "approval", label: "Customer approval", options: APPROVAL_OPTIONS, value: approval })}
    <div class="row" style="gap:.5rem">${button("Filter", { variant: "secondary", size: "sm" })}${q || status || approval ? html`<a class="btn btn--ghost btn--sm" href="${BASE}">Clear</a>` : ""}</div>
  </form>
</section>
<section class="card" style="margin-top:1rem">
  ${table(rows, [
    { header: "Customer", cell: (x) => html`${x.organization_name}` },
    { header: "Project", cell: (x) => html`<a href="/staff/projects/${x.project_id}">${x.project_name}</a>` },
    { header: "Website", cell: (x) => html`<a href="${BASE}/${x.id}"><strong>${x.website_name ?? (x.source === "ai_build" ? "AI-built website" : "Website")}</strong></a>` },
    { header: "URL", cell: (x) => websiteLink(x, true) },
    { header: "Version", cell: (x) => html`v${String(x.version)}${x.version_count > 1 ? html` <span class="faint">of ${String(x.version_count)}</span>` : ""}`, numeric: true },
    { header: "Status", cell: (x) => statusBadge(x) },
    { header: "Visibility", cell: (x) => html`${WD.visibilityLabel(x)}` },
    { header: "Approval", cell: (x) => approvalBadge(x) },
    { header: "Added", cell: (x) => html`${formatDateTime(x.assigned_at)}` },
    { header: "Last updated", cell: (x) => html`${formatDateTime(x.updated_at)}` },
    { header: "Staff", cell: (x) => html`${x.assigned_to_name ?? x.assigned_by_name ?? "—"}` },
    { header: "Actions", cell: (x) => html`<div class="row" style="gap:.25rem;flex-wrap:wrap">
        ${x.source === "external_url" && x.website_url
          ? html`<a class="btn btn--ghost btn--sm" href="${safeHttpsUrl(x.website_url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">View</a>`
          : html`<a class="btn btn--ghost btn--sm" href="${BASE}/${x.id}">View</a>`}
        <a class="btn btn--ghost btn--sm" href="${BASE}/${x.id}#edit">Edit</a>
        ${!x.superseded_at && !x.visible_at ? actionForm(ctx, `${BASE}/${x.id}/share`, "Share", { hidden: { back: "list" }, confirm: `Share "${x.website_name ?? "this website"}" with ${x.organization_name}? It will appear in their portal immediately.` }) : ""}
        <a class="btn btn--ghost btn--sm" href="${BASE}/${x.id}#replace">Replace</a>
        ${!x.superseded_at ? actionForm(ctx, `${BASE}/${x.id}/archive`, "Archive", { hidden: { back: "list" }, confirm: "Archive this website? The customer will no longer see it. It stays in the version history and can be restored." }) : ""}
      </div>` },
  ], {
    caption: "Website deliveries",
    empty: emptyState(q || status || approval ? "No website matches these filters" : "No websites delivered yet",
      q || status || approval ? "Clear the filters to see every delivery." : "Add a hosted website to an existing customer project to get started.",
      linkButton("+ Add Website", `${BASE}/new`)),
  })}
  ${total > limit ? html`<p class="faint" data-showing>Showing ${offset + (rows.length ? 1 : 0)}–${offset + rows.length} of ${total} websites.</p>${pagination(ctx, page, offset + rows.length < total)}` : ""}
</section>`;
    return staffPage(ctx, "Website Delivery", body);
  });

  // ── Add Website ──────────────────────────────────────────────────────────────────────────────────────────────
  const addPage = async (ctx: AppContext, v: { org?: string; projectId?: string; websiteName?: string; websiteUrl?: string; note?: string; assignedTo?: string },
    errors: Record<string, string> = {}, status = 200, general: string[] = []) => {
    const q = (ctx.url.searchParams.get("q") ?? "").slice(0, 200);
    const orgName = v.org ? await WD.organizationName(ctx.db, v.org) : null;
    const step1 = html`<section class="card">
  <h2 class="card__title">1. Customer</h2>
  ${orgName
    ? html`<p><strong>${orgName}</strong> <a class="btn btn--ghost btn--sm" href="${BASE}/new">Change customer</a></p>`
    : html`<form method="get" action="${BASE}/new" class="row" style="gap:.5rem;align-items:end;flex-wrap:wrap" role="search">
        ${input({ name: "q", label: "Search existing customers", value: q, placeholder: "Customer or company name", maxlength: 200 })}
        ${button("Search", { variant: "secondary", size: "sm" })}
      </form>
      ${await (async () => {
        const choices = await WD.customerChoices(ctx.db, q);
        return table(choices, [
          { header: "Customer", cell: (c) => html`${c.name}` },
          { header: "Projects", cell: (c) => String(c.projects), numeric: true },
          { header: "", cell: (c) => c.projects ? html`<a class="btn btn--secondary btn--sm" href="${BASE}/new?org=${c.id}">Select</a>` : html`<span class="faint">no open projects</span>` },
        ], { caption: "Customers", empty: emptyState("No customer matches that search", "Websites are delivered to existing customer accounts; nothing is created here.") });
      })()}`}
</section>`;

    let step2 = html``;
    if (orgName && v.org) {
      const projects = await WD.projectChoices(ctx.db, v.org);
      const staff = await WD.staffMembers(ctx.db);
      step2 = projects.length === 0
        ? alert("warn", "This customer has no open project. A website is delivered to an existing project, so create or reopen the project first.")
        : html`<form method="post" action="${BASE}" class="card stack" novalidate>
  ${csrf(ctx)}
  <input type="hidden" name="organizationId" value="${v.org}">
  <h2 class="card__title">2. Website details</h2>
  ${select({ name: "projectId", label: "Project", required: true, includeBlank: projects.length > 1 ? "Choose the project…" : undefined,
      options: projects.map((p) => ({ value: p.id, label: `${p.name} (${p.status.replace(/_/g, " ")})` })), value: v.projectId ?? (projects.length === 1 ? projects[0].id : ""), error: errors.projectId })}
  ${input({ name: "websiteName", label: "Website name", required: true, value: v.websiteName, maxlength: WD.WEBSITE_NAME_MAX, placeholder: "Harbor Dental website", error: errors.websiteName })}
  ${input({ name: "websiteUrl", label: "Website URL", type: "url", required: true, value: v.websiteUrl, maxlength: 2048, inputmode: "url", autocomplete: "off",
      placeholder: "https://customer-website.pages.dev", hint: "The full https:// address where the website is hosted. It opens in a new tab for the customer; Crestmont does not copy or check the website.", error: errors.websiteUrl })}
  ${select({ name: "assignedTo", label: "Assigned staff member", options: staff.map((s) => ({ value: s.id, label: s.display_name })), value: v.assignedTo ?? ctx.actor?.userId ?? "", error: errors.assignedTo })}
  ${textarea({ name: "note", label: "Internal notes (staff only)", value: v.note, rows: 3, maxlength: WD.NOTE_MAX, hint: "Never shown to the customer.", error: errors.note })}
  <p class="faint">This is version 1 if the project has no website yet; otherwise it becomes the project's next version and replaces the one the customer sees.</p>
  <div class="form-actions row" style="gap:.5rem;flex-wrap:wrap">
    ${button("Save Draft", { variant: "secondary", name: "intent", value: "draft" })}
    ${button("Save & Share with Customer", { name: "intent", value: "share" })}
    <a class="btn btn--ghost" href="${BASE}">Cancel</a>
  </div>
</form>`;
    }
    const body = html`${pageHead("Add Website", html`<a class="btn btn--ghost btn--sm" href="${BASE}">Back to Website Delivery</a>`, "Website Delivery")}
${formErrors(general)}${step1}${step2}`;
    return staffPage(ctx, "Add Website", body, status);
  };

  r.get(`${BASE}/new`, async (ctx) => {
    requireStaff(ctx, PERM);
    const sp = ctx.url.searchParams;
    // `?project=` starts from a known project (e.g. a link from the project's own page): its customer is read from
    // the project, never from the link, and only a customer's open project qualifies.
    const projectId = sp.get("project") ?? "";
    if (projectId) {
      const owner = await ctx.db.prepare(`SELECT p.organization_id FROM projects p JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = ? AND o.kind = 'customer' AND p.status <> 'cancelled'`).bind(projectId).first<{ organization_id: string }>();
      if (owner) return addPage(ctx, { org: owner.organization_id, projectId });
    }
    const org = sp.get("org") ?? "";
    return addPage(ctx, { org: org && (await WD.organizationName(ctx.db, org)) ? org : undefined });
  });

  r.post(BASE, async (ctx) => {
    requireStaff(ctx, PERM);
    const f = await ctx.form();
    const v = {
      org: str(f, "organizationId"), projectId: str(f, "projectId"), websiteName: str(f, "websiteName"),
      websiteUrl: str(f, "websiteUrl"), note: String(f.get("note") ?? "").trim(), assignedTo: str(f, "assignedTo"),
    };
    const share = str(f, "intent") === "share";
    const errors = WD.validateExternalInput(v);
    // Project ownership: the project must belong to the customer that was chosen in step 1.
    const orgName = v.org ? await WD.organizationName(ctx.db, v.org) : null;
    if (!orgName) return addPage(ctx, {}, {}, 422, ["Choose the customer first."]);
    if (v.projectId && !errors.projectId && !(await WD.projectChoices(ctx.db, v.org)).some((p) => p.id === v.projectId)) {
      errors.projectId = "That project does not belong to this customer, or is not open.";
    }
    if (Object.keys(errors).length) return addPage(ctx, v, errors, 422);
    const res = await WD.createExternal(ctx.db, {
      projectId: v.projectId, websiteName: v.websiteName, websiteUrl: v.websiteUrl, note: v.note || null, share,
      actorId: actorId(ctx), assignedTo: v.assignedTo || null, ip: ctx.ip ?? null,
    });
    if (!res.ok) return addPage(ctx, v, {}, 422, [res.why]);
    if (share) await tellCustomer(ctx, res.delivery);
    return redirect(ctx, `${BASE}/${res.delivery.id}`, {
      kind: "success",
      text: share
        ? `Version ${res.delivery.version} saved and shared. ${orgName} can now see it on their project page.`
        : `Version ${res.delivery.version} saved as a draft. Only staff can see it until you share it.`,
    });
  });

  // ── One delivery: current version, actions and full version history ─────────────────────────────────────────
  r.get(`${BASE}/:id`, async (ctx, p) => {
    requireStaff(ctx, PERM);
    const d = await deliveryOr404(ctx, p.id);
    const head = (await WD.headForProject(ctx.db, d.project_id))!;
    const versions = await WD.versionsForProject(ctx.db, d.project_id);
    const project = (await ctx.db.prepare(`SELECT p.name, o.name AS org FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?`)
      .bind(d.project_id).first<{ name: string; org: string }>())!;
    const staff = await WD.staffMembers(ctx.db);
    const live = !head.superseded_at;
    const cur = versions.find((v) => v.id === head.id)!;

    const body = html`${pageHead(head.website_name ?? "Website", html`<a class="btn btn--ghost btn--sm" href="${BASE}">Back to Website Delivery</a>`, `${project.org} · ${project.name}`)}
${d.id !== head.id ? alert("info", html`You followed a link to version ${String(d.version)}. The current version is ${String(head.version)}; the full history is below.`) : ""}
${head.customer_decision === "revision_requested" ? alert("warn", html`<strong>The customer asked for changes</strong> on ${formatDateTime(head.customer_reviewed_at)}${cur.decided_by_name ? ` (${cur.decided_by_name})` : ""}: “${head.customer_note ?? ""}”. Replace the website with a revised version below; it will need its own approval.`) : ""}
${head.customer_decision === "approved" ? alert("success", html`<strong>The customer approved version ${String(head.version)}</strong> on ${formatDateTime(head.customer_reviewed_at)}${cur.decided_by_name ? ` (${cur.decided_by_name})` : ""}${head.customer_note ? html`: “${head.customer_note}”` : ""}.`) : ""}
<div class="grid grid-2">
<section class="card">
  <h2 class="card__title">Current version</h2>
  ${dl([
    ["Customer", project.org],
    ["Project", html`<a href="/staff/projects/${d.project_id}">${project.name}</a>`],
    ["Website", head.website_name ?? "—"],
    ["Source", sourceLabel(head)],
    ["Website URL", websiteLink(head)],
    ["Version", `v${head.version}`],
    ["Status", statusBadge(head)],
    ["Customer visibility", WD.visibilityLabel(head)],
    ["Customer approval", approvalBadge(head)],
    ["Customer feedback", head.customer_note ?? "—"],
    ["Date added", formatDateTime(head.assigned_at)],
    ["Shared with customer", head.visible_at ? formatDateTime(head.visible_at) : "Not shared"],
    ["Last updated", formatDateTime(head.updated_at)],
    ["Assigned staff", cur.assigned_to_name ?? "—"],
    ["Internal notes", head.note ?? "—"],
  ])}
  <div class="row" style="gap:.5rem;flex-wrap:wrap;margin-top:1rem">
    ${head.source === "external_url" && head.website_url ? html`<a class="btn btn--secondary btn--sm" href="${safeHttpsUrl(head.website_url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">View website</a>` : ""}
    ${live && !head.visible_at ? actionForm(ctx, `${BASE}/${head.id}/share`, "Share with customer", { variant: "primary", confirm: `Share version ${head.version} with ${project.org}? It will appear in their portal immediately.` }) : ""}
    ${live ? actionForm(ctx, `${BASE}/${head.id}/archive`, "Archive", { variant: "danger", confirm: "Archive this website? The customer will no longer see it. It stays in the version history and can be restored." }) : ""}
  </div>
  ${!live ? alert("info", "This project has no live website: the newest version is archived. Restore a version below, or replace it with a new address.") : ""}
</section>
<section class="stack">
  <form id="edit" method="post" action="${BASE}/${head.id}/edit" class="card stack">
    ${csrf(ctx)}
    <h2 class="card__title">Edit details</h2>
    <p class="faint">Changes the name, responsible staff member and internal notes of version ${String(head.version)}. To change the website address, replace it below — that creates a new version.</p>
    ${input({ name: "websiteName", label: "Website name", value: head.website_name, maxlength: WD.WEBSITE_NAME_MAX, required: head.source === "external_url" })}
    ${select({ name: "assignedTo", label: "Assigned staff member", options: staff.map((s) => ({ value: s.id, label: s.display_name })), value: head.assigned_to ?? "", includeBlank: head.assigned_to ? undefined : "Unassigned" })}
    ${textarea({ name: "note", label: "Internal notes (staff only)", value: head.note, rows: 3, maxlength: WD.NOTE_MAX })}
    <div class="row">${button("Save changes", { variant: "secondary", size: "sm" })}</div>
  </form>
  <form id="replace" method="post" action="${BASE}/${head.id}/replace" class="card stack" novalidate>
    ${csrf(ctx)}
    <h2 class="card__title">Replace with a new version</h2>
    <p class="faint">Adds version ${String(versions.length ? Math.max(...versions.map((v) => v.version)) + 1 : 1)} with a new address. Version ${String(head.version)} is kept in the history with its own approval; the new version needs a fresh customer decision.</p>
    ${input({ id: "f-replace-url", name: "websiteUrl", label: "New website URL", type: "url", required: true, maxlength: 2048, inputmode: "url", autocomplete: "off", placeholder: "https://customer-website.pages.dev" })}
    ${input({ id: "f-replace-name", name: "websiteName", label: "Website name", value: head.website_name, maxlength: WD.WEBSITE_NAME_MAX })}
    ${textarea({ id: "f-replace-note", name: "note", label: "Internal notes for this version (staff only)", rows: 2, maxlength: WD.NOTE_MAX })}
    <div class="row" style="gap:.5rem;flex-wrap:wrap">
      ${button("Save as draft", { variant: "secondary", size: "sm", name: "intent", value: "draft" })}
      ${button("Save & share with customer", { size: "sm", name: "intent", value: "share" })}
    </div>
  </form>
</section>
</div>
<section class="card" style="margin-top:1.5rem">
  <h2 class="card__title">Version history</h2>
  ${table(versions, [
    { header: "Version", cell: (v) => html`<strong>v${String(v.version)}</strong>${v.id === head.id ? html` ${badge("active", live ? "current" : "newest")}` : ""}${v.restored_from ? html`<br><span class="faint">restored copy</span>` : ""}` },
    { header: "Website", cell: (v) => html`${v.website_name ?? "—"}<br>${websiteLink(v, true)}` },
    { header: "Added", cell: (v) => html`${formatDateTime(v.assigned_at)}<br><span class="faint">by ${v.assigned_by_name ?? "—"}</span>` },
    { header: "Visibility", cell: (v) => html`${WD.visibilityLabel(v)}${v.visible_at ? html`<br><span class="faint">shared ${formatDateTime(v.visible_at)}</span>` : ""}` },
    { header: "Customer decision", cell: (v) => html`${approvalBadge(v)}${v.customer_reviewed_at ? html`<br><span class="faint">${formatDateTime(v.customer_reviewed_at)}${v.decided_by_name ? ` · ${v.decided_by_name}` : ""}</span>` : ""}` },
    { header: "Customer feedback", cell: (v) => v.customer_note ?? "—" },
    { header: "Internal notes", cell: (v) => v.note ?? "—" },
    { header: "", cell: (v) => v.superseded_at ? html`<div class="row" style="gap:.25rem;flex-wrap:wrap">
        ${actionForm(ctx, `${BASE}/${v.id}/restore`, "Restore as draft", { hidden: { share: "no" }, confirm: `Restore version ${v.version} as a new draft version? The customer's current website stays until you share it.` })}
        ${actionForm(ctx, `${BASE}/${v.id}/restore`, "Restore & share", { hidden: { share: "yes" }, confirm: `Restore version ${v.version} and show it to the customer now? It replaces what they currently see.` })}
      </div>` : "" },
  ], { caption: "Version history" })}
</section>`;
    return staffPage(ctx, head.website_name ?? "Website", body);
  });

  r.post(`${BASE}/:id/edit`, async (ctx, p) => {
    requireStaff(ctx, PERM);
    await deliveryOr404(ctx, p.id);
    const f = await ctx.form();
    const res = await WD.updateDetails(ctx.db, {
      deliveryId: p.id, websiteName: f.has("websiteName") ? str(f, "websiteName") : undefined,
      assignedTo: f.has("assignedTo") ? str(f, "assignedTo") : undefined,
      note: f.has("note") ? String(f.get("note") ?? "") : undefined, actorId: actorId(ctx), ip: ctx.ip ?? null,
    });
    if (!res.ok) return redirect(ctx, `${BASE}/${p.id}`, { kind: "error", text: res.why });
    return redirect(ctx, `${BASE}/${p.id}`, { kind: "success", text: "Details saved." });
  });

  r.post(`${BASE}/:id/share`, async (ctx, p) => {
    requireStaff(ctx, PERM);
    await deliveryOr404(ctx, p.id);
    const f = await ctx.form();
    const res = await WD.makeVisibleToCustomer(ctx.db, p.id, { actorId: actorId(ctx), ip: ctx.ip ?? null });
    if (!res.ok) return redirect(ctx, back(f, p.id), { kind: "error", text: res.why });
    // The customer is told once per version that a website is ready for their review (email + portal notice).
    if (res.newlyVisible) await tellCustomer(ctx, res.delivery);
    return redirect(ctx, back(f, p.id), { kind: "success", text: `Version ${res.delivery.version} is now visible in the customer's portal.` });
  });

  r.post(`${BASE}/:id/replace`, async (ctx, p) => {
    requireStaff(ctx, PERM);
    await deliveryOr404(ctx, p.id);
    const f = await ctx.form();
    const share = str(f, "intent") === "share";
    const res = await WD.replaceWithExternal(ctx.db, {
      deliveryId: p.id, websiteUrl: str(f, "websiteUrl"), websiteName: str(f, "websiteName") || null,
      note: String(f.get("note") ?? "").trim() || null, share, actorId: actorId(ctx), ip: ctx.ip ?? null,
    });
    if (!res.ok) return redirect(ctx, `${BASE}/${p.id}#replace`, { kind: "error", text: res.why });
    if (share) await tellCustomer(ctx, res.delivery);
    return redirect(ctx, `${BASE}/${res.delivery.id}`, {
      kind: "success", text: `Version ${res.delivery.version} added${share ? " and shared with the customer" : " as a draft"}.`,
    });
  });

  r.post(`${BASE}/:id/archive`, async (ctx, p) => {
    requireStaff(ctx, PERM);
    await deliveryOr404(ctx, p.id);
    const f = await ctx.form();
    const res = await WD.archive(ctx.db, { deliveryId: p.id, actorId: actorId(ctx), ip: ctx.ip ?? null });
    if (!res.ok) return redirect(ctx, back(f, p.id), { kind: "error", text: res.why });
    return redirect(ctx, back(f, p.id), { kind: "success", text: `Version ${res.delivery.version} archived. The customer no longer sees it.` });
  });

  // Restoring an earlier version: a NEW version that names the old one. The old row is never edited.
  r.post(`${BASE}/:id/restore`, async (ctx, p) => {
    requireStaff(ctx, PERM);
    const d = await deliveryOr404(ctx, p.id);
    const f = await ctx.form();
    const share = str(f, "share") === "yes";
    const res = await WD.rollbackTo(ctx.db, { projectId: d.project_id, deliveryId: d.id, actorId: actorId(ctx), makeVisible: share, ip: ctx.ip ?? null });
    if (!res.ok) return redirect(ctx, `${BASE}/${d.id}`, { kind: "error", text: res.why });
    if (share) await tellCustomer(ctx, res.delivery);
    return redirect(ctx, `${BASE}/${res.delivery.id}`, {
      kind: "success", text: `Version ${d.version} restored as version ${res.delivery.version}${share ? " and shared with the customer" : " (draft)"}.`,
    });
  });
}
