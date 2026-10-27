# Crestmont Platform

Business platform for Crestmont Website Development: public site, CRM, sales, payments, projects, support, owner command center and the Launch Readiness Command Center.

**Status: early foundation — not production-ready.** See `docs/BUILD_LEDGER.md` and run the readiness snapshot for computed status.

## Requirements
Node ≥ 22.18 (native TypeScript + `node:sqlite`). No runtime dependencies.

## Commands
```bash
npm test                                   # runs all tests; writes evidence/ci-evidence.json
npx tsc -p tsconfig.json                   # typecheck (needs typescript + @types/node)
node --no-warnings scripts/readiness-snapshot.ts > evidence/readiness-snapshot.json   # computed readiness + evidence/readiness.csv
npm run evidence:post                      # sign & post evidence (READINESS_URL, EVIDENCE_INGEST_SECRET)
```

## Layout
- `requirements/inventory.ts` — the approved requirement inventory (readiness denominator)
- `requirements/status.ts` — explicit implementation records (tests never promote these)
- `migrations/` — D1 schema · `seeds/blockers.sql` — blocker register from discovery
- `src/domain/` — pure business rules · `src/services/` — I/O · `src/readiness/` — readiness engine, ingestion, reports
- `src/worker.ts` — Cloudflare Worker API
- `tests/` — tests tagged `[REQ-ID]` · `scripts/evidence-reporter.mjs` — maps results to evidence
- `docs/adr/` — architecture decisions
