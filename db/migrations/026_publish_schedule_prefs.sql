-- CPD-594: Per-platform saved publish schedule preferences
-- Stored as JSONB on client_plans alongside existing source_channels / voice_profile.
-- Shape: { "youtube": [{"day": 4, "time": "15:00"}], "tiktok": [...], "instagram": [...] }
-- day values: 0=Sun … 6=Sat, -1=daily

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS publish_schedule_prefs JSONB DEFAULT '{}'::jsonb;
