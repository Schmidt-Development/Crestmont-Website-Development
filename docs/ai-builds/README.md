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

## Founder architecture V3 (2026-10-28): Claude-only orchestration
`ORCHESTRATOR.md`. Three Claude Code builder workers on Node 1 (one Claude plan account each, one website each, a fourth
website queues), each running architect → builder session(s) → tests → separate Claude reviewer → corrective cycles,
with approvals, an integrations checklist and the Builder accounts / Pipeline dashboard. Provider kind `claude-code`
(`runner/src/providers/claude-code-cli.ts`) with subscription sign-in only; metered credentials are refused. OpenAI /
Codex paths were removed. **Release gate blocked:** live use on consumer Max accounts for customer builds needs the
Founder decision in `ORCHESTRATOR.md` §9.4. The local-model provider stays available and Ollama is optional.

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
- Approving a preview records the decision only. Publishing a customer site is the separate, Owner-authorized
  release workflow of `DELIVERY.md`; nothing here changes Crestmont's own production, charges customers or migrates
  production databases.

## Founder decisions (2026-10-28)
| # | Decision | Implementation |
| --- | --- | --- |
| D1 | Owner approval of customer revisions | Requests wait in Owner → AI builds; *Approve and start AI build* queues one build (existing queue, no duplicate jobs); *Reject* (reason sent to the customer) starts nothing and does not use a round. Identical resubmissions are not new rounds; failed/canceled builds stay eligible. Tenant-scoped, audited; the portal shows Awaiting review / In progress / Not accepted. Automatic mode exists but is off by default. |
| D2 | Preview retention: 30 days after final approval | `PREVIEW-DEPLOYMENT.md` §3: in-progress and in-review previews never expire; the approved one is kept until its production deployment is verified; never the only recoverable copy; dates shown; preserve/extend; scheduled, audited, retried. |
| D3 | Private previews with authentication | `PREVIEW-DEPLOYMENT.md` §2a: runner-generated gate + platform-signed 5-minute links (staff, or the project's own customer for a shared preview). $0; Cloudflare Access not needed. |
| D4 | Native Windows Ollama | `WINDOWS-SUPERCOMPUTER.md` "Founder decision D4": inference on the host (localhost only), sandbox without network, runner reaches the model through the egress gateway; model + GPU residency health check. **Not yet validated on the Founder's hardware.** |
| D5 | Owner-controlled customer production delivery | `DELIVERY.md`: prepare → explicit Owner authorization (MFA step-up) → runner deploy to `cm-site-<project>` → verification → versions, rollback, audit. Framework only; nothing deployed. |

## Contracts
- Runner protocol: `RUNNER-PROTOCOL.md` · Frontend: `FRONTEND-CONTRACT.md` · Runner setup: `RUNNER-SETUP.md` · Starters: `STARTERS.md`.
- Windows build machine (local model, default): `WINDOWS-SUPERCOMPUTER.md` · Validation plan: `LOCAL-VALIDATION.md`.
- Founder order of work for the first real build (decisions, install, known installer issues): `FOUNDER-RUNNER-INSTALL.md`.
- Preview account, private access, lifecycle and secret inventory: `PREVIEW-DEPLOYMENT.md`.
- Customer production delivery: `DELIVERY.md`.
- V3 Claude-only orchestrator, provider authorization gate, Node 1 Claude setup: `ORCHESTRATOR.md`.
