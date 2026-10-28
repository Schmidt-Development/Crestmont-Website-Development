# Production authentication — status against the Founder's approved requirements

Audit of `main` at `45b6fe8` (2026-10-27). **Owner of the changes below: the backend engineering session.** This file
is a hand-off, not a redesign: the existing system is sound and is kept. Production-mode journey tests that prove the
implemented parts are in `tests/production-auth.test.ts` (development-mode equivalents in `tests/auth.test.ts`).

## Already implemented and tested

| Requirement | Where | Tests |
|---|---|---|
| Public site open, no shared password, in production | `src/app/preview-gate.ts` returns "off" whenever `ENVIRONMENT=production`, even if `PREVIEW_GATE` / `STAGING_ACCESS_PASSWORD` are set | production-auth #1, preview-gate.test.ts |
| Staging stays restricted | Preview gate fails closed on staging (`PREVIEW_GATE=required`) | preview-gate.test.ts |
| Customer self sign-up, individual email/password accounts | `/register` → `registerCustomer` (own organization, `customer_admin`) | production-auth #2, auth.test.ts |
| Email verification | single-use 48 h token, hashed at rest | production-auth #2 |
| Employee accounts with roles | individual invitations (`/invite`, 7 days, single-use); Owner cannot be granted by invitation; role-based `can()` | production-auth #3, security-matrix.test.ts |
| Owner login with MFA | Owner created only by `scripts/bootstrap-owner.ts` one-time invitation (no default password); all staff must enrol TOTP before any staff page | production-auth #4 |
| Password hashing | PBKDF2-SHA256, 100k iterations, per-user salt (the Workers WebCrypto maximum); breached-password check (k-anonymity) on by default outside development | auth.test.ts |
| Password reset | single-use 1 h token, same response for unknown accounts, revokes every session | production-auth #5 |
| Sessions | hashed tokens; absolute 12 h staff / 7 d customer; idle 2 h staff / 24 h customer; list and revoke; password change signs out others | auth.test.ts |
| Login rate limiting and lockout | 30/15 min per IP, 10/15 min per email, lock 15 min after 8 failures; security events recorded | production-auth #6 |
| MFA hardening | TOTP replay protection; replacing an authenticator needs an MFA-verified session; enrolled secret never re-displayed | production-auth #4, auth.test.ts |
| Tenant isolation | every customer route checked against other organizations' ids | security-tenancy.test.ts |
| Audit logging | `audit_logs` for registration, sessions, MFA, resets, invitations; `security_events` for failures | auth.test.ts, platform tests |
| Release approval needs Owner + MFA | `/staff/readiness/approve` | production-auth #3, #4 |

## Gaps for the backend session (in priority order)

1. **MFA account recovery.** There are no recovery codes and no documented path when an authenticator is lost.
   For the Owner this is a lock-out risk. Proposed: 10 single-use recovery codes (hashed like passwords, shown once
   at enrolment, regenerate on demand, audited); Administrator-initiated MFA reset for employees (revokes sessions,
   forces re-enrolment, audited); a documented Owner break-glass procedure (operator-run script, like
   `bootstrap-owner.ts`, that revokes sessions and clears MFA, recorded in `audit_logs`).
2. **Step-up MFA for sensitive actions.** MFA is checked once per session (staff sessions last up to 12 h). Require
   a fresh TOTP (or one verified within ~10 minutes) for: release approval, role/membership changes, refunds and
   payouts, integration/secret settings, data exports, and MFA changes.
3. **TOTP secrets at rest.** `users.totp_secret` and `totp_pending_secret` are stored in clear. Encrypt with
   AES-GCM under a per-environment Worker secret (e.g. `MFA_ENCRYPTION_KEY`), with a migration that re-encrypts
   existing rows. (The deleted staging export artifact showed why: a database copy exposed 2FA keys.)
4. **Bot protection on auth forms.** Public contact/quote forms use Turnstile; `/register` and `/password/forgot`
   do not. Add the existing Turnstile check, and a per-IP limit on `/password/forgot` (currently per email only).
5. **Email-verified gating.** Unverified customers can sign in (proposal acceptance already requires a verified
   email). Decide which other actions require it (checkout, file upload, messaging).
6. **Password hashing cost.** 100k PBKDF2 iterations is the Workers maximum and below current OWASP guidance for
   PBKDF2-SHA256. Acceptable for launch; keep the hash format versioned so a stronger KDF can be adopted with
   rehash-on-login.

## Not engineering: needs the Founder

- **Transactional email (Resend).** In production without `RESEND_API_KEY`, verification and reset emails are only
  written to the outbox. Customer sign-up and self-service reset do not work for real users until transactional
  email is authorised (marketing email stays off).
- **Staging credential rotation** after the public-artifact exposure: `Deploy staging` with *rotate_credentials*,
  once PR #8 is merged (so the new notes are encrypted).
