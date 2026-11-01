# AI Builds: the permanent 10/10 quality engine

Every AI build — all packages, first builds, revisions and repairs — runs a **Build → Inspect → Test → Score →
Repair** loop inside the runner. Only a website whose scorecard is a **verified 10/10 within its approved scope**
reaches internal approval. There is no manual override, and nobody can edit a score.

## Where each part lives

| Part | Location |
| --- | --- |
| Full-stack foundation every build starts from | `runner/starters/fullstack-v1/` (`STARTERS.md`) |
| Acceptance gates A–G, J (run in the job repository) | `runner/starters/fullstack-v1/scripts/gates.mjs` (protected) |
| Package capability matrix (one source of truth) | `scripts/packages.json` in the starter = `PACKAGE_CAPABILITIES` in `src/domain/quality.ts` (a test keeps them identical) |
| 20-criterion scorecard, defect classes, repair loop | `runner/src/quality.ts`, `runner/src/job.ts` |
| Gate H (browser check), gate I (independent reviewer with screenshots) | `runner/src/orchestrator/` |
| Platform verification of a reported scorecard | `src/domain/quality.ts` (`verifyScorecard`) |
| Persistence, approval gate, improvement proposals | `src/services/build-quality.ts`, `migrations/0063_quality_engine.sql` |
| Staff view | `/staff/builds/:id` → "Quality scorecard" |

## The scorecard

Twenty criteria: visual design, brand consistency, desktop, mobile, frontend, backend, database, workflows,
payments, integrations, authentication, security, accessibility, performance, SEO, error handling,
maintainability, requirements, customer experience, deployment.

- Each criterion is `pass`, `fail`, `pending_external`, `unsupported` or `not_applicable`. A `pass` must name
  evidence: a gate result, a test run, or a reviewer verdict that saw the desktop and mobile screenshots.
- **Applicability is the platform's decision**, recomputed from the package and the customer's brief. Only
  `workflows` (no booking in scope) and `payments` (no payments in scope) may be not applicable. Reporting a
  required criterion as not applicable fails verification.
- Score = 10 × passed ÷ applicable, **rounded down** to one decimal. It is 10 only when every applicable criterion
  passes. Non-applicable criteria are excluded from the denominator.
- A skipped test never counts as a pass (gate A parses the TAP output).

## Trusted evidence

The website's own code cannot produce its evidence:

- Protected starter files (gates, test harness, foundation tests, the first migration, the package matrix) are
  restored by the runner before every acceptance run.
- Stale `gates.json` files and screenshots are deleted before acceptance. `gates.json` is trusted only when the
  runner's own `quality-gates` check ran it.
- Provider verifications (for example `stripe.verify_test_key`, `resend.verify_sending_domain`) are read only from
  `.crestmont/quality/verifications.json`, which the runner writes from the integration broker's completed
  operations. Without one, gate E is `pending_external`, never `pass`.
- The platform re-verifies the structure, evidence, applicability and arithmetic of every scorecard it receives
  and stores both the scorecard and the verification result (`build_quality`).

## Outcomes

| Runner result | Platform result |
| --- | --- |
| Verified 10/10 | `ready_for_review` → awaiting internal approval |
| Only `pending_external` criteria outstanding (the customer's provider setup) | `needs_information`, with the missing setup listed |
| Below 10 after repair attempts, or a non-productive repair loop | stopped `quality_not_met` (no retry) |
| Reported ready without a verified 10/10 | refused: `failed`, stage `FAILED_NEEDS_INTERVENTION`, audit `builds.quality_refused` |

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

- Websites built before the full-stack foundation keep their original starter for revisions (brochure v1). The
  full-stack gates would break those repositories, so these revisions are **not scored**; the staff page says so.
  Moving such a website to fullstack v1 is a rebuild, which is the Owner's decision.
- Gate H is the runner's browser check of pages and forms. A full scripted booking-and-payment flow in a browser
  is run against staging, not in the job container.
- Performance numbers come from the local harness. Staging measurements are taken during Node 1 / staging
  validation.
- Real Stripe test mode and the staging E2E for Junk in the Trunk need Node 1 access and the customer's own test
  keys.
