# Crestmont AI Builds runner image.
# Build from the repository root:   docker build -t crestmont-ai-runner -f runner/Dockerfile runner
# See docs/ai-builds/RUNNER-SETUP.md for the run command, volumes and environment.
FROM node:22-bookworm

ARG PLAYWRIGHT_VERSION=1.55.0
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# git (job repositories), bubblewrap + socat (Claude Code sandbox on Linux), tini (signal handling).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bubblewrap socat tini \
 && rm -rf /var/lib/apt/lists/*

# Playwright + Chromium (and its OS libraries) for browser verification by the agent's skills.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && chmod -R a+rX /ms-playwright

# Non-root user; the runner never needs root at runtime.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner \
 && mkdir -p /workspaces /skills /app \
 && chown runner:runner /workspaces

WORKDIR /app
COPY package.json ./
# No lockfile is committed yet (the SDK version is pinned exactly). After the first successful install, commit
# runner/package-lock.json and switch this line to `npm ci --omit=dev`.
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY skills ./skills
COPY starters ./starters
RUN chown -R root:root /app && chmod -R a+rX /app

USER runner
ENV HOME=/home/runner \
    RUNNER_WORKSPACES=/workspaces \
    SKILLS_SOURCE_DIR=/skills \
    RUNNER_SECRETS_DIR=/run/secrets
VOLUME ["/workspaces"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "src/main.ts"]
