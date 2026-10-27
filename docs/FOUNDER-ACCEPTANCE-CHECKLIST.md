# Founder acceptance checklist

**Requirement:** DOC-003 (§75, §76.25, §77, §79). Use this before recording a production launch decision at `/staff/readiness/approve`.

**This checklist holds no status.** Each line names where the live, evidence-backed answer is. Status is computed from stored records at `/staff/readiness`, and the same figures appear in the final status report: `/staff/readiness/founder-report` (Markdown download: `/staff/readiness/founder-report.md`, or `node --no-warnings scripts/founder-report.ts --db <db>`). If this document and the dashboard ever disagree, the dashboard is authoritative.

Tick a box only after you have looked at the linked evidence yourself.

## Part 1 — Launch gates A–H (§44)

| Gate | What you check | Where | Accept when |
|---|---|---|---|
| **A** Engineering completeness | Every in-scope requirement implemented or dispositioned by you | `/staff/readiness` gate A · `/staff/readiness/requirements?impl=in_progress` | Gate A shows **pass**. Every deferral has your scope approval. |
| **B** Automated tests | All CI suites for the release commit ran on GitHub Actions with zero failures | Gate B · `/staff/readiness/engineering` | Gate B **pass**, and its evidence says "GitHub Actions" (not "local runs only"). |
| **C** Security | No open release-blocking findings; security requirements verified in staging | Gate C · `/staff/readiness/security` · `docs/security/ASVS-REVIEW.md` | Gate C **pass**. Any accepted risk was accepted by you. An independent review/pen test is done (F-16). |
| **D** Integrations | Stripe (test → live plan), Resend, Turnstile, DNS, storage, voice verified in staging, or excluded by you | Gate D · `/staff/integrations` · `/staff/readiness/env/staging` | Gate D **pass**. |
| **E** Staging certification | Every P0 technical requirement passes in staging, including the browser E2E journeys | Gate E · `/staff/readiness/env/staging` | Gate E **pass**. Staging evidence is for the release-candidate commit. |
| **F** Business readiness | Legal entity, address, agreements (attorney-reviewed), tax, payment configuration, support hours, disclosures | Gate F · `/staff/settings` · `/staff/legal` | Gate F **pass**. |
| **G** Founder approval | Your decision, bound to the commit, config digest and evidence set | `/staff/readiness/approve` | You approve the exact commit you reviewed. The panel shows **Valid**. |
| **H** Production verification | Post-deploy checks for the deployed commit pass. Production matches the approved candidate | Gate H · `/staff/readiness/env/production` · `/staff/ops` | After deploying: Gate H **pass**, and `/staff/ops` shows "Matches approved release" with no mismatch alert. |

## Part 2 — Platform completion (§75)

Each line maps to inventory subsystems. The status report gives yes/no per subsystem (implemented, tested, staging verified, production verified, blocked, evidence, remaining action).

| §75 item | Subsystem(s) in the report | Notes |
|---|---|---|
| ☐ Public website is complete | Public Website, Brand, CMS | |
| ☐ Real portfolio evidence is verified | Portfolio | Genuine screenshots only (BLK-007/008) |
| ☐ Customer portal is complete | Customer Portal, Authentication | |
| ☐ Owner dashboard is complete | Owner Dashboard | |
| ☐ CRM is complete | CRM | |
| ☐ Sales system is complete | Sales, Catalog | |
| ☐ Project management is complete | Project Management | |
| ☐ Employee dashboards are complete | Employees | |
| ☐ Support system is complete | Support | |
| ☐ Financial system is complete | Finance, Payments | |
| ☐ AI operations are complete | AI Operations | |
| ☐ AI receptionist verified to the appropriate preproduction level | AI Receptionist | Provider decision BLK-009 |
| ☐ Email system is verified | Email | BLK-005 |
| ☐ Database and storage are operational | Data, Files, Infrastructure | |
| ☐ Security checks pass | Security | Gate C |
| ☐ Backups and recovery are tested | Testing (TEST-004), Infrastructure (INFRA-006) | A **staging** restore drill recorded at `/staff/backups`. Development drills alone are not enough |
| ☐ CI/CD is operational | Infrastructure (INFRA-004, INFRA-005) | Green GitHub Actions runs. `deploy-staging` deployed at least once |
| ☐ Staging passes required E2E tests | Testing (TEST-002) | Gate E |
| ☐ Launch readiness accurately reflects engineering evidence | Launch Readiness, Continuity | Feed panel healthy. `/api/readiness/health` returns 200 |
| ☐ Required external accounts are configured | Identity, Infrastructure | Open `external_account` blockers = 0 |
| ☐ Required legal and business approvals are complete | Legal, Identity | Gate F. Attorney review recorded (LEGAL-004) |
| ☐ Founder approval is obtained | Launch (LAUNCH-001) | Gate G |

## Part 3 — Production safety (§79), immediately before you approve

- ☐ Legal identity and required disclosures verified (`/legal`, `/staff/settings`).
- ☐ Stripe **live** configuration reviewed. Live keys are refused by the platform until you authorise PAY-010. That authorisation is a separate, explicit decision.
- ☐ Domain and email configuration verified (`/staff/integrations`: DNS, Resend; `/staff/ops`: production URL probe).
- ☐ Support contact channels work (support@, published staffed hours, no 24/7 claim).
- ☐ Required agreements are the attorney-approved versions (`/staff/legal`).
- ☐ Staging certification is for the **same commit** you are approving (Gate E evidence commit = release candidate commit).
- ☐ Security findings reviewed (`/staff/readiness/security`).
- ☐ Backup and rollback procedures verified: a staging restore drill passed (`/staff/backups`), a staging rollback was exercised (`/staff/ops` shows a `rolled_back` staging deployment linked to its target), and the rollback plan in the release candidate is correct.
- ☐ Data retention schedule approved (docs/RETENTION-SCHEDULE.md) and periods set at `/staff/ops/retention`, or explicitly deferred.
- ☐ Post-launch monitoring owner and routine agreed (docs/POSTLAUNCH-MONITORING.md).

## Part 4 — Deploy and verify

1. Approve at `/staff/readiness/approve` (type the full commit).
2. GitHub → Actions → **Deploy production** → Run workflow with that commit. Approve the `production` environment when GitHub asks. The workflow refuses unless your approval is still valid.
3. After it finishes: Gate H **pass**, `/staff/ops` shows the deployment "Matches approved release", `/staff/readiness/env/production` shows DNS/TLS/health from the probe.
4. Download the release evidence packet (`/staff/readiness/packet.json`) and the final status report (`/staff/readiness/founder-report.md`) and keep them with the release record.

Do not describe Crestmont as "production-ready" while any release-blocking item above is open (§75).
