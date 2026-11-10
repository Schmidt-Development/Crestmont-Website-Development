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

export interface CertSend { template: string; probe: "delivered" | "bounced"; deliveryId: string; status: string }

export async function sendCertificationBatch(ctx: AppContext, runId: string, pause = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<CertSend[]> {
  if (!CERT_RUN_ID.test(runId)) throw new Error("runId must be 4-40 lowercase letters, digits or hyphens");
  const identity = identityFrom(ctx.settings);
  const out: CertSend[] = [];
  const send = async (t: EmailTemplate, probe: CertSend["probe"]) => {
    const def = TEMPLATES[t] as TemplateDef<EmailTemplate>;
    const r = renderTemplate(t, def.samples[0] as never, identity, def.category === "marketing" ? `${ctx.baseUrl}/unsubscribe/preview` : undefined);
    const res = await ctx.email.send({ to: `${probe}+${runId}-${t.replace(/_/g, "-")}@resend.dev`, subject: `[Delivery check] ${r.subject}`, html: r.html, text: r.text,
      template: t, idempotencyKey: `email-cert:${runId}:${probe}:${t}` });
    out.push({ template: t, probe, deliveryId: res.deliveryId, status: res.status });
    await pause(600); // Resend's default API rate limit is 2 requests a second
  };
  for (const t of EMAIL_TEMPLATES) await send(t, "delivered");
  await send("internal_alert", "bounced");
  return out;
}
