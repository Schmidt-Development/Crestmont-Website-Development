# AI Website Builder: V4 orchestrator (local dual-model on owned GPUs)

Founder directive V4 (2026-10-28) replaces the V3 Claude-subscription worker design ([history](history/ORCHESTRATOR-V3-CLAUDE-SUBSCRIPTION.md)).
D1–D5 are kept: customer-revision approval, preview retention, private previews, native Windows Ollama (now dual-model)
and Owner-controlled delivery. See `README.md`.

> **Status (2026-10-28): IMPLEMENTED and SIMULATED-TESTED only.** Nothing here has run on Node 1. Every model, GPU and
> throughput figure below is either from a public source (cited) or labelled an *estimate*; none is a measurement.
> The V3 provider-authorization blocker no longer applies: no subscription account is used. The remaining blockers
> are in §15.

## 1. Flow

```
 Paid intake ──► Platform (Cloudflare Worker + D1): queue, priority, GPU workers, pipeline, cycles, approvals, integrations
                  │ dispatch: website → GPU worker (affinity); capacity = concurrent builds per worker (measured)
                  ▼
 Node 1 (Windows, RTX 5090 32 GB) ─ Docker Desktop
   runner container: RUNNER_SLOTS website agents at once, one shared GPU scheduler
      slot n: claim ─► Model A architect (fresh, read-only) ─► SPEC.json
                    ─► Model B build/verify ─► runner checks (sandbox, browser, screenshots)
                    ─► Model A review (fresh, read-only; sees screenshots) ─► platform referee
                    ─► correction routed (B ordinary · A repeated/architectural/integration) ─► repeat
                    ─► private preview ─► AWAITING_INTERNAL_APPROVAL (customer sees nothing)
   GPU scheduler ─► Ollama (native, 127.0.0.1:11434): one of Model A / Model B in memory at a time
   egress proxy (allow-list) · per-build sandbox containers (no network) · GPU telemetry sampler (host)
 Staff: internal approval (MFA) ─► share with customer ─► feedback/revisions (D1) ─► final approval ─► Owner release (D5)
```

## 2. Audit: KEEP / MODIFY / REMOVE / BLOCKED (V3 → V4)

| Component | Decision | Notes |
|---|---|---|
| Control plane: queue, leases, HMAC, checkpoints, budgets, D1–D5 | KEEP | unchanged |
| Local provider (in-house tool loop, transcripts, sandbox containers, egress proxy, paid-AI tripwire) | KEEP + MODIFY | model chosen per phase; every request through the GPU scheduler |
| Pipeline: spec validation, evidence referee, loop guards, approvals, integration checklist | KEEP + MODIFY | stages for the private review and customer preview; models recorded per cycle; `integration_operation` approvals; test-environment status |
| `build_workers` (Claude accounts, one website each, usage %) | MODIFY → GPU workers | many websites per worker up to measured capacity; telemetry (VRAM, utilization, loaded model, queue, throughput, switches) with its source; cost class (owned hardware only) |
| One-website-per-worker index, lowest-usage ranking, rate-limit release | REMOVE | replaced by capacity-aware claims, Founder priority with aging, most-free-capacity dispatch |
| Claude Code CLI provider, Claude advisor, `subscription-included` capability, `-Provider ClaudeCode`, `docker-compose.claude.yml`, Claude Code image variant and lockfile step, Claude egress rule | REMOVE | V3 history document kept |
| Migration 0053 (was 0043) | MODIFY in place | never applied to a shared database (staging migrates from `main`); renumbered 0041–0043 → 0051–0053 when integrated with `main` (which already uses 0041–0050) |
| Multi-session worktrees (`orchestrator/sessions.ts`) | KEEP, not wired | provider-independent; per-website parallel sessions would compete for the same GPU, so throughput comes from parallel websites instead |
| Paid Claude Agent SDK adapter (`providers/claude-agent-sdk.ts`, `agent-sdk/`) | KEEP, **recommend removal** | needs `RUNNER_ALLOW_PAID_PROVIDER=true` *and* `BUILD_ALLOW_PAID_PROVIDER=true`; no fallback to it. Safe removal: delete the adapter, `agent-sdk/`, the two flags and their tests in one PR after Founder confirmation |
| Model verification on Node 1, benchmarks, acceptance build | BLOCKED (hardware) | §12, §15 |

Conflicting instructions found and resolved: V3 docs (ORCHESTRATOR, README, FOUNDER-RUNNER-INSTALL, RUNNER-PROTOCOL v1.5)
described Claude accounts, usage limits and `subscription-included`; all updated or archived. `READY_FOR_FOUNDER_APPROVAL`
became `READY_FOR_INTERNAL_APPROVAL` (older runners' wording is still accepted and mapped).

## 3. Models (verified 2026-10-28 from public sources; not yet on Node 1)

| | Model A: architect / reviewer | Model B: builder |
|---|---|---|
| Official repo | [`Qwen/Qwen3.8-27B`](https://huggingface.co/Qwen/Qwen3.8-27B), weights 2026-08-14 ([QwenLM/Qwen3.8](https://github.com/QwenLM/Qwen3.8)) | [`Qwen/Qwen3.6-35B-A3B`](https://huggingface.co/Qwen/Qwen3.6-35B-A3B), 2026-04-16 |
| Type | dense 27B, vision encoder | MoE 35B total / 3B active, vision |
| License | Apache-2.0 (commercial use allowed) | Apache-2.0 |
| Ollama tag (pin exactly) | [`qwen3.8:27b-q4_K_M`](https://ollama.com/library/qwen3.8/tags), 18 GB | [`qwen3.6:35b-a3b-q4_K_M`](https://ollama.com/library/qwen3.6/tags), 24 GB |
| Ollama badges | tools, thinking, vision; 256K context | tools, thinking, vision; 256K context |
| Tool calling | official serving examples use the `qwen3_coder` parser; Ollama's OpenAI-compatible API supports `tools` and `reasoning_effort`, not `tool_choice` ([docs](https://docs.ollama.com/api/openai-compatibility)) | same |

No substitution was needed: both named candidates exist. Not verified: the minimum Ollama version for these
architectures, image input through Ollama's OpenAI-compatible endpoint for these models, and any quality or speed.
Alternatives if one fails on Node 1 (Founder confirmation required): A → `qwen3.6:27b-q4_K_M` (17 GB, Apache-2.0);
single-model baseline → `qwen3-coder:30b-a3b-q4_K_M` (19 GB, text only).

**Memory (estimate, not measured).** Q4 weights: A ≈ 18 GB, B ≈ 24 GB → together ≈ 42 GB > 32 GB. So the design never
assumes both are resident: the runner keeps **one model in GPU memory at a time** (`OLLAMA_MAX_LOADED_MODELS=1`,
`GPU_VRAM_TOTAL_MB` from the hardware check, `GPU_VRAM_RESERVE_MB=4096` never given to weights). KV cache grows with
context × parallel requests; the installer uses 64K context at 1 parallel request, 32K above that. The benchmark replaces
these with measured figures.

## 4. Routing (runner/src/inference/router.ts)

| Task | Model | Where |
|---|---|---|
| Requirements analysis, master architecture, development planning | A | architect session (one read-only session produces the full master spec); `plan` phase when no spec |
| Routine frontend / backend development, standard debugging (verify) | B | build and verify phases |
| Formal AI review, final AI quality assessment | A | every review cycle, fresh session |
| Repeated failed tests | A | the same outstanding items `ROUTER_ESCALATE_AFTER_REPEATS` (2) cycles in a row |
| Complex architecture changes | A | the review names an architectural problem |
| Complex integrations | A | integration/security items are at least half of what is outstanding |
| Routine revisions / difficult revisions | B / A | revision text mentions payments, auth, database, integrations, redesign … or is over 1500 characters |

Single-model mode (`LOCAL_MODEL` only) uses one model for every task. The router chooses a model, nothing else: the
platform referee, approvals and the private review gate are outside it. Every cycle records the builder model, the
reviewer model and the routing reason (dashboard → project pipeline).

**Context between models.** The builder's transcript (runner-side, checkpointed) is model-independent and continues
when a repair moves from B to A. Reviews and the architect always start fresh and read the repository: BRIEF, SPEC,
review files, `runner-checks.json`, code and screenshots.

## 5. GPU scheduler (runner/src/inference/scheduler.ts)

All model requests of all website slots go through one queue:

- **Concurrency:** at most `INFERENCE_MAX_CONCURRENT` requests on the GPU (= `OLLAMA_NUM_PARALLEL`), from the benchmark.
- **Residency:** knows what is loaded (Ollama `/api/ps`, measured `size_vram`); co-residence only when every size is known
  and fits under GPU size − reserve.
- **Batching:** requests for the loaded model run first. A request for the other model switches the GPU when the loaded
  model has been idle for `idleGrace` (20 s; its agents are between calls) or when it is the oldest request and has waited
  `MODEL_SWITCH_MAX_WAIT_SECONDS` (180 s) and the loaded model has had its minimum time (120 s). Then no new work is
  admitted, running requests finish, the other model is unloaded and the waiting one loaded.
- **Timeout and recovery:** a switch has `MODEL_SWITCH_TIMEOUT_SECONDS` (300 s). A failed load is retried once; then that
  model cools down (2 min), only its waiting requests fail, the scheduler re-reads what is loaded, and the other model
  keeps working. The build that needed it checkpoints and is released for 10 minutes without spending an attempt.
- **Fairness:** among requests for the loaded model, the website served least recently goes first.
- **Logging:** per model requests, tokens, generation time, queue wait, tokens/s; every switch with its duration and
  result. Reported to the platform every minute (GPU workers page) and on `/health`.
- **Abort:** a stopped build leaves the queue at once.

Known limit (to tune on Node 1): with one resident model, a review waits for the builder batch (up to 3 minutes) and a
switch costs a full model load. Switch frequency vs throughput is set by `MODEL_SWITCH_MAX_WAIT_SECONDS` and the
number of slots.

## 6. Multi-website scheduling (platform, src/services/build-workers.ts)

- **Tracking:** every paid website is tracked in `build_pipeline` (ten and more; no limit in the schema).
- **Affinity:** each website has one GPU worker (where its workspace and checkpoints live). A worker serves many websites.
- **Capacity:** a worker runs at most `max_active_projects` builds at once (set on the dashboard from the benchmark).
  A website waiting for a person, an external setup or its preview review holds no capacity, so another eligible
  website runs meanwhile.
- **Order:** Founder priority (−5..5) raised by one step per 4 hours of waiting, so nothing starves; then arrival.
- **Dispatch:** to the eligible worker with the most free capacity, then the least recently assigned; a website returns to
  the worker that built it before. Eligible = enabled, not paused, reporting, owned hardware, model server not failed.
- **No duplicates:** unique active-assignment index per project, leased claims, compare-and-set transitions.
- **Scheduler view (pipeline page):**
  - active websites;
  - ready to run;
  - GPU requests running (as reported, else "not reported");
  - waiting for GPU (queued or switching);
  - running tests;
  - in AI review;
  - waiting for external setup;
  - waiting for a person;
  - delivered.

## 7. Lifecycle and customer visibility

Stages:
`INTAKE_RECEIVED → ARCHITECTING → QUEUED/WAITING_FOR_GPU_CAPACITY → WORKER_ASSIGNED → BUILDING → TESTING → AI_REVIEW ⇄ REVISION_REQUIRED → AWAITING_INTERNAL_APPROVAL → READY_FOR_CUSTOMER_PREVIEW → CUSTOMER_PREVIEW ⇄ CUSTOMER_FEEDBACK → APPROVED_FOR_DELIVERY → DELIVERED`.
Side stages: `WAITING_FOR_HUMAN_AUTHORIZATION`, `WAITING_FOR_EXTERNAL_SETUP` and `FAILED_NEEDS_INTERVENTION`.

**Private review gate (V4 §7 F):**
- **While the site is in development and awaiting internal approval:**
  - the customer sees "In internal review" and nothing more;
  - no preview link, notification, AI review result or status detail reaches them;
  - the preview exists only behind the D3 gate.
- **Internal approval (`POST /staff/builds/:id/internal-approve`):**
  - needs `builds.configure` and an MFA step-up, and is audited;
  - shows the automated acceptance verdict, but approving a build that did not pass it requires a written reason;
  - shares nothing.
- **Share with the customer (Phase G):** a separate, step-up-protected action. It is allowed only after internal approval.
  It updates the portal, notifies the customer and enables their review and revision requests (D1 policy unchanged).
- **Final approval:** allowed only after internal approval. Production delivery stays the D5 Owner-authorized release.

No AI verdict changes any of these steps.

## 8. Secrets and the trusted integration layer (runner/src/integrations/)

- Agents generate integration code, mocks and configuration templates, and declare the credentials they need.
- Agents **request** catalogued operations in `.crestmont/integration-operations.json`.
- For each request, the runner (not the agent):
  - asks the Owner (approval kind `integration_operation`, naming the exact operation);
  - after approval, reads the project's credential from `<secrets>/integrations/<projectId>/` itself;
  - runs the operation once;
  - refuses live credentials;
  - redacts the result, writes it for the agent and reports the test-environment status to the platform.
- Current catalogue, read-only and test mode only: `stripe.verify_test_key` and `stripe.list_test_webhooks`. New
  operations are added by code review, never described by a model.
- The agent never receives a credential:
  - its tools are confined to the repository;
  - its sandbox has no network and no secrets;
  - the runner's secrets directory is outside both.
- `api.stripe.com` must be added to the runner's egress allow-list (`-ExtraEgressDomains`); that list applies to the runner container only. Build sandboxes have no network, and the install network reaches only the npm registry.
- Live connections are still marked by a person (never inferred). Unknown operations are recorded as "not supported"
  for a person.
- Customer production secrets stay out of the AI builder entirely. They are set on the customer's target during the D5
  release.

## 9. Future GPU expansion

- **Registry:** the GPU worker registry already reports the fields a multi-GPU scheduler needs:
  - id, hardware, VRAM total and used, utilization, loaded and supported models;
  - active and queued requests, concurrency, throughput, switches, health;
  - slots and cost class.
- **Adding owned GPUs:** register another worker and install the runner on that machine with its id. The dispatcher
  spreads new websites by free capacity.
- **Paid or rented capacity:** `rented-gpu` and `dedicated-server` cost classes exist in the schema but are refused at
  registration and at claim time. They need a separate Founder approval and budget.
- **Not built yet:** moving a waiting website to another worker automatically. Today an Owner reassigns it, or the sweep
  releases a disconnected worker's websites.

## 10. $0 metered inference

No automatic Claude, OpenAI or other paid fallback exists:

- **Local provider:** refuses hosted inference URLs and Ollama `-cloud` models.
- **Egress proxy:** denies paid AI hosts from every network.
- **Platform:** refuses runners that do not declare zero token cost, and GPU workers that are not owned hardware.
- **Agent environment:** built from an allow-list.
- **Preflight:** names any metered credential present on the runner.
- **Installer:** reserves the `ANTHROPIC_*`, `OPENAI_*` and `LOCAL_MODEL_API_KEY` keys.

The dashboard shows "Metered AI spend" from recorded runs; it must stay $0.00.

## 11. Dashboard (Owner → AI builds)

- **GPU workers and AI models** (`/staff/builds/workers`):
  - **GPU workers:** health, model loaded, VRAM and utilization with source, running and queued requests, model
    switching, concurrent builds, slots. Controls: pause/resume, capacity, rotate key, remove; registration is owned
    hardware only (MFA).
  - **AI models:** identifier, role, quantization, memory (measured or configured estimate), context, tokens/s,
    requests, last healthy.
- **Website pipeline** (`/staff/builds/pipeline`), for each website:
  - customer/project, stage, GPU worker and current model, last task;
  - tests, AI review, revisions;
  - pending human actions, private preview status, what the customer sees, priority.
  - Also on the page: the scheduler view and the approvals queue.
- **Build page:**
  - automated acceptance, current activity;
  - internal approval, share, final approval;
  - revision, pause, budget, evidence and preview.
- **Project pipeline page:**
  - stage history and master spec;
  - cycles with prompts, verdicts and the models of each cycle;
  - integrations with test-environment evidence.

## 12. Benchmarks and acceptance (Node 1)

**A. Automated harness** (`runner/src/benchmark.ts`). Per model it measures:
- cold load time and real GPU memory;
- tokens/s and p50/p95 at 1, 2, 4 and 8 concurrent requests;
- A↔B switch time;
- tool-call and JSON sanity.

It writes `benchmark-<time>.json` and `.md`, labelled MEASURED with the host and the GPU sample. Run it after
installation (§13 step 6).

**B. Website benchmark** (the V4 §12 list). Build the *same* internal requirements three ways:
1. A + B, the default;
2. B only (`-Model qwen3.6:35b-a3b-q4_K_M`);
3. A only (`-Model qwen3.8:27b-q4_K_M`).

Where practical, compare with a Claude-built reference site made outside this system. Record per run, with a staff
reviewer scoring from the evidence (scoring sheet: the table below, kept in `C:\CrestmontRunner\evidence\`):

| # | Metric | Source |
|---|---|---|
| 1 | Planning quality | staff score of SPEC.json (1–5) |
| 2–4 | Frontend quality, backend correctness, integration correctness | staff score + runner checks |
| 5 | Security defects | review findings + manual check |
| 6 | Responsive design | browser-check screenshots |
| 7 | Automated test success | runner checks |
| 8 | Revision cycles | `build_cycles` |
| 9 | Total wall-clock time | build events |
| 10–12 | Peak GPU memory, throughput, switch overhead | benchmark harness, GPU workers page |
| 13 | Reviewer defect detection | seeded defects found / seeded (staff seeds 5 defects into a copy) |
| 14 | Websites per day | measured completions per 24 h with the chosen slots |
| 15 | Human correction effort | staff minutes to reach approval |

No claim of Claude-equivalent quality is made without these results.

**C. Acceptance (the first real internal website):**
- The full lifecycle on Crestmont's own test project: intake → … → internal approval.
- Customer preview to a staff test account.
- Final approval.
- **No production release.**

## 13. Node 1 installation (exact steps)

Run in an elevated PowerShell on Node 1, from a checkout of this branch (for example `C:\src\Crestmont-Website-Development`).

1. **Platform** (Owner, staging environment): **Owner → AI builds → GPU workers → Register a GPU worker**.
   - Name: "Node 1 RTX 5090".
   - Concurrent website builds: **1**.
   - Copy the worker id and the one-time key.
2. **Save the key:**
   ```powershell
   New-Item -ItemType Directory -Force C:\CrestmontRunner\secrets | Out-Null
   Set-Content -NoNewline C:\CrestmontRunner\secrets\worker_key '<enrollment key>'
   ```
3. **Ollama:** install or update Ollama (the installer does it with `-Install`). Check `ollama --version` is current
   enough to pull the models; the minimum version is unverified.
4. **Install** (dual-model; pulls about 42 GB; one slot and one GPU request until benchmarked):
   ```powershell
   cd C:\src\Crestmont-Website-Development\runner\windows
   .\Install-CrestmontRunner.ps1 -PlatformUrl https://<staging host> -Install `
     -ModelA qwen3.8:27b-q4_K_M -ModelB qwen3.6:35b-a3b-q4_K_M -Slots 1 -GpuConcurrency 1 -WorkerId wkr_XXXX
   ```
5. **Check:**
   ```powershell
   .\Get-RunnerHealth.ps1
   ollama ps
   ```
   The worker appears as Available on the GPU workers page, with both models listed. `ollama ps` should show
   `100% GPU` for the loaded model.
6. **Benchmark** (MEASURED figures):
   ```powershell
   docker compose -f C:\CrestmontRunner\compose\docker-compose.yml --project-directory C:\CrestmontRunner\compose `
     run --rm --no-deps -v C:\CrestmontRunner\evidence:/out runner node --no-warnings src/benchmark.ts --concurrency 1,2,4,8 --out /out
   ```
   Then:
   - choose the highest concurrency whose p95 latency and errors are acceptable;
   - re-run step 4 with `-GpuConcurrency <n> -Slots <m>` (slots ≥ concurrency, e.g. 2× it);
   - set "Concurrent website builds" on the dashboard to the same number of slots.
7. **First internal website:** §12 C.

## 14. Founder-only checklist

1. **Confirm the models:** `qwen3.8:27b-q4_K_M` (A) and `qwen3.6:35b-a3b-q4_K_M` (B), Apache-2.0, or name a substitution.
2. **Approve applying migrations 0051–0053 to staging.** They only run through a merge to `main` plus the staging deploy.
   Do not merge until you decide.
3. Register Node 1 and save its key (§13 1–2).
4. Run the installer, the health check and the benchmark (§13 3–6), then set the capacity.
5. Run the website benchmark and the first internal website (§12 B–C). Score the results.
6. Place test-mode integration credentials when wanted, e.g.
   `C:\CrestmontRunner\secrets\integrations\<projectId>\STRIPE_TEST_SECRET_KEY`. Add `api.stripe.com` with
   `-ExtraEgressDomains`.
7. **Decide on the paid Agent SDK adapter:** remove (recommended) or keep, double-gated.
8. **Approve each website internally.** Then share it with the customer, give the final approval and authorize releases
   (D5).

## 15. Launch-readiness (V4 evidence levels)

**Levels:**
- **IMPLEMENTED:** the code exists.
- **SIMULATED-TESTED:** fixtures or simulated services.
- **NODE-1-VERIFIED:** observed on the hardware.
- **ACCEPTANCE-TESTED:** a real lifecycle passed.
- **PRODUCTION-READY:** all gates passed.

| Item | Level | Blocker / next action | Owner |
|---|---|---|---|
| GPU worker registry, capacity scheduling, priority/aging, dashboard (AIB-012) | SIMULATED-TESTED | Node 1 telemetry and capacity from the benchmark | Founder |
| Architect spec, evidence referee, loop guards, models per cycle (AIB-013) | SIMULATED-TESTED | real models must produce valid specs and verdicts | Founder + engineering |
| Approvals, integration checklist (AIB-014) | SIMULATED-TESTED | none on the code side | Founder (decisions) |
| Dual-model router, GPU scheduler, slots, $0 enforcement (AIB-015) | SIMULATED-TESTED | tuning: switch wait, slots, concurrency, context from measurements | engineering after the benchmark |
| Node 1 verification and acceptance build (AIB-016) | not started | §13–§12 C | Founder |
| Private review gate and customer visibility (AIB-017) | SIMULATED-TESTED | none on the code side | — |
| Trusted integration layer (AIB-018) | SIMULATED-TESTED | each operation run once with real test-mode credentials | Founder |
| Models' licensing and availability | verified from public sources | confirm on Node 1 (`ollama pull`, `ollama show`) | Founder |
| Ollama vision through the OpenAI-compatible API | unverified | if image requests fail, that cycle is judged by the rule-based reviewer; re-run the installer with `-NoReviewerVision` for text-only reviews | Node 1 |
| Docker Desktop: `host.docker.internal` reaches the localhost-only native Ollama | unverified (D4 item) | installer step 8 checks it; `-OllamaInDocker` fallback | Node 1 |
| Previews (Cloudflare preview account), project repositories | Founder setup (unchanged) | PREVIEW-DEPLOYMENT.md, RUNNER-SETUP.md | Founder |
| Merge of PR #16 / migrations to staging | not authorized | Founder decision | Founder |
| Production customer delivery | framework only (D5) | after acceptance; Owner authorization per release | Founder |
