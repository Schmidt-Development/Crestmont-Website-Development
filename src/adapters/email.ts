// Transactional email (EMAIL-001..003). Two adapters:
//  - ResendEmail: real delivery through the Resend API (requires RESEND_API_KEY + verified domain).
//  - OutboxEmail: development only; renders and stores the message so flows can be exercised and
//    inspected. Outbox rows are status 'queued' with provider 'dev-outbox' and are never reported
//    as sent or delivered.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";

export interface EmailMessage { to: string; subject: string; html: string; text: string; template: string; idempotencyKey: string }
export interface EmailResult { deliveryId: string; status: "queued" | "sent" | "failed" | "duplicate"; provider: "resend" | "dev-outbox" }

export interface EmailAdapter {
  readonly kind: "resend" | "dev-outbox";
  send(msg: EmailMessage): Promise<EmailResult>;
}

async function insertDelivery(db: Db, msg: EmailMessage, provider: "resend" | "dev-outbox"): Promise<string | null> {
  const id = newId("em");
  const at = nowIso();
  const res = await db.prepare(
    `INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, attempts, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 0, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
  ).bind(id, msg.template, msg.to, msg.idempotencyKey, at, at).run();
  if (res.meta.changes !== 1) return null;
  await db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES (?,?,?,?,?)`)
    .bind(id, provider, msg.subject, msg.html, msg.text).run();
  return id;
}

export class OutboxEmail implements EmailAdapter {
  readonly kind = "dev-outbox" as const;
  private db: Db;
  constructor(db: Db) { this.db = db; }
  async send(msg: EmailMessage): Promise<EmailResult> {
    const id = await insertDelivery(this.db, msg, "dev-outbox");
    if (!id) return { deliveryId: "", status: "duplicate", provider: this.kind };
    return { deliveryId: id, status: "queued", provider: this.kind };
  }
}

export class ResendEmail implements EmailAdapter {
  readonly kind = "resend" as const;
  private db: Db; private apiKey: string; private from: string; private fetchImpl: typeof fetch;
  constructor(db: Db, apiKey: string, from: string, fetchImpl: typeof fetch = fetch) {
    this.db = db; this.apiKey = apiKey; this.from = from; this.fetchImpl = fetchImpl;
  }
  async send(msg: EmailMessage): Promise<EmailResult> {
    const id = await insertDelivery(this.db, msg, "resend");
    if (!id) return { deliveryId: "", status: "duplicate", provider: this.kind };
    return this.attempt(id, msg);
  }
  async attempt(id: string, msg: EmailMessage): Promise<EmailResult> {
    try {
      const r = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": msg.idempotencyKey },
        body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!r.ok) throw new Error(`Resend ${r.status}: ${body.message ?? "error"}`);
      await this.db.prepare(`UPDATE email_deliveries SET status='sent', provider_message_id=?, attempts=attempts+1, updated_at=? WHERE id=?`)
        .bind(body.id ?? null, nowIso(), id).run();
      return { deliveryId: id, status: "sent", provider: this.kind };
    } catch (e) {
      await this.db.prepare(`UPDATE email_deliveries SET status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END, attempts=attempts+1, last_error=?, updated_at=? WHERE id=?`)
        .bind((e as Error).message.slice(0, 1000), nowIso(), id).run();
      return { deliveryId: id, status: "failed", provider: this.kind };
    }
  }
}
