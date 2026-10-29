# Backup and recovery

**Requirements:** INFRA-006, DOC-002, TEST-004 · **Status (2026-10-29):** staging is restore-drilled after every deploy (`staging-restore-drill.yml`); production has a pre-deploy export (`deploy-production.yml`) and a **daily sealed off-Cloudflare export with restore verification** (`production-backup.yml`, §3.2), which runs once its destination secrets are set. R2 versioning (§4) is not yet verified. Record every backup and every restore drill, with evidence, at **/staff/backups**.

## 1. What needs protecting

| Data | Where (production design) | Loss impact |
|---|---|---|
| Relational data: accounts, CRM, quotes, orders, invoices, projects, tickets, audit log | Cloudflare D1 `crestmont-production` | Critical — financial and contractual records |
| Customer files and portfolio screenshots | R2 `crestmont-files-production` (private) | High |
| Worker code and configuration | GitHub `noahschmidt10/Crestmont-Website-Development` + Cloudflare deployments | Low — rebuildable from git |
| Secrets | `wrangler secret` per environment; the Founder's password manager is the source of truth | High — rotate rather than restore (see RUNBOOK §4) |
| Stripe and Resend records | The providers themselves (source of truth for payments and email events) | Re-sync through webhooks and reconciliation |

## 2. RPO / RTO — engineering targets, pending Founder approval

**Engineering targets for production D1: RPO 24 h, RTO 4 h.** RPO 24 h is what the daily off-Cloudflare export (§3.2, `production-backup.yml`) guarantees even if Cloudflare itself is lost; D1 Time Travel gives minutes while Cloudflare is available. RTO 4 h is the time to restore the latest export into a new D1 database and repoint the Worker, which the daily restore-verification job rehearses. These are **engineering targets, not commitments**, until the Founder approves them (record the approval at /staff/backups).

| Tier | Data | RPO (max data loss) | RTO (max time to restore) |
|---|---|---|---|
| 1 | D1 production | **≤ 24 h** from daily exports; **≤ minutes** with D1 Time Travel | **≤ 4 h** |
| 2 | R2 customer files | **≤ 24 h** (object versioning + daily inventory) | **≤ 8 h** |
| 3 | Worker deployment | 0 (git) | **≤ 30 min** (rollback) |

These are **proposals**, not commitments. The Founder approves them, and they become valid only after a restore drill in staging measures real numbers (recorded at /staff/backups → "Observed RTO/RPO").

## 3. D1 (database)

### 3.1 Time Travel (point-in-time restore)
D1 Time Travel keeps a continuous history (30 days on paid Workers plans; **confirm the current retention for the account's plan**).

```sh
# Find a bookmark for the moment just before the incident
wrangler d1 time-travel info crestmont-production --timestamp "2026-11-02T14:05:00Z"
# Restore IN PLACE to that bookmark (destructive: overwrites current data)
wrangler d1 time-travel restore crestmont-production --bookmark <bookmark-id>
```

Rules:
- **Always** export the current state first (§3.2) so the restore itself can be undone.
- A production restore requires Founder approval (an incident decision). Record it as an incident blocker and a release-history entry.
- Payments: after a restore, replay Stripe events received since the restore point. Stripe redelivers on request, and event ids are idempotent in `stripe_events`. Then run reconciliation.

### 3.2 Logical export (daily backup)
```sh
wrangler d1 export crestmont-production --remote --output backups/crestmont-production-$(date -u +%Y%m%dT%H%MZ).sql
sha256sum backups/*.sql
```
Store the export **outside Cloudflare**: an encrypted bucket in a second provider, or the Founder's encrypted storage. Record what, where, size, sha256 and who verified it at /staff/backups. Exports contain personal and financial data: encrypt them at rest and restrict access.

**Scheduled (CREST-GAP-016): `.github/workflows/production-backup.yml`, daily 06:37 UTC.**

1. `backup` job (environment `production`, or the one named by the repository variable `BACKUP_ENVIRONMENT`): `wrangler d1 export crestmont-production --remote --env production` plus SELECT row counts. **Read-only**: nothing else is ever run against the production database (enforced by `tests/infra-workflows.test.ts`). The export is sealed with `scripts/seal.ts` (AES-256-GCM, passphrase `BACKUP_SEAL_PASSPHRASE`), the plaintext deleted, and the sealed object plus a manifest (sha256 of the export and of the sealed object, per-table row counts, commit, run id) uploaded with `scripts/offsite-backup.ts` (AWS Signature V4, no third-party code) to `crestmont-production/d1/YYYY/MM/` in an S3-compatible bucket **outside Cloudflare**. Both sha256 values are in the run summary.
2. `restore-verify` job: downloads the object back from the store, checks both sha256 values, opens it, restores it into a throw-away D1 database `crestmont-backup-verify-<run>`, compares every table's row count with the manifest, records INFRA-006 evidence (when `READINESS_URL` / `EVIDENCE_INGEST_SECRET` are set), and deletes the scratch database.

It skips with a notice, exporting nothing, until these **environment secrets** exist: `BACKUP_S3_ENDPOINT` (e.g. `https://s3.us-west-004.backblazeb2.com`), `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_SEAL_PASSPHRASE` (32+ characters; store it in the Founder's password manager — without it no backup can be opened), optional `BACKUP_S3_REGION`. Use a key limited to that one bucket, with **object lock or versioning** and a lifecycle rule (e.g. keep 35 daily copies). If the `production` environment has required reviewers, each scheduled run waits for approval; to run unattended, create an environment without reviewers that holds the same secrets and set `BACKUP_ENVIRONMENT` to its name. Open a backup: download the `.sql.sealed` object, then `node --no-warnings scripts/seal.ts open <file> export.sql`. Note: a D1 export briefly blocks other queries on a large database, so the job runs off-peak.

The pre-deploy export in `deploy-production.yml` still runs before every production migration.

### 3.3 Restore from an export (drill or disaster)
```sh
wrangler d1 create crestmont-restore-drill
wrangler d1 execute crestmont-restore-drill --remote --file backups/<export>.sql
# Verify: row counts per table compared with the source, latest audit_logs id, latest invoice
wrangler d1 execute crestmont-restore-drill --remote --command "SELECT COUNT(*) FROM invoices; SELECT MAX(id) FROM audit_logs;"
```
Drills **never** target production. Record the drill, its result, the time taken (observed RTO) and the age of the export (observed RPO) at /staff/backups → "Record a restore drill".

Local development equivalent (works today; TEST-004):
```sh
# Full SQL export in the same format as `wrangler d1 export` (schema + data + indexes + triggers)
node --no-warnings scripts/backup-export.ts --db .dev/crestmont.db --out backups/dev-$(date -u +%Y%m%d).sql
# Restore into a FRESH database and verify: row counts per table vs the source, schema parity,
# integrity_check, foreign_key_check, audit_logs still append-only. --record writes the drill to
# restore_tests (environment "development") so it appears at /staff/backups.
node --no-warnings scripts/restore-verify.ts --export backups/dev-YYYYMMDD.sql --source .dev/crestmont.db \
  --record .dev/crestmont.db --by <your staff user id>
```
The same `restore-verify.ts` checks apply to a `wrangler d1 export` file restored locally, which is a cheap pre-check before a D1 drill. `tests/ops.test.ts` proves the round trip on a database populated through the real routes (registration, checkout, Stripe webhook, readiness approvals, audit log). Development drills do **not** satisfy the staging drill requirement below.

## 4. R2 (files)

- Turn on **object versioning** (or bucket lifecycle retention of non-current versions, 30 days) on `crestmont-files-production` when the bucket is created.
- Deleted or overwritten objects are recovered from the previous version.
- Disaster copy: a scheduled `rclone sync` (S3-compatible API with a read-only R2 token) to a second provider. Not set up yet.
- The `files` table holds `r2_key`, `sha256` and `size_bytes` for every object, so a restore can be verified by recomputing hashes.

## 5. Worker deployment rollback

```sh
wrangler deployments list --env production
wrangler rollback <deployment-id> --env production --message "Rollback: <reason>"
```
- A rollback restores code only. **Database migrations are not rolled back automatically.** Migrations must be backward-compatible (additive) for at least one release so the previous Worker version still works against the new schema.
- If a migration must be undone, restore D1 (§3.1) to the bookmark taken just before the migration. Founder approval is required.
- Record the rollback in release history (`deployments.status = 'rolled_back'`, `rollback_target_deployment_id`).

## 6. Verification schedule (proposed)

| What | How often | Evidence |
|---|---|---|
| D1 export taken and hashed | Daily (manual weekly until automated) | /staff/backups record |
| Restore drill (export → scratch D1, row-count compare) | Monthly, and before launch | /staff/backups drill with observed RTO/RPO |
| Time Travel bookmark lookup | Quarterly | Drill record |
| R2 version restore of a test object | Quarterly | Drill record |
| Worker rollback in staging | Before launch, then each quarter | Release history + drill record |

INFRA-006 stays **in progress** until automated backups exist in staging and production and at least one restore drill has passed there.
