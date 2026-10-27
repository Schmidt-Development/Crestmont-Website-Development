# OWASP ASVS 4.0.3 review (Level 2–oriented)

**Requirement:** SEC-007 · **Scope:** the code in this repository as of 2026-10-26, findings status updated 2026-10-27 (development only; no staging or production exists) · **Reviewer:** engineering, self-review.

> **This is not a compliance claim.** Crestmont is **not** ASVS-compliant or certified, and nothing here should be presented that way. This is a self-review by the same team that wrote the code. It is not an independent assessment or a penetration test. It checks the source against the ASVS 4.0.3 chapters at roughly Level 2 depth and lists the gaps. An independent review and a staging penetration test are still needed before launch (F-16).

Severity: **High** = plausible exploitation or loss of an essential control before launch · **Medium** = defence-in-depth gap or a missing operational control · **Low** = hardening.

## Summary of findings

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| F-01 | High | V14 / V1 | No staging or production environment, secrets store, WAF or Access policy exists yet (BLK-003). Every control below is verified only in development tests. | Partly resolved: staging Worker, D1 and secrets now exist (deploy-staging.yml); production, WAF and Cloudflare Access are still not provisioned |
| F-02 | High | V12 | No malware scanning for uploads. Files stay `scan_status='pending'` (`src/services/files.ts`). | Open |
| F-03 | Medium | V7 | No external alerting. Errors go to `app_errors` and the console only; nobody is paged (`/staff/monitoring`). | Open |
| F-04 | Medium | V2.8 | A TOTP code can be replayed within its ±30 s window. `verifyTotp` (`src/lib/auth-crypto.ts`) does not record the last used time-step. | **Fixed** (migration 0010: `users.totp_last_step`; codes are single-use per 30 s step; `tests/auth.test.ts`) |
| F-05 | Medium | V2.4 | PBKDF2-SHA256 at 100 000 iterations is the Workers WebCrypto maximum, but below OWASP's current 600 000 recommendation for PBKDF2-SHA256. | Accepted constraint pending managed-auth decision |
| F-06 | Medium | V2.1 | Breached-password checking (ASVS 2.1.7) is missing; there is only a tiny denylist (`passwordProblems`). | **Fixed** (k-anonymity breached-password check via the Have I Been Pwned range API, on outside development, fail-open with a security event; larger offline denylist; `tests/asvs-hardening.test.ts`) |
| F-07 | Medium | V3.3 | Sessions have an absolute lifetime (12 h staff / 7 d customer) but **no idle timeout** (ASVS 3.3.2 at L2). | **Fixed** (idle timeout 2 h staff / 24 h customer, `sessions.last_seen_at`; `src/services/auth.ts`) |
| F-08 | Medium | V4 / V13 | `/api/*` routes skip CSRF by design. Safety relies on each API route never trusting cookies for writes. Today `readiness` reads use the cookie actor (read-only). Any future cookie-authenticated API write would be CSRF-exposed. | Open (guard by review) |
| F-09 | Medium | V8.3 | Privacy deletion keeps `audit_logs.ip` and `security_events.email` for the anonymised user, because the audit table is append-only by design. The retention period for these is not yet defined. | Open (needs retention policy) |
| F-10 | Medium | V10 / V14.2 | Dependency scanning (npm audit, CodeQL) is configured in CI but has never run (BLK-013). There are zero runtime dependencies, which limits exposure, but dev tooling is unscanned. | Open |
| F-11 | Low | V5 / V12.6 | SSRF: outbound calls go only to fixed provider hosts (Stripe, Resend, Anthropic, GitHub, Turnstile, Cloudflare DoH) built from constants. `GITHUB_REPO` comes from configuration and is validated (`owner/name`). Nothing fetches user-supplied URLs today. There is still no central egress allowlist. | **Fixed** (central egress allowlist `src/lib/egress.ts`, installed on the Worker's global fetch; the environment probe allows only its validated host for the call; `tests/asvs-hardening.test.ts`) |
| F-12 | Low | V14.4 | `style-src 'self'` CSP is good. Several pages use inline `style="..."` attributes, which CSP-level-3 browsers block unless `'unsafe-inline'` is allowed. This is a functional, not security, issue. | **Fixed** (CSP allows `style-src-attr 'unsafe-inline'` only; scripts and style elements stay `'self'`) |
| F-13 | Low | V7.1 | `recordAppError` redacts common key formats (`src/services/monitoring.ts#redact`). Free-form error messages could still contain personal data. | **Fixed** (`redact` also removes email addresses, phone numbers and card-like numbers from stored error text) |
| F-14 | Low | V9 | HSTS is sent (`max-age=63072000; includeSubDomains`). TLS termination and the minimum TLS version are Cloudflare settings that are not provisioned yet. | Open |
| F-15 | Low | V11 | The business-logic limits exist (revision allowances, refund chain, milestone de-duplication) but have no anti-automation on authenticated business actions apart from login/registration/reset rate limits. | Open |
| F-16 | High | Process | No independent review or penetration test has been done. | Open |
| F-17 | Medium | V2.5 | The voice receptionist matches callers by verified email + phone only to *open a ticket*. It never reveals data, but email + phone are weak identity factors if that matching were ever reused for disclosure. | Accepted (documented constraint in `src/services/voice.ts`) |

## V1 Architecture

- ✔ Documented stack and trust boundaries: `docs/adr/0001-stack.md`. Server-rendered HTML; all authorization happens on the server.
- ✔ Central request pipeline: `src/app/app.ts` (`handle`, guards `requireUser` / `requireStaff` / `requireCustomerOrg`).
- ◐ Threat model: not written as a separate document. The security-relevant decisions are spread across file headers (F-01).

## V2 Authentication

- ✔ Passwords are hashed with PBKDF2-SHA256 and a random 16-byte salt. Comparison is timing-equalised, including for unknown accounts (`src/lib/auth-crypto.ts`). Iterations: F-05.
- ✔ Minimum length 12, maximum 200, no composition rules (ASVS 2.1.1/2.1.2/2.1.9). There is no breached-password check (F-06).
- ✔ Generic login failure message. Lockout after 8 failures for 15 minutes. Per-IP and per-email rate limits (`src/services/auth.ts#login`, `src/services/security.ts#rateLimit`).
- ✔ TOTP MFA (RFC 6238; tested against the RFC vectors in `tests/auth.test.ts`). It is mandatory for staff: `requireStaff` refuses sessions without MFA, and `can()` in `src/domain/authz.ts` denies staff roles without MFA. Replay: F-04.
- ✔ Recovery: single-use, hashed, one-hour reset tokens. A reset revokes all sessions (`resetPassword`).
- ✔ Staff invitations: single-use, hashed, 7-day tokens. The Owner role cannot be granted by invitation or through the UI (`createInvitation`, `src/services/employees.ts`).
- ✔ Disabled accounts cannot sign in and their sessions are rejected (`loadSession` checks `disabled_at`). Disabling revokes sessions (`setStaffDisabled`; test `[EMP-002] disabling a user revokes all sessions`).

## V3 Session management

- ✔ 256-bit random session tokens. Only the SHA-256 hash is stored (`sessions.token_hash`).
- ✔ Cookie `cm_session`: `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS (`src/app/http.ts#cookie`).
- ✔ Server-side revocation: per session, all others, and all sessions on role change, disable, password change/reset or privacy deletion.
- ✔ A new session is created at login. MFA verification upgrades that same server-side session row (no fixation: the token is minted at password verification, before any privileged state).
- ✖ Idle timeout (F-07).

## V4 Access control

- ✔ Deny by default. Every staff route calls `requireStaff(ctx, perm)`; customers go through `requireCustomerOrg`, scoped by `organization_id` from the guard, never from input (`docs/ENGINEERING.md`).
- ✔ Founder-protected permissions are Owner-only and never granted to non-user actors (`src/domain/authz.ts`, `OWNER_ONLY`; test `[AIOPS-003]`).
- ✔ The Owner account is immutable through the UI: no role change, no disable, no grant of owner (`src/services/employees.ts`; test `[EMP-001]`).
- ✔ Every platform page returns 403 for roles without the permission (test `[EMP-002] non-permitted roles get 403`).
- ✔ Privacy export is scoped to the requester's own customer organizations. Internal notes are excluded (`src/services/privacy.ts#buildExport`; test `[SEC-006]`).
- ✔ The voice webhook never reveals customer data, and its responses are identical for matched and unmatched callers (test `[VOICE-004] route_support never leaks`).
- ◐ API CSRF exemption: F-08.

## V5 Validation, sanitisation and encoding

- ✔ Output encoding: the `html` tagged template escapes `& < > " ' \``; `raw()` is only used for repository-authored markup (`src/lib/html.ts`). URLs pass through `safeUrl()`, which allows only http(s), mailto, tel and same-site paths.
- ✔ Email HTML bodies are never injected into pages. Staff see the text body (escaped) and the HTML only as a download served with `default-src 'none'` CSP (`/staff/email/:id/html`; test `[EMAIL-003]`).
- ✔ Input validation through `src/lib/validate.ts` for JSON APIs, plus explicit server-side checks on every form (e.g. settings, backups).
- ✔ SQL injection: all queries are parameterised with `.bind()`. LIKE wildcards in user filters are stripped. No string-built SQL from input. Dynamic `WHERE` fragments use only constant column names.
- ✔ CSV export guards against formula injection (`csvCell` in `src/routes/platform.ts` and `src/readiness/report.ts`; test `[SEC-001]`).
- ◐ SSRF: F-11.

## V6 Stored cryptography

- ✔ WebCrypto only; no custom primitives. HMAC-SHA256 for webhooks and evidence, PBKDF2 for passwords, SHA-256 for token hashes, constant-time hex comparison (`src/lib/crypto.ts`).
- ◐ TOTP secrets are stored in plaintext in D1 (base32). D1 encrypts at rest at the platform level, but there is no application-level envelope encryption. This is acceptable for Level 2 only with restricted database access (operational control, F-01).

## V7 Error handling and logging

- ✔ Generic error pages. Stack traces never reach users (`handle` in `src/app/app.ts`).
- ✔ Append-only audit log enforced by database triggers (`migrations/0001_core.sql`). Sensitive actions are audited (role changes, disable/enable, settings, privacy, AI decisions, integration probes, voice configuration, audit exports).
- ✔ Security events: failed and locked logins, rate limiting, MFA failures, password reset requests (`security_events`, `/staff/security`).
- ◐ The error log (`app_errors`) needs one integration line in `app.ts` to be populated (see the hand-off note). There is no alerting (F-03). Redaction: F-13.

## V8 Data protection

- ✔ `Cache-Control: no-store` for authenticated pages and all downloads.
- ✔ Secrets are never displayed: `/staff/security` and `/staff/integrations` show names or presence only. Integration fingerprints are truncated SHA-256 (`src/services/integrations.ts`).
- ✔ Privacy export and deletion workflow (`/account/privacy`, `/staff/security#privacy`). Financial records are retained and the user is anonymised.
- ✔ Voice transcripts, summaries and recordings are stored only with consent (test `[VOICE-006]`).
- ◐ No retention schedule yet for sessions, security events, email bodies or app errors (F-09).

## V9 Communications

- ✔ HSTS header and the `Secure` cookie flag on HTTPS. All outbound provider calls use HTTPS URLs.
- ◐ Edge TLS configuration is not provisioned (F-14).

## V10 Malicious code

- ✔ Zero runtime npm dependencies (`package.json`). No `eval` or dynamic `Function`. The client JavaScript (`public/assets/app.js`) is progressive enhancement only.
- ◐ CI scanning has never run (F-10).

## V11 Business logic

- ✔ Server-side pricing; the CMS cannot change prices (`src/domain/catalog.ts`). The voice agent cannot quote non-catalog prices: configuration versions containing other dollar amounts are rejected (`inventedPrices`, test `[VOICE-004]`).
- ✔ State machines for leads and projects. Idempotent webhooks (Stripe event id; voice provider + call id + event id).
- ◐ Anti-automation for authenticated actions: F-15.

## V12 Files and resources

- ✔ Extension + magic-byte allow-list, no SVG/HTML, 25 MB limit, sanitised filenames (`src/adapters/storage.ts`). Private storage; downloads are access-checked and audited (`src/services/files.ts`).
- ✖ Malware scanning (F-02).

## V13 API and web services

- ✔ Webhooks verify HMAC signatures over the raw body with a timestamp tolerance and fail closed when the secret is missing: Stripe (`src/domain/stripe-webhook.ts`), CI evidence (`src/readiness/ingest.ts`), voice (`src/services/voice.ts`; test `[VOICE-003]`).
- ✔ JSON body size limit of 1 MB (`readBody` in `src/routes/api.ts`). Malformed JSON returns 400.
- ◐ F-08.

## V14 Configuration

- ✔ Security headers on every response: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy (`src/app/http.ts`).
- ✔ Central CSRF protection (double-submit token plus Origin/Referer check) for all non-API state changes.
- ✔ The Stripe adapter refuses live keys (`src/adapters/payments.ts`). The integration matrix shows a live key as `blocked`.
- ✖ Environments and secrets are not provisioned (F-01).

## Next steps

1. Fix F-04 (store the last TOTP step per user) and F-07 (idle timeout). Both are small code changes.
2. Pick a malware-scanning approach (F-02) and alert routing (F-03) when the Cloudflare account exists.
3. Record F-01–F-17 in `security_findings` so the readiness gates track them.
4. Commission an independent review and pen test against staging (F-16). Do not mark SEC-007 verified on the strength of this self-review.
