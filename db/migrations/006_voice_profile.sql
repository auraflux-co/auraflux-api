-- Voice profile per customer — CPD-77
-- Stores recommended HeyGen voice IDs + characteristics for a client.

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS voice_profile JSONB;

COMMENT ON COLUMN client_plans.voice_profile IS
  'Customer voice profile: { selectedVoiceId, recommendations: [{ voiceId, matchScore, description }], characteristics, updatedAt }';
