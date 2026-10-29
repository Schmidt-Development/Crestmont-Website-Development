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

## Batches

| # | PR | Branch | Findings | State |
| --- | --- | --- | --- | --- |
| 1 | #26 | claude/closeout-001-invitation-takeover | 001, 004 | Green; awaiting Founder merge (urgent: staging is public) |
| 2 | (this PR) | claude/closeout-register | register, validation test, this file | Green when opened |

## Next executable tasks

1. Branch consolidation (CREST-GAP-018): rebase PR #18 (security-legal), #19 (staging MFA encryption),
   `claude/d1-closeout`, `claude/staging-health-closeout` onto main; cherry-pick `src/` + tests; unique migration numbers.
2. Lockout throttling (003) and Turnstile guards (019).
3. Commerce stream (005–008, 031–039 …), then ops, modules/frontend, Retell.
