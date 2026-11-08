// Internal operational email (Founder directive 2026-11-08): every internal notification goes to ONE mailbox,
// crestmontwebsitedevelopment@gmail.com, through the existing mailer (Resend outside development, the development
// outbox otherwise). Customer-facing recipients are never replaced by this address; this is only for messages meant for
// Crestmont itself.
//
// Every send carries an idempotency key built from the event (e.g. the Stripe event or appointment id), so a retried
// job or a duplicate webhook never produces a second email. What happened to each message (queued, accepted by the
// provider, delivered, bounced, suppressed) is recorded in email_deliveries like any other email.
import type { Env } from "../app/context.ts";
import { sendMail, type MailerCtx, type MailSpec, type SendMail, type TemplateData } from "./mailer.ts";

export const INTERNAL_NOTIFY_EMAIL = "crestmontwebsitedevelopment@gmail.com";

/** The internal operations mailbox. INTERNAL_NOTIFY_EMAIL in the environment may point a test environment elsewhere. */
export const internalNotifyEmail = (env?: { INTERNAL_NOTIFY_EMAIL?: string } | null) =>
  (env?.INTERNAL_NOTIFY_EMAIL?.trim() || INTERNAL_NOTIFY_EMAIL).toLowerCase();

export type InternalKind = "paid_order" | "appointment" | "founder_callback" | "support_escalation" | "refund_request" | "dispute" | "automation_failure" | "launch_blocker";

/**
 * Sends one internal notification. `key` must identify the business event (not the attempt), so repeats are no-ops.
 * Returns what the mailer returned; never throws for a provider problem (the mailer queues for retry).
 */
export async function sendInternalNotification(
  mail: MailerCtx & { env?: Partial<Pick<Env, "INTERNAL_NOTIFY_EMAIL">> | null },
  kind: InternalKind,
  key: string,
  data: TemplateData["internal_alert"],
) {
  return sendInternalTemplate(mail, kind, key, { template: "internal_alert", data });
}

/**
 * The same internal mailbox and the same idempotency key as sendInternalNotification, for an internal event whose
 * staff template carries more detail than internal_alert (e.g. founder_appointment). Because the key is shared, one
 * business event can never produce both a detailed email and an internal_alert.
 */
export async function sendInternalTemplate(
  mail: MailerCtx & { env?: Partial<Pick<Env, "INTERNAL_NOTIFY_EMAIL">> | null },
  kind: InternalKind,
  key: string,
  spec: MailSpec,
) {
  return sendMail(mail, { ...spec, to: internalNotifyEmail(mail.env ?? null), idempotencyKey: internalNotifyKey(kind, key) } as SendMail);
}

/** The idempotency key every internal notification for one business event uses. */
export const internalNotifyKey = (kind: InternalKind, key: string) => `internal:${kind}:${key}`.slice(0, 300);
