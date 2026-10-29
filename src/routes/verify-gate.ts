// CREST-GAP-031: verified email ownership is required before any purchase or payment (Founder default). An unverified
// customer can still browse the portal; posting a checkout or pay action answers 403 with a way to resend the
// confirmation email (POST /verify-email/resend, src/routes/auth.ts). Nothing is created for an unverified buyer.
import type { AppContext } from "../app/context.ts";
import { html } from "../lib/html.ts";
import { htmlResponse } from "../app/http.ts";
import { publicLayout } from "../ui/layout.ts";
import { alert, actionForm } from "../ui/components.ts";

export const VERIFY_BEFORE_PAYING = "Confirm your email address before buying or paying. We sent a confirmation link when you registered; you can send a new one below.";

/** null when the signed-in user may pay; otherwise the 403 page to return. */
export function requireVerifiedForPayment(ctx: AppContext): Response | null {
  if (!ctx.user || ctx.user.emailVerified) return null;
  return htmlResponse(ctx, publicLayout(ctx, { title: "Confirm your email", noindex: true }, html`<section class="section"><div class="container stack" style="max-width:720px">
<h1>Confirm your email first</h1>${alert("warn", VERIFY_BEFORE_PAYING)}
<p>Signed in as <strong>${ctx.user.email}</strong>. Nothing was ordered or charged.</p>
<div class="row">${actionForm(ctx, "/verify-email/resend", "Resend confirmation email", { variant: "primary" })}</div></div></section>`), 403);
}
