# Crestmont file scanner (SEC-003). Build from the repository root:
#   docker build -t crestmont-file-scanner:1 -f scanner/Dockerfile scanner
# The same exact Node base image as the build runner (runner/Dockerfile), pinned by digest. No npm packages: the
# scanner uses Node's standard library only, so there is nothing to install and no supply chain to audit.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production HEALTH_PORT=8790
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--no-warnings", "src/main.ts"]
