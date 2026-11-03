# Automatic Launch Readiness (READY-013)

Launch Readiness derives every requirement's status from evidence. Nobody types a status, and no routine
engineering completion needs a file edit.

## Why this replaced the old model

Implementation status used to be asserted by hand in `requirements/status/*.ts`. Nothing recomputed it when work
actually landed. The 2026-11-02 audit found eleven merged-ready pull requests (#108–#118) that would have moved
the implemented count by **exactly zero**, because not one of them edited that directory. PR #119 fixed *when*
those declarations reached the database; it could not fix the fact that they were declarations.

## The three rules

1. **A passing test never implies a deployment.** `DEPLOYED_STAGING` needs a succeeded deployment row carrying
   the same commit the tests passed at.
2. **A deployment never implies certification.** `STAGING_VERIFIED` needs evidence from that environment, at
   the deployed commit.
3. **Evidence certifies the commit it ran at, and nothing else.** When the integration head moves past the
   commit a requirement was last proven at, it becomes `EVIDENCE_STALE` rather than keeping a verdict earned by
   code that has since changed.

## The states

| State | Meaning |
|---|---|
| `NOT_IMPLEMENTED` | Nothing proves it: no passing evidence, ever. |
| `IMPLEMENTED` | Tagged tests pass in CI at the current head, off the default branch. |
| `MERGED` | …and that CI run was on the default branch. |
| `DEPLOYED_STAGING` | A succeeded staging deployment carries that commit. |
| `STAGING_VERIFIED` | Staging evidence at that commit passed. |
| `DEPLOYED_PRODUCTION` / `PRODUCTION_VERIFIED` | The same two steps in production. |
| `BLOCKED` | An external gate is open. The ladder position is kept in `progress`, so the work done stays visible. |
| `REGRESSED` | It passed before and fails now. Outranks `BLOCKED`, so a regression is never hidden. |
| `EVIDENCE_STALE` | Proven at an older commit; the head has moved and nothing re-proved it. |

## How a requirement is registered

1. Add it to `requirements/inventory.ts`.
2. Give it an entry in `requirements/acceptance.ts`, or let it take the category default.
3. Tag at least one test `[THE-ID]`, **or** declare the external fact that establishes it.

`tests/acceptance-registry.test.ts` refuses an inventory id with no acceptance, an acceptance entry for an
unknown id, a gate naming a blocker or finding that does not exist, and a platform requirement that is neither
tested nor externally gated. The requirement then appears on the dashboard at the next evidence ingest —
`syncRequirementsIfStale` notices the deployed registry differs from the database and applies it.

## Acceptance

Each requirement declares `completeAt` — the state at which it counts as done — plus any evidence sources it
demands and any external gate.

- **Code requirements** default to `IMPLEMENTED`: their tagged tests passing is the proof.
- **Integration requirements** default to `STAGING_VERIFIED`: CI exercises a fake, so a live run is what counts.
- **External facts** (a legal entity, a vendor account, a Founder decision, a captured screenshot, an
  independent review) name a blocker or a release-blocking security finding. While it is open the requirement is
  `BLOCKED`; once it clears, the fact itself is the evidence. This is how a requirement no test can prove still
  completes automatically — the Founder resolves the blocker, and readiness follows.

The **five AI systems** are `tracking: "external_ai"`: reported beside the platform, never inside its
percentages.

## When it recalculates

`syncDerivedStates` runs on evidence ingest, on deployment recording and on any blocker change. It is
idempotent (a run with no new facts writes nothing and reports 0 changed), retryable (failures are recorded in
`readiness_sync` instead of leaving the dashboard silently stale) and auditable (`requirement_state_history`
keeps every transition with the commit and the reason). The derivation itself is a pure function recomputed on
every read, so the stored rows can never drift into a second, competing answer.

## What the Owner sees

`/staff/readiness` carries an **Automatic status** panel: when readiness was last recalculated and what
triggered it, the commit it was judged against, the latest deployment, the platform count, a breakdown by
derived state, anything that has lost a verdict, and the recent transitions. Each requirement's page explains
**why this status** — its acceptance criteria, what the evidence says, the commit it was proven at, its external
gate, and its full status history.
