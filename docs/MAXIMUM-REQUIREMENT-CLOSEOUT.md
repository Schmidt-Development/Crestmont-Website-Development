# Maximum requirement closeout — 2026-10-27

Computed from `requirements/inventory.ts` + `requirements/status/*` (closures recorded in
`requirements/status/closeout.ts`). The 154 original requirements and the 11 AI Builds addendum requirements are counted
separately.

## 1–2. Final counts

| Ledger | Implemented | In progress | Not started | Total |
|---|---|---|---|---|
| Original registry | **111** (was 83) | 41 | 2 (was 13) | 154 |
| AI Builds addendum | 9 | 2 | 0 | 11 |
| **Combined** | **120** (72.7%) | 43 | 2 | 165 |

Outstanding: 45 (was 73).

## Closure rule

`docs/ENGINEERING.md`: a requirement is *implemented* when every applicable layer exists (UI, server, persistence,
authz, validation, errors, empty states, audit/notifications, tests). Verification against a live provider or on a
deployed environment is tracked by the readiness engine (`verified_in_staging`, `production_verified`) and, per
provider, by an integration requirement that **stays open until a real transaction succeeds**: PAY-001 (Stripe),
EMAIL-001 (Resend), VOICE-002 (Retell), FILE-001 (R2). Every closure below states its basis. "Simulated provider" means
signed or recorded provider fixtures — never presented as a live result. If the Founder prefers to hold the
simulated-provider closures open until real runs exist, remove them from `CLOSURES` in `requirements/status/closeout.ts`
(one line each); the counts recompute automatically.

## 3–4. Requirements closed in this mission (28) and their evidence

| ID | Basis | Evidence |
|---|---|---|
| BRAND-006 | first-party | `tests/e2e/visual.e2e.ts` (3 widths) + new staging sweep in `tests/e2e/staging-quality.e2e.ts` (public, customer, employee, Owner at 375/1440 px, AA contrast) run by every staging deploy; rehearsed on a staging-shaped DB, 2 defects fixed |
| WEB-009 | first-party | `tests/public.test.ts`; `tests/e2e/staging-quality.e2e.ts` on every staging deploy |
| TEST-003 | first-party | visual/focus/contrast suite + axe-core WCAG 2.1 A/AA scan on staging |
| READY-004 | first-party | `tests/readiness.test.ts`; staging `/api/readiness/health` shows the signed `ci` feed healthy (22:28 UTC) |
| READY-006 | first-party | `tests/readiness-sources.test.ts`, `tests/ops.test.ts`: error rate (`env_metrics`) and latency (`env_latency`) on `/staff/readiness/env/:env` |
| READY-009 | first-party | `tests/ops.test.ts`: signed deployment recording and timeline |
| READY-012 | first-party | `tests/readiness-ui.test.ts`, `tests/scheduled.test.ts`, `tests/infra-workflows.test.ts`; off-platform monitor `staging-health-monitor.yml` |
| INFRA-004 | first-party | `tests/infra-workflows.test.ts` (CI on every PR/push: typecheck, tests incl. secret scan, runner, audit; CodeQL weekly) |
| SEC-004 | first-party | `tests/secret-scan.test.ts`, `.github/dependabot.yml`, workflow secret hygiene test |
| AIOPS-003 | first-party | `tests/platform.test.ts`, `tests/domain.test.ts`, `tests/readiness-ui.test.ts` (AI/automation can never refund, accept contracts or approve launch) |
| DOC-002 | first-party | `docs/RUNBOOK.md` (alerting, recovery automation), BACKUP-RECOVERY, POSTLAUNCH-MONITORING; `tests/infra-workflows.test.ts` |
| PORTAL-005 | first-party | `tests/portal.test.ts`, `tests/live-and-limits.test.ts`, `tests/projects.test.ts`, `tests/ux.test.ts` |
| SUP-003 | first-party | `tests/support.test.ts`; */15 cron registered for staging |
| PM-005 | first-party | `tests/domain.test.ts`, `tests/projects.test.ts`, `tests/scheduled.test.ts`; policy on `/faq` and draft agreements |
| FIN-002 | first-party | `tests/finance.test.ts`, `tests/integrations.test.ts`, `tests/finance-documents.test.ts` |
| EMAIL-002 | first-party | `tests/email-templates.test.ts`: 20/20 required workflows in one typed, branded registry; preview at `/staff/email/templates` |
| PAY-005 | first-party | `tests/finance-documents.test.ts`, `tests/legal-commerce.test.ts`, `tests/tax.test.ts` (prints "pending" identity until IDENT-001/002) |
| PAY-003 | simulated provider | `tests/data.test.ts`, `tests/finance.test.ts` |
| PAY-006 | simulated provider | `tests/domain.test.ts`, `tests/data.test.ts`, `tests/finance-documents.test.ts` |
| PAY-007 | simulated provider | `tests/finance.test.ts`, `tests/domain.test.ts`, `tests/provider-contracts.test.ts`, journeys e2e |
| PAY-008 | simulated provider | `tests/finance.test.ts`, `tests/finance-documents.test.ts` |
| PAY-009 | simulated provider | `tests/integrations.test.ts`, `tests/finance-documents.test.ts` |
| PM-003 | simulated provider | `tests/portal.test.ts` |
| SALES-004 | simulated provider | `tests/crm.test.ts`, journeys e2e |
| PORTAL-008 | simulated provider | `tests/finance.test.ts` |
| CRM-007 | simulated provider | `tests/crm.test.ts`, `tests/voice.test.ts` |
| EMAIL-003 | simulated provider | `tests/integrations.test.ts`, `tests/platform.test.ts`, `tests/provider-contracts.test.ts` |
| VOICE-003 | simulated provider | `tests/voice.test.ts` |

Moved from **not started → in progress** (first-party groundwork exists): IDENT-001, IDENT-002, LEGAL-004, LEGAL-005
(tax configuration built), PAY-010, EMAIL-001, LAUNCH-001, PORT-001, PORT-002, PORT-003, PORT-005.

## 5–8. Remaining open requirements

Blocker type: **T** technical/observation, **E** external account/service, **H** hardware, **L** legal, **F** Founder-only.

| ID | Type | Why open | Action that unblocks it |
|---|---|---|---|
| TEST-004 | T | rehearsal + restore drill now run after every staging deploy; no run observed from this session | Founder (or a session with the Schmidt repo attached) confirms a green `staging-rollback-rehearsal` / `staging-restore-drill` run or the TEST-004 evidence at /staff/readiness |
| INFRA-006 | T/F | same drill evidence; recovery targets (RTO/RPO) blank | observe a drill run; Founder enters recovery targets |
| TEST-002 | E/F | 12 of 33 journeys need Stripe (5,6,7,17,19,24,25), voice (27,28) or launch (31–33) | Stripe test account; voice provider; LAUNCH-001 |
| READY-005 | E | push path verified on real staging (github feed healthy 22:42 UTC); code scanning needs GitHub Advanced Security | enable code scanning (admin), or the Founder accepts scans as out of scope |
| PAY-001 | E | needs a dedicated Stripe test-mode account and one real checkout | create account, add `STRIPE_SECRET_KEY` (sk_test) + `STRIPE_WEBHOOK_SECRET` to staging |
| PAY-004 | E/F | subscriptions need Stripe test run; maintenance entitlements unapproved | Stripe test account; Founder approves CAT-006 |
| EMAIL-001 | E | Resend account + verified domain + one real delivery | verify domain in Resend; add `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` |
| FILE-001, PORTAL-004 | E | R2 not enabled on the Cloudflare account | enable R2; next deploy binds the bucket |
| SEC-003 | E/F | no malware-scanning service | Founder chooses a scanner |
| VOICE-001, VOICE-002 | F/E | provider decision, budget and number purchase | Founder approves Retell + budget |
| VOICE-004..006 | E | guardrails/consent must be loaded into a real agent | after VOICE-002 |
| AIOPS-002, SUP-004 | H | no real local-model draft yet | install the runner on the Windows supercomputer |
| AIB-010, AIB-011 | H | nothing has run on the Windows host | WINDOWS-SUPERCOMPUTER.md → LOCAL-VALIDATION.md drills → Collect-Evidence.ps1 |
| INFRA-002 | F | production resources are created only with launch authorization | LAUNCH-001 |
| INFRA-005 | F | branch protection / required reviewers are repository settings | Founder configures GitHub settings |
| SEC-006 | F/L | retention periods need Founder/attorney approval | approve RETENTION-SCHEDULE.md |
| SEC-007 | F | an independent review/pen test is required (never self-certified) | commission the review |
| IDENT-001, IDENT-002, IDENT-005 | L/F | entity, registered address | form the entity; enter name/address in Business settings |
| IDENT-003, IDENT-004 (not started) | E/F | mailboxes and domain ownership | set up mailboxes; confirm domain under Crestmont control |
| LEGAL-001, LEGAL-002, LEGAL-004 | L | attorney review | engage an attorney |
| LEGAL-005 | L/F | tax registration/rates decided by the Founder with an accountant | record them at /staff/settings/tax |
| PAY-010 | F/L | live payments only after identity, legal and launch | IDENT/LEGAL + LAUNCH-001 |
| CAT-005, CAT-006 | F | maintenance entitlements | Founder approves or edits |
| SUP-005 | F | staffed hours | Founder sets them in Business settings |
| PORT-001..006 | F | genuine screenshots, relationship records, link verification | run `portfolio-screenshots.yml`, review, upload; document relationships |
| LAUNCH-001..003 | F | production authorization | Founder decision after the gates pass |

## Self-hosted AI runner (Workstream: runner hardening)

Zero-paid-AI default preserved (local Ollama provider; Agent SDK only as an explicitly enabled adapter; no fallback).
Done before machine access:
- **Dependency locking:** `runner/package-lock.json` + `npm ci`; sandbox Playwright via its own package.json; exact base-image tags.
- **Five host-only defects fixed:**
  - the proxy blocked the runner's CONNECT tunnel to Ollama;
  - Squid crash-looped when it dropped root;
  - the paid-API tripwire could pass with the proxy down;
  - the Windows driver-store version was misread, wrongly blocking NVIDIA hosts;
  - unvalidated allow-list hosts could inject proxy rules.
- **Resilience:** context-overflow shrink-and-retry, bounded timeout retry, cancellable backoff, lease watchdog, symlink-safe checkpoints, model reachability in `/health`.
- **Executed in the cloud workspace (not the Windows host):**
  - hadolint (0 findings);
  - pwsh 7.6 + PSScriptAnalyzer with 5.1 rules (0 findings);
  - `squid -k parse` on the rendered config;
  - stand-in images under the production docker flags: sandbox 11/12, runner image 10/11, egress end-to-end 37/37. The stand-ins were built from local binaries because Docker Hub was unreachable, so the 2 expected misses are stand-in artefacts.
- **CI:** builds the real images and runs the self-checks on every push (`runner-images`). Windows PowerShell 5.1 checks run only when the Windows kit changes, to limit Windows-runner minutes.
- **Still needs the Windows host:** GPU/model choice and throughput, Docker Desktop forwarding to Ollama, real image builds on the host, and LOCAL-VALIDATION §0–§6 (tripwire, real Starter build, cancel/crash drills, evidence).

## 9. Verified staging status

- Staging `https://crestmont-platform-staging.partners-df4.workers.dev` is live behind the preview gate; public
  `/api/readiness/health` returned `ok` at 22:55 UTC with all three feeds healthy: `ci` (22:43), `staging_e2e` (22:42) and
  `github` (22:42 — the new READY-005 snapshot, posted by the real deploy workflow with its read-only token, which also
  shows the deploy carrying READY-006's metrics and timings went out).
  These show evidence was *received*; per-test outcomes are visible to staff at /staff/readiness.
- This session cannot read GitHub Actions for the Schmidt repository (the same-named repository attached to this session
  occupies the checkout path), so individual run results were not observed here.

## 10. Remaining production launch gates

Readiness gates A–F at /staff/readiness/gates; production stays blocked on: Founder launch authorization (LAUNCH-001),
legal identity and attorney review (IDENT-001/002, LEGAL-004), tax (LEGAL-005), Stripe live activation (PAY-010),
independent security review (SEC-007), branch protection (INFRA-005), and production environment creation (INFRA-002).

## Addendum — continuation after `7bf8ead` (2026-10-27/28)

Engineering-only work done without external services, Founder decisions or the supercomputer:

| Commit | Change | Why |
|---|---|---|
| `4ad178c` | Required `scheduler` feed on staging/production; `scripts/verify-crons.ts` re-registers missing cron triggers during the staging deploy; `recovery:rollback|restore:<env>` feeds from drill evidence; ASVS F-08 enforced (no cookie session for any `/api/*` write); `env_metrics` 90-day retention; Dependabot ignores major Node image bumps | **Defect found:** the public health feed showed no `job:*` entries on staging, i.e. the cron-triggered jobs (Stripe retry, support escalation, inactivity, retention, build sweep…) had never recorded a run there, while health reported `ok` |
| `069bec0` | Stripe requests pinned to `2025-02-24.acacia`; webhook handling accepts basil+ shapes (`src/domain/stripe-shapes.ts`); `invoice.paid` without a payment link resolves it via the pinned API or fails for retry; documented webhook version + event list (test-enforced) | **Defect found:** no `Stripe-Version` was sent; Stripe `2025-03-31.basil` removed `Invoice.payment_intent/charge/subscription` and `Subscription.current_period_end`, so on a new account milestone payments would lose their PaymentIntent link (refunds/disputes unmatched) and subscription events their subscription id |
| `95bb65b` | Scheduler feed treats a never-run daily job as pending while the 15-minute jobs run | avoids alerting every 30 min for up to 24 h after a trigger repair |

Tests: 353 unit/integration (was 344), all passing. Requirement totals unchanged: original 111 / 41 / 2, addendum 9 / 2 / 0
(120 of 165, 72.7%). TEST-004 closes when the new `recovery:*:staging` feeds show passed runs.
