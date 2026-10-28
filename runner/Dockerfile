# Crestmont AI Builds runner image (the orchestrator; it never runs customer code itself in the default local mode).
# Build (from the repository root):   docker build -t crestmont-ai-runner:1 -f runner/Dockerfile runner
# Windows deployment: runner/windows/Install-CrestmontRunner.ps1 builds it. See docs/ai-builds/WINDOWS-SUPERCOMPUTER.md.
# CI builds the default variant on every push and checks it (.github/workflows/ci.yml, job runner-images).
#
# Default (local provider): Node + git + tar + the Docker CLI (to start per-job sandbox containers from
# runner/sandbox/Dockerfile). No runtime npm packages: `npm ci` against the committed package-lock.json installs
# nothing and fails if package.json and the lockfile disagree.
# The optional, PAID Claude Agent SDK adapter and the tools it needs inside this image (the SDK and Playwright from
# agent-sdk/package-lock.json, Chromium, bubblewrap, socat) are installed only with --build-arg INSTALL_AGENT_SDK=true,
# and that build fails until agent-sdk/package-lock.json has been generated, reviewed and committed.
#
# Base images are exact version tags; pin them by digest once CI has printed the digests (RUNNER-SETUP.md section 12).
# Docker CLI: volume-subpath mounts need Docker Engine/CLI >= 26.0 (https://docs.docker.com/engine/release-notes/26.0/).
# Debian packages are not version-pinned (bookworm security updates); hadolint DL3008 is ignored for that reason.
ARG DOCKER_CLI_IMAGE=docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${NODE_IMAGE}

ARG INSTALL_AGENT_SDK=false
# Founder V3 (Claude-only orchestrator): the Claude Code CLI for subscription-signed-in builder workers.
ARG INSTALL_CLAUDE_CODE=false
ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git (job repositories), tar (checkpoints), tini (signal handling), ca-certificates.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tar ca-certificates tini \
 && if [ "$INSTALL_AGENT_SDK" = "true" ] || [ "$INSTALL_CLAUDE_CODE" = "true" ]; then apt-get install -y --no-install-recommends bubblewrap socat; fi \
 && rm -rf /var/lib/apt/lists/*

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# Non-root user (uid 10001, same as the sandbox's builder user so both can write job workspaces).
# Docker socket access is granted at run time through the socket's group (compose `group_add`), not root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner \
 && mkdir -p /workspaces /skills /app \
 && chown runner:runner /workspaces

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Optional paid adapter only: the SDK + Playwright (locked) and Chromium for the Agent SDK's in-process browser skills.
# /app/node_modules points at agent-sdk/node_modules so `import("@anthropic-ai/claude-agent-sdk")` resolves.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# (The [n] glob lets the default build proceed while agent-sdk/package-lock.json is not committed yet.)
COPY agent-sdk/package.json agent-sdk/package-lock.jso[n] /app/agent-sdk/
RUN if [ "$INSTALL_AGENT_SDK" = "true" ]; then \
      if [ ! -f /app/agent-sdk/package-lock.json ]; then \
        echo "INSTALL_AGENT_SDK=true needs runner/agent-sdk/package-lock.json (see RUNNER-SETUP.md section 12)" >&2; exit 1; \
      fi \
      && npm ci --prefix /app/agent-sdk --omit=dev --no-audit --no-fund \
      && rm -rf /app/node_modules && ln -s /app/agent-sdk/node_modules /app/node_modules \
      && /app/agent-sdk/node_modules/.bin/playwright install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/* \
      && chmod -R a+rX /ms-playwright \
      && npm cache clean --force; \
    fi

# Claude Code (V3 builder workers): the CLI + Playwright (locked) and Chromium. Signed in per worker at run time
# (CLAUDE_CODE_CONFIG_DIR, mounted per account); the image holds no credential.
COPY claude-code/package.json claude-code/package-lock.jso[n] /app/claude-code/
RUN if [ "$INSTALL_CLAUDE_CODE" = "true" ]; then \
      if [ ! -f /app/claude-code/package-lock.json ]; then \
        echo "INSTALL_CLAUDE_CODE=true needs runner/claude-code/package-lock.json (see docs/ai-builds/ORCHESTRATOR.md)" >&2; exit 1; \
      fi \
      && npm ci --prefix /app/claude-code --omit=dev --no-audit --no-fund \
      && ln -s /app/claude-code/node_modules/.bin/claude /usr/local/bin/claude \
      && /app/claude-code/node_modules/.bin/playwright install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/* \
      && chmod -R a+rX /ms-playwright \
      && npm cache clean --force; \
    fi

COPY src ./src
COPY skills ./skills
COPY starters ./starters
COPY windows/select-model.ts ./windows/select-model.ts
RUN chown -R root:root /app && chmod -R a+rX /app

USER runner
ENV HOME=/home/runner \
    RUNNER_WORKSPACES=/workspaces \
    SKILLS_SOURCE_DIR=/skills \
    RUNNER_SECRETS_DIR=/run/secrets
VOLUME ["/workspaces"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "src/main.ts"]
