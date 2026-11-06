# Real captured output, not hand-written fixtures

Every file here was produced by an actual run of `runner/ci/frontend-import-poc.ts` against real Docker: a real
`npm install` through the registry proxy, a real Vite build with no network, and real Chromium measuring three
viewports. They are checked in so the modules that CONSUME this data can be tested without Docker, and so a
change in the shape of the measurement is caught by a test rather than by a build.

| file | what it is |
|---|---|
| `import-baseline.json` | the approved frontend as imported, before any backend work |
| `design-baseline.json` | the frozen design, derived from the above |
| `integration-manifest.json` | the plan, written against those exact fingerprints |
| `import-after-integration.json` | the same site re-measured after the quote form was connected |
| `import-after-drift.json` | the same site after one CSS custom property was changed (`--amber`) |

To regenerate:

    RUNNER_SANDBOX_IMAGE=crestmont-build-sandbox:1-frontend-import \
      node --no-warnings runner/ci/frontend-import-poc.ts --stage baseline
    ... --stage verify
    ... --stage drift
