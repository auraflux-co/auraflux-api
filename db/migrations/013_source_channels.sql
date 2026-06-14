-- Migration 013: source_channels JSONB on client_plans (CPD-292)
--
-- Stores per-customer default source channel handles so the source library
-- picker can pre-fill them without the user typing them every time.
--
-- Shape: { "twitchLogin": "streamer", "kickUsername": "streamer", "youtubeHandle": "@channel" }

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS source_channels JSONB NOT NULL DEFAULT '{}';
