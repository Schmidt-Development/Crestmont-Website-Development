-- Amazon SES as a second email provider next to Resend (src/adapters/ses.ts; EMAIL_PROVIDER = "ses").
--
-- email_messages.provider records which provider a delivery was queued for, so the retry job and the staff retry
-- button use the same provider again. Its CHECK allowed only 'resend' and 'dev-outbox'; SQLite cannot widen a CHECK,
-- so the table is rebuilt once with 'ses' added. Every existing row is copied unchanged. Nothing references this table.
--
-- SES delivery events (SNS -> /api/webhooks/ses) reuse email_webhook_events for exactly-once processing: the SNS
-- MessageId is stored as "sns:<MessageId>" in its svix_id key column, and email_deliveries.provider_message_id holds
-- the SES MessageId the same way it holds Resend's email id. Neither table needs a schema change.

PRAGMA defer_foreign_keys = true;

CREATE TABLE email_messages_v2 (
  delivery_id TEXT PRIMARY KEY REFERENCES email_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('resend','ses','dev-outbox')),
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL
);
INSERT INTO email_messages_v2 (delivery_id, provider, subject, html_body, text_body)
SELECT delivery_id, provider, subject, html_body, text_body FROM email_messages;
DROP TABLE email_messages;
ALTER TABLE email_messages_v2 RENAME TO email_messages;
