# Phased launch: the non-AI offering first

Phase 1 opens Crestmont's **non-AI offering** on production: the public website, customer portal, staff and Owner
dashboards, CRM, projects, contracts, approved maintenance plans, support and payments, with every website delivered
by the Crestmont team ([FULFILLMENT-HUMAN-SUPERVISED.md](FULFILLMENT-HUMAN-SUPERVISED.md)).

The separately-developed AI systems — the **AI Website Builder**, the **AI Receptionist** and **AI Sales
Optimization** — are not part of phase 1. They keep being developed and certified on staging in their own sessions;
nothing here changes their implementation.

Phase 1 does **not** relax any release control. The release workflow, Founder approval, MFA, evidence binding,
security findings and every platform requirement apply exactly as before. Phase 1 changes two things only.

## 1. A production feature gate for AI website generation

`src/domain/ai-build-gate.ts`. Production is closed for any `AI_BUILD_AUTOMATION` value except exactly `"on"`;
`wrangler.toml [env.production]` states `"off"`. Because it is a committed `[vars]` value, changing it changes the
release configuration digest, which voids any Founder approval and needs a new release candidate.

While closed: payment + intake create no build; the sweep queues nothing; the runner claim endpoint hands out
nothing; automatic customer revisions do not happen; the Owner's database switch cannot reopen it; Owner actions that
would queue AI work are refused with the reason. Staging and development stay open (the builder's certification runs
there) unless set to `"off"`. Tests: `tests/ai-build-gate.test.ts`.

## 2. A Founder scope policy for the release gates

The AI systems' requirements count toward release gates A–F today, so phase 1 could never pass however complete the
non-AI platform is. The readiness schema has always had the honest mechanism for this — a Founder scope disposition
(`requirements.disposition = 'deferred_by_founder'`, bound to a `scope_disposition` record) — but nothing could
record one. `src/readiness/phased-release.ts` and `src/services/phased-release.ts` now can, under a fixed policy:

- **Only `external_ai` requirements** (the acceptance registry's tracking for the AI systems) can be deferred. Every
  platform requirement — authentication, security, payments, legal, identity, launch — stays in scope.
- **Each AI system needs a production gate** that keeps it off (the table on the page and in `PRODUCTION_GATES`).
- **Security requirements** of an AI system need a written reason why nothing reachable on production depends on
  them. **AIB-019** (production refuses the test-only payment simulation) is **never deferrable**: it guards the live
  payment path.
- **Founder only**: the Founder's own Owner account (`FOUNDER_EMAIL`), MFA step-up, a typed confirmation and a reason.
  A request with one ineligible id defers nothing.
- **Evidence-bound**: deferral changes the evidence set, so outstanding launch approvals stop being valid and are
  explicitly voided. Deferred requirements keep their real state and are listed separately; **Reinstate** puts one
  back into every gate.
- **Enforced at deploy**: `/api/readiness/release-authorization` reports the deferrals; `deploy-production.yml`
  refuses if the commit's `wrangler.toml` would switch a deferred system on (`scripts/release-authorization.ts`) or the
  production Worker holds a secret that would (`scripts/phase-check.ts`: `BUILD_RUNNER_SECRET`, `AI_BUILD_AUTOMATION`,
  Retell keys, …).

Tests: `tests/phased-release.test.ts`; route classification and audit: the security matrix.

## Founder steps (staging readiness, after the staging Owner account is trusted again)

1. **Launch readiness → Phased release** (`/staff/readiness/phased-release`). Review the production gates table.
2. Tick the AI-system requirements to defer for phase 1 (ineligible ones show *Stays in scope* and why), give the
   reason, type `defer for phase 1`, and confirm with your second factor.
3. Then, as before: release tag → release candidate → `/staff/readiness/approve` once gates A–F pass → Actions →
   **Deploy production**.

Deferring changes scope, not readiness: gates A–F must still pass on their own evidence.

## Reopening AI website generation

Only after the builder's separate certification and Founder authorization: reinstate its requirements (they must then
pass the gates), set `AI_BUILD_AUTOMATION = "on"` in `[env.production]` through a reviewed pull request, create a new
release candidate, and approve it. Live payments (`PAYMENTS_LIVE_AUTHORIZED`), Retell keys and any paid AI provider
remain separate Founder authorizations.
