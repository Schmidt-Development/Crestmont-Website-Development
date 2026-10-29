# CRESTMONT — 104-finding closeout register

Generated from `docs/closeout/crestmont-104-register.json` by `scripts/closeout-register.ts`. Do not edit by hand. Source audit: `docs/closeout/AUDIT-2026-10-29.md` (main @ 92fee96).

## Counters

| Measure | Count |
| --- | --- |
| Original findings | 104 |
| Engineering complete (incl. closed) | 2 |
| With automated tests | 2 |
| Staging certified (CLOSED — VERIFIED) | 0 |
| Awaiting external or human action | 9 |
| CLOSED — VERIFIED | 0 |
| ENGINEERING COMPLETE — STAGING VERIFICATION PENDING | 2 |
| ENGINEERING COMPLETE — EXTERNAL VERIFICATION PENDING | 0 |
| BLOCKED — HUMAN ACTION | 9 |
| BLOCKED — PROVIDER ACCESS | 0 |
| OPEN — ENGINEERING | 93 |
| NOT APPLICABLE — EVIDENCE BACKED | 0 |
| Supplemental findings (CREST-NEW) | 0 |

## Findings

| ID | Priority | Stream | Disposition | PR | Commit | Tests | Staging verification | Unblock action / notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CREST-GAP-001 | P0 | 1-security-identity | ENGINEERING COMPLETE — STAGING VERIFICATION PENDING | #26 | 00429e0 | tests/invitation-security.test.ts | — | Awaiting Founder merge of PR #26 and the resulting Deploy staging run. |
| CREST-GAP-002 | P1 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-003 | P1 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-004 | P1 | 1-security-identity | ENGINEERING COMPLETE — STAGING VERIFICATION PENDING | #26 | 00429e0 | tests/invitation-security.test.ts | — | Awaiting Founder merge of PR #26. |
| CREST-GAP-005 | P1 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-006 | P1 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-007 | P1 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-008 | P1 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-009 | P1 | 3-cloudflare-d1-ci-release | BLOCKED — HUMAN ACTION | — | — | — | — | GitHub → Settings → Environments → production → add secret PRODUCTION_MFA_ENCRYPTION_KEY (base64 of 32 random bytes, kept in the Founder's password manager), then Actions → Provision production → Run workflow on main and approve. |
| CREST-GAP-010 | P1 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-011 | P1 | 7-business-legal | BLOCKED — HUMAN ACTION | — | — | — | — | Form the legal entity and set a registered address; engage an accountant; then fill business.legal_name, business.address and contact.email in /staff/settings on staging and production. |
| CREST-GAP-012 | P1 | 6-integrations-ai | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-013 | P1 | 3-cloudflare-d1-ci-release | BLOCKED — HUMAN ACTION | — | — | — | — | Cloudflare → Websites → Add site crestmontwebsitedevelopment.com on the Crestmont account; switch nameservers at the registrar; remove apex CNAME/A/AAAA records; SSL/TLS Full (strict). |
| CREST-GAP-014 | P1 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-015 | P1 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-016 | P1 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-017 | P1 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-018 | P1 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-019 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-020 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-021 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-022 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-023 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-024 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-025 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-026 | P2 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-027 | P2 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-028 | P2 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-029 | P2 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-030 | P2 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-031 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-032 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-033 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-034 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-035 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-036 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-037 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-038 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-039 | P2 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-040 | P2 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-041 | P2 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-042 | P2 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-043 | P2 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-044 | P2 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-045 | P2 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-046 | P2 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-047 | P2 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-048 | P2 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-049 | P2 | 5-frontend-portfolio-a11y-seo | BLOCKED — HUMAN ACTION | — | — | — | — | Founder sets support.staffed_hours in /staff/settings (engineering hides the line until it is set). |
| CREST-GAP-050 | P2 | 2-commerce-sales | BLOCKED — HUMAN ACTION | — | — | — | — | Founder approves or amends the proposed maintenance entitlements in src/domain/catalog.ts (CAT-006 / BLK-010). |
| CREST-GAP-051 | P2 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-052 | P2 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-053 | P2 (P1 if voice launches) | 6-integrations-ai | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-054 | P2 | 3-cloudflare-d1-ci-release | BLOCKED — HUMAN ACTION | — | — | — | — | GitHub → Settings → Rules → Rulesets: protect v* tags; Settings → Environments → production: confirm required reviewer = Founder and deployment branches = main. |
| CREST-GAP-055 | P2 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-056 | P2 | 6-integrations-ai | BLOCKED — HUMAN ACTION | — | — | — | — | Choose a penetration-test vendor and commission a test against staging once CREST-GAP-001..004 are merged; engineering supplies scope and evidence. |
| CREST-GAP-057 | P2 | 4-owner-staff-customer-ops | BLOCKED — HUMAN ACTION | — | — | — | — | Founder and attorney approve the retention periods in docs/RETENTION-SCHEDULE.md; then enable them in /staff/ops/retention. |
| CREST-GAP-058 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-059 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-060 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-061 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-062 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-063 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-064 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-065 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-066 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-067 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-068 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-069 | P3 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-070 | P3 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-071 | P3 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-072 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | Founder default recorded 2026-10-29: prompt customer administrators to enrol MFA; require MFA for staff and Owner. Engineering implements the prompt. |
| CREST-GAP-073 | P3 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-074 | P3 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-075 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-076 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-077 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-078 | P3 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-079 | P3 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-080 | P3 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-081 | P3 | 4-owner-staff-customer-ops | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-082 | P3 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-083 | P3 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-084 | P3 | 2-commerce-sales | BLOCKED — HUMAN ACTION | — | — | — | — | Accountant reviews the Michigan sales-tax position for web services and the /staff/settings/tax configuration; record the review. |
| CREST-GAP-085 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-086 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-087 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-088 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-089 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-090 | P3 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-091 | P3 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-092 | P3 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-093 | P4 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-094 | P4 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-095 | P4 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-096 | P4 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-097 | P4 | 2-commerce-sales | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-098 | P4 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-099 | P4 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-100 | P4 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-101 | P4 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-102 | P4 | 1-security-identity | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-103 | P4 | 5-frontend-portfolio-a11y-seo | OPEN — ENGINEERING | — | — | — | — | — |
| CREST-GAP-104 | P4 | 3-cloudflare-d1-ci-release | OPEN — ENGINEERING | — | — | — | — | — |
