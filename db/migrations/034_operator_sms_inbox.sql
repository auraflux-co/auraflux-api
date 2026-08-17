-- 034_operator_sms_inbox.sql
-- Allow inbound SMS on operator lines (437/571) without a brand_id.
-- SMS Inbox previously INNER JOINed brands, so those messages never appeared.

ALTER TABLE brand_sms_inbox
  ALTER COLUMN brand_id DROP NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('034_operator_sms_inbox')
ON CONFLICT DO NOTHING;
