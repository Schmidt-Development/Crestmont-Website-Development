// Business settings → Tax (LEGAL-005). Owner only: the Founder records whether Crestmont is registered to collect
// sales tax, the jurisdictions (registration id + rate), which products are taxable, and whether Stripe Tax is
// planned (a flag only). The platform never proposes a jurisdiction, rate or taxability, and nothing is
// pre-filled. Every change is audited with before/after values. Changes apply to invoices issued afterwards;
// issued invoices keep the tax snapshot they were issued with.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime } from "../lib/html.ts";
import { HttpError, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { isOwner } from "../domain/authz.ts";
import { csrf, input, textarea, checkbox, button, formErrors, alert, badge, table, emptyState, pageHead, linkButton } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import { audit } from "../services/security.ts";
import * as tax from "../services/tax.ts";
import { formatRate, parseRatePercent, taxConfigured } from "../domain/tax.ts";

function requireOwner(ctx: AppContext): void {
  requireStaff(ctx, "settings.operational");
  if (!isOwner(ctx.actor!)) throw new HttpError(403, "Only the Owner can view or change tax configuration. Tax registration, jurisdictions and rates are Founder decisions.");
}

const plain = (s: string) => !/[<>]/.test(s);

async function taxPage(ctx: AppContext, errors: string[] = [], status = 200) {
  requireOwner(ctx);
  const st = await tax.taxAdminState(ctx.db);
  const cfg = await tax.loadTaxConfig(ctx.db);
  const on = taxConfigured(cfg);
  const taxable = new Set(st.taxable);
  const statusBox = on
    ? alert("info", html`<strong>Tax is configured.</strong> New invoices, checkout and quotes add tax at ${cfg.rates.map((r) => `${r.name} ${formatRate(r.ratePpm)}`).join(" + ")} on ${taxable.size ? html`${st.taxable.length} taxable product type(s)` : html`<strong>no products</strong> (none is marked taxable, so no tax is added)`}. Invoices already issued keep the tax they were issued with.`)
    : alert("warn", html`<strong>Tax is not configured.</strong> No tax is added anywhere, and invoices and receipts state that they are not tax invoices. Tax is applied only when Crestmont is recorded as registered <em>and</em> at least one jurisdiction is applied.`);
  const body = html`${pageHead("Tax configuration", linkButton("Business settings", "/staff/settings", "ghost", "sm"), "Business settings · Owner only")}
${alert("warn", html`Crestmont's tax registrations, jurisdictions, rates and which products are taxable are <strong>Founder decisions</strong> (normally with an accountant). This page only records them; it never suggests a rate or a tax position.`)}
${statusBox}${formErrors(errors)}
<form method="post" action="/staff/settings/tax" class="card stack">${csrf(ctx)}
<h2 class="card__title">Registration</h2>
${checkbox("registered", "Crestmont is registered to collect sales tax in the jurisdictions listed below.", { checked: st.settings?.registered === 1 })}
${checkbox("stripe_tax_planned", "Stripe Tax will be used (recorded only).", { checked: st.settings?.stripe_tax_planned === 1 })}
<p class="hint">The Stripe Tax flag is a record of the decision. This platform does not turn on Stripe Tax. If Stripe Tax is enabled in Stripe later, un-apply the rates below first so tax is not charged twice.</p>
<h2 class="card__title">Taxable products</h2>
<p class="hint">Only products checked here are taxed. Unchecked products are invoiced without tax and documents say so.</p>
<div class="stack">${tax.TAX_PRODUCTS.map((p) => checkbox("taxable", p.label, { value: p.key, checked: taxable.has(p.key) }))}</div>
${textarea({ name: "notes", label: "Notes (for example, the accountant's guidance or registration dates)", value: st.settings?.notes ?? "", rows: 3, maxlength: 1000 })}
<div class="form-actions">${button("Save tax settings")}</div>
${st.settings ? html`<p class="faint">Last changed ${formatDateTime(st.settings.updated_at)}${st.settings.updated_by_name ? ` by ${st.settings.updated_by_name}` : ""}.</p>` : html`<p class="faint">Never saved.</p>`}</form>
<section class="card stack"><h2 class="card__title">Jurisdictions</h2>
${table(st.jurisdictions, [
  { header: "Jurisdiction", cell: (j) => j.name },
  { header: "Registration id", cell: (j) => j.registration_id },
  { header: "Rate", cell: (j) => formatRate(j.rate_ppm), numeric: true },
  { header: "Applied", cell: (j) => (j.applied ? badge("active", "Applied") : badge("draft", "Not applied")) },
  { header: "Updated", cell: (j) => formatDateTime(j.updated_at) },
  { header: "Edit", cell: (j) => html`<details><summary>Edit</summary>${jurisdictionForm(ctx, j)}</details>` },
], { empty: emptyState("No jurisdictions recorded", "Add a jurisdiction only after Crestmont has registered there.") })}
<h3 style="font-size:1rem">Add a jurisdiction</h3>${jurisdictionForm(ctx, null)}
<p class="hint">Rates apply per line and per jurisdiction, rounded to the cent (half away from zero); every applied jurisdiction is charged on every taxable line. Assigning different jurisdictions to different customers (destination-based sourcing) is not supported yet.</p></section>
<p><a href="/staff/audit?action=tax.">Change history in the audit log</a></p>`;
  return staffPage(ctx, "Tax configuration", body, status);
}

function jurisdictionForm(ctx: AppContext, j: tax.JurisdictionRow | null) {
  const pre = j ? `j-${j.id}` : "j-new";
  return html`<form method="post" action="/staff/settings/tax/jurisdictions" class="stack">${csrf(ctx)}${j ? html`<input type="hidden" name="id" value="${j.id}">` : ""}
<div class="grid grid-3">${input({ name: "name", id: `${pre}-name`, label: "Jurisdiction", value: j?.name ?? "", required: true, maxlength: 120 })}
${input({ name: "registration_id", id: `${pre}-reg`, label: "Registration / permit id", value: j?.registration_id ?? "", required: true, maxlength: 80 })}
${input({ name: "rate", id: `${pre}-rate`, label: "Rate (%)", value: j ? formatRate(j.rate_ppm).replace("%", "") : "", required: true, maxlength: 9, inputmode: "decimal" })}</div>
${checkbox("applied", "Apply this rate to taxable sales", { checked: j ? j.applied === 1 : true })}
<div class="form-actions">${button(j ? "Save jurisdiction" : "Add jurisdiction", { variant: j ? "secondary" : "primary", size: "sm" })}</div></form>`;
}

export function register(r: Router): void {
  r.get("/staff/settings/tax", (ctx) => taxPage(ctx));

  r.post("/staff/settings/tax", async (ctx) => {
    requireOwner(ctx);
    const f = await ctx.form();
    const keys = [...new Set(f.getAll("taxable").map(String))];
    const notes = str(f, "notes");
    const e: string[] = [];
    if (keys.some((k) => !tax.TAX_PRODUCT_KEYS.has(k))) e.push("Choose taxable products from the list");
    if (notes.length > 1000) e.push("Notes are too long (1,000 characters maximum)");
    if (e.length) return taxPage(ctx, e, 422);
    const before = await tax.taxAdminState(ctx.db);
    const next = { registered: !!f.get("registered"), stripeTaxPlanned: !!f.get("stripe_tax_planned"), notes: notes || null };
    await tax.saveTaxSettings(ctx.db, ctx.user!.id, next);
    await tax.setTaxableProducts(ctx.db, ctx.user!.id, keys);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "tax.settings_updated", subjectType: "tax_settings", subjectId: "1", details: {
      before: { registered: before.settings?.registered === 1, stripeTaxPlanned: before.settings?.stripe_tax_planned === 1, taxable: before.taxable, notes: before.settings?.notes ?? null },
      after: { ...next, taxable: keys.sort() } } });
    return redirect(ctx, "/staff/settings/tax", { kind: "success", text: "Tax settings saved. They apply to invoices issued from now on." });
  });

  r.post("/staff/settings/tax/jurisdictions", async (ctx) => {
    requireOwner(ctx);
    const f = await ctx.form();
    const id = str(f, "id");
    const v = { name: str(f, "name"), registrationId: str(f, "registration_id"), rate: str(f, "rate"), applied: !!f.get("applied") };
    const ratePpm = parseRatePercent(v.rate);
    const e: string[] = [];
    if (v.name.length < 2 || v.name.length > 120 || !plain(v.name)) e.push("Enter the jurisdiction name (plain text, up to 120 characters)");
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._\/#-]{0,79}$/.test(v.registrationId)) e.push("Enter the registration or permit id exactly as issued (letters, digits, spaces, . _ / # -)");
    if (ratePpm === null) e.push("Enter the rate as a percentage between 0 and 100 with at most four decimals (for example 6.5)");
    if (e.length) return taxPage(ctx, e, 422);
    const values = { name: v.name, registrationId: v.registrationId, ratePpm: ratePpm!, applied: v.applied };
    if (id) {
      const before = await tax.updateJurisdiction(ctx.db, ctx.user!.id, id, values);
      if (!before) throw new HttpError(404, "Jurisdiction not found");
      await audit(ctx.db, { actorUserId: ctx.user!.id, action: "tax.jurisdiction_updated", subjectType: "tax_jurisdiction", subjectId: id, details: {
        before: { name: before.name, registrationId: before.registration_id, ratePpm: before.rate_ppm, applied: before.applied === 1 }, after: values } });
      return redirect(ctx, "/staff/settings/tax", { kind: "success", text: `Saved ${v.name}.` });
    }
    const newId = await tax.addJurisdiction(ctx.db, ctx.user!.id, values);
    await audit(ctx.db, { actorUserId: ctx.user!.id, action: "tax.jurisdiction_added", subjectType: "tax_jurisdiction", subjectId: newId, details: { after: values } });
    return redirect(ctx, "/staff/settings/tax", { kind: "success", text: `Added ${v.name}.` });
  });
}
