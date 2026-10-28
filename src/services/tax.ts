// Tax configuration persistence and invoice tax snapshots (LEGAL-005). See src/domain/tax.ts for the arithmetic
// and rounding rule. Nothing here chooses a jurisdiction, rate or taxability: the Owner records them.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { PACKAGES, MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { computeTax, formatRate, taxConfigured, NOT_CONFIGURED_TAX, type TaxConfig, type TaxResult, type TaxRate } from "../domain/tax.ts";
import type { CheckoutLine } from "../adapters/payments.ts";

/** Every product key an invoice line can carry, with the label the Owner sees. */
export const TAX_PRODUCTS: { key: string; label: string }[] = [
  ...Object.values(PACKAGES).map((p) => ({ key: p.id, label: `${p.name} website package` })),
  { key: "custom", label: "Custom quoted projects (all milestone invoices)" },
  { key: "change_order", label: "Change orders" },
  ...Object.values(MAINTENANCE_PLANS).map((m) => ({ key: m.id, label: `${m.name} maintenance plan` })),
];
export const TAX_PRODUCT_KEYS = new Set(TAX_PRODUCTS.map((p) => p.key));

export interface TaxSettingsRow { registered: number; stripe_tax_planned: number; notes: string | null; updated_at: string; updated_by_name: string | null }
export interface JurisdictionRow { id: string; name: string; registration_id: string; rate_ppm: number; applied: number; updated_at: string }

export async function taxAdminState(db: Db): Promise<{ settings: TaxSettingsRow | null; jurisdictions: JurisdictionRow[]; taxable: string[] }> {
  const settings = await db.prepare(`SELECT t.registered, t.stripe_tax_planned, t.notes, t.updated_at, u.display_name AS updated_by_name FROM tax_settings t LEFT JOIN users u ON u.id = t.updated_by WHERE t.id = 1`).first<TaxSettingsRow>();
  const jurisdictions = (await db.prepare(`SELECT id, name, registration_id, rate_ppm, applied, updated_at FROM tax_jurisdictions ORDER BY name, created_at`).all<JurisdictionRow>()).results;
  const taxable = (await db.prepare(`SELECT product_key FROM tax_taxable_products ORDER BY product_key`).all<{ product_key: string }>()).results.map((r) => r.product_key);
  return { settings, jurisdictions, taxable };
}

/** Current configuration. Missing tables or rows mean "not configured" (no tax). */
export async function loadTaxConfig(db: Db): Promise<TaxConfig> {
  try {
    const s = await taxAdminState(db);
    const rates: TaxRate[] = s.jurisdictions.filter((j) => j.applied).map((j) => ({ jurisdictionId: j.id, name: j.name, registrationId: j.registration_id, ratePpm: j.rate_ppm }));
    return { registered: s.settings?.registered === 1, stripeTaxPlanned: s.settings?.stripe_tax_planned === 1, rates, taxable: new Set(s.taxable) };
  } catch { return NOT_CONFIGURED_TAX; }
}

export interface InvoiceTax { amountCents: number; subtotalCents: number | null; taxCents: number; detailJson: string | null }

/**
 * Tax snapshot for a new invoice line. Not configured → the subtotal is the whole amount and nothing is stored
 * (documents keep saying they are not tax invoices). Configured → detail is stored even when the product is not
 * taxable, so the document can state that no tax applied under the recorded configuration.
 */
export async function taxForNewInvoice(db: Db, line: { description: string; amountCents: number; productKey: string }): Promise<InvoiceTax> {
  const cfg = await loadTaxConfig(db);
  if (!taxConfigured(cfg)) return { amountCents: line.amountCents, subtotalCents: null, taxCents: 0, detailJson: null };
  const r = computeTax([line], cfg);
  return { amountCents: r.totalCents, subtotalCents: r.subtotalCents, taxCents: r.taxCents, detailJson: JSON.stringify(r) };
}

export function parseTaxDetail(json: string | null | undefined): TaxResult | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as TaxResult;
    return r && r.configured && Array.isArray(r.lines) && Number.isInteger(r.taxCents) ? r : null;
  } catch { return null; }
}

/** Product key of a quote-based order: the quoted package id, else "custom". */
export async function quoteProductKey(db: Db, quoteVersionId: string | null): Promise<string> {
  if (!quoteVersionId) return "custom";
  const qv = await db.prepare(`SELECT package_id FROM quote_versions WHERE id = ?`).bind(quoteVersionId).first<{ package_id: string | null }>();
  return qv?.package_id && qv.package_id in PACKAGES ? qv.package_id : "custom";
}

/**
 * Stripe Checkout lines for an invoice: the taxable amount, then one separate line per jurisdiction with tax, so
 * the session total equals invoices.amount_cents (which the webhook matches). Untaxed invoices are one line.
 */
export function checkoutLinesFor(inv: { description: string | null; amount_cents: number; subtotal_cents?: number | null; tax_detail_json?: string | null }, fallbackName: string): CheckoutLine[] {
  const name = inv.description ?? fallbackName;
  const detail = parseTaxDetail(inv.tax_detail_json);
  if (!detail || inv.subtotal_cents === null || inv.subtotal_cents === undefined) return [{ name, amountCents: inv.amount_cents }];
  const lines: CheckoutLine[] = [{ name, amountCents: inv.subtotal_cents }, ...taxLines(detail)];
  return lines;
}

export function taxLines(detail: TaxResult): CheckoutLine[] {
  return detail.byJurisdiction.filter((j) => j.taxCents > 0).map((j) => ({ name: `Sales tax — ${j.name} (${formatRate(j.ratePpm)}, registration ${j.registrationId})`, amountCents: j.taxCents, taxJurisdictionId: j.jurisdictionId }));
}

export const NOT_TAX_INVOICE = "It is not a tax invoice; tax configuration is not yet finalized.";

/** The tax statement printed on invoices and receipts. No snapshot → the existing "not a tax invoice" wording. */
export function taxStatement(detail: TaxResult | null): string {
  if (!detail) return NOT_TAX_INVOICE;
  const regs = detail.byJurisdiction.map((j) => `${j.name} ${j.registrationId}`).join("; ");
  return `Sales tax is calculated per line from the tax registrations and rates recorded in Crestmont's tax settings when this invoice was issued, rounded to the cent (half away from zero) per line and jurisdiction.${regs ? ` Registrations: ${regs}.` : ""}`;
}

/** Label for one jurisdiction's tax line ("Sales tax — State (7.25%)"). */
export function taxLabel(j: { name: string; ratePpm: number }): string {
  return `Sales tax — ${j.name} (${formatRate(j.ratePpm)})`;
}

export async function saveTaxSettings(db: Db, userId: string, v: { registered: boolean; stripeTaxPlanned: boolean; notes: string | null }) {
  await db.prepare(`INSERT INTO tax_settings (id, registered, stripe_tax_planned, notes, updated_by, updated_at) VALUES (1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET registered = excluded.registered, stripe_tax_planned = excluded.stripe_tax_planned, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(v.registered ? 1 : 0, v.stripeTaxPlanned ? 1 : 0, v.notes, userId, nowIso()).run();
}

export async function addJurisdiction(db: Db, userId: string, v: { name: string; registrationId: string; ratePpm: number; applied: boolean }): Promise<string> {
  const id = newId("txj"), at = nowIso();
  await db.prepare(`INSERT INTO tax_jurisdictions (id, name, registration_id, rate_ppm, applied, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, v.name, v.registrationId, v.ratePpm, v.applied ? 1 : 0, userId, at, userId, at).run();
  return id;
}

export async function updateJurisdiction(db: Db, userId: string, id: string, v: { name: string; registrationId: string; ratePpm: number; applied: boolean }): Promise<JurisdictionRow | null> {
  const before = await db.prepare(`SELECT id, name, registration_id, rate_ppm, applied, updated_at FROM tax_jurisdictions WHERE id = ?`).bind(id).first<JurisdictionRow>();
  if (!before) return null;
  await db.prepare(`UPDATE tax_jurisdictions SET name = ?, registration_id = ?, rate_ppm = ?, applied = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(v.name, v.registrationId, v.ratePpm, v.applied ? 1 : 0, userId, nowIso(), id).run();
  return before;
}

export async function setTaxableProducts(db: Db, userId: string, keys: string[]): Promise<void> {
  const at = nowIso();
  await db.batch([
    db.prepare(`DELETE FROM tax_taxable_products`),
    ...keys.map((k) => db.prepare(`INSERT INTO tax_taxable_products (product_key, updated_by, updated_at) VALUES (?,?,?)`).bind(k, userId, at)),
  ]);
}
