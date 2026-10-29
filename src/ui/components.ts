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

/** Arrow glyph used in CTA squares and card links (decorative). */
export const ARROW_SVG = html`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 11.5l7-7M6 4.5h5.5V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Call-to-action link (M03): label layer plus an arrow square. The square is aria-hidden, so the accessible name is
 * exactly the label. app.js adds the tile-fill hover layer on first hover/focus.
 */
export function ctaLink(text: string, href: string, variant: "primary" | "secondary" = "primary", size?: "sm", extraClass = ""): SafeHtml {
  return html`<a class="btn btn--${variant} btn--cta${size ? " btn--sm" : ""}${extraClass ? ` ${extraClass}` : ""}" href="${safeUrl(href)}"><span class="btn__label">${text}</span><span class="btn__arrow" aria-hidden="true">${ARROW_SVG}</span></a>`;
}

/** Inline POST form with a single button (for actions like "Approve"). */
export function actionForm(ctx: AppContext, action: string, text: string, opts: { variant?: "primary" | "secondary" | "ghost" | "danger"; hidden?: Record<string, string>; confirm?: string; size?: "sm" } = {}): SafeHtml {
  const hidden = Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  return html`<form method="post" action="${safeUrl(action)}" style="display:inline"${opts.confirm ? html` data-confirm="${opts.confirm}"` : ""}>${csrf(ctx)}${hidden}${button(text, { variant: opts.variant ?? "secondary", size: opts.size ?? "sm" })}</form>`;
}

interface FieldBase { name: string; label: string; hint?: string; error?: string; required?: boolean; id?: string }

/** aria-invalid + aria-describedby linking a control to its error message and hint (BRAND-005, TEST-003). */
function describedBy(id: string, f: { hint?: string; error?: string }): SafeHtml {
  const ids = [f.error ? `${id}-err` : "", f.hint ? `${id}-hint` : ""].filter(Boolean).join(" ");
  return html`${f.error ? html` aria-invalid="true"` : ""}${ids ? html` aria-describedby="${ids}"` : ""}`;
}

export function input(f: FieldBase & { type?: string; value?: string | number | null; autocomplete?: string; placeholder?: string; min?: number; max?: number; step?: string; pattern?: string; maxlength?: number; inputmode?: string }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  return html`<div class="field"><label for="${id}">${f.label}${f.required ? html` <span aria-hidden="true" class="faint">*</span>` : ""}</label>
<input class="input" id="${id}" name="${f.name}" type="${f.type ?? "text"}" value="${f.value ?? ""}"${f.required ? html` required` : ""}${f.autocomplete ? html` autocomplete="${f.autocomplete}"` : ""}${f.placeholder ? html` placeholder="${f.placeholder}"` : ""}${f.min !== undefined ? html` min="${f.min}"` : ""}${f.max !== undefined ? html` max="${f.max}"` : ""}${f.step ? html` step="${f.step}"` : ""}${f.maxlength ? html` maxlength="${f.maxlength}"` : ""}${f.inputmode ? html` inputmode="${f.inputmode}"` : ""}${describedBy(id, f)}>
${f.hint ? html`<span class="hint" id="${id}-hint">${f.hint}</span>` : ""}${f.error ? html`<span class="error-text" id="${id}-err" role="alert">${f.error}</span>` : ""}</div>`;
}

export function textarea(f: FieldBase & { value?: string | null; rows?: number; maxlength?: number }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  return html`<div class="field"><label for="${id}">${f.label}${f.required ? html` <span aria-hidden="true" class="faint">*</span>` : ""}</label>
<textarea class="textarea" id="${id}" name="${f.name}" rows="${f.rows ?? 5}"${f.required ? html` required` : ""}${f.maxlength ? html` maxlength="${f.maxlength}"` : ""}${describedBy(id, f)}>${f.value ?? ""}</textarea>
${f.hint ? html`<span class="hint" id="${id}-hint">${f.hint}</span>` : ""}${f.error ? html`<span class="error-text" id="${id}-err" role="alert">${f.error}</span>` : ""}</div>`;
}

export function select(f: FieldBase & { options: { value: string; label: string }[] | string[]; value?: string | null; includeBlank?: string }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  const opts = f.options.map((o) => (typeof o === "string" ? { value: o, label: labelize(o) } : o));
  return html`<div class="field"><label for="${id}">${f.label}</label>
<select class="select" id="${id}" name="${f.name}"${f.required ? html` required` : ""}${describedBy(id, f)}>
${f.includeBlank !== undefined ? html`<option value="">${f.includeBlank}</option>` : ""}
${opts.map((o) => html`<option value="${o.value}"${o.value === (f.value ?? "") ? html` selected` : ""}>${o.label}</option>`)}
</select>${f.hint ? html`<span class="hint" id="${id}-hint">${f.hint}</span>` : ""}${f.error ? html`<span class="error-text" id="${id}-err" role="alert">${f.error}</span>` : ""}</div>`;
}

export function checkbox(name: string, text: string, opts: { checked?: boolean; value?: string; required?: boolean } = {}): SafeHtml {
  return html`<label class="checkbox"><input type="checkbox" name="${name}" value="${opts.value ?? "1"}"${opts.checked ? html` checked` : ""}${opts.required ? html` required` : ""}> <span>${text}</span></label>`;
}

export function fileInput(name: string, labelText: string, opts: { multiple?: boolean; hint?: string; accept?: string } = {}): SafeHtml {
  return html`<div class="field dropzone"><label for="f-${name}">${labelText}</label>
<input id="f-${name}" class="input" type="file" name="${name}"${opts.multiple ? html` multiple` : ""} accept="${opts.accept ?? ".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.zip,.txt,.csv"}" aria-describedby="f-${name}-hint">
<span class="hint" id="f-${name}-hint">${opts.hint ?? "PDF, images, Word, Excel, ZIP, text or CSV · up to 25 MB each"}</span></div>`;
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

export function tabs(items: { href: string; label: string; current: boolean }[], ariaLabel = "Section"): SafeHtml {
  return html`<nav class="tabs" aria-label="${ariaLabel}">${items.map((t) => html`<a href="${safeUrl(t.href)}"${t.current ? html` aria-current="page"` : ""}>${t.label}</a>`)}</nav>`;
}

export function pageHead(title: string, actions?: SafeHtml, sub?: string): SafeHtml {
  return html`<div class="page-head"><div>${sub ? html`<div class="eyebrow">${sub}</div>` : ""}<h1>${title}</h1></div>${actions ? html`<div class="actions">${actions}</div>` : ""}</div>`;
}

export function barChart(rows: { label: string; value: number; display: string }[]): SafeHtml {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<div class="bar-chart" role="list">${rows.map((r) => html`<div class="bar-chart__row" role="listitem"><span>${r.label}</span><span class="bar-chart__bar"><span style="width:${(r.value / max) * 100}%"></span></span><span class="num">${r.display}</span></div>`)}</div>`;
}

export const nl2br = (s: string | null | undefined): SafeHtml => join((s ?? "").split("\n").map((line) => html`${line}`), "<br>");

// ───────────── UX workstream components (BRAND-003..005) ─────────────

/**
 * Drawer (BRAND-003). `drawerLink` is an ordinary link to a full server-rendered page; with JavaScript,
 * app.js opens the page's `[data-drawer-body]` region in the shared `<dialog class="drawer">` instead.
 * Without JavaScript (or if the fetch fails) the link simply navigates.
 */
export function drawerAttrs(quickUrl: string): SafeHtml {
  return html` data-drawer="${safeUrl(quickUrl)}"`;
}

/** The one drawer dialog per page. Rendered by appLayout; content is filled by app.js. */
export function drawerShell(): SafeHtml {
  return html`<dialog class="drawer" id="drawer" aria-labelledby="drawer-title">
<div class="drawer__head"><h2 class="drawer__title" id="drawer-title">Details</h2><form method="dialog"><button class="btn btn--ghost btn--sm" type="submit" data-close>Close</button></form></div>
<div class="drawer__body" aria-live="polite"></div>
<div class="drawer__foot"><a class="btn btn--secondary btn--sm" href="#" data-drawer-full>Open full record</a></div></dialog>`;
}

/** Wraps the part of a full page that the drawer shows. */
export function drawerBody(title: string, body: SafeHtml): SafeHtml {
  return html`<div data-drawer-body data-drawer-title="${title}">${body}</div>`;
}

/** Skeleton loader (BRAND-005): placeholder blocks while a slow section loads. Purely decorative for AT. */
export function skeleton(opts: { lines?: number; kpis?: number } = {}): SafeHtml {
  const kpis = opts.kpis ?? 0, lines = opts.lines ?? 4;
  return html`<div class="skeleton-wrap" aria-hidden="true">${kpis ? html`<div class="kpis">${Array.from({ length: kpis }, () => html`<div class="kpi"><div class="skeleton skeleton--label"></div><div class="skeleton skeleton--value"></div></div>`)}</div>` : ""}
<div class="card">${Array.from({ length: lines }, (_, i) => html`<div class="skeleton skeleton--line" style="width:${[92, 78, 85, 64, 88, 70][i % 6]}%"></div>`)}</div></div>`;
}

export interface DateRangeValue { from: string; to: string }

/** Server-computed presets so they work as plain links without JavaScript. Dates are UTC calendar days. */
export function dateRangePresets(now: Date): { key: string; label: string; from: string; to: string }[] {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const today = d(now);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return [
    { key: "month", label: "This month", from: d(new Date(Date.UTC(y, m, 1))), to: today },
    { key: "30d", label: "Last 30 days", from: d(new Date(now.getTime() - 29 * 86400e3)), to: today },
    { key: "quarter", label: "This quarter", from: d(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))), to: today },
    { key: "year", label: "This year", from: d(new Date(Date.UTC(y, 0, 1))), to: today },
  ];
}

/**
 * Date-range control (BRAND-004): from/to date inputs plus preset links (this month, last 30 days, this
 * quarter, this year). Keeps the existing query parameter names `from` and `to` and preserves other params.
 */
export function dateRange(ctx: AppContext, value: DateRangeValue, opts: { extra?: SafeHtml; legend?: string; applyLabel?: string } = {}): SafeHtml {
  const presets = dateRangePresets(ctx.now());
  const keep = [...ctx.url.searchParams].filter(([k]) => !["from", "to", "page"].includes(k));
  const href = (from: string, to: string) => {
    const u = new URL(ctx.url); u.searchParams.set("from", from); u.searchParams.set("to", to); u.searchParams.delete("page");
    return u.pathname + u.search;
  };
  return html`<form method="get" class="filters date-range" action="${ctx.url.pathname}" data-slow>
${keep.filter(([k]) => !opts.extra || !new RegExp(`name="${k}"`).test(opts.extra.value)).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<fieldset class="date-range__fields"><legend class="label">${opts.legend ?? "Date range"}</legend>
<div class="date-range__inputs">${input({ name: "from", id: "range-from", label: "From", type: "date", value: value.from })}${input({ name: "to", id: "range-to", label: "To", type: "date", value: value.to })}</div>
<nav class="date-range__presets" aria-label="Date range presets">${presets.map((p) => html`<a class="chip" href="${href(p.from, p.to)}"${p.from === value.from && p.to === value.to ? html` aria-current="true"` : ""}>${p.label}</a>`)}</nav></fieldset>
${opts.extra ?? ""}<div class="field date-range__apply">${button(opts.applyLabel ?? "Apply", { variant: "secondary", size: "sm" })}</div></form>`;
}

/**
 * Rich-text field (BRAND-004): a plain textarea that accepts the safe markdown subset rendered by
 * src/ui/markdown.ts, plus a server-rendered preview. app.js adds a formatting toolbar and updates the
 * preview live; without JavaScript the textarea and the saved-value preview still work.
 */
export function richText(f: FieldBase & { value?: string | null; rows?: number; maxlength?: number; preview: SafeHtml }): SafeHtml {
  const id = f.id ?? `f-${f.name}`;
  const hint = `${f.hint ? f.hint + " " : ""}Formatting: ## heading, **bold**, *italic*, [link text](https://…), "- " bullets, "1. " numbered lists, blank line between paragraphs. HTML is not allowed.`;
  return html`<div class="richtext" data-richtext="${id}">${textarea({ ...f, hint })}
<div class="richtext__preview-wrap"><div class="label" id="${id}-preview-label">Formatted preview</div><div class="richtext__preview prose" id="${id}-preview" data-preview-for="${id}" aria-labelledby="${id}-preview-label">${f.preview}</div></div></div>`;
}

/** Hidden attribution fields for public lead forms (CRM-001). Values are computed server-side; no JavaScript. */
export function attributionFields(a: Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_term" | "utm_content" | "referrer" | "landing_page", string>>): SafeHtml {
  return html`${(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "referrer", "landing_page"] as const).filter((k) => a[k]).map((k) => html`<input type="hidden" name="${k}" value="${a[k]}">`)}`;
}
