# Engineering checkpoint — 2026-10-27 (overnight run)

Durable handoff for the Founder and the next session. Branch: `main` (GitHub `Schmidt-Development/Crestmont-Website-Development`).
Staging: https://crestmont-platform-staging.partners-df4.workers.dev (behind the preview password).

## 1. Completed and verified

| Area | What | Verification |
|---|---|---|
| Staging access | Derived, always-in-sync preview + demo credentials; one-time rotation; full live sequence verified before any access artifact | tests/staging-access.test.ts; staging `/api/readiness/health` reports staging E2E evidence received (11:07 UTC) |
| Security | Route matrix over every route (anonymous, pre-MFA, roles, tenants, audit, fuzz); 16 defects fixed | tests/security-*.test.ts |
| Finance | PDF invoices/receipts, Stripe Invoice adapter (fixtures only), ledger/payout reconciliation, AI cost attribution, exports | tests/finance-documents.test.ts |
| Owner modules | CRM dedupe/merge, quotes, project closure checklist, workload, CMS versions, reports, portal notifications/maintenance/team | tests/owner-*.test.ts |
| Staging journeys | 21 of 33 required journeys automated against staging (12 skipped with blockers); content + axe accessibility checks | tests/e2e/staging-*.e2e.ts (run by the deploy workflow) |
| Hardening | Breached-password check, egress allowlist, PII redaction, per-user action limits, live unread counts | tests/asvs-hardening.test.ts, tests/live-and-limits.test.ts |
| Legal drafts | Custom development + maintenance agreements, DPA, privacy accuracy; acceptance at the right steps | tests/legal-commerce.test.ts |
| AI Builds control plane | Eligibility, durable queue, leases, budgets, owner controls, brief snapshots, JSON/state contract | tests/builds.test.ts (controlled fixtures — **no real Claude build has run**) |
| AI Builds runner | `runner/`: Agent SDK 0.3.310, isolated workspaces, starter, curated skills, checkpoints, previews, owner report | 42 mock tests in CI (fake SDK + fake control plane) — **never run against a real model** |
| Restore drill | Weekly/manual staging export → scratch restore → row-count evidence | tests/restore-drill.test.ts (workflow not yet executed) |

Requirement ledger (computed from `requirements/status/*`): original registry **83 implemented / 58 in progress / 13 not started (154)**;
AI Builds addendum **9 implemented / 2 in progress / 0 not started (11)**.

## 2. Remaining engineering (independent of the Founder)
- Worker rollback rehearsal on staging (TEST-004).
- After the runner is provisioned: lockfile for `runner/`, a per-job container (stronger isolation than one OS user),
  and confirming the Docker sandbox flags (see "Residual risks" in `docs/ai-builds/RUNNER-SETUP.md`).
- Remaining items are otherwise blocked on the owner actions below.

## 3. Owner actions — ordered by what they unblock

| # | Action | Unblocks | Exact steps |
|---|---|---|---|
| 1 | **Provision the AI Builds runner** | AIB-010/011 (any real automated build) | Follow `docs/ai-builds/RUNNER-SETUP.md`: a Linux VM with Docker (2 vCPU / 4 GB / 40 GB); an Anthropic Console workspace with a monthly spend limit and an API key (not a claude.ai subscription); `openssl rand -hex 32` → GitHub repository secret `BUILD_RUNNER_SECRET` (the next staging deploy installs it) and the same value for the runner; optional dedicated GitHub org + fine-grained token for build repos; optional separate Cloudflare account/token for preview Workers; review `runner/skills/manifest.json`; first run: one internal Starter project with a $5 project limit. |
| 2 | **Stripe test account** (BLK-004) | Checkout, Stripe invoices, refunds, disputes, reconciliation; AI Builds end-to-end test payment; journeys 5–7, 17, 19, 24, 25 | Create a dedicated Crestmont Stripe account, stay in test mode, add `STRIPE_SECRET_KEY` (sk_test_…) and `STRIPE_WEBHOOK_SECRET` as staging Worker secrets, point a test webhook at `/api/webhooks/stripe`. |
| 3 | Resend + business email (BLK-005, IDENT-003) | Real email delivery, EMAIL-001..003 | Verify the sending domain in Resend; add `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` to staging. |
| 4 | Legal entity, address, attorney review, tax (IDENT-001/002, LEGAL-004/005) | Live payments (PAY-010), final legal pages | Provide the entity name and registered address in Business settings; engage an attorney for the drafts in `/legal`. |
| 5 | Maintenance plan contents (CAT-006/BLK-010), staffed hours (SUP-005) | Maintenance sales, support policy | Approve or edit the proposed entitlements; set staffed hours in Business settings. |
| 6 | Voice provider decision (BLK-009) | VOICE-001..006, journeys 27–28 | Approve Retell (recommendation in docs/voice/) and a budget. |
| 7 | Portfolio screenshots + relationship records (BLK-007/008) | PORT-001..006 | Provide or approve genuine screenshots and the relationship statement per business. |
| 8 | External alerting channel (ASVS F-03), malware scanning (F-02), independent pen test (F-16) | SEC-007, INFRA-006, SEC-003 | Choose an alert destination; choose a scanning service; commission a review. |
| 9 | Production launch authorization (LAUNCH-001) | Production | Only after the above; the release gate stays in place. |

## 4. How to resume
- Pull `main`; run `npm run -s typecheck && npm test` (all pass at this checkpoint) and `npm run e2e`.
- Staging deploys automatically on push to `main`; the newest **staging-preview-access** artifact holds working credentials.
- After action 1: set `BUILD_RUNNER_SECRET`, start the runner, then in **Owner → AI builds** backfill one test project and watch it
  through to owner review. Record the run as AIB-011 evidence only if it is a real provider-backed run.
