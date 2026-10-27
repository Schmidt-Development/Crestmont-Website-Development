# Backup and recovery

**Requirements:** INFRA-006, DOC-002, TEST-004 · **Status:** procedures written. **No automated backups exist yet.** Cloudflare D1 and R2 are not provisioned because no Cloudflare account is connected (BLK-003). Until they are, the only data is the local development database. Record every backup and every restore drill, with evidence, at **/staff/backups**.

## 1. What needs protecting

| Data | Where (production design) | Loss impact |
|---|---|---|
| Relational data: accounts, CRM, quotes, orders, invoices, projects, tickets, audit log | Cloudflare D1 `crestmont-production` | Critical — financial and contractual records |
| Customer files and portfolio screenshots | R2 `crestmont-files-production` (private) | High |
| Worker code and configuration | GitHub `noahschmidt10/Crestmont-Website-Development` + Cloudflare deployments | Low — rebuildable from git |
| Secrets | `wrangler secret` per environment; the Founder's password manager is the source of truth | High — rotate rather than restore (see RUNBOOK §4) |
| Stripe and Resend records | The providers themselves (source of truth for payments and email events) | Re-sync through webhooks and reconciliation |

## 2. Proposed RPO / RTO (for Founder approval)

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

Until a scheduled job exists, take exports manually before every production migration and at least weekly. Automating this (a GitHub Actions cron with a scoped API token) is a follow-up once BLK-003 and BLK-013 are cleared.

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
