-- Migration 016: Fix jobs stuck in 'pending' status due to createJobSpec calling saveJob
-- before upsertJobRow could set status='queued'.
-- createJobSpec (lib/job_spec.js) calls saveJob({ status: 'pending' }) at creation time.
-- upsertJobRow ON CONFLICT did not overwrite status, leaving fresh jobs at 'pending'.
-- These jobs never appeared on any page (not in ACTIVE_STATUSES or COMPLETE_STATUSES).
-- Fix: upgrade 'pending'+'fetch' stage jobs that have a job_spec (C1 jobs) to 'queued'.

UPDATE jobs
SET    status = 'queued',
       stage  = 'queued'
WHERE  status = 'pending'
  AND  stage  = 'fetch'
  AND  job_spec IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('016_fix_pending_job_status');
