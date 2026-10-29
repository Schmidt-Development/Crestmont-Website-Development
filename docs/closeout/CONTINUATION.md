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
| 2 | #27 | claude/closeout-register | register, validator, this file | docs/tests only; updated at the end of the run |
| 3 | #28 | claude/closeout-018-branch-consolidation | 018, 002, 021–027 (partly), 030, 052 (contract), 069, 092 | PRs #18/#19/d1-closeout/staging-health-closeout landed without the preview gate; migrations 0040, 0041 |
| 4 | #29 | claude/closeout-003-login-throttling | 003, 085 | stacked on #28; migration 0046 |
| 5 | #31 | claude/closeout-086-session-cookies | 086, 102 | stacked on #29 |
| — | #30 | claude/closeout-hardening | 012, 017, 056, 087, 101 | independent of the stack |
| — | #32 | claude/closeout-retell | 053, 100 (supersedes #17) | migration 0042; CI green; Retell dashboard steps in docs/voice/RETELL-CONNECTION-GUIDE.md |
| — | (agents) | claude/closeout-commerce / -modules / -ops / -frontend | see each PR | migrations: commerce 0043, modules 0044, ops 0045 |

Reserved migration numbers: 0040 (#28 security readiness), 0041 (#28 deleted-task links), 0042 Retell, 0043 commerce,
0044 modules, 0045 ops, 0046 known devices (#29). After everything merges, run `tests/migrations` uniqueness test (ops PR).

The container restarted once mid-run (OOM with six concurrent test suites). Keep at most three engineering agents at a
time and have them run focused tests; the full suite at most twice per branch.

## Next executable tasks

1. Branch consolidation (CREST-GAP-018): rebase PR #18 (security-legal), #19 (staging MFA encryption),
   `claude/d1-closeout`, `claude/staging-health-closeout` onto main; cherry-pick `src/` + tests; unique migration numbers.
2. Lockout throttling (003) and Turnstile guards (019).
3. Commerce stream (005–008, 031–039 …), then ops, modules/frontend, Retell.
