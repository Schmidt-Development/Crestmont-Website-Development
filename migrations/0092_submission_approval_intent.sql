-- Approving a design at submission, applied only once the design actually exists.
--
-- The Founder's requirement: submitting a finished frontend should carry it all the way into the backend queue
-- without pressing another button. Approval is the one step in this architecture that must be a person's, and it
-- cannot happen at submission because there is nothing to approve yet -- the design has not been measured, and an
-- approval recorded against an unmeasured artifact would be an approval of nothing.
--
-- So the acknowledgement is recorded here, against the artifact, at the moment the Founder submits it: who said it
-- and when. It becomes an approval only after the artifact has been scanned clean, imported and measured, and it is
-- then recorded against THAT baseline -- its version, its design fingerprint and the artifact's own sha256 -- by
-- the usual approveBaseline path, with the usual audit row naming the person. An artifact that is infected,
-- invalid or unmeasurable never reaches that point, so an intent can never approve one.
--
-- Deliberately on the artifact and not on the project: the acknowledgement is about this upload, this version and
-- these bytes. A later artifact gets its own, or none.

ALTER TABLE frontend_artifacts ADD COLUMN approval_intent_by TEXT REFERENCES users(id);
ALTER TABLE frontend_artifacts ADD COLUMN approval_intent_at TEXT;
-- Set when the intent has been acted on, so it is applied exactly once even if a baseline is recorded again.
ALTER TABLE frontend_artifacts ADD COLUMN approval_intent_applied_at TEXT;

-- The Founder's four-slot queue. The cap already existed and already queues (claimJob refuses at_capacity and
-- leaves the rest waiting in order); it was set to 2.
UPDATE build_settings SET max_concurrent = 4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1 AND max_concurrent < 4;
