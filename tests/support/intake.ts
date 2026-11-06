// The pre-purchase website intake (Founder requirement, 2026-11; migration 0089): customers complete it before they
// pay. Tests that purchase a package or pay a quote's first invoice complete it first through the real routes, with
// answers that satisfy every required question of ONBOARDING_SECTIONS (src/services/onboarding.ts).
import type { TestClient } from "./app.ts";

/** A complete, valid set of intake answers (TEST DATA; fictional business). */
export const INTAKE_ANSWERS = {
  business_name: "Fixture Bakery (test data)",
  contact_name: "Fixture Contact",
  contact_email: "contact@fixture-bakery.example",
  industry: "Bakery",
  goals: "More catering enquiries and online pre-orders.",
  target_audience: "Local families and offices ordering catering.",
  has_branding: "no",
  brand_style: "Warm, classic and friendly.",
  pages: "Home\nMenu\nCatering\nAbout\nContact",
  content_source: "crestmont_draft",
  images_source: "licensed",
  domain_status: "need",
  domain_wishes: "fixture-bakery.example",
  hosting: "crestmont",
} as const;

async function submit(c: TestClient, path: string, extra: Record<string, string | string[]>) {
  const res = await c.post(path, { ...INTAKE_ANSWERS, ...extra, intent: "submit" });
  if (res.status !== 303) throw new Error(`intake at ${path} was not accepted: ${res.status} ${(await res.text()).slice(0, 400)}`);
  return res;
}

/** Completes the package intake (/checkout/:pkg/intake); the customer lands on the review page. */
export async function completeIntake(c: TestClient, packageId: string, extra: Record<string, string | string[]> = {}) {
  const res = await submit(c, `/checkout/${packageId}/intake`, extra);
  if (res.headers.get("location") !== `/checkout/${packageId}/review`) throw new Error(`intake for ${packageId} did not complete: ${res.headers.get("location")}`);
  return res;
}

/** Completes the intake for an accepted quote's first invoice (/portal/billing/invoices/:id/intake). */
export async function completeQuoteIntake(c: TestClient, invoiceId: string, extra: Record<string, string | string[]> = {}) {
  const res = await submit(c, `/portal/billing/invoices/${invoiceId}/intake`, extra);
  if (res.headers.get("location") !== `/portal/billing/invoices/${invoiceId}`) throw new Error(`quote intake for ${invoiceId} did not complete: ${res.headers.get("location")}`);
  return res;
}
