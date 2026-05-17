'use strict';
/**
 * lib/active_jobs.js — shared registry for in-flight portal-pipeline jobs (CPD-266).
 *
 * Imported by both developer_api.js (to register/unregister) and server.js
 * (to wait for all jobs before graceful shutdown). Using a separate module avoids
 * the circular dependency that would occur if developer_api.js imported server.js.
 *
 * Lifecycle:
 *   1. developer_api.js calls registerPipelineJob(jobId) when the setImmediate
 *      async pipeline starts.
 *   2. Each code path (success, failure, unhandled error) calls
 *      unregisterPipelineJob(jobId) in a finally block.
 *   3. gracefulShutdown() in server.js calls getActivePipelineJobs() and waits
 *      for all in-flight jobs to complete before exiting.
 */

const activePipelineJobs = new Map(); // jobId → { resolve, done }

/**
 * Register a pipeline job. Returns a resolve function the caller must invoke
 * when the job finishes (pass/fail/error).
 */
function registerPipelineJob(jobId) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  activePipelineJobs.set(jobId, { resolve, done });
  return resolve;
}

/**
 * Unregister a pipeline job, resolving its done Promise so shutdown can proceed.
 * Safe to call multiple times (idempotent).
 */
function unregisterPipelineJob(jobId) {
  const entry = activePipelineJobs.get(jobId);
  if (entry) {
    entry.resolve();
    activePipelineJobs.delete(jobId);
  }
}

/** Returns the live Map for inspection / waiting. */
function getActivePipelineJobs() {
  return activePipelineJobs;
}

module.exports = { registerPipelineJob, unregisterPipelineJob, getActivePipelineJobs };
