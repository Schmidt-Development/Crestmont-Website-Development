# AI Builds — frontend API and state contract (v1)

Backend owner: the backend session (`src/routes/builds.ts`, `src/services/builds.ts`). The frontend design session may
restyle or replace the server-rendered pages `/staff/builds` and `/staff/builds/:id`, but should keep every action
posting to the same endpoints (CSRF token `_csrf` as on every staff form) so authorization, auditing and state rules stay
server-side. All amounts are USD numbers; all timestamps ISO-8601 UTC.

## States (`src/domain/builds.ts`)

| state | label | meaning | owner actions |
|---|---|---|---|
| `awaiting_intake` | Awaiting intake | verified payment, intake not submitted | cancel |
| `awaiting_payment` | Awaiting payment | intake submitted, qualifying payment not verified | cancel |
| `queued` | Queued | eligible; waiting for runner capacity | cancel |
| `preparing` / `building` / `verifying` | Preparing / Building / Verifying | leased by a runner | cancel (stops at next heartbeat), pause |
| `needs_information` | Needs information | stopped on a blocker only a person can resolve | resume, revision, cancel |
| `ready_for_review` | Ready for owner review | preview delivered to owner review | approve (Owner), revision, cancel |
| `approved` | Approved for delivery | owner approved the preview for the existing delivery process | revision |
| `failed` | Failed | attempts exhausted | retry, resume (if a session/source exists), cancel |
| `budget_paused` | Budget paused | stopped at a spending/runtime/turn limit; partial work kept | resume (after raising the limit), cancel |
| `paused` | Paused | owner pause while active | resume, cancel |
| `canceled` | Canceled | owner cancel, refund, dispute or project cancellation | — |

Build stages and completion are separate: completion is the requirement checklist, never a percentage. Each requirement
is `remaining`, `implemented_unverified`, `verified` (only with evidence of a check that ran) or `blocked` (with a blocker).
If a percentage is ever shown it must be `verified / total` from this checklist, labelled as an estimate.

## Read endpoints (staff session; `builds.read`: Owner, Administrator, Project Manager)

`GET /api/builds?state=&q=&page=` →
```json
{ "settings": { "automationEnabled": true, "globallyPaused": false, "pauseReason": null, "autoStartAfter": "…",
                "runBudgetUsd": 25, "projectBudgetUsd": 75, "maxRuntimeMinutes": 120, "maxTurns": 200,
                "maxConcurrent": 2, "maxAttempts": 3, "model": "claude-sonnet-5-5" },
  "runner": { "runner_id": "…", "version": "…", "last_seen_at": "…", "capabilities": ["local-model","zero-token-cost","…"], "zeroCost": true, "online": true } | null,
  "builds": [ BuildSummary ], "hasMore": false }
```
`BuildSummary`: `id, projectId, projectName, organizationName, orderId, kind ("first_build"|"revision"), revision, packageId,
strategy ("standard"|"custom"), state, stateLabel, stateReason, eligibility { verdict, reasons[] }, startedAt, finishedAt,
heartbeatAt, elapsedSeconds, costUsd, projectSpendUsd, runBudgetUsd, projectBudgetUsd,
requirements { remaining, implemented_unverified, verified, blocked }, previewUrl, source { repo, branch, commit },
attempts, maxAttempts, cancelRequested, projectPaused, updatedAt`.

`GET /api/builds/:id` → `{ summary, requirements[ {key,label,status,evidence,blocker,updated_at} ], events[ {id,at,kind,from_state,to_state,message,actor_kind,actor_user_id} ],
runs[ {attempt,runner_id,started_at,ended_at,outcome,cost_usd,turns,session_id,error} ], brief {id,version,sha256,created_at}, report (markdown),
missingInformation[], instruction, kind, revision, agentSessionId, checkpointAvailable }`. Event messages are sanitized server-side.

## Actions (form POST, `_csrf`, redirect with a flash message)

| endpoint | permission | fields |
|---|---|---|
| `POST /staff/builds/pause` | builds.manage | `paused` = `1`/`0`, `reason` (required to pause) |
| `POST /staff/builds/settings` | builds.configure (Owner) | `run_budget`, `project_budget`, `max_runtime`, `max_turns`, `max_concurrent`, `max_attempts`, `model`, `automation_enabled` |
| `POST /staff/builds/backfill` | builds.configure | `project_id` |
| `POST /staff/builds/projects/:projectId/pause` | builds.manage | `paused`, `reason` |
| `POST /staff/builds/projects/:projectId/budget` | builds.configure | `project_budget` |
| `POST /staff/builds/:id/cancel` | builds.manage | `reason` |
| `POST /staff/builds/:id/retry` / `resume` | builds.manage | — |
| `POST /staff/builds/:id/revision` | builds.manage | `instruction` (10–5000 chars) |
| `POST /staff/builds/:id/approve` | builds.configure | `notes` |

## Customer-facing

`GET /portal/projects/:id/build-status` (customer session, own organization only) → `{ "status": "In progress" | "Scheduled" | … | null, "updatedAt": "…" | null }`.
Wording from `BUILD_STATE_CUSTOMER`. Never show prompts, logs, costs, previews in progress or other customers' data.
