# ADR 0002 — Authentication provider

**Status:** Proposed — awaiting Founder approval (presented together with maintenance entitlements, BLK-010)
**Date:** 2026-10-26

## Context
§17 asks for managed authentication with registration, verification, recovery, MFA (required for staff, optional for customers), sessions, revocation, rate limiting, suspicious-activity logging and invitations. Choosing a paid provider is a cost decision reserved for the Founder (§2, §78).

To avoid blocking the portal, a complete in-platform implementation was built behind a single seam (`loadSession` + `/login` routes): PBKDF2-SHA256 passwords, RFC 6238 TOTP MFA (enforced for every staff route), lockout + rate limits, security event log, session listing/revocation, single-use hashed email/reset tokens, staff invitations that cannot grant Owner. It is covered by integration tests and real-browser E2E tests.

## Options (prices read from vendor pages on 2026-10-26)

| Option | Cost | Notes |
|---|---|---|
| **A. In-platform auth (built) + Cloudflare Access in front of `/staff/*`** | $0 — Cloudflare Zero Trust free plan covers up to 50 users; $7/user/month pay-as-you-go above that | Staff get two independent layers (Cloudflare identity check, then platform password + TOTP). Customers use the in-platform flows. No customer-data vendor. Crestmont owns password-security operations. |
| B. Clerk Pro | $25/month ($20 billed annually), 50,000 retained users per app included | MFA is not included on the free Hobby plan. Replaces the built flows; adds a vendor holding customer identities; JS SDK integration work. |
| C. Auth0 Essentials | $35/month for up to 500 monthly active users | MFA on paid plans only. Similar replacement effort to B. |

## Recommendation
**Option A.** It satisfies every §17 capability today at no recurring cost, keeps customer identities in Crestmont's own database, and adds a managed identity gate for the higher-risk staff/owner surface. Revisit B/C if Crestmont needs social sign-in or enterprise SSO for customers.

This deviates from the literal word "managed" for customer accounts, so it needs explicit Founder approval. If the Founder prefers B or C, only `src/services/auth.ts#loadSession` and `src/routes/auth.ts` change; authorization (`src/domain/authz.ts`) stays as is.

## Sources
- Cloudflare Access / Zero Trust plans: https://www.cloudflare.com/en-au/products/cloudflare-access
- Clerk pricing: https://clerk.com/pricing
- Auth0 pricing: https://auth0.com/pricing
