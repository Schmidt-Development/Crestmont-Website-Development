// Sign-in, registration, verification, MFA, password reset, invitations, account (AUTH-001..006).
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html } from "../lib/html.ts";
import { cookie, htmlResponse, isSecure, redirect, str } from "../app/http.ts";
import { authLayout, appLayout } from "../ui/layout.ts";
import { csrf, input, button, formErrors, alert, table, actionForm, badge, checkbox } from "../ui/components.ts";
import * as auth from "../services/auth.ts";
import { requireUser } from "../app/app.ts";
import { sendMail } from "../services/mailer.ts";
import { otpauthUri } from "../lib/auth-crypto.ts";
import { formatDateTime, label } from "../lib/html.ts";
import { HttpError } from "../app/http.ts";
import { portalNav } from "./nav.ts";
import { staffNav } from "./nav.ts";
import { recordAcceptance } from "../services/agreements.ts";

const safeNext = (n: string | null, fallback: string) => (n && n.startsWith("/") && !n.startsWith("//") ? n : fallback);

function sessionCookie(ctx: AppContext, token: string, maxAge: number) {
  return cookie("cm_session", token, { maxAge, secure: isSecure(ctx), httpOnly: true, sameSite: "Lax" });
}

function loginPage(ctx: AppContext, errors: string[] = [], email = "") {
  const next = ctx.url.searchParams.get("next") ?? "";
  return htmlResponse(ctx, authLayout(ctx, { title: "Sign in" }, html`<h1 style="font-size:2rem">Sign in</h1>
${formErrors(errors)}
<form method="post" action="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">${csrf(ctx)}
${input({ name: "email", label: "Email", type: "email", value: email, autocomplete: "email", required: true })}
${input({ name: "password", label: "Password", type: "password", autocomplete: "current-password", required: true })}
<div class="form-actions">${button("Sign in")}<a class="btn btn--ghost" href="/password/forgot">Forgot password?</a></div></form>
<hr><p class="muted">New to Crestmont? <a href="/register">Create an account</a></p>`), errors.length ? 400 : 200);
}

function registerPage(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Create account" }, html`<h1 style="font-size:2rem">Create your account</h1>
<p class="muted">Use your account to purchase a package, accept a quote, and manage your project.</p>${formErrors(errors)}
<form method="post" action="/register">${csrf(ctx)}
${input({ name: "name", label: "Your name", value: v.name, autocomplete: "name", required: true })}
${input({ name: "organization", label: "Business name", value: v.organization, autocomplete: "organization", required: true })}
${input({ name: "email", label: "Email", type: "email", value: v.email, autocomplete: "email", required: true })}
${input({ name: "password", label: "Password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters." })}
${checkbox("terms", "I agree to the Terms of Service and Privacy Policy.", { required: true })}
<p class="faint" style="font-size:.8rem"><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a></p>
<div class="form-actions">${button("Create account")}</div></form>
<hr><p class="muted">Already have an account? <a href="/login">Sign in</a></p>`), errors.length ? 400 : 200);
}

export function register(r: Router) {
  r.get("/login", (ctx) => (ctx.user && ctx.sessionMfaVerified ? redirect(ctx, ctx.user.isStaff ? "/staff" : "/portal") : loginPage(ctx)));
  r.post("/login", async (ctx) => {
    const f = await ctx.form();
    const email = str(f, "email");
    try {
      const res = await auth.login(ctx.db, email, String(f.get("password") ?? ""), { ip: ctx.ip, userAgent: ctx.req.headers.get("user-agent") });
      ctx.setCookies.push(sessionCookie(ctx, res.sessionToken, res.maxAge));
      const next = safeNext(ctx.url.searchParams.get("next"), "");
      if (res.mfaRequired) return redirect(ctx, `/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}`);
      const roles = (await ctx.db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(res.userId).all<{ role_id: string }>()).results;
      return redirect(ctx, next || (roles.some((x) => !x.role_id.startsWith("customer_")) ? "/staff" : "/portal"));
    } catch (e) {
      if (e instanceof auth.AuthError) return loginPage(ctx, [e.message], email);
      throw e;
    }
  });

  r.post("/logout", async (ctx) => {
    if (ctx.sessionId && ctx.user) await auth.revokeSession(ctx.db, ctx.sessionId, ctx.user.id);
    ctx.setCookies.push(cookie("cm_session", "", { maxAge: 0, secure: isSecure(ctx) }));
    return redirect(ctx, "/", { kind: "info", text: "You are signed out." });
  });

  r.get("/register", (ctx) => registerPage(ctx));
  r.post("/register", async (ctx) => {
    const f = await ctx.form();
    const v = { name: str(f, "name"), organization: str(f, "organization"), email: str(f, "email") };
    const errors: string[] = [];
    if (v.name.length < 2) errors.push("Enter your name");
    if (v.organization.length < 2) errors.push("Enter your business name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.push("Enter a valid email address");
    if (!f.get("terms")) errors.push("You must accept the Terms of Service and Privacy Policy");
    if (errors.length) return registerPage(ctx, errors, v);
    try {
      const res = await auth.registerCustomer(ctx.db, { email: v.email, name: v.name, password: String(f.get("password") ?? ""), organizationName: v.organization }, ctx.ip);
      if (res.verifyToken) {
        await sendMail(ctx, { template: "verification", to: v.email.toLowerCase(), subject: "Confirm your email — Crestmont", heading: "Confirm your email address", idempotencyKey: `verify:${res.userId}:${res.verifyToken.slice(0, 8)}`,
          paragraphs: [`Hello ${v.name}, thank you for creating a Crestmont account.`, "Confirm your email address to finish setting up your account. This link expires in 48 hours."],
          cta: { label: "Confirm email", url: `${ctx.baseUrl}/verify-email?token=${res.verifyToken}` } });
        await recordTermsAcceptance(ctx, res.userId, res.organizationId!);
      }
      return htmlResponse(ctx, authLayout(ctx, { title: "Check your email" }, html`<h1 style="font-size:2rem">Check your email</h1>
<p>If this address can be used, we have sent a confirmation link to <strong>${v.email}</strong>. Follow it to activate your account, then sign in.</p><p><a href="/login">Go to sign in</a></p>`));
    } catch (e) {
      if (e instanceof auth.AuthError) return registerPage(ctx, [e.message], v);
      throw e;
    }
  });

  r.get("/verify-email", async (ctx) => {
    const token = ctx.url.searchParams.get("token") ?? "";
    try {
      await auth.verifyEmail(ctx.db, token);
      return redirect(ctx, "/login", { kind: "success", text: "Email confirmed. You can sign in now." });
    } catch (e) {
      if (e instanceof auth.AuthError) return htmlResponse(ctx, authLayout(ctx, { title: "Link expired" }, html`<h1 style="font-size:2rem">Link not valid</h1><p>${e.message}</p><p><a href="/login">Sign in</a> to request a new confirmation email.</p>`), 400);
      throw e;
    }
  });

  r.post("/verify-email/resend", async (ctx) => {
    requireUser(ctx);
    if (!ctx.user!.emailVerified) {
      const token = await auth.newEmailVerifyToken(ctx.db, ctx.user!.id);
      await sendMail(ctx, { template: "verification", to: ctx.user!.email, subject: "Confirm your email — Crestmont", heading: "Confirm your email address", idempotencyKey: `verify:${ctx.user!.id}:${token.slice(0, 8)}`,
        paragraphs: ["Confirm your email address to finish setting up your account. This link expires in 48 hours."], cta: { label: "Confirm email", url: `${ctx.baseUrl}/verify-email?token=${token}` } });
    }
    return redirect(ctx, "/portal", { kind: "info", text: "If your email is unconfirmed, a new link is on its way." });
  });

  // ── MFA ──
  r.get("/mfa", async (ctx) => {
    requireUser(ctx);
    const next = ctx.url.searchParams.get("next") ?? "";
    if (ctx.sessionMfaVerified) return redirect(ctx, safeNext(next, ctx.user!.isStaff ? "/staff" : "/portal"));
    if (!ctx.user!.mfaEnabled) return redirect(ctx, `/mfa/setup${next ? `?next=${encodeURIComponent(next)}` : ""}`);
    return mfaChallenge(ctx);
  });
  r.post("/mfa", async (ctx) => {
    requireUser(ctx);
    const f = await ctx.form();
    try {
      await auth.completeMfa(ctx.db, ctx.sessionId!, ctx.user!.id, str(f, "code").replace(/\s/g, ""), ctx.ip);
      return redirect(ctx, safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/portal"));
    } catch (e) {
      if (e instanceof auth.AuthError) return mfaChallenge(ctx, [e.message]);
      throw e;
    }
  });
  r.get("/mfa/setup", async (ctx) => {
    requireUser(ctx);
    if (ctx.user!.mfaEnabled && !ctx.sessionMfaVerified) return redirect(ctx, "/mfa");
    const secret = await auth.beginTotpEnrollment(ctx.db, ctx.user!.id);
    return mfaSetup(ctx, secret);
  });
  r.post("/mfa/setup", async (ctx) => {
    requireUser(ctx);
    const f = await ctx.form();
    try {
      await auth.confirmTotpEnrollment(ctx.db, ctx.user!.id, ctx.sessionId!, str(f, "code").replace(/\s/g, ""));
      await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, subject: "Two-factor authentication enabled", heading: "Two-factor authentication is on", idempotencyKey: `mfa-on:${ctx.user!.id}:${Date.now()}`,
        paragraphs: ["Two-factor authentication was enabled on your Crestmont account. If this was not you, reset your password immediately and contact support."] });
      return redirect(ctx, safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/account"), { kind: "success", text: "Two-factor authentication is enabled." });
    } catch (e) {
      if (e instanceof auth.AuthError) {
        const row = await ctx.db.prepare(`SELECT totp_pending_secret FROM users WHERE id = ?`).bind(ctx.user!.id).first<{ totp_pending_secret: string }>();
        return mfaSetup(ctx, row?.totp_pending_secret ?? "", [e.message]);
      }
      throw e;
    }
  });

  // ── Password reset ──
  r.get("/password/forgot", (ctx) => htmlResponse(ctx, authLayout(ctx, { title: "Reset password" }, html`<h1 style="font-size:2rem">Reset your password</h1>
<form method="post" action="/password/forgot">${csrf(ctx)}${input({ name: "email", label: "Email", type: "email", autocomplete: "email", required: true })}<div class="form-actions">${button("Send reset link")}</div></form>`)));
  r.post("/password/forgot", async (ctx) => {
    const f = await ctx.form();
    const res = await auth.requestPasswordReset(ctx.db, str(f, "email"), ctx.ip);
    if (res) {
      await sendMail(ctx, { template: "password_reset", to: str(f, "email").toLowerCase(), subject: "Reset your Crestmont password", heading: "Reset your password", idempotencyKey: `reset:${res.userId}:${res.token.slice(0, 8)}`,
        paragraphs: ["Someone asked to reset the password for this account. If that was you, use the link below within one hour.", "If you did not ask for this, you can ignore this email."],
        cta: { label: "Choose a new password", url: `${ctx.baseUrl}/password/reset?token=${res.token}` } });
    }
    return htmlResponse(ctx, authLayout(ctx, { title: "Check your email" }, html`<h1 style="font-size:2rem">Check your email</h1><p>If an account exists for that address, a reset link has been sent. It expires in one hour.</p>`));
  });
  r.get("/password/reset", (ctx) => resetPage(ctx));
  r.post("/password/reset", async (ctx) => {
    const f = await ctx.form();
    try {
      await auth.resetPassword(ctx.db, str(f, "token"), String(f.get("password") ?? ""), ctx.ip);
      return redirect(ctx, "/login", { kind: "success", text: "Password updated. Sign in with your new password." });
    } catch (e) {
      if (e instanceof auth.AuthError) return resetPage(ctx, [e.message], str(f, "token"));
      throw e;
    }
  });

  // ── Invitations ──
  r.get("/invite", async (ctx) => {
    const token = ctx.url.searchParams.get("token") ?? "";
    const inv = /^[0-9a-f]{64}$/.test(token) ? await auth.invitationByToken(ctx.db, token) : null;
    if (!inv || inv.accepted_at || inv.expires_at < new Date().toISOString()) return htmlResponse(ctx, authLayout(ctx, { title: "Invitation" }, html`<h1 style="font-size:2rem">Invitation not valid</h1><p>This invitation has expired or was already used. Ask the person who invited you to send a new one.</p>`), 400);
    return invitePage(ctx, token, inv.email, inv.org_name, inv.role_id);
  });
  r.post("/invite", async (ctx) => {
    const f = await ctx.form();
    const token = str(f, "token");
    try {
      await auth.acceptInvitation(ctx.db, token, str(f, "name"), String(f.get("password") ?? ""));
      return redirect(ctx, "/login", { kind: "success", text: "Invitation accepted. Sign in to continue — you will set up two-factor authentication next." });
    } catch (e) {
      if (e instanceof auth.AuthError) {
        const inv = await auth.invitationByToken(ctx.db, token);
        return inv ? invitePage(ctx, token, inv.email, inv.org_name, inv.role_id, [e.message]) : redirect(ctx, "/login", { kind: "error", text: e.message });
      }
      throw e;
    }
  });

  // ── Account & sessions ──
  r.get("/account", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const sessions = (await ctx.db.prepare(`SELECT id, ip, user_agent, created_at, expires_at, revoked_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20`)
      .bind(ctx.user!.id, new Date().toISOString()).all<{ id: string; ip: string | null; user_agent: string | null; created_at: string; expires_at: string }>()).results;
    const body = html`<div class="page-head"><h1>Account</h1></div>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Profile</h2><p>${ctx.user!.displayName}<br><span class="muted">${ctx.user!.email}</span> ${ctx.user!.emailVerified ? badge("verified", "Email verified") : badge("pending", "Email not confirmed")}</p>
${ctx.user!.memberships.map((m) => html`<p class="faint">${m.organizationName} · ${label(m.role)}</p>`)}</section>
<section class="card"><h2 class="card__title">Two-factor authentication</h2>
${ctx.user!.mfaEnabled ? html`<p>${badge("active", "Enabled")} Codes from your authenticator app are required at sign-in.</p>` : html`<p class="muted">${ctx.user!.isStaff ? "Required for staff." : "Optional for customers, and recommended."}</p><a class="btn btn--secondary" href="/mfa/setup">Set up two-factor authentication</a>`}</section></div>
<section class="card" style="margin-top:1.5rem"><h2 class="card__title">Change password</h2>
<form method="post" action="/account/password">${csrf(ctx)}<div class="grid grid-2">${input({ name: "current", label: "Current password", type: "password", autocomplete: "current-password", required: true })}${input({ name: "next", label: "New password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters. Other sessions will be signed out." })}</div>${button("Update password", { variant: "secondary" })}</form></section>
<section style="margin-top:1.5rem"><div class="row row--between"><h2 style="font-size:1.5rem;margin:0">Active sessions</h2>${actionForm(ctx, "/account/sessions/revoke-others", "Sign out all other sessions", { variant: "danger", confirm: "Sign out every other session?" })}</div>
${table(sessions, [
  { header: "Started", cell: (s) => formatDateTime(s.created_at) },
  { header: "IP", cell: (s) => s.ip ?? "—" },
  { header: "Device", cell: (s) => (s.user_agent ?? "—").slice(0, 70) },
  { header: "", cell: (s) => s.id === ctx.sessionId ? badge("active", "This session") : actionForm(ctx, `/account/sessions/${s.id}/revoke`, "Revoke", { variant: "ghost" }) },
])}</section>`;
    const nav = ctx.user!.isStaff ? staffNav : portalNav;
    return htmlResponse(ctx, appLayout(ctx, { title: "Account", nav: nav(ctx), home: ctx.user!.isStaff ? "/staff" : "/portal", area: ctx.user!.isStaff ? "Crestmont staff" : "Customer portal" }, body));
  });
  r.post("/account/password", async (ctx) => {
    requireUser(ctx);
    const f = await ctx.form();
    try {
      await auth.changePassword(ctx.db, ctx.user!.id, String(f.get("current") ?? ""), String(f.get("next") ?? ""), ctx.sessionId!);
      await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, subject: "Your password was changed", heading: "Password changed", idempotencyKey: `pw:${ctx.user!.id}:${Date.now()}`, paragraphs: ["The password for your Crestmont account was changed and other sessions were signed out. If this was not you, reset your password now."] });
      return redirect(ctx, "/account", { kind: "success", text: "Password updated. Other sessions were signed out." });
    } catch (e) {
      if (e instanceof auth.AuthError) return redirect(ctx, "/account", { kind: "error", text: e.message });
      throw e;
    }
  });
  r.post("/account/sessions/:id/revoke", async (ctx, p) => {
    requireUser(ctx);
    const own = await ctx.db.prepare(`SELECT id FROM sessions WHERE id = ? AND user_id = ?`).bind(p.id, ctx.user!.id).first();
    if (!own) throw new HttpError(404, "Session not found");
    await auth.revokeSession(ctx.db, p.id, ctx.user!.id);
    return redirect(ctx, "/account", { kind: "success", text: "Session revoked." });
  });
  r.post("/account/sessions/revoke-others", async (ctx) => {
    requireUser(ctx);
    await auth.revokeAllSessions(ctx.db, ctx.user!.id, ctx.sessionId, ctx.user!.id);
    return redirect(ctx, "/account", { kind: "success", text: "All other sessions were signed out." });
  });
}

async function recordTermsAcceptance(ctx: AppContext, userId: string, organizationId: string) {
  // LEGAL-003: records the exact Terms of Service + Privacy Policy versions shown at registration.
  await recordAcceptance(ctx, { userId, organizationId, context: "registration" });
}

function mfaChallenge(ctx: AppContext, errors: string[] = []) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Verification code" }, html`<h1 style="font-size:2rem">Enter your code</h1><p class="muted">Open your authenticator app and enter the 6-digit code for Crestmont.</p>${formErrors(errors)}
<form method="post" action="/mfa${ctx.url.search}">${csrf(ctx)}${input({ name: "code", label: "6-digit code", autocomplete: "one-time-code", inputmode: "numeric", required: true, maxlength: 7 })}<div class="form-actions">${button("Verify")}</div></form>`), errors.length ? 401 : 200);
}

function mfaSetup(ctx: AppContext, secret: string, errors: string[] = []) {
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;
  return htmlResponse(ctx, authLayout(ctx, { title: "Set up two-factor authentication" }, html`<h1 style="font-size:2rem">Set up two-factor authentication</h1>
${ctx.user!.isStaff ? alert("info", "Two-factor authentication is required for Crestmont staff accounts.") : ""}
<ol class="muted"><li>Open an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator).</li><li>Add an account using this setup key, or open the link on a phone that has the app.</li><li>Enter the 6-digit code it shows.</li></ol>
<p><span class="label">Setup key</span><br><code style="font-size:1.1rem;letter-spacing:.08em;color:var(--gold-1)" data-testid="totp-secret">${grouped}</code></p>
<p><a href="${otpauthUri(secret, ctx.user!.email)}">Open in authenticator app</a></p>${formErrors(errors)}
<form method="post" action="/mfa/setup${ctx.url.search}">${csrf(ctx)}${input({ name: "code", label: "6-digit code", autocomplete: "one-time-code", inputmode: "numeric", required: true, maxlength: 7 })}<div class="form-actions">${button("Turn on")}</div></form>`), errors.length ? 400 : 200);
}

function resetPage(ctx: AppContext, errors: string[] = [], token = ctx.url.searchParams.get("token") ?? "") {
  return htmlResponse(ctx, authLayout(ctx, { title: "Choose a new password" }, html`<h1 style="font-size:2rem">Choose a new password</h1>${formErrors(errors)}
<form method="post" action="/password/reset">${csrf(ctx)}<input type="hidden" name="token" value="${token}">${input({ name: "password", label: "New password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters." })}<div class="form-actions">${button("Update password")}</div></form>`), errors.length ? 400 : 200);
}

function invitePage(ctx: AppContext, token: string, email: string, org: string, role: string, errors: string[] = []) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Accept invitation" }, html`<h1 style="font-size:2rem">Join ${org}</h1><p class="muted">You have been invited as <strong>${label(role)}</strong> using <strong>${email}</strong>.</p>${formErrors(errors)}
<form method="post" action="/invite">${csrf(ctx)}<input type="hidden" name="token" value="${token}">${input({ name: "name", label: "Your name", autocomplete: "name", required: true })}${input({ name: "password", label: "Choose a password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters." })}<div class="form-actions">${button("Accept invitation")}</div></form>`), errors.length ? 400 : 200);
}
