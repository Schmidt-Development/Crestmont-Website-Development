# Human-supervised website fulfillment (phase 1)

While AI website generation is off on production (`AI_BUILD_AUTOMATION = "off"`, see
[PHASED-LAUNCH.md](PHASED-LAUNCH.md)), every paid website project is delivered by the Crestmont team using the
project-management workflow that already exists. Nothing about pricing, packages, payment rules or entitlements
changes: Starter $999, Business $2,499, Premium $4,999+, custom work quoted with 50/25/25 milestones, and the
approved maintenance plans, all enforced server-side as before (`src/domain/catalog.ts`).

## What the platform guarantees while the gate is closed

- A verified payment plus a submitted intake **creates no AI build**. The project is provisioned, moves to
  *Scope review* and waits for a person (`tests/ai-build-gate.test.ts`).
- The recovery sweep, automatic customer revisions and the build runner hand out nothing; the runner claim endpoint
  answers `disabled_in_environment`.
- Owner actions that would queue AI work by hand (resume automation, enable automation, backfill, retry, resume,
  revision, forwarding a customer revision) are refused with the reason. Pausing stays possible.
- Staff see the mode on **Projects** ("Delivered by the Crestmont team") and on **AI builds**.
- No customer-facing page, email or agreement promises automated or AI-generated delivery. The public site describes
  "AI-assisted draft copy for you to review and approve" only (an existing package entitlement, produced and reviewed
  by people), and the AI Receptionist is "Coming soon" (FD-45).

## The workflow (Staff → Projects)

| Status | Who | What happens | Exit |
|---|---|---|---|
| Purchased → Awaiting onboarding | System | Created by the verified Stripe payment (never by a redirect). The customer gets the onboarding link. | Customer submits intake |
| Scope review | Project manager | Assign a PM. Check the intake against the package (page limit, features, revision rounds). Anything beyond the package becomes a change order — never silent scope growth. Set the target launch date. | Scope confirmed |
| Design | Designer | Design in the approved brand direction; share for customer review when the package calls for a design checkpoint. | Design approved or ready to build |
| Development | Developer | Build the site in its own repository. Use the AI-assisted draft copy entitlement only as a draft a person edits and the customer approves. | Ready for QA |
| Internal QA | A second person | Accessibility, performance, forms, links, mobile, content accuracy, security headers. Failing QA returns to Development. | QA passed |
| Customer review → Revisions | Customer / PM | Customer reviews in the portal. Each revision round is counted against the allowance; extra rounds need an approved, paid change order. | Customer approves |
| Final approval → Deployment | Owner | Deployment is refused until the customer release checks pass (`releaseReadiness` in `src/services/projects.ts`: engineering complete, internal QA, security/accessibility, customer launch approval, deployment authorized, and every required milestone paid unless the Owner documents an exception). | Live |
| Completed → Maintenance | PM | Hand-off documents; the customer's approved maintenance plan continues under the maintenance terms in force. | — |

The inactivity policy (reminders at 7 and 14 days, escalation at 21, pause at 30) and the support SLAs apply
unchanged.

## Never

- Never mark a project or a requirement complete because an AI produced something. People review every AI-assisted draft.
- Never promise a delivery date shorter than the scope review set, or describe the work as automated.
- Never re-enable AI generation on production from the database or a Worker secret. It reopens only through
  [PHASED-LAUNCH.md](PHASED-LAUNCH.md) § Reopening AI website generation.
