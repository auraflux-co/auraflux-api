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
const { nrPipelineEvent } = require('../nr_pipeline');
const pipelineBus = require('../pipeline_events');
const { recordWhyLedger, INTERVENTION, FAILURE_CLASS } = require('../why_ledger');
const { resolveSyntheticMediaFlags } = require('../publish_synthetic');
const { recordGateMetadataSnapshot } = require('../publish_seo_audit');
const { validateYoutubeTagsSeo } = require('./metadata_qa');

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
const POLL_INTERVAL_MS = 10000; // 10 s between status checks
const POLL_TIMEOUT_MS = 900000; // 15 minutes max poll per platform (Upload-Post can take several minutes for large videos)

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

    // Tags — target 490-500 combined chars (YouTube hard max 500)
    if (metadata.tags && Array.isArray(metadata.tags)) {
      violations.push(...validateYoutubeTagsSeo(metadata.tags));
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
const UPLOADPOST_BASE_URL = 'https://api.upload-post.com/api';
const FormData = require('form-data');

/**
 * Submit an upload request to Upload-Post for a single platform.
 * Uses multipart form-data matching lib/publish.js — the proven working format.
 * Returns { requestId } or throws.
 */
async function submitUpload(platform, driveUrl, metadata, corrected, pipelineJobId = null) {
  if (platform === 'youtube') {
    throw new Error('YouTube uploads use the YouTube Data API directly — not Upload-Post');
  }
  if (!UPLOADPOST_API_KEY) throw new Error('UPLOADPOST_API_KEY not set');
  if (!UPLOADPOST_PROFILE) throw new Error('UPLOADPOST_PROFILE not set');

  const title = corrected.title || metadata.title;
  const description = corrected.description || metadata.description || '';
  const scheduledAt = corrected.scheduledAt || metadata.scheduledAt || null;
  const { resolveTikTokPrivacy } = require('../publish_privacy');
  const jobSpecStub = { contentType: metadata.contentType, clipsOnly: metadata.clipsOnly };

  const form = new FormData();
  form.append('user', UPLOADPOST_PROFILE);
  form.append('video', driveUrl);
  form.append('title', title);
  if (description) form.append('description', description);
  form.append('platform[]', platform);
  form.append('async_upload', 'true');

  const synthetic = resolveSyntheticMediaFlags({
    jobType: metadata.jobType || metadata.contentType,
    contentType: metadata.contentType,
    isAigc: metadata.isAigc,
    heygenUsed: metadata.heygenUsed,
  });

  if (platform === 'tiktok') {
    const tiktokCaption = metadata.tiktokCaption
      || corrected.caption
      || metadata.description
      || metadata.title;
    form.append('tiktok_title', [...tiktokCaption].slice(0, 2200).join(''));
    form.append('privacy_level', resolveTikTokPrivacy(jobSpecStub, metadata, scheduledAt));
    form.append('post_mode', 'DIRECT_POST');
    form.append('is_aigc', synthetic.isAigc ? 'true' : 'false');
    form.append('brand_content_toggle', 'false');
  }

  if (platform === 'instagram') {
    const igCaption = metadata.instagramCaption
      || corrected.caption
      || metadata.description
      || metadata.title;
    form.append('media_type', 'REELS');
    form.append('instagram_title', [...igCaption].slice(0, 2200).join(''));
  }

  const response = await axios.post(
    `${UPLOADPOST_BASE_URL}/upload`,
    form,
    {
      headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}`, ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: 60000
    }
  );

  const requestId = response.data?.request_id || response.data?.requestId || response.data?.id;
  if (!requestId) throw new Error(`No request_id returned from Upload-Post: ${JSON.stringify(response.data)}`);
  try {
    nrPipelineEvent('UploadPostApiSubmitOk', {
      pipelineStage: 'upload_post',
      source: 'gate5',
      platform,
      requestId: String(requestId),
      jobId: pipelineJobId
    });
  } catch (_e) { /* non-fatal */ }
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
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    pollAttempt++;

    try {
      const response = await axios.get(
        `${UPLOADPOST_BASE_URL}/uploadposts/status`,
        {
          params: { request_id: requestId },
          headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}` },
          timeout: 15000
        }
      );

      const status = response.data?.status;
      const platformJobId = response.data?.job_id || response.data?.jobId;

      try {
        pipelineBus.emit('publish:poll_tick', {
          jobId: pipelineJobId,
          source: 'gate5',
          platform,
          request_id: String(requestId),
          attempt: pollAttempt,
          uploadPostStatus: status || null
        });
      } catch (_e) { /* non-fatal */ }

      if (status === 'completed') {
        const results = Array.isArray(response.data?.results) ? response.data.results : [];
        const platformResult = results.find((r) => String(r.platform || '').toLowerCase() === platform)
          || (results.length === 1 ? results[0] : null);
        if (platformResult && platformResult.success === false) {
          const errMsg = platformResult.error_message || platformResult.error || `Upload-Post ${platform} failed`;
          try {
            pipelineBus.emit('publish:platform_done', {
              jobId: pipelineJobId,
              platform,
              request_id: String(requestId),
              outcome: 'failed',
              reason: String(errMsg).slice(0, 300)
            });
          } catch (_e3) { /* non-fatal */ }
          throw new Error(`Upload-Post reported failure for ${platform}: ${errMsg}`);
        }
        try {
          pipelineBus.emit('publish:platform_done', {
            jobId: pipelineJobId,
            platform,
            request_id: String(requestId),
            outcome: 'completed',
            platformJobId: platformJobId ? String(platformJobId) : null
          });
        } catch (_e2) { /* non-fatal */ }
        return { jobId: platformJobId || requestId, url: platformResult?.url || response.data?.url || null };
      }
      if (status === 'failed') {
        const errMsg = response.data?.error || 'unknown error';
        try {
          pipelineBus.emit('publish:platform_done', {
            jobId: pipelineJobId,
            platform,
            request_id: String(requestId),
            outcome: 'failed',
            reason: String(errMsg).slice(0, 300)
          });
        } catch (_e3) { /* non-fatal */ }
        throw new Error(`Upload-Post reported failure for ${platform}: ${errMsg}`);
      }
      // status === 'pending' or 'processing' — continue polling
    } catch (err) {
      if (err.message?.includes('Upload-Post reported failure')) throw err;
      // Network errors during poll — log and retry
      logError('GATE5_POLL_ERROR', err, { platform, requestId });
      try {
        pipelineBus.emit('publish:poll_tick', {
          jobId: pipelineJobId,
          source: 'gate5',
          platform,
          request_id: String(requestId),
          attempt: pollAttempt,
          uploadPostStatus: null,
          pollError: (err.message || '').slice(0, 240)
        });
      } catch (_e) { /* non-fatal */ }
    }
  }

  try {
    pipelineBus.emit('publish:platform_done', {
      jobId: pipelineJobId,
      platform,
      request_id: String(requestId),
      outcome: 'timeout'
    });
  } catch (_e) { /* non-fatal */ }
  throw new Error(`Poll timeout after ${POLL_TIMEOUT_MS / 1000}s for ${platform} request ${requestId}`);
}

/**
 * YouTube: Data API resumable upload + thumbnail + Streamer Related Clips playlist.
 * Upload-Post is never used for YouTube on C0.
 */
async function publishYouTubeDirect(jobSpec, driveUrl, metadata, corrected, jobId) {
  const ytDirect = require('../services/youtube_direct');
  if (!ytDirect.isConnected()) {
    return {
      jobId: null,
      failed: true,
      failReason: 'YouTube not connected — visit /connect/youtube to authorize the channel',
    };
  }

  const { resolveYouTubePrivacy } = require('../publish_privacy');
  const privacyStatus = resolveYouTubePrivacy(jobSpec, corrected);
  const scheduledAt = corrected.scheduledAt || metadata.scheduledAt || null;

  try {
    const heygenUsed = !!(
      jobSpec.heygen?.videoJobs?.length
      || jobSpec.addOns?.heygen?.active
      || metadata.heygenUsed
    );
    const direct = await ytDirect.publish({
      videoSource: driveUrl,
      metadata: {
        title: corrected.title || metadata.title,
        description: corrected.description || metadata.description,
        tags: corrected.tags || metadata.tags,
        categoryId: corrected.categoryId || metadata.categoryId || '24',
        privacyStatus,
        publishAt: scheduledAt || undefined,
        contentType: jobSpec.contentType || metadata.contentType,
        heygenUsed,
      },
      thumbnailUrl: metadata.thumbnailUrl,
      jobId,
    });
    const out = {
      jobId: direct.videoId,
      failed: false,
      failReason: null,
      url: direct.url,
      via: 'direct',
      thumbnailSet: direct.thumbnailSet,
    };
    try {
      out.playlist = await ytDirect.addStreamerClipToPlaylist(direct.videoId, jobSpec, {
        log: (msg) => console.log(`[gate5] ${jobId}: ${msg}`),
      });
    } catch (plErr) {
      console.warn(`[gate5] ${jobId}: playlist add failed — ${plErr.message}`);
      out.playlist = { ok: false, error: plErr.message };
    }
    return out;
  } catch (e) {
    logError('GATE5_YT_DIRECT_FAIL', e, { jobId, gate: 5 });
    return { jobId: null, failed: true, failReason: e.message, via: 'direct' };
  }
}

/**
 * Upload to a single platform with retries (TikTok / Instagram via Upload-Post only).
 */
async function uploadWithRetries(platform, driveUrl, metadata, corrected, jobId) {
  if (platform === 'youtube') {
    throw new Error('uploadWithRetries must not be called for YouTube');
  }
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      try {
        pipelineBus.emit('pipeline:retry_attempt', {
          jobId,
          gate: 5,
          stage: `upload_post_${platform}`,
          attempt,
          maxAttempts: MAX_RETRIES
        });
      } catch (_e) { /* non-fatal */ }
      const { requestId } = await submitUpload(platform, driveUrl, metadata, corrected, jobId);
      const { jobId: platformJobId, url: platformUrl } = await pollForJobId(requestId, platform, jobId);
      try {
        nrPipelineEvent('UploadPostPollComplete', {
          pipelineStage: 'upload_post',
          source: 'gate5',
          platform,
          requestId: String(requestId),
          uploadPostJobId: platformJobId || null,
          jobId
        });
      } catch (_e) { /* non-fatal */ }
      return { jobId: platformJobId, url: platformUrl || null, failed: false, failReason: null };
    } catch (err) {
      lastErr = err;
      logError('GATE5_UPLOAD_ATTEMPT_FAIL', err, { jobId, gate: 5, platform, attempt });
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }

  logError('GATE5_UPLOAD_EXHAUSTED', lastErr, { jobId, gate: 5, platform, attempts: MAX_RETRIES });
  try {
    nrPipelineEvent('UploadPostPlatformExhausted', {
      pipelineStage: 'upload_post',
      source: 'gate5',
      platform,
      jobId,
      attempts: MAX_RETRIES,
      error: (lastErr && lastErr.message) ? String(lastErr.message).slice(0, 500) : 'unknown'
    });
  } catch (_e) { /* non-fatal */ }
  return { jobId: null, failed: true, failReason: lastErr.message };
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) reasons.push('jobSpec.jobId missing');

  const platforms = jobSpec.deliverySpec?.platforms || jobSpec.order?.publish?.platforms || [];
  if (platforms.length === 0) reasons.push('No platforms specified in deliverySpec.platforms');

  const needsUploadPost = platforms.some((p) => p === 'tiktok' || p === 'instagram');
  if (needsUploadPost) {
    if (!UPLOADPOST_API_KEY) reasons.push('UPLOADPOST_API_KEY not set (required for TikTok/Instagram)');
    if (!UPLOADPOST_PROFILE) reasons.push('UPLOADPOST_PROFILE not set (required for TikTok/Instagram)');
  }

  const needsYouTube = platforms.includes('youtube');
  if (needsYouTube) {
    try {
      const ytDirect = require('../services/youtube_direct');
      if (!ytDirect.isConnected()) {
        reasons.push('YouTube not connected — visit /connect/youtube (Data API, not Upload-Post)');
      }
    } catch (_e) {
      reasons.push('YouTube direct publish module unavailable');
    }
  }

  // driveUrl is only available AFTER assembly + Drive upload — not at pre-generate time.
  const driveUrl = jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  const isPreGenerate = !jobSpec.assembledPath && !driveUrl;
  if (!isPreGenerate && !driveUrl) {
    reasons.push('driveUrl missing from jobSpec — required for publish');
  }

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
  const ytNote = platforms.includes('youtube') ? 'YouTube via Data API; ' : '';
  const upNote = platforms.some((p) => p === 'tiktok' || p === 'instagram')
    ? `TikTok/IG via Upload-Post profile '${profile}'. `
    : '';
  return {
    committed: `I will deliver to [${platforms.join(', ')}] as private drafts. ${ytNote}${upNote}Will NOT fire without gate4.uploadSignal === true.`,
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
    try {
      pipelineBus.emit('publish:failed_validation', {
        jobId,
        code: 'gate4_upload_signal',
        message: reason.slice(0, 500)
      });
    } catch (_e) { /* non-fatal */ }
    try {
      recordWhyLedger({
        jobId,
        gate: 'gate5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: 'gate4_upload_signal_false',
        reasons: [reason.slice(0, 500)],
        failureClass: FAILURE_CLASS.SPEC_VIOLATION,
        interventionType: INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        source: 'lib/gates/gate5:run'
      });
    } catch (_w) { /* non-fatal */ }
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
    try {
      pipelineBus.emit('publish:failed_validation', {
        jobId,
        code: 'gate5_not_ready',
        message: reason.slice(0, 500)
      });
    } catch (_e) { /* non-fatal */ }
    try {
      recordWhyLedger({
        jobId,
        gate: 'gate5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: 'gate5_not_ready',
        reasons: readiness.reasons.slice(0, 12),
        failureClass: FAILURE_CLASS.SPEC_VIOLATION,
        interventionType: INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        source: 'lib/gates/gate5:run'
      });
    } catch (_w) { /* non-fatal */ }
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: readiness.reasons },
      completedAt: now()
    };
  }

  // CPD-971 / duplicate guard — skip if a prior Gate 5 run already confirmed upload
  try {
    const { getPublishedResults } = require('../db');
    const priorPublished = getPublishedResults(jobId) || [];
    if (priorPublished.some(r => r.platform_job_id)) {
      console.log(`[gate5] ${jobId}: already published (${priorPublished.map(r => r.platform).join(', ')}) — skipping duplicate upload`);
      return {
        ...baseOutput,
        passed: true,
        skippedDuplicate: true,
        prePublishValidation: { passed: true, violations: [] },
        completedAt: now()
      };
    }
  } catch (_dupE) { /* non-fatal */ }

  const driveUrl = jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || jobSpec.order?.publish?.driveUrl;
  const platforms = jobSpec.deliverySpec?.platforms || jobSpec.order?.publish?.platforms || [];
  const thumbnailUrl = jobSpec?.state?.savedOutputs?.thumbnailDriveUrl || null;

  // Read publish copy from savedOutputs (set after Drive upload by assembly.js)
  const publishCopy = jobSpec.state?.savedOutputs?.publishCopy || jobSpec.order?.publish || {};
  const ytMeta = publishCopy.youtube || publishCopy.platforms?.youtube || publishCopy;

  const metadata = {
    title: ytMeta.bestTitle?.title || ytMeta.title || ytMeta.titles?.[0] || jobSpec.order?.publish?.title || jobSpec.title || '',
    description: ytMeta.description || jobSpec.order?.publish?.description || '',
    tags: ytMeta.tags || ytMeta.hashtags || jobSpec.order?.publish?.tags || [],
    categoryId: jobSpec.deliverySpec?.categoryId || jobSpec.order?.publish?.categoryId || '24',
    privacyStatus: require('../publish_privacy').resolveYouTubePrivacy(jobSpec),
    contentType: jobSpec.contentType,
    clipsOnly: jobSpec.clipsOnly,
    scheduledAt: jobSpec.deliverySpec?.scheduledAt || jobSpec.order?.publish?.scheduledAt || null,
    caption: publishCopy.tiktok?.caption || publishCopy.instagram?.caption || '',
    tiktokCaption: publishCopy.tiktok?.caption || '',
    instagramCaption: publishCopy.instagram?.caption || '',
    mediaType: jobSpec.order?.publish?.mediaType || 'REELS',
    platforms,
    thumbnailUrl,
    pinnedComment: ytMeta.pinnedComment || null
  };

  let publishSeoAudit = recordGateMetadataSnapshot(
    jobSpec.publishSeoAudit || jobSpec.state?.savedOutputs?.publishSeoAudit || null,
    metadata,
    'gate5_pre_upload',
  );

  // ── Pre-publish validation ─────────────────────────────────────────────
  const validation = validatePrePublish(metadata);

  if (!validation.passed) {
    logError('GATE5_VALIDATION_FAIL', new Error(`Violations: ${validation.violations.join('; ')}`), { jobId, gate: 5, violations: validation.violations });
    try {
      pipelineBus.emit('publish:failed_validation', {
        jobId,
        code: 'gate5_prepublish_validation',
        message: validation.violations.join('; ').slice(0, 500)
      });
    } catch (_e) { /* non-fatal */ }
    try {
      recordWhyLedger({
        jobId,
        gate: 'gate5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: 'prepublish_validation_failed',
        reasons: validation.violations.slice(0, 20),
        failureClass: FAILURE_CLASS.SPEC_VIOLATION,
        interventionType: INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        source: 'lib/gates/gate5:run'
      });
    } catch (_w) { /* non-fatal */ }
    return {
      ...baseOutput,
      prePublishValidation: { passed: false, violations: validation.violations },
      completedAt: now()
    };
  }

  const corrected = validation.corrected;
  publishSeoAudit = recordGateMetadataSnapshot(
    publishSeoAudit,
    { ...metadata, ...corrected },
    'gate5_corrected',
  );

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

    if (platform === 'youtube') {
      platformResults.youtube = {
        attempted: true,
        ...await publishYouTubeDirect(jobSpec, driveUrl, metadata, corrected, jobId),
      };
      continue;
    }

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
      platforms: summary
    });
  } catch (_e) { /* non-fatal */ }

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

  if (anySuccess) {
    publishSeoAudit = recordGateMetadataSnapshot(publishSeoAudit, corrected, 'gate5_published');
    const last = publishSeoAudit.snapshots[publishSeoAudit.snapshots.length - 1];
    if (last?.changes?.length) {
      console.log(`[gate5] ${jobId}: SEO field changes — ${last.changes.join('; ')}`);
    }
    if (platformResults.youtube?.playlist?.ok) {
      console.log(`[gate5] ${jobId}: added to Streamer Related Clips playlist`);
    }
  }

  return {
    gate: 5,
    jobId,
    passed: anySuccess,
    platforms: platformResults,
    prePublishValidation: { passed: true, violations: [] },
    publishSeoAudit,
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
    const platforms = jobSpec?.deliverySpec?.platforms || jobSpec?.order?.publish?.platforms || [];
    if (platforms.length === 0) {
      console.warn(`[gate5] prepare() warning: no platforms in deliverySpec.platforms for job ${jobId}`);
    }

    if (platforms.some((p) => p === 'tiktok' || p === 'instagram')) {
      if (!UPLOADPOST_API_KEY) {
        console.warn(`[gate5] prepare() warning: UPLOADPOST_API_KEY not set — TikTok/Instagram delivery will fail for job ${jobId}`);
      }
      if (!UPLOADPOST_PROFILE) {
        console.warn(`[gate5] prepare() warning: UPLOADPOST_PROFILE not set — TikTok/Instagram delivery will fail for job ${jobId}`);
      }
    }

    if (platforms.includes('youtube')) {
      try {
        const ytDirect = require('../services/youtube_direct');
        if (!ytDirect.isConnected()) {
          console.warn(`[gate5] prepare() warning: YouTube not connected — visit /connect/youtube for job ${jobId}`);
        }
      } catch (_e) { /* non-fatal */ }
    }

    // driveUrl not expected at pre-generate time — only warn if assembledPath exists (run time)
    const driveUrl = jobSpec?.driveUrl || jobSpec?.state?.savedOutputs?.driveUrl;
    const hasAssembled = !!jobSpec?.assembledPath;
    if (hasAssembled && !driveUrl) {
      console.warn(`[gate5] prepare() warning: driveUrl missing after assembly for job ${jobId}`);
    }

    const profile = UPLOADPOST_PROFILE || '(not set)';
    console.log(`[gate5] Ready for job ${jobId} — will deliver to ${platforms.join(', ') || '(none set yet)'} via ${profile}`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate5] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare, validatePrePublish };
