-- FD-38 (Founder decision, 2026-11): raw IP addresses are kept 90 days and identifiable security logs 180 days,
-- provisionally, subject to lawful exceptions and final privacy review. Periods take effect when the Owner applies
-- them on /staff/ops/retention (src/services/retention.ts); legal holds still pause them.
--
-- audit_logs stays append-only. The single permitted change is clearing a stored IP address after the retention
-- period: every other column must be unchanged, and an IP can only become NULL (never be set or altered).
-- agreement_acceptances.ip is NOT cleared: it is part of the acceptance evidence kept for the contract.

DROP TRIGGER audit_logs_no_update;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  WHEN NOT (
    OLD.ip IS NOT NULL AND NEW.ip IS NULL
    AND NEW.id IS OLD.id AND NEW.actor_user_id IS OLD.actor_user_id AND NEW.actor_kind IS OLD.actor_kind
    AND NEW.action IS OLD.action AND NEW.subject_type IS OLD.subject_type AND NEW.subject_id IS OLD.subject_id
    AND NEW.organization_id IS OLD.organization_id AND NEW.details_json IS OLD.details_json AND NEW.created_at IS OLD.created_at
  )
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- FD-14 (Founder decision, 2026-11): the customer has five business days for each requested review. respond_by is the
-- end of the fifth business day (Monday–Friday, America/New_York) after the request. FD-15: when it passes nothing is
-- approved; the customer is reminded once and the project team is told (overdue_notified_at).
ALTER TABLE approval_requests ADD COLUMN respond_by TEXT;
ALTER TABLE approval_requests ADD COLUMN overdue_notified_at TEXT;
