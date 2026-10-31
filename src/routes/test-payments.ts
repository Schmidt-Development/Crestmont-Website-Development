// Test-only payment simulation (Owner; refused in production; migration 0054; src/services/payment-simulation.ts).
//  GET  /staff/test-payments                         status, test organizations' open invoices, event log
//  POST /staff/test-payments/organizations/:id/mark  mark / unmark a fictional test organization (step-up)
//  POST /staff/test-payments/simulate                deliver a synthetic SIMULATED_PAID or SIMULATED_FAILED event (step-up)
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDateTime } from "../lib/html.ts";
import { HttpError, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { alert, badge, button, csrf, emptyState, input, pageHead, select, table } from "../ui/components.ts";
import { staffPage } from "./crm.ts";
import * as sim from "../services/payment-simulation.ts";
import { randomToken } from "../lib/auth-crypto.ts";

const PAGE = "/staff/test-payments";

async function page(ctx: AppContext) {
  requireStaff(ctx, "payments.simulate");
  const on = sim.simulationAvailable(ctx.env);
  const candidates = await sim.simulationCandidates(ctx.db);
  const events = await sim.recentSimulationEvents(ctx.db);
  const body = html`${pageHead("Test payments (simulated)", undefined, "Internal end-to-end testing only")}
${alert("warn", html`<strong>No real transaction happens here.</strong> A simulated payment stands in for the payment provider (Stripe is not configured) so an internal test can exercise the real onboarding and AI build workflow. It only pays invoices of organizations you marked as fictional test organizations, never sends a receipt, and a project paid this way can never be shown to a customer or released to production. It does not test Stripe Checkout, signatures, settlement or refunds.`)}
${on ? "" : alert("info", ctx.env.ENVIRONMENT === "production" ? "Payment simulation is never available in production." : "Payment simulation is disabled in this environment (set PAYMENT_SIMULATION_ENABLED=\"true\" to enable it).")}
<section class="section--tight"><h2>Open invoices of customer organizations</h2>
${table(candidates, [
  { header: "Organization", cell: (r) => html`${r.organization_name}${r.simulation_test_org ? html` ${badge("open", "Test organization")}` : ""}` },
  { header: "Invoice", cell: (r) => html`<code>${r.invoice_id}</code><br><span class="faint">${r.description ?? ""}</span>` },
  { header: "Amount", cell: (r) => formatCents(r.amount_cents) },
  { header: "", cell: (r) => !on ? "" : r.simulation_test_org
    ? html`<form method="post" action="${PAGE}/simulate" class="stack">${csrf(ctx)}<input type="hidden" name="invoice_id" value="${r.invoice_id}">
${select({ name: "outcome", label: "Simulated result", options: [{ value: "paid", label: "SIMULATED_PAID" }, { value: "failed", label: "SIMULATED_FAILED" }], value: "paid" })}
${button("Deliver simulated payment event", { variant: "secondary", size: "sm" })}</form>`
    : html`<form method="post" action="${PAGE}/organizations/${r.organization_id}/mark" class="stack">${csrf(ctx)}<input type="hidden" name="mark" value="1">
${input({ name: "confirm", label: "Type the organization name to mark it as a fictional test organization", required: true, maxlength: 200 })}
${button("Mark as test organization", { variant: "ghost", size: "sm" })}</form>` },
], { empty: emptyState("No open invoices", "An order's first invoice appears here once a customer accepts a quote or starts a checkout.") })}</section>
<section class="section--tight"><h2>Simulated payment events</h2>
${table(events, [
  { header: "Received", cell: (e) => formatDateTime(e.received_at) },
  { header: "Event", cell: (e) => html`<code>${e.id}</code><br><span class="faint">${e.transaction_id}</span>` },
  { header: "Invoice", cell: (e) => e.invoice_id ?? "—" },
  { header: "Amount", cell: (e) => e.amount_cents == null ? "—" : `${formatCents(e.amount_cents)} ${e.currency ?? ""}` },
  { header: "Status", cell: (e) => e.payment_status ?? "—" },
  { header: "Outcome", cell: (e) => html`${badge(e.outcome === "applied" ? "paid" : e.outcome === "rejected" ? "failed" : "open", e.outcome)}${e.reason ? html`<br><span class="faint">${e.reason}</span>` : ""}` },
  { header: "Correlation", cell: (e) => e.correlation_id ?? "—" },
], { empty: emptyState("No simulated events", "Delivered events, including rejected ones, are listed here.") })}</section>`;
  return staffPage(ctx, "Test payments", body);
}

export function register(r: Router): void {
  r.get(PAGE, (ctx) => page(ctx));

  r.post(`${PAGE}/organizations/:id/mark`, async (ctx, p) => {
    requireStaff(ctx, "payments.simulate");
    const f = await ctx.form();
    const mark = str(f, "mark") === "1";
    try {
      await sim.markTestOrganization(ctx, ctx.user!.id, p.id, mark, str(f, "confirm"));
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 404) return redirect(ctx, PAGE, { kind: "error", text: e.message });
      throw e;
    }
    return redirect(ctx, PAGE, { kind: "success", text: mark ? "Marked as a fictional test organization." : "Test-organization mark removed." });
  });

  r.post(`${PAGE}/simulate`, async (ctx) => {
    requireStaff(ctx, "payments.simulate");
    const f = await ctx.form();
    const outcome = str(f, "outcome") === "failed" ? sim.SIMULATED_FAILED : sim.SIMULATED_PAID;
    let res: sim.DeliveryResult;
    try {
      sim.assertSimulationAllowed(ctx.env);
      const evt = await sim.createSimulatedEvent(ctx.db, ctx.env, str(f, "invoice_id"), { correlationId: `corr_${randomToken().slice(0, 16)}`, now: ctx.now(), paymentStatus: outcome });
      res = await sim.deliverSimulatedEvent(ctx, ctx.user!.id, evt, ctx.now());
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 404) return redirect(ctx, PAGE, { kind: "error", text: e.message });
      throw e;
    }
    const text = res.outcome === "applied" ? `Simulated payment applied (${res.eventId}). The real onboarding and build workflow continues from here.`
      : `Simulated event ${res.eventId}: ${res.outcome}${res.reason ? ` (${res.reason})` : ""}.`;
    return redirect(ctx, PAGE, { kind: res.outcome === "applied" ? "success" : res.outcome === "rejected" ? "error" : "info", text });
  });
}
