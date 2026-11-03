// Owner Dashboard: AI -> Design Gallery (Founder directive, 2026-11-02, Part 5).
//
// This is THE gallery, not a view of one. Every control here writes the same `design_references` rows that
// services/design-gallery.ts reads when the AI selects references for a build, so the owner's decisions bind the
// builder by construction. There is no second store to fall out of step with (J01, J02, J07).
//
// Images go to the existing object store (R2 in production, the local-disk adapter in development); only keys live
// in D1. Uploads are validated with the same helper the customer portal uses, so an unexpected file type or an
// oversized upload is refused here exactly as it is there (5.8).

import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime } from "../lib/html.ts";
import { HttpError, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { can } from "../domain/authz.ts";
import { staffPage } from "./crm.ts";
import { alert, badge, button, csrf, emptyState, input, kpi, pageHead, select, table, textarea, linkButton } from "../ui/components.ts";
import { validateUpload, UPLOAD_LIMIT_BYTES } from "../adapters/storage.ts";
import { sha256Hex } from "../lib/crypto.ts";
import * as G from "../services/design-gallery.ts";

const INDUSTRIES = ["luxury", "automotive", "construction", "home-services", "technology", "saas", "professional", "hospitality", "restaurants", "healthcare", "ecommerce", "editorial", "minimalist", "cinematic", "bold-contemporary", "interactive"];

const statusBadge = (s: G.ReferenceStatus) =>
  s === "APPROVED" ? badge("ok", "Approved") : s === "PENDING_REVIEW" ? badge("warn", "Pending review") : s === "DISABLED" ? badge("muted", "Disabled") : badge("danger", "Rejected");

export function register(r: Router): void {
  // ── the gallery ──────────────────────────────────────────────────────────────────────────────────────────────
  r.get("/staff/builds/gallery", async (ctx) => {
    requireStaff(ctx, "builds.read");
    const manage = can(ctx.actor!, "builds.configure");
    const url = ctx.url;
    const filter: G.ListFilter = {
      status: (url.searchParams.get("status") as G.ReferenceStatus | "ALL") ?? "ALL",
      industry: url.searchParams.get("industry") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      limit: 60, offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
    };
    const [{ rows, total }, c, version] = await Promise.all([G.listReferences(ctx.db, filter), G.counts(ctx.db), G.galleryVersion(ctx.db)]);

    const body = html`${pageHead("AI → Design Gallery", linkButton("AI builds", "/staff/builds", "ghost", "sm"), "The one approved reference set every build draws on")}
${alert("info", html`This is the gallery the AI itself reads. <strong>Starter, Business and Premium all draw on it and are held to the same visual standard</strong> — packages differ in scope and deliverables, not in whether the website is allowed to look premium. Disabling or removing a reference stops it being selected for new builds immediately. Gallery version <code>${String(version)}</code>.`)}
<div class="kpis">${kpi("Approved and AI-eligible", c.aiEligible, `target ${G.GALLERY_TARGET}`)}${kpi("Pending review", c.pending)}${kpi("Disabled", c.disabled)}${kpi("Rejected", c.rejected)}${kpi("Total", c.total)}</div>
${c.aiEligible < G.GALLERY_TARGET ? alert("warn", html`The gallery holds <strong>${String(c.aiEligible)}</strong> approved, rights-cleared references against a target of ${String(G.GALLERY_TARGET)}. Builds still run; they simply have fewer references to work from. References with an unverified rights basis are never given to the AI.`) : ""}

<form method="get" action="/staff/builds/gallery" class="row" style="gap:.5rem;align-items:end;flex-wrap:wrap">
  ${input({ name: "q", label: "Search", value: filter.q ?? "", maxlength: 60 })}
  ${select({ name: "status", label: "Status", value: filter.status ?? "ALL", options: [{ value: "ALL", label: "All" }, ...G.STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))] })}
  ${select({ name: "industry", label: "Industry", value: filter.industry ?? "", options: [{ value: "", label: "Any" }, ...INDUSTRIES.map((i) => ({ value: i, label: i }))] })}
  ${button("Filter", { size: "sm" })}
</form>

${manage ? html`<section class="card"><h2 class="card__title">Add a reference</h2>
<form method="post" action="/staff/builds/gallery/add" enctype="multipart/form-data" class="stack">${csrf(ctx)}
  <div class="grid grid-3">
    ${input({ name: "title", label: "Title", required: true, maxlength: 200 })}
    ${select({ name: "industry", label: "Industry", options: INDUSTRIES.map((i) => ({ value: i, label: i })) })}
    ${input({ name: "style_tags", label: "Style tags (comma separated)", maxlength: 200, hint: "editorial, minimalist, cinematic" })}
  </div>
  <div class="grid grid-3">
    ${input({ name: "source_url", label: "Source URL (optional)", maxlength: 500 })}
    ${input({ name: "source_name", label: "Source name (optional)", maxlength: 120 })}
    ${select({ name: "rights_basis", label: "Rights basis", value: "owner_supplied", options: [
      { value: "owner_supplied", label: "Supplied by the owner" }, { value: "licensed", label: "Licensed" },
      { value: "public_permitted", label: "Public source, terms permit" }, { value: "own_work", label: "Crestmont's own work" },
      { value: "unverified", label: "Unverified (never given to the AI)" }] })}
  </div>
  <div class="field"><label for="f-desktop">Desktop screenshot</label><input class="input" id="f-desktop" type="file" name="desktop" accept="image/*" required></div>
  <div class="field"><label for="f-mobile">Mobile screenshot (optional)</label><input class="input" id="f-mobile" type="file" name="mobile" accept="image/*"></div>
  ${textarea({ name: "quality_notes", label: "What makes it good", rows: 2, maxlength: 2000, id: "f-qn" })}
  ${button("Add to gallery", { variant: "primary", disabled: !ctx.storage })}
  ${!ctx.storage ? html`<p class="faint">No object store is configured on this environment, so uploads are unavailable.</p>` : ""}
  <p class="faint">A new reference waits at <strong>pending review</strong> until it is approved here; nothing becomes available to the AI on its own. An inspiration screenshot is never licensed for use in a customer's website.</p>
</form></section>` : ""}

<section class="card"><h2 class="card__title">References${total ? html` <span class="faint">(${String(total)})</span>` : ""}</h2>
${table(rows, [
  { header: "Reference", cell: (x) => html`<a href="/staff/builds/gallery/${x.id}"><strong>${x.title}</strong></a><br><span class="faint">${x.industry}${G.tags(x).length ? ` · ${G.tags(x).join(", ")}` : ""}</span>` },
  { header: "Preview", cell: (x) => x.desktop_key ? html`<a href="/staff/builds/gallery/${x.id}/image?which=desktop"><img src="/staff/builds/gallery/${x.id}/image?which=desktop" alt="${x.title}" style="width:140px;height:auto;border-radius:6px"></a>` : html`<span class="faint">no image</span>` },
  { header: "Status", cell: (x) => html`${statusBadge(x.status)}${x.ai_eligible && x.rights_basis !== "unverified" ? "" : html`<br><span class="faint">not given to the AI</span>`}` },
  { header: "Rights", cell: (x) => html`${x.rights_basis.replace(/_/g, " ")}` },
  { header: "Updated", cell: (x) => formatDateTime(x.updated_at) },
  { header: "", cell: (x) => manage ? html`<form method="post" action="/staff/builds/gallery/${x.id}/decide" class="row" style="gap:.25rem">${csrf(ctx)}
      ${x.status !== "APPROVED" ? button("Approve", { name: "decision", value: "approve", size: "sm" }) : ""}
      ${x.status === "APPROVED" ? button("Disable", { name: "decision", value: "disable", variant: "ghost", size: "sm" }) : ""}
      ${x.status === "DISABLED" ? button("Enable", { name: "decision", value: "enable", size: "sm" }) : ""}
      ${x.status !== "REJECTED" ? button("Reject", { name: "decision", value: "reject", variant: "ghost", size: "sm" }) : ""}
    </form>` : "" },
], { empty: emptyState("The gallery is empty", "Add references above. Each one waits for your approval before the AI can use it.") })}
</section>`;
    return staffPage(ctx, "AI → Design Gallery", body);
  });

  // ── one reference ────────────────────────────────────────────────────────────────────────────────────────────
  r.get("/staff/builds/gallery/:id", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const manage = can(ctx.actor!, "builds.configure");
    const x = await G.getReference(ctx.db, String(p.id));
    if (!x) throw new HttpError(404, "That design reference does not exist.");
    const events = (await ctx.db.prepare(`SELECT at, action, note FROM design_reference_events WHERE reference_id = ? ORDER BY id DESC LIMIT 50`).bind(x.id).all<{ at: string; action: string; note: string | null }>()).results;
    const used = (await ctx.db.prepare(`SELECT job_id, gallery_version, selected_at FROM design_reference_uses WHERE reference_id = ? ORDER BY id DESC LIMIT 20`).bind(x.id).all<{ job_id: string; gallery_version: number; selected_at: string }>()).results;
    const body = html`${pageHead(x.title, linkButton("Design Gallery", "/staff/builds/gallery", "ghost", "sm"), x.industry)}
<div class="row" style="gap:1rem;align-items:flex-start;flex-wrap:wrap">
  ${x.desktop_key ? html`<figure><img src="/staff/builds/gallery/${x.id}/image?which=desktop" alt="${x.title} desktop" style="max-width:520px;border-radius:8px"><figcaption class="faint">Desktop</figcaption></figure>` : ""}
  ${x.mobile_key ? html`<figure><img src="/staff/builds/gallery/${x.id}/image?which=mobile" alt="${x.title} mobile" style="max-width:220px;border-radius:8px"><figcaption class="faint">Mobile</figcaption></figure>` : ""}
</div>
<section class="card"><h2 class="card__title">Details</h2>
  <p>${statusBadge(x.status)} · rights: ${x.rights_basis.replace(/_/g, " ")}${x.rights_note ? html` — ${x.rights_note}` : ""}</p>
  ${x.source_url ? html`<p class="faint">Source: <a href="${x.source_url}" rel="noreferrer noopener nofollow" target="_blank">${x.source_name ?? x.source_url}</a></p>` : ""}
  ${x.quality_notes ? html`<p>${x.quality_notes}</p>` : ""}
</section>
${manage ? html`<section class="card"><h2 class="card__title">Edit</h2>
<form method="post" action="/staff/builds/gallery/${x.id}/edit" class="stack">${csrf(ctx)}
  <div class="grid grid-3">${input({ name: "title", label: "Title", value: x.title, maxlength: 200 })}
  ${select({ name: "industry", label: "Industry", value: x.industry, options: INDUSTRIES.map((i) => ({ value: i, label: i })) })}
  ${input({ name: "style_tags", label: "Style tags", value: G.tags(x).join(", "), maxlength: 200 })}</div>
  <div class="grid grid-3">${input({ name: "source_url", label: "Source URL", value: x.source_url ?? "", maxlength: 500 })}
  ${select({ name: "rights_basis", label: "Rights basis", value: x.rights_basis, options: G.RIGHTS.map((v) => ({ value: v, label: v.replace(/_/g, " ") })) })}
  ${select({ name: "ai_eligible", label: "Give to the AI", value: x.ai_eligible ? "1" : "0", options: [{ value: "1", label: "Yes" }, { value: "0", label: "No" }] })}</div>
  ${textarea({ name: "quality_notes", label: "What makes it good", value: x.quality_notes ?? "", rows: 2, maxlength: 2000, id: "f-qn2" })}
  ${button("Save changes", { variant: "primary" })}
</form>
<form method="post" action="/staff/builds/gallery/${x.id}/remove" class="stack" style="margin-top:1rem"
      onsubmit="return confirm('Remove this reference? It stops being selected for new builds immediately. Its history is kept.')">${csrf(ctx)}
  ${button("Remove from gallery", { variant: "danger", size: "sm" })}
  <p class="faint">Removal is immediate for new builds. Websites already generated are unaffected.</p>
</form></section>` : ""}
<section class="card"><h2 class="card__title">History</h2>${table(events, [
  { header: "When", cell: (e) => formatDateTime(e.at) }, { header: "Action", cell: (e) => html`${e.action}` }, { header: "Note", cell: (e) => html`${e.note ?? ""}` },
], { empty: emptyState("No history", "") })}</section>
<section class="card"><h2 class="card__title">Used by builds</h2>${table(used, [
  { header: "Build", cell: (u) => html`<a href="/staff/builds/${u.job_id}">${u.job_id}</a>` },
  { header: "Gallery version", cell: (u) => html`${String(u.gallery_version)}` },
  { header: "Selected", cell: (u) => formatDateTime(u.selected_at) },
], { empty: emptyState("Not used yet", "Builds record the references they were given.") })}</section>`;
    return staffPage(ctx, x.title, body);
  });

  // The image itself, served from the object store. Staff-only: the gallery is internal reference material.
  r.get("/staff/builds/gallery/:id/image", async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const x = await G.getReference(ctx.db, String(p.id));
    if (!x) throw new HttpError(404, "That design reference does not exist.");
    const which = ctx.url.searchParams.get("which") ?? "desktop";
    const key = which === "mobile" ? x.mobile_key : which === "tablet" ? x.tablet_key : x.desktop_key;
    if (!key || !ctx.storage) throw new HttpError(404, "No image is stored for that reference.");
    const obj = await ctx.storage.get(key);
    if (!obj) throw new HttpError(404, "That image is no longer in storage.");
    return new Response(obj.body as BodyInit, { headers: { "content-type": obj.contentType, "cache-control": "private, max-age=300" } });
  });

  // ── owner actions ────────────────────────────────────────────────────────────────────────────────────────────
  r.post("/staff/builds/gallery/add", async (ctx) => {
    requireStaff(ctx, "builds.configure");
    if (!ctx.storage) throw new HttpError(503, "No object store is configured on this environment.");
    const form = await ctx.form();
    const file = form.get("desktop");
    if (!(file instanceof File) || !file.size) throw new HttpError(422, "Choose a desktop screenshot to upload.");
    if (file.size > UPLOAD_LIMIT_BYTES) throw new HttpError(422, `That image is larger than the ${Math.round(UPLOAD_LIMIT_BYTES / 1024 / 1024)} MB limit.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const v = validateUpload(file.name, bytes);
    if (!v.ok) throw new HttpError(422, v.reason);
    if (!v.contentType.startsWith("image/")) throw new HttpError(422, "A design reference must be an image.");
    const checksum = await sha256Hex(bytes);

    const id = `dref_${checksum.slice(0, 16)}`;
    const desktopKey = `design-gallery/${id}/desktop.${v.ext}`;
    await ctx.storage.put(desktopKey, bytes, v.contentType);
    let mobileKey: string | null = null;
    const mob = form.get("mobile");
    if (mob instanceof File && mob.size) {
      if (mob.size > UPLOAD_LIMIT_BYTES) throw new HttpError(422, "The mobile screenshot is too large.");
      const mb = new Uint8Array(await mob.arrayBuffer());
      const mv = validateUpload(mob.name, mb);
      if (mv.ok && mv.contentType.startsWith("image/")) { mobileKey = `design-gallery/${id}/mobile.${mv.ext}`; await ctx.storage.put(mobileKey, mb, mv.contentType); }
    }
    const refId = await G.addReference(ctx.db, {
      title: str(form, "title"), industry: str(form, "industry"),
      styleTags: str(form, "style_tags").split(",").map((s) => s.trim()).filter(Boolean),
      sourceUrl: str(form, "source_url") || null, sourceName: str(form, "source_name") || null,
      rightsBasis: str(form, "rights_basis") as G.RightsBasis,
      qualityNotes: str(form, "quality_notes") || null,
      desktopKey, mobileKey, checksum,
    }, ctx.actor!.userId ?? null, ctx.now());
    return redirect(ctx, `/staff/builds/gallery/${refId}`, { kind: "success", text: "Added to the gallery. It waits at pending review until you approve it." });
  });

  r.post("/staff/builds/gallery/:id/decide", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    const decision = str(form, "decision") as G.Decision;
    if (!["approve", "reject", "disable", "enable"].includes(decision)) throw new HttpError(422, "Unknown decision.");
    await G.decide(ctx.db, String(p.id), decision, ctx.actor!.userId ?? null, null, ctx.now());
    return redirect(ctx, "/staff/builds/gallery");
  });

  r.post("/staff/builds/gallery/:id/edit", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    await G.editReference(ctx.db, String(p.id), {
      title: str(form, "title"), industry: str(form, "industry"),
      styleTags: str(form, "style_tags").split(",").map((s) => s.trim()).filter(Boolean),
      sourceUrl: str(form, "source_url") || null,
      rightsBasis: str(form, "rights_basis") as G.RightsBasis,
      aiEligible: str(form, "ai_eligible") === "1",
      qualityNotes: str(form, "quality_notes") || null,
    }, ctx.actor!.userId ?? null, ctx.now());
    return redirect(ctx, `/staff/builds/gallery/${String(p.id)}`, { kind: "success", text: "Saved." });
  });

  r.post("/staff/builds/gallery/:id/remove", async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    await G.removeReference(ctx.db, String(p.id), ctx.actor!.userId ?? null, ctx.now());
    return redirect(ctx, "/staff/builds/gallery");
  });
}
