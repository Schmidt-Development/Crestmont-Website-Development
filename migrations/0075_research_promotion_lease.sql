-- Research → CRM promotion: overlap protection and per-run measurement.
--
-- Why a lease. Promotion moves from a 15-minute schedule to a one-minute one, so a run that takes longer than a
-- minute would otherwise be running while the next tick starts. Two concurrent runs do not corrupt anything — the
-- intake engine's idempotency key means a second attempt on a prospect returns the first decision rather than making
-- a second lead — but they do waste the whole next invocation re-walking work in flight, and they make the per-minute
-- figure unreadable, which is the figure the target is stated in.
--
-- So a run takes a lease first. The lease is one row and is taken with a conditional UPDATE: a single D1 statement is
-- atomic, so `WHERE expires_at IS NULL OR expires_at <= now` is a correct compare-and-swap, and the run that changed
-- zero rows knows someone else holds it. It carries an expiry rather than a flag so a Worker that dies mid-run cannot
-- wedge the schedule: the lease simply goes stale and the next tick takes it. A run that finishes normally releases it
-- immediately, so the next minute starts at once instead of waiting out the expiry.
CREATE TABLE research_promotion_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,                 -- the run id holding it; NULL when free
  trigger TEXT,                -- which kind of run holds it, for diagnosis
  acquired_at TEXT,
  expires_at TEXT              -- NULL or past = free. Never trust a holder without checking this.
);
INSERT INTO research_promotion_lease (id, holder, trigger, acquired_at, expires_at) VALUES (1, NULL, NULL, NULL, NULL);

-- What the run cost and how it was configured, so throughput can be read from the rows rather than inferred.
-- duration_ms is the wall clock of the run; with `promoted` it gives leads per second per run, and across runs it
-- gives the per-minute and per-hour figures the target is stated in.
ALTER TABLE research_promotion_runs ADD COLUMN duration_ms INTEGER;
-- Prospects left out of the batch because they share a phone, email or domain with one that was taken. They are not
-- a backlog that has drained, and without this column a run reporting fewer than its cap looks like one that did.
ALTER TABLE research_promotion_runs ADD COLUMN deferred_identity INTEGER NOT NULL DEFAULT 0 CHECK (deferred_identity >= 0);
-- How many promotions were in flight, so a throughput change can be attributed to the setting that caused it.
ALTER TABLE research_promotion_runs ADD COLUMN concurrency INTEGER;

-- Reading "how many leads did research create in the last minute / hour" straight from the CRM rather than from the
-- promoter's own counters is what the acceptance test requires. Research leads are a small slice of the table, so the
-- index is partial and stays cheap.
CREATE INDEX idx_leads_research_created ON leads(created_at) WHERE origin = 'research_agent';
