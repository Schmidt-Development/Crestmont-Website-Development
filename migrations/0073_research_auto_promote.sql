-- Automatic research → CRM promotion, numbered 0073. 0070 research samples, 0071 readiness derivation and 0072
-- build revisions (PR #123) are on main; 0064-0069 are claimed by open PRs #108-#114. Prefixes must be unique
-- (tests/ops-closeout.test.ts) and D1 applies by name, so the relative order does not matter. Additive: two settings
-- columns, three prospect columns, one new table.
--
-- Why this exists: promotion was a per-prospect Owner click (POST /staff/research/promote, one prospect_id). There was
-- no automatic path at all, so a worker producing thousands of qualified prospects a day could only ever reach the CRM
-- a handful at a time. The Founder authorised automatic creation for prospects that already meet the verified
-- qualification criteria; genuinely ambiguous records (shared phone, same business as another record) still wait for a
-- person, which is what `status = 'review'` already means.
--
-- Nothing here weakens a control. Promotion still goes through the CRM intake engine (contact-identity.ts, channel
-- research_agent), so customer matching, suppression, do-not-call, shared-identifier review, idempotency and the audit
-- record all apply exactly as they do to a human promotion. Creating a CRM lead still releases nobody for calling:
-- outbound eligibility is computed fail-closed and stays blocked (src/domain/research.ts#outboundEligibility).

-- Owner controls. auto_promote ships OFF: turning it on is one deliberate decision by the Owner, not a per-lead
-- approval, and it means a deploy can never start creating leads by surprise.
ALTER TABLE research_settings ADD COLUMN auto_promote INTEGER NOT NULL DEFAULT 0 CHECK (auto_promote IN (0,1));
-- Upper bound on leads one run may create. Keeps a backlog drain resumable and bounded instead of one huge write.
ALTER TABLE research_settings ADD COLUMN auto_promote_max_per_run INTEGER NOT NULL DEFAULT 200 CHECK (auto_promote_max_per_run BETWEEN 1 AND 2000);

-- Retry state per prospect, so a transient failure is retried with backoff and a persistent one stops instead of
-- being attempted forever. A prospect the intake engine decides on (promoted / existing / review / suppressed) is
-- moved out of 'qualified' by promote(), so it is never reconsidered by its status alone.
ALTER TABLE research_prospects ADD COLUMN promote_attempts INTEGER NOT NULL DEFAULT 0 CHECK (promote_attempts >= 0);
ALTER TABLE research_prospects ADD COLUMN promote_last_error TEXT;
ALTER TABLE research_prospects ADD COLUMN promote_next_at TEXT;   -- NULL = due now

-- One row per automatic promotion run: the numerical reconciliation, kept rather than recomputed, so "what did the
-- backlog drain actually do" is answerable later. Counts only, no business data.
CREATE TABLE research_promotion_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','owner','ingest')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  examined INTEGER NOT NULL DEFAULT 0 CHECK (examined >= 0),
  promoted INTEGER NOT NULL DEFAULT 0 CHECK (promoted >= 0),          -- new CRM leads created
  existing_crm INTEGER NOT NULL DEFAULT 0 CHECK (existing_crm >= 0),  -- matched a CRM contact; no second lead
  review INTEGER NOT NULL DEFAULT 0 CHECK (review >= 0),              -- CRM duplicate-review queue; a person decides
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed >= 0),      -- do-not-call / email suppression / erasure
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),          -- intake refused the record as invalid
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),              -- unexpected error; retried with backoff
  remaining INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0),        -- still 'qualified' and due when the run stopped
  stopped_reason TEXT NOT NULL DEFAULT 'drained',                     -- drained | cap | paused | disabled | error
  actor_user_id TEXT REFERENCES users(id)                             -- NULL for a scheduled run
);
CREATE INDEX idx_research_promotion_runs_started ON research_promotion_runs(started_at);

-- Finding the next due batch is the hot query of the drain: one index for it.
CREATE INDEX idx_research_prospects_promote_due ON research_prospects(status, promote_next_at, score DESC);
