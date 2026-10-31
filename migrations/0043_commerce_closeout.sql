-- Commerce & sales closeout (CREST-GAP-006, CREST-GAP-036).
--
-- CREST-GAP-006: exactly one project per order. provisionProjectOnce() inserts with INSERT OR IGNORE against this
-- index, so a retried or concurrent provisioning can never create a second project for the same paid order.
-- (Before this index the check-then-insert in provisionProject could race.) If an environment already holds two
-- projects for one order this statement fails and the duplicate must be reviewed by hand; it is never auto-deleted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_order ON projects(order_id) WHERE order_id IS NOT NULL;

-- CREST-GAP-036: lookup of an organization's open package order (reused by a repeat checkout).
CREATE INDEX IF NOT EXISTS idx_orders_open_package ON orders(organization_id, product_id) WHERE kind = 'package' AND status = 'pending_payment';

-- CREST-GAP-006 repair sweep: paid invoices by order.
CREATE INDEX IF NOT EXISTS idx_invoices_order_status ON invoices(order_id, status);
