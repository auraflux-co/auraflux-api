-- API invite gate: approval flag for developer API key creation.
-- Rob sets api_access = 'approved' (or Clerk publicMetadata.apiAccess) after review.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS api_access TEXT;

COMMENT ON COLUMN user_profiles.api_access IS
  'Developer API invite status. Create keys only when value is approved.';
