// Design-system components (BRAND-003..005). All output is escaped via `html`.
import { html, join, safeUrl, label as labelize, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";

export const csrf = (ctx: AppContext) => html`<input type="hidden" name="_csrf" value="${ctx.csrfToken}">`;

export function button(text: string, opts: { variant?: "primary" | "secondary" | "ghost" | "danger"; type?: "submit" | "button"; size?: "sm"; name?: string; value?: string; disabled?: boolean } = {}): SafeHtml {
  return html`<button class="btn btn--${opts.variant ?? "primary"}${opts.size ? " btn--sm" : ""}" type="${opts.type ?? "submit"}"${opts.name ? html` name="${opts.name}" value="${opts.value ?? ""}"` : ""}${opts.disabled ? html` disabled aria-disabled="true"` : ""}>${text}</button>`;
}

export function linkButton(text: string, href: string, variant: "primary" | "secondary" | "ghost" = "primary", size?: "sm"): SafeHtml {
  return html`<a class="btn btn--${variant}${size ? " btn--sm" : ""}" href="${safeUrl(href)}">${text}</a>`;
}

/** Inline POST form with a single button (for actions like "Approve"). */
export function actionForm(ctx: AppContext, action: string, text: string, opts: { variant?: "primary" | "secondary" | "ghost" | "danger"; hidden?: Record<string, string>; confirm?: string; size?: "sm" } = {}): SafeHtml {
  const hidden = Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  return html`<form method="post" action="${safeUrl(action)}" style="display:inline"${opts.confirm ? html` data-confirm="${opts.confirm}"` : ""}>${csrf(ctx)}${hidden}${button(text, { variant: opts.variant ?? "secondary", size: opts.size ?? "sm" })}</form>`;
}

interface FieldBase { name: string; label: string; hint?: string; error?: string; required?: boolean; id?: string }

export function input(f: FieldBase & { type?: string; value?: string | number | null; autocomplete?: string; placeholder?: string; min?: number; max?: number; step?: string; pattern?: string; maxlength?: number; inputmode?: string }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  return html`<div class="field"><label for="${id}">${f.label}${f.required ? html` <span aria-hidden="true" class="faint">*</span>` : ""}</label>
<input class="input" id="${id}" name="${f.name}" type="${f.type ?? "text"}" value="${f.value ?? ""}"${f.required ? html` required` : ""}${f.autocomplete ? html` autocomplete="${f.autocomplete}"` : ""}${f.placeholder ? html` placeholder="${f.placeholder}"` : ""}${f.min !== undefined ? html` min="${f.min}"` : ""}${f.max !== undefined ? html` max="${f.max}"` : ""}${f.step ? html` step="${f.step}"` : ""}${f.maxlength ? html` maxlength="${f.maxlength}"` : ""}${f.inputmode ? html` inputmode="${f.inputmode}"` : ""}${f.error ? html` aria-invalid="true" aria-describedby="${id}-err"` : f.hint ? html` aria-describedby="${id}-hint"` : ""}>
${f.hint ? html`<span class="hint" id="${id}-hint">${f.hint}</span>` : ""}${f.error ? html`<span class="error-text" id="${id}-err" role="alert">${f.error}</span>` : ""}</div>`;
}

export function textarea(f: FieldBase & { value?: string | null; rows?: number; maxlength?: number }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  return html`<div class="field"><label for="${id}">${f.label}${f.required ? html` <span aria-hidden="true" class="faint">*</span>` : ""}</label>
<textarea class="textarea" id="${id}" name="${f.name}" rows="${f.rows ?? 5}"${f.required ? html` required` : ""}${f.maxlength ? html` maxlength="${f.maxlength}"` : ""}${f.error ? html` aria-invalid="true" aria-describedby="${id}-err"` : ""}>${f.value ?? ""}</textarea>
${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}${f.error ? html`<span class="error-text" id="${id}-err" role="alert">${f.error}</span>` : ""}</div>`;
}

export function select(f: FieldBase & { options: { value: string; label: string }[] | string[]; value?: string | null; includeBlank?: string }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  const opts = f.options.map((o) => (typeof o === "string" ? { value: o, label: labelize(o) } : o));
  return html`<div class="field"><label for="${id}">${f.label}</label>
<select class="select" id="${id}" name="${f.name}"${f.required ? html` required` : ""}${f.error ? html` aria-invalid="true"` : ""}>
${f.includeBlank !== undefined ? html`<option value="">${f.includeBlank}</option>` : ""}
${opts.map((o) => html`<option value="${o.value}"${o.value === (f.value ?? "") ? html` selected` : ""}>${o.label}</option>`)}
</select>${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}${f.error ? html`<span class="error-text" role="alert">${f.error}</span>` : ""}</div>`;
}

export function checkbox(name: string, text: string, opts: { checked?: boolean; value?: string; required?: boolean } = {}): SafeHtml {
  return html`<label class="checkbox"><input type="checkbox" name="${name}" value="${opts.value ?? "1"}"${opts.checked ? html` checked` : ""}${opts.required ? html` required` : ""}> <span>${text}</span></label>`;
}

export function fileInput(name: string, labelText: string, opts: { multiple?: boolean; hint?: string; accept?: string } = {}): SafeHtml {
  return html`<div class="field dropzone"><label for="f-${name}">${labelText}</label>
<input id="f-${name}" class="input" type="file" name="${name}"${opts.multiple ? html` multiple` : ""} accept="${opts.accept ?? ".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.zip,.txt,.csv"}">
<span class="hint">${opts.hint ?? "PDF, images, Word, Excel, ZIP, text or CSV · up to 25 MB each"}</span></div>`;
}

export function formErrors(errors: string[]): SafeHtml {
  if (!errors.length) return html``;
  return html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

export function alert(kind: "info" | "success" | "error" | "warn", body: SafeHtml | string): SafeHtml {
  return html`<div class="alert alert--${kind}" role="${kind === "error" ? "alert" : "status"}">${body}</div>`;
}

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "gold" | ""> = {
  // generic
  active: "ok", paid: "ok", succeeded: "ok", approved: "ok", completed: "ok", done: "ok", resolved: "ok", closed: "", verified: "ok", pass: "ok", healthy: "ok",
  delivered: "ok", sent: "info", converted: "ok", accepted: "ok", published: "ok", clean: "ok", issued: "ok", production_verified: "ok",
  verified_in_staging: "ok", verified_in_development: "info", implemented: "info", maintenance: "ok",
  open: "info", in_progress: "info", new: "info", qualified: "info", quote_sent: "info", draft: "", pending: "", todo: "", review: "info",
  quote_required: "warn", negotiation: "warn", awaiting_payment: "warn", pending_customer: "warn", pending_staff: "warn", escalated: "bad",
  past_due: "bad", failed: "bad", rejected: "bad", lost: "", archived: "", blocked: "bad", test_failed: "bad", fail: "bad", failing: "bad",
  stale: "warn", unavailable: "warn", not_evaluable: "warn", requires_founder_approval: "gold", test_pending: "warn", not_started: "",
  paused: "warn", cancelled: "", requested: "warn", under_review: "warn", recommended: "gold", denied: "", queued: "warn",
  not_configured: "warn", configured_unverified: "warn", dead_letter: "bad", urgent: "bad", high: "warn", normal: "", low: "",
};

export function badge(status: string | null | undefined, text?: string): SafeHtml {
  const s = status ?? "unknown";
  const tone = STATUS_TONE[s] ?? "";
  return html`<span class="badge${tone ? ` badge--${tone}` : ""}">${text ?? labelize(s)}</span>`;
}

export interface Column<T> { header: string; cell: (row: T) => SafeHtml | string | number | null; numeric?: boolean }

export function table<T>(rows: T[], cols: Column<T>[], opts: { empty?: SafeHtml; caption?: string } = {}): SafeHtml {
  if (!rows.length) return opts.empty ?? emptyState("Nothing here yet", "Records will appear here as they are created.");
  return html`<div class="table-wrap"><table class="table">${opts.caption ? html`<caption class="visually-hidden">${opts.caption}</caption>` : ""}
<thead><tr>${cols.map((c) => html`<th scope="col"${c.numeric ? html` class="num"` : ""}>${c.header}</th>`)}</tr></thead>
<tbody>${rows.map((r) => html`<tr>${cols.map((c) => html`<td${c.numeric ? html` class="num"` : ""}>${c.cell(r) as SafeHtml}</td>`)}</tr>`)}</tbody></table></div>`;
}

export function emptyState(title: string, body: string, action?: SafeHtml): SafeHtml {
  return html`<div class="empty"><h3>${title}</h3><p>${body}</p>${action ?? ""}</div>`;
}

export function kpi(labelText: string, value: string | number, sub?: string, meterPercent?: number): SafeHtml {
  return html`<div class="kpi"><div class="kpi__label">${labelText}</div><div class="kpi__value">${value}</div>${sub ? html`<div class="kpi__sub">${sub}</div>` : ""}${meterPercent !== undefined ? html`<div class="meter" role="img" aria-label="${Math.round(meterPercent)} percent"><span style="width:${Math.max(0, Math.min(100, meterPercent))}%"></span></div>` : ""}</div>`;
}

export function pagination(ctx: AppContext, page: number, hasNext: boolean): SafeHtml {
  const link = (p: number) => { const u = new URL(ctx.url); u.searchParams.set("page", String(p)); return u.pathname + u.search; };
  return html`<nav class="pagination" aria-label="Pagination">${page > 1 ? html`<a class="btn btn--ghost btn--sm" href="${link(page - 1)}">Previous</a>` : ""}<span class="faint">Page ${page}</span>${hasNext ? html`<a class="btn btn--ghost btn--sm" href="${link(page + 1)}">Next</a>` : ""}</nav>`;
}

export function pageParam(ctx: AppContext): { page: number; limit: number; offset: number } {
  const page = Math.max(1, Math.min(10_000, parseInt(ctx.url.searchParams.get("page") ?? "1", 10) || 1));
  const limit = 25;
  return { page, limit, offset: (page - 1) * limit };
}

export function dl(items: [string, SafeHtml | string | number | null | undefined][]): SafeHtml {
  return html`<dl class="dl">${items.map(([k, v]) => html`<dt>${k}</dt><dd>${(v ?? "—") as SafeHtml}</dd>`)}</dl>`;
}

export function tabs(items: { href: string; label: string; current: boolean }[]): SafeHtml {
  return html`<nav class="tabs">${items.map((t) => html`<a href="${safeUrl(t.href)}"${t.current ? html` aria-current="page"` : ""}>${t.label}</a>`)}</nav>`;
}

export function pageHead(title: string, actions?: SafeHtml, sub?: string): SafeHtml {
  return html`<div class="page-head"><div>${sub ? html`<div class="eyebrow">${sub}</div>` : ""}<h1>${title}</h1></div>${actions ? html`<div class="actions">${actions}</div>` : ""}</div>`;
}

export function barChart(rows: { label: string; value: number; display: string }[]): SafeHtml {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<div class="bar-chart" role="list">${rows.map((r) => html`<div class="bar-chart__row" role="listitem"><span>${r.label}</span><span class="bar-chart__bar"><span style="width:${(r.value / max) * 100}%"></span></span><span class="num">${r.display}</span></div>`)}</div>`;
}

export const nl2br = (s: string | null | undefined): SafeHtml => join((s ?? "").split("\n").map((line) => html`${line}`), "<br>");
