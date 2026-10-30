# Node 1 dispatch-to-GPU diagnostic

Founder P0 directive, 2026-10-30. The question: where does a queued Crestmont job stop between the platform and Node 1's RTX 5090?

## 1. How the platform and Node 1 actually talk (from the code)

```
Crestmont platform (Cloudflare Worker + D1, staging = branch main)            Node 1 (Windows, RTX 5090)
                                                                               ┌──────────────────────────────────────┐
 ai_jobs / build_jobs  ◄── signed HTTPS POST, outbound from Node 1 only ────── │ runner container (Docker Desktop)    │
 /api/builds/runner/claim        (registers runner: build_runners row)         │  polls every few s (back-off)        │
 /api/builds/runner/ai/claim     (only after a build claim found nothing)      │  HMAC secret: secrets\build_runner_  │
 /api/builds/runner/ai/checkpoint  (new: D07–D11)                              │  secret; egress via squid allow-list │
 /api/builds/runner/ai/complete                                                │        │ http://host.docker.internal │
                                                                               │        ▼          :11434              │
                                                                               │ Ollama (tray app, user session) ──► GPU
                                                                               └──────────────────────────────────────┘
 Start-up: scheduled task CrestmontRunner-Start runs AT LOGON of the installing user → Docker Desktop, Ollama,
 `docker compose up -d` (restart: unless-stopped). Nothing listens on Node 1; no port is exposed.
```

There's no push from the cloud and no Claude session anywhere in this path. If the runner is running, signed in and holds the right secret, Node 1 receives work without anyone watching.

| Layer | What must be true | How to see it |
|---|---|---|
| 1 PC on, 2 Windows running | booted, **and a user signed in** (Docker Desktop and the start task need a session) | script L1 |
| power | no sleep or hibernate on AC | script L2 |
| 3 network | DNS, TCP 443 and HTTPS to the platform | script L3 |
| 4 runner running | Docker engine, `runner` container running, auto-start task registered | script L4 |
| 5 authenticated | runner's last claim succeeded (503 = secret not set on the platform; 401 = secret mismatch) | script L5; platform page "Rejected runner calls" (new) |
| 6 receiving jobs | `build_runners.last_seen_at` fresh; diagnostic D03–D06 | platform page **Owner → AI builds → Node diagnostics** |
| 7 Ollama | `/api/version`; configured `LOCAL_MODEL` installed | script L7; diagnostic D08 |
| 8 GPU | `nvidia-smi` | script L8 |
| 9 inference | model resident in VRAM (`/api/ps size_vram`), tokens, timings | diagnostic D09–D11; script `-InferenceProbe` |

## 2. What the evidence shows (2026-10-30)

1. **The previous benchmark never offered a job to Node 1.** The Junk in the Trunk "claim" was a signed HTTP fixture written by the test, against an in-memory database inside Claude's cloud sandbox (`tests/e2e-simulated-purchase.test.ts`). Node 1 polls staging, which never saw that job. In checkpoint terms its first unproven step was **D05, "Job offered"**: no real worker could ever have received it. This is a test boundary, not a Node 1 fault.
2. **"Node 1 not connected" was a misattribution.** It meant that the Claude session's *linked computer* was not connected. That computer is a MacBook (`noahs-macbook-pro-local`, macOS arm64), not Node 1, so it says nothing about Node 1.
3. **Staging runs `main`, which has none of the V4 builder.** Staging deploys only from `main` (`deploy-staging.yml`). PR #16 (GPU worker registry, worker keys, `/workers/status`, dual-model routing, migrations 0041–0043) and PR #51 are not merged. A runner built from PR #16 can't register against staging, and the V4 installer needs a worker id and key that only V4 staging can issue. **Today Node 1 can only work against `main`'s single-model runner protocol.**
4. **Staging itself deploys.** The latest four `deploy-staging` runs (head 095e349) applied migrations and deployed the Worker; only the browser verification of the portfolio pages fails afterwards. `staging-health-monitor` has been failing at "Service and evidence-feed health". Its log storage is blocked from Claude's sandbox, so the reason isn't confirmed here.
5. **Whether staging has `BUILD_RUNNER_SECRET` can't be confirmed from here.** The deploy step passes either way, and its log is unreadable from the sandbox. Without the secret every runner call is answered 503.
6. **An observability gap (fixed here):** a runner that was running but sent a wrong signature left no trace on the platform. Rejected signatures are now recorded, at most once a minute, with the reason only.
7. **A design risk for an always-on machine (unverified on Node 1):** the runner starts only when the installing user signs in. After any reboot, such as a Windows Update, Node 1 is "on" but does not poll until someone signs in. Sleep on AC power has the same effect. The script reports both.
8. **Migration numbering:** `main` already has `0044_modules_closeout`, `0045_ops_closeout` and `0046_known_devices`, and PR #51 adds `0044_simulated_payments`. D1 applies files by name, so this works, but PR #51 should be renumbered before merging. This branch uses `0047`.

## 3. What this branch adds (focused on `main`, the code staging runs)

- **A real diagnostic job** (`src/services/runner-diagnostics.ts`, migration 0047). The Owner presses **Queue diagnostic job** on **AI builds → Node diagnostics**. That creates one `ai_jobs` row (workflow `gpu_diagnostic`) on the existing signed draft channel. The workload is the Founder's minimal Junk in the Trunk HTML prompt at temperature 0. Each checkpoint is written by the side that observed it:
  - D01 created and D02 persisted (read back).
  - D03 runner registered and D04 fresh (taken from `build_runners` at the moment of the claim).
  - D05 offered and D06 claimed (lease).
  - D07 runner acknowledged: host, pid, runner version, configured model.
  - D08 Ollama answering (`/api/version`).
  - D09 model loaded, with its share of GPU memory from `/api/ps` `size_vram`.
  - D10 inference sent (prompt hash).
  - D11 completed: Ollama's own durations, token counts and tokens per second.
  - D12 result received (bytes, SHA-256).
  - D13 terminal state persisted.

  The page names the **first failing or unproven step** and shows the artifact as escaped text. Diagnostics are never retried and never enter the human draft-approval queue. A runner older than this branch still serves the job as a plain draft: D07–D11 then show as "not reported", and D05/D06/D12/D13 still prove the round trip.
- **Platform connectivity view** on the same page: whether `BUILD_RUNNER_SECRET` is set, every runner that has ever authenticated with how fresh it is, and the latest rejected runner calls.
- **`runner/windows/Test-Node1Dispatch.ps1`**: a read-only report on layers 1–8, plus an optional real inference with `nvidia-smi` sampling (layer 9). It writes no secrets and is copied to `C:\CrestmontRunner` by the installer.
- **Tests:** `tests/runner-diagnostics.test.ts` and `runner/test/diagnostic.test.ts`. They are signed HTTP fixtures and a fake Ollama: they prove the recording is honest and **are not evidence of GPU execution**.

## 4. Founder steps (in this order)

1. **On Node 1, now, read-only.** Open PowerShell in the repository checkout and run:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\runner\windows\Test-Node1Dispatch.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\runner\windows\Test-Node1Dispatch.ps1 -InferenceProbe
   ```
   The second command loads the configured model and runs one small prompt. Attach `C:\CrestmontRunner\state\diagnostics\node1-diagnostic-<time>.txt` (it holds no secrets) to the Claude conversation. If the runner was installed in another folder, add `-InstallDir <folder>`.
2. **Confirm `BUILD_RUNNER_SECRET`.** It must be set as a GitHub secret for staging, with the same value saved on Node 1 in `C:\CrestmontRunner\secrets\build_runner_secret`. The script's L5 line tells you which side is wrong.
3. **Authorize merging this branch to `main`.** It applies migration 0047 on staging through the normal deploy. Then go to **AI builds → Node diagnostics → Queue diagnostic job** and wait for an idle poll (seconds to a few minutes).
4. **If the report shows that nobody is signed in, or that the machine sleeps,** choose one of these for unattended operation. Each one is a security and operations trade-off that's yours to decide:
   - Windows auto-logon for a dedicated local account (physical-access risk).
   - Ollama as a service through NSSM, plus Docker Engine without Docker Desktop. That is a larger change, not made here.
   - Power plan "never sleep on AC".

## 5. Not done (needs the machine or your authorization)

- No real D01–D13 run has happened: staging doesn't have this code until it's merged, and Node 1 wasn't reachable from this session.
- Restart, reconnect and duplicate-execution drills on Node 1. Leases already prevent double execution: one lease per job, and when a diagnostic's 15-minute lease expires, the sweep fails it instead of re-running it.
- No settings, services or models were changed on Node 1.
