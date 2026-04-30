'use strict';
/**
 * lib/gates/gate5.js — Portal 5: Upload Confirmation (Code Only, No AI)
 *
 * Binary result. Only fires if gate4.uploadSignal === true.
 * Runs pre-publish validator, uploads to Upload-Post, polls for job_id per platform.
 * One platform failure retries that platform only (max 3 retries).
 *
 * Output contract:
 * {
 *   portal: 5,
 *   jobId: string,
 *   passed: boolean,
 *   platforms: {
 *     youtube:   { attempted, jobId, failed, failReason },
 *     tiktok:    { attempted, jobId, failed, failReason },
 *     instagram: { attempted, jobId, failed, failReason }
 *   },
 *   prePublishValidation: { passed: boolean, violations: [] },
 *   completedAt: ISO-8601
 * }
 */

const axios = require('axios');
const { logError } = require('../error_logger');
const { nrPipelineEvent } = require('../nr_pipeline');
const pipelineBus = require('../pipeline_events');
const { recordWhyLedger, INTERVENTION, FAILURE_CLASS } = require('../why_ledger');

// ─── Pre-publish constraints ──────────────────────────────────────────────────

const PLATFORM_RULES = {
  youtube: {
    maxTitleChars: 100,
    maxDescBytes: 5000,
    maxTagsTotalChars: 500,
    requiresCategoryId: true,
    supportsScheduling: true,
    scheduledRequiresPrivate: true,
  },
  tiktok: {
    maxCaptionRunes: 2200,
    supportsScheduling: false,
  },
  instagram: {
    maxCaptionChars: 2200,
    maxHashtags: 30,
    maxMentions: 20,
    validMediaTypes: ['REELS', 'STORIES'],
  },
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const RETRY_DELAY_MAX_MS = 30000; // cap exponential backoff at 30s — CPD-39
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 120000; // 2 minutes max poll per platform

// ─── Pre-publish validator ────────────────────────────────────────────────────

/**
 * Count UTF-16 runes (code units) in a string (for TikTok caption limit).
 */
function countRunes(str) {
  if (!str) return 0;
  return [...str].length; // Spread handles surrogate pairs correctly
}

/**
 * Count bytes in a string (for YouTube description limit).
 */
function byteLength(str) {
  if (!str) return 0;
  return Buffer.byteLength(str, 'utf8');
}

/**
 * Validate publish metadata per platform.
 * Corrects where possible; returns violations that cannot be auto-corrected.
 * @param {Object} metadata - { title, description, tags, categoryId, scheduledAt, platforms, mediaType, caption }
 * @returns {{ passed: boolean, violations: string[], corrected: Object }}
 */
function validatePrePublish(metadata) {
  const violations = [];
  const corrected = { ...metadata };
  const platforms = metadata.platforms || [];

  if (platforms.includes('youtube')) {
    const rules = PLATFORM_RULES.youtube;

    // Title
    if (!metadata.title || metadata.title.length === 0) {
      violations.push('YouTube: title is required');
    } else {
      // Strip illegal chars
      const cleanTitle = metadata.title.replace(/[<>]/g, '');
      if (cleanTitle !== metadata.title) corrected.title = cleanTitle;
      if (corrected.title.length > rules.maxTitleChars) {
        violations.push(
          `YouTube: title exceeds ${rules.maxTitleChars} chars (${corrected.title.length})`
        );
      }
    }

    // Description
    if (metadata.description) {
      const descBytes = byteLength(metadata.description);
      if (descBytes > rules.maxDescBytes) {
        violations.push(`YouTube: description exceeds ${rules.maxDescBytes} bytes (${descBytes})`);
      }
    }

    // Tags
    if (metadata.tags && Array.isArray(metadata.tags)) {
      const tagsJoined = metadata.tags.join('');
      if (tagsJoined.length > rules.maxTagsTotalChars) {
        violations.push(
          `YouTube: combined tag length ${tagsJoined.length} exceeds ${rules.maxTagsTotalChars} chars`
        );
      }
    }

    // Category ID
    if (rules.requiresCategoryId && !metadata.categoryId) {
      // Default to 24 (Entertainment) if missing
      corrected.categoryId = '24';
    }

    // Scheduling
    if (metadata.scheduledAt) {
      const scheduledDate = new Date(metadata.scheduledAt);
      if (scheduledDate <= new Date()) {
        violations.push('YouTube: scheduledAt must be a future date');
      }
      if (rules.scheduledRequiresPrivate && metadata.privacyStatus !== 'private') {
        corrected.privacyStatus = 'private';
      }
    }
  }

  if (platforms.includes('tiktok')) {
    const rules = PLATFORM_RULES.tiktok;

    // Caption rune count
    const caption = metadata.caption || metadata.description || '';
    const runeCount = countRunes(caption);
    if (runeCount > rules.maxCaptionRunes) {
      violations.push(
        `TikTok: caption ${runeCount} runes exceeds ${rules.maxCaptionRunes} rune limit`
      );
    }

    // No scheduling
    if (metadata.scheduledAt && !rules.supportsScheduling) {
      // Remove scheduledAt for TikTok — not a violation, just strip it
      corrected.tiktokScheduledAt = null;
    }
  }

  if (platforms.includes('instagram')) {
    const rules = PLATFORM_RULES.instagram;

    // Caption length
    const caption = metadata.caption || metadata.description || '';
    if (caption.length > rules.maxCaptionChars) {
      violations.push(
        `Instagram: caption ${caption.length} chars exceeds ${rules.maxCaptionChars} char limit`
      );
    }

    // Hashtags
    const hashtags = caption.match(/#\w+/g) || [];
    if (hashtags.length > rules.maxHashtags) {
      violations.push(`Instagram: ${hashtags.length} hashtags exceeds ${rules.maxHashtags} limit`);
    }

    // Mentions
    const mentions = caption.match(/@\w+/g) || [];
    if (mentions.length > rules.maxMentions) {
      violations.push(`Instagram: ${mentions.length} mentions exceeds ${rules.maxMentions} limit`);
    }

    // Media type
    const mediaType = metadata.mediaType || 'REELS';
    if (!rules.validMediaTypes.includes(mediaType)) {
      violations.push(
        `Instagram: mediaType "${mediaType}" not valid — must be one of: ${rules.validMediaTypes.join(', ')}`
      );
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    corrected,
  };
}

// ─── Upload-Post API helper ───────────────────────────────────────────────────

const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE; // global fallback for C0
const UPLOADPOST_BASE_URL = 'https://api.upload-post.com/api';
const FormData = require('form-data');

/**
 * Resolve the Upload-Post profile for a job.
 * Priority: jobSpec.publishConfig.uploadPostProfile → jobSpec.deliverySpec.uploadPostProfile → UPLOADPOST_PROFILE env.
 * This allows each C1+ customer to publish to their own connected social accounts.
 *
 * @param {Object} jobSpec
 * @returns {string|null}
 */
function resolveUploadPostProfile(jobSpec) {
  return (
    jobSpec?.publishConfig?.uploadPostProfile ||
    jobSpec?.deliverySpec?.uploadPostProfile ||
    process.env.UPLOADPOST_PROFILE ||  // read dynamically so tests can override after module load
    null
  );
}

/**
 * Submit an upload request to Upload-Post for a single platform.
 * Uses multipart form-data matching lib/publish.js — the proven working format.
 * Returns { requestId } or throws.
 */
async function submitUpload(platform, driveUrl, metadata, corrected, pipelineJobId = null, profile = null) {
  const resolvedProfile = profile || UPLOADPOST_PROFILE;
  if (!UPLOADPOST_API_KEY) throw new Error('UPLOADPOST_API_KEY not set');
  if (!resolvedProfile) throw new Error('UPLOADPOST_PROFILE not set (no per-customer publishConfig.uploadPostProfile and no UPLOADPOST_PROFILE env)');

  const title = corrected.title || metadata.title;
  const description = corrected.description || metadata.description || '';
  const tags = corrected.tags || metadata.tags || [];
  const privacyStatus = corrected.privacyStatus || metadata.privacyStatus || 'private';

  const form = new FormData();
  form.append('user', resolvedProfile);
  form.append('video', driveUrl);
  form.append('title', title);
  if (description) form.append('description', description);
  form.append('platform[]', platform);
  form.append('async_upload', 'true');

  if (platform === 'youtube') {
    form.append('youtube_title', title);
    form.append('youtube_description', description || title);
    if (tags.length) tags.forEach((t) => form.append('tags[]', t));
    form.append('privacyStatus', privacyStatus);
    form.append('categoryId', corrected.categoryId || metadata.categoryId || '24');
    form.append('containsSyntheticMedia', 'true');
    form.append('madeForKids', 'false');
    if (metadata.thumbnailUrl) form.append('thumbnail_url', metadata.thumbnailUrl);
    if (metadata.pinnedComment) form.append('first_comment', metadata.pinnedComment);
  }

  if (platform === 'tiktok') {
    form.append('tiktok_title', (corrected.caption || description || title).substring(0, 90));
    form.append('privacy_level', 'PUBLIC_TO_EVERYONE');
    form.append('post_mode', 'DIRECT_POST');
    form.append('is_aigc', 'true');
    form.append('brand_content_toggle', 'false');
  }

  if (platform === 'instagram') {
    form.append('media_type', 'REELS');
    form.append('instagram_title', corrected.caption || description || title);
  }

  const response = await axios.post(`${UPLOADPOST_BASE_URL}/upload`, form, {
    headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}`, ...form.getHeaders() },
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  const requestId = response.data?.request_id || response.data?.requestId || response.data?.id;
  if (!requestId)
    throw new Error(`No request_id returned from Upload-Post: ${JSON.stringify(response.data)}`);
  try {
    nrPipelineEvent('UploadPostApiSubmitOk', {
      pipelineStage: 'upload_post',
      source: 'portal5',
      platform,
      requestId: String(requestId),
      jobId: pipelineJobId,
    });
  } catch (_e) {
    /* non-fatal */
  }
  return { requestId };
}

/**
 * Poll Upload-Post status until job_id confirmed or timeout.
 * Returns { jobId } or throws.
 */
async function pollForJobId(requestId, platform, pipelineJobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollAttempt = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    pollAttempt++;

    try {
      const response = await axios.get(`${UPLOADPOST_BASE_URL}/status`, {
        params: { request_id: requestId },
        headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}` },
        timeout: 15000,
      });

      const status = response.data?.status;
      const platformJobId = response.data?.job_id || response.data?.jobId;

      try {
        pipelineBus.emit('publish:poll_tick', {
          jobId: pipelineJobId,
          source: 'portal5',
          platform,
          request_id: String(requestId),
          attempt: pollAttempt,
          uploadPostStatus: status || null,
        });
      } catch (_e) {
        /* non-fatal */
      }

      if (status === 'completed' && platformJobId) {
        try {
          pipelineBus.emit('publish:platform_done', {
            jobId: pipelineJobId,
            platform,
            request_id: String(requestId),
            outcome: 'completed',
            platformJobId: String(platformJobId),
          });
        } catch (_e2) {
          /* non-fatal */
        }
        return { jobId: platformJobId };
      }
      if (status === 'failed') {
        const errMsg = response.data?.error || 'unknown error';
        try {
          pipelineBus.emit('publish:platform_done', {
            jobId: pipelineJobId,
            platform,
            request_id: String(requestId),
            outcome: 'failed',
            reason: String(errMsg).slice(0, 300),
          });
        } catch (_e3) {
          /* non-fatal */
        }
        throw new Error(`Upload-Post reported failure for ${platform}: ${errMsg}`);
      }
      // status === 'pending' or 'processing' — continue polling
    } catch (err) {
      if (err.message?.includes('Upload-Post reported failure')) throw err;
      // Network errors during poll — log and retry
      logError('PORTAL5_POLL_ERROR', err, { platform, requestId });
      try {
        pipelineBus.emit('publish:poll_tick', {
          jobId: pipelineJobId,
          source: 'portal5',
          platform,
          request_id: String(requestId),
          attempt: pollAttempt,
          uploadPostStatus: null,
          pollError: (err.message || '').slice(0, 240),
        });
      } catch (_e) {
        /* non-fatal */
      }
    }
  }

  try {
    pipelineBus.emit('publish:platform_done', {
      jobId: pipelineJobId,
      platform,
      request_id: String(requestId),
      outcome: 'timeout',
    });
  } catch (_e) {
    /* non-fatal */
  }
  throw new Error(
    `Poll timeout after ${POLL_TIMEOUT_MS / 1000}s for ${platform} request ${requestId}`
  );
}

/**
 * Upload to a single platform with retries.
 */
async function uploadWithRetries(platform, driveUrl, metadata, corrected, jobId, profile = null) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      try {
        pipelineBus.emit('pipeline:retry_attempt', {
          jobId,
          portal: 5,
          stage: `upload_post_${platform}`,
          attempt,
          maxAttempts: MAX_RETRIES,
        });
      } catch (_e) {
        /* non-fatal */
      }
      const { requestId } = await submitUpload(platform, driveUrl, metadata, corrected, jobId, profile);
      const { jobId: platformJobId } = await pollForJobId(requestId, platform, jobId);
      try {
        nrPipelineEvent('UploadPostPollComplete', {
          pipelineStage: 'upload_post',
          source: 'portal5',
          platform,
          requestId: String(requestId),
          uploadPostJobId: platformJobId || null,
          jobId,
        });
      } catch (_e) {
        /* non-fatal */
      }
      return { jobId: platformJobId, failed: false, failReason: null };
    } catch (err) {
      lastErr = err;
      logError('PORTAL5_UPLOAD_ATTEMPT_FAIL', err, { jobId, portal: 5, platform, attempt });
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, attempt - 1), RETRY_DELAY_MAX_MS);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  logError('PORTAL5_UPLOAD_EXHAUSTED', lastErr, { jobId, portal: 5, platform, attempts: MAX_RETRIES });
  try {
    nrPipelineEvent('UploadPostPlatformExhausted', {
      pipelineStage: 'upload_post',
      source: 'portal5',
      platform,
      jobId,
      attempts: MAX_RETRIES,
      error: lastErr && lastErr.message ? String(lastErr.message).slice(0, 500) : 'unknown',
    });
  } catch (_e) {
    /* non-fatal */
  }
  return { jobId: null, failed: true, failReason: lastErr.message };
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!UPLOADPOST_API_KEY) reasons.push('UPLOADPOST_API_KEY not set');
  // Profile check: per-customer publishConfig takes priority over global env var.
  if (!resolveUploadPostProfile(jobSpec)) reasons.push('No UPLOADPOST_PROFILE set (neither jobSpec.publishConfig.uploadPostProfile nor UPLOADPOST_PROFILE env)');

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) reasons.push('jobSpec.jobId missing');

  // driveUrl is only available AFTER assembly + Drive upload — not at pre-generate time.
  // Only check if we're being called at run() time (driveUrl will be in savedOutputs).
  // At pre-generate canProduce() check, driveUrl absence is expected and not a blocker.
  // R2 video URL (C1+) takes priority; driveUrl is the C0/legacy alias kept for backward compat.
  const driveUrl =
    jobSpec.r2VideoUrl || jobSpec.state?.savedOutputs?.r2VideoUrl ||
    jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  const isPreGenerate = !jobSpec.assembledPath && !driveUrl;
  if (!isPreGenerate && !driveUrl) {
    reasons.push('driveUrl missing from jobSpec — required for Upload-Post');
  }

  const platforms = jobSpec.deliverySpec?.platforms || jobSpec.order?.publish?.platforms || [];
  if (platforms.length === 0) reasons.push('No platforms specified in deliverySpec.platforms');

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ committed: string }}
 */
function commit(jobSpec) {
  const platforms = jobSpec?.deliverySpec?.platforms || jobSpec?.order?.publish?.platforms || [];
  const profile = resolveUploadPostProfile(jobSpec) || 'not configured';
  return {
    committed: `I will deliver to [${platforms.join(', ')}] as private drafts via Upload-Post profile '${profile}'. I confirm job_id per platform. Will NOT fire without gate4.uploadSignal === true.`,
    summary: `Deliver to ${platforms.join(', ')} as private drafts`,
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {Object} gate4Report
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, gate4Report) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  const platformTemplate = {
    attempted: false,
    jobId: null,
    failed: false,
    failReason: null,
  };

  const baseOutput = {
    portal: 5,
    jobId,
    passed: false,
    platforms: {
      youtube: { ...platformTemplate },
      tiktok: { ...platformTemplate },
      instagram: { ...platformTemplate },
    },
    prePublishValidation: { passed: false, violations: [] },
    completedAt: now(),
  };

  // ── HOLD: thumbnail approval still pending ───────────────────────────
  const thumbState = jobSpec.state?.thumbnail;
  if (thumbState && thumbState.status === 'pending') {
    const msg = `Portal 5 HOLD: thumbnail approval is pending for job ${jobId} — customer must approve via POST /jobs/${jobId}/thumbnail/approve`;
    console.warn(`[gate5] ${msg}`);
    try {
      pipelineBus.emit('thumbnail:awaiting_approval', { jobId, candidateCount: (thumbState.candidates || []).length });
    } catch (_e) { /* non-fatal */ }
    return {
      ...baseOutput,
      passed:  false,
      outcome: 'thumbnail_approval_pending',
      prePublishValidation: { passed: false, violations: [msg] },
      completedAt: now(),
    };
  }

  // ── HARD STOP: uploadSignal must be true ─────────────────────────────
  if (!gate4Report || gate4Report.uploadSignal !== true) {
    const reason = `Portal 5 HARD STOP: gate4.uploadSignal is not true — upload blocked. gate4.passed=${gate4Report?.passed}, gate4.uploadSignal=${gate4Report?.uploadSignal}`;
    logError('PORTAL5_HARD_STOP', new Error(reason), { jobId, portal: 5 });
    try {
      pipelineBus.emit('publish:failed_validation', {
        jobId,
        code: 'gate4_upload_signal',
        message: reason.slice(0, 500),
      });
    } catch (_e) {
      /* non-fatal */
    }
    try {
      recordWhyLedger({
        jobId,
        portal: 'portal5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: 'gate4_upload_signal_false',
        reasons: [reason.slice(0, 500)],
        failureClass: FAILURE_CLASS.SPEC_VIOLATION,
        interventionType: INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        source: 'lib/portals/portal5:run',
      });
    } catch (_w) {
      /* non-fatal */
    }
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: [reason] },
      completedAt: now(),
    };
  }

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Portal 5 not ready: ${readiness.reasons.join('; ')}`;
    logError('PORTAL5_NOT_READY', new Error(reason), { jobId, portal: 5 });
    try {
      pipelineBus.emit('publish:failed_validation', {
        jobId,
        code: 'gate5_not_ready',
        message: reason.slice(0, 500),
      });
    } catch (_e) {
      /* non-fatal */
    }
    try {
      recordWhyLedger({
        jobId,
        portal: 'portal5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: 'gate5_not_ready',
        reasons: readiness.reasons.slice(0, 12),
        failureClass: FAILURE_CLASS.SPEC_VIOLATION,
        interventionType: INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        source: 'lib/portals/portal5:run',
      });
    } catch (_w) {
      /* non-fatal */
    }
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: readiness.reasons },
      completedAt: now(),
    };
  }

  // R2 video URL (C1+) takes priority; driveUrl is the C0/legacy alias kept for backward compat.
  const driveUrl =
    jobSpec.r2VideoUrl || jobSpec.state?.savedOutputs?.r2VideoUrl ||
    jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  const platforms = jobSpec.deliverySpec?.platforms || jobSpec.order?.publish?.platforms || [];
  // Per-customer Upload-Post profile — C1+ customers carry their own in publishConfig.
  const uploadPostProfile = resolveUploadPostProfile(jobSpec);
  // Prefer approved thumbnail from the approval stage; fall back to legacy thumbnailDriveUrl
  const thumbnailUrl =
    (thumbState?.status === 'approved' ? thumbState.r2Url : null)
    || jobSpec?.state?.savedOutputs?.thumbnailDriveUrl
    || null;

  // Read publish copy from savedOutputs (set after Drive upload by assembly.js)
  const publishCopy = jobSpec.state?.savedOutputs?.publishCopy || jobSpec.order?.publish || {};
  const ytMeta = publishCopy.youtube || publishCopy.platforms?.youtube || publishCopy;

  const metadata = {
    title:
      ytMeta.title || ytMeta.titles?.[0] || jobSpec.order?.publish?.title || jobSpec.title || '',
    description: ytMeta.description || jobSpec.order?.publish?.description || '',
    tags: ytMeta.tags || ytMeta.hashtags || jobSpec.order?.publish?.tags || [],
    categoryId: jobSpec.deliverySpec?.categoryId || jobSpec.order?.publish?.categoryId || '24',
    privacyStatus:
      jobSpec.deliverySpec?.visibility || jobSpec.order?.publish?.privacyStatus || 'private',
    scheduledAt: jobSpec.deliverySpec?.scheduledAt || jobSpec.order?.publish?.scheduledAt || null,
    caption:
      publishCopy.tiktok?.caption || publishCopy.instagram?.caption || ytMeta.description || '',
    mediaType: jobSpec.order?.publish?.mediaType || 'REELS',
    platforms,
    thumbnailUrl,
    pinnedComment: ytMeta.pinnedComment || null,
  };

  // ── Pre-publish validation ─────────────────────────────────────────────
  const validation = validatePrePublish(metadata);

  if (!validation.passed) {
    logError(
      'PORTAL5_VALIDATION_FAIL',
      new Error(`Violations: ${validation.violations.join('; ')}`),
      { jobId, portal: 5, violations: validation.violations }
    );
    try {
      pipelineBus.emit('publish:failed_validation', {
        jobId,
        code: 'gate5_prepublish_validation',
        message: validation.violations.join('; ').slice(0, 500),
      });
    } catch (_e) {
      /* non-fatal */
    }
    try {
      recordWhyLedger({
        jobId,
        portal: 'portal5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: 'prepublish_validation_failed',
        reasons: validation.violations.slice(0, 20),
        failureClass: FAILURE_CLASS.SPEC_VIOLATION,
        interventionType: INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        source: 'lib/portals/portal5:run',
      });
    } catch (_w) {
      /* non-fatal */
    }
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: validation.violations },
      completedAt: now(),
    };
  }

  const corrected = validation.corrected;
  const platformResults = {
    youtube: { ...platformTemplate },
    tiktok: { ...platformTemplate },
    instagram: { ...platformTemplate },
  };

  // ── Upload per platform ───────────────────────────────────────────────
  for (const platform of platforms) {
    if (!['youtube', 'tiktok', 'instagram'].includes(platform)) {
      logError('PORTAL5_UNKNOWN_PLATFORM', new Error(`Unknown platform: ${platform}`), {
        jobId,
        portal: 5,
        platform,
      });
      platformResults[platform] = {
        attempted: false,
        jobId: null,
        failed: true,
        failReason: `Unknown platform: ${platform}`,
      };
      continue;
    }

    platformResults[platform].attempted = true;
    const result = await uploadWithRetries(platform, driveUrl, metadata, corrected, jobId, uploadPostProfile);
    platformResults[platform] = { attempted: true, ...result };
  }

  // ── Determine overall pass ────────────────────────────────────────────
  const attemptedResults = Object.values(platformResults).filter((r) => r.attempted);
  const anySuccess = attemptedResults.some((r) => !r.failed && r.jobId);
  const allFailed = platforms.length > 0 && attemptedResults.length > 0 && attemptedResults.every((r) => r.failed);
  const allSuccess = attemptedResults.length > 0 && attemptedResults.every((r) => !r.failed && r.jobId);
  // platformOutcome gives operators a precise signal: 'all_success' | 'partial_success' | 'all_failed' | 'no_platforms'
  const platformOutcome = allFailed
    ? 'all_failed'
    : allSuccess
      ? 'all_success'
      : anySuccess
        ? 'partial_success'
        : 'no_platforms';

  if (allFailed) {
    logError('PORTAL5_ALL_PLATFORMS_FAILED', new Error('All platform uploads failed'), {
      jobId,
      portal: 5,
      platformResults,
    });
    // CPD-39: self-healing trigger — surface to operator for manual retry
    try {
      pipelineBus.emit('publish:needs_intervention', {
        jobId,
        portal: 5,
        reason: 'all_platforms_failed',
        failedPlatforms: Object.entries(platformResults)
          .filter(([, r]) => r.attempted && r.failed)
          .map(([p, r]) => ({ platform: p, reason: r.failReason })),
      });
    } catch (_e) { /* non-fatal */ }
  }

  try {
    const summary = {};
    for (const p of platforms) {
      const r = platformResults[p];
      if (r) summary[p] = { attempted: !!r.attempted, failed: !!r.failed, hasJobId: !!r.jobId };
    }
    pipelineBus.emit('publish:all_done', {
      jobId,
      anySuccess,
      allFailed,
      platforms: summary,
    });
  } catch (_e) {
    /* non-fatal */
  }

  // ── Persist publish results to DB (fire-and-forget) ──────────────────
  try {
    const { savePublishResult, markJobPublished } = require('../db');
    for (const [platform, r] of Object.entries(platformResults)) {
      if (r.attempted) {
        savePublishResult(jobId, platform, {
          platformJobId: r.jobId,
          driveUrl,
          title: metadata.title,
          status: r.failed ? 'failed' : 'published',
        }).catch((e) => logError('PORTAL5_DB_PERSIST_FAIL', e, { jobId, portal: 5, platform }));
      }
    }
    if (anySuccess) markJobPublished(jobId, driveUrl).catch(() => {});
  } catch (e) {
    logError('PORTAL5_DB_PERSIST_FAIL', e, { jobId, portal: 5 });
  }

  // ── NR: VideoPublished event per platform ────────────────────────────
  try {
    if (typeof newrelic !== 'undefined') {
      const customerId = jobSpec.customerId || 'unknown';
      const contentType = jobSpec.contentType || 'unknown';
      Object.entries(platformResults).forEach(([platform, r]) => {
        if (r.attempted && !r.failed) {
          newrelic.recordCustomEvent('VideoPublished', {
            timestamp: Date.now(),
            jobId,
            customerId,
            contentType,
            platform,
            title: (metadata.title || '').slice(0, 100),
            platformJobId: r.jobId || null,
            driveUrl: driveUrl || null,
          });
        }
      });
    }
  } catch (e) {
    /* non-fatal */
  }

  return {
    portal: 5,
    jobId,
    passed: anySuccess,           // true if at least one platform published (pipeline continues)
    platformOutcome,              // 'all_success' | 'partial_success' | 'all_failed' | 'no_platforms'
    platforms: platformResults,
    prePublishValidation: { passed: true, violations: [] },
    completedAt: now(),
  };
}

// ─── prepare ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Pre-validate UPLOADPOST_API_KEY is set
    if (!UPLOADPOST_API_KEY) {
      console.warn(
        `[gate5] prepare() warning: UPLOADPOST_API_KEY not set — delivery will fail for job ${jobId}`
      );
    }

    // Pre-validate UPLOADPOST_PROFILE is set
    if (!UPLOADPOST_PROFILE) {
      console.warn(
        `[gate5] prepare() warning: UPLOADPOST_PROFILE not set — delivery will fail for job ${jobId}`
      );
    }

    // Pre-validate platforms list is non-empty — read from deliverySpec (correct path)
    const platforms = jobSpec?.deliverySpec?.platforms || jobSpec?.order?.publish?.platforms || [];
    if (platforms.length === 0) {
      console.warn(
        `[gate5] prepare() warning: no platforms in deliverySpec.platforms for job ${jobId}`
      );
    }

    // driveUrl not expected at pre-generate time — only warn if assembledPath exists (run time)
    const driveUrl =
      jobSpec?.r2VideoUrl || jobSpec?.state?.savedOutputs?.r2VideoUrl ||
      jobSpec?.driveUrl || jobSpec?.state?.savedOutputs?.driveUrl;
    const hasAssembled = !!jobSpec?.assembledPath;
    if (hasAssembled && !driveUrl) {
      console.warn(`[gate5] prepare() warning: driveUrl missing after assembly for job ${jobId}`);
    }

    const profile = resolveUploadPostProfile(jobSpec) || '(not set)';
    console.log(
      `[gate5] Ready for job ${jobId} — will deliver to ${platforms.join(', ') || '(none set yet)'} via profile ${profile}`
    );
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate5] prepare() warning: ${e.message}`);
  }
}

/**
 * Re-trigger a single platform upload for self-healing retry (CPD-39).
 * Used by POST /publish/retry-upload/:jobId/:platform.
 */
async function retryPlatformUpload(jobSpec, platform) {
  const jobId = jobSpec?.jobId || 'unknown';
  const publishCopy = jobSpec.state?.savedOutputs?.publishCopy || jobSpec.order?.publish || {};
  const ytMeta = publishCopy.youtube || publishCopy.platforms?.youtube || publishCopy;
  // R2 video URL (C1+) takes priority; driveUrl is the C0/legacy alias kept for backward compat.
  const driveUrl =
    jobSpec.r2VideoUrl || jobSpec.state?.savedOutputs?.r2VideoUrl ||
    jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  const thumbnailUrl = jobSpec?.state?.savedOutputs?.thumbnailDriveUrl || null;
  const metadata = {
    title: ytMeta.title || ytMeta.titles?.[0] || jobSpec.order?.publish?.title || jobSpec.title || '',
    description: ytMeta.description || jobSpec.order?.publish?.description || '',
    tags: ytMeta.tags || ytMeta.hashtags || jobSpec.order?.publish?.tags || [],
    categoryId: jobSpec.deliverySpec?.categoryId || jobSpec.order?.publish?.categoryId || '24',
    privacyStatus: jobSpec.deliverySpec?.visibility || jobSpec.order?.publish?.privacyStatus || 'private',
    scheduledAt: jobSpec.deliverySpec?.scheduledAt || jobSpec.order?.publish?.scheduledAt || null,
    caption: publishCopy.tiktok?.caption || publishCopy.instagram?.caption || ytMeta.description || '',
    mediaType: jobSpec.order?.publish?.mediaType || 'REELS',
    platforms: [platform],
    thumbnailUrl,
    pinnedComment: ytMeta.pinnedComment || null,
  };
  const validation = validatePrePublish(metadata);
  if (!validation.passed) {
    return { ok: false, error: `Pre-publish validation failed: ${validation.violations.join('; ')}` };
  }
  const result = await uploadWithRetries(platform, driveUrl, metadata, validation.corrected, jobId, resolveUploadPostProfile(jobSpec));
  return { ok: !result.failed, platformJobId: result.jobId, failReason: result.failReason };
}

module.exports = { canProduce, commit, run, prepare, validatePrePublish, retryPlatformUpload, resolveUploadPostProfile };
