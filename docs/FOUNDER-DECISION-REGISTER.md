# Founder decision register

**One list of everything that waits on the Founder.** Prepared 2026-10-28 by the security, legal and production-readiness session. Recommendations are **defaults to consider, not approvals**: nothing below is decided until the Founder records the decision (and, where marked, counsel/accountant/agent confirms it). Where a decision lands in the platform, the "Where it lands" column says how.

Related: launch gates `docs/FOUNDER-ACCEPTANCE-CHECKLIST.md` · findings `docs/security/SECURITY-READINESS-2026-10-28.md` · legal drafts `docs/legal/README.md` (§5 lists clause-level legal decisions) · research `docs/legal/RESEARCH-NOTES-2026-10.md`.

## A. Do these first (security, not decisions)

These are actions, not choices. They close active exposures.

| # | Action | Why | How |
|---|---|---|---|
| A1 | Review and merge **PR #8** (`claude/production-readiness`). It already contains PR #12's only commit, so #12 merges with it; #13 is a superset and can follow. Ask the PR owner to apply `pr8-pr13-F23-F24-workflow-hardening.patch` first (F-23/F-24) | Stops staging Owner credentials (F-18) and the production database export (F-19) being published as artifacts of this public repository | GitHub PR review |
| A2 | Delete existing `staging-preview-access` (and any `pre-deploy-production-export`) artifacts | Old artifacts stay downloadable until they expire | Actions → each *Deploy staging* run → Artifacts → delete |
| A3 | Rotate staging credentials after A1 | Treat the old staging Owner password and 2FA key as compromised | *Deploy staging* → run workflow with `rotate_credentials=true` |
| A4 | GitHub settings (free on public repos) | Enforce what the files cannot | `docs/security/SECURITY-READINESS-2026-10-28.md` §10 (environment reviewers + `main`-only, rulesets, secret scanning + push protection, Dependabot alerts, fork-PR approval). Code scanning default setup is already on; delete the redundant `codeql.yml`, which fails every run while default setup is enabled |

## B. Decisions

| ID | Decision | Options | Recommendation (not approved) | Consequence | Deadline / dependency | Where it lands |
|---|---|---|---|---|---|---|
| D-01 | **Business legal identity** | Michigan LLC; sole proprietorship (+ county assumed-name certificate); other entity | Form a Michigan LLC named "Crestmont Website Development LLC" (research: ~$50 filing, $25/yr annual statement, EIN free — verify fees on LARA); confirm with attorney and CPA (tax classification) | Every contract, invoice, Stripe account and policy needs the legal name and address; blocks BLK-006, Gate F | Before any contract or payment | `business_settings` legal name/address → rendered in legal pages |
| D-02 | **Customer email verification gate** | (a) no gate (today); (b) verify before first payment, quote acceptance or launch approval; (c) verify before any portal access | **(b)** — low friction for enquiries, but contracts and payments bound to a confirmed address | (a) agreements may be accepted by mistyped/unowned emails; (c) more drop-off | Before onboarding customers | Small code change (engineering ready; not implemented to avoid deciding for you) |
| D-03 | **Data retention periods** | Proposed schedule in `docs/RETENTION-SCHEDULE.md` (security events 365 d, email bodies 730 d, app errors 90 d, transcripts 90 d, deleted files 30 d); alternatives longer/shorter | Approve the proposed schedule after counsel answers RETENTION-SCHEDULE questions 1–4; financial records ~7 y per accountant | Until set, personal data accumulates indefinitely (privacy policy says "limited period") | Before activation | Owner sets `/staff/ops/retention` (now step-up protected); legal holds pause it |
| D-04 | **Recovery objectives (RTO/RPO)** | Proposed in `docs/BACKUP-RECOVERY.md` §2: D1 RPO ≤ 24 h (minutes with Time Travel) / RTO ≤ 4 h; R2 RPO ≤ 24 h / RTO ≤ 8 h; deploy RTO ≤ 30 min. Stricter options need paid tooling and on-call | Approve as **internal targets only**, not customer promises, until a staging restore drill measures real numbers (D1 restore session) | Customer-facing SLA (MSA Schedule D) must not promise more than measured | Before launch; after restore drill | BACKUP-RECOVERY §2; MSA Sched. D.8 |
| D-05 | **Malware scanning** | Self-hosted ClamAV on the existing runner ($0); ClamAV in Cloudflare Containers; Cloudmersive (free tier); scanii ($49/mo); no scanning (uploads labelled "not yet scanned") | **ClamAV on the runner, pull mode**; make scanning mandatory for downloads (a proposed `files.require_scan` setting, added with the adapter) only after a week clean on staging. Do not use VirusTotal's public API | Without it F-02 (release-blocking) stays open; customer files reach staff machines unscanned | Before customer uploads in production | `docs/security/MALWARE-SCANNING.md` (contract implemented; provider adapter after decision) |
| D-06 | **Insurance** | Tech E&O / professional liability; cyber (first + third party); general liability or BOP; workers' comp once employees | Get quotes for **tech E&O + cyber** from a licensed Michigan agent before the first contract; set the MSA liability cap with the agent | Uninsured contract and breach liability; some clients require certificates | Before operations | MSA §15 cap placeholder `[LIABILITY CAP]` |
| D-07 | **Customer contract terms** | See `docs/legal/README.md` §5 (liability cap, dispute route, warranty period, late fees, portfolio consent, IP transfer timing) | Liability cap = fees paid in prior 12 months; mediation then courts in Founder's county; 30-day warranty; opt-in portfolio consent — **all subject to counsel** | Drafts cannot be used until decided and reviewed | Attorney review (LEGAL-004) | New agreement version migration after approval |
| D-08 | **Refund policy** | Percentages/windows per milestone; maintenance proration; who may deny at first review | Keep the Owner-decides chain; let support only *route* (not deny) refund requests, or disclose that support may close clearly ineligible ones; no proration on monthly plans with cancel-anytime | Published policy currently says the Founder decides, but the code lets support deny at review (contradiction found by the legal review) | Before payments | `src/domain/refunds.ts` behaviour or policy text — one must change |
| D-09 | **Alert destination (F-03)** | Cloudflare Notifications email; free uptime service; Workers Logs/Logpush alerts | Cloudflare Notifications to the Founder's email (no new vendor, no cost) | Without it nobody is told when production fails; F-03 blocks release | Before launch | `docs/POSTLAUNCH-MONITORING.md` §4 |
| D-10 | **Maintenance commitments** | Approve/amend proposed entitlements per plan (BLK-010) | Approve only what exists: do not promise automated backups until they run on schedule; state response targets, not resolution times | Overpromising is a breach-of-contract risk | Before selling plans | `src/domain/catalog.ts` entitlements; MSA Sched. B.2 |
| D-11 | **Support hours** | Business hours (e.g. Mon–Fri 9–5 ET); extended; best-effort | Publish business hours with response targets only; SEV-1 security incidents handled any time by the Founder | Policy pages show "to be published" until set | Before sales | `business_settings` staffed hours |
| D-12 | **Security-incident notice window to customers (DPA)** | 48 h / 72 h / "without undue delay" | 72 h from confirmation, subject to counsel and state law | Contract commitment; drives incident runbook | Attorney review | DPA §8.1; `docs/INCIDENT-RESPONSE.md` §4.2 |
| D-13 | **Independent security review (F-16)** | Paid pen test of staging; freelance review; defer | One scoped pen test of staging before first paying customer | F-16 is release-blocking | Before launch | `security_findings` F-16 |
| D-14 | **AI receptionist scope** | Inbound only (as built); add outbound callbacks/SMS later | Inbound only at launch; outbound requires new consent design and counsel (TCPA) | Outbound without consent design creates TCPA exposure | Before enabling voice (BLK-009) | MSA Sched. C; Retell session |
| D-15 | **Repository visibility** | Public (today) with free code scanning; private (needs paid GitHub Code Security for scanning) | Stay public only if every workflow treats artifacts/summaries as public (after PR #8); otherwise go private and accept losing free scanning or pay | Public repo is the root cause of F-18/F-19 | Before production deploy | GitHub settings |
| D-16 | **Legal holds** | Owner places holds on counsel's advice | Use for chargebacks, disputes, incidents, legal requests | Without a hold the retention job may delete evidence once periods are on | When the first dispute arises | `scripts/legal-hold.ts` |
| D-17 | **Production activation (go / no-go)** | Go when Gates A–G pass | **No-go today** (§D) | — | Final launch | `/staff/readiness` Founder approval (Gate G) |

## C. External dependencies (who must act)

| Needs | What exactly | Blocks |
|---|---|---|
| **Cloudflare access** (Founder) | R2 enabled on the account (staging uploads off without it); production D1/R2/Worker via *Provision production*; custom domain + DNS; SSL Full (strict), min TLS 1.2 (F-14); WAF/Access policy (F-01); Notifications for alerts (D-09) | BLK-003, BLK-011, F-01, F-03, F-14 |
| **GitHub organization settings** (Founder) | items A1–A4; production environment reviewers and branch policy; review PRs #8/#12/#13 | F-18, F-19, F-23, F-24, F-10 (record a passing audit run) |
| **Payment provider** (Founder) | Crestmont Stripe account, test keys to staging, webhook secret; live keys only at launch | BLK-004, Gate D |
| **Email provider** (Founder) | Resend account, domain DNS (SPF/DKIM/DMARC), mailboxes for support@/sales@/billing@/legal@ | BLK-005 |
| **Voice provider** (Founder) | Provider approval (BLK-009), Retell account, number purchase, recording/retention settings, DPA | BLK-009 |
| **Legal counsel** | Review `docs/legal/*` (questions in README §5 and RESEARCH-NOTES §5); governing law; breach notice; call-recording consent; auto-renewal; AI IP language; DMCA agent | LEGAL-004, Gate F |
| **Accountant (CPA)** | Entity tax classification; Michigan sales/use tax on builds, hosting, plans and resold licenses (RAB 2023-10); Lansing city income tax; record retention period | LEGAL-005, PAY-010 |
| **Insurance agent** | Tech E&O + cyber quotes; GL/BOP; contract certificate requirements | D-06 |
| **Other Claude sessions** | PR #8 tag-injection/secret-scope patch (§9 of the security doc); AI builder: refuse `failed` scans; AI runner: commit sandbox/agent-sdk lockfiles; frontend: renumber `0037_portfolio_demos.sql`; D1 restore drill on staging; MFA production key | F-23, F-24, D-04 |
| **Founder authorization** | Every production deployment, migration, secret change, DNS change, live payment or live calling | Gate G |

## D. Business setup checklist (Founder; nothing here has been filed or bought)

| Item | Status | Next step | Ask |
|---|---|---|---|
| Legal entity | Not confirmed (BLK-006) | Decide D-01; check name availability in LARA's MiBusiness Registry | Attorney |
| Registered business name / DBA | Not confirmed | If the LLC's exact name is used, no DBA (confirm) | Attorney / LARA |
| EIN | Not confirmed | IRS online application after formation (free — avoid paid look-alike sites) | — |
| State registrations | Unknown | LLC annual statement each Feb 15; sales-tax license only if taxable sales | CPA |
| Business address / registered agent | Not established | Registered agent with a Michigan street address (Founder or service) | Attorney |
| Business banking | Unknown | Separate account in the entity's name (needed for Stripe payouts) | — |
| Accounting setup | Unknown | Bookkeeping + record retention policy (~7 years for financial records) | CPA |
| Sales tax applicability | Unresolved | CPA review of RAB 2023-10 against Crestmont's actual offerings | CPA |
| Payroll / contractors | Unknown | Contractor agreements with confidentiality + IP assignment before any helper touches customer data | Attorney / CPA |
| Insurance | None known | D-06 | Agent |
| Business licensing (local) | UNVERIFIED (Lansing/Ingham) | Check city/county home-occupation and license rules | City clerk |
| Domain ownership | Unverified (BLK-011) | Confirm registrar account is in the business's name; enable registrar lock + 2FA | — |
| Business email addresses | Not set (BLK-005) | support@, sales@, billing@, legal@, security@ | — |
| Customer support contact | Not set | D-11 | — |
| Privacy and legal contact | Not set | legal@ mailbox; named privacy contact in the privacy policy | Attorney |

## E. Production readiness (evidence-based)

| Stage | Assessment | Evidence |
|---|---|---|
| Ready for integration testing | **Yes, for backend code** — tests pass on this branch; frontend redesign and provider integrations are separate branches | `npm test`, typecheck |
| Ready for staging verification | **Partly** — staging exists, but uploads are off (no R2) and 0/15 security requirements are staging-verified; staging Owner credentials must be rotated first (F-18) | Gate C/E |
| Ready for production configuration | **No** — PR #8/#12/#13 unmerged; production secrets/domain not provisioned; F-19/F-23 open | Gates A, C, D |
| Ready for production deployment | **No** | Gates A, C, D, E, F, G fail |
| Overall | **Blocked** on A1–A4, D-01, D-05, D-09, D-13, counsel review, and provider accounts | this register |

Code-level tests passing does not mean production readiness.
