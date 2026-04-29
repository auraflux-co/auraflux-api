'use strict';

// ── Publish routes ────────────────────────────────────────────────────────────
// GET  /publish/upload-status
// GET  /upload-status/:trackingId
// POST /publish
// POST /generate-publish-copy
// GET  /publish/status
// GET  /publish/history
// GET  /publish/queue
// POST /publish/queue
// POST /publish/setup-queue
// POST /publish/retry-upload/:jobId/:platform  (CPD-39 self-healing)
// POST /publish/confirm/:jobId/:platform       (CPD-39 approve/reject)
// POST /publish/youtube  (C0 legacy — direct Google API upload)
// POST /publish/tiktok   (C0 legacy — direct TikTok API upload)
// POST /publish/instagram (C0 legacy — direct Meta Graph API upload)
//
// Primary publish path for C1+ is POST /publish → handlePublish (Upload-Post proxy).
// The per-platform routes (/youtube, /tiktok, /instagram) are C0 legacy stubs kept
// as reference implementations. C1+ channels everything through Upload-Post.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const router = require('express').Router();

const {
  handlePublish,
  handleGeneratePublishCopy,
  readUploadStatus,
  uploadToDrive,
} = require('../publish');
const {
  requireFields,
  validateBodySize,
  validateStringLength,
  validateJobId,
} = require('../validation');
const { publishLimit, apiLimit } = require('../rateLimiter');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { loadJob, savePublishResult, updatePublishStatus } = require('../db');
const { retryPlatformUpload } = require('../portals/portal5');
const { validatePublishCopy, sanitizePublishCopy } = require('../services/pre_publish_validator');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');

// GET /publish/upload-status
router.get('/publish/upload-status', (req, res) => {
  const db = readUploadStatus();
  const limit = parseInt(req.query.limit) || 50;
  const platform = req.query.platform || null;
  const status = req.query.status || null;

  let uploads = db.uploads;
  if (platform) uploads = uploads.filter((u) => u.platforms && u.platforms.includes(platform));
  if (status) uploads = uploads.filter((u) => u.status === status);

  res.json({
    total: db.uploads.length,
    filtered: uploads.length,
    uploads: uploads.slice(0, limit),
  });
});

// GET /upload-status/:trackingId
router.get('/upload-status/:trackingId', (req, res) => {
  const db = readUploadStatus();
  const entry = db.uploads.find((u) => u.trackingId === req.params.trackingId);
  if (!entry)
    return res
      .status(404)
      .json({ error: 'trackingId not found', trackingId: req.params.trackingId });
  res.json({
    trackingId: entry.trackingId,
    overallStatus: entry.status === 'submitted' ? 'uploading' : entry.status,
    platforms: entry.platforms,
    title: entry.title,
    timestamp: entry.timestamp,
    request_id: entry.request_id || null,
    job_id: entry.job_id || null,
    error: entry.error || null,
  });
});

// POST /publish — primary publish path (Upload-Post proxy)
router.post('/publish', publishLimit, validateBodySize(), requireFields('jobId'), handlePublish);

// POST /generate-publish-copy
router.post(
  '/generate-publish-copy',
  publishLimit,
  validateBodySize(),
  requireFields('jobId'),
  handleGeneratePublishCopy
);

// GET /publish/status — poll Upload-Post job/request status
router.get('/publish/status', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });
  const { request_id, job_id } = req.query;
  if (!request_id && !job_id)
    return res.status(400).json({ error: 'request_id or job_id required' });
  try {
    const param = request_id ? `request_id=${request_id}` : `job_id=${job_id}`;
    const response = await axios.get(
      `https://api.upload-post.com/api/uploadposts/status?${param}`,
      { headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message, details: e.response?.data || null });
  }
});

// GET /publish/history
router.get('/publish/history', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });
  try {
    const response = await axios.get(
      'https://api.upload-post.com/api/uploadposts/history?limit=20',
      { headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /publish/queue
router.get('/publish/queue', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || '';
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });
  try {
    const response = await axios.get(
      `https://api.upload-post.com/api/uploadposts/queue/settings?profile_username=${UPLOADPOST_PROFILE}`,
      { headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/queue
router.post('/publish/queue', publishLimit, validateBodySize(), async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || '';
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });
  try {
    const response = await axios.post(
      'https://api.upload-post.com/api/uploadposts/queue/settings',
      { profile_username: UPLOADPOST_PROFILE, ...req.body },
      {
        headers: {
          Authorization: `Apikey ${UPLOADPOST_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/setup-queue — configure Upload-Post publishing schedule
router.post('/publish/setup-queue', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || '';
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });

  const scheduleConfig = req.body.schedule || {
    timezone: 'America/New_York',
    max_posts_per_slot: 3,
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    slots: [
      { hour: 9, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 14, minute: 0 },
      { hour: 17, minute: 0 },
      { hour: 18, minute: 0 },
      { hour: 20, minute: 0 },
    ],
  };

  try {
    const response = await axios.post(
      'https://api.upload-post.com/api/uploadposts/queue/settings',
      { profile_username: UPLOADPOST_PROFILE, ...scheduleConfig },
      {
        headers: {
          Authorization: `Apikey ${UPLOADPOST_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[upload-post] Queue configured for ${UPLOADPOST_PROFILE}`);
    res.json({ ok: true, schedule: scheduleConfig, response: response.data });
  } catch (e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

// ── C0 legacy per-platform routes ────────────────────────────────────────────
// These use direct platform APIs (Google/TikTok/Meta). C1+ uses POST /publish
// (Upload-Post proxy) for all platforms. Kept as reference implementations.

// POST /publish/youtube
router.post('/publish/youtube', async (req, res) => {
  const { filename, title, description, tags, scheduledAt, privacyStatus } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const { google } = require('googleapis');
    const CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
    const CLIENT_SECRET = 'd-FL95Q19q7MQmFpd7hHD0Ty';
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    if (!process.env.DRIVE_REFRESH_TOKEN)
      return res.status(400).json({ error: 'Run node cwn-auth.js first to authorize Google' });
    oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const status = { privacyStatus: privacyStatus || 'private' };
    if (scheduledAt) {
      status.privacyStatus = 'private';
      status.publishAt = new Date(scheduledAt).toISOString();
    }

    console.log(
      `[youtube] Uploading ${filename} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)}MB)...`
    );
    const uploadRes = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: title || filename,
          description: description || '',
          tags: tags || [],
          categoryId: '24',
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en',
        },
        status,
      },
      media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
    });
    const videoId = uploadRes.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[youtube] Uploaded: ${videoUrl}`);
    res.json({ ok: true, videoId, videoUrl, scheduledAt: status.publishAt || null });
  } catch (e) {
    console.error('[youtube] Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/tiktok
router.post('/publish/tiktok', async (req, res) => {
  const { filename, caption } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!process.env.TIKTOK_ACCESS_TOKEN)
    return res.status(400).json({ error: 'TIKTOK_ACCESS_TOKEN not set in .env' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const fileSize = fs.statSync(filePath).size;
    console.log(
      `[tiktok] Initiating upload for ${filename} (${(fileSize / 1024 / 1024).toFixed(1)}MB)...`
    );
    const initResp = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption || '',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TIKTOK_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const { publish_id, upload_url } = initResp.data.data;
    const fileBuffer = fs.readFileSync(filePath);
    await axios.put(upload_url, fileBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': fileSize,
      },
      maxBodyLength: Infinity,
    });
    console.log(`[tiktok] Uploaded. Publish ID: ${publish_id}`);
    res.json({ ok: true, publishId: publish_id });
  } catch (e) {
    console.error('[tiktok] Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/instagram
router.post('/publish/instagram', async (req, res) => {
  const { filename, caption } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!process.env.INSTAGRAM_ACCESS_TOKEN || !process.env.INSTAGRAM_ACCOUNT_ID)
    return res
      .status(400)
      .json({ error: 'INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const driveUrl = await uploadToDrive(
      filePath,
      path.basename(filename),
      path.basename(filename)
    );
    if (!driveUrl) return res.status(400).json({ error: 'Drive upload required for Instagram' });

    const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
    const IG_ID = process.env.INSTAGRAM_ACCOUNT_ID;
    const BASE = 'https://graph.facebook.com/v19.0';

    console.log(`[instagram] Creating container for ${filename}...`);
    const containerResp = await axios.post(`${BASE}/${IG_ID}/media`, {
      video_url: driveUrl,
      caption: caption || '',
      media_type: 'REELS',
      access_token: IG_TOKEN,
    });
    const containerId = containerResp.data.id;

    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusResp = await axios.get(
        `${BASE}/${containerId}?fields=status_code&access_token=${IG_TOKEN}`
      );
      if (statusResp.data.status_code === 'FINISHED') {
        ready = true;
        break;
      }
      if (statusResp.data.status_code === 'ERROR')
        throw new Error('Instagram container processing failed');
      console.log(`[instagram] Container status: ${statusResp.data.status_code} (${i + 1}/20)`);
    }
    if (!ready) return res.status(500).json({ error: 'Instagram container timed out' });

    const publishResp = await axios.post(`${BASE}/${IG_ID}/media_publish`, {
      creation_id: containerId,
      access_token: IG_TOKEN,
    });
    console.log(`[instagram] Published. Media ID: ${publishResp.data.id}`);
    res.json({ ok: true, mediaId: publishResp.data.id });
  } catch (e) {
    console.error('[instagram] Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CPD-39: Self-healing retry + operator confirm/reject ──────────────────────

const VALID_PLATFORMS = ['youtube', 'tiktok', 'instagram'];

/**
 * POST /publish/retry-upload/:jobId/:platform
 * Operator-triggered or system-triggered re-upload of a single failed platform.
 * Auth: operator+
 */
router.post(
  '/publish/retry-upload/:jobId/:platform',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.OPERATOR }),
  async (req, res) => {
    const { jobId, platform } = req.params;
    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ ok: false, error: `Unknown platform: ${platform}` });
    }
    const jobSpec = await loadJob(jobId);
    if (!jobSpec) {
      return res.status(404).json({ ok: false, error: `Job ${jobId} not found` });
    }
    // Mark as retrying in DB
    await updatePublishStatus(jobId, platform, 'retrying');
    const result = await retryPlatformUpload(jobSpec, platform);
    const newStatus = result.ok ? 'published' : 'failed';
    await savePublishResult(jobId, platform, {
      platformJobId: result.platformJobId || null,
      driveUrl: jobSpec.driveUrl || jobSpec.state?.savedOutputs?.driveUrl || null,
      title: jobSpec.title || '',
      status: newStatus,
    });
    return res.json({
      ok: result.ok,
      jobId,
      platform,
      status: newStatus,
      platformJobId: result.platformJobId || null,
      ...(result.failReason ? { failReason: result.failReason } : {}),
    });
  }
);

/**
 * POST /publish/confirm/:jobId/:platform
 * Operator approves or rejects a published platform delivery.
 * Body: { action: 'approve' | 'reject', reason?: string }
 * Auth: operator+
 */
router.post(
  '/publish/confirm/:jobId/:platform',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.OPERATOR }),
  async (req, res) => {
    const { jobId, platform } = req.params;
    const { action, reason } = req.body || {};
    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ ok: false, error: `Unknown platform: ${platform}` });
    }
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ ok: false, error: `action must be 'approve' or 'reject'` });
    }
    const jobSpec = await loadJob(jobId);
    if (!jobSpec) {
      return res.status(404).json({ ok: false, error: `Job ${jobId} not found` });
    }
    const status = action === 'approve' ? 'confirmed' : 'rejected';
    await updatePublishStatus(jobId, platform, status);
    return res.json({ ok: true, jobId, platform, status, ...(reason ? { reason } : {}) });
  }
);

// ── CPD-31: Pre-publish validator ────────────────────────────────────────────
// POST /jobs/:jobId/validate-publish
// Validates publish copy against platform API limits before Upload-Post fires.
// Also called automatically from Portal 5 before any upload attempt.
//
// Body: { youtube?, tiktok?, instagram? } — publish copy payload
// Returns: { valid, violations[], sanitized? } on 200 even for violations (action gate is caller's)
//
// 422 = validation ran but found violations (caller must decide to block or sanitize)
// 200 = validation ran and passed

router.post(
  '/jobs/:jobId/validate-publish',
  requireAuth,
  requireRole(ROLES.customer),
  async (req, res) => {
    const { jobId } = req.params;
    const payload = req.body || {};

    // If no platform data sent, load from job spec
    let toValidate = payload;
    if (!payload.youtube && !payload.tiktok && !payload.instagram) {
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ ok: false, error: `Job ${jobId} not found` });
      const pub = jobSpec.state?.publishCopy || jobSpec.publishCopy;
      if (!pub) {
        return res.status(400).json({
          ok:    false,
          error: 'No publish copy on job spec — generate publish copy first',
          label: 'NO_PUBLISH_COPY',
        });
      }
      toValidate = pub;
    }

    const result = validatePublishCopy(toValidate);

    if (result.valid) {
      return res.json({ ok: true, valid: true, violations: [] });
    }

    const sanitized = sanitizePublishCopy(toValidate);
    const sanitizedResult = validatePublishCopy(sanitized);

    return res.status(422).json({
      ok:         false,
      valid:      false,
      violations: result.violations,
      sanitized,
      sanitizedValid: sanitizedResult.valid,
      message:    `${result.violations.length} platform limit violation(s) — see violations[]`,
      label:      'PRE_PUBLISH_LIMIT',
    });
  }
);

module.exports = router;
