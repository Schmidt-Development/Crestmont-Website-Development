/**
 * BLK-006 / IDENT-001 — the operating legal entity.
 *
 * Crestmont Website Development is the customer-facing BRAND. The legal entity that operates it is
 * Talent Revenue Systems LLC, confirmed by the Founder on 2026-11-04. Documents and disclosures that
 * legitimately need a legal operating name (agreements, invoices, receipts, the disclosures page) use the
 * legal name; everything a customer reads as a product name keeps the brand.
 *
 * The Business settings value still wins where it is set, so the Owner can correct or refine the recorded
 * name without a deploy. This constant only stops the platform printing "pending" for a company that exists.
 *
 * Deliberately NOT changed here: `commerceBlock` in src/domain/payments-mode.ts still requires the Owner to
 * record the entity in Business settings before production checkout opens. That gate is about the Owner
 * confirming their own business record on the live system, and a code default must not satisfy it.
 */
export const OPERATING_LEGAL_NAME = "Talent Revenue Systems LLC";

/** The customer-facing brand. Never replaced by the legal name in product copy. */
export const TRADING_NAME = "Crestmont Website Development";

/**
 * No registered mailing address is published. Crestmont trades online and the Founder has not authorised a
 * residential address as a public business address; where a provider or a law genuinely requires one, that is
 * recorded as an open external dependency rather than invented here (IDENT-002).
 */
export const REGISTERED_ADDRESS: string | null = null;

/** The legal operating name to print: the Owner's recorded setting, else the confirmed entity. */
export function legalNameFrom(settings: Record<string, string | undefined>): string {
  return settings["business.legal_name"]?.trim() || OPERATING_LEGAL_NAME;
}
