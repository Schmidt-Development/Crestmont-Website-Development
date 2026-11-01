// Transactional notifications: an outbox written with the business change (deduplicated), delivered by the
// scheduled handler through the CUSTOMER's own mail provider (Resend: RESEND_API_KEY + MAIL_FROM as Worker secrets).
// Without a provider nothing is sent and nothing is reported as sent: messages stay 'queued'.
import { CONFIG } from "./config.js";
import { all, run, nowIso } from "./db.js";
import { newId } from "./crypto.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const TEMPLATES = {
  booking_confirmed: (p) => ({ subject: `Booking confirmed: ${p.serviceName} (${p.reference})`, text: `Hello ${p.name},\n\nYour booking ${p.reference} for ${p.serviceName} on ${p.when} is confirmed.\nManage or cancel it here: ${p.manageUrl}\n\n${CONFIG.business?.name ?? ""}` }),
  booking_received: (p) => ({ subject: `Booking request received: ${p.reference}`, text: `Hello ${p.name},\n\nWe received your booking ${p.reference} for ${p.serviceName} on ${p.when}. ${p.paymentRequired ? "It is confirmed once the payment is completed." : ""}\nManage it here: ${p.manageUrl}\n\n${CONFIG.business?.name ?? ""}` }),
  booking_cancelled: (p) => ({ subject: `Booking cancelled: ${p.reference}`, text: `Hello ${p.name},\n\nYour booking ${p.reference} on ${p.when} has been cancelled.\n\n${CONFIG.business?.name ?? ""}` }),
  booking_rescheduled: (p) => ({ subject: `Booking moved: ${p.reference}`, text: `Hello ${p.name},\n\nYour booking ${p.reference} is now on ${p.when}.\nManage it here: ${p.manageUrl}\n\n${CONFIG.business?.name ?? ""}` }),
  staff_new_booking: (p) => ({ subject: `New booking ${p.reference}: ${p.serviceName}`, text: `${p.name} (${p.email}) booked ${p.serviceName} on ${p.when}.` }),
  staff_new_quote: (p) => ({ subject: `New quote request ${p.reference}`, text: `${p.name} (${p.email}${p.phone ? `, ${p.phone}` : ""}) asked for a quote${p.serviceName ? ` for ${p.serviceName}` : ""}.\n\n${p.details}` }),
  quote_received: (p) => ({ subject: `We received your quote request (${p.reference})`, text: `Hello ${p.name},\n\nThank you. We received your request ${p.reference} and will contact you soon.\n\n${CONFIG.business?.name ?? ""}` }),
  staff_new_contact: (p) => ({ subject: `New message from ${p.name}`, text: `${p.name} (${p.email}) wrote:\n\n${p.message}` }),
  payment_received: (p) => ({ subject: `Payment received for ${p.reference}`, text: `Hello ${p.name},\n\nWe received your payment of ${p.amount} for booking ${p.reference}.\n\n${CONFIG.business?.name ?? ""}` }),
};

/** Statement that queues one message (use inside the same batch as the business change). */
export function queueStmt(env, dedupeKey, to, template, payload) {
  if (!TEMPLATES[template]) throw new Error(`unknown template ${template}`);
  return env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, dedupe_key, to_address, template, payload_json, status, created_at) VALUES (?,?,?,?,?, 'queued', ?)`)
    .bind(newId("ntf"), dedupeKey, to, template, JSON.stringify(payload), nowIso(env));
}

export const mailConfigured = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

/** Deliver queued messages (scheduled handler). Bounded retries; failures are recorded, never hidden. */
export async function processOutbox(env, fetchImpl = fetch, limit = 20) {
  if (!mailConfigured(env)) return { sent: 0, failed: 0, skipped: "mail provider not configured (RESEND_API_KEY and MAIL_FROM on the customer's account)" };
  let sent = 0, failed = 0;
  for (const n of await all(env.DB, `SELECT * FROM notifications WHERE status = 'queued' AND attempts < 5 ORDER BY created_at LIMIT ?`, limit)) {
    const t = TEMPLATES[n.template](JSON.parse(n.payload_json));
    try {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": n.id },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [n.to_address], subject: t.subject, text: t.text, html: `<pre style="font:inherit;white-space:pre-wrap">${esc(t.text)}</pre>` }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { await run(env.DB, `UPDATE notifications SET status = 'sent', attempts = attempts + 1, provider_message_id = ?, sent_at = ?, last_error = NULL WHERE id = ?`, String(body.id ?? ""), nowIso(env), n.id); sent++; }
      else { await run(env.DB, `UPDATE notifications SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'queued' END, last_error = ? WHERE id = ?`, `provider answered ${res.status}`, n.id); failed++; }
    } catch (e) {
      await run(env.DB, `UPDATE notifications SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'queued' END, last_error = ? WHERE id = ?`, String(e?.message ?? e).slice(0, 200), n.id);
      failed++;
    }
  }
  return { sent, failed };
}
