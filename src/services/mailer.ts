// Branded transactional templates (EMAIL-002). Content is minimal: no passwords, no full card
// data, no internal notes. Links point back into the authenticated portal for details.
import { escapeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";

export const EMAIL_TEMPLATES = [
  "registration", "verification", "purchase", "receipt", "onboarding", "project_update", "approval_request",
  "revision_update", "change_order", "invoice", "failed_payment", "subscription_update", "support_ticket",
  "support_reply", "refund_request", "refund_decision", "project_completion", "handoff", "security_notification",
  "critical_incident", "password_reset", "staff_invitation", "quote_sent", "lead_received",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface Mail { template: EmailTemplate; to: string; subject: string; heading: string; paragraphs: string[]; cta?: { label: string; url: string }; idempotencyKey: string }

export function renderMail(m: Mail): { html: string; text: string } {
  const p = m.paragraphs.map((x) => `<p style="margin:0 0 16px;line-height:1.6;color:#e8e4d8">${escapeHtml(x)}</p>`).join("");
  const cta = m.cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(m.cta.url)}" style="display:inline-block;background:#c9a54c;color:#0b0b0c;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:600">${escapeHtml(m.cta.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#0b0b0c;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#141416;border:1px solid #3a3222">
<tr><td style="padding:28px 32px;border-bottom:1px solid #3a3222;color:#c9a54c;font-size:20px;letter-spacing:.08em">CRESTMONT</td></tr>
<tr><td style="padding:32px;font-family:Helvetica,Arial,sans-serif;font-size:15px">
<h1 style="margin:0 0 20px;font-family:Georgia,serif;font-weight:normal;color:#fff;font-size:24px">${escapeHtml(m.heading)}</h1>${p}${cta}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #3a3222;color:#8d887c;font-family:Helvetica,Arial,sans-serif;font-size:12px">Crestmont Website Development · This is a transactional message about your account or project.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [m.heading, "", ...m.paragraphs, ...(m.cta ? ["", `${m.cta.label}: ${m.cta.url}`] : []), "", "— Crestmont Website Development"].join("\n");
  return { html, text };
}

export async function sendMail(ctx: Pick<AppContext, "email">, m: Mail) {
  const { html, text } = renderMail(m);
  return ctx.email.send({ to: m.to, subject: m.subject, html, text, template: m.template, idempotencyKey: m.idempotencyKey });
}
