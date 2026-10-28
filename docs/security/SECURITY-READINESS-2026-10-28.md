# Security, legal and production readiness review — 2026-10-28

**Branch:** `claude/security-legal-production-readiness` · **Base:** `origin/main` @ `85819b8` (review), rebased onto `17c38f0` (PRs #14, #15) for integration · **Scope:** security, privacy, legal preparation, compliance engineering, supply chain, Cloudflare, recovery, monitoring, production readiness.

> **This is a self-review, not an audit or certification.** It was performed by an automated engineering session reading the code, running the test suite and reviewing workflow files. No penetration test, no scan of any live environment, and no independent review has been done (finding F-16 stays open). Nothing here makes Crestmont "secure", "compliant" or "production-ready".

Companion documents (no duplication — each topic lives in one place):

| Topic | Document |
|---|---|
| Founder decisions, external dependencies, business/insurance checklist | `docs/FOUNDER-DECISION-REGISTER.md` |
| Incident response runbook | `docs/INCIDENT-RESPONSE.md` |
| Malware scanning contract and provider choice | `docs/security/MALWARE-SCANNING.md` |
| Legal document suite (attorney-review drafts) | `docs/legal/README.md` |
| Compliance research with sources | `docs/legal/RESEARCH-NOTES-2026-10.md` |
| Original ASVS self-review (F-01…F-17) | `docs/security/ASVS-REVIEW.md` |
| Deployment, rollback, provisioning | `docs/DEPLOYMENT.md`, `docs/PRODUCTION-PROVISIONING.md`, `docs/RUNBOOK.md` |
| Backup and restore | `docs/BACKUP-RECOVERY.md` (D1 restore drill owned by its own session) |
| Retention | `docs/RETENTION-SCHEDULE.md` |
| Launch gates | `docs/FOUNDER-ACCEPTANCE-CHECKLIST.md` |

---

## 1. Baseline (verified 2026-10-28)

| Item | Evidence | State |
|---|---|---|
| Tests at base commit | `npm test` @ `85819b8`: **392 passed, 0 failed** | Matches the earlier report |
| Requirements | `scripts/readiness-snapshot.ts`: 165 total — 114 verified in development, 23 in progress, 5 test pending, 22 blocked, 1 Founder approval. Gate A reports **120/165 implemented** | Matches the earlier report |
| Launch gates | A fail, B pass (local runs only), C fail (5 blocking findings, 0/15 security reqs staging-verified), D fail (0/12 integrations), E fail, F fail (1/11), G fail (no approval), H not evaluable | Production not activated |
| Repository visibility | **Public** (anonymous clone succeeded; GitHub confirms public read) | Drives findings F-18, F-19 |
| Concurrent branches | see §8 | Ownership respected |

### Baseline matrix

| Requirement area | Existing implementation | Verified evidence | Remaining action | Owner | Class |
|---|---|---|---|---|---|
| Password storage & policy | PBKDF2-SHA256 100k (Workers max), versioned hash + rehash, local denylist, HIBP k-anonymity | `tests/auth.test.ts`, `tests/asvs-hardening.test.ts` | F-05 accepted risk (platform limit) | Engineering | Implemented and verified |
| Login abuse | per-IP and per-email limits, lockout after 8, security events | `tests/auth.test.ts` [AUTH-005], **new** `tests/security-readiness.test.ts` | — (F-20 fixed here) | Engineering | Implemented and verified |
| Sessions | hashed tokens, absolute + idle timeout, revoke one/all, revoked on reset/change | `tests/auth.test.ts` [AUTH-004] | Staging verification | Engineering | Implemented, awaiting staging |
| MFA / step-up | TOTP + recovery codes, replay protection, step-up list, encrypted secrets | `tests/auth-hardening.test.ts` | Production key activation | **MFA session** (PR #13) | External dependency |
| CSRF / headers / CSP | double-submit + Origin, strict CSP, HSTS, nosniff, DENY | `tests/auth.test.ts` [SEC-002] | — | Engineering | Implemented and verified |
| Authorization / tenancy | role permissions, org-scoped queries, owner-only set, MFA-gated staff | `tests/security-matrix.test.ts`, `tests/security-tenancy.test.ts`, route inventory | — (F-26/F-27/F-28 fixed here) | Engineering | Implemented and verified |
| Email verification gating | tokens issued; login not gated | `tests/auth.test.ts` | **Policy decision** | Founder | Founder decision required |
| File uploads | allow-list + magic bytes, 25 MB, private keys, audited downloads, share links | `tests/ux.test.ts`, `tests/portal.test.ts` | Scanner (F-02) | Founder (provider) / R2 session | Engineering complete; provider pending |
| Privacy export / deletion | self-service export, staff-processed anonymisation | `tests/data.test.ts` | — (F-26 + legal hold added here) | Engineering | Implemented and verified |
| Retention | two-tier job; configurable tier off by default | `tests/ops.test.ts` [SEC-006] | Approve periods | Founder + counsel | Founder decision required |
| Secrets | Worker secrets + GitHub secrets; scanning workflow; deploy fingerprints | `tests/secret-scan.test.ts`, `tests/staging-secrets.test.ts` | F-18/F-19 artifact exposure (PR #8) | Production-readiness session | Engineering incomplete (in PR) |
| Supply chain | Dependabot, CodeQL default setup (push/PR) plus a redundant advanced workflow, audit step (no-op) | workflow files | §6 | Engineering / Founder (settings) | Partly fixed here |
| Monitoring | in-platform health feeds, GitHub-hosted monitor | `tests/scheduler-health.test.ts`, `tests/infra-workflows.test.ts` | Alert destination (F-03) | Founder | Founder decision required |
| Backup / restore | pre-deploy exports, restore drill, rollback rehearsal | `tests/restore-drill.test.ts`, `tests/rollback-rehearsal.test.ts` | D1 restore drill on staging | **D1 restore session** | External verification |
| Legal documents | 12 published drafts with banner; versioned agreements, immutable acceptances | `tests/legal-commerce.test.ts` | Attorney review (LEGAL-004) | Founder + counsel | Attorney review required |
| Production | provisioning + deploy workflows, Founder authorization gate | `tests/provision-production.test.ts` | All gates | Founder | Production activation deferred |

---

## 2. Findings register (this review)

All findings are recorded in `security_findings` by `migrations/0040_security_readiness.sql`, so Gate C tracks them. "Resolved" means fixed in code on this branch with a regression test; it is not staging-verified until deployed.

### Critical

**F-18 — Staging Owner credentials published as a public artifact.** `deploy-staging.yml` on `main` uploads `access/README.md` (written by `scripts/staging-access.ts accessReadme`: preview password, Owner email and password, Owner TOTP setup key) as the `staging-preview-access` artifact. The workflow calls it "private"; on a public repository any signed-in GitHub user can download workflow artifacts.
- **Status:** open. Fix exists in **PR #8** (`claude/production-readiness`): encrypt with `ACCESS_ARTIFACT_PASSPHRASE` or withhold on a public repository. Reviewed here and sound.
- **Required now (Founder):** merge PR #8 (after review); delete existing `staging-preview-access` artifacts from past runs (Actions → each Deploy staging run → Artifacts → delete); then rotate staging credentials (`Deploy staging` → `rotate_credentials=true`). Treat the previous staging Owner password and 2FA key as compromised. Review staging `audit_logs` for `session.created` from unknown IPs.
- **Remaining risk until then:** anyone can sign in to staging as Owner. Staging holds seeded demo data only (no customer data), but the Owner can change staging settings and trigger staging integrations.

**F-19 — Production database export published as a public artifact.** `deploy-production.yml` on `main` exports `crestmont-production` and uploads it as `pre-deploy-production-export` (30-day retention).
- **Status:** open. Fix exists in PR #8 (export stored in the private R2 bucket; only the hash is reported). Production has never been deployed, so no customer data has been exposed.
- **Required:** PR #8 must merge **before the first production deployment**. Gate C blocks release while this is open.

### High

**F-26 — Privacy export leaked staff internal notes.** `buildExport` (`src/services/privacy.ts`) selected all `messages` of the customer organization, including `internal = 1` notes, while every other customer query filters them. Any customer member could read staff notes about their organization through `/account/privacy/export`. **Resolved** (filter added; test `[SEC-006] the self-service privacy export never contains staff internal notes`).

### Medium

| ID | Finding | Evidence | Status |
|---|---|---|---|
| F-20 | Lockout confirmed a correct password: a locked account said "locked" only to the right password, "incorrect" to wrong ones | `src/services/auth.ts login` | **Resolved**: lockout decided before the password result; unknown emails get an equivalent counter so the answer does not reveal which accounts exist. Two tests |
| F-21 | Files with `scan_status` `infected`/`failed` were downloadable via `GET /files/:id` (share links already refused them) | `src/services/files.ts serveFile` | **Resolved**: 409 + audited `file.download_blocked` |
| F-23 | `deploy-production.yml` interpolates free-text `inputs.tag` into `run:` scripts that hold the production token | lines `--notes "tag ${{ inputs.tag }}"`, `--message "Release ${{ inputs.tag }} …"` (also in PR #8) | **Open** — tested hand-off patch `pr8-pr13-F23-F24-workflow-hardening.patch` (applies cleanly to PR #8 and #13; their suite passes with it) |
| F-24 | Deploy workflows expose `CLOUDFLARE_API_TOKEN` to every step (including `npm install` of unpinned packages); `wrangler@4` and all actions pinned to mutable tags | job-level `env:` in deploy-production/staging | **Open** — same hand-off patch blanks secrets in every npm step; exact wrangler/SHA pinning still to do |
| F-29 | Published refund policy says the Founder decides discretionary refunds, but support can permanently deny at review (`under_review → denied` needs only `refund.review`) | `src/domain/refunds.ts`, `src/content/legal.ts` refunds | **Open — Founder decision D-08** (change the workflow or the policy text; not decided here) |
| F-30 | AI build inputs accepted files whose scan **failed**; portfolio uploads were stored as `clean` with no scan | `src/services/builds.ts`, `src/services/portfolio.ts` | **Resolved** (both refuse/label correctly; one-condition changes that merge cleanly with the AI builder and frontend branches) |
| F-25 | No legal-hold mechanism: retention purges and privacy anonymisation could destroy evidence | — | **Resolved**: `legal_holds` + enforcement (§4) |
| F-27 | Attachments on staff internal notes were stored as customer-organization files, visible and downloadable in the portal | `src/services/messages.ts postMessage` | **Resolved**: attachments refused on internal notes |
| F-28 | Privacy anonymisation, retention periods, pricing decisions, tax settings, invitation revoke and customer team changes did not need step-up MFA | `src/app/step-up.ts` | **Resolved**: 9 routes added; existing coverage test exercises the staff ones |
| F-10 (update) | The CI "dependency audit" ran `npm audit … \|\| true` at a root with no lockfile, so it could never fail | `ci.yml` | **Fixed here** (audits every committed lockfile, blocking on high); F-10 stays open until a passing run on GitHub Actions is recorded |

### Low

| ID | Finding | Status |
|---|---|---|
| F-22 | Outstanding password-reset links stayed valid after a reset or a password change | **Resolved** (`invalidateResetTokens`) |
| — | `runner/sandbox` and `runner/agent-sdk` lockfiles not committed; CI generates them per build, so the sandbox image installs an unreviewed dependency tree | Dependabot coverage added here; **committing the lockfiles** belongs to the AI runner workstream |
| — | Staging uses Cloudflare's public always-pass Turnstile test keys in `wrangler.toml` vars, so bot protection is not exercised on staging | Acceptable for staging; note for staging test plans |
| — | Migration number `0037` is used by both `main` (`0037_deploy_secret_fingerprints.sql`) and `claude/frontend-redesign` (`0037_portfolio_demos.sql`). Wrangler applies by full filename so both run, but ordering is implicit | Coordination note for the frontend session (rename to the next free number before merge). This branch uses `0040` |
| — | CI scratch folders (`backups/`, `access/`, `drill/`, `.pw/`) were not git-ignored | **Fixed** in `.gitignore` |
| — | `actions/checkout` without `persist-credentials: false` in `release.yml` (contents:write) | Patch in §9 |

### Already-fixed findings corrected in the register

F-06, F-08, F-11, F-13, F-15 were fixed in code with tests by earlier sessions (see `ASVS-REVIEW.md`) but `security_findings` still said `open`. The migration records them as resolved with their test evidence. The genuinely open release-blocking findings are now **F-01, F-02, F-03, F-10, F-16, F-18, F-19, F-23**. Open non-blocking: F-05 (accepted), F-09, F-14, F-17 (accepted), F-24, F-29.

---

## 3. Threat model (summary)

Assets: customer business data and files; staff and customer accounts; payment state (Stripe holds card data — Crestmont never does); voice transcripts/recordings; agreement acceptances and audit logs (legal evidence); deployment credentials (Cloudflare token, Worker secrets).

| Actor | Entry points | Main threats | Controls (where) | Residual |
|---|---|---|---|---|
| Anonymous internet | public pages, `/login`, `/register`, `/password/*`, `/api/leads`, `/share/:token`, webhooks | credential stuffing, enumeration, spam/bots, webhook forgery, SSRF via input | rate limits + lockout (`services/auth.ts`), uniform answers, Turnstile, HMAC/Stripe signatures, egress allowlist (`lib/egress.ts`) | no WAF rules provisioned (F-01/F-14) |
| Customer member | portal routes | cross-tenant access (IDOR), privilege escalation to admin/staff, malicious uploads | org-scoped queries, role checks, magic-byte allow-list, private storage, CSP sandbox on downloads | **no malware scanning** (F-02) |
| Customer admin | team, billing, share links | over-sharing files publicly | 7-day max links, scan acknowledgement, audit | links work without login by design |
| Staff (non-owner) | staff routes | over-broad data access, insider export | permission sets, assignment checks, step-up on exports, audit | stolen 12 h session (mitigated by step-up) |
| Owner | everything | account takeover = full control | MFA, step-up, break-glass scripts | single Owner; recovery depends on the Founder |
| CI / GitHub | workflows, artifacts, Dependabot PRs | secret leakage, supply-chain compromise, injection | env-scoped secrets, Founder authorization gate | **F-18, F-19, F-23, F-24**; repo settings unverifiable (§6) |
| Third-party providers | Stripe, Resend, Retell, Cloudflare, Anthropic (optional) | forged callbacks, outages, data handling | signatures, idempotency, fail-closed without secrets | provider DPAs not yet signed |
| AI runner / models | build jobs, AI drafts | prompt injection producing harmful output, data exfiltration | sandbox (no network), egress proxy, human approval of every AI output | model output quality is not a security control |

---

## 4. What this branch implemented

| Change | Files | Test |
|---|---|---|
| Uniform lockout (F-20) | `src/services/auth.ts` | `[AUTH-005]` ×2 |
| Reset links invalidated on reset/change (F-22) | `src/services/auth.ts` | `[AUTH-002]` |
| Quarantined files not served (F-21) | `src/services/files.ts` | `[SEC-003]` |
| Provider-independent scan verdicts (F-02 groundwork): bound to stored SHA-256, `infected` terminal, share links revoked, append-only `file_scans` | `src/services/malware-scan.ts`, migration 0040 | `[SEC-003] [F-02]` |
| Legal holds (F-25): global / organization / user; retention and anonymisation respect them; immutable, released once; Owner script | `src/services/legal-holds.ts`, `src/services/retention.ts`, `src/services/privacy.ts`, `scripts/legal-hold.ts`, migration 0040 | `[SEC-006]` |
| Internal notes excluded from export (F-26) | `src/services/privacy.ts` | `[SEC-006]` |
| No attachments on internal notes (F-27) | `src/services/messages.ts` | `[PORTAL-005]` |
| Step-up on 9 more actions (F-28) | `src/app/step-up.ts`, `tests/auth-hardening.test.ts` (scope note) | `[AUTH-008]` + existing coverage test |
| Findings register corrected and extended | `migrations/0040_security_readiness.sql` | `[SEC-007]` |
| Blocking dependency audit; Dependabot for runner sub-packages; artifact retention 14 days; CI scratch ignored | `.github/workflows/ci.yml`, `dependabot.yml`, `.gitignore` | YAML validated; audit step dry-run locally |

**Not changed on purpose:** MFA keys and migration (MFA session), D1 restore implementation (restore session), R2 adapter (R2 session), Resend/Stripe/Retell code and webhooks (their sessions), deploy/provision workflows and `wrangler.toml` (PR #8/#12/#13), frontend files, published agreement texts (counsel first), email-verification gating and retention periods (Founder).

---

## 5. Authentication and authorization matrix

| Capability | Anonymous | Customer member | Customer admin | Staff (by permission) | Owner |
|---|---|---|---|---|---|
| Sign in / register / reset | ✔ (rate-limited, uniform answers) | ✔ | ✔ | ✔ + MFA required | ✔ + MFA required |
| Own projects, messages, tickets, files | — | ✔ own org | ✔ own org | assigned or `*.read_all` | ✔ |
| Approvals, change orders, billing | — | — | ✔ (`customer.approve`/`customer.billing`) | — | — |
| Team management | — | — | ✔ (+ step-up if MFA) | — | — |
| Share links | open link only | — | ✔ (scan-aware) | if can read file | ✔ |
| Personal data export | — | ✔ own (+ step-up if MFA) | ✔ own | ✔ own | ✔ own |
| Process privacy deletion | — | — | — | `employee.manage` + step-up | ✔ + step-up |
| Refund decide / issue, pricing, tax, retention, AI budget, security exceptions, production release | — | — | — | — | Owner-only + step-up |
| Legal holds | — | — | — | — | Owner (script; no web form yet) |
| Scan verdicts | — | — | — | — | via `recordScanResult` only (no endpoint until a scanner is chosen) |
| `/api/*` writes | signature-authenticated only; cookies never authorize | | | | |

Source of truth: `src/domain/authz.ts` (permissions), `src/app/step-up.ts` (step-up), `tests/support/route-inventory.ts` (every route classified).

---

## 6. Secrets inventory (names only — no values)

| Secret | Where it lives | Used by | Staging/production separate | Rotation |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub secrets (should be environment-scoped) | deploy, provision, drills | **Cannot verify from repo** whether scoped per environment | Cloudflare dashboard → API tokens → roll; update GitHub secret |
| `EVIDENCE_INGEST_SECRET` | GitHub secret + Worker secret | CI evidence, GitHub snapshot | per environment (PR #8 derives per-env) | change both sides together |
| `SCHEDULER_TRIGGER_SECRET`, `BUILD_RUNNER_SECRET` | Worker secret (+ runner host) | backup scheduler, AI runner | per environment | put new value; restart runner |
| `MFA_ENCRYPTION_KEY` | Worker secret | TOTP encryption | per environment | **MFA session owns**; re-encryption script exists |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Worker secret | payments | test keys on staging only | Stripe dashboard roll |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Worker secret | email | per environment | Resend dashboard |
| `RETELL_API_KEY`, `VOICE_WEBHOOK_SECRET` | Worker secret | voice | per environment | Retell dashboard |
| `ANTHROPIC_API_KEY` | Worker secret (optional, paid) | AI adapter (off by default) | — | console |
| `GITHUB_TOKEN` | Worker secret (optional) | readiness GitHub view | — | fine-grained, read-only |
| `TURNSTILE_SECRET` / `PRODUCTION_TURNSTILE_*` | `wrangler.toml` (staging test keys) / GitHub secrets (production) | bot protection | yes | Cloudflare Turnstile |
| `STAGING_PREVIEW_PASSWORD`, `STAGING_ACCESS_PASSWORD` | GitHub secret / Worker secret | staging preview gate | staging only | **rotate after PR #8 merge (F-18)** |
| `ACCESS_ARTIFACT_PASSPHRASE` | GitHub secret (introduced by PR #8) | encrypting access notes | — | Founder keeps it in a password manager |

Fail-safe behaviour already in code: Turnstile fails closed outside development; webhooks reject without a secret; staging/production refuse MFA enrolment without `MFA_ENCRYPTION_KEY`; scheduler endpoint returns 503 without its secret. No secret values were found in tracked files: `git grep` across the current tree of **every** remote branch for Stripe, Resend, Anthropic, GitHub, AWS and Slack key formats and PEM private-key headers matched only deliberate fake values in test fixtures (`runner/test/*`, `tests/builds.test.ts`, `tests/platform.test.ts`). Git history (older commits) was not scanned; the repository's own `tests/secret-scan.test.ts` and GitHub secret scanning (once enabled, §10) cover that. Frontend bundles (`public/assets`) contain no secrets; only the public Turnstile site key is rendered.

---

## 7. Data classification

| Class | Examples | Storage | Who can read | Retention | Deletion |
|---|---|---|---|---|---|
| Restricted — credentials | password hashes, TOTP secrets, recovery-code hashes, token hashes | D1 (hashed / AES-GCM) | nobody in UI; never exported | life of account | anonymisation removes |
| Confidential — customer content | files, messages, tickets, project data, AI drafts | D1 + R2 (private) | own org + assigned staff | relationship (business record) | privacy request / soft delete → purge after configured period |
| Confidential — voice | transcripts, recording URLs | D1 | voice-permitted staff | proposed 90 days (off) | configured tier |
| Personal — contact | names, emails, phones, IPs in security events | D1 | staff by permission | proposed 365 days for security events (off) | anonymisation |
| Financial | orders, invoices, payments, refunds, receipts | D1 (+ Stripe) | finance permission | ~7 years (accountant to confirm) | never by retention job |
| Legal evidence | audit logs, agreement acceptances, privacy requests, legal holds, scan verdicts | D1, append-only triggers | audit permission | indefinite pending counsel | never |
| Operational | sessions, rate limits, metrics | D1 | system | 2–90 days (always tier) | automatic |

Backups (D1 exports) contain all of the above: they must stay encrypted and private (F-19 is exactly this risk).

---

## 8. Concurrent work observed (ownership)

| Branch (PR) | Ahead of main | Touches | Relationship to this branch |
|---|---|---|---|
| `claude/production-readiness` (PR #8) | 5 | deploy workflows, `scripts/evidence-secret.ts`, `wrangler.toml`, DEPLOYMENT/STAGING docs | **Fixes F-18/F-19 — merge dependency.** No file overlap with this branch |
| `claude/production-d1-id` (PR #12) | 1 | `wrangler.toml`, provision test | none |
| `claude/production-mfa-key` (PR #13) | 7 | includes PR #8's commits + provisioning | none; MFA untouched here |
| `claude/frontend-preview-encrypt-access` (PR #9) | 16 (40 behind main) | frontend assets, preview workflow | none; behind main |
| `claude/frontend-redesign` | 22 | public assets, layout, `0037_portfolio_demos.sql` | migration number collision (note above) |
| `claude/staging-email-recipient-guard` (Resend) | 3 | email adapter, hooks, `app.ts`, `context.ts` | none (this branch does not touch those files) |
| `dependabot/*` (4) | 1 each | action versions in workflows | `ci.yml` edits here avoid the `uses:` lines, so rebases are trivial |
| `claude/backend-pending`, `ci-dom-iterable`, `production-provisioning` | 0 | — | already merged |

PR state (open/merged) could not be read: this session has read-only git access and the GitHub API/web pages were not reachable. States above are inferred from git ancestry.

---

## 9. Hand-off patches for other workstreams (not applied here, to avoid conflicting PRs)

**For the PR #8 / #13 owner — `deploy-production.yml` (F-23, F-24):**
```yaml
# inputs: validate and pass via env, never interpolate into run:
- name: Validate release tag
  env: { TAG: "${{ inputs.tag }}" }
  run: '[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "::error::invalid tag"; exit 1; }'
# then in later steps:
  env: { TAG: "${{ inputs.tag }}" }
  run: $WRANGLER deploy --env production --message "Release ${TAG} ${TARGET_COMMIT}"
```
- Move `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` from job-level `env:` to the individual wrangler steps (same in `deploy-staging.yml`, which runs `npm install … playwright` with the token in scope).
- Pin wrangler exactly (`wrangler@4.<x>.<y>`) or add it to a committed devDependencies lockfile and use `npm ci`.
- Add `persist-credentials: false` to checkouts that don't push (`release.yml` especially).
- After Dependabot settles action versions, pin all `uses:` to full commit SHAs with a version comment.

**For the AI Website Builder workstream — `src/services/builds.ts`:** done on this branch (F-30): `runnerFile` and the brief file list now refuse `failed` as well as `infected`. Merges cleanly with `claude/ai-website-builder-readiness`; please keep the condition when rebasing.

**For the R2 workstream:** when a scanner is chosen, the upload path should keep new objects un-servable until a verdict (see `docs/security/MALWARE-SCANNING.md` §3).

**For the AI runner workstream:** `runner/sandbox/package-lock.json` is committed on `claude/ai-website-builder-readiness` (good — the CI audit here will then audit it); `runner/agent-sdk/package-lock.json` is still missing.

---

## 10. GitHub settings that cannot be verified or changed from the repository

The Founder (organization owner) should check these in GitHub. None cost money on a public repository.

1. **Settings → Environments → `production`:** required reviewer = Founder; *Deployment branches and tags* = `main` only. Without the branch rule, `workflow_dispatch` can run a modified workflow file from a feature branch and skip the in-file `main` checks.
2. **Environment secrets:** keep `CLOUDFLARE_API_TOKEN` and production Turnstile keys on the `production` environment, not at repository level.
3. **Settings → Rules → Rulesets** for `main`: require PR, 1 approval, required status check *CI / test*, block force pushes and deletion. Add a tag ruleset for `v*`.
4. **Settings → Actions → General:** *Require approval for all outside collaborators* for fork PRs; default workflow permissions = *Read repository contents*.
5. **Settings → Code security:** enable Secret scanning + Push protection and Dependabot alerts/security updates. **Code scanning default setup is already enabled** (verified on PR #18: it analyses `actions` and `javascript-typescript` on pushes and PRs). Because default setup is on, the separate `.github/workflows/codeql.yml` (advanced setup, weekly + manual) can never upload results and fails each run ("CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled"). Decision for the Founder: delete `codeql.yml` (recommended — default setup covers it) or switch default setup off and keep the workflow. Not changed here.
6. **Actions → artifacts:** delete existing `staging-preview-access` and `pre-deploy-production-export` artifacts from past runs (F-18/F-19).
7. Consider whether the repository should be **private**. Being public is the root cause of F-18/F-19. Private repositories lose free CodeQL/secret scanning unless GitHub Code Security is purchased — a cost/benefit decision for the Founder (register item D-15).

---

## 11. Verification on this branch

- `npm test`: see the final commit message for counts (all passing).
- `tsc -p tsconfig.json`: clean (checked locally with TypeScript 6.0 / @types/node 26 because the package registry was unreachable from this workspace; CI uses TypeScript 5 / @types/node 22).
- New tests: `tests/security-readiness.test.ts` (10 tests).
- Not done: staging verification (no deploy rights from this session), penetration test, any scan of live systems.
