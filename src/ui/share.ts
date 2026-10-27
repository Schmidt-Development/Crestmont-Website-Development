// Share-link panel (SEC-003) used on the customer file page and the staff file share page.
import { html, formatDateTime, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import { csrf, button, checkbox, select, input, badge, table, actionForm, alert } from "./components.ts";
import { SHARE_DURATIONS, shareState, type ShareLinkRow } from "../services/share-links.ts";
import type { FileRow } from "../services/files.ts";

export function sharePanel(ctx: AppContext, f: FileRow, links: ShareLinkRow[], opts: { canManage: boolean; created?: { url: string; expiresAt: string } | null }): SafeHtml {
  const now = ctx.now();
  const scanWarn = f.scan_status !== "clean";
  const blocked = f.scan_status === "infected" || f.scan_status === "failed";
  return html`<section class="card stack" id="share" data-share-panel><h2 class="card__title">Share with a link</h2>
<p class="muted">Creates a private, time-limited link that lets someone without an account download <strong>this file only</strong>. Links expire after at most 7 days, can be revoked at any time, and every use is logged.</p>
${opts.created ? html`<div class="alert alert--success" role="status"><strong>Share link created.</strong> Copy it now — for security it is shown only once and cannot be retrieved later.
<code class="share-url" data-share-url>${opts.created.url}</code><span class="faint">Expires ${formatDateTime(opts.created.expiresAt)}.</span></div>` : ""}
${blocked ? alert("error", "This file cannot be shared: its malware scan did not pass.")
    : !opts.canManage ? html`<p class="faint">Only an account administrator can create share links for your organization's files.</p>`
    : html`${scanWarn ? alert("warn", html`<strong>Not scanned for malware.</strong> Malware scanning is not configured yet, so this file has not been checked. Anyone you share it with receives it unscanned.`) : ""}
<form method="post" action="/files/${f.id}/share" class="stack">${csrf(ctx)}
${select({ name: "hours", id: `share-hours-${f.id}`, label: "Link valid for", options: SHARE_DURATIONS.map((d) => ({ value: String(d.hours), label: d.label })), value: "72" })}
${input({ name: "note", id: `share-note-${f.id}`, label: "Note (optional)", maxlength: 200, hint: "Who the link is for — shown only to your team." })}
${scanWarn ? checkbox("acknowledge_unscanned", "I understand this file has not been scanned for malware and want to share it anyway.") : ""}
<div class="form-actions">${button("Create share link", { variant: "secondary", size: "sm" })}</div></form>`}
${links.length ? table(links, [
    { header: "Created", cell: (s) => html`${formatDateTime(s.created_at)}<br><span class="faint">${s.creator_name ?? ""}</span>` },
    { header: "Expires", cell: (s) => formatDateTime(s.expires_at) },
    { header: "Status", cell: (s) => { const st = shareState(s, now); return badge(st === "active" ? "active" : st === "revoked" ? "cancelled" : "stale", st === "active" ? "Active" : st === "revoked" ? "Revoked" : "Expired"); } },
    { header: "Uses", cell: (s) => html`${s.access_count}${s.last_accessed_at ? html`<br><span class="faint">last ${formatDateTime(s.last_accessed_at)}</span>` : ""}`, numeric: true },
    { header: "Note", cell: (s) => html`${s.note ?? "—"}${s.unscanned_acknowledged ? html`<br>${badge("test_pending", "Shared unscanned")}` : ""}` },
    { header: "", cell: (s) => (opts.canManage && shareState(s, now) === "active" ? actionForm(ctx, `/files/share-links/${s.id}/revoke`, "Revoke", { variant: "danger", confirm: "Revoke this link? Anyone holding it will lose access." }) : "") },
  ], { caption: "Share links for this file" }) : html`<p class="faint">No share links yet.</p>`}</section>`;
}
