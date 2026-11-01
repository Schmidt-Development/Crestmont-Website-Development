-- Outbound sales closeout (2026-11-01).
--
-- 1. Purchase link → order → sales lead. A buyer who reaches checkout through an AI sales purchase link (/buy/:token) is
--    bound to the CRM lead the link was issued for, whatever email they sign in with; the order created is recorded on
--    the link so check_payment_status, the outcome resolver and the SIE attribute the payment to the right opportunity.
ALTER TABLE sales_checkout_links ADD COLUMN order_id TEXT REFERENCES orders(id);
CREATE INDEX idx_sales_checkout_links_order ON sales_checkout_links(order_id) WHERE order_id IS NOT NULL;

-- 2. A Retell call that ends with invalid_destination marks the researched number as invalid: no further sales call is
--    queued to it until staff verify a new number (sales-outbound.ts gateFor).
ALTER TABLE research_prospects ADD COLUMN phone_status TEXT CHECK (phone_status IS NULL OR phone_status IN ('invalid'));

-- 3. Self-Improvement Engine: a prompt written by the Founder directly in Retell (e.g. "Single Prompt V17") is adopted as
--    an 'external' version — stored verbatim, never re-composed with the protected policy and never overwritten by an
--    older SIE version (deploy refuses while the live prompt is one the engine did not deploy or adopt).
ALTER TABLE so_versions ADD COLUMN prompt_mode TEXT NOT NULL DEFAULT 'composed' CHECK (prompt_mode IN ('composed','external'));
