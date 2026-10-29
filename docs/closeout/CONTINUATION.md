# Closeout continuation — resume here

Read this first in any new session working on the 104-finding closeout. The register
(`docs/closeout/crestmont-104-register.json`, rendered to `CRESTMONT-104-CLOSEOUT.md`) is the source of truth for
each finding's state; this file records batches, PRs and what to do next.

## Ground rules (from the Founder directive of 2026-10-29)

- Full commerce is the target; no quote-only substitute. Production payments stay gated behind live credentials,
  legal approval and a Founder flag.
- Non-blocking: anything needing a human or provider goes to the Founder/External action register; keep working.
- Never merge branches that restore the staging preview gate (`PREVIEW_GATE = "required"`) or roll
  `ACCESS_EPOCH` back from 3. PRs #8, #18, #19 predate public staging: cherry-pick their `src/` changes only.
- Do not recreate `crestmont-platform-frontend-preview`. Do not deploy production.
- **Merging requires a human.** The session's safety policy refuses merges without a review, so every PR is
  opened green and handed to the Founder to merge, in the order below. Merging to `main` triggers Deploy staging.

## Tooling notes

- Tests: `npm test` (unit/integration), `PLAYWRIGHT_MODULE=/opt/npm-tools/node_modules/playwright/index.mjs npm run e2e`.
- Typecheck in sandboxes without npm registry access: `ln -sfn /opt/npm-tools/node_modules/@types node_modules/@types`
  then `/opt/npm-tools/node_modules/.bin/tsc -p tsconfig.json`.
- Register: edit the JSON, then `node --no-warnings scripts/closeout-register.ts` (CI test fails if the markdown is stale).

## Batches (PRs are opened green; the Founder merges, in this order)

| Order | PR | Branch | Findings | Notes |
| --- | --- | --- | --- | --- |
| 1 | #26 | claude/closeout-001-invitation-takeover | 001, 004 | P0 — merge first (staging is public) |
| 2 | #27 | claude/closeout-register | register, validator, this file | docs/tests only |
| 3 | #28 | claude/closeout-018-branch-consolidation | 002, 018, 021–023, 025, 026, 030, 052 (contract), 069, 092 | PRs #18/#19/d1-closeout/staging-health-closeout without the preview gate; migrations 0040, 0041 |
| 4 | #29 | claude/closeout-003-login-throttling | 003, 085 | stacked on #28; migration 0046 |
| 5 | #31 | claude/closeout-086-session-cookies | 086, 102 | stacked on #29 |
| 6 | #30 | claude/closeout-hardening | 012, 017, 056 (scope), 087, 101 | independent |
| 7 | #35 | claude/closeout-commerce | 005–008, 010, 031–039, 080, 082, 083, 091, 093, 094 | contains 1–6 (merge commits); migration 0043 |
| 8 | #32 | claude/closeout-retell | 053, 100 (supersedes #17) | contains 1–7; migration 0042 |
| 9 | #33 | claude/closeout-modules | 040–044, 070–074, 079, 081 | contains 1–8; migration 0044 |
| 10 | #34 | claude/closeout-frontend | 043 (policy link), 045–049, 051, 061, 075–078, 090, 095–099, 103 | contains 1–9 |
| 11 | #36 | claude/closeout-ops | 014 (prep), 015, 016, 019, 020, 024, 027–029, 055, 058, 062–068, 089, 104, CREST-NEW-001 | contains 1–10; migration 0045. Whole stack at this head: 605/605 unit, runner 92/92, e2e 37/0, tsc clean |
| — | glassly#1, better-lansing-mechanics#24 | claude/demo-closeout-059(-060) | 059 (2 of 4 demos), 060 | base crestmont/portfolio-demo; merging deploys only the demo Worker |

Every later PR already contains the earlier ones, so each merges without conflicts when the order is kept. Merging out
of order re-opens conflicts in src/services/mailer.ts, src/app/scheduled.ts and .github/workflows/ci.yml.

Reserved migration numbers: 0040 (#28 security readiness), 0041 (#28 deleted-task links), 0042 Retell, 0043 commerce,
0044 modules, 0045 ops, 0046 known devices (#29). After everything merges, run `tests/migrations` uniqueness test (ops PR).

The container restarted once mid-run (OOM with six concurrent test suites). Keep at most three engineering agents at a
time and have them run focused tests; the full suite at most twice per branch.

## Next executable tasks

1. Branch consolidation (CREST-GAP-018): rebase PR #18 (security-legal), #19 (staging MFA encryption),
   `claude/d1-closeout`, `claude/staging-health-closeout` onto main; cherry-pick `src/` + tests; unique migration numbers.
2. Lockout throttling (003) and Turnstile guards (019).
3. Commerce stream (005–008, 031–039 …), then ops, modules/frontend, Retell.
