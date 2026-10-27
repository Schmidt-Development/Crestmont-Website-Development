-- Sales & finance (area C): quote version binding for proposal links, acceptance by user,
-- refund decision records, and reporting indexes.

-- A proposal link is bound to the exact version that was sent; a later version supersedes it.
ALTER TABLE quote_access_tokens ADD COLUMN quote_version_id TEXT REFERENCES quote_versions(id);

ALTER TABLE quote_versions ADD COLUMN package_id TEXT;              -- starter|business|premium|custom
ALTER TABLE quote_versions ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE quote_versions ADD COLUMN accepted_by_user_id TEXT REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN sent_at TEXT;

-- Founder decision notes, issue time and failure reason (§24 record keeping).
ALTER TABLE refunds ADD COLUMN decision_notes TEXT;
ALTER TABLE refunds ADD COLUMN issued_at TEXT;
ALTER TABLE refunds ADD COLUMN failure_reason TEXT;

CREATE INDEX idx_orders_lead ON orders(lead_id);
CREATE INDEX idx_orders_org ON orders(organization_id, created_at);
CREATE INDEX idx_invoices_org ON invoices(organization_id, status);
CREATE INDEX idx_payments_created ON payments(created_at);
CREATE INDEX idx_refunds_status ON refunds(status, created_at);
CREATE INDEX idx_quotes_lead ON quotes(lead_id);
CREATE INDEX idx_project_costs_project ON project_costs(project_id);
