# AI Website Builder: V3 orchestrator (Claude-only)

Founder directive V3 (2026-10-28). Claude-only: no OpenAI, ChatGPT, Codex, paid API or other paid AI anywhere.
This replaces the V2 "OpenAI architect / reviewer" design. D1–D5 (customer revisions, preview retention, private
previews, native Windows Ollama, Owner-controlled delivery) are unchanged; see README.md.

> **Release gate: BLOCKED (provider authorization).** The orchestration is implemented and tested with simulated
> Claude sessions. Running it live on the three consumer Claude Max accounts for unattended, customer-triggered
> commercial builds is **not clearly permitted** by Anthropic's published terms (section 9). Nothing in this
> repository works around that. The Founder decision needed is in section 9.4.

## 1. Flow

```
 Customer intake (paid) ──► Platform (Cloudflare Worker + D1)
                             │  build_jobs, build_workers, build_assignments, build_pipeline,
                             │  build_cycles, build_approvals, build_integrations
                             │  dispatcher: one website per account; a fourth website queues
                             ▼
 Node 1 (Windows, RTX 5090) — Docker Desktop
   egress-proxy (squid, allow-list) ◄── claude_net (internal network, no published ports, no docker.sock)
   claude-1  (worker wkr_…, account label partners@lansingcarrentals.com)
   claude-2  (worker wkr_…, account label headquartersenterpriseoperations@outlook.com)
   claude-3  (worker wkr_…, account label noahschmidt10@gmail.com)
     each = one runner process ("local orchestrator") + its own CLAUDE_CONFIG_DIR:
       claim ─► architect session (read-only) ─► SPEC.json / SPEC.md
             ─► builder session(s) (worktrees when sessions > 1)
             ─► automated tests (build, lint, Playwright, checks)
             ─► separate reviewer session (read-only, sees the evidence files)
             ─► platform referee (submitCycle) ─► corrective prompt ─► repeat
             ─► integrations checkpoint (WAITING_FOR_EXTERNAL_SETUP only when nothing else is left)
             ─► private preview (D3) ─► Founder approval ─► Owner-controlled delivery (D5)
```

The account emails are labels only. No password, token, cookie or session file is in the repository; each account
is signed in once by the Founder, interactively, into its own config directory on Node 1 (`C:\CrestmontRunner\claude\claude-N`).

## 2. KEEP / MODIFY / REMOVE audit (V2 → V3)

| Item | Decision | Notes |
|---|---|---|
| Runner protocol, leases, HMAC, checkpoints, resume | KEEP | unchanged |
| Sandbox (bubblewrap/seccomp), egress proxy, paid-AI tripwire | KEEP | claude_net only reaches the exact Claude Code hosts |
| D1–D5 (revisions, retention, private previews, delivery) | KEEP | unchanged |
| Local model provider (Ollama, OpenAI-compatible client to Ollama) | KEEP, optional | not needed in `-Provider ClaudeCode` mode; `openai-client.ts` only talks to the local Ollama endpoint |
| Builder worker registry, dispatcher, assignments | MODIFY | provider kinds `claude-code`, `local-model`; billing `subscription`, `zero-cost` only |
| Pipeline stages, cycles, referee, approvals, integrations | KEEP (V2 platform) | review decisions come from a Claude session or the deterministic reviewer |
| Migration 0043 | MODIFY (renamed `0043_ai_builder_v3_orchestration.sql`) | not applied to any shared DB yet, so edited in place; no `paid_spend_cap` |
| Codex / OpenAI architect and reviewer advisors | REMOVE | |
| LocalModel advisor | REMOVE | architect and reviewer are Claude sessions or (reviewer) deterministic |
| `openai-api` / `anthropic-api` worker kinds, `paid_spend_cap` | REMOVE | |
| Legacy paid Claude Agent SDK adapter (`claude-agent-sdk`) | KEEP, flagged | still refuses to start unless `RUNNER_ALLOW_PAID_PROVIDER=true` **and** an API key are both set; never set in V3. Founder may ask for it to be deleted |
| Cost guard | MODIFY | strips every metered credential variable from the Claude Code environment and refuses to start if one is present |

## 3. Orchestration design

**Sessions.** Each Claude call is a separate `claude -p` process with the worker's `CLAUDE_CONFIG_DIR`:

- Architect: `--output-format json --allowedTools Read Glob Grep --disallowedTools Edit Write NotebookEdit Bash WebFetch WebSearch Task`.
  Output is the `MasterSpec` JSON (validated on the runner and again by the platform) written to `SPEC.json` and `SPEC.md`.
- Builder: `--output-format stream-json --verbose --setting-sources project --permission-mode dontAsk`, with the
  project's `.claude/settings.json` pre-authorizing routine operations (edit files in the workspace, run `npm`, tests,
  git in the workspace) and denying everything else (secrets paths, network tools, destructive git). `--resume` continues
  a session after a checkpoint. No `bypassPermissions` anywhere.
- Reviewer: same read-only flags as the architect, in a **new** session. It reads the evidence files (build/test/lint
  logs, Playwright results, screenshots list, diff summary) that the runner wrote, not the builder's own claims.

**Referee.** `POST /api/builds/runner/cycles/submit` decides, not the reviewer: failing evidence overrules "ready";
each cycle gets a traceable next prompt. Loop guards: maximum cycles (`max_review_cycles`, default 8), the same failure
signature three times, or no score progress over three cycles → `ESCALATED` to staff.

**Multi-session.** When a worker's "sessions per website" is above 1, the spec's work items are layered by dependency;
each group runs in its own git worktree owning a set of paths, merged sequentially. A session that writes outside its
paths, or conflicts on merge, is discarded and its group re-run serially. Every session has a task, owner, output
contract (`BUILDER_CONTRACT`) and a completion record in the cycle's `sessions_json`.

**Approvals and integrations.** The builder requests approvals for anything outside routine work (credentials, external
accounts, privileged infrastructure, money, destructive operations, production, DNS, sensitive security choices) through
`approvals/request`; staff decide in the dashboard. Integrations (forms email, payments, analytics, …) are tracked in a
checklist; the runner never marks one live. A build only enters `WAITING_FOR_EXTERNAL_SETUP` after all independent work
is done.

## 4. Scheduler

- One website per account, enforced by unique partial indexes on active assignments; a fourth website waits in the queue.
- Ownership lasts the whole lifecycle; the assignment is released only at `ready_for_review`, `approved`, `canceled`
  or an Owner reassignment (authorized handoff).
- Order: a project keeps its previous worker when that worker is free (continuity); otherwise lowest **verified** usage
  first, then least recently assigned. Usage is only compared when it has a named source; otherwise it is "unknown" and
  never invented.
- Paused, stale (`worker_stale_minutes`) or rate-limited workers get nothing.

## 5. Usage limits and zero fees

- When Claude Code reports a usage limit (`system/api_retry` with `rate_limit`, or the limit text), the runner
  checkpoints (git + session id), reports `rate_limited_until`, and finishes the claim as `released` with `notBefore`.
  The platform requeues without spending an attempt, keeps the assignment, and refuses that worker's claims until the
  reset. The same session resumes later. There is no overage path.
- `assertNoMeteredEnv` refuses to start a Claude session if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock/Vertex
  or similar variables exist, because an API key takes precedence over the subscription login and would bill the
  Console account. The session environment is built from an allow-list, not inherited.
- Founder settings that the code cannot enforce: keep **extra usage turned off** on all three accounts; never put an
  API key on Node 1.
- Official usage telemetry: Claude Code's status line input carries `rate_limits.five_hour` / `seven_day`
  `used_percentage` and `resets_at` for Pro/Max. It is documented for the interactive status line, not for `-p`.
  Not wired yet; the dashboard shows usage as unknown until a verified source is connected (Node 1 follow-up).

## 6. Dashboard (Owner → AI builds)

- **Builder accounts** (`/staff/builds/workers`): register / remove workers (label = account email), one-time enrollment key,
  rotate key, pause / resume dispatch, sessions per website, status, usage with its source, rate-limit reset, current website.
- **Pipeline** (`/staff/builds/pipeline`): every website with its stage, worker, cycle count and last score; queue;
  pending approvals (approve / deny); integrations (mark live, staff only).
- **Project pipeline** (`/staff/builds/projects/:id/pipeline`): stage history, spec, cycles with evidence and verdicts,
  reassign to another worker. Changes need MFA step-up.

## 7. Security and isolation

- Worker containers: read-only root, `cap_drop: ALL`, `no-new-privileges`, pid/memory/cpu limits, no Docker socket, no
  published ports, internal network whose only exit is the proxy (Claude Code hosts, the platform, npm registry, approved extras).
- Agent commands run in Claude Code's own sandbox (`RUNNER_SANDBOX=on`, bubblewrap). Deny rules and the sandbox's
  `denyRead` cover `/run/secrets` and the worker's own Claude config directory (its sign-in); each container mounts only
  its own account's directory, so the other accounts are not reachable at all.
- Residual risks (Node 1 validation items):
  1. Docker's default seccomp profile may block the user namespaces bubblewrap needs; Claude Code then fails closed
     (sandbox error), it does not run unsandboxed. Validate on Node 1 before the first build.
  2. `../secrets` is mounted read-only into each worker; protected only by deny rules and the sandbox. A follow-up can mount
     only that worker's key file.
  3. `--max-turns` is not in `claude --help` of 2.1.312; the runner also enforces its own timeout. Validate on Node 1.

## 8. Tests

`node --test` in `runner/` (orchestrator.test.ts, claude-node.test.ts and others) and in the root (builds-v2.test.ts,
security matrix / tenancy). They exercise: lowest-usage dispatch and fourth-website queue, lifecycle ownership,
continuity, architect spec, multi-session worktrees and serial re-run, evidence-overrules-ready, loop guards and
escalation, approvals and integrations gating, usage-limit release and resume, metered-environment refusal, egress
allow-list, installer `-Provider ClaudeCode`. **All Claude sessions in tests are simulated** (injected process runner);
no live Claude account has been used.

## 9. Provider authorization (release gate)

### 9.1 What the published terms say (checked 2026-10-28)

- Consumer Terms §3: users may not access the Services "through automated or non-human means, whether through a bot,
  script, or otherwise", except with an API key or where Anthropic otherwise explicitly permits it.
  ([anthropic.com/legal/consumer-terms](https://www.anthropic.com/legal/consumer-terms))
- Consumer Terms §2: no sharing of account login details or making an account available to anyone else.
- Claude Code legal and compliance: OAuth (subscription) authentication is "intended exclusively for purchasers of Claude
  Free, Pro, Max …" and "designed to support ordinary use of Claude Code"; developers building products or services
  "should use API key authentication"; Anthropic does not allow third parties to route requests through Free/Pro/Max
  credentials on behalf of their users; advertised Pro/Max limits assume "ordinary, individual usage of Claude Code and
  the Agent SDK". Questions go to sales.
  ([code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance))
- Max plan usage is shared between Claude and Claude Code; an `ANTHROPIC_API_KEY` in the environment overrides the
  subscription and is billed; "extra usage" can be turned on and is billed.
  ([support.claude.com, using Claude Code with Pro/Max](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan))

### 9.2 Assessment

Running Claude Code headless (`claude -p`) from a script is documented and supported. What is not clearly permitted is
this combination: three consumer Max accounts run unattended by a service, triggered by paying customers' orders, to
produce a commercial product, with work spread across accounts. That reads as "building a product or service" on
consumer OAuth credentials, beyond "ordinary, individual usage", and possibly as automated access not explicitly
permitted. This is an assessment of public text, not legal advice.

### 9.3 What this means in the code

- The Claude Code execution adapter (`runner/src/providers/claude-code-cli.ts`) is implemented and tested with simulated
  sessions; its status is **blocked by provider authorization** for live customer builds.
- Nothing circumvents provider limits: no cookie or token extraction, no browser automation of claude.ai, no limit
  evasion, no rotating accounts to escape a limit (a rate-limited worker waits for its own reset).
- No paid API was substituted.

### 9.4 Founder decision required (pick one)

1. **Ask Anthropic for written permission** (sales / support) for this exact use: unattended Claude Code on three Max
   accounts owned by Crestmont, building customer websites. If granted in writing, record it, then run the Node 1 steps below.
2. **Move to commercial seats** (Claude Team or Enterprise with Claude Code, under the Commercial Terms) and confirm with
   Anthropic that automated builds are within those terms. The code works the same (each seat = one worker).
3. **Use API key authentication** (Console, metered). Conflicts with the $0 requirement; needs an explicit Founder
   approval of a budget and would use the existing two-key-gated adapter or an API-key mode of the Claude Code worker.
4. **Stay internal-only** until 1 or 2 is settled: the Founder may run the acceptance test interactively on Crestmont's own
   test site, attended, which is closer to ordinary individual use. Do not take customer orders through it.

## 10. Node 1 setup (after the release gate is cleared)

Run in PowerShell on Node 1 from the repository checkout (`C:\src\Crestmont-Website-Development`, adjust as needed).

1. Platform, signed in as Owner: **Owner → AI builds → Builder accounts → Register a worker** three times: provider
   `claude-code`, billing `subscription`, label `partners@lansingcarrentals.com`,
   `headquartersenterpriseoperations@outlook.com`, `noahschmidt10@gmail.com`. Copy each one-time key and worker id.
2. Save the keys (one line each, no trailing spaces), then lock the folder down:
   ```powershell
   New-Item -ItemType Directory -Force C:\CrestmontRunner\secrets | Out-Null
   Set-Content -NoNewline C:\CrestmontRunner\secrets\worker_claude-1_key '<key for claude-1>'
   Set-Content -NoNewline C:\CrestmontRunner\secrets\worker_claude-2_key '<key for claude-2>'
   Set-Content -NoNewline C:\CrestmontRunner\secrets\worker_claude-3_key '<key for claude-3>'
   icacls C:\CrestmontRunner\secrets /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F"
   ```
3. Lockfile: `runner\claude-code\package-lock.json` must exist and be committed after review. Take it from the CI artifact
   `runner-lockfiles` of the latest run, or generate it on a machine with registry access:
   `cd runner\claude-code; npm install --package-lock-only --ignore-scripts`.
4. Install (no Ollama in this mode):
   ```powershell
   cd C:\src\Crestmont-Website-Development\runner\windows
   .\Install-CrestmontRunner.ps1 -PlatformUrl https://<platform host> -Install -Provider ClaudeCode `
     -ClaudeWorkerIds wkr_AAAA,wkr_BBBB,wkr_CCCC -NoStart
   ```
5. Sign each account in once, into its own directory (the installer prints these lines). Use the matching account for
   each container; in the browser that opens, check the email shown before approving:
   ```powershell
   docker compose -f C:\CrestmontRunner\compose\docker-compose.yml -f C:\CrestmontRunner\compose\docker-compose.claude.yml `
     --project-directory C:\CrestmontRunner\compose run --rm -it --no-deps -e CLAUDE_CONFIG_DIR=/claude/claude-1 claude-1 claude
   #   /login  → sign in as partners@lansingcarrentals.com → /status (check plan) → /exit
   # repeat with claude-2 (headquartersenterpriseoperations@outlook.com) and claude-3 (noahschmidt10@gmail.com)
   ```
6. On claude.ai for each account: **Settings → Usage → extra usage off**. Never set `ANTHROPIC_API_KEY` on Node 1.
7. Start and check: `.\Start-CrestmontRunner.ps1` then `.\Get-RunnerHealth.ps1`. The three workers show as online in
   Builder accounts.

## 11. First acceptance test

1. Validate the sandbox: `docker compose … run --rm --no-deps claude-1 claude -p "run: echo ok" --permission-mode dontAsk`
   must succeed with the sandbox on; a bubblewrap/namespace error means the seccomp item in 7 needs fixing first.
2. Create an internal test intake (Crestmont's own test project, not a customer). Confirm it is assigned to the account with
   the lowest verified usage (or least recently used when usage is unknown).
3. Watch the project pipeline: SPEC appears, builder cycles, reviewer verdicts with evidence, score rising, preview link.
4. Create a second and third test intake (each lands on a different account) and a fourth (stays queued until one finishes).
5. Exhaustion check (optional): when an account hits its limit, its website shows "waiting for usage reset" and resumes
   after the reset with no extra charges on the account's billing page.
6. Approve the preview as Founder. Do not release to a customer domain during the test.

## 12. Founder-only actions

Decide the release gate (9.4); register the three workers; save keys; sign each account in; keep extra usage off; review
and commit the lockfile; validate the sandbox on Node 1; approve previews; authorize any delivery (D5).
