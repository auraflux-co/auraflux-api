'use strict';
/**
 * lib/portals/portal_twelvelabs_qa.js — Twelve Labs Pegasus video QA extension (CPD-431)
 *
 * Fires as an extension after portal4 (assembly complete, R2 URL available).
 * Sends the output video URL to Twelve Labs Pegasus 1.2 for automated quality
 * analysis: visual, audio, production, and content quality scored 0-100.
 *
 * Result is stored in jobSpec.state.savedOutputs.twelveLabsQA — never blocks
 * delivery. If the API key is absent or the request fails, the job continues.
 *
 * Intercept: after portal4 (requires r2VideoUrl in savedOutputs)
 * Activation: always ordered (twelve_labs_qa_ext.ordered = true in job_spec.js)
 *   — self-skips gracefully if TWELVE_LABS_API_KEY is not set
 *
 * Jira: CPD-431
 */

const { analyzeVideo } = require('../services/twelve_labs_qa');
const { logError }     = require('../error_logger');

function _now() { return new Date().toISOString(); }

/**
 * runWorker — called by portal_policy_runner after portal4 passes.
 *
 * @param {object} opts
 * @param {object} opts.jobSpec       — full job spec with state.savedOutputs.r2VideoUrl
 * @param {number} opts.workerAttempt — attempt index (1-based)
 * @returns {Promise<{passed, outcome, reason, savedOutputs}>}
 */
async function runWorker({ jobSpec, workerAttempt = 1 }) {
  const jobId = jobSpec?.jobId || 'unknown';
  console.log(`[twelvelabs_qa:${jobId}] attempt=${workerAttempt} — starting Twelve Labs QA`);

  if (!jobSpec?.extensions?.twelvelabs_qa_ext?.ordered) {
    console.log(`[twelvelabs_qa:${jobId}] not ordered in extensions — skipping`);
    return {
      passed:  true,
      outcome: 'skipped',
      reason:  'twelvelabs_qa_ext not ordered for this job',
    };
  }

  if (!process.env.TWELVE_LABS_API_KEY) {
    console.warn(`[twelvelabs_qa:${jobId}] TWELVE_LABS_API_KEY not set — skipping (add key to enable)`);
    return {
      passed:  true,
      outcome: 'skipped',
      reason:  'TWELVE_LABS_API_KEY not configured',
    };
  }

  const videoUrl = jobSpec?.state?.savedOutputs?.r2VideoUrl ||
                   jobSpec?.r2VideoUrl ||
                   null;

  if (!videoUrl) {
    console.warn(`[twelvelabs_qa:${jobId}] No r2VideoUrl in savedOutputs — skipping`);
    return {
      passed:  true,
      outcome: 'skipped',
      reason:  'No r2VideoUrl available for Twelve Labs analysis',
    };
  }

  try {
    console.log(`[twelvelabs_qa:${jobId}] Sending to Pegasus: ${videoUrl.slice(0, 80)}...`);
    const qa = await analyzeVideo(videoUrl, jobId);

    if (!qa) {
      console.warn(`[twelvelabs_qa:${jobId}] No QA result returned — non-blocking pass`);
      return {
        passed:  true,
        outcome: 'skipped',
        reason:  'Twelve Labs returned no result (timeout or parse error)',
      };
    }

    // Store result — downstream readers can check jobSpec.state.savedOutputs.twelveLabsQA
    if (!jobSpec.state) jobSpec.state = {};
    if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
    jobSpec.state.savedOutputs.twelveLabsQA = {
      score:            qa.score,
      pass:             qa.pass,
      visual_score:     qa.visual_score,
      audio_score:      qa.audio_score,
      production_score: qa.production_score,
      content_score:    qa.content_score,
      issues:           qa.issues || [],
      summary:          qa.summary || '',
      analyzedAt:       _now(),
    };

    const issues = qa.issues?.length ? `issues: ${qa.issues.join('; ')}` : 'no issues';
    console.log(`[twelvelabs_qa:${jobId}] score=${qa.score} pass=${qa.pass} — ${issues}`);

    // Extension is always non-blocking — a low score is surfaced for operator review
    // but does not hard-stop the job. Operators review via savedOutputs.twelveLabsQA.
    return {
      passed:       true,
      outcome:      qa.pass ? 'compliant' : 'operator_review',
      reason:       qa.pass
        ? `Twelve Labs QA passed (score ${qa.score}/100)`
        : `Twelve Labs QA flagged for review (score ${qa.score}/100): ${(qa.issues || []).slice(0, 3).join('; ')}`,
      savedOutputs: { twelveLabsQA: jobSpec.state.savedOutputs.twelveLabsQA },
    };
  } catch (err) {
    logError(jobSpec, 'twelvelabs_qa', err);
    console.warn(`[twelvelabs_qa:${jobId}] unexpected error — ${err.message} — non-blocking pass`);
    return {
      passed:  true,
      outcome: 'skipped',
      reason:  `Twelve Labs QA error (non-blocking): ${err.message}`,
    };
  }
}

/**
 * isPass — always true; extension stores result for operators but never blocks delivery.
 */
function isPass(result) {
  return result?.passed !== false;
}

module.exports = { runWorker, isPass };
