// Stripe webhook verification and idempotent event recording (§22, PAY-002, PAY-003).
// Signature scheme: header `Stripe-Signature: t=<ts>,v1=<hex>`, signed payload `${t}.${rawBody}`.
import { hmacSha256Hex, timingSafeEqualHex } from "../lib/crypto.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";

export class WebhookSignatureError extends Error {}

export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {}): Promise<void> {
  if (!secret) throw new WebhookSignatureError("Webhook secret not configured");
  if (!header) throw new WebhookSignatureError("Missing Stripe-Signature header");
  const parts = header.split(",").map((p) => p.trim().split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) throw new WebhookSignatureError("Malformed Stripe-Signature header");
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > tolerance) throw new WebhookSignatureError("Timestamp outside tolerance");
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  if (!sigs.some((s) => timingSafeEqualHex(s, expected))) throw new WebhookSignatureError("Signature mismatch");
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: { id: string; [k: string]: unknown } };
}

/** Shape check for a verified event body before it is stored or processed (SEC-001). */
export function isStripeEventEnvelope(v: unknown): v is StripeEvent {
  const e = v as Partial<StripeEvent> | null;
  const obj = e && typeof e === "object" && !Array.isArray(e) ? e.data?.object : null;
  return !!e && typeof e.id === "string" && e.id.length > 0 && e.id.length <= 255 && typeof e.type === "string" && e.type.length > 0 && e.type.length <= 255
    && Number.isInteger(e.created) && !!obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.id === "string" && obj.id.length <= 255;
}

export type RecordOutcome = "new" | "duplicate";

/** Stores the event exactly once. Duplicate deliveries are acknowledged without reprocessing. */
export async function recordStripeEvent(db: Db, evt: StripeEvent, rawBody: string): Promise<RecordOutcome> {
  const res = await db.prepare(
    `INSERT INTO stripe_events (id, type, object_id, stripe_created, payload, status, attempts, received_at)
     VALUES (?, ?, ?, ?, ?, 'received', 0, ?) ON CONFLICT(id) DO NOTHING`,
  ).bind(evt.id, evt.type, evt.data?.object?.id ?? null, evt.created, rawBody, nowIso()).run();
  return res.meta.changes === 1 ? "new" : "duplicate";
}

/**
 * Out-of-order protection: an event is stale if a later event for the same object
 * has already been processed. Stale events are marked `ignored` rather than applied.
 */
export async function isStaleEvent(db: Db, evt: StripeEvent): Promise<boolean> {
  const row = await db.prepare(
    `SELECT MAX(stripe_created) AS latest FROM stripe_events WHERE object_id = ? AND status = 'processed' AND id <> ?`,
  ).bind(evt.data.object.id, evt.id).first<{ latest: number | null }>();
  return row?.latest != null && row.latest > evt.created;
}

const MAX_ATTEMPTS = 5;

export async function markEventResult(db: Db, eventId: string, result: { ok: true; ignored?: boolean } | { ok: false; error: string }): Promise<void> {
  if (result.ok) {
    await db.prepare(`UPDATE stripe_events SET status = ?, processed_at = ?, attempts = attempts + 1 WHERE id = ?`)
      .bind(result.ignored ? "ignored" : "processed", nowIso(), eventId).run();
  } else {
    await db.prepare(
      `UPDATE stripe_events SET attempts = attempts + 1, last_error = ?,
         status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'dead_letter' ELSE 'failed' END WHERE id = ?`,
    ).bind(result.error.slice(0, 2000), eventId).run();
  }
}
