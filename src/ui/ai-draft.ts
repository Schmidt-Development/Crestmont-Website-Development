// Shared markup for "AI draft reply" (support tickets and customer conversations). Works without JavaScript: the
// start button is a normal form post and the page shows the draft (or its progress) after a reload. With JavaScript
// (public/assets/app.js, "AI draft replies") the same form is sent with fetch, a loading state is shown, the status
// endpoint is polled and the finished draft is placed in the editable reply field — never sent.
import type { AppContext } from "../app/context.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { csrf } from "./components.ts";
import type { DraftStatus } from "../services/ai-drafts.ts";

/** True when app.js asked for the JSON answer (fetch with `Accept: application/json`) instead of a redirect. */
export const wantsJson = (ctx: AppContext) => /\bapplication\/json\b/.test(ctx.req.headers.get("accept") ?? "");

/** The hidden ai_job_id field inside the reply form: set when a draft is in the field, empty otherwise. */
export function draftJobField(status: DraftStatus | null): SafeHtml {
  return html`<input type="hidden" name="ai_job_id" value="${status?.state === "ready" ? status.jobId : ""}" data-ai-draft-job>`;
}

/** Message shown in the status line for a draft state. */
export function draftStatusText(status: DraftStatus | null): string {
  if (!status) return "";
  if (status.state === "pending") return "Drafting a reply… The draft will appear in the reply box as soon as it is ready. Nothing is sent automatically.";
  if (status.state === "ready") return "AI draft placed in the reply box. Review and edit it — nothing is sent until you press Send.";
  if (status.state === "failed") return `AI draft unavailable: ${status.error ?? "the AI model returned an error"} Nothing was sent.`;
  return "";
}

/**
 * The AI draft controls: start/retry button, optional discard, and a live status line.
 * `target` is a CSS selector for the reply form whose `body` textarea receives the draft.
 */
export function draftControls(ctx: AppContext, o: { startAction: string; statusBase: string; target: string; status: DraftStatus | null; discardAction?: string }): SafeHtml {
  const s = o.status;
  const ready = s?.state === "ready";
  const text = draftStatusText(s);
  return html`<div class="ai-draft" data-ai-draft data-ai-draft-status-base="${o.statusBase}" data-ai-draft-target="${o.target}"${s?.state === "pending" ? html` data-ai-draft-pending="${s.jobId}"` : ""}>
<div class="ai-draft__row"><form method="post" action="${o.startAction}" data-ai-draft-start>${csrf(ctx)}<button class="btn btn--secondary btn--sm" type="submit" data-ai-draft-button>${s?.state === "failed" ? "Retry AI draft" : "AI draft reply"}</button></form>
${o.discardAction ? html`<form method="post" action="${o.discardAction}" data-ai-draft-discard${ready ? "" : html` hidden`}>${csrf(ctx)}<input type="hidden" name="ai_job_id" value="${ready ? s!.jobId : ""}"><button class="btn btn--ghost btn--sm" type="submit">Discard AI draft</button></form>` : ""}</div>
<p class="ai-draft__status" data-ai-draft-status role="status" aria-live="polite" data-state="${s?.state ?? "idle"}"${text ? "" : html` hidden`}>${text}${s?.state === "pending" ? html`<noscript> Reload this page to check.</noscript>` : ""}</p>
<p class="faint ai-draft__note">AI drafts are suggestions only and are never sent automatically.</p></div>`;
}
