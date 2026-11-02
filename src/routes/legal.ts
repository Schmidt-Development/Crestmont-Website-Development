// Agreements & acceptance records (LEGAL-003), printable receipts (PAY-005) and Founder-approved
// price changes (CAT-007).
//   Public:   /legal/:kind/versions, /legal/:kind/versions/:version   (exact stored text of each version)
//   Portal:   /portal/agreements, /portal/billing/receipts/:paymentId  (requireCustomerOrg; org-scoped queries)
//   Staff:    /staff/legal (customers.read), /staff/finance/receipts/:paymentId (finance.read),
//             /staff/pricing (propose: quote.write or settings.operational; decide: Owner + pricing.change)
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatCents, formatDate, formatDateTime, label, type SafeHtml } from "../lib/html.ts";
import { HttpError, htmlResponse, redirect, str } from "../app/http.ts";
import { requireStaff, requireCustomerOrg } from "../app/app.ts";
import { appLayout, publicLayout } from "../ui/layout.ts";
import { portalNav, staffNav } from "./nav.ts";
import { csrf, button, linkButton, input, textarea, select, formErrors, alert, badge, table, emptyState, pagination, pageParam, dl, pageHead } from "../ui/components.ts";
import { DRAFT_BANNER } from "../content/legal.ts";
import * as ag from "../services/agreements.ts";
import { loadReceipt, businessIdentity, type ReceiptData } from "../services/receipts.ts";
import { taxStatement, taxLabel } from "../services/tax.ts";
import { usd } from "../services/finance-documents.ts";
import * as pricing from "../services/pricing-approvals.ts";
import { audit } from "../services/security.ts";

function portalPage(ctx: AppContext, title: string, body: SafeHtml, status = 200) {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body), status);
}
function staffPage(ctx: AppContext, title: string, body: SafeHtml, status = 200) {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: staffNav(ctx), home: "/staff", area: "Staff" }, body), status);
}

const versionHref = (kind: string, version: string) => `/legal/${ag.slugForKind(kind) ?? kind}/versions/${encodeURIComponent(version)}`;
const docTitle = (r: { title: string | null; kind: string }) => r.title ?? label(r.kind);
const CONTEXT_LABEL: Record<string, string> = { registration: "Account registration", quote_acceptance: "Proposal acceptance", package_quote_acceptance: "Package proposal acceptance", package_checkout: "Package checkout", maintenance_checkout: "Maintenance subscription" };
const reviewBadge = (reviewed: number) => (reviewed ? badge("verified", "Attorney reviewed") : badge("pending", "Draft — not attorney reviewed"));

// ───────────────────────── LEGAL-003 ─────────────────────────

async function versionPage(ctx: AppContext, kindOrSlug: string, version: string) {
  const k = ag.kindForSlugOrKind(kindOrSlug);
  if (!k) throw new HttpError(404, "That policy does not exist.");
  const v = await ag.versionByKind(ctx.db, k.kind, version);
  if (!v || !v.body_text) throw new HttpError(404, "That version does not exist.");
  const latest = (await ag.latestVersions(ctx.db)).get(k.kind);
  const blocks = ag.textBlocks(v.body_text);
  return htmlResponse(ctx, publicLayout(ctx, { title: `${docTitle(v)} — version ${v.version}`, noindex: true }, html`<section class="section"><div class="container">
<div class="eyebrow">Policies · version history</div><h1>${docTitle(v)}</h1>
${dl([["Version", v.version], ["Effective", formatDateTime(v.effective_at)], ["Status", reviewBadge(v.attorney_reviewed)], ["SHA-256 of text", html`<code style="word-break:break-all">${v.body_sha256}</code>`], ["Current version", latest?.id === v.id ? "Yes" : html`No — <a href="${versionHref(k.kind, latest?.version ?? "")}">see the current version</a>`]])}
${v.attorney_reviewed ? "" : html`<div class="legal-draft" role="note" style="margin-top:1.5rem">${DRAFT_BANNER}</div>`}
<p class="faint">This is the exact text stored for this version. Anyone who accepted this version accepted this text.</p>
<article class="prose legal">${blocks.map((b) => b.t === "h2" ? html`<h2>${b.s}</h2>` : b.t === "p" ? html`<p>${b.s}</p>` : html`<ul>${b.items.map((i) => html`<li>${i}</li>`)}</ul>`)}</article>
<hr><p><a href="/legal/${k.slug}/versions">All versions of this document</a> · <a href="/legal/${k.slug}">Current page</a></p></div></section>`));
}

async function versionsList(ctx: AppContext, kindOrSlug: string) {
  const k = ag.kindForSlugOrKind(kindOrSlug);
  if (!k) throw new HttpError(404, "That policy does not exist.");
  const rows = await ag.versionsForKind(ctx.db, k.kind);
  return htmlResponse(ctx, publicLayout(ctx, { title: "Version history", noindex: true }, html`<section class="section"><div class="container">
<div class="eyebrow">Policies · version history</div><h1>${rows[0] ? docTitle(rows[0]) : label(k.kind)}</h1>
${table(rows, [{ header: "Version", cell: (r) => html`<a href="${versionHref(r.kind, r.version)}">${r.version}</a>` }, { header: "Effective", cell: (r) => formatDateTime(r.effective_at) }, { header: "Review", cell: (r) => reviewBadge(r.attorney_reviewed) }],
    { empty: emptyState("No versions stored", "No version of this document has been recorded yet.") })}</div></section>`));
}

async function portalAgreements(ctx: AppContext) {
  const org = requireCustomerOrg(ctx);
  const pg = pageParam(ctx);
  const rows = await ag.orgAcceptances(ctx.db, org.organizationId, pg);
  return portalPage(ctx, "Agreements", html`${pageHead("Agreements", undefined, org.organizationName)}
<p class="muted">Every time someone in your organization accepted Crestmont's terms or policies, we recorded who accepted, when, from which IP address, and the exact version of the text. Select a version to read exactly what was accepted.</p>
${alert("info", "All Crestmont policies are currently drafts pending attorney review.")}
${table(rows.slice(0, pg.limit), [
    { header: "Accepted", cell: (r) => formatDateTime(r.accepted_at) }, { header: "By", cell: (r) => `${r.user_name} (${r.user_email})` },
    { header: "Document", cell: (r) => docTitle(r) }, { header: "Version", cell: (r) => html`<a href="${versionHref(r.kind, r.version)}">${r.version}</a>` },
    { header: "When", cell: (r) => CONTEXT_LABEL[r.context_type ?? ""] ?? "—" }, { header: "IP", cell: (r) => r.ip ?? "Not recorded" }],
    { empty: emptyState("No agreements accepted yet", "Agreements are recorded when you register, accept a proposal or check out.", linkButton("Read our policies", "/legal", "secondary")) })}
${pagination(ctx, pg.page, rows.length > pg.limit)}`);
}

async function staffLegal(ctx: AppContext) {
  requireStaff(ctx, "customers.read");
  const orgFilter = ctx.url.searchParams.get("org") ?? "";
  const org = orgFilter ? await ctx.db.prepare(`SELECT id, name FROM organizations WHERE id = ? AND kind = 'customer'`).bind(orgFilter).first<{ id: string; name: string }>() : null;
  if (orgFilter && !org) throw new HttpError(404, "Customer not found.");
  const pg = pageParam(ctx);
  const rows = await ag.allAcceptances(ctx.db, { organizationId: org?.id }, pg);
  const versions = await ag.versionsWithCounts(ctx.db);
  const drift = await ag.agreementDrift(ctx.db, ag.factsFromSettings(ctx.settings));
  return staffPage(ctx, "Agreements", html`${pageHead(org ? `Agreements — ${org.name}` : "Agreements & acceptances", org ? linkButton("All customers", "/staff/legal", "ghost", "sm") : undefined, "Legal")}
${alert("warn", "No document is attorney reviewed. LEGAL-004 stays open until a real attorney review is recorded; this page never marks a draft as reviewed.")}
${drift.length ? alert("info", html`The current wording of ${drift.map((d) => d.title).join(", ")} differs from the latest stored version (for example because a business setting changed). A new version is stored automatically the next time someone accepts it, so every acceptance points at the exact text shown.`) : ""}
<section class="card stack"><h2 style="font-size:1.2rem">Acceptance records</h2>${table(rows.slice(0, pg.limit), [
    { header: "Accepted", cell: (r) => formatDateTime(r.accepted_at) }, { header: "Customer", cell: (r) => html`<a href="/staff/legal?org=${r.organization_id}">${r.org_name}</a>` },
    { header: "By", cell: (r) => `${r.user_name} (${r.user_email})` }, { header: "Document", cell: (r) => docTitle(r) },
    { header: "Version", cell: (r) => html`<a href="${versionHref(r.kind, r.version)}">${r.version}</a>` }, { header: "Context", cell: (r) => CONTEXT_LABEL[r.context_type ?? ""] ?? "—" }, { header: "IP", cell: (r) => r.ip ?? "—" }],
    { empty: emptyState("No acceptances recorded", "Acceptances are recorded at registration, proposal acceptance and checkout.") })}
${pagination(ctx, pg.page, rows.length > pg.limit)}</section>
${org ? "" : html`<section class="card stack"><h2 style="font-size:1.2rem">Stored versions</h2>${table(versions, [
    { header: "Document", cell: (v) => docTitle(v) }, { header: "Version", cell: (v) => html`<a href="${versionHref(v.kind, v.version)}">${v.version}</a>` },
    { header: "Effective", cell: (v) => formatDateTime(v.effective_at) }, { header: "Review", cell: (v) => reviewBadge(v.attorney_reviewed) }, { header: "Acceptances", cell: (v) => v.acceptances, numeric: true },
    { header: "SHA-256", cell: (v) => html`<code>${v.body_sha256.slice(0, 12)}…</code>` }])}</section>`}`);
}

// ───────────────────────── PAY-005 receipts ─────────────────────────

const MILESTONE_LABEL: Record<string, string> = { full: "Payment in full", deposit_50: "50% deposit", design_25: "25% design milestone", prelaunch_25: "25% pre-launch", change_order: "Change order", subscription: "Subscription" };

function receiptDocument(ctx: AppContext, r: ReceiptData, backHref: string): SafeHtml {
  const id = businessIdentity(ctx.settings);
  const ref = r.payment.stripe_payment_intent_id ?? null;
  return html`<div class="no-print row" style="margin-bottom:1rem">${linkButton("Back", backHref, "ghost", "sm")}
<a class="btn btn--primary btn--sm" href="${ctx.url.pathname}/pdf" data-pdf>Download PDF</a>
<a class="btn btn--secondary btn--sm" href="${ctx.url.pathname}?view=print">Print version</a></div>
<article class="card receipt stack" data-testid="receipt">
<div class="row row--between"><div><div class="eyebrow">Payment receipt</div><h1 style="margin:0">${r.receiptNumber}</h1></div>
<div style="text-align:right"><strong>${id.tradingName}</strong><br>
${id.legalName ? html`<span>${id.legalName}</span><br>` : html`<span class="faint" data-testid="legal-name-pending">The legal business name will appear here once the legal entity is established.</span><br>`}
${id.address ? html`<span>${id.address}</span><br>` : html`<span class="faint">A registered business address will appear here once established.</span><br>`}
<span>${id.billingEmail}</span></div></div>
${dl([
  ["Receipt number", r.receiptNumber], ["Billed to", r.organization.name], ["Payment date", formatDateTime(r.payment.created_at)],
  ["Amount paid", html`<strong>${formatCents(r.payment.amount_cents)}</strong> USD`], ["Payment status", label(r.payment.status)],
  ...(r.refundedCents ? [["Refunded", formatCents(r.refundedCents)] as [string, string]] : []),
  ["Invoice", r.invoice ? `${r.invoice.id} — ${r.invoice.description ?? MILESTONE_LABEL[r.invoice.milestone_kind ?? ""] ?? "Invoice"}` : "No invoice linked"],
  ["Invoice amount", r.invoice ? formatCents(r.invoice.amount_cents) : "—"],
  ...(r.tax ? [["Of which sales tax", html`${r.tax.byJurisdiction.map((j) => html`<span data-testid="receipt-tax">${taxLabel(j)}: ${usd(j.taxCents)}</span><br>`)}`] as [string, SafeHtml]] : []),
  ["Invoice issued", formatDate(r.invoice?.created_at)],
  ["Order", r.order ? `${r.order.id} (${label(r.order.kind)}, total ${formatCents(r.order.total_cents)})` : "—"],
  ["Stripe payment reference", ref ?? "Not recorded"], ["Stripe charge", r.payment.stripe_charge_id ?? "Not recorded"],
  ["Stripe checkout session", r.invoice?.stripe_checkout_session_id ?? "Not recorded"], ["Internal payment ID", r.payment.id],
])}
<p class="faint">This receipt confirms a payment recorded from a Stripe payment confirmation. ${taxStatement(r.tax)}</p>
</article>`;
}

function printShell(ctx: AppContext, title: string, body: SafeHtml) {
  return htmlResponse(ctx, html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${title} · Crestmont Website Development</title><link rel="stylesheet" href="/assets/app.css"></head><body class="receipt-print"><main id="main" class="page">${body}</main></body></html>`);
}

async function receiptRoute(ctx: AppContext, paymentId: string, staff: boolean) {
  let r: ReceiptData; let back: string;
  if (staff) {
    requireStaff(ctx, "finance.read");
    r = await loadReceipt(ctx.db, paymentId, null);
    back = "/staff/finance/invoices";
  } else {
    const org = requireCustomerOrg(ctx);
    r = await loadReceipt(ctx.db, paymentId, org.organizationId); // 404 for any other organization's payment
    back = r.invoice ? `/portal/billing/invoices/${r.invoice.id}` : "/portal/billing";
  }
  const doc = receiptDocument(ctx, r, back);
  if (ctx.url.searchParams.get("view") === "print") return printShell(ctx, `Receipt ${r.receiptNumber}`, doc);
  const title = `Receipt ${r.receiptNumber}`;
  return staff ? staffPage(ctx, title, doc) : portalPage(ctx, title, doc);
}

// ───────────────────────── CAT-007 pricing ─────────────────────────

async function pricingPage(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status = 200) {
  requireStaff(ctx);
  const proposer = pricing.canPropose(ctx.actor!), decider = pricing.canDecide(ctx.actor!);
  if (!proposer && !decider) throw new HttpError(403, "You do not have permission to view price changes.");
  const now = ctx.now();
  const current = await Promise.all(pricing.PRICED_ITEMS.map(async (i) => ({ ...i, eff: await pricing.effectivePrice(ctx.db, i.type, i.id, now) })));
  const scheduled = await pricing.scheduledOverrides(ctx.db, now);
  const requests = await pricing.listPriceChanges(ctx.db);
  const itemName = (t: string, id: string) => pricing.pricedItem(t, id)?.name ?? id;
  const tomorrow = new Date(now.getTime() + 86400e3).toISOString().slice(0, 10);
  return staffPage(ctx, "Pricing", html`${pageHead("Prices & price changes", undefined, "Catalog")}
${alert("info", "Prices change only with Founder approval. Staff propose a change with a reason; only the Owner can approve or reject it. AI and automation can never approve. Existing orders, invoices and quotes keep the prices they were created with.")}
${formErrors(errors)}
<section class="card stack"><h2 style="font-size:1.2rem">Prices in effect now</h2>${table(current, [
    { header: "Item", cell: (i) => i.name }, { header: "Catalog price", cell: (i) => formatCents(i.catalogCents), numeric: true },
    { header: "Effective price", cell: (i) => html`<strong data-testid="effective-${i.type}-${i.id}">${formatCents(i.eff.cents)}</strong>`, numeric: true },
    { header: "Source", cell: (i) => i.eff.source === "override" ? html`Approved change since ${formatDate(i.eff.effectiveAt)}` : "Catalog (launch price)" }, { header: "Unit", cell: (i) => i.unit }])}
${scheduled.length ? html`<h3 style="font-size:1rem">Scheduled</h3>${table(scheduled, [{ header: "Item", cell: (s) => itemName(s.item_type, s.item_id) }, { header: "New price", cell: (s) => formatCents(s.amount_cents), numeric: true }, { header: "Effective", cell: (s) => formatDateTime(s.effective_at) }])}` : ""}</section>
${proposer ? html`<section class="card stack"><h2 style="font-size:1.2rem">Propose a price change</h2>
<form method="post" action="/staff/pricing" class="stack">${csrf(ctx)}
<div class="grid grid-2">${select({ name: "item", label: "Package or plan", options: pricing.PRICED_ITEMS.map((i) => ({ value: `${i.type}:${i.id}`, label: `${i.name} (${i.unit})` })), value: v.item, required: true })}
${input({ name: "proposed", label: "Proposed price ($)", value: v.proposed, inputmode: "decimal", required: true })}
${input({ name: "effective_date", label: "Effective date", type: "date", value: v.effective_date ?? tomorrow, required: true, hint: "The new price applies from 00:00 UTC on this date, or from approval if that is later." })}</div>
${textarea({ name: "reason", label: "Reason", value: v.reason, rows: 3, required: true, maxlength: 2000 })}
<div class="form-actions">${button("Submit for Founder approval", { variant: "secondary" })}</div></form></section>` : ""}
<section class="card stack"><h2 style="font-size:1.2rem">Requests</h2>${table(requests, [
    { header: "Requested", cell: (r) => formatDateTime(r.requested_at) }, { header: "By", cell: (r) => r.requester_name ?? "—" }, { header: "Item", cell: (r) => itemName(r.item_type, r.item_id) },
    { header: "From → to", cell: (r) => `${formatCents(r.current_cents)} → ${formatCents(r.proposed_cents)}` }, { header: "Effective", cell: (r) => formatDate(r.effective_at) },
    { header: "Reason", cell: (r) => r.reason.slice(0, 200) }, { header: "Status", cell: (r) => html`${badge(r.status)}${r.decided_at ? html`<br><span class="faint">${r.decider_name ?? ""} · ${formatDate(r.decided_at)}${r.decision_note ? ` · ${r.decision_note}` : ""}</span>` : ""}` },
    { header: "", cell: (r) => r.status === "pending" && decider ? html`<form method="post" action="/staff/pricing/${r.id}/decide" class="stack">${csrf(ctx)}${input({ name: "note", id: `note-${r.id}`, label: "Note (required to reject)", maxlength: 500 })}
<div class="row">${button("Approve", { name: "decision", value: "approved", size: "sm" })}${button("Reject", { name: "decision", value: "rejected", variant: "danger", size: "sm" })}</div></form>` : r.status === "pending" ? html`<span class="faint">Awaiting Founder</span>` : "" }],
    { empty: emptyState("No price change requests", "Approved launch prices from the catalog are in effect.") })}</section>`, status);
}

export function register(r: Router): void {
  r.get("/legal/:kind/versions", (ctx, p) => versionsList(ctx, p.kind));
  r.get("/legal/:kind/versions/:version", (ctx, p) => versionPage(ctx, p.kind, p.version));
  r.get("/portal/agreements", portalAgreements);
  r.get("/staff/legal", staffLegal);

  r.get("/portal/billing/receipts/:paymentId", (ctx, p) => receiptRoute(ctx, p.paymentId, false));
  r.get("/staff/finance/receipts/:paymentId", (ctx, p) => receiptRoute(ctx, p.paymentId, true));

  r.get("/staff/pricing", (ctx) => pricingPage(ctx));
  r.post("/staff/pricing", async (ctx) => {
    requireStaff(ctx);
    if (!pricing.canPropose(ctx.actor!)) throw new HttpError(403, "You cannot propose price changes.");
    const f = await ctx.form();
    const v = { item: str(f, "item"), proposed: str(f, "proposed"), effective_date: str(f, "effective_date"), reason: str(f, "reason") };
    const [itemType, itemId] = v.item.split(":");
    const res = await pricing.proposePriceChange(ctx.db, ctx.actor!, { itemType: itemType ?? "", itemId: itemId ?? "", proposed: v.proposed, effectiveDate: v.effective_date, reason: v.reason }, ctx.now());
    if (!res.ok) return pricingPage(ctx, res.issues, v, 422);
    return redirect(ctx, "/staff/pricing", { kind: "success", text: "Price change submitted for Founder approval. Prices do not change until it is approved." });
  });
  r.post("/staff/pricing/:id/decide", async (ctx, p) => {
    requireStaff(ctx);
    const f = await ctx.form();
    const decision = str(f, "decision");
    // Authorize before validating input: non-Founders get 403 (and an audit entry) whatever they send.
    if (!pricing.canDecide(ctx.actor!)) {
      await audit(ctx.db, { actorUserId: ctx.user!.id, action: "pricing.change_decision_denied", subjectType: "price_change_request", subjectId: p.id, ip: ctx.ip, details: { decision: decision.slice(0, 40) } });
      throw new HttpError(403, "Only the Founder (Owner with pricing.change) can approve or reject price changes.");
    }
    if (decision !== "approved" && decision !== "rejected") throw new HttpError(422, "Choose approve or reject.");
    const res = await pricing.decidePriceChange(ctx.db, ctx.actor!, p.id, decision, str(f, "note"), ctx.now(), ctx);
    return redirect(ctx, "/staff/pricing", { kind: "success", text: decision === "approved" ? `Approved. The new price takes effect ${formatDateTime(res.effectiveAt)}.` : "Price change rejected." });
  });
}

