# AI Website Builder: long-running builds (context resets, project memory, checkpoints, continuation)

Added 2026-11-01 on PR #99 (`claude/builder-reasoning-none`). This file covers what lets a local-model build run
through any number of model requests, context resets, restarts and segments, and what keeps that safe.

**Evidence level.** Everything here is tested with **fake** model servers, a fake Docker executor and a fake
control plane (`runner/test/continuity.test.ts`, the `[AIB-CONTINUITY]` tests in `runner/test/local-job.test.ts`).
The "10 million token" test counts **deterministic token numbers reported by the fake server**. It proves the
runner's bookkeeping and context management, not GPU behaviour or model quality. Nothing in this file has run on
Node 1 yet. The real-model steps are in §8.

## 1. Context accounting and fresh-context resets (`runner/src/providers/local.ts`)

Before every request, the runner measures:
- the system prompt;
- the workspace message: file tree, untrusted brief, durable project memory, and the mechanical log;
- the conversation history;
- the tool schemas;
- the output capacity reserved for the reply (`max_tokens`).

It measures these against the current model's own context window (`LOCAL_MODEL_A/B_CONTEXT_TOKENS`).

The estimate is chars/3.5, multiplied by a per-model **calibration** learned from the server's own `prompt_tokens`.
The calibration only moves upward and is capped at 3×.

**When the context is reset:**
- **Before exhaustion:** when the request would use more than 85% of the usable window (window − reply − 3% margin).
- **After a refusal:** when the model server refuses a prompt as too long. The calibration also rises ×1.25. At most
  3 resets in a row; then the phase fails honestly.
- **After silent truncation:** when a reply reports `prompt_tokens` at 97% or more of the window. Ollama's `/v1`
  endpoint truncates silently, so the reset happens before the next call.

**A reset starts a fresh context** made of:
1. the fixed system prompt;
2. the refreshed workspace message, including the project memory digest;
3. a `CONTEXT RESET #n` message that restates the **current phase instruction verbatim** and tells the model to
   re-read the authoritative files;
4. only the newest whole turns that fit in 30% of the window. An assistant tool call always stays with its results.

Turns that are removed go into a bounded, **runner-written** mechanical log. No model ever summarises the
conversation, and nothing a model wrote becomes the source of truth.

**Limits:**
- There is no limit on the number of resets.
- If the fixed part alone cannot fit, the phase fails with an exact message: raise `LOCAL_MODEL_*_CONTEXT_TOKENS`
  together with `num_ctx`.
- After a reset whose fresh context is already large, the next reset waits for 10% growth. This stops a tight window
  from throwing away the newest turn on every call.

**Persistence:**
- Every reset is reported to the job, which takes a **checkpoint**.
- The transcript (the current fresh context, the instruction and the reset count) is saved after every turn.

The architect and reviewer sessions (Model A, `orchestrator/advisors.ts`) are short and have bounded turns. They keep
their own window by replacing older tool outputs. They start fresh on every call and need no memory.

## 2. Durable project memory (`runner/src/memory.ts`)

**Where it lives:** `<job dir>/agent/project-memory.json`.
- It is outside the agent's repository, so the agent cannot edit it.
- It is written atomically.
- It is carried in every checkpoint archive (`local-agent/`).
- It therefore survives context resets, model switches, container restarts, runner restarts, Windows restarts and a
  resume on another host.

**Who writes it:** only the runner, and only from authoritative sources:

| Recorded | Source |
|---|---|
| Brief identity (id, version, sha256, business name) and package | the claim. The brief itself stays in `BRIEF.json` and on the platform |
| Specification present and version | the platform (`SPEC.json`) |
| Requirement statuses | `readRequirements` (platform seed plus the agent's evidence rules) |
| Phases completed, review cycles completed | the job's own phase results and the platform's cycle decisions |
| Runner acceptance checks (pass/fail per check) | the runner's checks |
| Defect history: signature, occurrences, the repairs tried, whether each repair worked | outstanding items from the evidence |
| Integration code/mock status, approved operations, approvals pending | the builder's integrations file and the trusted broker |
| Preview deploy result | the runner's deploy |
| Segments (start/end commit, end reason, tokens, resets, progress), interruptions, in-flight step | the runner |
| The builder's own phase summaries | the model, **labelled model-reported**, bounded to 20 |

**Tenant isolation:** the file is bound to `projectId + jobId + kind + revision`. A file for anything else is ignored,
never merged, and the report says so.

**No credentials:** every string passes through the log redactor (registered secrets) and is also scrubbed of
credential shapes: Stripe `sk_/rk_/whsec_`, `re_…`, AWS, JWT, and long tokens.

**What the model sees:** a bounded digest (10% of the window) in every context. It contains:
- the open requirements;
- the failing checks;
- unresolved defects, with a warning when an earlier repair did not fix the defect ("use a different approach");
- the people the build is waiting on;
- recovery notes;
- the list of files to re-read.

## 3. Checkpoints and crash recovery (`runner/src/checkpoint.ts`, `runner/src/job.ts`)

**When a checkpoint is taken** (archive plus platform record):
- after every phase;
- after every context reset;
- after every review cycle's repair;
- at every segment end;
- before every stop;
- at the end of the build.

**What the archive now carries:**
- the transcript and the project memory;
- the source (git bundle);
- the git-ignored `.crestmont/` status files (plan, requirements, reviews, integration requests; screenshots
  excluded). These are restored only into a restored git checkout and never over an existing file.
- the runner's idempotency records (`runner-state/integration-operations-done.json`).

**On the next start, the runner:**
1. Restores the last checkpoint from the local workspace or the platform.
2. Opens a new segment. If the previous segment never closed (crash, lost lease, restart), it records
   `interrupted` and the step that was in flight.
3. Puts a recovery note into the report and the model's memory digest.
4. **Skips phases already completed** (no model call for them).
5. Continues **review cycle numbering** where it stopped. The platform requires cycle N+1 after N, and an existing
   cycle answers idempotently.

**Duplicate side effects are prevented by:**
- **Approved integration operations:** never re-run after a resume. The broker's record travels in the checkpoint
  (regression test).
- **Approval requests:** deduplicated on the platform (`dedupe_key`).
- **Review cycles:** idempotent per `(job, cycle)`.
- **Preview deploys:** one Worker per build name, so a re-deploy replaces the same Worker.
- **Payments:** the runner never touches them. Simulated payments are idempotent per event id on the platform.
- **Customer email:** never sent by the runner.

## 4. Cumulative local-model token policy (no ceiling)

- **Per request (kept):** context window, `LOCAL_MODEL_MAX_OUTPUT_TOKENS` per call, request timeout.
- **Per segment (kept, not a ceiling):** `RUNNER_MAX_TURNS`, `RUNNER_MAX_RUNTIME_MINUTES`,
  `RUNNER_LOCAL_MAX_OUTPUT_TOKENS`, and the platform's per-run runtime/turn limit. These split GPU time fairly
  between websites.
- **What happens at a segment limit** (local, zero-cost provider):
  1. The runner commits and checkpoints.
  2. It completes the attempt as `released`, so the platform requeues the build **without spending an attempt**.
  3. The next segment resumes from the checkpoint.

  The report carries the cumulative tokens, segments and resets.
- **No cumulative limits** on tokens, model requests, resets or segments.
- **Still enforced:**
  - **Stall guard:** `RUNNER_CONTINUATION_MAX_IDLE_SEGMENTS` (default 2) consecutive segments without a new commit,
    completed phase, or improved requirement or check end the build as `Stalled`.
  - **Thrashing guard:** `RUNNER_CONTINUATION_MAX_SEGMENTS_WITHOUT_MILESTONE` (default 8) consecutive segments with
    commits but no milestone also end the build as `Stalled`.
  - **Bounded repair loop:** `ORCHESTRATOR_MAX_CYCLES` counts across segments. A defect that survives
    `MAX_INEFFECTIVE_REPAIRS` (3) targeted repairs ends the loop for a person instead of repeating the fix.
  - Loop detection, the malformed-output limits, the GPU scheduler and stalled-job detection.
- **Never overridden:** cancel, pause, budget and eligibility stops from the platform. `RUNNER_CONTINUATION=off`
  restores the old behaviour, where a segment limit fails the attempt.
- Tokens are recorded as **operational metrics** (memory totals and the owner report). They are not customer billing.
  Metered spend stays $0 (ORCHESTRATOR §10). No paid fallback exists.

## 5. Customer-owned external services (billing isolation)

- **Platform** (`src/services/build-pipeline.ts`): every integration catalogue entry states who pays
  (`integrationBilling`), and the Owner's integration checklist shows a "Who pays" column. Crestmont pays for building
  the website on its own GPU workers. The services the website needs to operate run on the **customer's own
  accounts**: domain and hosting, Stripe fees, email, SMS and voice, maps, booking, other APIs. Crestmont's Stripe,
  Resend, Retell and Cloudflare accounts are never used for a customer site.
- **Builder contract** (`orchestrator/evidence.ts`):
  - credentials are read only server-side, from the customer's Worker secrets;
  - each one is documented in `integrations.json` with `"paidBy": "customer"`;
  - nothing secret goes into frontend code, logs or the repository;
  - Stripe test and live keys are kept apart;
  - free tiers come first;
  - a paid plan is never added by the builder. It is requested as `paid_usage_increase`.
- **Runner check `credential-scan`** (`checks.ts`): fails the build when the files git would commit hold a credential
  shape or a local secrets file with secret-named values. Values are never echoed. Obvious placeholders and
  publishable keys pass.
- **Already in place and unchanged:**
  - the per-project integration secrets live on the runner (`<secrets>/integrations/<projectId>/`);
  - test-mode-only, read-only catalogued operations;
  - Owner approval per operation;
  - sanitized evidence;
  - the agent never receives credentials;
  - "live" is set only by a person.
- **Not done (needs a Founder decision):** a customer-facing disclosure and consent step in the portal, listing the
  paid services and recording the customer's authorization. Today only staff see the checklist. This needs approved
  legal wording and a migration.

## 6. Full-stack scope: what the builder can and cannot produce today

- **Custom builds** (a custom quote, `strategy: custom`) start without a starter. The builder may implement a full
  frontend, backend, database and integrations per SPEC.json and the builder contract. The runner's acceptance gate
  for them is the review loop plus the credential scan. **No starter checks run** (E2E-BENCHMARK §6).
- **Standard packages, including Business at $2,499,** use the approved **brochure starter v1**: a static site in
  `public/` served by a Worker static-assets project. The contact form is a stub, and "defined integrations" are
  stubbed until credentials exist. That matches the sold scope (`src/domain/catalog.ts`), but **it is not a working
  booking system, database or Stripe checkout**.
- A Business-package build of Junk in the Trunk therefore **cannot** meet E2E items 7–10 (backend, database,
  functional booking, Stripe test mode) without one of two things: an approved full-stack starter for Business
  (Worker API + D1 + booking + Stripe test adapter, with runnable checks), or a custom quote. Which one is a Founder
  scope decision, because it changes what the package includes.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RUNNER_CONTINUATION` | on | `off`: a segment limit fails the attempt (old behaviour) |
| `RUNNER_CONTINUATION_MAX_IDLE_SEGMENTS` | `2` | consecutive segment-limit endings without progress before `Stalled` |
| `RUNNER_CONTINUATION_MAX_SEGMENTS_WITHOUT_MILESTONE` | `8` | consecutive segments with commits but no milestone before `Stalled` |
| `RUNNER_MAX_TURNS` / `RUNNER_MAX_RUNTIME_MINUTES` / `RUNNER_LOCAL_MAX_OUTPUT_TOKENS` | `300` / `180` / `2000000` | per-**segment** limits (not cumulative) |
| `LOCAL_MODEL_A_CONTEXT_TOKENS` / `LOCAL_MODEL_B_CONTEXT_TOKENS` | `LOCAL_MODEL_CONTEXT_TOKENS` (32768) | the window the accounting uses. **Must equal each model's `num_ctx`** |
| `LOCAL_MODEL_A_REASONING` / `LOCAL_MODEL_B_REASONING` | unset → `none` | Qwen thinking; `none` sends `reasoning_effort: "none"` (PR #99) |

## 8. Node 1: deploy and the real tests (Founder or operator, in this order)

1. **Update the runner** (elevated PowerShell on Node 1), after PR #99 is merged:
   - `cd <checkout>; git pull`
   - Then re-run the installer exactly as in NODE1-INSTALL §4 (it keeps `:1-previous` for rollback).
   - Check with `C:\CrestmontRunner\Get-RunnerHealth.ps1` and `Test-Node1Dispatch.ps1 -InferenceProbe`.
2. **Context windows:** confirm `OLLAMA_CONTEXT_LENGTH` (or each model's `num_ctx`) equals
   `LOCAL_MODEL_A/B_CONTEXT_TOKENS` in the runner's environment. `ollama ps` must show 100% GPU. Only one model at a
   time is expected on 32 GB.
3. **Real local-model compaction test** (no customer data). Temporarily set `LOCAL_MODEL_B_CONTEXT_TOKENS=8192`
   (with matching `num_ctx`), run a staging test build (step 5), and confirm in the build's activity:
   - at least one `context reset #n` line;
   - a `checkpoint after context reset n` step;
   - work continuing after it;
   - a report with `context resets` greater than 0 in the project memory note.

   Then restore the normal window. Record it as **MEASURED on Node 1**. Until then, compaction is simulated-tested only.
4. **Restart recovery:** during a staging build, run `Uninstall-CrestmontRunner.ps1` (plain stop) and start it again.
   The build must come back as `released` → queued → claimed, with "Project memory restored" and no repeated
   completed phase in the report.
5. **Junk in the Trunk staging E2E:** follow E2E-BENCHMARK §5. **The package decision in §6 above must be made
   first.**
   - The existing fixture is a $2,500 custom quote. A $2,499 Business order would build the static brochure starter.
   - Stop at `AWAITING_INTERNAL_APPROVAL`. Do not approve, share or release.
   - A build whose booking, database or Stripe test mode is simulated, missing or broken is **not** a pass.
