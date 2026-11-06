// Sign-in, registration, verification, MFA, password reset, invitations, account (AUTH-001..006).
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html } from "../lib/html.ts";
import { cookie, hostCookieName, htmlResponse, isSecure, parseCookies, redirect, str } from "../app/http.ts";
import { authLayout, appLayout } from "../ui/layout.ts";
import { csrf, input, button, formErrors, alert, table, actionForm, badge, checkbox } from "../ui/components.ts";
import * as auth from "../services/auth.ts";
import { requireUser } from "../app/app.ts";
import { sendMail } from "../services/mailer.ts";
import { otpauthUri } from "../lib/auth-crypto.ts";
import { formatDateTime, label } from "../lib/html.ts";
import { HttpError } from "../app/http.ts";
import { securityEvent } from "../services/security.ts";
import { portalNav } from "./nav.ts";
import { staffNav } from "./nav.ts";
import { recordAcceptance } from "../services/agreements.ts";
import { verifyTurnstile } from "./api.ts";
import { turnstileWidget } from "./public.ts";
import { safeNextPath } from "../app/step-up.ts";

/** Same-origin relative redirect target only (rejects //host, /\host, absolute URLs and control characters). */
const safeNext = (n: string | null, fallback: string) => safeNextPath(n, fallback);
const BOT_CHECK_FAILED = "We could not verify that this request came from a person. Please try again.";

/** New session token once the second factor is complete (CREST-GAP-086). */
async function rotateSessionCookie(ctx: AppContext) {
  const r = await auth.rotateSessionToken(ctx.db, ctx.sessionId!);
  if (r) ctx.setCookies.push(sessionCookie(ctx, r.token, r.maxAge));
}

/** The remembered-device cookie for abuse-resistant sign-in (CREST-GAP-003). */
function deviceCookieValue(ctx: AppContext): string | null {
  const v = parseCookies(ctx.req.headers.get("cookie"))[auth.DEVICE_COOKIE];
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
}
async function setDeviceCookie(ctx: AppContext, userId: string, existing: string | null) {
  const token = await auth.rememberDevice(ctx.db, userId, existing);
  if (token !== existing) ctx.setCookies.push(cookie(auth.DEVICE_COOKIE, token, { maxAge: auth.DEVICE_MAX_AGE_S, secure: isSecure(ctx), httpOnly: true, sameSite: "Lax" }));
}
/** Whether this sign-in passed the bot challenge. Without a configured widget, development cannot show the challenge,
 *  so it counts as passed there; elsewhere an unconfigured or failed challenge never passes. */
async function signInChallengePassed(ctx: AppContext, token: FormDataEntryValue | null): Promise<boolean> {
  if (!ctx.env.TURNSTILE_SITE_KEY && !ctx.env.TURNSTILE_SECRET && ctx.env.ENVIRONMENT === "development") return true;
  if (typeof token !== "string" || !token) return false;
  return verifyTurnstile(ctx, token);
}

function sessionCookie(ctx: AppContext, token: string, maxAge: number) {
  return cookie(hostCookieName("cm_session", isSecure(ctx)), token, { maxAge, secure: isSecure(ctx), httpOnly: true, sameSite: "Lax" });
}

function loginPage(ctx: AppContext, errors: string[] = [], email = "", status?: number) {
  const next = ctx.url.searchParams.get("next") ?? "";
  return htmlResponse(ctx, authLayout(ctx, { title: "Sign in", description: "Sign in to the Crestmont customer portal to follow your project, approvals, files, invoices and support requests." }, html`<h1 style="font-size:2rem">Sign in</h1>
${formErrors(errors)}
<form method="post" action="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">${csrf(ctx)}
${input({ name: "email", label: "Email", type: "email", value: email, autocomplete: "email", required: true })}
${input({ name: "password", label: "Password", type: "password", autocomplete: "current-password", required: true })}
${turnstileWidget(ctx)}
<div class="form-actions">${button("Sign in")}<a class="btn btn--ghost" href="/password/forgot">Forgot password?</a></div></form>
<hr><p class="muted">New to Crestmont? <a href="/register">Create an account</a></p>`), status ?? (errors.length ? 400 : 200));
}

function registerPage(ctx: AppContext, errors: string[] = [], v: Record<string, string> = {}, status?: number) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Create account", description: "Create a Crestmont customer account to buy a website package and follow your project in the customer portal." }, html`<h1 style="font-size:2rem">Create your account</h1>
<p class="muted">Use your account to purchase a package, accept a quote, and manage your project.</p>${formErrors(errors)}
<form method="post" action="/register">${csrf(ctx)}
${input({ name: "name", label: "Your name", value: v.name, autocomplete: "name", required: true })}
${input({ name: "organization", label: "Business name", value: v.organization, autocomplete: "organization", required: true })}
${input({ name: "email", label: "Email", type: "email", value: v.email, autocomplete: "email", required: true })}
${input({ name: "password", label: "Password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters." })}
${checkbox("terms", "I agree to the Terms of Service and Privacy Policy.", { required: true })}
<p class="faint" style="font-size:.8rem"><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a></p>
${turnstileWidget(ctx)}
<div class="form-actions">${button("Create account")}</div></form>
<hr><p class="muted">Already have an account? <a href="/login">Sign in</a></p>`), status ?? (errors.length ? 400 : 200));
}

export function register(r: Router) {
  r.get("/login", (ctx) => (ctx.user && ctx.sessionMfaVerified ? redirect(ctx, ctx.user.isStaff ? "/staff" : "/portal") : loginPage(ctx)));
  r.post("/login", async (ctx) => {
    const f = await ctx.form();
    const email = str(f, "email");
    try {
      const deviceToken = deviceCookieValue(ctx);
      const res = await auth.login(ctx.db, email, String(f.get("password") ?? ""), { ip: ctx.ip, userAgent: ctx.req.headers.get("user-agent"), deviceToken, challengePassed: await signInChallengePassed(ctx, f.get("cf-turnstile-response")) });
      ctx.setCookies.push(sessionCookie(ctx, res.sessionToken, res.maxAge));
      // A device is remembered only after a COMPLETE sign-in: here when no second factor is needed, else after /mfa.
      if (!res.mfaRequired) await setDeviceCookie(ctx, res.userId, deviceToken);
      const next = safeNext(ctx.url.searchParams.get("next"), "");
      if (res.mfaRequired) return redirect(ctx, `/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}`);
      const roles = (await ctx.db.prepare(`SELECT role_id FROM memberships WHERE user_id = ?`).bind(res.userId).all<{ role_id: string }>()).results;
      return redirect(ctx, next || (roles.some((x) => !x.role_id.startsWith("customer_")) ? "/staff" : "/portal"));
    } catch (e) {
      if (e instanceof auth.LoginFailed && e.notifyEmail) {
        // Once per 15-minute window per account: the holder learns that strangers are guessing (CREST-GAP-003, -085).
        await sendMail(ctx, { template: "security_notification", to: e.notifyEmail, idempotencyKey: `signin-attempts:${e.notifyUserId}:${Math.floor(Date.now() / 900e3)}`, data: { event: "sign_in_attempts" } });
      }
      if (e instanceof auth.SignInChallengeRequired) return loginPage(ctx, [e.message], email, 403);
      if (e instanceof auth.AuthError) return loginPage(ctx, [e.message], email);
      throw e;
    }
  });

  r.post("/logout", async (ctx) => {
    if (ctx.sessionId && ctx.user) await auth.revokeSession(ctx.db, ctx.sessionId, ctx.user.id);
    ctx.setCookies.push(cookie("cm_session", "", { maxAge: 0, secure: isSecure(ctx) }));
    if (isSecure(ctx)) ctx.setCookies.push(cookie(hostCookieName("cm_session", true), "", { maxAge: 0, secure: true }));
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
    // Bot protection (docs/AUTH-PRODUCTION.md gap 4): same Turnstile check as the public lead forms; fails closed
    // outside development without TURNSTILE_SECRET (staging uses Cloudflare's always-pass test keys).
    if (!(await verifyTurnstile(ctx, f.get("cf-turnstile-response")))) {
      await securityEvent(ctx.db, "bot_check_failed", { ip: ctx.ip, detail: "register" });
      return registerPage(ctx, [BOT_CHECK_FAILED], v, 400);
    }
    try {
      await auth.assertPasswordNotBreached(ctx.env, ctx.db, String(f.get("password") ?? ""));
      const res = await auth.registerCustomer(ctx.db, { email: v.email, name: v.name, password: String(f.get("password") ?? ""), organizationName: v.organization }, ctx.ip);
      if (res.verifyToken) {
        await sendMail(ctx, { template: "verification", to: v.email.toLowerCase(), idempotencyKey: `verify:${res.userId}:${res.verifyToken.slice(0, 8)}`,
          data: { name: v.name, confirmUrl: `${ctx.baseUrl}/verify-email?token=${res.verifyToken}` } });
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
      await sendMail(ctx, { template: "verification", to: ctx.user!.email, idempotencyKey: `verify:${ctx.user!.id}:${token.slice(0, 8)}`,
        data: { name: null, confirmUrl: `${ctx.baseUrl}/verify-email?token=${token}` } });
    }
    return redirect(ctx, "/portal", { kind: "info", text: "If your email is unconfirmed, a new link is on its way." });
  });

  // ── MFA ──
  // MFA removed (Founder directive, 2026-11-06). These addresses stay so old links and bookmarks land somewhere
  // sensible: each sends the signed-in user on to where they were going, and nobody is asked for a code.
  const onward = (ctx: AppContext) => {
    requireUser(ctx);
    return redirect(ctx, safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/portal"));
  };
  for (const path of ["/mfa", "/mfa/setup", "/mfa/step-up"]) {
    r.get(path, async (ctx) => onward(ctx));
    r.post(path, async (ctx) => onward(ctx));
  }

  // ── Account & sessions ──
  r.get("/account", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const sessions = (await ctx.db.prepare(`SELECT id, ip, user_agent, created_at, expires_at, revoked_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20`)
      .bind(ctx.user!.id, new Date().toISOString()).all<{ id: string; ip: string | null; user_agent: string | null; created_at: string; expires_at: string }>()).results;
    const body = html`<div class="page-head"><h1>Account</h1></div>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Profile</h2><p>${ctx.user!.displayName}<br><span class="muted">${ctx.user!.email}</span> ${ctx.user!.emailVerified ? badge("verified", "Email verified") : badge("pending", "Email not confirmed")}</p>
${ctx.user!.memberships.map((m) => html`<p class="faint">${m.organizationName} · ${label(m.role)}</p>`)}
<p data-account-links>${ctx.user!.isStaff ? "" : html`<a href="/account/profile">Edit name or email</a> · `}<a href="/account/privacy">Privacy &amp; your data</a> — download your data or request deletion.</p></section>
<section class="card"><h2 class="card__title">Sign-in</h2><p class="muted">You sign in with your email address and password. Keep your password private; changing it signs out your other sessions.</p></section></div>
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
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const f = await ctx.form();
    try {
      await auth.assertPasswordNotBreached(ctx.env, ctx.db, String(f.get("next") ?? ""));
      await auth.changePassword(ctx.db, ctx.user!.id, String(f.get("current") ?? ""), String(f.get("next") ?? ""), ctx.sessionId!);
      await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, idempotencyKey: `pw:${ctx.user!.id}:${Date.now()}`, data: { event: "password_changed" } });
      return redirect(ctx, "/account", { kind: "success", text: "Password updated. Other sessions were signed out." });
    } catch (e) {
      if (e instanceof auth.AuthError) return redirect(ctx, "/account", { kind: "error", text: e.message });
      throw e;
    }
  });
  r.post("/account/sessions/:id/revoke", async (ctx, p) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    const own = await ctx.db.prepare(`SELECT id FROM sessions WHERE id = ? AND user_id = ?`).bind(p.id, ctx.user!.id).first();
    if (!own) throw new HttpError(404, "Session not found");
    await auth.revokeSession(ctx.db, p.id, ctx.user!.id);
    return redirect(ctx, "/account", { kind: "success", text: "Session revoked." });
  });
  r.post("/account/sessions/revoke-others", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    await auth.revokeAllSessions(ctx.db, ctx.user!.id, ctx.sessionId, ctx.user!.id);
    return redirect(ctx, "/account", { kind: "success", text: "All other sessions were signed out." });
  });
}

async function recordTermsAcceptance(ctx: AppContext, userId: string, organizationId: string) {
  // LEGAL-003: records the exact Terms of Service + Privacy Policy versions shown at registration.
  await recordAcceptance(ctx, { userId, organizationId, context: "registration" });
}

const codeField = () => input({ name: "code", label: "6-digit code", autocomplete: "one-time-code", required: true, maxlength: 20,
  hint: "Lost your authenticator? Enter one of your recovery codes instead (each works once)." });

const isCustomerAdmin = (ctx: AppContext) => !!ctx.user?.memberships.some((m) => m.role === "customer_admin");

/** Account page copy (FD-30): required for staff and customer administrators, optional for customer members. */




/** Shows freshly generated recovery codes. This response is the only place they ever appear in plaintext. */

/** After a recovery code was used: email the account owner and warn in the UI. */
async function recoveryUsed(ctx: AppContext, remaining: number): Promise<{ kind: "info" | "error"; text: string }> {
  await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, idempotencyKey: `mfa-rc-used:${ctx.user!.id}:${Date.now()}`, data: { event: "mfa_recovery_code_used" } });
  return { kind: remaining <= 2 ? "error" : "info", text: `You signed in with a recovery code. ${remaining} unused code${remaining === 1 ? "" : "s"} left — generate a new set from your account page${remaining <= 2 ? " now" : ""}.` };
}

function forgotPage(ctx: AppContext, errors: string[] = [], status?: number) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Reset password" }, html`<h1 style="font-size:2rem">Reset your password</h1>${formErrors(errors)}
<form method="post" action="/password/forgot">${csrf(ctx)}${input({ name: "email", label: "Email", type: "email", autocomplete: "email", required: true })}${turnstileWidget(ctx)}<div class="form-actions">${button("Send reset link")}</div></form>`), status ?? (errors.length ? 400 : 200));
}


function resetPage(ctx: AppContext, errors: string[] = [], token = ctx.url.searchParams.get("token") ?? "") {
  return htmlResponse(ctx, authLayout(ctx, { title: "Choose a new password" }, html`<h1 style="font-size:2rem">Choose a new password</h1>${formErrors(errors)}
<form method="post" action="/password/reset">${csrf(ctx)}<input type="hidden" name="token" value="${token}">${input({ name: "password", label: "New password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters." })}<div class="form-actions">${button("Update password")}</div></form>`), errors.length ? 400 : 200);
}

/** The signed-in user id that may accept an invitation: only a session that has completed MFA (when enabled). */
function invitationSessionUser(ctx: AppContext): string | null {
  if (!ctx.user) return null;
  if (ctx.user.mfaEnabled && !ctx.sessionMfaVerified) return null;
  return ctx.user.id;
}

function invitePage(ctx: AppContext, token: string, email: string, org: string, role: string, mode: auth.InvitationMode, errors: string[] = []) {
  const head = html`<h1 style="font-size:2rem">Join ${org}</h1><p class="muted">You have been invited as <strong>${label(role)}</strong> using <strong>${email}</strong>.</p>${formErrors(errors)}`;
  if (mode === "sign_in") {
    return htmlResponse(ctx, authLayout(ctx, { title: "Accept invitation" }, html`${head}<p>An account already uses this email address. Sign in to that account, then open the invitation link from your email again to accept it.</p><p><a class="btn" href="/login">Sign in</a></p>`), errors.length ? 403 : 200);
  }
  if (mode === "confirm") {
    return htmlResponse(ctx, authLayout(ctx, { title: "Accept invitation" }, html`${head}<p>You are signed in as <strong>${email}</strong>.</p>
<form method="post" action="/invite">${csrf(ctx)}<input type="hidden" name="token" value="${token}"><div class="form-actions">${button("Accept invitation")}</div></form>`), errors.length ? 400 : 200);
  }
  return htmlResponse(ctx, authLayout(ctx, { title: "Accept invitation" }, html`${head}
<form method="post" action="/invite">${csrf(ctx)}<input type="hidden" name="token" value="${token}">${input({ name: "name", label: "Your name", autocomplete: "name", required: true })}${input({ name: "password", label: "Choose a password", type: "password", autocomplete: "new-password", required: true, hint: "At least 12 characters." })}<div class="form-actions">${button("Accept invitation")}</div></form>`), errors.length ? 400 : 200);
}
