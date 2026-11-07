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

## Why the recorded design fingerprint changed (2026-11-06)

`design-baseline.json` and `integration-manifest.json` now record
`60c8a0703724305cd065973a60649af9c2f827e358757c79d2a69b126e29bc31`, where they previously recorded
`239cc2854af8f6ee33c75b30a671b378aa34afec8bc46c1d2451ab21a9ef81f6`.

Nothing captured was edited. `import-baseline.json`, `import-after-integration.json` and `import-after-drift.json`
are the measurements and are untouched. The baseline is a pure function of the first of them (`baselineFrom`), and
that function changed: DL-010 fixed how a nested landmark's spacing is measured, so the fingerprint it derives
changed with it. The file was re-derived from the same captured measurement rather than hand-edited, and the
manifest's `designFingerprint` moved with the design it was written against.

The bug being fixed: `gap` was measured from the previous landmark's bottom, which is right between siblings but
wrong when landmarks nest. `section` sits inside `main`, so a child's gap was minus its parent's height, and any
content-driven height change moved it — absolute height back inside a comparison that excludes it on purpose.
