// Sales tax arithmetic (LEGAL-005). Pure functions, integer cents only.
//
// This module takes no tax position. Whether Crestmont is registered, in which jurisdictions, at which rates and
// which products are taxable are Founder decisions recorded in Business settings → Tax (src/routes/tax.ts).
// With nothing recorded, computeTax() returns configured=false and adds no tax.
//
// Calculation (documented rounding):
//   - Tax is calculated per line and per applied jurisdiction: line amount (integer cents) × rate.
//   - Rates are integers in parts per million (ppm) of the amount: 7.25% = 72,500 ppm, so a rate typed with up
//     to four decimals is exact and no floating point is used.
//   - Each (line, jurisdiction) product is rounded to whole cents, half away from zero
//     (e.g. 0.5¢ → 1¢, 1.49¢ → 1¢, -0.5¢ → -1¢). Line tax = sum of its jurisdiction taxes; document tax = sum of
//     line taxes. Totals are therefore always the sum of what is printed, with no further rounding.
//   - Lines whose product is not marked taxable get 0 tax and are listed as not taxable.

export interface TaxRate { jurisdictionId: string; name: string; registrationId: string; ratePpm: number }
export interface TaxConfig { registered: boolean; stripeTaxPlanned: boolean; rates: TaxRate[]; taxable: ReadonlySet<string> }
export interface TaxLineInput { description: string; amountCents: number; productKey: string }
export interface JurisdictionTax { jurisdictionId: string; name: string; registrationId: string; ratePpm: number; taxCents: number }
export interface TaxLineResult extends TaxLineInput { taxable: boolean; taxes: JurisdictionTax[]; taxCents: number }
export interface TaxResult {
  configured: boolean;
  lines: TaxLineResult[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Tax per jurisdiction across all lines (each the sum of its per-line rounded amounts). */
  byJurisdiction: JurisdictionTax[];
}

export const PPM = 1_000_000;
export const NOT_CONFIGURED_TAX: TaxConfig = Object.freeze({ registered: false, stripeTaxPlanned: false, rates: [], taxable: new Set<string>() });

export function taxConfigured(c: TaxConfig): boolean {
  return c.registered && c.rates.length > 0;
}

/** amountCents × ratePpm / 1e6, rounded to whole cents half away from zero (BigInt: exact for any amount). */
export function lineTaxCents(amountCents: number, ratePpm: number): number {
  if (!Number.isInteger(amountCents) || !Number.isInteger(ratePpm) || ratePpm < 0 || ratePpm > PPM) throw new RangeError("Tax inputs must be integer cents and a rate between 0 and 1,000,000 ppm");
  const q = BigInt(Math.abs(amountCents)) * BigInt(ratePpm);
  const r = Number((q + BigInt(PPM / 2)) / BigInt(PPM));
  return amountCents < 0 ? -r : r;
}

export function computeTax(lines: TaxLineInput[], cfg: TaxConfig): TaxResult {
  const configured = taxConfigured(cfg);
  const out: TaxLineResult[] = lines.map((l) => {
    const taxable = configured && cfg.taxable.has(l.productKey);
    const taxes = taxable ? cfg.rates.map((r) => ({ jurisdictionId: r.jurisdictionId, name: r.name, registrationId: r.registrationId, ratePpm: r.ratePpm, taxCents: lineTaxCents(l.amountCents, r.ratePpm) })) : [];
    return { ...l, taxable, taxes, taxCents: taxes.reduce((s, t) => s + t.taxCents, 0) };
  });
  const byJurisdiction = configured ? cfg.rates.map((r) => ({ jurisdictionId: r.jurisdictionId, name: r.name, registrationId: r.registrationId, ratePpm: r.ratePpm,
    taxCents: out.reduce((s, l) => s + (l.taxes.find((t) => t.jurisdictionId === r.jurisdictionId)?.taxCents ?? 0), 0) })) : [];
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = out.reduce((s, l) => s + l.taxCents, 0);
  return { configured, lines: out, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, byJurisdiction };
}

/** "7.25%" from 72500 ppm (trailing zeros trimmed, up to four decimals). */
export function formatRate(ppm: number): string {
  const whole = Math.floor(ppm / 10_000), frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** Percent text typed by the Founder ("7.25", "8.875%") → ppm; null when not a valid rate (0–100, ≤ 4 decimals). */
export function parseRatePercent(input: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,4}))?\s*%?\s*$/.exec(input);
  if (!m) return null;
  const ppm = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0") || 0);
  return ppm <= PPM ? ppm : null;
}
