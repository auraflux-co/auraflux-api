-- 046_publish_results_request_id.sql
-- Persist Upload-Post request_id so Creator Stats can fetch per-post analytics.

ALTER TABLE publish_results
  ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_publish_results_request_id
  ON publish_results (request_id)
  WHERE request_id IS NOT NULL;
