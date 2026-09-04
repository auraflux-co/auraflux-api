-- Migration 037: Better Auth 1.7+ requires account.issuer for OAuth account linking.
-- Maps to logical field `issuer` (snake_case column matches migration 036 style).

ALTER TABLE account
  ADD COLUMN IF NOT EXISTS issuer TEXT;

-- Backfill existing rows (credential / legacy) so unique lookups don't see NULL issuer.
UPDATE account
SET issuer = CASE
  WHEN provider_id = 'google' THEN 'https://accounts.google.com'
  WHEN provider_id = 'credential' THEN 'credential'
  ELSE provider_id
END
WHERE issuer IS NULL OR issuer = '';

ALTER TABLE account
  ALTER COLUMN issuer SET NOT NULL;

CREATE INDEX IF NOT EXISTS account_issuer_account_id_idx
  ON account (issuer, account_id);

INSERT INTO schema_migrations (version) VALUES ('037_better_auth_account_issuer')
  ON CONFLICT DO NOTHING;
