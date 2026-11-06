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
      const res = await auth.completeMfa(ctx.env, ctx.db, ctx.sessionId!, ctx.user!.id, str(f, "code"), ctx.ip);
      await rotateSessionCookie(ctx);
      await setDeviceCookie(ctx, ctx.user!.id, deviceCookieValue(ctx));
      const dest = safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/portal");
      if (res.method === "recovery") return redirect(ctx, dest, await recoveryUsed(ctx, res.remaining));
      return redirect(ctx, dest);
    } catch (e) {
      if (e instanceof auth.AuthError) return mfaChallenge(ctx, [e.message], e.status === 503 ? 503 : undefined);
      throw e;
    }
  });
  r.get("/mfa/setup", async (ctx) => {
    requireUser(ctx);
    if (ctx.user!.mfaEnabled && !ctx.sessionMfaVerified) return redirect(ctx, "/mfa");
    try {
      const secret = await auth.beginTotpEnrollment(ctx.env, ctx.db, ctx.user!.id);
      return mfaSetup(ctx, secret);
    } catch (e) {
      if (e instanceof auth.AuthError) return mfaUnavailable(ctx, e.message);
      throw e;
    }
  });
  r.post("/mfa/setup", async (ctx) => {
    requireUser(ctx);
    // Same rule as GET: replacing an enrolled authenticator needs a session that already passed MFA.
    if (ctx.user!.mfaEnabled && !ctx.sessionMfaVerified) return redirect(ctx, "/mfa");
    const f = await ctx.form();
    try {
      const codes = await auth.confirmTotpEnrollment(ctx.env, ctx.db, ctx.user!.id, ctx.sessionId!, str(f, "code").replace(/\s/g, ""));
      await rotateSessionCookie(ctx);
      await setDeviceCookie(ctx, ctx.user!.id, deviceCookieValue(ctx));
      await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, idempotencyKey: `mfa-on:${ctx.user!.id}:${Date.now()}`, data: { event: "mfa_enabled" } });
      // The recovery codes are shown exactly once, in this response; only their hashes are stored.
      return recoveryCodesPage(ctx, codes, safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/account"), "Two-factor authentication is enabled");
    } catch (e) {
      if (e instanceof auth.AuthError) {
        if (e.status === 503) return mfaUnavailable(ctx, e.message);
        const pending = await auth.pendingTotpSecret(ctx.env, ctx.db, ctx.user!.id).catch(() => null);
        if (!pending) return redirect(ctx, `/mfa/setup${ctx.url.search}`, { kind: "error", text: e.message });
        return mfaSetup(ctx, pending, [e.message]);
      }
      throw e;
    }
  });

  // ── Step-up MFA (src/app/step-up.ts): a fresh TOTP or recovery code before a sensitive action ──
  r.get("/mfa/step-up", async (ctx) => {
    requireUser(ctx);
    const next = safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/account");
    if (!ctx.sessionMfaVerified) return redirect(ctx, `/mfa?next=${encodeURIComponent(next)}`);
    if (!ctx.user!.mfaEnabled) {
      return htmlResponse(ctx, authLayout(ctx, { title: "Confirm it is you" }, html`<h1 style="font-size:2rem">No second step needed</h1>
<p class="muted">Your account does not use two-factor authentication, so there is nothing to confirm. You can turn it on from your account page.</p><p><a class="btn" href="${next}">Continue</a></p>`));
    }
    return stepUpPage(ctx, next);
  });
  r.post("/mfa/step-up", async (ctx) => {
    requireUser(ctx);
    const next = safeNext(ctx.url.searchParams.get("next"), ctx.user!.isStaff ? "/staff" : "/account");
    if (!ctx.sessionMfaVerified) return redirect(ctx, `/mfa?next=${encodeURIComponent(next)}`);
    if (!ctx.user!.mfaEnabled) return redirect(ctx, next);
    const f = await ctx.form();
    try {
      const res = await auth.verifySecondFactor(ctx.env, ctx.db, ctx.sessionId!, ctx.user!.id, str(f, "code"), ctx.ip, "step_up");
      if (res.method === "recovery") return redirect(ctx, next, await recoveryUsed(ctx, res.remaining));
      return redirect(ctx, next, { kind: "success", text: "Verified. You can continue for the next 10 minutes." });
    } catch (e) {
      if (e instanceof auth.AuthError) return stepUpPage(ctx, next, [e.message], e.status === 503 ? 503 : 401);
      throw e;
    }
  });

  // ── Password reset ──
  r.get("/password/forgot", (ctx) => forgotPage(ctx));
  r.post("/password/forgot", async (ctx) => {
    const f = await ctx.form();
    // Bot protection (gap 4): Turnstile, then a per-IP limit in requestPasswordReset (the per-email limit stays).
    if (!(await verifyTurnstile(ctx, f.get("cf-turnstile-response")))) {
      await securityEvent(ctx.db, "bot_check_failed", { ip: ctx.ip, detail: "password reset" });
      return forgotPage(ctx, [BOT_CHECK_FAILED], 400);
    }
    let res: Awaited<ReturnType<typeof auth.requestPasswordReset>>;
    try {
      res = await auth.requestPasswordReset(ctx.db, str(f, "email"), ctx.ip);
    } catch (e) {
      if (e instanceof auth.AuthError) return forgotPage(ctx, [e.message], e.status);
      throw e;
    }
    if (res) {
      await sendMail(ctx, { template: "password_reset", to: str(f, "email").toLowerCase(), idempotencyKey: `reset:${res.userId}:${res.token.slice(0, 8)}`,
        data: { resetUrl: `${ctx.baseUrl}/password/reset?token=${res.token}` } });
    }
    return htmlResponse(ctx, authLayout(ctx, { title: "Check your email" }, html`<h1 style="font-size:2rem">Check your email</h1><p>If an account exists for that address, a reset link has been sent. It expires in one hour.</p>`));
  });
  r.get("/password/reset", (ctx) => resetPage(ctx));
  r.post("/password/reset", async (ctx) => {
    const f = await ctx.form();
    try {
      await auth.assertPasswordNotBreached(ctx.env, ctx.db, String(f.get("password") ?? ""));
      const resetUserId = await auth.resetPassword(ctx.db, str(f, "token"), String(f.get("password") ?? ""), ctx.ip);
      // CREST-GAP-039: security notice that the reset completed (a mail failure never blocks the reset).
      const resetUser = await ctx.db.prepare(`SELECT email FROM users WHERE id = ?`).bind(resetUserId).first<{ email: string }>();
      if (resetUser) {
        try { await sendMail(ctx, { template: "security_notification", to: resetUser.email, idempotencyKey: `reset-done:${resetUserId}:${str(f, "token").slice(0, 16)}`, data: { event: "password_reset_completed" } }); }
        catch (e) { console.error(JSON.stringify({ level: "warn", msg: "reset notice email failed", error: (e as Error).message })); }
      }
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
    return invitePage(ctx, token, inv.email, inv.org_name, inv.role_id, await auth.invitationMode(ctx.db, inv.email, invitationSessionUser(ctx)));
  });
  r.post("/invite", async (ctx) => {
    const f = await ctx.form();
    const token = str(f, "token");
    const sessionUserId = invitationSessionUser(ctx);
    try {
      const inv0 = /^[0-9a-f]{64}$/.test(token) ? await auth.invitationByToken(ctx.db, token) : null;
      const mode = inv0 ? await auth.invitationMode(ctx.db, inv0.email, sessionUserId) : "new";
      if (mode === "new" || mode === "claim") await auth.assertPasswordNotBreached(ctx.env, ctx.db, String(f.get("password") ?? ""));
      await auth.acceptInvitation(ctx.db, token, str(f, "name"), String(f.get("password") ?? ""), { sessionUserId, ip: ctx.ip });
      if (mode === "confirm") return redirect(ctx, inv0!.role_id.startsWith("customer_") ? "/portal" : "/staff", { kind: "success", text: "Invitation accepted." });
      return redirect(ctx, "/login", { kind: "success", text: "Invitation accepted. Sign in to continue — staff accounts set up two-factor authentication next." });
    } catch (e) {
      if (e instanceof auth.AuthError) {
        const inv = await auth.invitationByToken(ctx.db, token);
        if (!inv) return redirect(ctx, "/login", { kind: "error", text: e.message });
        if (inv.accepted_at || inv.expires_at < new Date().toISOString()) return htmlResponse(ctx, authLayout(ctx, { title: "Invitation" }, html`<h1 style="font-size:2rem">Invitation not valid</h1><p>This invitation has expired or was already used. Ask the person who invited you to send a new one.</p>`), 400);
        return invitePage(ctx, token, inv.email, inv.org_name, inv.role_id, await auth.invitationMode(ctx.db, inv.email, sessionUserId), [e.message]);
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
    const recovery = await auth.recoveryCodeStatus(ctx.db, ctx.user!.id);
    const body = html`<div class="page-head"><h1>Account</h1></div>
<div class="grid grid-2"><section class="card"><h2 class="card__title">Profile</h2><p>${ctx.user!.displayName}<br><span class="muted">${ctx.user!.email}</span> ${ctx.user!.emailVerified ? badge("verified", "Email verified") : badge("pending", "Email not confirmed")}</p>
${ctx.user!.memberships.map((m) => html`<p class="faint">${m.organizationName} · ${label(m.role)}</p>`)}
<p data-account-links>${ctx.user!.isStaff ? "" : html`<a href="/account/profile">Edit name or email</a> · `}<a href="/account/privacy">Privacy &amp; your data</a> — download your data or request deletion.</p></section>
<section class="card"><h2 class="card__title">Two-factor authentication</h2>
${ctx.user!.mfaEnabled ? html`<p>${badge("active", "Enabled")} Codes from your authenticator app are required at sign-in.</p>
<p data-testid="recovery-status">Recovery codes: ${recovery.total ? html`<strong>${recovery.remaining}</strong> of ${recovery.total} unused` : html`${badge("pending", "None")} generate a set now so a lost phone does not lock you out`}.</p>
<form method="post" action="/account/mfa/recovery-codes" class="stack">${csrf(ctx)}${input({ name: "code", label: "Current 6-digit code from your authenticator", autocomplete: "one-time-code", inputmode: "numeric", required: true, maxlength: 7, hint: "Generating a new set replaces every earlier recovery code." })}${button(recovery.total ? "Generate new recovery codes" : "Generate recovery codes", { variant: "secondary" })}</form>
<p><a href="/mfa/setup">Replace authenticator</a></p>` : html`<p class="muted" data-mfa-requirement>${mfaRequirementText(ctx)}</p><a class="btn btn--secondary" href="/mfa/setup">Set up two-factor authentication</a>`}</section></div>
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
  // Regenerating recovery codes needs an MFA-verified session AND a current authenticator code (a fresher check than
  // step-up: a recovery code cannot mint new recovery codes). Shown once; audited; the user is emailed.
  r.post("/account/mfa/recovery-codes", async (ctx) => {
    requireUser(ctx);
    if (!ctx.sessionMfaVerified) throw new HttpError(401, "MFA_REQUIRED");
    if (!ctx.user!.mfaEnabled) return redirect(ctx, "/account", { kind: "error", text: "Turn on two-factor authentication first." });
    const f = await ctx.form();
    try {
      const codes = await auth.regenerateRecoveryCodes(ctx.env, ctx.db, ctx.sessionId!, ctx.user!.id, str(f, "code"), ctx.ip);
      await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, idempotencyKey: `mfa-rc:${ctx.user!.id}:${Date.now()}`, data: { event: "mfa_recovery_codes_regenerated" } });
      return recoveryCodesPage(ctx, codes, "/account", "New recovery codes");
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
function mfaRequirementText(ctx: AppContext): string {
  if (ctx.user!.isStaff) return "Required for staff.";
  if (isCustomerAdmin(ctx)) return "Required for account administrators. Set it up to pay invoices, approve work, accept proposals and manage your team.";
  return "Optional for team members, and recommended.";
}

function mfaChallenge(ctx: AppContext, errors: string[] = [], status?: number) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Verification code" }, html`<h1 style="font-size:2rem">Enter your code</h1><p class="muted">Open your authenticator app and enter the 6-digit code for Crestmont.</p>${formErrors(errors)}
<form method="post" action="/mfa${ctx.url.search}">${csrf(ctx)}${codeField()}<div class="form-actions">${button("Verify")}</div></form>`), status ?? (errors.length ? 401 : 200));
}

function stepUpPage(ctx: AppContext, next: string, errors: string[] = [], status?: number) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Confirm it is you" }, html`<h1 style="font-size:2rem">Confirm it is you</h1>
<p class="muted">This action needs a fresh two-factor check. Enter the current 6-digit code from your authenticator app; you will then return to the page you were on.</p>${formErrors(errors)}
<form method="post" action="/mfa/step-up?next=${encodeURIComponent(next)}">${csrf(ctx)}${codeField()}<div class="form-actions">${button("Verify and continue")}<a class="btn btn--ghost" href="${next}">Cancel</a></div></form>`), status ?? 200);
}

function mfaUnavailable(ctx: AppContext, message: string) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Two-factor setup unavailable" }, html`<h1 style="font-size:2rem">Two-factor setup is unavailable</h1>${alert("error", message)}<p><a href="/">Back to the website</a></p>`), 503);
}

/** Shows freshly generated recovery codes. This response is the only place they ever appear in plaintext. */
function recoveryCodesPage(ctx: AppContext, codes: string[], next: string, heading: string) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Recovery codes" }, html`<h1 style="font-size:2rem">${heading}</h1>
${alert("info", "Save these recovery codes now, somewhere safe and separate from your phone (a password manager or a printed copy). They are shown only once. Each code works once, in place of a 6-digit code, if you lose your authenticator.")}
<ol class="recovery-codes" data-testid="recovery-codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ol>
<p class="muted">Generating a new set (from your account page) replaces all of these.</p>
<div class="form-actions"><a class="btn" href="${next}">I have saved my codes — continue</a></div>`));
}

/** After a recovery code was used: email the account owner and warn in the UI. */
async function recoveryUsed(ctx: AppContext, remaining: number): Promise<{ kind: "info" | "error"; text: string }> {
  await sendMail(ctx, { template: "security_notification", to: ctx.user!.email, idempotencyKey: `mfa-rc-used:${ctx.user!.id}:${Date.now()}`, data: { event: "mfa_recovery_code_used" } });
  return { kind: remaining <= 2 ? "error" : "info", text: `You signed in with a recovery code. ${remaining} unused code${remaining === 1 ? "" : "s"} left — generate a new set from your account page${remaining <= 2 ? " now" : ""}.` };
}

function forgotPage(ctx: AppContext, errors: string[] = [], status?: number) {
  return htmlResponse(ctx, authLayout(ctx, { title: "Reset password" }, html`<h1 style="font-size:2rem">Reset your password</h1>${formErrors(errors)}
<form method="post" action="/password/forgot">${csrf(ctx)}${input({ name: "email", label: "Email", type: "email", autocomplete: "email", required: true })}${turnstileWidget(ctx)}<div class="form-actions">${button("Send reset link")}</div></form>`), status ?? (errors.length ? 400 : 200));
}

function mfaSetup(ctx: AppContext, secret: string, errors: string[] = []) {
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;
  return htmlResponse(ctx, authLayout(ctx, { title: "Set up two-factor authentication" }, html`<h1 style="font-size:2rem">Set up two-factor authentication</h1>
${ctx.user!.isStaff ? alert("info", "Two-factor authentication is required for Crestmont staff accounts.") : isCustomerAdmin(ctx) ? alert("info", "Two-factor authentication is required for account administrators, who approve work and pay invoices. Until it is on you can view your portal, but not pay, approve, accept proposals or manage your team.") : ""}
<ol class="muted"><li>Open an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator).</li><li>Add an account using this setup key, or open the link on a phone that has the app.</li><li>Enter the 6-digit code it shows.</li></ol>
<p><span class="label">Setup key</span><br><code style="font-size:1.1rem;letter-spacing:.08em;color:var(--gold-1)" data-testid="totp-secret">${grouped}</code></p>
<p><a href="${otpauthUri(secret, ctx.user!.email)}">Open in authenticator app</a></p>${formErrors(errors)}
<form method="post" action="/mfa/setup${ctx.url.search}">${csrf(ctx)}${input({ name: "code", label: "6-digit code", autocomplete: "one-time-code", inputmode: "numeric", required: true, maxlength: 7 })}<div class="form-actions">${button("Turn on")}</div></form>`), errors.length ? 400 : 200);
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
