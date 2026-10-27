# AI Builds — automated first builds for paid intakes

**Status:** the control plane is implemented and tested with controlled fixtures. **Execution is unavailable** until the
Founder provisions a build runner (`RUNNER-SETUP.md`). No real Claude build has run; do not describe it as operational
until a real end-to-end staging run succeeds (requirement AIB-011).

## Architecture
- **Control plane (Cloudflare Worker, D1):** `src/services/builds.ts`, `src/routes/builds.ts`, `migrations/0031_ai_builds.sql`.
  Eligibility, durable queue (`build_jobs`, unique per order/revision, one active build per project), leases and heartbeats,
  budgets/runtime/turn limits, state transitions with reasons (`build_events`), brief snapshots (`build_briefs`),
  requirement checklist (`build_requirements`), attempts (`build_runs`), owner controls, notifications.
- **Runner (separate Node process, official Claude Agent SDK):** `runner/`. Pulls jobs over the signed protocol
  (`RUNNER-PROTOCOL.md`), works in an isolated per-job workspace with a per-customer repository and preview credentials,
  reports usage at each heartbeat and stops when the platform says so. Workers cannot host the Agent SDK, so the runner runs
  on a container/VM host.

## When a build starts
A first build is queued automatically when all hold (re-checked on payment, intake, refunds, disputes, cancellation and every 15 min):
1. the project's customer organization has a verified customer admin;
2. the package (or accepted quote scope) is recorded server-side;
3. required onboarding is submitted;
4. the order's first invoice — 100% upfront, or the 50% deposit for milestone quotes — was marked paid by a **verified Stripe webhook**
   (`checkout.session.completed` only when `payment_status` is `paid`, `checkout.session.async_payment_succeeded`, or `invoice.paid`);
5. no approved/issued refund, no dispute, project not cancelled/completed.

Projects created before automation was enabled (`build_settings.auto_start_after`) never start on their own: the Owner backfills
selected projects. Staging sample data is excluded the same way.

## Operations (Owner → AI builds)
- Pause all automation or one project; cancel; retry; resume a saved session; submit a revision; approve a preview.
- Limits: per-run and per-project (cumulative, revisions included) spending, runtime, turns, concurrency, attempts, model.
- Approving a preview records the decision only. Nothing here publishes to production, changes domains, charges customers,
  emails customers or migrates production databases.

## Contracts
- Runner protocol: `RUNNER-PROTOCOL.md` · Frontend: `FRONTEND-CONTRACT.md` · Runner setup: `RUNNER-SETUP.md` · Starters: `STARTERS.md`.
