# Crestmont per-build SANDBOX image: the only place customer-generated code runs (agent commands, npm installs,
# builds, tests, acceptance checks, browser checks). The runner starts one container from it per build with
# --network none, a non-root user, --read-only root, tmpfs /tmp, --cap-drop ALL, no-new-privileges and CPU/RAM/PID
# limits (runner/src/sandbox.ts). It contains NO secrets, no Docker CLI and no credentials.
#
# Build (from the repository root):  docker build -t crestmont-build-sandbox:1 -f runner/sandbox/Dockerfile runner/sandbox
# CI builds this image on every push and runs runner/ci/sandbox-self-check.ts against it (.github/workflows/ci.yml,
# job runner-images).
#
# Reproducibility: the base image is an exact version tag (pin it by digest once CI has printed the digest; see
# docs/ai-builds/RUNNER-SETUP.md section 12) and the npm packages come from package-lock.json via `npm ci`.
# Debian packages are not version-pinned (bookworm security updates); hadolint DL3008 is ignored for that reason.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
FROM ${NODE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/opt/crestmont/node_modules \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# bash + coreutils `timeout` (per-command limits), git (read-only use by build tools), ca-certificates.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash coreutils git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Playwright (exact version from package-lock.json) + its Chromium and OS libraries for browser validation, installed
# at image build time (the job containers have no network).
WORKDIR /opt/crestmont
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && ./node_modules/.bin/playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright /opt/crestmont \
 && npm cache clean --force

COPY browser-check.mjs /opt/crestmont/browser-check.mjs

# Same uid as the runner (10001) so both can write the job's workspace; no login shell, no sudo. Setuid/setgid bits
# are removed from every binary (su, passwd, mount, ...): no-new-privileges already neutralises them at run time;
# this makes the image safe even if a container were started without it.
RUN useradd --uid 10001 --create-home --home-dir /home/builder --shell /usr/sbin/nologin builder \
 && mkdir -p /workspace/repo \
 && chown -R builder:builder /workspace /home/builder \
 && chmod -R a+rX /opt/crestmont \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

USER builder
WORKDIR /workspace/repo
CMD ["sleep", "infinity"]
