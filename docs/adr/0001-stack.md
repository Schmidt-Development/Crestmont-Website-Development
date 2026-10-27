# ADR 0001 — Platform stack

**Status:** Accepted (engineering) · 2026-10-26

## Decision

| Concern | Choice | Why |
|---|---|---|
| API runtime | Cloudflare Workers (`src/worker.ts`) | Directive §61 Cloudflare-first; global edge, no servers to patch |
| Relational DB | Cloudflare D1 (SQLite) | Native to Workers, real constraints/indexes/transactions via `batch`. Revisit if write volume or reporting outgrows D1 (escape hatch: Postgres via Hyperdrive — schema is portable SQL) |
| Files | R2, private bucket, signed URLs | §65; never public by default |
| Async work | Cloudflare Queues | Stripe event application, email retries, AI jobs, reconciliation |
| Bot defence | Turnstile on public forms; fails closed outside development | §64 |
| Auth | Managed provider (candidate: Clerk or Auth0 — needs Founder cost approval) behind the `resolveActor` seam | Managed MFA, recovery, sessions (§17); the platform enforces authorization itself |
| Payments | Stripe Checkout + Billing + Customer Portal, webhooks as the only source of payment truth | §22 |
| Email | Resend with verified domain | §55 |
| Voice | Pending provider evaluation (BLK-009) | §51 |
| Frontend | Workers static assets + server-rendered pages for public site; SPA for dashboards. Built in CI (registry unavailable in this workspace, BLK-012) | |

## Code conventions

- TypeScript run natively by Node ≥22.18 (type stripping) for tests and scripts; no transpile step for domain code. Only erasable syntax (no enums, no parameter properties).
- Domain rules live in `src/domain/*` as pure functions; services in `src/services/*` do I/O. Every rule that encodes a Founder decision has a test tagged with its requirement ID.
- Money is integer cents. Unknown costs are `NULL`, never `0` (§57).
- All SQL is parameterised. Audit log is append-only at the database level (triggers).
- Tests run against the real migrations through a node:sqlite D1 adapter (`tests/support/sqlite-d1.ts`).

## Readiness evidence pipeline

`npm test` → custom reporter maps `[REQ-ID]` tests to requirements → `evidence/ci-evidence.json` → CI signs (HMAC, timestamped) → `POST /api/readiness/evidence` → stored idempotently by run id → `buildReport()` computes statuses, separate score dimensions and gates A–H. Implementation status comes only from explicit records in `requirements/status.ts`; passing tests never promote it.
