// Resend delivery events + suppression list (EMAIL-003, §55 "delivery logs, failure tracking,
// appropriate unsubscribe behaviour").
//
// Resend signs webhooks with Svix (sources checked 2026-10-27):
//  - https://resend.com/docs/webhooks/verify-webhooks-requests  (svix-id / svix-timestamp / svix-signature, raw body)
//  - https://docs.svix.com/receiving/verifying-payloads/how-manual.md
//      signedContent = `${svix_id}.${svix_timestamp}.${body}`; key = base64-decode(secret without "whsec_");
//      HMAC-SHA256, base64; header is a space-delimited list of "v1,<base64>"; check timestamp tolerance;
//      constant-time compare.
//  - https://resend.com/docs/webhooks/event-types.md and /webhooks/emails/bounced.md
//      { type, created_at, data: { email_id, to: [..], bounce: { type: "Permanent" | "Temporary", subType, message } } }
//
// Status mapping onto email_deliveries (statuses allowed by 0001_core.sql):
//   email.sent → sent (only from queued); email.delivered → delivered; email.bounced (Permanent) → bounced + suppression;
//   email.bounced (other) → failed (no suppression); email.complained → suppression (status stays delivered);
//   email.delivery_delayed → last_error note only; email.failed → failed; email.suppressed → suppressed.
// Never downgrades: once delivered/bounced, a late "sent" does not move the row back.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";

export class SvixAuthError extends Error {}
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

const enc = new TextEncoder();

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64encode(b: ArrayBuffer): string {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
}

function secretBytes(secret: string): Uint8Array {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try { return b64decode(raw); } catch { throw new SvixAuthError("RESEND_WEBHOOK_SECRET is not a valid whsec_ base64 secret"); }
}

async function svixSign(secret: string, id: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretBytes(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64encode(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ts}.${body}`)));
}

/** Header value as Resend/Svix would send it (tests and documentation). */
export async function signSvix(secret: string, id: string, body: string, ts = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${await svixSign(secret, id, String(ts), body)}` };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Fails closed when the secret is absent. Returns the svix-id (idempotency key). */
export async function verifySvix(secret: string | undefined, body: string, headers: Headers, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!secret) throw new SvixAuthError("Resend webhook secret not configured (RESEND_WEBHOOK_SECRET)");
  const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sig = headers.get("svix-signature");
  if (!id || !ts || !sig) throw new SvixAuthError("Missing svix-id, svix-timestamp or svix-signature header");
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id) || !/^\d{1,12}$/.test(ts)) throw new SvixAuthError("Malformed svix headers");
  if (Math.abs(nowSeconds - Number(ts)) > SVIX_TOLERANCE_SECONDS) throw new SvixAuthError("Signature timestamp outside tolerance");
  const expected = await svixSign(secret, id, ts, body);
  const ok = sig.split(" ").some((part) => {
    const [version, value] = part.split(",", 2);
    return version === "v1" && typeof value === "string" && constantTimeEqual(value, expected);
  });
  if (!ok) throw new SvixAuthError("Signature mismatch");
  return id;
}

export const HANDLED_EVENTS = ["email.sent", "email.delivered", "email.bounced", "email.complained", "email.delivery_delayed", "email.failed", "email.suppressed"] as const;

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const s = (o: Obj, k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);

export interface EventOutcome { duplicate: boolean; outcome: "applied" | "ignored" | "unmatched"; suppressed?: string[] }

/** Adds (or keeps) an active suppression. Returns true when a new one was created. */
export async function addSuppression(db: Db, email: string, reason: "hard_bounce" | "complaint", detail: string | null, sourceEventId: string | null): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e) || e.length > 254) return false;
  const id = newId("sup");
  const res = await db.prepare(`INSERT INTO email_suppressions (id, email, reason, detail, source_event_id, created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(email) WHERE removed_at IS NULL DO NOTHING`).bind(id, e, reason, detail?.slice(0, 500) ?? null, sourceEventId, nowIso()).run();
  if (res.meta.changes === 1) {
    await audit(db, { actorKind: "webhook", action: "email.suppression_added", subjectType: "email_suppression", subjectId: id, details: { reason, event: sourceEventId } });
    return true;
  }
  return false;
}

/** Handles one verified Resend event, exactly once per svix-id. */
/**
 * Environment isolation: Resend webhooks are per account, so this endpoint may receive the other environment's
 * events. Our sends carry the tag environment=<ENVIRONMENT> (src/adapters/email.ts). An event tagged for another
 * environment is acknowledged and recorded without recipient or message id, and changes nothing. Staging also
 * ignores untagged events (it only ever sends tagged mail); production applies untagged ones (e.g. mail sent from
 * the Resend dashboard), because a missed production bounce is worse than a stray one.
 */
export function eventIsForeign(data: Record<string, unknown>, environment: string | undefined): boolean {
  if (!environment) return false;
  const tags = data.tags;
  let tag: string | null = null;
  if (tags && typeof tags === "object" && !Array.isArray(tags)) {
    const v = (tags as Record<string, unknown>).environment;
    tag = typeof v === "string" ? v : null;
  } else if (Array.isArray(tags)) {
    const t = tags.find((x) => x && typeof x === "object" && (x as Record<string, unknown>).name === "environment") as Record<string, unknown> | undefined;
    tag = typeof t?.value === "string" ? (t.value as string) : null;
  }
  if (tag === null) return environment === "staging";
  return tag !== environment;
}

export async function handleResendEvent(db: Db, svixId: string, raw: string, environment?: string): Promise<EventOutcome> {
  const json = obj(JSON.parse(raw));
  const type = s(json, "type") ?? "unknown";
  const data = obj(json.data);
  if (eventIsForeign(data, environment)) {
    const claim = await db.prepare(`INSERT INTO email_webhook_events (svix_id, type, provider_message_id, delivery_id, recipient, outcome, event_created_at, received_at)
        VALUES (?,?,NULL,NULL,NULL,'ignored',?,?) ON CONFLICT(svix_id) DO NOTHING`).bind(svixId, type.slice(0, 60), s(json, "created_at"), nowIso()).run();
    return { duplicate: claim.meta.changes !== 1, outcome: "ignored" };
  }
  const messageId = s(data, "email_id");
  const recipients = (Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : []).filter((x): x is string => typeof x === "string").slice(0, 50);
  const delivery = messageId ? await db.prepare(`SELECT id, status, to_email FROM email_deliveries WHERE provider_message_id = ?`).bind(messageId).first<{ id: string; status: string; to_email: string }>() : null;
  const handled = (HANDLED_EVENTS as readonly string[]).includes(type);
  const outcome: EventOutcome["outcome"] = !handled ? "ignored" : delivery || type === "email.bounced" || type === "email.complained" ? "applied" : "unmatched";
  const claim = await db.prepare(`INSERT INTO email_webhook_events (svix_id, type, provider_message_id, delivery_id, recipient, outcome, event_created_at, received_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(svix_id) DO NOTHING`)
    .bind(svixId, type.slice(0, 60), messageId, delivery?.id ?? null, (delivery?.to_email ?? recipients[0] ?? null), outcome, s(json, "created_at"), nowIso()).run();
  if (claim.meta.changes !== 1) {
    const prev = await db.prepare(`SELECT outcome FROM email_webhook_events WHERE svix_id = ?`).bind(svixId).first<{ outcome: EventOutcome["outcome"] }>();
    return { duplicate: true, outcome: prev?.outcome ?? "ignored" };
  }
  if (!handled) return { duplicate: false, outcome };

  const at = nowIso();
  const setStatus = async (to: string, onlyFrom: string[], note?: string | null) => {
    if (!delivery) return;
    await db.prepare(`UPDATE email_deliveries SET status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ? AND status IN (${onlyFrom.map(() => "?").join(",")})`)
      .bind(to, note ?? null, at, delivery.id, ...onlyFrom).run();
  };
  const suppressed: string[] = [];
  const targets = delivery ? [delivery.to_email] : recipients;
  let detail: string | null = null;
  switch (type) {
    case "email.sent": await setStatus("sent", ["queued", "failed"]); break;
    case "email.delivered": await setStatus("delivered", ["queued", "sent", "failed"]); break;
    case "email.delivery_delayed":
      detail = "Delivery delayed by the recipient's mail server (temporary); Resend keeps retrying.";
      if (delivery) await db.prepare(`UPDATE email_deliveries SET last_error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','sent')`).bind(detail, at, delivery.id).run();
      break;
    case "email.failed": await setStatus("failed", ["queued", "sent"], `Resend reported the send failed${s(obj(data.failed), "reason") ? `: ${s(obj(data.failed), "reason")}` : ""}`); break;
    case "email.suppressed": await setStatus("suppressed", ["queued", "sent"], "Resend suppressed this message (address on Resend's suppression list)."); break;
    case "email.bounced": {
      const b = obj(data.bounce);
      const permanent = s(b, "type") === "Permanent";
      detail = `Bounce ${s(b, "type") ?? "unknown"}${s(b, "subType") ? `/${s(b, "subType")}` : ""}: ${(s(b, "message") ?? "").slice(0, 300)}`;
      if (permanent) {
        await setStatus("bounced", ["queued", "sent", "delivered", "failed"], detail);
        for (const t of targets) if (await addSuppression(db, t, "hard_bounce", detail, svixId)) suppressed.push(t.toLowerCase());
      } else {
        await setStatus("failed", ["queued", "sent"], detail);
      }
      break;
    }
    case "email.complained":
      detail = "Recipient marked the message as spam.";
      if (delivery) await db.prepare(`UPDATE email_deliveries SET last_error = ?, updated_at = ? WHERE id = ?`).bind(detail, at, delivery.id).run();
      for (const t of targets) if (await addSuppression(db, t, "complaint", detail, svixId)) suppressed.push(t.toLowerCase());
      break;
  }
  if (detail) await db.prepare(`UPDATE email_webhook_events SET detail = ? WHERE svix_id = ?`).bind(detail.slice(0, 500), svixId).run();
  return { duplicate: false, outcome, suppressed };
}

export interface SuppressionRow { id: string; email: string; reason: string; detail: string | null; created_at: string; removed_at: string | null; removed_by_name: string | null; removal_note: string | null }

export async function listSuppressions(db: Db, f: { includeRemoved: boolean; q?: string; limit: number; offset: number }): Promise<SuppressionRow[]> {
  const where: string[] = [], binds: unknown[] = [];
  if (!f.includeRemoved) where.push("s.removed_at IS NULL");
  if (f.q) { where.push("s.email LIKE ?"); binds.push(`%${f.q.toLowerCase().replace(/[%_]/g, "")}%`); }
  return (await db.prepare(`SELECT s.id, s.email, s.reason, s.detail, s.created_at, s.removed_at, u.display_name AS removed_by_name, s.removal_note
      FROM email_suppressions s LEFT JOIN users u ON u.id = s.removed_by ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, f.limit + 1, f.offset).all<SuppressionRow>()).results;
}

export class SuppressionError extends Error {}

/** Staff removal (e.g. the customer fixed their mailbox). Keeps the history row; audited. */
export async function removeSuppression(db: Db, id: string, userId: string, note: string): Promise<string> {
  const n = note.trim();
  if (n.length < 5 || n.length > 500) throw new SuppressionError("Explain why the suppression is being removed (5–500 characters).");
  const row = await db.prepare(`SELECT email FROM email_suppressions WHERE id = ? AND removed_at IS NULL`).bind(id).first<{ email: string }>();
  if (!row) throw new SuppressionError("That suppression does not exist or was already removed.");
  await db.prepare(`UPDATE email_suppressions SET removed_at = ?, removed_by = ?, removal_note = ? WHERE id = ? AND removed_at IS NULL`).bind(nowIso(), userId, n, id).run();
  await audit(db, { actorUserId: userId, action: "email.suppression_removed", subjectType: "email_suppression", subjectId: id, details: { note: n } });
  return row.email;
}

export async function recentEmailEvents(db: Db, limit = 20) {
  return (await db.prepare(`SELECT svix_id, type, recipient, outcome, detail, received_at FROM email_webhook_events ORDER BY received_at DESC, rowid DESC LIMIT ?`).bind(limit)
    .all<{ svix_id: string; type: string; recipient: string | null; outcome: string; detail: string | null; received_at: string }>()).results;
}
