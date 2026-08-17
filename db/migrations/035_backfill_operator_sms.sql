-- 035_backfill_operator_sms.sql
-- Copy Slack-thread inbound history into SMS Inbox (operator 437/571 texts
-- were posted to Slack before brand_sms_inbox persisted those lines).

INSERT INTO brand_sms_inbox (brand_id, from_number, to_number, body, received_at)
SELECT
  (
    SELECT id FROM brands
     WHERE telnyx_number = t.to_number
        OR regexp_replace(COALESCE(telnyx_number, ''), '\D', '', 'g')
         = regexp_replace(t.to_number, '\D', '', 'g')
     LIMIT 1
  ),
  t.from_number,
  t.to_number,
  t.last_inbound,
  t.created_at
FROM slack_sms_threads t
WHERE COALESCE(t.last_inbound, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM brand_sms_inbox i
     WHERE i.from_number = t.from_number
       AND i.to_number = t.to_number
       AND i.body = t.last_inbound
  );

INSERT INTO schema_migrations (version)
VALUES ('035_backfill_operator_sms')
ON CONFLICT DO NOTHING;
