// Quote builder, versioning, proposal delivery and acceptance (SALES-002..004, CAT-003, CAT-007).
// Totals are ALWAYS computed by priceQuote() on the server from the package catalog or
// staff-authored lines; nothing the browser sends as a "total" or "price" is trusted.
// Proposal links carry an opaque token; only its SHA-256 hash is stored and it is bound to the
// exact quote version that was sent, so a later revision supersedes the old link.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { can, type Actor } from "../domain/authz.ts";
import { LEAD_TRANSITIONS, type LeadStage } from "../domain/crm.ts";
import { priceQuote, PricingError, PACKAGES, type PackageId, type QuoteLine, type PriceBreakdown } from "../domain/catalog.ts";
import { randomToken, hashToken } from "../lib/auth-crypto.ts";
import { HttpError } from "../app/http.ts";
import { changeLeadStage } from "./leads.ts";
import { createQuoteOrder } from "./commerce.ts";
import { sendMail } from "./mailer.ts";
import { audit } from "./security.ts";
import { withEffectivePackagePrice } from "./pricing-approvals.ts";
import { getLead, leadScope, type LeadRow } from "./crm.ts";

/** Automation actor used for pipeline moves triggered by a customer's own action (quote acceptance).
 *  It is kind "system", so Founder-protected permissions are never available to it (authz.ts). */
export const SALES_AUTOMATION: Actor = { kind: "system", roles: [{ role: "owner", organizationId: "system" }], mfaVerified: true };

export interface QuoteInput {
  packageId: PackageId | "custom";
  lines: QuoteLine[];          // extra lines (premium) or all lines (custom)
  scope: string;
  validUntil: string;          // YYYY-MM-DD
}

export interface QuoteVersionRow {
  id: string; quote_id: string; version: number; line_items_json: string; total_cents: number; payment_schedule: string; scope_text: string;
  valid_until: string | null; accepted_at: string | null; accepted_by_contact_id: string | null; accepted_by_user_id: string | null; package_id: string | null; created_at: string;
}
export interface QuoteRow { id: string; lead_id: string; status: string; current_version: number; created_by: string; created_at: string; sent_at: string | null }

export function validateQuoteInput(input: QuoteInput, today: string): { ok: true; price: PriceBreakdown } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (input.scope.length < 20 || input.scope.length > 20_000) issues.push("Describe the scope (at least 20 characters)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil) || Number.isNaN(Date.parse(input.validUntil))) issues.push("Choose a valid-until date");
  else if (input.validUntil < today) issues.push("Valid-until must be today or later");
  if (input.lines.length > 40) issues.push("Too many line items");
  for (const l of input.lines) if (l.description.length > 300) issues.push("Line descriptions must be 300 characters or fewer");
  let price: PriceBreakdown | null = null;
  try {
    price = priceQuote({ packageId: input.packageId, customLines: input.lines });
  } catch (e) {
    if (e instanceof PricingError) issues.push(e.message); else throw e;
  }
  if (issues.length || !price) return { ok: false, issues };
  return { ok: true, price };
}

function assertLeadWritable(actor: Actor, lead: LeadRow) {
  if (!can(actor, "quote.write")) throw new HttpError(403, "You cannot write quotes.");
  if (can(actor, "lead.write_all")) return;
  if (can(actor, "lead.write_assigned") && lead.owner_user_id === actor.userId) return;
  throw new HttpError(403, "This lead is not assigned to you.");
}

/** Creates a quote (version 1) or a new version of an existing quote. Every save is a new version; the quote returns to draft. */
export async function saveQuote(db: Db, actor: Actor, leadId: string, quoteId: string | null, input: QuoteInput, today: string) {
  const lead = await getLead(db, actor, leadId);
  assertLeadWritable(actor, lead);
  const v = validateQuoteInput(input, today);
  if (!v.ok) return v;
  const at = nowIso();
  const price = await withEffectivePackagePrice(db, v.price); // CAT-007: Founder-approved effective package price
  const lineJson = JSON.stringify({ lines: price.lines, installments: price.installments });
  if (!quoteId) {
    const qid = newId("qt"), vid = newId("qv");
    await db.batch([
      db.prepare(`INSERT INTO quotes (id, lead_id, status, current_version, created_by, created_at) VALUES (?,?, 'draft', 1, ?, ?)`).bind(qid, leadId, actor.userId, at),
      db.prepare(`INSERT INTO quote_versions (id, quote_id, version, line_items_json, total_cents, payment_schedule, scope_text, valid_until, package_id, created_by, created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?)`)
        .bind(vid, qid, lineJson, price.totalCents, price.schedule, input.scope, input.validUntil, price.packageId, actor.userId, at),
      db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'system',?,?)`).bind(newId("act"), leadId, actor.userId ?? null, `Quote ${qid} v1 drafted ($${(price.totalCents / 100).toFixed(2)})`, at),
    ]);
    await audit(db, { actorUserId: actor.userId, action: "quote.created", subjectType: "quote", subjectId: qid, details: { version: 1, totalCents: price.totalCents, packageId: price.packageId } });
    return { ok: true as const, quoteId: qid, version: 1, price };
  }
  const q = await db.prepare(`SELECT * FROM quotes WHERE id = ? AND lead_id = ?`).bind(quoteId, leadId).first<QuoteRow>();
  if (!q) throw new HttpError(404, "Quote not found.");
  if (q.status === "accepted") throw new HttpError(409, "This quote was accepted and can no longer be revised. Use a change order for additional work.");
  const next = q.current_version + 1;
  const res = await db.batch([
    db.prepare(`UPDATE quotes SET current_version = ?, status = 'draft' WHERE id = ? AND current_version = ?`).bind(next, quoteId, q.current_version),
    db.prepare(`INSERT INTO quote_versions (id, quote_id, version, line_items_json, total_cents, payment_schedule, scope_text, valid_until, package_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId("qv"), quoteId, next, lineJson, price.totalCents, price.schedule, input.scope, input.validUntil, price.packageId, actor.userId, at),
    db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'system',?,?)`).bind(newId("act"), leadId, actor.userId ?? null, `Quote ${quoteId} revised to v${next} ($${(price.totalCents / 100).toFixed(2)})`, at),
  ]);
  if (res[0].meta.changes !== 1) throw new HttpError(409, "The quote changed while you were editing. Reload and try again.");
  await audit(db, { actorUserId: actor.userId, action: "quote.revised", subjectType: "quote", subjectId: quoteId, details: { version: next, totalCents: price.totalCents } });
  return { ok: true as const, quoteId, version: next, price };
}

export async function getQuote(db: Db, actor: Actor, quoteId: string) {
  const scope = leadScope(actor);
  const q = await db.prepare(`SELECT q.* FROM quotes q JOIN leads l ON l.id = q.lead_id WHERE q.id = ? AND ${scope.sql}`).bind(quoteId, ...scope.binds).first<QuoteRow>();
  if (!q) throw new HttpError(404, "Quote not found.");
  const versions = (await db.prepare(`SELECT * FROM quote_versions WHERE quote_id = ? ORDER BY version DESC`).bind(quoteId).all<QuoteVersionRow>()).results;
  return { quote: q, versions, current: versions.find((v) => v.version === q.current_version)! };
}

export async function listQuotes(db: Db, actor: Actor, f: { status?: string }, page: { limit: number; offset: number }) {
  const scope = leadScope(actor);
  const conds = [scope.sql], binds = [...scope.binds];
  if (f.status) { conds.push(`q.status = ?`); binds.push(f.status); }
  return (await db.prepare(`SELECT q.id, q.status, q.current_version, q.created_at, q.sent_at, q.lead_id, qv.total_cents, qv.payment_schedule, qv.valid_until, qv.package_id, c.name AS contact_name, co.name AS company_name
    FROM quotes q JOIN leads l ON l.id = q.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id
    JOIN quote_versions qv ON qv.quote_id = q.id AND qv.version = q.current_version WHERE ${conds.join(" AND ")} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, page.limit + 1, page.offset)
    .all<{ id: string; status: string; current_version: number; created_at: string; sent_at: string | null; lead_id: string; total_cents: number; payment_schedule: string; valid_until: string | null; package_id: string | null; contact_name: string; company_name: string | null }>()).results;
}

/** Sends the current version: new access token (hash stored), email, lead → quote_sent where valid. */
export async function sendQuote(ctx: AppContext, actor: Actor, quoteId: string) {
  if (!can(actor, "quote.send")) throw new HttpError(403, "You cannot send quotes.");
  const { quote, current } = await getQuote(ctx.db, actor, quoteId);
  const lead = await getLead(ctx.db, actor, quote.lead_id);
  assertLeadWritable(actor, lead);
  if (quote.status === "accepted") throw new HttpError(409, "This quote is already accepted.");
  if (!lead.contact_email) throw new HttpError(409, "The contact has no email address. Add one before sending the proposal.");
  const today = ctx.now().toISOString().slice(0, 10);
  if (current.valid_until && current.valid_until < today) throw new HttpError(409, "This version has expired. Save a new version with a later valid-until date.");
  const token = randomToken();
  const at = nowIso(ctx.now);
  const expires = current.valid_until ? `${current.valid_until}T23:59:59.999Z` : new Date(ctx.now().getTime() + 30 * 86400e3).toISOString();
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO quote_access_tokens (token_hash, quote_id, contact_id, quote_version_id, expires_at, created_at) VALUES (?,?,?,?,?,?)`).bind(await hashToken(token), quoteId, lead.contact_id, current.id, expires, at),
    ctx.db.prepare(`UPDATE quotes SET status = 'sent', sent_at = COALESCE(sent_at, ?) WHERE id = ?`).bind(at, quoteId),
    ctx.db.prepare(`INSERT INTO crm_activities (id, lead_id, actor_user_id, kind, body, created_at) VALUES (?,?,?,'email',?,?)`).bind(newId("act"), lead.id, actor.userId ?? null, `Proposal v${current.version} emailed to ${lead.contact_email}`, at),
  ]);
  const url = `${ctx.baseUrl}/q/${token}`;
  await sendMail(ctx, {
    template: "quote_sent", to: lead.contact_email, subject: "Your Crestmont proposal", heading: "Your website proposal is ready",
    idempotencyKey: `quote:${current.id}:${token.slice(0, 12)}`,
    paragraphs: [`Hello ${lead.contact_name}, thank you for considering Crestmont Website Development.`,
      `Your proposal totals $${(current.total_cents / 100).toFixed(2)}${current.valid_until ? ` and is valid until ${current.valid_until}` : ""}. Review the scope, line items and payment schedule at the link below.`,
      "To accept, you will sign in (or create an account) with this email address."],
    cta: { label: "Review proposal", url },
  });
  await audit(ctx.db, { actorUserId: actor.userId, action: "quote.sent", subjectType: "quote", subjectId: quoteId, details: { version: current.version } });
  let stageNote: string | null = null;
  if (lead.stage !== "quote_sent") {
    if ((LEAD_TRANSITIONS[lead.stage] as readonly LeadStage[]).includes("quote_sent")) await changeLeadStage(ctx.db, actor, lead.id, "quote_sent");
    else stageNote = `Lead stays in "${lead.stage}" — moving to Quote Sent is not a valid transition from there.`;
  }
  return { token, url, stageNote };
}

// ── public proposal ──
export type ProposalState = "open" | "accepted" | "expired" | "superseded" | "withdrawn";
export interface Proposal {
  tokenHash: string; quote: QuoteRow; version: QuoteVersionRow; lines: QuoteLine[]; installments: PriceBreakdown["installments"];
  contact: { id: string; name: string; email: string | null }; companyName: string | null; state: ProposalState; leadId: string; leadStage: LeadStage;
}

export async function loadProposal(db: Db, token: string, now: Date): Promise<Proposal | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const h = await hashToken(token);
  const t = await db.prepare(`SELECT token_hash, quote_id, contact_id, quote_version_id, expires_at FROM quote_access_tokens WHERE token_hash = ?`).bind(h)
    .first<{ token_hash: string; quote_id: string; contact_id: string; quote_version_id: string | null; expires_at: string }>();
  if (!t) return null;
  const quote = await db.prepare(`SELECT * FROM quotes WHERE id = ?`).bind(t.quote_id).first<QuoteRow>();
  if (!quote) return null;
  const version = t.quote_version_id
    ? await db.prepare(`SELECT * FROM quote_versions WHERE id = ?`).bind(t.quote_version_id).first<QuoteVersionRow>()
    : await db.prepare(`SELECT * FROM quote_versions WHERE quote_id = ? AND version = ?`).bind(quote.id, quote.current_version).first<QuoteVersionRow>();
  if (!version) return null;
  const c = await db.prepare(`SELECT c.id, c.name, c.email, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?`).bind(t.contact_id).first<{ id: string; name: string; email: string | null; company: string | null }>();
  const lead = await db.prepare(`SELECT stage FROM leads WHERE id = ?`).bind(quote.lead_id).first<{ stage: LeadStage }>();
  const parsed = JSON.parse(version.line_items_json) as { lines: QuoteLine[]; installments: PriceBreakdown["installments"] };
  const nowS = now.toISOString();
  let state: ProposalState = "open";
  if (version.accepted_at) state = "accepted";
  else if (quote.status === "accepted") state = "superseded"; // another version was accepted
  else if (version.version !== quote.current_version || quote.status === "superseded") state = "superseded";
  else if (quote.status === "rejected") state = "withdrawn";
  else if (t.expires_at < nowS || (version.valid_until && `${version.valid_until}T23:59:59.999Z` < nowS) || quote.status === "expired") state = "expired";
  return { tokenHash: h, quote, version, lines: parsed.lines, installments: parsed.installments, contact: { id: c!.id, name: c!.name, email: c!.email }, companyName: c!.company, state, leadId: quote.lead_id, leadStage: lead!.stage };
}

/** Customer acceptance. Caller has verified the signed-in user's organization (requireCustomerOrg). */
export async function acceptProposal(ctx: AppContext, p: Proposal, user: { id: string; email: string }, organizationId: string) {
  if (p.state !== "open") throw new HttpError(409, p.state === "accepted" ? "This proposal has already been accepted." : p.state === "superseded" ? "This proposal has been replaced by a newer version. Use the link in the latest email." : "This proposal is no longer open for acceptance.");
  if (!p.contact.email || p.contact.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new HttpError(403, `This proposal was sent to a different email address. Sign in with the address the proposal was sent to.`);
  }
  const at = nowIso(ctx.now);
  const res = await ctx.db.batch([
    ctx.db.prepare(`UPDATE quote_versions SET accepted_at = ?, accepted_by_contact_id = ?, accepted_by_user_id = ? WHERE id = ? AND accepted_at IS NULL`).bind(at, p.contact.id, user.id, p.version.id),
    ctx.db.prepare(`UPDATE quotes SET status = 'accepted' WHERE id = ? AND current_version = ? AND status <> 'accepted'`).bind(p.quote.id, p.version.version),
    ctx.db.prepare(`UPDATE contacts SET user_id = COALESCE(user_id, ?) WHERE id = ?`).bind(user.id, p.contact.id),
    // Link the CRM company to the customer's organization (creates the customer record link).
    ctx.db.prepare(`UPDATE companies SET organization_id = COALESCE(organization_id, ?) WHERE id = (SELECT company_id FROM contacts WHERE id = ?)`).bind(organizationId, p.contact.id),
  ]);
  if (res[0].meta.changes !== 1 || res[1].meta.changes !== 1) throw new HttpError(409, "This proposal changed while you were viewing it. Reload the page.");
  await audit(ctx.db, { actorUserId: user.id, action: "quote.accepted", subjectType: "quote", subjectId: p.quote.id, organizationId, details: { version: p.version.version, totalCents: p.version.total_cents } });
  // Pipeline: → accepted → awaiting_payment (only where the transition is valid).
  const notes: string[] = [];
  for (const to of ["accepted", "awaiting_payment"] as const) {
    try { await changeLeadStage(ctx.db, SALES_AUTOMATION, p.leadId, to); }
    catch (e) { notes.push(`Stage not moved to ${to}: ${(e as Error).message}`); }
  }
  if (notes.length) {
    await ctx.db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`).bind(newId("act"), p.leadId, notes.join("; "), at).run();
  }
  const order = await createQuoteOrder(ctx.db, organizationId, { id: p.version.id, total_cents: p.version.total_cents, payment_schedule: p.version.payment_schedule, quote_id: p.quote.id }, p.leadId, user.id);
  await ctx.db.prepare(`INSERT INTO crm_activities (id, lead_id, kind, body, created_at) VALUES (?,?,'system',?,?)`)
    .bind(newId("act"), p.leadId, `Customer accepted quote v${p.version.version}; order ${order.orderId} created with first invoice ${order.invoiceId}`, at).run();
  // Notify the lead owner.
  const owner = await ctx.db.prepare(`SELECT owner_user_id FROM leads WHERE id = ?`).bind(p.leadId).first<{ owner_user_id: string | null }>();
  if (owner?.owner_user_id) {
    await ctx.db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("ntf"), owner.owner_user_id, "quote_accepted", "lead", p.leadId, `${p.contact.name} accepted quote v${p.version.version}.`, at).run();
  }
  return order;
}

export function packageName(id: string | null) {
  return id && id in PACKAGES ? PACKAGES[id as PackageId].name : "Custom development";
}
