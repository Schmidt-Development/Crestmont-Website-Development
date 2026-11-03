-- READY-013: automatic, evidence-driven Launch Readiness.
-- (Numbered 0071: 0070 was taken by the research runner samples migration from PR #121.)
--
-- Implementation status used to be asserted by hand in requirements/status/*.ts and nothing recomputed it when
-- engineering work landed. src/readiness/derive.ts now derives every status from the evidence CI, the staging
-- deploy and the production checks already post. These tables persist the derivation so the Owner can see WHEN
-- it last ran, WHAT changed and WHY — the computation itself stays the single source of truth and is recomputed
-- on read, so these rows can never drift into a second, competing answer.

-- Current derived state, one row per requirement. Rewritten only when the derived state actually changes.
CREATE TABLE requirement_state (
  requirement_id TEXT PRIMARY KEY REFERENCES requirements(id) ON DELETE CASCADE,
  state TEXT NOT NULL,                 -- the ten-state vocabulary (derive.ts AutoState)
  progress TEXT NOT NULL,              -- the ladder position ignoring blockers
  complete INTEGER NOT NULL,
  complete_at TEXT NOT NULL,           -- the acceptance level this requirement must reach
  detail TEXT NOT NULL,                -- one sentence explaining the state
  proven_commit TEXT,
  head_commit TEXT,
  evidence_run_ids TEXT,
  updated_at TEXT NOT NULL
);

-- Every transition, append-only: the audit trail behind "why did this change?".
CREATE TABLE requirement_state_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  sync_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT NOT NULL,
  head_commit TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_req_state_history ON requirement_state_history(requirement_id, id);

-- One row per synchronisation. Idempotent: a sync that changes nothing still records that it ran, so the
-- dashboard can show "last checked" separately from "last changed".
CREATE TABLE readiness_sync (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,               -- evidence:<source>, deployment:<env>, blocker, manual, scheduled
  head_commit TEXT,
  requirements INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX idx_readiness_sync_time ON readiness_sync(finished_at);

-- ── Reconciliation (2026-11-02 audit, RECON-01) ──
-- BLK-004 asked for a dedicated Crestmont Stripe account in TEST MODE. That acceptance criterion is met and
-- recorded: staging deploy #123 (run 41364900468, commit 029e545) completed a hosted Stripe test-mode checkout
-- (journey 5), a signed webhook created the order (journey 6), the project was provisioned (journey 7) and the
-- customer opened the billing portal (journey 24); the run's probe reported GET /v1/balance succeeding in test
-- mode with the webhook endpoint enabled. Live-mode activation is a SEPARATE requirement (PAY-010) gated by
-- BLK-006 and LAUNCH-001, and is deliberately not closed here.
UPDATE blockers SET status = 'resolved', resolved_at = '2026-11-02T01:12:00Z',
  resolution_evidence = 'Dedicated Crestmont Stripe account configured in test mode and exercised end to end on staging: deploy #123 (GitHub Actions run 41364900468, commit 029e545) passed journeys 5, 6, 7 and 24 against the live hosted checkout, plus a test-mode refund ([PAY-007]) and a disputed payment ([PAY-008]) through signed webhooks. Live-mode activation remains open under PAY-010 (BLK-006, LAUNCH-001).'
  WHERE id = 'BLK-004' AND status = 'open';

-- Blocker links implied by the acceptance registry (requirements/acceptance.ts). The derivation gates on the
-- registry directly, so these exist so the Blocker pages name the requirements each blocker actually holds up.
-- Applied once by applySeedBlockerLinks; a link a person later removes is not re-created.
INSERT OR IGNORE INTO blocker_seed_links (blocker_id, requirement_id) VALUES
('BLK-002','INFRA-003'),
('BLK-003','READY-005'),('BLK-003','INFRA-002'),('BLK-003','FILE-001'),('BLK-003','LAUNCH-002'),('BLK-003','LAUNCH-003'),
('BLK-005','IDENT-003'),('BLK-005','EMAIL-001'),
('BLK-006','IDENT-001'),('BLK-006','IDENT-002'),('BLK-006','IDENT-005'),('BLK-006','PAY-010'),('BLK-006','SUP-005'),
('BLK-006','SEC-006'),('BLK-006','SEC-007'),('BLK-006','LEGAL-001'),('BLK-006','LEGAL-002'),('BLK-006','LEGAL-004'),
('BLK-006','LEGAL-005'),('BLK-006','LAUNCH-001'),
('BLK-007','PORT-001'),('BLK-007','PORT-002'),('BLK-007','PORT-003'),('BLK-007','PORT-004'),('BLK-007','PORT-006'),
('BLK-008','PORT-005'),
('BLK-009','SUP-004'),('BLK-009','AIOPS-002'),
('BLK-010','CAT-005'),('BLK-010','CAT-006'),('BLK-010','PAY-004'),
('BLK-011','IDENT-004');

-- The acceptance registry's identity per requirement. A changed acceptance rule (a new gate, a different
-- completion level) makes the stored copy stale, so syncRequirementsIfStale re-applies it at the next ingest
-- and a newly registered requirement appears without anyone touching the dashboard.
ALTER TABLE requirements ADD COLUMN acceptance_fingerprint TEXT;

-- DEPRECATED by READY-013: requirements.implementation_status is no longer an input to readiness. Status is
-- derived in src/readiness/derive.ts and stored in requirement_state. The column stays for schema
-- compatibility and old snapshots; nothing reads it for a verdict.
