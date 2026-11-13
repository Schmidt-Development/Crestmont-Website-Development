// Transactional email (EMAIL-001..003). Two adapters:
//  - ResendEmail: real delivery through the Resend API (requires RESEND_API_KEY + verified domain).
//  - OutboxEmail: development only; renders and stores the message so flows can be exercised and
//    inspected. Outbox rows are status 'queued' with provider 'dev-outbox' and are never reported
//    as sent or delivered.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";

/**
 * Crestmont's departmental mailboxes (Owner, 2026-11-13 — locked; never consolidate). Every customer email is sent from
 * support@ under the business name; Reply-To sends the customer's answer to the department the message is about:
 * billing@ for invoices, payments, subscriptions and refunds, sales@ for quotes, proposals and sales follow-ups, support@
 * for everything else. legal@ is the address agreements and policies name for legal notices (src/services/agreements.ts).
 */
export const MAILBOXES = {
  support: "support@crestmontwebsitedevelopment.com",
  sales: "sales@crestmontwebsitedevelopment.com",
  billing: "billing@crestmontwebsitedevelopment.com",
  legal: "legal@crestmontwebsitedevelopment.com",
} as const;
export const DEFAULT_EMAIL_FROM = `Crestmont Website Development <${MAILBOXES.support}>`;
const BILLING_TEMPLATES = new Set(["receipt", "invoice", "failed_payment", "subscription_update", "refund_request", "refund_decision", "dispute_opened"]);
const SALES_TEMPLATES = new Set(["quote_sent", "proposal_accepted", "sales_info", "lead_received", "consultation", "voice_followup"]);
/** The Reply-To mailbox for a template (see MAILBOXES). */
export function replyToFor(template: string): string {
  if (BILLING_TEMPLATES.has(template)) return MAILBOXES.billing;
  if (SALES_TEMPLATES.has(template)) return MAILBOXES.sales;
  return MAILBOXES.support;
}

export interface EmailMessage { to: string; subject: string; html: string; text: string; template: string; idempotencyKey: string }
export interface EmailResult { deliveryId: string; status: "queued" | "sent" | "failed" | "duplicate" | "suppressed"; provider: "resend" | "dev-outbox" }

export interface EmailAdapter {
  readonly kind: "resend" | "dev-outbox";
  send(msg: EmailMessage): Promise<EmailResult>;
}

/**
 * EMAIL-003: active suppression (hard bounce / spam complaint recorded from Resend webhooks, see
 * src/services/email-events.ts). Applies to every template, security notices included: a hard-bounced
 * address cannot receive mail anyway and a complainant has asked not to be mailed. The delivery row is
 * kept with status 'suppressed' and the reason in last_error so staff can see why it was not sent.
 */
async function suppressionReason(db: Db, to: string): Promise<string | null> {
  try {
    const row = await db.prepare(`SELECT reason, created_at FROM email_suppressions WHERE email = ? AND removed_at IS NULL`).bind(to.trim().toLowerCase()).first<{ reason: string; created_at: string }>();
    return row ? `Not sent: recipient suppressed (${row.reason === "complaint" ? "spam complaint" : "hard bounce"} recorded ${row.created_at.slice(0, 10)}). Remove the suppression in Email operations to resume.` : null;
  } catch { return null; } // legacy databases without migration 0012
}

async function insertDelivery(db: Db, msg: EmailMessage, provider: "resend" | "dev-outbox"): Promise<{ id: string; suppressed: boolean } | null> {
  const id = newId("em");
  const at = nowIso();
  const suppressed = await suppressionReason(db, msg.to);
  const res = await db.prepare(
    `INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, attempts, last_error, created_at, updated_at)
     VALUES (?,?,?,?,?, 0, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
  ).bind(id, msg.template, msg.to, msg.idempotencyKey, suppressed ? "suppressed" : "queued", suppressed, at, at).run();
  if (res.meta.changes !== 1) return null;
  await db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES (?,?,?,?,?)`)
    .bind(id, provider, msg.subject, msg.html, msg.text).run();
  return { id, suppressed: !!suppressed };
}

export class OutboxEmail implements EmailAdapter {
  readonly kind = "dev-outbox" as const;
  private db: Db;
  constructor(db: Db) { this.db = db; }
  async send(msg: EmailMessage): Promise<EmailResult> {
    const d = await insertDelivery(this.db, msg, "dev-outbox");
    if (!d) return { deliveryId: "", status: "duplicate", provider: this.kind };
    return { deliveryId: d.id, status: d.suppressed ? "suppressed" : "queued", provider: this.kind };
  }
}

/**
 * Which recipients may receive real mail (EMAIL-001, INFRA-002). Never: reserved names that cannot receive mail
 * (RFC 2606 / 6761: .test, .invalid, .example, .localhost, example.com/.net/.org) — sending to them only produces
 * bounces against the sending domain. On staging, additionally only the allowlist: EMAIL_RECIPIENT_ALLOWLIST is a
 * comma-separated list of exact addresses and/or "@domain" entries; unset, it defaults to "@crestmontwebsitedevelopment.com".
 * Staging is test data (demo accounts, sample customers), so it must never mail anyone outside that list.
 */
const RESERVED = /(\.(test|invalid|example|localhost)|@example\.(com|net|org)|\.example\.(com|net|org))$/i;
export const DEFAULT_STAGING_ALLOWLIST = "@crestmontwebsitedevelopment.com";
/** Same default as src/services/internal-notify.ts (kept here so the adapter does not depend on services). */
const INTERNAL_MAILBOX = "crestmontwebsitedevelopment@gmail.com";
/** Resend's own test inboxes (https://resend.com/docs/dashboard/emails/send-test-emails): they accept mail and answer with
 *  a delivered, bounced or complained event without reaching a person or harming the domain's reputation. Every
 *  environment may mail them, so delivery can be certified end to end (src/services/email-certification.ts). */
export const RESEND_TEST_INBOX = /^(delivered|bounced|complained)(\+[a-z0-9._-]{1,80})?@resend\.dev$/;
export function recipientPolicy(env: { ENVIRONMENT: string; EMAIL_RECIPIENT_ALLOWLIST?: string; INTERNAL_NOTIFY_EMAIL?: string }): (to: string) => string | null {
  // The internal operations mailbox (Founder directive 2026-11-08) is Crestmont's own inbox, not a customer: staging
  // may always mail it, so internal notifications can be verified end to end before production.
  const internal = (env.INTERNAL_NOTIFY_EMAIL?.trim() || INTERNAL_MAILBOX).toLowerCase();
  const entries = [...(env.EMAIL_RECIPIENT_ALLOWLIST ?? DEFAULT_STAGING_ALLOWLIST).split(","), internal].map((x) => x.trim().toLowerCase()).filter(Boolean);
  return (toRaw: string) => {
    const to = toRaw.trim().toLowerCase();
    if (RESERVED.test(to)) return "Not sent: reserved test address that cannot receive mail.";
    if (RESEND_TEST_INBOX.test(to)) return null;
    if (env.ENVIRONMENT !== "production" && !entries.some((e) => (e.startsWith("@") ? to.endsWith(e) : to === e)))
      return "Not sent: staging only mails addresses on EMAIL_RECIPIENT_ALLOWLIST (staging holds test data).";
    return null;
  };
}

export class ResendEmail implements EmailAdapter {
  readonly kind = "resend" as const;
  private db: Db; private apiKey: string; private from: string; private fetchImpl: typeof fetch;
  private blocked: (to: string) => string | null;
  private environment: string | null;
  /**
   * `environment` is sent as the Resend tag `environment=<staging|production>`. Resend webhooks are configured per
   * account, so one environment's endpoint can receive the other's events; the receiver ignores events whose tag
   * names another environment (src/services/email-events.ts), keeping each database to its own recipients.
   */
  constructor(db: Db, apiKey: string, from: string, fetchImpl: typeof fetch = fetch, blocked: (to: string) => string | null = () => null, environment: string | null = null) {
    this.db = db; this.apiKey = apiKey; this.from = from; this.fetchImpl = fetchImpl; this.blocked = blocked; this.environment = environment;
  }
  async send(msg: EmailMessage): Promise<EmailResult> {
    // A recipient outside the policy is recorded in the outbox (never sent, never reported delivered).
    const reason = this.blocked(msg.to);
    if (reason) {
      const o = await insertDelivery(this.db, msg, "dev-outbox");
      if (!o) return { deliveryId: "", status: "duplicate", provider: "dev-outbox" };
      await this.db.prepare(`UPDATE email_deliveries SET last_error = COALESCE(last_error, ?) WHERE id = ?`).bind(reason, o.id).run();
      return { deliveryId: o.id, status: o.suppressed ? "suppressed" : "queued", provider: "dev-outbox" };
    }
    const d = await insertDelivery(this.db, msg, "resend");
    if (!d) return { deliveryId: "", status: "duplicate", provider: this.kind };
    if (d.suppressed) return { deliveryId: d.id, status: "suppressed", provider: this.kind };
    return this.attempt(d.id, msg);
  }
  async attempt(id: string, msg: EmailMessage): Promise<EmailResult> {
    const blocked = this.blocked(msg.to);
    if (blocked) {
      await this.db.prepare(`UPDATE email_deliveries SET last_error=?, updated_at=? WHERE id=?`).bind(blocked, nowIso(), id).run();
      return { deliveryId: id, status: "failed", provider: this.kind };
    }
    // A suppression added after the message was queued also blocks retries.
    const suppressed = await suppressionReason(this.db, msg.to);
    if (suppressed) {
      await this.db.prepare(`UPDATE email_deliveries SET status='suppressed', last_error=?, updated_at=? WHERE id=?`).bind(suppressed, nowIso(), id).run();
      return { deliveryId: id, status: "suppressed", provider: this.kind };
    }
    try {
      const r = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": msg.idempotencyKey },
        body: JSON.stringify({ from: this.from, reply_to: replyToFor(msg.template), to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
          ...(this.environment ? { tags: [{ name: "environment", value: this.environment }] } : {}) }),
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
