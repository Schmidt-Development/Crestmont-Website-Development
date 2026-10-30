# CRM duplicate protection — operational runbook

Covers migrations `0048_contact_identity.sql` and `0049_crm_identity_erasure.sql`, `src/services/contact-identity.ts` (intake engine), `src/services/identity-erasure.ts` (privacy erasure),
`src/services/outreach-ledger.ts` (dial and email dedupe), `src/services/crm-import.ts` (import API),
`scripts/crm-duplicate-audit.ts` (historical audit). Background: [AUDIT.md](AUDIT.md). API: [IMPORT-API.md](IMPORT-API.md).

## 1. What changes for people

| Who | What they will see |
|---|---|
| Visitor submitting a form again | Their open lead continues (message added to history, reply task due today) instead of a second lead |
| Caller known to the CRM | The receptionist call attaches to their open lead |
| Staff adding a lead | Live "possible match" hint while typing; on save, matching records are shown **before anything is written**, with "Add this lead to …" or "Create a separate record" |
| Staff editing a contact | Edit is saved; if the new email/phone is used by another record, a review item is created |
| Staff/Owner | CRM → Duplicates gains **Review queue** and **Duplicate prevention** tabs; each lead shows **Contact identity & provenance** |
| Outbound calling | A second request for a number that already has an open request folds into it; two runs can never dial one number at once |

Only the Owner (the only role with `lead.write_all`) resolves review items, and only staff who can see all leads can
open the review queue (it shows contact details of any record). Applying anything to an existing customer's
record is Owner-only by design.

## 2. Configuration (per environment)

```bash
openssl rand -hex 32 | npx wrangler@4.149.0 secret put CRM_IMPORT_SECRET --env staging      # then production
```
Store it in the Founder's password manager and give the same value to the research engine. Until it is set the import
endpoint answers `503` (fail closed). Rotate by putting a new value and updating the engine (requests signed with the old
secret then get `401`; retry with the same idempotency key is safe).

## 3. Release sequence

1. **Founder approves the PR.** Merging to `main` deploys staging automatically: typecheck, tests, D1 Time Travel
   bookmark, `wrangler d1 migrations apply` (0048 runs here), deploy, smoke and browser checks.
2. **Verify staging** (checklist below). Record results on the PR.
3. **Production** only through the release workflow (Founder approval; export + migrations + deploy). Set
   `CRM_IMPORT_SECRET` in production only when the research engine is ready.

### Staging verification checklist

- [ ] `npx wrangler@4.149.0 d1 execute crestmont-staging --remote --env staging --command "SELECT kind, COUNT(*), SUM(shared) FROM contact_identities GROUP BY kind"` returns rows (backfill ran).
- [ ] Same for `SELECT COUNT(*) FROM contacts` / `leads` / `companies`: equal to the counts before the deploy.
- [ ] `/contact` twice with the same email → one lead, second message in its history, reply task present.
- [ ] `/staff/crm/new` with an existing email → warning shown, nothing saved; "Add this lead to …" links it.
- [ ] Lead page shows **Contact identity & provenance**; CRM → Duplicates → Review queue and Duplicate prevention render.
- [ ] Import API: unsigned request → 401; with `CRM_IMPORT_SECRET` set on staging, a signed `dryRun` batch → 200 and
      no rows written; a signed real batch with one known number → `NO_CHANGE`/`EXISTING_*`, with a DNC number → `SUPPRESSED`.
- [ ] Owner: CRM → Duplicates → Review queue → *Erase a person's CRM data* for a test research record → its contact,
      identifiers and review items are gone; re-importing it returns `SUPPRESSED`; `crm_erasure_tombstones` has one row
      per identifier and no raw value.
- [ ] Outbound stays off on staging (`RETELL_OUTBOUND` not `on`); `phone_outreach_ledger` has no stuck reservations.

## 4. Historical duplicate remediation (dry run first, never automatic)

```bash
npx wrangler@4.149.0 d1 export crestmont-production --remote --env production --output crm-export.sql
sqlite3 crm.sqlite < crm-export.sql
node --no-warnings scripts/crm-duplicate-audit.ts --db crm.sqlite --out audit.json --md audit.md          # ids only
node --no-warnings scripts/crm-duplicate-audit.ts --db crm.sqlite --md audit-private.md --show-values     # Founder only, never commit
```
The database is opened read-only. Classes: safe exact duplicates, probable duplicates, shared contact identities,
conflicting records, existing customer conflicts (see the script header).

Founder review workflow:
1. Read `audit.md`. Decide which groups to look at (start with safe exact duplicates).
2. Optional: put every group in the review queue — `--emit-review-sql review-items.sql`, read it, then
   `npx wrangler@4.149.0 d1 execute crestmont-production --remote --env production --file review-items.sql`
   (adds review items only; idempotent).
3. For each group open the lead: merge with the existing **Possible duplicates** card (moves activities, quotes,
   orders and calls; fills blanks; archives the other lead; audited) or mark **Not a duplicate**. Then close the review
   item. Shared identities are normally kept separate. Customer conflicts: Owner only; never merge organizations or
   Stripe customers from the CRM.

Nothing is deleted at any step; merged leads stay archived with `merged_into_lead_id`.

## 5. Day-to-day operations

| Task | How |
|---|---|
| Work the review queue | CRM → Duplicates → Review queue (Owner). Apply / Link / Create separately / Keep existing |
| See why something was linked | Lead page → Contact identity & provenance → Intake decisions (rule, channel, outcome) |
| Check a number's outbound state | Lead page identity table (attempts, last outcome, lease) or `SELECT * FROM phone_outreach_ledger WHERE phone_e164 = '+1…'` and `phone_outreach_events` |
| A lease looks stuck | Leases expire on their own (dial lease = stale-dial window + 30 min) and the `voice_outbound` job recovers them; recovery is logged as `expired` events. Do not clear by hand while a call may be live |
| Duplicate-prevention metrics | CRM → Duplicates → Duplicate prevention (last 30 days) |
| Research batch status | `SELECT id, client, status, counts_json, created_at FROM crm_import_batches ORDER BY created_at DESC LIMIT 20` |

Useful queries:
```sql
-- outcomes in the last 7 days
SELECT outcome, channel, COUNT(*) FROM crm_intake_decisions WHERE created_at >= datetime('now','-7 days') GROUP BY 1,2;
-- open review items by kind
SELECT kind, COUNT(*) FROM crm_identity_reviews WHERE status = 'open' GROUP BY kind;
-- reservations past expiry (should be empty after the next voice_outbound run)
SELECT phone_e164, reserved_for_id, lease_expires_at FROM phone_outreach_ledger WHERE reservation_id IS NOT NULL AND lease_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

## 5a. Privacy erasure of CRM identity data

Three entry points run the same erasure (`src/services/identity-erasure.ts`), each authenticated, permission-checked,
audited (counts only, never the identifiers) and safe to repeat:

| Entry point | Who | When |
|---|---|---|
| Staff → Security → privacy requests → Complete | `employee.manage` + fresh two-factor (step-up) | Account holder asked to be deleted |
| Staff → AI receptionist → Operations → Erase a caller's data | `voice.manage` | Caller without an account |
| CRM → Duplicates → Review queue → *Erase a person's CRM data* | **Owner only** + step-up | Anyone else (e.g. a research-imported prospect who writes in) |

What it removes (one atomic batch):
- **The person's contacts**: the account holder's own contacts / the caller's receptionist contacts, plus every
  non-customer contact whose identifier belongs to a single business: research-created prospects included. They
  become `Deleted contact`; their leads keep stage and history but lose the person's message.
- **Identifiers used by nobody else**: their `contact_identities`, all links, email campaign enrollments, and any
  held research candidate, review value or field-history value that normalizes to them (any formatting or case),
  **including review items that were never linked to a contact**. An item attached to another, legitimate record is
  kept for that record but its candidate data and matching values are replaced with `[erased]`.
- **Optionally (default on)** a re-import tombstone: salted SHA-256 of the normalized identifier, no name, no id.
  Research/CRM API imports of it return `SUPPRESSED` (`erased_at_request`). A person who contacts Crestmont again
  themselves (form, call) is not blocked. Untick *Allow research imports…* to skip the tombstone.

What it keeps, on purpose:
- A **shared identifier** (a line or inbox used by two different businesses, or by a customer) stays with those
  records; the result says how many were kept. A shared line never gets a tombstone, so the businesses that own it
  stay importable.
- **Customers'** records are not anonymised unless they are the named subject (account deletion).
- **Suppression**: `voice_dnc` and `email_suppressions` rows stay, so the opt-out is still honoured.
- **Outbound ledger** keeps the number for per-number call limits (as `calls` already do). Orders, invoices,
  payments, quotes, contracts and audit logs are untouched. Staff-written qualification notes stay.
- Intake decisions keep their outcome and record ids; they never held raw identifiers (receptionist idempotency keys
  are hashed).

Concurrency: an import racing an erasure either commits first and is erased with it, or is refused afterwards by the
tombstone (both sides use the `crm_write_guard` race guard and re-plan on conflict).

Tombstones are minimization, not anonymity: a phone number's keyspace is small enough that a hash can be brute-forced
by someone holding the database. They contain nothing else and are needed only to honour the request.

## 6. Rollback

Code rollback does not undo migrations (DEPLOYMENT.md). In order of preference:

1. **Code only** (most issues): redeploy the previous Worker version. The 0048 tables stay; the old code ignores them;
   triggers keep registering identities harmlessly.
2. **Database point-in-time** (data damage): D1 Time Travel restore to the bookmark the deploy workflow took before
   applying 0048 (`npx wrangler@4.149.0 d1 time-travel restore crestmont-<env> --env <env> --bookmark <id>`). Loses every
   write after the bookmark.
3. **Schema rollback** (remove 0049 / 0048 but keep later data): deploy the previous code first, export, then apply
   [`rollback-0049.sql`](rollback-0049.sql) (drops only the tombstone table: erased identifiers become importable
   again; erasures are not undone) and, if needed, [`rollback-0048.sql`](rollback-0048.sql). It drops only what 0048 added (identity, ledger, review, decision
   tables, triggers, views, the added columns) and removes the `d1_migrations` row so 0048 can be re-applied later.
   Contacts, companies, leads and calls are untouched (tests: case 20 in `tests/crm-identity.test.ts`, and the
   0048 + 0049 migration/rollback test in `tests/crm-erasure.test.ts`).

## 7. Known limitations (honest list)

- Historical audit not yet run on production/staging data (no database access from the build session).
- Staging behaviour not yet verified: it requires the PR to be merged (merging deploys staging).
- `leads.source` keeps its existing CHECK (rebuilding the table was avoided). Research leads use `source = manual`
  with `origin = research_agent`; reports group them under "manual" until a later migration adds a source value.
- A new phone number for an existing business is added as an additional identifier; the ledger dedupes per number,
  so two different numbers of one business are two ledger rows (outbound requests still need per-number consent).
- No marketing email automation exists; `enrollEmailCampaign()` is the gate future sequences must use, and an
  unsubscribe table should be added with the first marketing sequence.
- Import throughput figures are local SQLite measurements; D1 latency will be higher.
- The checkout path (`billing.ts ensureCheckoutLead`) keeps its own rule (link the buyer's open lead by email, else a
  new contact for the verified account holder); its identities are registered by the triggers.
- Erasure matches by normalized phone/email only. A held research record about the person that carries neither of the
  identifiers given (e.g. only their name) is not found; give every phone/email the person used.
- `contact_identities.shared` is only ever set, never cleared, when businesses stop sharing an identifier (conservative:
  a stale flag only makes matching more cautious).
- `enrollEmailCampaign()` reports `already_enrolled` (not `suppressed`) if a suppression lands between its check and its
  insert; the insert itself still refuses the suppressed address.
