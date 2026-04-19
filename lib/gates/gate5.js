'use strict';
/**
 * lib/gates/gate5.js — Gate 5: Upload Confirmation (Code Only, No AI)
 *
 * Binary result. Only fires if gate4.uploadSignal === true.
 * Runs pre-publish validator, uploads to Upload-Post, polls for job_id per platform.
 * One platform failure retries that platform only (max 3 retries).
 *
 * Output contract:
 * {
 *   gate: 5,
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

// ─── Pre-publish constraints ──────────────────────────────────────────────────

const PLATFORM_RULES = {
  youtube: {
    maxTitleChars: 100,
    maxDescBytes: 5000,
    maxTagsTotalChars: 500,
    requiresCategoryId: true,
    supportsScheduling: true,
    scheduledRequiresPrivate: true
  },
  tiktok: {
    maxCaptionRunes: 2200,
    supportsScheduling: false
  },
  instagram: {
    maxCaptionChars: 2200,
    maxHashtags: 30,
    maxMentions: 20,
    validMediaTypes: ['REELS', 'STORIES']
  }
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
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
        violations.push(`YouTube: title exceeds ${rules.maxTitleChars} chars (${corrected.title.length})`);
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
        violations.push(`YouTube: combined tag length ${tagsJoined.length} exceeds ${rules.maxTagsTotalChars} chars`);
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
      violations.push(`TikTok: caption ${runeCount} runes exceeds ${rules.maxCaptionRunes} rune limit`);
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
      violations.push(`Instagram: caption ${caption.length} chars exceeds ${rules.maxCaptionChars} char limit`);
    }

    // Hashtags
    const hashtags = (caption.match(/#\w+/g) || []);
    if (hashtags.length > rules.maxHashtags) {
      violations.push(`Instagram: ${hashtags.length} hashtags exceeds ${rules.maxHashtags} limit`);
    }

    // Mentions
    const mentions = (caption.match(/@\w+/g) || []);
    if (mentions.length > rules.maxMentions) {
      violations.push(`Instagram: ${mentions.length} mentions exceeds ${rules.maxMentions} limit`);
    }

    // Media type
    const mediaType = metadata.mediaType || 'REELS';
    if (!rules.validMediaTypes.includes(mediaType)) {
      violations.push(`Instagram: mediaType "${mediaType}" not valid — must be one of: ${rules.validMediaTypes.join(', ')}`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    corrected
  };
}

// ─── Upload-Post API helper ───────────────────────────────────────────────────

const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE;
const UPLOADPOST_BASE_URL = 'https://api.upload-post.com/v1';

/**
 * Submit an upload request to Upload-Post for a single platform.
 * Returns { requestId } or throws.
 */
async function submitUpload(platform, driveUrl, metadata, corrected) {
  if (!UPLOADPOST_API_KEY) throw new Error('UPLOADPOST_API_KEY not set');

  const payload = {
    profile: UPLOADPOST_PROFILE,
    platform,
    url: driveUrl,
    title: corrected.title || metadata.title,
    description: corrected.description || metadata.description || '',
    tags: corrected.tags || metadata.tags || [],
    categoryId: corrected.categoryId || metadata.categoryId,
    privacyStatus: corrected.privacyStatus || metadata.privacyStatus || 'private',
    scheduledAt: platform === 'tiktok' ? null : (metadata.scheduledAt || null),
    caption: corrected.caption || metadata.caption || corrected.description || metadata.description || '',
    mediaType: metadata.mediaType || 'REELS',
    thumbnail_url: metadata.thumbnailUrl || undefined
  };

  const response = await axios.post(
    `${UPLOADPOST_BASE_URL}/upload`,
    payload,
    {
      headers: { 'Authorization': `Bearer ${UPLOADPOST_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  const requestId = response.data?.request_id || response.data?.requestId || response.data?.id;
  if (!requestId) throw new Error('No request_id returned from Upload-Post');
  return { requestId };
}

/**
 * Poll Upload-Post status until job_id confirmed or timeout.
 * Returns { jobId } or throws.
 */
async function pollForJobId(requestId, platform) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const response = await axios.get(
        `${UPLOADPOST_BASE_URL}/status`,
        {
          params: { request_id: requestId },
          headers: { 'Authorization': `Bearer ${UPLOADPOST_API_KEY}` },
          timeout: 15000
        }
      );

      const status = response.data?.status;
      const jobId = response.data?.job_id || response.data?.jobId;

      if (status === 'completed' && jobId) {
        return { jobId };
      }
      if (status === 'failed') {
        throw new Error(`Upload-Post reported failure for ${platform}: ${response.data?.error || 'unknown error'}`);
      }
      // status === 'pending' or 'processing' — continue polling
    } catch (err) {
      if (err.message?.includes('Upload-Post reported failure')) throw err;
      // Network errors during poll — log and retry
      logError('GATE5_POLL_ERROR', err, { platform, requestId });
    }
  }

  throw new Error(`Poll timeout after ${POLL_TIMEOUT_MS / 1000}s for ${platform} request ${requestId}`);
}

/**
 * Upload to a single platform with retries.
 */
async function uploadWithRetries(platform, driveUrl, metadata, corrected, jobId) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { requestId } = await submitUpload(platform, driveUrl, metadata, corrected);
      const { jobId: platformJobId } = await pollForJobId(requestId, platform);
      return { jobId: platformJobId, failed: false, failReason: null };
    } catch (err) {
      lastErr = err;
      logError('GATE5_UPLOAD_ATTEMPT_FAIL', err, { jobId, gate: 5, platform, attempt });
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }

  logError('GATE5_UPLOAD_EXHAUSTED', lastErr, { jobId, gate: 5, platform, attempts: MAX_RETRIES });
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
  if (!UPLOADPOST_PROFILE) reasons.push('UPLOADPOST_PROFILE not set');

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) reasons.push('jobSpec.jobId missing');

  const driveUrl = jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  if (!driveUrl) reasons.push('driveUrl missing from jobSpec — required for Upload-Post');

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
  const profile = process.env.UPLOADPOST_PROFILE || 'not configured';
  return {
    committed: `I will deliver to [${platforms.join(', ')}] as private drafts via Upload-Post profile '${profile}'. I confirm job_id per platform. Will NOT fire without gate4.uploadSignal === true.`,
    summary: `Deliver to ${platforms.join(', ')} as private drafts`
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
    failReason: null
  };

  const baseOutput = {
    gate: 5,
    jobId,
    passed: false,
    platforms: {
      youtube: { ...platformTemplate },
      tiktok: { ...platformTemplate },
      instagram: { ...platformTemplate }
    },
    prePublishValidation: { passed: false, violations: [] },
    completedAt: now()
  };

  // ── HARD STOP: uploadSignal must be true ─────────────────────────────
  if (!gate4Report || gate4Report.uploadSignal !== true) {
    const reason = `Gate 5 HARD STOP: gate4.uploadSignal is not true — upload blocked. gate4.passed=${gate4Report?.passed}, gate4.uploadSignal=${gate4Report?.uploadSignal}`;
    logError('GATE5_HARD_STOP', new Error(reason), { jobId, gate: 5 });
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: [reason] },
      completedAt: now()
    };
  }

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 5 not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE5_NOT_READY', new Error(reason), { jobId, gate: 5 });
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: readiness.reasons },
      completedAt: now()
    };
  }

  const driveUrl = jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  const platforms = jobSpec.deliverySpec?.platforms || jobSpec.order?.publish?.platforms || [];
  const thumbnailUrl = jobSpec?.state?.savedOutputs?.thumbnailDriveUrl || null;

  // Read publish copy from savedOutputs (set after Drive upload by assembly.js)
  const publishCopy = jobSpec.state?.savedOutputs?.publishCopy || jobSpec.order?.publish || {};
  const ytMeta = publishCopy.youtube || publishCopy.platforms?.youtube || publishCopy;

  const metadata = {
    title: ytMeta.title || ytMeta.titles?.[0] || jobSpec.order?.publish?.title || jobSpec.title || '',
    description: ytMeta.description || jobSpec.order?.publish?.description || '',
    tags: ytMeta.tags || ytMeta.hashtags || jobSpec.order?.publish?.tags || [],
    categoryId: jobSpec.deliverySpec?.categoryId || jobSpec.order?.publish?.categoryId || '24',
    privacyStatus: jobSpec.deliverySpec?.visibility || jobSpec.order?.publish?.privacyStatus || 'private',
    scheduledAt: jobSpec.deliverySpec?.scheduledAt || jobSpec.order?.publish?.scheduledAt || null,
    caption: publishCopy.tiktok?.caption || publishCopy.instagram?.caption || ytMeta.description || '',
    mediaType: jobSpec.order?.publish?.mediaType || 'REELS',
    platforms,
    thumbnailUrl,
    pinnedComment: ytMeta.pinnedComment || null
  };

  // ── Pre-publish validation ─────────────────────────────────────────────
  const validation = validatePrePublish(metadata);

  if (!validation.passed) {
    logError('GATE5_VALIDATION_FAIL', new Error(`Violations: ${validation.violations.join('; ')}`), { jobId, gate: 5, violations: validation.violations });
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: validation.violations },
      completedAt: now()
    };
  }

  const corrected = validation.corrected;
  const platformResults = {
    youtube: { ...platformTemplate },
    tiktok: { ...platformTemplate },
    instagram: { ...platformTemplate }
  };

  // ── Upload per platform ───────────────────────────────────────────────
  for (const platform of platforms) {
    if (!['youtube', 'tiktok', 'instagram'].includes(platform)) {
      logError('GATE5_UNKNOWN_PLATFORM', new Error(`Unknown platform: ${platform}`), { jobId, gate: 5, platform });
      platformResults[platform] = { attempted: false, jobId: null, failed: true, failReason: `Unknown platform: ${platform}` };
      continue;
    }

    platformResults[platform].attempted = true;
    const result = await uploadWithRetries(platform, driveUrl, metadata, corrected, jobId);
    platformResults[platform] = { attempted: true, ...result };
  }

  // ── Determine overall pass ────────────────────────────────────────────
  // Pass = at least one platform confirmed job_id (partial success counts)
  const anySuccess = Object.values(platformResults).some(r => r.attempted && !r.failed && r.jobId);
  const allFailed = platforms.length > 0 && Object.values(platformResults)
    .filter(r => r.attempted)
    .every(r => r.failed);

  if (allFailed) {
    logError('GATE5_ALL_PLATFORMS_FAILED', new Error('All platform uploads failed'), { jobId, gate: 5, platformResults });
  }

  // ── Persist publish results to DB ────────────────────────────────────
  try {
    const { savePublishResult, markJobPublished } = require('../db');
    Object.entries(platformResults).forEach(([platform, r]) => {
      if (r.attempted) {
        savePublishResult(jobId, platform, {
          platformJobId: r.jobId,
          driveUrl,
          title: metadata.title,
          status: r.failed ? 'failed' : 'published'
        });
      }
    });
    if (anySuccess) markJobPublished(jobId, driveUrl);
  } catch(e) {
    logError('GATE5_DB_PERSIST_FAIL', e, { jobId, gate: 5 });
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
            jobId, customerId, contentType, platform,
            title: (metadata.title || '').slice(0, 100),
            platformJobId: r.jobId || null,
            driveUrl: driveUrl || null
          });
        }
      });
    }
  } catch(e) { /* non-fatal */ }

  return {
    gate: 5,
    jobId,
    passed: anySuccess,
    platforms: platformResults,
    prePublishValidation: { passed: true, violations: [] },
    completedAt: now()
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
      console.warn(`[gate5] prepare() warning: UPLOADPOST_API_KEY not set — delivery will fail for job ${jobId}`);
    }

    // Pre-validate UPLOADPOST_PROFILE is set
    if (!UPLOADPOST_PROFILE) {
      console.warn(`[gate5] prepare() warning: UPLOADPOST_PROFILE not set — delivery will fail for job ${jobId}`);
    }

    // Pre-validate platforms list is non-empty
    const platforms = jobSpec?.order?.publish?.platforms || [];
    if (platforms.length === 0) {
      console.warn(`[gate5] prepare() warning: no platforms specified in jobSpec.order.publish.platforms for job ${jobId}`);
    }

    // Pre-validate driveFolder is set
    const driveUrl = jobSpec?.driveUrl || jobSpec?.order?.publish?.driveUrl;
    if (!driveUrl) {
      console.warn(`[gate5] prepare() warning: driveUrl missing from jobSpec for job ${jobId} — required for Upload-Post`);
    }

    const profile = UPLOADPOST_PROFILE || '(not set)';
    console.log(`[gate5] Ready for job ${jobId} — will deliver to ${platforms.join(', ') || '(none)'} via ${profile}`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate5] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare, validatePrePublish };
