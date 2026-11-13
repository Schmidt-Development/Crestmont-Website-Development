// Guest checkout (Founder, 2026-11-13): a completely new visitor buys a package without creating an account first.
//
// The visitor's intake carries everything an account needs (contact name, business name, email). On its first submit,
// for an email that has no Crestmont account, this creates the customer's own records exactly as registration does —
// a user (with NO password and an unconfirmed email), the customer organization and the customer_admin membership —
// and opens a normal customer session for that browser. Everything after that is the unchanged purchase flow: the
// review (server price, required plan, agreements), the Stripe-hosted Checkout, the signed webhook that marks the
// order paid and provisions exactly one project.
//
// The account is secured after payment: the verified payment sends an "account setup" email with a single-use link
// (7 days) to choose a password; using it also confirms the email address (src/services/auth.ts resetPassword).
// Until then the account has no password, so nobody can sign in to it from another browser.
//
// Safety: an email that already belongs to an account is never taken over — the visitor is asked to sign in. Creation
// is rate-limited per IP and, outside development, behind the Turnstile challenge (src/routes/crm.ts).
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { randomToken, hashToken } from "../lib/auth-crypto.ts";
import { rateLimit, securityEvent, audit } from "./security.ts";

export const SETUP_LINK_HOURS = 7 * 24;
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class GuestCheckoutError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

export type GuestStart = { kind: "created"; userId: string; organizationId: string } | { kind: "existing_account" };

/** Creates the buyer's user, organization and membership for a new email; never touches an existing account. */
export async function startGuestCustomer(db: Db, input: { email: string; name: string; businessName: string }, ip: string | null): Promise<GuestStart> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim().slice(0, 120);
  const business = input.businessName.trim().slice(0, 150);
  if (!VALID_EMAIL.test(email) || email.length > 254) throw new GuestCheckoutError("Enter a valid contact email address.");
  if (!name) throw new GuestCheckoutError("Enter the primary contact name.");
  if (!business) throw new GuestCheckoutError("Enter the business name.");
  const rl = await rateLimit(db, `guest-checkout:${ip ?? "unknown"}`, 10, 3600);
  if (!rl.allowed) { await securityEvent(db, "rate_limited", { ip, detail: "guest checkout" }); throw new GuestCheckoutError("Too many new checkouts from your network. Try again later.", 429); }
  if (await db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first()) return { kind: "existing_account" };
  const at = nowIso();
  const userId = newId("usr"), organizationId = newId("org");
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?,?,?,NULL,?)`).bind(userId, email, name, at),
    db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?,?,'customer',?)`).bind(organizationId, business, at),
    db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_admin',?)`).bind(newId("mbr"), userId, organizationId, at),
  ]);
  await audit(db, { actorUserId: userId, action: "user.guest_checkout_started", subjectType: "user", subjectId: userId, organizationId, ip });
  return { kind: "created", userId, organizationId };
}

/** A customer session for the buyer's browser (same shape and lifetime as a customer sign-in). */
export async function openGuestSession(db: Db, userId: string, meta: { ip: string | null; userAgent: string | null; maxAgeS: number }): Promise<string> {
  const token = randomToken();
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, mfa_verified, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(newId("ses"), userId, await hashToken(token), 0, meta.ip, meta.userAgent?.slice(0, 300) ?? null, nowIso(), new Date(Date.now() + meta.maxAgeS * 1000).toISOString()).run();
  await audit(db, { actorUserId: userId, action: "session.created", subjectType: "user", subjectId: userId, ip: meta.ip, details: { via: "guest_checkout" } });
  return token;
}

/** Customer administrators of an organization who have never chosen a password (guest buyers). */
export async function passwordlessAdmins(db: Db, organizationId: string): Promise<{ id: string; email: string; display_name: string }[]> {
  return (await db.prepare(`SELECT u.id, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND m.role_id = 'customer_admin' AND u.password_hash IS NULL AND u.disabled_at IS NULL`).bind(organizationId).all<{ id: string; email: string; display_name: string }>()).results;
}

/** A single-use account-setup link token (a password-reset token with a 7-day life). */
export async function newAccountSetupToken(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?,?,'password_reset',?,?)`)
    .bind(await hashToken(token), userId, new Date(Date.now() + SETUP_LINK_HOURS * 3600e3).toISOString(), nowIso()).run();
  return token;
}
