// Automatic retry of queued Resend deliveries (CREST-GAP-035, EMAIL-003).
//
// A send that failed transiently stays 'queued' with attempts incremented (src/adapters/email.ts); after 5 attempts it
// becomes 'failed'. The scheduled job retries queued Resend messages with exponential backoff (5, 10, 20, 40 minutes
// after the last attempt) using the stored rendered message and the same idempotency key, so Resend never sends twice.
// Messages still queued an hour after their last attempt are "stuck": the count is reported in the job detail and the
// Owner gets at most one in-app notice per day while any are stuck. Development-outbox rows are never touched.
import type { AppContext } from "../app/context.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { EmailMessage, EmailResult } from "../adapters/email.ts";

const BASE_BACKOFF_MS = 5 * 60_000;
export const MAX_EMAIL_ATTEMPTS = 5;
const STUCK_AFTER_MS = 60 * 60_000;

export function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
}

type Retrier = { kind: "resend"; attempt(id: string, msg: EmailMessage): Promise<EmailResult> };

export async function retryQueuedEmails(ctx: Pick<AppContext, "db" | "email" | "now">): Promise<{ retried: number; sent: number; stuck: number; detail: string }> {
  const db = ctx.db;
  const now = ctx.now().getTime();
  const email = ctx.email as unknown as Partial<Retrier>;
  let retried = 0, sent = 0;
  if (email.kind === "resend" && typeof email.attempt === "function") {
    const rows = (await db.prepare(`SELECT d.id, d.template, d.to_email, d.idempotency_key, d.attempts, d.updated_at, m.subject, m.html_body, m.text_body
        FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id
        WHERE d.status = 'queued' AND m.provider = 'resend' AND d.attempts < ? AND d.updated_at <= ? ORDER BY d.updated_at LIMIT 50`)
      .bind(MAX_EMAIL_ATTEMPTS, new Date(now - BASE_BACKOFF_MS).toISOString())
      .all<{ id: string; template: string; to_email: string; idempotency_key: string; attempts: number; updated_at: string; subject: string; html_body: string; text_body: string }>()).results;
    for (const r of rows) {
      if (Date.parse(r.updated_at) + backoffMs(r.attempts) > now) continue;
      retried++;
      const res = await email.attempt.call(ctx.email, r.id, { to: r.to_email, subject: r.subject, html: r.html_body, text: r.text_body, template: r.template, idempotencyKey: r.idempotency_key });
      if (res.status === "sent") sent++;
    }
  }
  const stuck = (await db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.status = 'queued' AND m.provider = 'resend' AND d.updated_at < ?`)
    .bind(new Date(now - STUCK_AFTER_MS).toISOString()).first<{ n: number }>())?.n ?? 0;
  if (stuck > 0) {
    const day = new Date(now).toISOString().slice(0, 10);
    const owners = (await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.disabled_at IS NULL`).all<{ user_id: string }>()).results;
    for (const o of owners) {
      await db.prepare(`INSERT INTO notifications (id, user_id, kind, subject_type, subject_id, body, created_at) SELECT ?,?,'email_stuck',NULL,?,?,?
          WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'email_stuck' AND subject_id = ?)`)
        .bind(newId("ntf"), o.user_id, day, `${stuck} email${stuck === 1 ? " is" : "s are"} still queued more than an hour after the last delivery attempt. Review Email operations.`, nowIso(), o.user_id, day).run();
    }
  }
  const mode = email.kind === "resend" ? `${retried} queued deliveries retried, ${sent} sent` : "retry skipped: Resend is not configured (outbox only)";
  return { retried, sent, stuck, detail: `${mode}; ${stuck} stuck (queued > 1 h)` };
}
