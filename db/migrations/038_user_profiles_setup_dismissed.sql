-- CPD-1330: persist setup checklist dismiss without Clerk publicMetadata
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS setup_dismissed BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version) VALUES ('038_user_profiles_setup_dismissed')
  ON CONFLICT DO NOTHING;
