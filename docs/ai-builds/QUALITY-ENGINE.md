# AI Builds: the design-first weighted quality engine

Every AI build — all packages, first builds, revisions and repairs — runs a **Build → Inspect → Test → Score →
Repair** loop inside the runner, in four explicit phases. Only a website whose scorecard is a **verified 100/100**
reaches internal approval. There is no manual override, and nobody can edit a score.

## Why the scoring changed

Build `bld_50e28bbd1cd033ad9ddfad02` revision 1-3 was certified **9.4/10** because 18 of 19 applicable criteria
passed. Measured afterwards on the stored snapshot:

- `.site-nav ul { flex-direction: column }` at `site.css:109` sits outside any media query and the
  `@media (min-width: 64rem)` block never resets it, so the **primary desktop navigation rendered as a vertical
  stack**;
- the website carried **zero images**, against a brief whose `images_source` was `licensed`.

Both are among the first things a paying customer sees. Neither could move the score by more than 1/19 ≈ 0.5,
because `visual_design` was one binary PASS covering the entire visual product. A customer buys two things: a
website that looks exceptional and a website that works. Those are now **80 of 100 points**.

## The three categories

| Category | Points | Where it comes from |
| --- | ---: | --- |
| **A — Visual design** | 40 | An independent vision-capable reviewer's numeric rubric over real browser screenshots at desktop, tablet and mobile. There is no deterministic substitute. |
| **B — Frontend and backend functionality** | 40 | The acceptance gates' evidence: real endpoints, real persistence, real journeys. |
| **C — Remaining website quality** | 20 | Security, accessibility, performance, SEO, reliability, deployment readiness. |

`TotalPoints = Design + Functionality + Other` (max 100); `OverallScore = TotalPoints / 10`.

**The overall score is informational.** It is NOT what decides rollback, phase advancement or loop termination —
see "Phase-aware progress" below.

### Category A, item by item (40)

| Item | Max |
| --- | ---: |
| Layout composition, spacing, hierarchy and alignment | 8 |
| Typography, visual branding and colour harmony | 6 |
| Imagery: selection, relevance and presentation | 6 |
| Component polish, interaction states and visual consistency | 7 |
| Responsive visual quality across desktop, tablet and mobile | 6 |
| Industry appropriateness, distinctiveness and premium presentation | 7 |

Scored in halves. An item below its maximum **must** name its deficiencies; a number with nothing behind it is
recorded as 0 for that item, with that as the reason.

### Hard visual failures (measured, not judged)

Each one **caps** the whole design category, so "39/40 with broken primary navigation" is arithmetically
impossible:

| Measured defect | Category capped at |
| --- | ---: |
| A page rendered unstyled, or failed to load | 0 |
| A required viewport has no screenshot evidence | 0 |
| No vision-capable reviewer inspected the rendered website | 0 |
| Primary navigation broken, or stacked where it should be horizontal | 12 |
| Components overlap, or content is clipped | 14 |
| The page scrolls horizontally at a required viewport | 18 |
| Placeholder content or media presented as final | 20 |
| The approved design requires imagery and the website has none | 24 |

These come from `runner/sandbox/browser-check.mjs`, which now renders **desktop (1366), tablet (768) and mobile
(390)** and writes its measurements to `.crestmont/quality/visual.json`. It also detects the stacked desktop
navigation that reached 9.4/10: the links are measured by **where they are**, not only by whether they are visible.

Whether the approved design requires imagery is read from the customer's own intake (`images_source`) and the
architect's design specification — never from the builder.

### No vision, no design certification

A text-only reviewer must never claim it inspected a visual product. `vision` is read from the model's configured
capability, never from its answer. Without a vision reviewer and real images the design category is `blocked` and
worth 0 — reported as "nobody looked", not as "it looks bad".

## The four phases

| Phase | Objective | Gate out |
| --- | --- | --- |
| **Design** | 40/40 visual design. Backend work is deliberately deferred; deterministic mocks show interactive states. | A verified 40/40, all three viewports evidenced, no hard failure, a stored revision identified |
| **Design locked** | The approved design is frozen. | The freeze is persisted AND platform-verified |
| **Functionality** | 40/40 functionality while the design stays at 40/40. The backend adapts to the approved frontend contracts. | Functionality 40/40 with the design still certified |
| **Final QA** | The remaining 20 points, then a re-check of both certified categories. | 100/100 |

The phase lives in `build_jobs.build_phase`, not in a variable: it has to survive a runner restart, a replaced
container, a GPU model change, a checkpoint restore and a resumed multi-segment build. **The platform owns it** —
a runner reads its phase from the claim and from each cycle's answer, and never chooses its own.

## The design freeze

A verified 40/40 writes a row in `build_design_freezes` naming the job and attempt, the stored snapshot
(`attempt-cycle`) whose files *are* the approved design, the commit, the full rubric with the reviewer's own
per-item notes, the viewports evidenced, the gallery references a vision model actually received, the reviewer by
name, and a sha256 fingerprint of the frontend source. `platform_verified` is 1 only once this platform has
re-verified the card — **that column, not the runner's claim, is what the functionality gate reads.**

If later work changes the frozen presentation, the freeze is marked invalidated with its reason and the design
repair becomes outstanding work. The functional work is **not** reverted: reverting would also revert the change
that caused the regression. Re-certification after a selective repair puts the same freeze back in force, and the
whole history stays readable.

## Phase-aware progress

`PrimaryProgress` is the **active phase's own category**, never the total:

| Phase | Progress signal |
| --- | --- |
| Design, Design locked | Design points |
| Functionality | Functionality points, subject to the design staying certified |
| Final QA | Remaining-quality points, subject to both others staying certified |

The case this exists for: a cycle that takes the design from 20/40 to 30/40 while deferred backend functionality
falls from 30/40 to 5/40 drops the total from 7.0 to 5.5. The old scalar ratchet reverted that, destroying ten
points of design to protect code the build was not meant to be writing yet. It is now **recorded as progress**,
the improved design is kept, and the backend regression becomes outstanding work for its own phase.

A newly completed rubric item counts as progress even before the number moves, because the two halves of a cycle
can cancel out.

What has **not** been removed: the regression bound (two losing cycles in the active category), the idle bound
(three cycles with neither a point nor a completed rubric item → escalate for a targeted diagnostic), the review
cycle limit, and the budget, runtime and lease limits. A **safety-critical** problem — security, data integrity,
budget, lease — halts the build in every phase whatever the scores did, including before a design would otherwise
have been frozen.

## Where each part lives

| Part | Location |
| --- | --- |
| Full-stack foundation every build starts from | `runner/starters/fullstack-v1/` (`STARTERS.md`) |
| Acceptance gates A–G, J (run in the job repository) | `runner/starters/fullstack-v1/scripts/gates.mjs` (protected) |
| Package capability matrix (one source of truth) | `scripts/packages.json` in the starter = `PACKAGE_CAPABILITIES` in `src/domain/quality.ts` (a test keeps them identical) |
| **Authoritative weighted rubric and phase machine** | `src/domain/quality-rubric.ts` |
| Runner's mirror of the rubric (the image ships only `runner/`) | `runner/src/quality-weighted.ts` — `runner/test/quality-weighted.test.ts` fails if the two diverge, or compute different numbers from the same evidence |
| 20-criterion evidence engine, defect classes | `runner/src/quality.ts` |
| Phase-aware ratchet and stall guard | `runner/src/orchestrator/ratchet.ts` |
| Visual measurements (three viewports, navigation geometry, imagery, overflow, clipping) | `runner/sandbox/browser-check.mjs` |
| Reviewer contract including the numeric visual rubric | `runner/src/orchestrator/contracts.ts`, `advisors.ts` |
| Phase-specific builder prompts | `runner/src/prompt.ts` (`buildPhaseBlock`) |
| Platform verification of a reported scorecard | `src/domain/quality-verify.ts` (`verifyScorecard2`); `src/domain/quality.ts` (`verifyScorecard`, legacy /1) |
| Phases, freeze, milestones, per-phase metrics | `src/services/build-phases.ts`, `migrations/0076_design_first_phases.sql` |
| Persistence, approval gate, improvement proposals | `src/services/build-quality.ts`, `migrations/0063_quality_engine.sql` |
| Staff view | `/staff/builds/:id` → "Quality scorecard"; `/staff/builds/:id/inspect` → "Quality categories" |

## The evidence criteria

The twenty criteria have not gone away: they are the **evidence engine** for categories B and C, and the rubric is
the weighting layer over them. Each is `pass`, `fail`, `pending_external`, `unsupported` or `not_applicable`, and
a `pass` must name evidence.

| Category B item | Max | Criteria |
| --- | ---: | --- |
| Frontend controls, navigation, forms, interactions | 10 | `frontend` |
| Backend APIs, validation, business logic | 10 | `backend` |
| Database persistence, permissions, authenticated features | 8 | `database`, `auth` |
| Tested end-to-end customer and admin journeys | 8 | `workflows`, `requirements`, `customer_experience` |
| External service integration correctness | 4 | `integrations`, `payments` |

| Category C item | Max | Criteria |
| --- | ---: | --- |
| Security and privacy | 6 | `security` |
| Accessibility | 4 | `accessibility` |
| Performance | 4 | `performance` |
| SEO | 2 | `seo` |
| Reliability and error handling | 2 | `error_handling` |
| Deployment readiness and maintainability | 2 | `deployment`, `maintainability` |

`visual_design`, `brand_consistency`, `desktop` and `mobile` are design evidence: they cap the visual category
rather than adding points of their own.

**Applicability is the platform's decision**, recomputed from the package and the customer's brief. Only
`workflows` (no booking in scope) and `payments` (no payments in scope) may be not applicable; reporting a
required criterion as not applicable fails verification. An item with no applicable criterion is dropped and its
maximum is shared out **within its own category**, so a Starter website can still reach 40/40 functionality inside
its own scope while never earning points for features it never had.

A skipped test never counts as a pass (gate A parses the TAP output).

## Trusted evidence

The website's own code cannot produce its evidence:

- Protected starter files (gates, test harness, foundation tests, the first migration, the package matrix) are
  restored by the runner before every acceptance run.
- The gate process never loads the website's own modules. Tests and the performance server run in separate process
  groups that are killed when they finish. The configuration is judged by a protected validator, and latency is
  measured over HTTP from outside the website's process.
- Every protected foundation suite must run completely (each declared test reports a result). Any failed test, and
  any skipped test without a disabled-feature reason, fails gate C whatever its tags.
- Stale `gates.json` files and screenshots are deleted before acceptance. `gates.json` is trusted only when the
  runner's own `quality-gates` check ran in this pass, its output contains exactly one `CRESTMONT-GATES-SHA256` line
  matching the file's bytes, and its exit status agrees with the file.
- The final scorecard uses the reviewer's assessment and visual rubric only if no repair happened after that
  review; otherwise the review-based criteria and the design category have no evidence for the final code.
- A viewport the card claims is checked against the **screenshot files the stored snapshot actually holds**. The
  platform is the only place that has both the card and the bytes, so "the reviewer saw tablet" stops being an
  assertion.
- Provider verifications (for example `stripe.verify_test_key`, `resend.verify_sending_domain`) are read only from
  `.crestmont/quality/verifications.json`, which the runner writes from the integration broker's completed
  operations. Without one, gate E is `pending_external`, never `pass`.
- The platform re-verifies the structure, evidence, applicability and arithmetic of every scorecard it receives,
  recomputing the category points from the reported evidence rather than reading them, and stores both the
  scorecard and the verification result (`build_quality`).

## Outcomes

| Runner result | Platform result |
| --- | --- |
| Verified 100/100 (40 + 40 + 20) | `ready_for_review` → awaiting internal approval |
| Only `pending_external` criteria outstanding (the customer's provider setup) | `needs_information`, with the missing setup listed |
| Below 100 after repair attempts, or a non-productive repair loop | stopped `quality_not_met` (no retry), with the short category named |
| Reported ready without a verified 100/100 | refused: `failed`, stage `FAILED_NEEDS_INTERVENTION`, audit `builds.quality_refused` |

## Historical scorecards

Two schemas live side by side, deliberately:

- **`crestmont.quality-scorecard/1`** — the flat twenty-criterion card. Eligible at a verified 10/10. Existing rows
  keep their numbers exactly as reported and are labelled legacy scoring in the UI. The Junk in the Trunk 9.4 is
  one of them: it stays visible as history and is **never** presented as having passed the weighted visual rubric.
  No category breakdown is backfilled for it, because none was ever measured.
- **`crestmont.quality-scorecard/2`** — the weighted card. Eligible only at a verified 100/100.

A card is routed by its own `schema` field, so a runner one version behind still reports a card the platform
verifies and stores — it simply cannot reach the new eligibility. A build that predates the phase machine reports
phase `design`, because it never passed a design gate; claiming any later phase for it would be a backfilled
fiction.

## Measured efficiency

`build_phase_metrics` accumulates, per job, attempt and phase: inference calls, input and output tokens, elapsed
time, review versus implementation time, revisions, reviews, rollbacks and ineffective repairs. These are
measurements. GPU savings are not claimed from anywhere else.

## Self-improvement without self-modification

Defects whose cause is reusable (starter, builder prompt, architecture, integration, test coverage, deployment,
security) become **builder improvement proposals** (`builder_improvements`). Each proposal records the root cause,
proposed fix, regression test, affected components, risk and evidence, and counts repeat occurrences. A proposal
changes nothing by itself: a person approves or rejects it, and an approved one still goes through code review and
the normal deployment gates. Customer-generated code never modifies the builder.

## Customer revisions vs Crestmont's defects

`revisions.category`:

- `builder_defect`: Crestmont's own defect against the approved scope. It **never uses a revision round**.
- `customer_revision`: a change the customer asked for. It uses an included round; beyond the allowance, it needs
  a change order.
- `scope_change`: outside the approved scope. It is never included and cannot start before an approved change
  order.

The customer chooses **"a change I would like"** or **"something does not work as agreed"** in the portal. A
problem report uses no round while staff triage it, and is not queued for the AI builder until it is classified.
Coordinators classify each request with a reason the customer can see (`POST /staff/revisions/:id/classify`,
audited as `revision.classified`). Work that has already started cannot become billable without a change order.
The original approved scope stays in `project_scopes`; classification never edits it.

## Not yet covered (stated honestly)

- **Subjective beauty cannot be proven by deterministic tests.** The engine combines objective measurements
  (navigation geometry, overflow, clipping, imagery counts, stylesheet application) with an independent visual
  assessment, and the Founder approval checkpoint stays in place while the automated evaluator's reliability is
  being established. A 40/40 is evidence that nothing measurable is wrong and that a vision reviewer judged it
  finished — not a proof of excellence.
- A process started by website test code that escapes its process group (a new session) could still run after the
  tests. It cannot change the result: the runner rejects a gates file whose bytes do not match the gate's single
  digest line. At worst it voids the evidence, and the build does not pass.
- Websites built before the full-stack foundation keep their original starter for revisions (brochure v1). The
  full-stack gates would break those repositories, so these revisions are **not scored**; the staff page says so.
  Moving such a website to fullstack v1 is a rebuild, which is the Owner's decision.
- Gate H is the runner's browser check of pages and forms. A full scripted booking-and-payment flow in a browser
  is run against staging, not in the job container.
- Performance numbers come from the local harness. Staging measurements are taken during Node 1 / staging
  validation.
- Real Stripe test mode and the staging E2E for Junk in the Trunk need Node 1 access and the customer's own test
  keys.
- The weighted engine has been exercised against synthetic fixtures and mocked orchestration only. Whether the
  builder actually produces a 40/40 design is a question the **next real build** answers, not this implementation.
