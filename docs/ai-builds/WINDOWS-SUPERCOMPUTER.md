# AI Builds on the Windows build machine (self-hosted, no per-token fees)

**Status: designed and mock-tested only.** Nothing in this document has run on the Windows machine yet. Its hardware
is unknown to this repository, so the model is chosen by `select-model.ts` from what `Discover-Hardware.ps1`
reports, not assumed. The first real build is the controlled validation in `LOCAL-VALIDATION.md`. Until that
passes, do not describe local AI builds as operational. What has been verified off the host (lint, real Squid,
compose networks, PowerShell parse/analysis, sandbox flags with a real Docker daemon, CI image builds) and what only
the host can show is tabled in `LOCAL-VALIDATION.md` § "Validation status".

## What runs where

```
 Crestmont platform (Cloudflare Worker, control plane)
        ^  HTTPS, outbound only: claim / heartbeat / checkpoint / complete / ai/claim / ai/complete (HMAC-signed)
        |
 Windows machine ─ Docker Desktop (WSL 2 backend, Linux containers)
   ├─ egress-proxy  (Squid allow-list; the only way out of the internal networks; logs every request)
   ├─ runner        (Node orchestrator; internal network only; talks to Docker to create sandboxes)
   │     └─ per-build sandbox container   docker run --network none, non-root, read-only, cap-drop ALL,
   │        (one per build, removed after)  CPU/RAM/PID limits, only that build's repo + home mounted
   │     └─ per-install container         docker run --network crestmont_install (proxy -> registry.npmjs.org only),
   │                                       npm ci/install --ignore-scripts
   └─ Ollama        native Windows app (GPU), 127.0.0.1:11434 only    [or: profile ollama-in-docker]
```

- **No inbound port, no firewall rule.** Nothing is published on any interface. The runner polls the platform.
  The health endpoint listens on 127.0.0.1 inside the runner container. `Get-RunnerHealth.ps1` reads it with
  `docker exec`.
- **Paid inference is off.** `RUNNER_AGENT_PROVIDER=local` is the default and the installer writes
  `RUNNER_ALLOW_PAID_PROVIDER=false`. The Claude Agent SDK adapter refuses to start without that flag. The runner
  never falls back to it. The proxy denies `anthropic.com`, `claude.ai`, `openai.com` and the other hosted AI APIs,
  and logs the denials.
- **Customer code never runs on the Windows host, or in the runner process.** It runs only inside the per-build
  sandbox: agent commands, installs, builds, the starter's `npm run check` and the browser check. The model's file
  tools stay inside the build's repository (realpath check). `.git` internals are off limits.
- **Customer instructions are data.** The brief reaches the model only inside a block marked
  `<<BEGIN/END UNTRUSTED CUSTOMER DATA>>`. The rules (BRIEF_RULES) live in a fixed system prompt. The model's
  output is limited to tool calls that the runner validates.

## Research summary (sources retrieved 2026-10-27; unverified items marked)

### Ollama
| Fact | Source |
| --- | --- |
| OpenAI-compatible `/v1/chat/completions` supports `tools`. `tool_choice` is not supported. Clients must send an API key, which Ollama ignores. | https://docs.ollama.com/api/openai-compatibility |
| The OpenAI API has no context-size parameter. Set it with `OLLAMA_CONTEXT_LENGTH` or a Modelfile `PARAMETER num_ctx`. | same |
| Native `/api/chat` takes `tools`. It returns `message.tool_calls[].function.arguments` as an **object**. Tool results go back as `{"role":"tool","tool_name":…}`. Several calls can come in one response. | https://docs.ollama.com/capabilities/tool-calling |
| Binds 127.0.0.1:11434 by default (`OLLAMA_HOST`). The default context is 4096. `OLLAMA_CONTEXT_LENGTH` sets it. `OLLAMA_NUM_PARALLEL` defaults to 1, and "required RAM will scale by NUM_PARALLEL × CONTEXT_LENGTH". `OLLAMA_KEEP_ALIVE` defaults to 5 min (negative = keep loaded). `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_MAX_QUEUE` (512) and `OLLAMA_FLASH_ATTENTION=1` are available. `OLLAMA_KV_CACHE_TYPE` accepts q8_0 (≈ half of f16) or q4_0. `ollama ps` shows the GPU/CPU split. | https://docs.ollama.com/faq |
| Windows needs 10 22H2 or newer. NVIDIA needs driver 551.61+. AMD runs through ROCm v7 or Vulkan. Install without admin to the home directory (`/DIR=` to change). Logs are `%LOCALAPPDATA%\Ollama\server.log` and `app.log`. Models live in `%HOMEPATH%\.ollama` (`OLLAMA_MODELS` moves them). A standalone zip can run `ollama serve` as a service under NSSM. | https://docs.ollama.com/windows |

### Models (all Apache-2.0 unless noted)
| Model (Ollama tag) | Size / memory | Context | Tool calling | License | Source |
| --- | --- | --- | --- | --- | --- |
| `qwen3-coder:30b` (Qwen3-Coder-30B-A3B-Instruct, Q4_K_M) | 30.5B total / 3.3B active. 19 GB download *(secondary source)*. Unsloth: ≥ 18 GB unified memory for 6+ tok/s at 4-bit. | 256K native | "excels in tool calling" | Apache-2.0 | [HF card](https://huggingface.co/Qwen/qwen3-coder-30b-a3b-instruct), [Unsloth](https://unsloth.ai/docs/models/tutorials/qwen3-coder-how-to-run-locally), [tag sizes (secondary)](https://theaitechpulse.com/qwen3-coder-ollama-2026) |
| `qwen3-coder:30b-a3b-q8_0` | 32 GB download *(secondary)*. Unsloth Q8: ≥ 33 GB. | 256K | yes | Apache-2.0 | same |
| `qwen3-coder-next:q8_0` (80B / 3B active) | 85 GB. The Q4_K_M GGUF is 48.4 GB. | 256K | yes; "works with coding agents like Claude Code, Qwen Code, Cline, OpenCode" | Apache-2.0 | [Ollama registry](https://registry.ollama.ai/library/qwen3-coder-next:q8_0), [HF GGUF](https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF) |
| `devstral-small-2` (24B dense) | "single RTX 4090 or a Mac with 32GB RAM". Q8 fits in 25 GB (Unsloth). | 256K (min. 16K recommended) | yes (`mistral` parser) | Apache-2.0 | [HF card](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512), [Mistral](https://mistral.ai/news/devstral-2-vibe-cli/), [Unsloth](https://unsloth.ai/docs/models/tutorials/devstral-2) |
| Devstral 2 (123B) | "minimum of 4 H100-class GPUs" | 256K | yes | **modified MIT** (read before use) | [Mistral](https://mistral.ai/news/devstral-2-vibe-cli/) |
| `gpt-oss:20b` (21B / 3.6B active) | "run within 16GB of memory" | not stated in source | function calling | Apache-2.0 | [model card](https://dell.huggingface.co/models/openai/gpt-oss-20b) |
| `qwen3-coder:480b` | 290 GB at Q4_K_M *(secondary)* | 256K | yes | Apache-2.0 | out of scope for one machine |
| Qwen3.6-35B-A3B | 35B / 3B active. OpenHands: "at least 24GB of VRAM for quantized variants". | 262K | not checked | **license not verified** | [OpenHands](https://docs.openhands.dev/openhands/usage/llms/local-llms.md), [vLLM recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B) |

Not verified here: the official `ollama.com/library/qwen3-coder` tag list (that page could not be fetched; the sizes
come from a secondary source quoting it), the default quantization of `devstral-small-2`, and the Ollama tag and
license of Qwen3.6-35B-A3B. Confirm with `ollama show <tag>` on the machine. `*-cloud` tags run remotely
(Ollama Cloud). The runner refuses them, as it refuses hosted API base URLs.

### Coding agents that work with local models
| Agent | How it uses Ollama | Fit for unattended per-build sandboxes |
| --- | --- | --- |
| OpenHands | OpenAI-compatible `http://host.docker.internal:11434/v1`. Needs `OLLAMA_CONTEXT_LENGTH` ≥ 22000. The quickstart mounts `/var/run/docker.sock` into the OpenHands container. Docs recommend Qwen3.6-35B-A3B with a 24 GB+ GPU. | Strong agent, but it orchestrates its own sandboxes through the Docker socket and has its own server/UI. Running it per build would give an agent process the Docker socket, and the socket is the boundary this design keeps away from anything the model drives. [docs](https://docs.openhands.dev/openhands/usage/llms/local-llms.md) |
| goose | Ollama provider via `OLLAMA_HOST`. "goose extensively uses tool calling, so models without it can only do chat completion". The 4096 default context is too low. | Desktop/CLI agent with its own extension system. It runs commands on the machine it runs on, so it would have to live inside the sandbox together with model access. [docs](https://goose-docs.ai/docs/getting-started/providers) |
| Qwen Code | CLI configured with `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`. Headless mode is not documented on the page read. | Node CLI. It would also run commands where it runs. [LiteLLM tutorial](https://docs.litellm.ai/docs/tutorials/litellm_qwen_code_cli) |
| opencode | Ollama via a provider config. Community notes: "Tool calling requires a model trained for it". `qwen3-coder:30b` "runs at 4k" unless `num_ctx` is raised. | Same shape as Qwen Code. [community setup](https://github.com/imagewize/ollama-opencode-setup) |
| Aider | Not evaluated beyond search results (no official page fetched). Aider edits through diff formats rather than tool calls. | Not chosen. Unverified. |

**Decision: an in-house tool loop (`runner/src/providers/local.ts`) instead of an existing agent.** Reasons:
1. *Isolation.* The runner keeps the Docker socket. The model only reaches a fixed set of tools. Commands run in a
   container with `--network none`, and installs go through an allow-listed proxy. Each existing agent wants either
   the Docker socket (OpenHands) or to run commands where it runs, which would mean model access from inside the
   sandbox.
2. *Control-plane integration.* Heartbeats, server-side stop, lease loss, checkpoints with a resumable transcript,
   requirement statuses and the owner report already exist in the runner. Wrapping a third-party CLI would lose
   interrupt and resume semantics.
3. *Weaker-model robustness*, built in where it is needed: strict schema validation with corrective feedback,
   a parser for tool calls printed as text (Qwen-style `<tool_call>`, fenced JSON), bounded retries, loop detection,
   a rolling context summary, and turn, time and output-token caps.
4. *Licensing and supply chain.* The loop has no runtime dependencies. The local default needs no npm packages.

The cost is a smaller tool set than mature agents offer. If the validation shows the model handles the loop well
but needs more capability, the provider interface (`AgentProvider`) allows adding an adapter for an existing agent
that runs entirely inside the sandbox.

## Hardware discovery (`Discover-Hardware.ps1`)

Read-only. It needs no admin rights, installs nothing, writes nothing except to stdout, and sends only two HEAD
requests (the platform URL and `https://registry.npmjs.org/`).

```powershell
powershell -ExecutionPolicy Bypass -File .\runner\windows\Discover-Hardware.ps1 -PlatformUrl https://<platform> | Out-File -Encoding utf8 hardware.json
```

Output schema `crestmont.hardware/1`:

| Field | Meaning |
| --- | --- |
| `collectedAt` | ISO time |
| `os.caption/version/build/edition/displayVersion/architecture` | Windows edition and build |
| `cpu.name/sockets/cores/logicalProcessors/maxClockMHz/virtualizationFirmwareEnabled/loadPercent` | CPU and load snapshot |
| `memory.totalGB/freeGB/usedPercent` | RAM |
| `gpus[].name/vendor/vramGB/vramReliable/driverVersion/source/utilizationPercent/memoryUsedGB` | `source` is `nvidia-smi` (reliable), `registry qwMemorySize`, or `Win32_VideoController`. `vramReliable:false` means the 32-bit `AdapterRAM` field, which caps near 4 GB. |
| `disks[].drive/freeGB/totalGB/fileSystem` | Fixed drives |
| `virtualization.hypervisorPresent/firmwareEnabled/wslInstalled/wslVersion2/wslStatusRaw` | WSL 2 status (`wsl --status`) |
| `docker.installed/desktopInstalled/clientVersion/serverVersion/serverReachable` | Docker Desktop |
| `ollama.installed/version/listening/models[]/hostSetting` | Ollama and its pulled models |
| `network.platformUrl/platform{reachable,status}/npmRegistry{reachable,status}` | Outbound reachability |
| `warnings[]` | Anything that could not be read |

## Model decision table (`runner/windows/select-model.ts`)

Run by the installer inside the runner image (no Node needed on Windows), or by hand:
`node --no-warnings runner/windows/select-model.ts hardware.json`. "VRAM" means the total of NVIDIA/AMD GPU memory
(Ollama on Windows does not accelerate Intel GPUs). Headroom of +4 GB over the model file for KV cache and runtime
at 32K context is an **estimate**. Confirm it on the machine: `ollama ps` should show `100% GPU`.

| Tier | Condition | Model | Context | Notes |
| --- | --- | --- | --- | --- |
| A | VRAM ≥ 89 GB and RAM ≥ 64 GB | `qwen3-coder-next:q8_0` | 65536 | alt: `qwen3-coder:30b-a3b-q8_0` |
| B | VRAM ≥ 36 GB | `qwen3-coder:30b-a3b-q8_0` | 32768 (65536 if ≥ 48 GB) | alt: `devstral-small-2`, `qwen3-coder:30b` |
| C | VRAM ≥ 23 GB | `qwen3-coder:30b` (Q4_K_M) | 32768 | alt: `devstral-small-2` |
| D | VRAM ≥ 16 GB and RAM ≥ 32 GB | `qwen3-coder:30b` with CPU offload, KV q8_0 | 32768 | slower; alt `gpt-oss:20b` (quality unverified) |
| E | no usable GPU, RAM ≥ 48 GB and ≥ 8 threads | `qwen3-coder:30b`, CPU only | 32768 | validation only; long build times |
| — | anything else | **insufficient**: do not deploy | | |

Blockers in any tier: NVIDIA driver older than 551.61, missing WSL or Docker Desktop, or less than model size plus
40 GB of free disk (estimate). Always set: `OLLAMA_NUM_PARALLEL=1` (one build *or* one draft at a time),
`OLLAMA_MAX_LOADED_MODELS=1` and `OLLAMA_KEEP_ALIVE=60m`. Flash attention is on with a GPU. The KV cache is f16
when VRAM is plentiful, otherwise q8_0. Per-build container limits: ¼ of the CPU threads (2 to 8) and about 15% of
RAM (4 to 8 GB), leaving the rest to the model server.

## Install (Founder)

Prerequisites you provide: an administrator account on the machine, the `BUILD_RUNNER_SECRET` value (the same value
as the platform's Worker secret, see `RUNNER-SETUP.md` §3), and a checkout of this repository on the machine.

```powershell
# Elevated PowerShell, in the repository checkout:
Set-ExecutionPolicy -Scope Process Bypass
.\runner\windows\Discover-Hardware.ps1 -PlatformUrl https://<platform> | Out-File -Encoding utf8 $env:TEMP\hw.json   # look first
.\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://<platform>            # report only
.\runner\windows\Install-CrestmontRunner.ps1 -PlatformUrl https://<platform> -Install   # install missing pieces
```

The installer is idempotent. It:
1. checks Windows ≥ build 19045, that `wsl --status` succeeds (the WSL 2 default version itself is not checked; confirm
   `wsl --status` shows "Default Version: 2"), Docker Desktop (Linux containers, engine ≥ 26) and Ollama. With `-Install`
   it runs `winget install --exact --id Docker.DockerDesktop` / `Ollama.Ollama` and `wsl --install --no-distribution`
   (a reboot follows; re-run afterwards). The winget package ids are from memory: check them with `winget show <id>`.
2. writes `C:\CrestmontRunner\state\hardware.json`.
3. creates `C:\CrestmontRunner\{compose,state,secrets,skills,logs,evidence}`. Inheritance is removed, and only
   SYSTEM, Administrators and your account have access. The secret is entered hidden (or `-SecretFile`), stored
   without a newline and never printed.
4. builds `crestmont-ai-runner:1` and `crestmont-build-sandbox:1` (`crestmont-egress-proxy:1` is built at step 8) (pinned base image
   tags pinned by digest, `npm ci` from the committed lockfiles, see `RUNNER-SETUP.md` §12). CI builds the same three
   images on every push.
5. writes `state\recommendation.json` and stops with the reasons when the machine is insufficient. `-Model <tag>`
   overrides only the model choice (`modelChoiceBlockers`); driver, disk, WSL and Docker blockers still stop it.
6. sets Ollama's user environment (`OLLAMA_HOST=127.0.0.1:11434`, context length, parallelism, keep-alive, flash
   attention, KV cache type), restarts Ollama, verifies that it listens on loopback only, and pulls the model.
7. writes `compose\docker-compose.yml`, `compose\proxy\squid.conf` (the allow-list with your platform host,
   rendered by `SquidConf.ps1`, which validates every host and refuses hosted AI domains as `-ExtraEgressDomains`;
   the same rendering is unit-tested as `egress-policy.ts`), the managed `compose\runner.env` (names, URLs and
   limits only; rewritten on every run, backed up when it changes) and, once, `compose\runner.local.env` for your
   own settings (never overwritten; managed or sandbox-weakening keys there stop the installer; `RunnerEnv.ps1`).
   The secret is mounted from `secrets\`. `compose\.env` pins `OLLAMA_IMAGE` (`-OllamaImage`).
8. checks that a container on the internal network can list the model through the proxy, then runs the runner's
   `--preflight` (skills, model present, sandbox image present).
9. runs `docker compose up -d` and registers the `CrestmontRunner-Start` scheduled task at your logon.

**Exact Founder sequence, prerequisites, decisions and known installer issues (2026-10-28 audit):**
`FOUNDER-RUNNER-INSTALL.md`. Read it before running the installer.

Copy the curated skills to `C:\CrestmontRunner\skills\` first (see `RUNNER-SETUP.md` §6). For the local model they
are reference guides the agent reads, not Claude skills. Required ones still fail preflight when missing.

### Ollama native vs. Ollama in Docker
- **Native (default).** It uses the GPU directly (NVIDIA or AMD per Ollama's Windows docs) and keeps the Ollama
  defaults and logs in `%LOCALAPPDATA%\Ollama`. It listens on 127.0.0.1 only. Containers reach it as
  `host.docker.internal:11434` through the proxy. **Unverified:** whether Docker Desktop forwards
  `host.docker.internal` to a listener bound only to 127.0.0.1 on this Docker Desktop version. The installer tests
  it (step 8). If the test fails, do not widen `OLLAMA_HOST` to `0.0.0.0`, because that exposes the model on the
  network. Use the alternative below.
- **In Docker (`-OllamaInDocker`, compose profile `ollama-in-docker`).** Docker's GPU passthrough on Windows is
  "only available on Windows with the WSL 2 backend" and NVIDIA-only (https://docs.docker.com/desktop/features/gpu/).
  The model server then sits on the internal network with no published port, and model pulls go through the proxy.
  Trade-offs: no AMD acceleration, models live in a Docker volume (`crestmont-ollama-models`) inside the WSL VM's
  disk, the image tag is pinned (`-OllamaImage`, default `ollama/ollama:0.32.0`: that GitHub release exists; the
  Docker Hub tag was not checked from here), and GPU-PV performance may differ (unmeasured).
- **Proxy rule for the model (either mode).** Node's `fetch` behind `HTTP_PROXY` (`NODE_USE_ENV_PROXY=1`) tunnels
  even `http://` URLs with CONNECT, so the proxy allows CONNECT to `host.docker.internal`/`ollama` on port 11434 from
  the runner network only. Without that rule every model call was denied (found with a real Squid locally).

## Isolation details

| Control | Where |
| --- | --- |
| One sandbox container per build (`cm-job-<workspace ref>`), removed at job end or on interrupt | `runner/src/sandbox.ts` |
| `--network none` for agent commands, builds, tests and browser checks | `JobSandbox.hardeningFlags("none")` |
| Installs only on `crestmont_install` (internal network). Its only egress is the proxy, and the proxy allows only `registry.npmjs.org`. `npm ci`/`npm install --ignore-scripts`. Packages listed in `RUNNER_ALLOWED_BUILD_SCRIPTS` get `npm rebuild` offline afterwards. Package specs are validated (no URLs, git, files or tarballs). | `JobSandbox.install`, `validatePackageSpec`, `squid.conf.template` |
| Non-root uid 10001, `--read-only`, `--tmpfs /tmp` (size-limited), `--cap-drop ALL`, `no-new-privileges`, `--cpus`, `--memory` = `--memory-swap`, `--pids-limit` | `hardeningFlags` |
| Mounts: only `<ref>/repo` → `/workspace/repo` and `<ref>/home` → `/home/builder` (volume sub-paths). No Docker socket, host home, secrets or other builds. | `mountFlags` |
| Per-command timeout via in-container `timeout -k 5`. A hung client restarts the container. | `JobSandbox.argv` |
| Disk quota: the job directory is measured after each command and install. Over `RUNNER_JOB_DISK_MB` the phase fails. `--storage-opt size` is not used: it needs overlay2 on xfs with pquota, which Docker Desktop's VM does not provide. | `overDiskQuota` |
| Runner: internal network only, read-only root, cap-drop ALL, all egress through the proxy (`NODE_USE_ENV_PROXY=1`) | `docker-compose.yml` |
| Proxy: Squid as the unprivileged `proxy` user, cap-drop ALL with nothing added back, paid AI hosts denied first (`TCP_DENIED`, logged), every allow-list host validated | `proxy/Dockerfile`, `squid.conf.template`, `SquidConf.ps1` |
| Sandbox image: no setuid/setgid binaries, no curl/wget/ssh/docker/sudo, Playwright from a lockfile | `sandbox/Dockerfile`, checked by `runner/ci/sandbox-self-check.ts` in CI |
| Model file tools: realpath confinement to the repository; `.git`, `.claude` and runner check results protected | `providers/local-tools.ts` |
| Audit: runner JSON logs (secrets redacted), proxy access log, checkpoints (git bundle + agent transcript), owner report with model, tokens and time | |

**Residual risks.** The runner container holds the Docker socket, which is root-equivalent inside Docker Desktop's
VM. It runs only runner code and never model output, but a runner compromise would mean control of the VM. Docker
Desktop's VM is the boundary between containers and Windows. Kernel or container-escape vulnerabilities in it are
not mitigated beyond the flags above. `workers.dev` previews (if enabled) are public to anyone with the link.

## Operations

- **Health:** `C:\CrestmontRunner\Get-RunnerHealth.ps1` prints the container states, the runner health JSON
  (provider, model, current job, last claim, `modelReachable` / `modelCheckedAt` from a `GET /v1/models` probe every
  5 minutes, `lastModelError`, `lastJobOutcome` / `lastJobError`, `lastDraftError`) and the Ollama version. Error
  texts are truncated and pass through the log redactor (no secrets, no URL credentials or query strings). The
  compose healthcheck uses the same endpoint; it reports unhealthy while the model server is unreachable.
- **Model server down:** while the probe fails the runner claims neither builds nor drafts (so an Ollama outage
  does not burn build attempts), re-probes every poll interval and resumes on its own. A model failure inside a
  build fails that attempt honestly (no paid fallback) and forces a re-probe before the next claim.
- **Control plane unreachable during a build:** heartbeats are retried; if none succeeds for the lease window (the
  lease time left at claim, 30 s..10 min), the runner stops the agent and keeps the workspace without completing, as
  for `lease_lost`, because the server may already have given the job to another attempt.
- **Logs:** `docker compose logs runner` (JSON lines, secrets redacted), `docker compose logs egress-proxy` (one
  line per outbound request) and `%LOCALAPPDATA%\Ollama\server.log`. Docker rotates container logs (json-file,
  20 MB × 10). `logs\start.log` is trimmed to about 2000 lines.
- **Stop / restart:** `docker compose stop runner` sends SIGTERM. The runner interrupts the agent, checkpoints and
  completes the build as `released`, which requeues it without spending an attempt (300 s grace).
- **Reboot recovery:** Docker Desktop and the Ollama tray app start in a user session. The `CrestmontRunner-Start`
  task runs at your logon, starts both, waits for the engine and runs `docker compose up -d` (containers also have
  `restart: unless-stopped`). For unattended reboots, either sign the account in automatically (Windows
  auto-logon; weigh the physical-access risk) or run Ollama as a service from the standalone zip with NSSM (Ollama's
  Windows docs). Docker Desktop itself cannot start before logon (Docker forum, unresolved). A build that was running
  when the machine went down is not lost. Its lease expires (180 s), the platform's 15-minute sweep requeues it with
  its resume data, and the runner restores the checkpoint when it claims it again: the git bundle plus the local
  agent transcript, from the local workspace volume or via `checkpoint/fetch`.
- **AI drafts:** with `RUNNER_SERVE_AI_DRAFTS=true` (the default with the local provider), the runner serves short
  platform drafts (`/api/builds/runner/ai/claim` and `/ai/complete`) while no build is running, one at a time. Each
  draft is a single model call with no tools, using the system and user messages exactly as given. No cost is sent
  (the platform records $0). Drafts are never served by a paid provider. `RUNNER_AI_DRAFTS_PROVIDER=claude` is
  refused without `RUNNER_ALLOW_PAID_PROVIDER=true`, and even with it this runner has no paid drafts adapter.
- **Retention:** workspaces live in the `crestmont-workspaces` volume. Prune them under
  `docs/RETENTION-SCHEDULE.md`, for example
  `docker run --rm -v crestmont-workspaces:/w alpine find /w -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} +`.

## Configuration added for the local provider

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUNNER_AGENT_PROVIDER` | `local` | `local` or `claude-agent-sdk` (paid, optional) |
| `RUNNER_ALLOW_PAID_PROVIDER` | `false` | must be `true` for the SDK adapter; never a fallback |
| `LOCAL_MODEL` | (required for local) | Ollama tag, e.g. `qwen3-coder:30b` |
| `LOCAL_MODEL_BASE_URL` | `http://host.docker.internal:11434/v1` | OpenAI-compatible base; hosted AI API hosts are refused |
| `LOCAL_MODEL_CONTEXT_TOKENS` | `32768` | must match `OLLAMA_CONTEXT_LENGTH`; drives context management |
| `LOCAL_MODEL_MAX_OUTPUT_TOKENS` / `RUNNER_LOCAL_MAX_OUTPUT_TOKENS` | `8192` / `2000000` | per call / per attempt |
| `LOCAL_MODEL_TEMPERATURE`, `LOCAL_MODEL_REQUEST_TIMEOUT_SECONDS` | `0.2`, `900` | |
| `RUNNER_SANDBOX_IMAGE` | `crestmont-build-sandbox:1` | per-build image |
| `RUNNER_SANDBOX_VOLUME` | (empty = bind mounts) | `crestmont-workspaces` in compose |
| `RUNNER_JOB_CPUS` / `RUNNER_JOB_MEMORY` / `RUNNER_JOB_PIDS` / `RUNNER_JOB_TMPFS_MB` / `RUNNER_JOB_DISK_MB` | `2` / `4g` / `512` / `512` / `4096` | per-build limits |
| `RUNNER_JOB_COMMAND_TIMEOUT_SECONDS` / `RUNNER_JOB_INSTALL_TIMEOUT_SECONDS` | `600` / `900` | |
| `RUNNER_INSTALL_NETWORK` / `RUNNER_INSTALL_PROXY` / `RUNNER_NPM_REGISTRY` | `crestmont_install` / `http://egress-proxy:3128` / npmjs | |
| `RUNNER_ALLOWED_BUILD_SCRIPTS` | (none) | packages whose install scripts may run, offline |
| `RUNNER_BROWSER_CHECK` | `on` | headless Chromium check of `public/` in the sandbox |
| `RUNNER_SERVE_AI_DRAFTS` / `RUNNER_AI_DRAFTS_PROVIDER` | `true` with local / `local` | AI drafts |
| `RUNNER_HEALTH_PORT` / `RUNNER_HEALTH_HOST` | off / `127.0.0.1` | compose sets 8787 |
