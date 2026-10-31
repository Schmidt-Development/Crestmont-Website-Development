// Customer profile self-service (CREST-GAP-073) and the dismissible two-factor reminder for customer administrators
// (CREST-GAP-072). Logic lives in src/services/account-profile.ts.
//   GET  /account/profile                 edit display name; request an email change; see / cancel a pending change
//   POST /account/profile                 save display name
//   POST /account/email                   request an email change (current password required)
//   POST /account/email/cancel            cancel a pending change
//   GET  /account/email/confirm?token=    confirmation page (the link in the mail; GET never changes anything)
//   POST /account/email/confirm           apply the change
//   POST /portal/notices/mfa-reminder/dismiss
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, type SafeHtml } from "../lib/html.ts";
import { htmlResponse, redirect, str } from "../app/http.ts";
import { requireCustomerOrg } from "../app/app.ts";
import { appLayout, authLayout } from "../ui/layout.ts";
import { alert, actionForm, button, csrf, formErrors, input, linkButton, pageHead } from "../ui/components.ts";
import { portalNav } from "./nav.ts";
import * as prof from "../services/account-profile.ts";

function page(ctx: AppContext, title: string, body: SafeHtml, status = 200): Response {
  return htmlResponse(ctx, appLayout(ctx, { title, nav: portalNav(ctx), home: "/portal", area: "Customer portal" }, body), status);
}

async function profilePage(ctx: AppContext, errors: string[] = [], status = 200, v: Record<string, string> = {}): Promise<Response> {
  requireCustomerOrg(ctx);
  const u = ctx.user!;
  const pending = await prof.pendingEmailChange(ctx.db, u.id);
  return page(ctx, "Profile", html`${pageHead("Profile", linkButton("Account & security", "/account", "ghost", "sm"), "Your account")}
${formErrors(errors)}
<div class="grid grid-2"><section class="card"><h2 class="card__title">Your name</h2>
<form method="post" action="/account/profile">${csrf(ctx)}${input({ name: "display_name", label: "Display name", value: v.display_name ?? u.displayName, required: true, maxlength: 100, autocomplete: "name", hint: "Shown to the Crestmont team and your colleagues on messages and approvals." })}
<div class="form-actions">${button("Save name", { variant: "secondary" })}</div></form></section>
<section class="card"><h2 class="card__title">Email address</h2><p>Current: <strong>${u.email}</strong></p>
${pending ? html`${alert("info", html`A change to <strong>${pending.new_email}</strong> is waiting for confirmation (requested ${formatDateTime(pending.created_at)}, link valid until ${formatDateTime(pending.expires_at)}). Your current address keeps working until the new one is confirmed.`)}
${actionForm(ctx, "/account/email/cancel", "Cancel this change", { variant: "ghost" })}` : ""}
<form method="post" action="/account/email">${csrf(ctx)}${input({ name: "new_email", label: "New email address", type: "email", value: v.new_email ?? "", required: true, maxlength: 254, autocomplete: "email" })}
${input({ name: "current_password", label: "Current password", type: "password", required: true, autocomplete: "current-password", hint: "We send a confirmation link to the new address and tell your current address. Nothing changes until you confirm." })}
<div class="form-actions">${button("Send confirmation link", { variant: "secondary" })}</div></form></section></div>
<p class="faint"><a href="/account/privacy">Privacy &amp; your data</a> — download your data or request deletion.</p>`, status);
}

const errorText = (e: unknown) => (e instanceof prof.ProfileError ? e : null);

export function register(r: Router): void {
  r.get("/account/profile", (ctx) => profilePage(ctx));
  r.post("/account/profile", async (ctx) => {
    requireCustomerOrg(ctx);
    const name = str(await ctx.form(), "display_name");
    try { await prof.updateDisplayName(ctx.db, ctx.user!.id, name, ctx.ip); }
    catch (e) { const pe = errorText(e); if (pe) return profilePage(ctx, [pe.message], pe.status, { display_name: name }); throw e; }
    return redirect(ctx, "/account/profile", { kind: "success", text: "Name saved." });
  });
  r.post("/account/email", async (ctx) => {
    requireCustomerOrg(ctx);
    const f = await ctx.form();
    const newEmail = str(f, "new_email");
    try { await prof.requestEmailChange(ctx, ctx.user!.id, newEmail, String(f.get("current_password") ?? "")); }
    catch (e) { const pe = errorText(e); if (pe) return profilePage(ctx, [pe.message], pe.status, { new_email: newEmail }); throw e; }
    return redirect(ctx, "/account/profile", { kind: "success", text: "If that address can be used, a confirmation link is on its way to it. We also told your current address. Nothing changes until you confirm." });
  });
  r.post("/account/email/cancel", async (ctx) => {
    requireCustomerOrg(ctx);
    const cancelled = await prof.cancelEmailChange(ctx.db, ctx.user!.id, ctx.ip);
    return redirect(ctx, "/account/profile", { kind: cancelled ? "success" : "info", text: cancelled ? "Email change cancelled. The link no longer works." : "There was no pending email change." });
  });
  // Confirmation: the GET shows a button so link scanners and prefetchers never apply the change.
  r.get("/account/email/confirm", async (ctx) => {
    const token = (ctx.url.searchParams.get("token") ?? "").slice(0, 200);
    const req = await prof.emailChangeByToken(ctx.db, token);
    if (!req) {
      return htmlResponse(ctx, authLayout(ctx, { title: "Link not valid" }, html`<h1 style="font-size:2rem">This link is not valid</h1>
${alert("error", "This confirmation link is invalid, already used, cancelled or expired. Request the change again from your profile page.")}<p><a href="/account/profile">Profile</a></p>`), 404);
    }
    return htmlResponse(ctx, authLayout(ctx, { title: "Confirm new email" }, html`<h1 style="font-size:2rem">Confirm your new email address</h1>
<p>Use <strong>${req.new_email}</strong> for signing in and notifications from now on. Other signed-in sessions will be signed out.</p>
<form method="post" action="/account/email/confirm">${csrf(ctx)}<input type="hidden" name="token" value="${token}">${button("Confirm new email")}</form>`));
  });
  r.post("/account/email/confirm", async (ctx) => {
    const token = str(await ctx.form(), "token").slice(0, 200);
    try {
      const keep = ctx.user && ctx.sessionId ? ctx.sessionId : null;
      const res = await prof.confirmEmailChange(ctx, token, keep);
      const signedInAsOwner = !!ctx.user && ctx.user.id === res.userId;
      return redirect(ctx, signedInAsOwner ? "/account/profile" : "/login", { kind: "success", text: `Your email address is now ${res.newEmail}.${signedInAsOwner ? "" : " Sign in with it."}` });
    } catch (e) {
      const pe = errorText(e);
      if (pe) return htmlResponse(ctx, authLayout(ctx, { title: "Could not change email" }, html`<h1 style="font-size:2rem">Email not changed</h1>${alert("error", pe.message)}<p><a href="/account/profile">Profile</a></p>`), pe.status);
      throw e;
    }
  });

  // CREST-GAP-072
  r.post("/portal/notices/mfa-reminder/dismiss", async (ctx) => {
    requireCustomerOrg(ctx);
    await prof.dismissMfaReminder(ctx.db, ctx.user!.id, ctx.ip);
    return redirect(ctx, "/portal", { kind: "info", text: "Reminder hidden. You can set up two-factor authentication any time from Account & security." });
  });
}

/** Dashboard notice for customer administrators without two-factor authentication (CREST-GAP-072). */
export async function mfaReminder(ctx: AppContext, org: { role: string }): Promise<SafeHtml> {
  if (!ctx.user || !(await prof.shouldShowMfaReminder(ctx.db, ctx.user, org.role))) return html``;
  return html`<div class="alert alert--warn" role="status" data-mfa-reminder><strong>Protect your account with two-factor authentication.</strong> As an account administrator you approve scope and pay invoices, so we recommend a second sign-in step. It takes about a minute with an authenticator app.
<div class="row" style="margin-top:.5rem">${linkButton("Set up two-factor authentication", "/mfa/setup", "primary", "sm")}${actionForm(ctx, "/portal/notices/mfa-reminder/dismiss", "Not now", { variant: "ghost" })}</div></div>`;
}

