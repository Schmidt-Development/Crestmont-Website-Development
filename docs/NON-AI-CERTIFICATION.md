# Phase 1 non-AI certification

What has been proven about the non-AI offering, where, and against what. Scope:
[PHASED-LAUNCH.md](PHASED-LAUNCH.md). Fulfilment: [FULFILLMENT-HUMAN-SUPERVISED.md](FULFILLMENT-HUMAN-SUPERVISED.md).

**Provider column:** *real sandbox* = the provider's own test environment was called (Stripe test mode on staging);
*fixture* = the platform's real adapter and webhook code, fed a signed fixture or a stand-in transport; no provider was
contacted. A fixture proves the platform's side of an integration, never a live connection.

## The connected customer journey

`tests/non-ai-certification.test.ts` runs ONE customer through everything, in order, on the real request pipeline and
migrations, with AI website generation off (`AI_BUILD_AUTOMATION = "off"`). Development environment; local, every CI run.

| # | Scenario | Provider | Expected | Result |
|---|---|---|---|---|
| 1 | Public pricing shows the approved packages | — | Starter $999, Business $2,499, Premium $4,999 | pass |
| 2 | Registration → verification email → verify → sign in | email fixture (outbox) | single-use link, portal | pass |
| 3 | Package checkout refuses without agreements, then records each agreement's exact text hash against the order | Stripe fixture | 422, then 303 to Stripe; server-side price | pass |
| 4 | Async payment **fails** | Stripe fixture (signed) | invoice stays open, no project | pass |
| 5 | **Forged** webhook signature | — | refused (401), nothing paid | pass |
| 6 | Payment succeeds, delivered **twice** (same id) and again under a new id | Stripe fixture (signed) | `duplicate: true`; one payment, one project | pass |
| 7 | Intake submitted | — | project in Scope review; **no AI build** | pass |
| 8 | Staff assignment, then **reassignment** | — | second PM owns it; audited | pass |
| 9 | Design blocked until the customer approves the written scope; the customer's notification says what to review | email fixture | 409 before, then design → development → QA → customer review | pass |
| 10 | Customer-requested **revision** | — | recorded against the allowance; no AI job | pass |
| 11 | File upload | storage fixture | `pending`, never shown as clean; **missing file** → 404 | pass |
| 12 | Support ticket → staff reply → customer sees it | email fixture | reply visible | pass |
| 13 | Maintenance: approved $99/$199/$299 plans; subscribe needs the terms; subscription webhook → active; **failed renewal** → past due + email; paid → active; cancellation → canceled | Stripe fixture (signed) | as listed | pass |
| 14 | **Another customer** opens this journey's project, file, ticket, revisions | — | 403/404, nothing leaks | pass |
| 15 | Customer opens staff pages; support role moves a project | — | 403 | pass |
| 16 | **Expired session** | — | sent to sign-in | pass |
| 17 | **Wrong MFA code** | — | refused, staff area closed, `mfa_failed` recorded | pass |
| 18 | Nothing in the journey created, queued or dispatched an AI build | — | 0 build jobs (fails if the gate is removed: mutation-checked) | pass |
| 19 | **Notification provider down** (real Resend adapter, failing transport) | Resend fixture | the ticket is created; the email is queued for retry with the provider's error | pass |

## Live staging (deployed Worker, staging D1, Stripe test mode)

From staging deploy #154 (2026-11-05, commit f13261e), the run that reached the journeys:

| Scenario | Provider | Result |
|---|---|---|
| Journey 5: customer pays in Stripe Checkout | **real sandbox** | pass |
| Journey 6: signed webhook creates the order | **real sandbox** | pass |
| Journey 7: project provisioned after payment | **real sandbox** | pass |
| Journey 24: Stripe billing portal | **real sandbox** | pass |
| Refund issued by the Founder; `charge.refunded` matched; customer notified once | **real sandbox** | pass |
| Dispute reaches staff and emails the Owner once | **real sandbox** | failed on a harness defect (counted page 1 of a 25-row list); fixed in #148, re-run pending |
| Journey 17/18: release checks on the run's project | real sandbox | failed: the staff project page answered 500 (cause not captured in #154; the same shape as #156's D1 overload, fixed by the bounded readiness load); re-run pending |
| Journey 25: failed renewal triggers recovery | — | **skipped** (no Stripe test-clock driver); proven by fixture above (#13) |
| CRM duplicate protection E2E | — | sign-in and erasure answered 500 in the same run (cause not captured); re-run pending |
| Transport security on the live site | real | passed in #154 (first real certificate/TLS/HSTS evidence) |

## Local browser E2E (`npm run e2e`)

47 pass, 0 fail; 40 skipped are the staging-only suites. The 21-step browser journey covers the quote path: public
form → CRM → quote → registration → signed payment → project → onboarding → files → tasks → scope approval → design and
revision rounds → change order → release readiness → handoff → final acceptance → support → refund → executive
overview → 375 px sweep.

## Defects found and fixed during certification (non-AI)

| Defect | Kind | Fix |
|---|---|---|
| Approval notifications said when to answer but not what (in-app text took the email's last paragraph, the deadline) | application | explicit `inApp` line |
| Readiness pages read every evidence row ever recorded; staging D1 answered "overloaded" and 14 Owner modules failed | application | bounded load, equivalence-proven (`tests/readiness-evidence-load.test.ts`) |
| Staging dispute journey counted page 1 of 25 rows | test harness | counts every page |
| CRM quick-view test expected attribution the drawer deliberately no longer shows | test drift | test follows f0fd13e |

## Not certified here

- A live **Resend** connection: no account or verified sending domain (BLK-005). Every template and the retry path are
  proven by fixture; staging and development deliver to the outbox only.
- **Production** itself: not deployed. Post-deploy checks (`scripts/production-checks.ts`, the AI-gate live check) run
  in `deploy-production.yml` and roll back on failure.
- **Malware scanning**: the scanner transport exists (`/api/scan/*`, `FILE_SCANNER_SECRET`); no scanner runs yet, so files
  stay `pending` — safe, but unscanned.
- Independent security review: none has taken place; the platform's own tests are not one.
