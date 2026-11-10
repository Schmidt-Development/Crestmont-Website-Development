// Email delivery certification (Founder, 2026-11-09). Each template is rendered from its reviewed sample (the same data
// as the Owner's template review page) and sent through THIS environment's real email adapter — Resend, the production
// sending domain and API key, the signed delivery webhook — to one of Resend's own test inboxes, never to a person.
// Each message's delivery row then records whether Resend accepted it and what its webhook reported. One extra message
// goes to Resend's bounce test inbox, which must come back "bounced" (bounce handling and suppression work).
//
// The subject carries "[Delivery check]" so a copy can never be mistaken for a real notice. Run through the signed ops
// endpoint (email-certification.yml). Real application events and their content are certified by the staging journeys.
import type { AppContext } from "../app/context.ts";
import { renderTemplate, identityFrom, EMAIL_TEMPLATES, TEMPLATES, type EmailTemplate, type TemplateDef } from "./mailer.ts";

export const CERT_RUN_ID = /^[a-z0-9-]{4,40}$/;

export interface CertSend { template: string; probe: "delivered" | "bounced"; deliveryId: string; status: string; error?: string }

/** Messages per request: each costs about five subrequests (suppression check, two inserts, the Resend call, the status
 *  update), and the Workers Free plan allows 50 per request. */
export const CERT_PART_SIZE = 6;
const plan = (): { template: EmailTemplate; probe: CertSend["probe"] }[] => [...EMAIL_TEMPLATES.map((t) => ({ template: t, probe: "delivered" as const })), { template: "internal_alert" as EmailTemplate, probe: "bounced" as const }];
export const certParts = () => Math.ceil(plan().length / CERT_PART_SIZE);

/** Sends part `part` of the run (CERT_PART_SIZE messages). A message that cannot be sent is reported with its error. */
export async function sendCertificationBatch(ctx: AppContext, runId: string, part = 0, pause = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<{ sent: CertSend[]; part: number; parts: number }> {
  if (!CERT_RUN_ID.test(runId)) throw new Error("runId must be 4-40 lowercase letters, digits or hyphens");
  const parts = certParts();
  if (!Number.isInteger(part) || part < 0 || part >= parts) throw new Error(`part must be 0-${parts - 1}`);
  const identity = identityFrom(ctx.settings);
  const sent: CertSend[] = [];
  for (const { template: t, probe } of plan().slice(part * CERT_PART_SIZE, (part + 1) * CERT_PART_SIZE)) {
    try {
      const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
      const r = renderTemplate(t, def.samples[0] as never, identity, def.category === "marketing" ? `${ctx.baseUrl}/unsubscribe/preview` : undefined);
      const res = await ctx.email.send({ to: `${probe}+${runId}-${t.replace(/_/g, "-")}@resend.dev`, subject: `[Delivery check] ${r.subject}`, html: r.html, text: r.text,
        template: t, idempotencyKey: `email-cert:${runId}:${probe}:${t}` });
      sent.push({ template: t, probe, deliveryId: res.deliveryId, status: res.status });
    } catch (e) {
      sent.push({ template: t, probe, deliveryId: "", status: "error", error: (e as Error).message.slice(0, 300) });
    }
    await pause(600); // Resend's default API rate limit is 2 requests a second
  }
  return { sent, part, parts };
}
