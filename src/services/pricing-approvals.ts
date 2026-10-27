// Founder-approved price changes and effective-price lookup (CAT-007, §6 "No unauthorized price changes", §78).
//
// The catalog (src/domain/catalog.ts) holds the approved launch prices and stays pure. A price can
// only change through this workflow:
//   1. Staff with quote.write or settings.operational PROPOSE a new price with a reason and an effective date.
//   2. Only an Owner holding pricing.change (MFA-verified user session) approves or rejects it.
//      pricing.change is never available to AI or automation actors (src/domain/authz.ts).
//   3. An approval writes an immutable price_overrides row that takes effect at its effective date.
// effectivePrice() is the single server-side lookup used by checkout (commerce.ts / billing.ts) and the
// public pricing pages, so both always show and charge the same amount. Existing orders, invoices and
// quote versions store their own amounts and are never repriced.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { can, isOwner, type Actor } from "../domain/authz.ts";
import { PACKAGES, MAINTENANCE_PLANS, type PackageId, type MaintenanceId, type PriceBreakdown } from "../domain/catalog.ts";
import { HttpError } from "../app/http.ts";
import { audit } from "./security.ts";

export type PricedItemType = "package" | "maintenance";
export interface PricedItem { type: PricedItemType; id: string; name: string; catalogCents: number; unit: string }

export const PRICED_ITEMS: PricedItem[] = [
  ...Object.values(PACKAGES).map((p) => ({ type: "package" as const, id: p.id, name: `${p.name} package`, catalogCents: p.basePriceCents, unit: p.priceIsFloor ? "starting price" : "one-time" })),
  ...Object.values(MAINTENANCE_PLANS).map((m) => ({ type: "maintenance" as const, id: m.id, name: `${m.name} maintenance`, catalogCents: m.monthlyCents, unit: "per month" })),
];

export function pricedItem(type: string, id: string): PricedItem | null {
  return PRICED_ITEMS.find((i) => i.type === type && i.id === id) ?? null;
}

export interface EffectivePrice { cents: number; source: "catalog" | "override"; overrideId: string | null; effectiveAt: string | null }

/** The price in force at `at`: the latest approved override whose effective date has arrived, otherwise the catalog price. */
export async function effectivePrice(db: Db, type: PricedItemType, id: string, at: Date = new Date()): Promise<EffectivePrice> {
  const item = pricedItem(type, id);
  if (!item) throw new HttpError(404, "Unknown catalog item.");
  const o = await db.prepare(`SELECT id, amount_cents, effective_at FROM price_overrides WHERE item_type = ? AND item_id = ? AND effective_at <= ? ORDER BY effective_at DESC, created_at DESC LIMIT 1`)
    .bind(type, id, at.toISOString()).first<{ id: string; amount_cents: number; effective_at: string }>();
  return o ? { cents: o.amount_cents, source: "override", overrideId: o.id, effectiveAt: o.effective_at } : { cents: item.catalogCents, source: "catalog", overrideId: null, effectiveAt: null };
}

export async function effectivePackagePrice(db: Db, id: PackageId, at?: Date) { return effectivePrice(db, "package", id, at); }
export async function effectiveMaintenancePrice(db: Db, id: MaintenanceId, at?: Date) { return effectivePrice(db, "maintenance", id, at); }

/** All effective prices keyed "type:id" (for pricing pages). */
export async function effectivePrices(db: Db, at: Date = new Date()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const i of PRICED_ITEMS) out[`${i.type}:${i.id}`] = (await effectivePrice(db, i.type, i.id, at)).cents;
  return out;
}

export interface ProposalInput { itemType: string; itemId: string; proposed: string; effectiveDate: string; reason: string }
export interface PriceChangeRow { id: string; item_type: PricedItemType; item_id: string; current_cents: number; proposed_cents: number; effective_at: string; reason: string; status: string; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; requester_name?: string; decider_name?: string | null }

export function canPropose(actor: Actor): boolean {
  return actor.kind === "user" && (can(actor, "quote.write") || can(actor, "settings.operational"));
}
export function canDecide(actor: Actor): boolean {
  return actor.kind === "user" && isOwner(actor) && can(actor, "pricing.change");
}

function parseDollarsToCents(s: string): number {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}

export async function proposePriceChange(db: Db, actor: Actor, input: ProposalInput, now: Date) {
  if (!canPropose(actor)) throw new HttpError(403, "You cannot propose price changes.");
  const issues: string[] = [];
  const item = pricedItem(input.itemType, input.itemId);
  if (!item) issues.push("Choose a package or maintenance plan");
  const cents = parseDollarsToCents(input.proposed);
  if (Number.isNaN(cents) || cents <= 0) issues.push("Enter the proposed price in dollars, for example 1099 or 1099.50");
  const today = now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate) || Number.isNaN(Date.parse(input.effectiveDate))) issues.push("Choose an effective date");
  else if (input.effectiveDate < today) issues.push("The effective date cannot be in the past");
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 2000) issues.push("Explain the reason for the change (10–2000 characters)");
  let current: EffectivePrice | null = null;
  if (item) {
    current = await effectivePrice(db, item.type, item.id, now);
    if (!Number.isNaN(cents) && cents === current.cents) issues.push("The proposed price is the same as the current price");
  }
  if (issues.length) return { ok: false as const, issues };
  const id = newId("pcr");
  const at = nowIso(() => now);
  await db.prepare(`INSERT INTO price_change_requests (id, item_type, item_id, current_cents, proposed_cents, effective_at, reason, status, requested_by, requested_at) VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`)
    .bind(id, item!.type, item!.id, current!.cents, cents, `${input.effectiveDate}T00:00:00.000Z`, reason, actor.userId, at).run();
  await audit(db, { actorUserId: actor.userId, action: "pricing.change_proposed", subjectType: "price_change_request", subjectId: id,
    details: { item: `${item!.type}:${item!.id}`, currentCents: current!.cents, proposedCents: cents, effectiveDate: input.effectiveDate, reason } });
  const owners = (await db.prepare(`SELECT DISTINCT user_id FROM memberships WHERE role_id = 'owner'`).all<{ user_id: string }>()).results;
  for (const o of owners) {
    await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(newId("ntf"), o.user_id, "price_change_proposed", "price_change_request", id, `Price change proposed for ${item!.name}: $${(cents / 100).toFixed(2)} — needs Founder approval.`, at).run();
  }
  return { ok: true as const, id };
}

export async function decidePriceChange(db: Db, actor: Actor, id: string, decision: "approved" | "rejected", note: string, now: Date) {
  // Founder-protected (§78): Owner user with MFA only. AI/automation actors never hold pricing.change.
  if (!canDecide(actor)) throw new HttpError(403, "Only the Founder (Owner with pricing.change) can approve or reject price changes.");
  const r = await db.prepare(`SELECT * FROM price_change_requests WHERE id = ?`).bind(id).first<PriceChangeRow>();
  if (!r) throw new HttpError(404, "Price change request not found.");
  if (r.status !== "pending") throw new HttpError(409, `This request was already ${r.status}.`);
  if (decision === "rejected" && note.trim().length < 3) throw new HttpError(422, "Give a short reason for rejecting the change.");
  const at = nowIso(() => now);
  // An approval decided after the requested date takes effect at the moment of approval, never retroactively.
  const effectiveAt = r.effective_at < at ? at : r.effective_at;
  const stmts = [db.prepare(`UPDATE price_change_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, effective_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(decision, actor.userId, at, note.trim() || null, decision === "approved" ? effectiveAt : r.effective_at, id)];
  const overrideId = newId("pov");
  if (decision === "approved") {
    stmts.push(db.prepare(`INSERT INTO price_overrides (id, item_type, item_id, amount_cents, effective_at, request_id, approved_by, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(overrideId, r.item_type, r.item_id, r.proposed_cents, effectiveAt, id, actor.userId, at));
  }
  const res = await db.batch(stmts);
  if (res[0].meta.changes !== 1) throw new HttpError(409, "This request changed while you were viewing it. Reload the page.");
  await audit(db, { actorUserId: actor.userId, action: decision === "approved" ? "pricing.change_approved" : "pricing.change_rejected", subjectType: "price_change_request", subjectId: id,
    details: { item: `${r.item_type}:${r.item_id}`, fromCents: r.current_cents, toCents: r.proposed_cents, effectiveAt: decision === "approved" ? effectiveAt : null, overrideId: decision === "approved" ? overrideId : null, note: note.trim() || null } });
  await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(newId("ntf"), r.requested_by, `price_change_${decision}`, "price_change_request", id, `Your proposed price change for ${pricedItem(r.item_type, r.item_id)?.name ?? r.item_id} was ${decision}.`, at).run();
  return { effectiveAt };
}

export async function listPriceChanges(db: Db, limit = 100) {
  return (await db.prepare(`SELECT r.*, u.display_name AS requester_name, d.display_name AS decider_name FROM price_change_requests r JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.requested_at DESC LIMIT ?`).bind(limit).all<PriceChangeRow>()).results;
}

export async function scheduledOverrides(db: Db, now: Date) {
  return (await db.prepare(`SELECT id, item_type, item_id, amount_cents, effective_at FROM price_overrides WHERE effective_at > ? ORDER BY effective_at`).bind(now.toISOString())
    .all<{ id: string; item_type: PricedItemType; item_id: string; amount_cents: number; effective_at: string }>()).results;
}

/** Re-bases a pure priceQuote() breakdown for a standard package on the effective package price (quotes use the same price as checkout). */
export async function withEffectivePackagePrice(db: Db, price: PriceBreakdown, at: Date = new Date()): Promise<PriceBreakdown> {
  if (price.packageId === "custom") return price;
  const eff = await effectivePackagePrice(db, price.packageId, at);
  if (eff.source === "catalog") return price;
  const lines = price.lines.map((l, i) => (i === 0 ? { ...l, amountCents: eff.cents } : l));
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  return { ...price, lines, totalCents: total, installments: [{ kind: "full", amountCents: total }] };
}
