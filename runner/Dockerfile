# Crestmont AI Builds runner image (the orchestrator; it never runs customer code itself in the default local mode).
# Build from the repository root:   docker build -t crestmont-ai-runner:1 -f runner/Dockerfile runner
# Windows deployment: runner/windows/Install-CrestmontRunner.ps1 builds it. See docs/ai-builds/WINDOWS-SUPERCOMPUTER.md.
#
# Default (local provider): Node + git + tar + the Docker CLI (to start per-job sandbox containers from
# runner/sandbox/Dockerfile). The optional, PAID Claude Agent SDK adapter and the tools it needs inside this image
# (Playwright Chromium, bubblewrap, socat) are installed only with --build-arg INSTALL_AGENT_SDK=true.
#
# Docker CLI: copied from the official docker CLI image. volume-subpath mounts need Docker Engine/CLI >= 26.0
# (https://docs.docker.com/engine/release-notes/26.0/). Pin the tag (and ideally the digest) you reviewed.
ARG DOCKER_CLI_IMAGE=docker:27.5.1-cli
FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM node:22-bookworm-slim

ARG INSTALL_AGENT_SDK=false
ARG PLAYWRIGHT_VERSION=1.55.0
ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# git (job repositories), tar (checkpoints), tini (signal handling), ca-certificates.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tar ca-certificates tini \
 && if [ "$INSTALL_AGENT_SDK" = "true" ]; then apt-get install -y --no-install-recommends bubblewrap socat; fi \
 && rm -rf /var/lib/apt/lists/*

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# Optional paid adapter only: Playwright + Chromium for the Agent SDK's in-process browser skills.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_PATH=/usr/local/lib/node_modules
RUN if [ "$INSTALL_AGENT_SDK" = "true" ]; then \
      npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
      && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
      && chmod -R a+rX /ms-playwright; \
    fi

# Non-root user (uid 10001, same as the sandbox's builder user so both can write job workspaces).
# Docker socket access is granted at run time through the socket's group (compose `group_add`), not root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner \
 && mkdir -p /workspaces /skills /app \
 && chown runner:runner /workspaces

WORKDIR /app
COPY package.json ./
# No package-lock.json is committed yet (it could not be generated without registry access; see
# docs/ai-builds/RUNNER-SETUP.md "Dependency locking"). The local default has NO runtime npm dependencies.
# The SDK (optionalDependencies, pinned exactly) is installed only for the paid adapter.
RUN if [ "$INSTALL_AGENT_SDK" = "true" ]; then npm install --omit=dev --no-audit --no-fund; else npm install --omit=dev --omit=optional --no-audit --no-fund; fi \
 && npm cache clean --force
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
