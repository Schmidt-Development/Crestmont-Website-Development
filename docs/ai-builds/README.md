# AI Builds — automated first builds for paid intakes

**Status:** the control plane is implemented and tested with controlled fixtures. **Execution is unavailable** until the
Founder provisions a build runner. The default runner uses a **self-hosted model on the company's Windows build
machine** (`WINDOWS-SUPERCOMPUTER.md`, zero per-token fees). The Claude Agent SDK is an optional, explicitly enabled
paid adapter. No real build has run on either provider. Do not describe AI builds as operational until the controlled
validation (`LOCAL-VALIDATION.md`) and a real end-to-end staging run succeed (requirement AIB-011).

## Architecture
- **Control plane (Cloudflare Worker, D1):** `src/services/builds.ts`, `src/routes/builds.ts`, `migrations/0031_ai_builds.sql`.
  Eligibility, durable queue (`build_jobs`, unique per order/revision, one active build per project), leases and heartbeats,
  budgets/runtime/turn limits, state transitions with reasons (`build_events`), brief snapshots (`build_briefs`),
  requirement checklist (`build_requirements`), attempts (`build_runs`), owner controls, notifications.
- **Runner (separate Node process):** `runner/`. Pulls jobs over the signed protocol (`RUNNER-PROTOCOL.md`), works in
  an isolated per-job workspace with a per-customer repository and preview credentials, reports usage at each heartbeat
  and stops when the platform says so. Agent providers (`runner/src/providers/`):
  - `local` (default): in-house tool-using agent against a self-hosted, OpenAI-compatible model server (Ollama).
    Commands, installs, checks and browser checks run in a separate restricted container per build. Cost is $0;
    tokens and model time are reported. When idle, the runner also serves the platform's short AI drafts (`ai_jobs`)
    with the same local model.
  - `claude-agent-sdk` (optional, paid): the original Agent SDK adapter. It needs `RUNNER_ALLOW_PAID_PROVIDER=true`
    on the runner **and** `BUILD_ALLOW_PAID_PROVIDER=true` on the Worker (the platform gives no work to a runner that
    does not declare zero token cost), and is never an automatic fallback.
  Deployment: `WINDOWS-SUPERCOMPUTER.md` (Windows + WSL 2 + Docker Desktop, outbound-only, no public port).

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

## Customer revisions and previews (2026-10-28)
- A customer's revision request (portal → Revisions; the existing allowance and change-order rules decide whether a
  round may be worked on) reaches the AI builder according to the Owner's policy: `off`, `owner_approval` (default:
  the request waits in Owner → AI builds until an owner forwards it, optionally editing the instruction) or `auto`.
  One live AI build per request; a failed one can be sent again. Approving the AI result never delivers it: staff
  deliver the round from the project's Revisions tab, which notifies the customer.
- Each build gets its own preview Worker on a separate preview account; previews are deleted on owner request or
  after an optional retention period, by the runner. Setup: `PREVIEW-DEPLOYMENT.md`.

## Contracts
- Runner protocol: `RUNNER-PROTOCOL.md` · Frontend: `FRONTEND-CONTRACT.md` · Runner setup: `RUNNER-SETUP.md` · Starters: `STARTERS.md`.
- Windows build machine (local model, default): `WINDOWS-SUPERCOMPUTER.md` · Validation plan: `LOCAL-VALIDATION.md`.
- Founder order of work for the first real build (decisions, install, known installer issues): `FOUNDER-RUNNER-INSTALL.md`.
- Preview account, lifecycle and secret inventory: `PREVIEW-DEPLOYMENT.md`.
