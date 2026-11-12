// The website intake form (PORTAL-002): one renderer for project onboarding (/portal/projects/:id/onboarding) and the
// pre-purchase intake (/checkout/:packageId/intake, /portal/billing/invoices/:id/intake). Fields are data
// (ONBOARDING_SECTIONS); conditional questions carry data-show-when and are validated server-side either way.
import type { AppContext } from "../app/context.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { input, textarea, checkbox, dl } from "./components.ts";
import * as O from "../services/onboarding.ts";

const val = (a: O.Answers, n: string) => { const v = a[n]; return Array.isArray(v) ? v.join(", ") : v ?? ""; };

/** One fieldset per section, filtered to the product's questions, pre-filled with the saved answers. */
export async function intakeSections(ctx: AppContext, organizationId: string, productId: string | null, a: O.Answers): Promise<SafeHtml[]> {
  const uploaded = async (n: string) => {
    const ids = Array.isArray(a[n]) ? (a[n] as string[]) : [];
    if (!ids.length) return html``;
    // One JSON parameter, not one per id: uploads accumulate across draft saves and D1 rejects more than 100 bound parameters.
    const rows = (await ctx.db.prepare(`SELECT id, filename FROM files WHERE organization_id = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`).bind(organizationId, JSON.stringify(ids)).all<{ id: string; filename: string }>()).results;
    return html`<p class="hint">Uploaded: ${rows.map((f) => html`<a href="/files/${f.id}">${f.filename}</a> `)}</p>`;
  };
  const field = async (f: O.OnboardingField): Promise<SafeHtml> => {
    const req = !!f.required;
    let inner: SafeHtml;
    if (f.type === "textarea") inner = textarea({ name: f.name, label: f.label, value: val(a, f.name), hint: f.hint, required: false, maxlength: f.max, rows: 4 });
    else if (f.type === "radio") inner = html`<fieldset class="field"><legend>${f.label}</legend>${f.options!.map((o) => html`<label class="checkbox"><input type="radio" name="${f.name}" value="${o.value}"${a[f.name] === o.value ? html` checked` : ""}> <span>${o.label}</span></label>`)}${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</fieldset>`;
    else if (f.type === "checkboxes") { const cur = Array.isArray(a[f.name]) ? (a[f.name] as string[]) : []; inner = html`<fieldset class="field"><legend>${f.label}</legend>${f.options!.map((o) => checkbox(f.name, o.label, { value: o.value, checked: cur.includes(o.value) }))}</fieldset>`; }
    else if (f.type === "file") inner = html`<div class="field dropzone"><label for="f-${f.name}">${f.label}</label><input class="input" id="f-${f.name}" type="file" name="${f.name}"${f.name === "images" ? html` multiple` : ""} accept=".png,.jpg,.jpeg,.webp,.gif,.pdf"><span class="hint">${f.hint ?? ""} Up to 25 MB each.</span>${await uploaded(f.name)}</div>`;
    else inner = input({ name: f.name, label: f.label, type: f.type === "tel" ? "tel" : f.type === "email" ? "email" : "text", value: val(a, f.name), hint: f.hint, maxlength: f.max });
    // Required questions carry a gold asterisk after their label (CSS: .ob-field--req), not a separate line under the
    // control that read as part of the next question. No HTML `required`: a draft can be saved half-finished.
    const cls = `ob-field${req ? " ob-field--req" : ""}`;
    return f.showWhen ? html`<div class="${cls}" data-show-when="${f.showWhen.field}=${f.showWhen.values.join(",")}">${inner}</div>` : html`<div class="${cls}">${inner}</div>`;
  };
  const sections: SafeHtml[] = [];
  for (const s of O.ONBOARDING_SECTIONS) {
    const fields = s.fields.filter((f) => !f.packages || f.packages.includes(productId ?? "custom"));
    const rendered: SafeHtml[] = [];
    for (const f of fields) rendered.push(await field(f));
    const n = sections.length + 1;
    sections.push(html`<fieldset class="card ob-section"><legend class="ob-section__title"><span class="ob-section__num" aria-hidden="true">${String(n).padStart(2, "0")}</span>${s.title}</legend>${s.intro ? html`<p class="ob-section__intro">${s.intro}</p>` : ""}<div class="ob-section__body">${rendered}</div></fieldset>`);
  }
  return sections;
}

/** The submitted answers as a definition list (file uploads are listed with the files, not here). */
export function intakeSummary(productId: string | null, a: O.Answers): SafeHtml {
  return dl(O.allFields(productId).filter((f) => f.type !== "file" && a[f.name] !== undefined && val(a, f.name) !== "")
    .map((f) => [f.label, (f.options ? (Array.isArray(a[f.name]) ? (a[f.name] as string[]) : [a[f.name] as string]).map((v) => f.options!.find((o) => o.value === v)?.label ?? v).join(", ") : val(a, f.name))] as [string, string]));
}
