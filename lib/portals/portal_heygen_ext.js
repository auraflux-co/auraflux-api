'use strict';
/**
 * lib/portals/portal_heygen_ext.js — HeyGen Avatar Portal Extension (CPD-68)
 *
 * This is the C1+ portal extension worker for HeyGen avatar rendering.
 * It fires between Portal 1 (Script QA) and Portal 2 (Render Quality) when the job
 * spec declares `addOns.heygen.active: true` (i.e. extensions.heygen_ext.ordered: true).
 *
 * Distinction from lib/routes/heygen.js:
 *   lib/routes/heygen.js      — C0-only utility routes (refresh IDs, fetch URLs) for the dashboard
 *   lib/portals/portal_heygen_ext.js — C1+ extension worker called by runPortalSequence()
 *
 * Output contract:
 *   { passed, outcome, segmentIds, segmentCount, avatarId, voiceId, submittedAt }
 */

const { logError } = require('../error_logger');
const { isFeatureEnabled } = require('../services/feature_gate');

/**
 * Run the HeyGen extension worker for a job.
 *
 * Submits each script scene to HeyGen as an avatar video segment.
 * Returns immediately after submission (the HeyGen poller watches for completion).
 *
 * @param {Object} params
 * @param {Object} params.jobSpec — job spec with addOns.heygen and designSpec.voice
 * @returns {Promise<Object>} output contract
 */
async function runWorker({ jobSpec } = {}) {
  const jobId    = jobSpec?.jobId || 'unknown';
  const planTier = jobSpec?.planTier || 'diy';

  // Plan check: avatar.heygen requires dfy+
  if (!isFeatureEnabled('avatar.heygen', planTier)) {
    return {
      passed:       false,
      outcome:      'skip',
      reason:       `avatar.heygen not available on plan tier: ${planTier}`,
      segmentIds:   [],
      segmentCount: 0,
      avatarId:     null,
      voiceId:      null,
      submittedAt:  null,
    };
  }

  const avatarId =
    jobSpec?.extensions?.heygen_ext?.avatarId ||
    jobSpec?.addOns?.heygen?.avatarId ||
    jobSpec?.designSpec?.voice?.avatarId ||
    null;
  const voiceId =
    jobSpec?.extensions?.heygen_ext?.voiceId ||
    jobSpec?.addOns?.heygen?.voiceId ||
    jobSpec?.designSpec?.voice?.heygenVoiceId ||
    null;

  if (!jobSpec?.addOns?.heygen?.active && !jobSpec?.extensions?.heygen_ext?.ordered) {
    return {
      passed: false,
      outcome: 'skip',
      reason: 'HeyGen extension not ordered for this job — check addOns.heygen.active',
      segmentIds: [],
      segmentCount: 0,
    };
  }

  if (!avatarId) {
    logError('HEYGEN_EXT_NO_AVATAR_ID', new Error('avatarId not set'), { jobId });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: 'avatarId not configured — set in addOns.heygen.avatarId or designSpec.voice.avatarId',
      segmentIds: [],
      segmentCount: 0,
    };
  }

  const script = jobSpec?.script?.raw || jobSpec?.script || null;
  if (!script) {
    logError('HEYGEN_EXT_NO_SCRIPT', new Error('script not ready'), { jobId });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: 'Script not available — Portal 1 must mark compliant before HeyGen extension runs',
      segmentIds: [],
      segmentCount: 0,
    };
  }

  // Determine scenes from the job spec scaffold or fall back to the whole script as one scene.
  const scenes =
    jobSpec?.designSpec?.sceneStructure?.items ||
    jobSpec?.designSpec?.sceneStructure?.scenes ||
    [{ script, label: 'scene_1' }];

  let heygenService;
  try {
    heygenService = require('../services/heygen');
  } catch (e) {
    logError('HEYGEN_EXT_SERVICE_UNAVAILABLE', e, { jobId });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: `HeyGen service unavailable: ${e.message}`,
      segmentIds: [],
      segmentCount: 0,
    };
  }

  const segmentIds = [];
  const submittedAt = new Date().toISOString();

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneScript = scene.script || scene.filledScript || script;
      const { video_id: videoId } = await heygenService.generateVideo({
        avatarId,
        voiceId,
        script: sceneScript,
        label: scene.label || `scene_${i + 1}`,
        jobId,
        sceneIndex: i,
      });
      segmentIds.push(videoId);
    }
  } catch (e) {
    logError('HEYGEN_EXT_SUBMIT_FAIL', e, { jobId, segmentsSoFar: segmentIds.length });
    return {
      passed: false,
      outcome: 'hard_fail',
      reason: `HeyGen submission failed: ${e.message}`,
      segmentIds,
      segmentCount: segmentIds.length,
    };
  }

  return {
    passed: true,
    outcome: 'submitted',
    segmentIds,
    segmentCount: segmentIds.length,
    avatarId,
    voiceId,
    submittedAt,
    note: 'HeyGen segments submitted — heygen_poller will track completion before Portal 2 runs',
  };
}

/**
 * isPass check — submitted means HeyGen accepted all segments.
 */
function isPass(result) {
  return result?.passed === true && result?.outcome === 'submitted';
}

module.exports = { runWorker, isPass };
