-- Migration 023: Add intro/outro card URLs to brands table (CPD intro/outro cards)
-- Stores R2 URLs for pre-rendered branded MP4 cards prepended/appended in assembly.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS intro_card_url TEXT,
  ADD COLUMN IF NOT EXISTS outro_card_url TEXT;
