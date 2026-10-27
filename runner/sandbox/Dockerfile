# Crestmont per-build SANDBOX image: the only place customer-generated code runs (agent commands, npm installs,
# builds, tests, acceptance checks, browser checks). The runner starts one container from it per build with
# --network none, a non-root user, --read-only root, tmpfs /tmp, --cap-drop ALL, no-new-privileges and CPU/RAM/PID
# limits (runner/src/sandbox.ts). It contains NO secrets, no Docker CLI and no credentials.
#
# Build (from the repository root):  docker build -t crestmont-build-sandbox:1 -f runner/sandbox/Dockerfile runner/sandbox
# Pin the base by digest after the first build you have reviewed: FROM node:22-bookworm-slim@sha256:<digest>
FROM node:26-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.55.0
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# bash + coreutils `timeout` (per-command limits), git (read-only use by build tools), ca-certificates.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash coreutils git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Playwright + Chromium and its OS libraries for browser validation (installed at image build time; the job
# containers have no network).
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && npm cache clean --force

COPY browser-check.mjs /opt/crestmont/browser-check.mjs

# Same uid as the runner (10001) so both can write the job's workspace; no login shell, no sudo.
RUN useradd --uid 10001 --create-home --home-dir /home/builder --shell /usr/sbin/nologin builder \
 && mkdir -p /workspace/repo \
 && chown -R builder:builder /workspace /home/builder \
 && chmod -R a+rX /opt/crestmont

USER builder
WORKDIR /workspace/repo
CMD ["sleep", "infinity"]
