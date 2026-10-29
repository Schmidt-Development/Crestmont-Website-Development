-- Operations closeout (2026-10-29). Additive only.

-- ───────────── Owner alerting (CREST-GAP-015, -089, -024 alert part) ─────────────
-- One row per alert item that has been raised (dead-lettered Stripe event, reconciliation finding, stuck email queue,
-- failing readiness feed, security-event burst). The dedupe key makes the scheduled ops_alerts job idempotent: an item
-- or window is emailed to the Owners once, however many times the job runs. Holds ids and counts only (no message
-- bodies, no personal data beyond internal user ids).
CREATE TABLE ops_alerts (
  dedupe_key TEXT PRIMARY KEY,         -- e.g. stripe_dead_letter:evt_123, mfa_failed:usr_1:2026-10-29T10
  category TEXT NOT NULL,              -- stripe_dead_letter | reconciliation_finding | email_queue_stuck | feed_failing | security_burst
  subject TEXT,                        -- the item the alert is about (event id, finding id, feed source, user id)
  summary TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ops_alerts_created ON ops_alerts(created_at);
-- Security-event bursts are counted per kind over the last hour.
CREATE INDEX IF NOT EXISTS idx_security_events_kind_created ON security_events(kind, created_at);

-- ───────────── Stripe retry scan (CREST-GAP-104) ─────────────
-- retryFailedStripeEvents: WHERE status IN ('failed','received') AND attempts < 5; the monitoring and alert queries
-- filter on status = 'dead_letter'.
CREATE INDEX IF NOT EXISTS idx_stripe_events_status_attempts ON stripe_events(status, attempts);

-- ───────────── Blocker register (CREST-GAP-064) ─────────────
-- Three discovery blockers were cleared by real events but never closed in the register. Only rows still open are
-- changed, so a database where staff already resolved them keeps its own evidence.
UPDATE blockers SET status = 'resolved', resolved_at = '2026-10-29T00:00:00Z', updated_at = '2026-10-29T00:00:00Z',
  resolution_evidence = 'Cloudflare access exists: deploy-staging.yml deploys crestmont-platform-staging with the CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets since 2026-10-27 (staging D1 crestmont-staging created by the workflow); provision-production.yml created D1 crestmont-production (id c667f1a9-0802-4c52-a0e1-b512219a6eea, pinned in wrangler.toml by PR #12). Remaining provider items (R2 on staging, real Turnstile keys, DNS) are tracked as their own findings (CREST-GAP-055, -019, BLK-011).'
  WHERE id = 'BLK-003' AND status = 'open';
UPDATE blockers SET status = 'resolved', resolved_at = '2026-10-29T00:00:00Z', updated_at = '2026-10-29T00:00:00Z',
  resolution_evidence = 'The frontend toolchain is installed and run in GitHub Actions instead of this workspace: ci.yml installs TypeScript and runs typecheck and tests on every PR; deploy-staging.yml installs Playwright and runs the browser suites against staging; the consolidated frontend is served by crestmont-platform-staging (PR #24, merged 2026-10-29).'
  WHERE id = 'BLK-012' AND status = 'open';
UPDATE blockers SET status = 'resolved', resolved_at = '2026-10-29T00:00:00Z', updated_at = '2026-10-29T00:00:00Z',
  resolution_evidence = 'GitHub Actions billing was fixed: the first CI run after BLK-013 passed on PR #1 (2026-10-27), and CI, CodeQL and the staging deploy, restore drill and rollback rehearsal workflows have run on every merge since.'
  WHERE id = 'BLK-013' AND status = 'open';
