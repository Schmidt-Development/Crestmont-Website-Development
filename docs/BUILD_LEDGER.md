# Crestmont Build Ledger

Persistent record so any engineering session can resume (§72). Authoritative status is computed by the readiness engine; this file records decisions, context and next actions.

## Session 1 — 2026-10-26

### Discovery findings
- **Logo:** not supplied in the workspace → BLK-001. No substitute was made.
- **GitHub:** no Crestmont repository exists. Accessible repos: better-lansing-mechanics, lansing-car-rentals, Headquarters, glassly (none modified). This session cannot create repos (gh token invalid) → BLK-002. Code lives in the workspace and is delivered as an archive until a repo is provided.
- **Domain:** crestmontwebsitedevelopment.com could not be verified (fetch disallowed by robots, shell egress denied) → BLK-011.
- **Portfolio sites** (read via web fetch, text only; no screenshots yet):
  - betterlansingmechanics.com — resolves. Auto repair shop, Lansing MI; site names *Noahs Consulting LLC* as operator. Has services catalogue, Spanish version, customer login/portal, callback form, before/after sliders. Site itself states online appointments, phone/AI receptionist and SMS are not yet active.
  - lansingcarrentals.com — resolves. Single-page site; booking via links to Turo; partner application page; site names *Akelle Richmond* as owner. Contains owner-reported fleet figures — do **not** repeat them as Crestmont claims.
  - mentorship.lansingcarrentals.com — resolves. Single-page booking for a paid 30-minute call; Stripe-hosted checkout; no-refund policy.
  - Screenshots blocked: workspace egress denies these domains and the linked computer's browser did not respond → BLK-007. Relationship of each business to Crestmont needs documentation → BLK-008.
- **Workspace limits:** npm/pypi registries unreachable → no third-party packages. Everything so far is dependency-free and runs on Node 22 built-ins.

### Built and verified (development only)
Requirements inventory (154 items), full relational schema (2 migrations), readiness engine + signed CI evidence ingestion, CSV export, server-side catalog/pricing, CRM and project state machines, revision/inactivity/release rules, permissions with MFA and tenant checks, refund workflow rules, Stripe webhook verification + idempotent event store, lead capture API. 35 tagged tests pass; typecheck clean. No staging or production environment exists.

Readiness snapshot (computed, not hand-entered): 11/154 implemented · 34/154 have passing dev evidence · 24 blocked · 0 staging · 0 production. Gates A, C–G fail; H not evaluable. **Not production-ready.**

### Founder decisions needed
1. Create the private repo and grant access (BLK-002).
2. Upload the original logo (BLK-001).
3. Cloudflare account + scoped API token (BLK-003); Stripe test account (BLK-004); Resend + mailbox provider (BLK-005).
4. Approve or amend proposed maintenance entitlements in `src/domain/catalog.ts` (BLK-010) — overage rates there are proposals.
5. Document Crestmont's relationship to the three portfolio businesses (BLK-008).
6. Choose managed auth provider (cost approval).
7. Voice provider: recommendation to follow once account access exists; no number will be purchased before approval (BLK-009).

### Next actions (engineering)
1. Push to the repo; enable branch protection; let CI produce the first real `gh-*` evidence run.
2. Provision dev/staging D1 + R2; deploy the API to staging; point CI evidence at it.
3. Capture genuine portfolio screenshots via browser automation once a browser or egress is available.
4. Design system + public site (Phase 4–5), then auth wiring, Stripe test checkout, customer portal.
5. Readiness dashboard UI and Founder approval panel.

## Session 2 — 2026-10-26 → 27

### Repository and CI
- Foundation verified (154 requirements, 35 tests, migrations, readiness engine, ledger) and imported to the private repo. Repo later **transferred to `Schmidt-Development/Crestmont-Website-Development`** (Enterprise). This session lost access at the transfer (git 403 / API 404) and cannot attach the org repo because a same-named repo is already attached. **Last commit on GitHub: `6b1cb3e`.** Commits `57145fb` and `a9fe428` (+ this ledger commit) exist only locally and in the delivered git bundle — the next session must push them.
- **BLK-013 open.** Every GitHub Actions run from `8bec22d` through `6b1cb3e` was refused before any job started: "recent account payments have failed or your spending limit needs to be increased" (last observed: run 40443419501, 2026-10-27 03:18 UTC, after the Founder reported the payment as settled). No run has executed under the Enterprise organization yet. Close BLK-013 only after a run with real job logs succeeds there.
- CodeQL is a separate workflow (needs GitHub Advanced Security on private repos; Enterprise may now provide it).

### Built (all integrated on `main`, verified locally)
Core pipeline (router, escaping templates, CSRF, CSP), design system, in-platform auth (PBKDF2, TOTP MFA required for staff with replay protection, idle + absolute session limits, lockout, rate limits, invitations), Stripe test-mode adapter (live keys refused) + webhook application, email adapters (Resend / dev outbox), bounded AI drafts; public website (all §11 pages), CMS, portfolio management; customer portal and project management; CRM, quotes, checkout, billing, refunds, disputes, finance; support, Owner overview, Launch Readiness Command Center UI; platform admin, AI operations, AI receptionist webhook + guardrails, privacy requests; scheduled jobs; ops docs (ASVS self-review, runbook, backup & recovery, voice provider evaluation). Official logo stored byte-identical; crest shown at exactly 2x density.

### Evidence at `a9fe428` (local runs — environment "development", not GitHub Actions)
- 183 unit/integration tests + 25 real-Chromium journeys (21 §69 journeys + 4 core): 207 passed, 0 failed.
- Readiness (computed): 67/154 implemented · 105/154 passing dev evidence · 22 blocked · 0 staging · 0 production. Gates A, C, D, E, F, G fail; B passes on local evidence only; H not evaluable. **Not production-ready.**
- 12 open blockers; 17 security findings recorded (3 resolved, 2 accepted risk, 12 open — 5 release-blocking).

### Not exercisable yet (no accounts / environments)
Real Stripe checkout, subscriptions, failed-payment recovery, refund issuance (BLK-004); email delivery (BLK-005); voice provider (BLK-009); staging/production deployment and health (BLK-003); GitHub data source in a deployed environment (BLK-013, token). These are covered by signed fixtures and honest "not configured" states, never presented as live.

### Founder decisions that block the next engineering actions
1. **Access for the new org:** install the Claude GitHub App on `Schmidt-Development` for this repo and start a session with it as source (blocks pushing `57145fb`+, CI verification, BLK-013).
2. **Cloudflare account + scoped API token** (blocks staging: D1, R2, Workers, cron, Turnstile, DNS — Gates D/E/H, BLK-003).
3. **Approve together:** maintenance entitlements in `src/domain/catalog.ts` (BLK-010) and authentication approach `docs/adr/0002-authentication-provider.md` (recommended: keep in-platform auth + Cloudflare Access for `/staff`, $0 under 50 staff).
4. **Stripe test-mode account** (BLK-004) and **Resend + mailbox provider** (BLK-005) for integration certification.
5. **Portfolio:** document Crestmont's relationship to the three businesses (BLK-008) and either allow the three domains in Settings → Capabilities or provide another genuine capture route (BLK-007).
Not blocking the next step: voice provider approval (`docs/voice/PROVIDER-EVALUATION.md` recommends Retell, separate workspace), legal entity/attorney review (BLK-006, blocks Gate F and live payments), vector logo (BLK-014).

### Next actions (engineering)
1. In a session with org access: push local commits, re-run CI, fix any real CI issue, record GitHub run evidence (`gh-*` run ids), close BLK-013 only on a green executed run.
2. With Cloudflare access: create staging D1/R2, apply migrations, deploy staging, set secrets, run the e2e suite against the staging URL with EVIDENCE_ENVIRONMENT=staging, post evidence.
3. Remaining in-progress items (see `requirements/status/*.ts` "missing" notes): malware scanning, external alerting, breached-password check, UTM attribution, PDF receipts/quotes, Resend delivery webhooks, provider adapter for the chosen voice platform.

## Session 3 — 2026-10-27 (staging preview priority)

- **Preview gate** (`src/app/preview-gate.ts`): HMAC pass cookie, constant-time password check, D1-backed rate
  limit and security events, fail-closed on deployed staging (`PREVIEW_GATE = "required"`), never active in production.
- **Self-provisioning staging deploy** (`deploy-staging.yml`): needs only `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`; creates D1, applies migrations, deploys, sets/rotates secrets, seeds, smoke-checks,
  writes a private access artifact. Founder steps: `docs/STAGING-PREVIEW.md`.
- **Sample data** (`scripts/seed-staging.ts`): generated through the real services (403 rows, 86 tables,
  8 demo accounts on the reserved `.test` domain).
- **Staging browser journey** (`tests/e2e/staging.e2e.ts`, TEST-002): runs in the deploy workflow on seeding
  runs and records staging evidence; rehearsed locally against the dev server with the gate on (pass).
- Status: preview not yet live — waiting on the two Cloudflare secrets (no other blocker).
- **Preview-password mismatch (deploy #4) fixed at the root**: the password was only (re)issued when the Worker
  secret looked missing or on request, so later runs could overwrite it while an earlier artifact kept the old
  value, and an artifact could be uploaded without the password ever being proven on the live site; reseeding
  also issued demo credentials that `INSERT OR IGNORE` never applied. Now `scripts/staging-access.ts` derives the
  preview password and all demo credentials (HMAC of the Cloudflare token secret + D1-stored salt) and re-applies
  them every run; `scripts/verify-staging-access.ts` proves preview password → Owner sign-in → 2FA → 32 modules on
  the live site before the artifact is issued. ACCESS_EPOCH 2 forces a one-time rotation of everything (old
  sessions revoked). The raw D1 export artifact (which held demo hashes and 2FA keys) was replaced by a Time
  Travel bookmark.

### Session 3, first-party backend closeout (2026-10-27)

- **Security matrix** (AUTH-007, AUTH-008, EMP-002, SEC-001 implemented): all 340 routes classified in
  `tests/support/route-inventory.ts`; anonymous, pre-MFA, role, tenant (every id-bearing route replayed with another
  customer's ids), audit (every audited action performed and its entry checked) and fuzz tests. 16 defects fixed,
  including pre-MFA access to password/session/file routes and live reset links visible in staff email views.
- **Finance** (PAY-005/006/008/009, FIN-002): zero-dependency PDF invoices and receipts, Stripe Invoice adapter for
  50/25/25 milestones (contract-tested against fixtures; never called live), ledger/payout reconciliation job,
  project attribution of AI costs, search/filter/export across finance modules. Migration 0015.
- **Owner modules**: CRM duplicate detection and merge, quote withdraw/lapse, project closure checklist, employee
  workload/capacity, CMS compare/discard/restore, operations reports, portal notifications/maintenance/team
  management, CSV exports everywhere. Migration 0016.
- **Staging journeys** (TEST-002): 21 of 33 journeys automated against the deployed preview (12 skipped with
  blocker ids); evidence reporter now records skipped tests as skipped.
- **Hardening**: breached-password check, egress allowlist, PII redaction, per-user action limits, live unread
  counts (passive polling), legal drafts round 2 (custom development + maintenance agreements, DPA). Migration 0030.
