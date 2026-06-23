'use strict';
const { normalizePublishCopyShape } = require('./publish_copy_normalize');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { log } = require('./logger');
const { callClaudeAPI } = require('./qa');

// OpenAI client for publish copy generation (titles, descriptions, tags)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { StageTimer, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./metrics');
const { nrPipelineEvent } = require('./nr_pipeline');
const pipelineBus = require('./pipeline_events');
const whyLedger = require('./why_ledger');
const { resolveSyntheticMediaFlags } = require('./publish_synthetic');
const {
  youtubeTagsCombinedLength,
  YOUTUBE_TAGS_TARGET_MIN,
  YOUTUBE_TAGS_TARGET_MAX,
} = require('./gates/metadata_qa');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const UPLOAD_STATUS_PATH = path.join(__dirname, '..', 'data', 'upload_status.json');

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Drive service account key — defined here (moved from server.js during module split)
const DRIVE_KEY_PATH   = path.join(__dirname, '..', 'cwn-drive-key.json');
const DRIVE_FOLDER_NAME = 'CWN Videos';

// Cached Drive folder ID after first lookup
let _driveFolderId = null;

// ─── FUNCTIONS EXTRACTED FROM server.js ───────────────────────────────────
// getDriveClient            (was ~1691)
// getDriveFolderId          (was ~1722)
// uploadToDrive             (was ~1996)
// importToCanva             (was ~2033)
// readUploadStatus          (was ~5807)
// writeUploadStatus         (was ~5815)
// logUploadAttempt          (was ~5819)
// generateShortFormCaption  (was ~6079)
// handlePublish             (handler body from app.post /publish)
// handleGeneratePublishCopy (handler body from app.post /generate-publish-copy)

async function getDriveClient() {
  const { google } = require('googleapis');

  // ── Option 1: OAuth2 refresh token (preferred — uploads as the user) ──
  if (process.env.DRIVE_REFRESH_TOKEN) {
    const CLIENT_ID     = process.env.DRIVE_CLIENT_ID;
    const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET;
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.warn('[drive] OAuth2: set DRIVE_CLIENT_ID and DRIVE_CLIENT_SECRET alongside DRIVE_REFRESH_TOKEN (no repo defaults — see .env.example)');
    } else try {
      const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
      oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
      return google.drive({ version: 'v3', auth: oauth2Client });
    } catch (e) {
      console.warn('[drive] OAuth2 client failed:', e.message);
    }
  }

  // ── Option 2: Service account key file (legacy — may hit quota issues) ──
  if (!fs.existsSync(DRIVE_KEY_PATH)) return null;
  try {
    const key  = JSON.parse(fs.readFileSync(DRIVE_KEY_PATH, 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
  } catch(e) {
    console.warn('[drive] Service account failed:', e.message);
    return null;
  }
}


async function getDriveFolderId(drive) {
  if (_driveFolderId) return _driveFolderId;

  // If DRIVE_FOLDER_ID is set in .env, use it directly (recommended)
  // This ensures files go into YOUR Drive folder, not the service account's
  if (process.env.DRIVE_FOLDER_ID) {
    _driveFolderId = process.env.DRIVE_FOLDER_ID;
    console.log(`[drive] Using configured folder ID: ${_driveFolderId}`);
    return _driveFolderId;
  }

  // Fallback: search for shared folder by name
  // Note: service account must have been granted access to this folder
  const res = await drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });
  if (res.data.files && res.data.files.length) {
    _driveFolderId = res.data.files[0].id;
    console.log(`[drive] Found folder "${DRIVE_FOLDER_NAME}": ${_driveFolderId}`);
    return _driveFolderId;
  }

  // Last resort: upload to root (visible in service account's Drive only)
  console.warn('[drive] No folder found — uploading to root. Set DRIVE_FOLDER_ID in .env to fix.');
  return null; // null = Drive root
}


async function uploadToDrive(filePath, fileName, title) {
  const drive = await getDriveClient();
  if (!drive) return null; // key not configured yet

  const folderId = await getDriveFolderId(drive);
  console.log(`[drive] Uploading ${fileName} (${(fs.statSync(filePath).size/1024/1024).toFixed(1)}MB)...`);

  const fileMetadata = { name: title || fileName };
  if (folderId) fileMetadata.parents = [folderId];

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: {
      mimeType: ({'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.txt':'text/plain','.json':'application/json'})[require('path').extname(filePath).toLowerCase()] || 'application/octet-stream',
      body: fs.createReadStream(filePath)
    },
    fields: 'id, name, webContentLink, webViewLink',
    supportsAllDrives: true
  });

  const fileId = res.data.id;

  // Make publicly accessible (anyone with link can view/download)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });

  // Return direct download link — Canva can fetch this
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  console.log(`[drive] ✓ Uploaded: ${directUrl}`);
  return directUrl;
}


async function importToCanva(videoUrl, title) {
  // Uses Claude + Canva MCP to import the video
  const response = await callClaudeAPI({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: 'You are a production assistant. Use the Canva MCP tool to import a video from a URL into Canva. Call import-design-from-url with the URL. Return ONLY JSON: {"design_id":"...","url":"..."}. No other text.',
    messages: [{ role: 'user', content: `Import this video into Canva: ${videoUrl}\nTitle: ${title}` }],
    mcp_servers: [{ type: 'url', url: 'https://mcp.canva.com/mcp', name: 'canva-mcp' }]
  });
  const text  = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch(e) {
    console.warn(`[canva] JSON parse failed: ${e.message} - Raw: ${clean.slice(0, 100)}`);
    return null;
  }
}


function readUploadStatus() {
  try {
    return JSON.parse(fs.readFileSync(UPLOAD_STATUS_PATH, 'utf8'));
  } catch (e) {
    return { schema_version: '1.0', created: new Date().toISOString(), uploads: [] };
  }
}


function writeUploadStatus(db) {
  fs.writeFileSync(UPLOAD_STATUS_PATH, JSON.stringify(db, null, 2));
}


function logUploadAttempt(entry) {
  const db = readUploadStatus();
  db.uploads.unshift(entry); // newest first
  // Keep last 500 entries
  if (db.uploads.length > 500) db.uploads = db.uploads.slice(0, 500);
  writeUploadStatus(db);
}


/**
 * CPD-936 hardening: GPT-4o occasionally emits slightly-malformed JSON (trailing
 * commas, smart quotes) which killed publish copy entirely — fatal for scheduled
 * publishes where nobody is watching. Try strict parse, then light repair,
 * then one fresh model call.
 */
function _repairJson(raw) {
  return raw
    .replace(/[\u201c\u201d]/g, '"')        // smart double quotes
    .replace(/[\u2018\u2019]/g, "'")        // smart single quotes (inside strings is fine; keys use ")
    .replace(/,\s*([}\]])/g, '$1');          // trailing commas before } or ]
}

async function _generateMetadataJson(systemPrompt, label = 'publish-copy') {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 6000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate the metadata JSON now.' }
      ]
    });
    const text = (response.choices[0]?.message?.content || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { lastErr = new Error('Could not parse JSON from OpenAI response'); continue; }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e1) {
      try {
        const repaired = JSON.parse(_repairJson(jsonMatch[0]));
        console.warn(`[${label}] JSON repaired on attempt ${attempt} (${e1.message.slice(0, 80)})`);
        return repaired;
      } catch (e2) {
        lastErr = e1;
        console.warn(`[${label}] JSON parse failed on attempt ${attempt}: ${e1.message.slice(0, 100)}${attempt < 2 ? ' — retrying with a fresh model call' : ''}`);
      }
    }
  }
  throw lastErr || new Error('metadata JSON generation failed');
}

async function generateShortFormCaption(script, contentType) {
  const excerpt = script.substring(0, 400);
  const base = (contentType || '').replace(/-short$/, '');

  const typeLabel = {
    nba: 'NBA highlights',
    sports: 'sports highlights',
    news: 'world news',
    twitch: 'Twitch clips',
    clips: 'Twitch clips',
  }[base] || 'short-form highlights';

  const systemPrompt = `You write ultra-short social captions for ClipzWorld News short-form vertical videos (≤90 seconds).

Content type: ${typeLabel}
TikTok profile: ${CHANNEL_SOCIAL.tiktok.url} (${CHANNEL_SOCIAL.tiktok.handle})
Instagram profile: ${CHANNEL_SOCIAL.instagram.url}
YouTube: ${CHANNEL_SOCIAL.youtube.url}

Script excerpt:
${excerpt}...

Generate a JSON object with exactly these fields:
{
  "caption": "90-150 char hook with 1-2 emojis, punchy, no hashtags inline",
  "hashtags": ["array", "of", "15-20", "tags", "no", "hash", "symbol"],
  "altText": "1-sentence accessibility description of the video content, plain English, no emojis"
}

Rules:
- caption: 90-150 chars, starts with the most compelling fact or hook — describe the moment, do NOT lead with the streamer's name (they're already in the video)
- For Twitch clips: standalone Short compilation on ClipzWorld News — never mention "Twitch Soup" or frame as a hosted show episode
- NEVER mention file paths, HTML files, or internal tool names
- For sports: describe the actual play/moment — do NOT call ESPN/NHL footage "Twitch"
- hashtags: 15-20 tags — REQUIRED mix:
  (1) discovery: FYP, ForYou, ForYouPage, Viral, ViralVideo
  (2) niche: TwitchClips, TwitchHighlights, StreamerFails, Gaming, LiveStream
  (3) topic-specific: streamer names (no spaces), moment keywords from script
  (4) brand: ClipzWorldNews
  No # prefix in array values; no duplicate tags
- altText: screen-reader friendly
- Output ONLY valid JSON, no markdown`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 400,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Generate the short-form caption JSON now.' }
    ]
  });

  const text = (response.choices[0]?.message?.content || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('generateShortFormCaption: could not parse JSON from OpenAI');

  const result = JSON.parse(jsonMatch[0]);
  // Normalise hashtags — strip any accidental # prefix
  if (Array.isArray(result.hashtags)) {
    result.hashtags = result.hashtags.map(h => h.replace(/^#/, ''));
  }
  return result;
}


async function handlePublish(req, res) {
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipzworldnews';
  const {
    driveUrl,
    filename,
    platforms = ['youtube'],
    title = 'ClipzWorld News — The Daily Update',
    description = '',
    tags = [],
    scheduledAt,
    privacyStatus = 'private',           // YouTube: 'public' | 'private' | 'unlisted'
    tiktokPrivacy = 'SELF_ONLY', // TikTok: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS'
    contentType = 'long',
    jobType,
    isAigc,
    heygenUsed,
    async: asyncUpload = true,
    metricsJobId  // Optional: if frontend passes the jobId from script gen or assembly
  } = req.body;

  const jobId = metricsJobId || `publish_${Date.now()}`;
  if (!metricsJobId) initJobMetrics(jobId);

  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;

  function failValidation(code, message, httpStatus = 400) {
    const msg = String(message || code).slice(0, 800);
    try {
      pipelineBus.emit('publish:failed_validation', { jobId, code, message: msg });
    } catch (_e) { /* non-fatal */ }
    try {
      whyLedger.recordWhyLedger({
        jobId,
        gate: 'gate5',
        kind: 'publish_validation_failure',
        passed: false,
        outcome: code,
        reasons: [msg.slice(0, 500)],
        interventionType: whyLedger.INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        evidenceDigest: { httpStatus },
        source: 'lib/publish:handlePublish:validation',
      });
    } catch (_w) { /* non-fatal */ }
    try {
      nrPipelineEvent('UploadPostPublishValidationFail', { jobId, code, message: msg.slice(0, 240) });
    } catch (_n) { /* non-fatal */ }
    return res.status(httpStatus).json({ error: msg, code });
  }

  if (!UPLOADPOST_API_KEY) {
    return failValidation('missing_uploadpost_api_key', 'UPLOADPOST_API_KEY not set in .env', 400);
  }
  if (!driveUrl && !filename) {
    return failValidation('missing_drive_or_filename', 'driveUrl or filename required', 400);
  }

  const videoUrl = driveUrl || null;
  if (!videoUrl) {
    return failValidation('missing_drive_url', 'driveUrl required — Upload-Post needs a public URL', 400);
  }

  const publishTimer = new StageTimer(jobId, 'Upload-Post Publish');

  console.log(`[upload-post] Publishing to: ${platforms.join(', ')}`);
  console.log(`[upload-post] Video URL: ${videoUrl}`);
  console.log(`[upload-post] Title: ${title}`);
  if (scheduledAt) console.log(`[upload-post] Scheduled: ${scheduledAt}`);

  try {
    try {
      pipelineBus.emit('publish:submit', {
        jobId,
        platforms: platforms.join(','),
        contentType,
        scheduled: !!scheduledAt,
      });
    } catch (_e) { /* non-fatal */ }
    const FormData = require('form-data');
    const form = new FormData();

    form.append('user', UPLOADPOST_PROFILE);
    form.append('video', videoUrl);  // Upload-Post accepts URL directly
    form.append('title', title);
    if (description) form.append('description', description);
    if (asyncUpload) form.append('async_upload', 'true');

    // Add platforms
    platforms.forEach(p => form.append('platform[]', p));

    const synthetic = resolveSyntheticMediaFlags({
      jobType: jobType || contentType,
      contentType,
      isAigc,
      heygenUsed,
    });

    // YouTube-specific
    if (platforms.includes('youtube')) {
      const ytTitle = contentType === 'short' ? title + ' #Shorts' : title;
      form.append('youtube_title', ytTitle);
      form.append('youtube_description', description || title);
      if (tags.length) tags.forEach(t => form.append('tags[]', t));
      form.append('privacyStatus', privacyStatus || 'private');
      form.append('categoryId', '24'); // Entertainment
      form.append('containsSyntheticMedia', synthetic.containsSyntheticMedia ? 'true' : 'false');
      form.append('madeForKids', 'false');
      // Thumbnail URL if provided
      if (req.body.thumbnailUrl) form.append('thumbnail_url', req.body.thumbnailUrl);
      // Pinned first comment if provided
      if (req.body.pinnedComment) form.append('first_comment', req.body.pinnedComment);
    }

    // Instagram-specific
    if (platforms.includes('instagram')) {
      form.append('media_type', contentType === 'short' ? 'REELS' : 'REELS');
      form.append('instagram_title', description || title);
    }

    // TikTok-specific
    if (platforms.includes('tiktok')) {
      form.append('tiktok_title', (title || '').substring(0, 90));
      form.append('privacy_level', tiktokPrivacy); // 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS'
      form.append('post_mode', 'DIRECT_POST');
      form.append('is_aigc', synthetic.isAigc ? 'true' : 'false');
      form.append('brand_content_toggle', 'false');
    }

    // Threads-specific
    if (platforms.includes('threads')) {
      form.append('threads_title', description || title);
    }

    // Schedule if requested
    if (scheduledAt) {
      form.append('scheduled_date', new Date(scheduledAt).toISOString());
    }

    try {
      nrPipelineEvent('UploadPostPublishSubmit', {
        jobId,
        pipelineStage: 'upload_post',
        source: 'publish_route',
        metricsJobId: jobId,
        platforms: platforms.join(','),
        platformCount: platforms.length,
        contentType,
        scheduled: !!scheduledAt
      });
    } catch (_e) { /* non-fatal */ }

    const response = await axios.post(
      'https://api.upload-post.com/api/upload',
      form,
      {
        headers: {
          'Authorization': `Apikey ${UPLOADPOST_API_KEY}`,
          ...form.getHeaders()
        },
        maxBodyLength: Infinity,
        timeout: 120000
      }
    );

    const { request_id, job_id, results } = response.data;
    try {
      nrPipelineEvent('UploadPostPublishAccepted', {
        jobId,
        pipelineStage: 'upload_post',
        source: 'publish_route',
        metricsJobId: jobId,
        request_id: request_id || null,
        job_id: job_id || null,
        platforms: platforms.join(',')
      });
    } catch (_e) { /* non-fatal */ }
    console.log(`[upload-post] ✅ Response received`);
    if (request_id) console.log(`[upload-post]    request_id: ${request_id}`);
    if (job_id) console.log(`[upload-post]    job_id: ${job_id} (scheduled)`);

    try {
      pipelineBus.emit('publish:accepted', {
        jobId,
        request_id: request_id || null,
        job_id: job_id || null,
        platforms: platforms.join(','),
      });
    } catch (_e) { /* non-fatal */ }

    // Finalize publish metrics
    publishTimer
      .addData('platforms', platforms.join(', '))
      .addData('platformCount', platforms.length)
      .addData('contentType', contentType)
      .addData('scheduled', !!scheduledAt)
      .addData('async', asyncUpload)
      .addData('request_id', request_id || null)
      .addData('job_id', job_id || null)
      .addData('success', true);

    addStageMetrics(jobId, publishTimer.end());
    if (!metricsJobId) finalizeJobMetrics(jobId);

    // Generate trackingId for this publish attempt
    const trackingId = `pub_${Date.now()}_${req.body.testId || 'manual'}`;

    // Log successful publish attempt to upload_status.json
    logUploadAttempt({
      id: Date.now(),
      trackingId,
      timestamp: new Date().toISOString(),
      status: 'submitted',
      platforms,
      title,
      contentType,
      driveUrl: videoUrl,
      request_id: request_id || null,
      job_id: job_id || null,
      scheduledAt: scheduledAt || null,
      metricsJobId: jobId
    });

    res.json({
      ok: true,
      trackingId,
      request_id,
      job_id,
      results,
      scheduledAt: scheduledAt || null,
      platforms,
      statusUrl: request_id
        ? `https://api.upload-post.com/api/uploadposts/status?request_id=${request_id}`
        : job_id
        ? `https://api.upload-post.com/api/uploadposts/status?job_id=${job_id}`
        : null,
      metricsJobId: jobId
    });

    // Fire-and-forget: poll Upload-Post per-platform status (Gap #17)
    if (request_id) {
      const rid = request_id;
      const apiKey = UPLOADPOST_API_KEY;
      setImmediate(() => {
        let attempts = 0;
        const maxAttempts = 10;
        const intervalMs = 30000;
        const poll = async () => {
          attempts++;
          try {
            const statusRes = await axios.get(
              `https://api.upload-post.com/api/uploadposts/status?request_id=${rid}`,
              { headers: { 'Authorization': `Apikey ${apiKey}` }, timeout: 10000 }
            );
            const { status, platforms: platformResults } = statusRes.data;
            const platformSummary = Array.isArray(platformResults)
              ? platformResults.map(p => ({
                platform: p.platform,
                status: p.status,
                hasUrl: !!p.url,
              }))
              : [];
            console.log(`[upload-post] Poll ${attempts}/${maxAttempts} — status: ${status}`);
            if (Array.isArray(platformResults)) {
              platformResults.forEach(p => {
                console.log(`[upload-post]   ${p.platform}: ${p.status}${p.url ? ' -> ' + p.url : ''}`);
              });
            }
            try {
              pipelineBus.emit('publish:poll_tick', {
                jobId,
                request_id: rid,
                attempt: attempts,
                maxAttempts,
                uploadPostStatus: status || null,
                platformSummary,
              });
            } catch (_e) { /* non-fatal */ }

            if (status === 'done' || status === 'completed' || status === 'failed') {
              try {
                pipelineBus.emit('publish:poll_terminal', {
                  jobId,
                  request_id: rid,
                  outcome: status === 'failed' ? 'failed' : 'completed',
                  attempts,
                  platformSummary,
                });
              } catch (_e2) { /* non-fatal */ }
              return;
            }
            if (attempts >= maxAttempts) {
              try {
                pipelineBus.emit('publish:poll_terminal', {
                  jobId,
                  request_id: rid,
                  outcome: 'timeout',
                  attempts,
                  maxAttempts,
                });
              } catch (_e3) { /* non-fatal */ }
              return;
            }
            setTimeout(poll, intervalMs);
          } catch (pollErr) {
            console.warn(`[upload-post] Polling warn (attempt ${attempts}): ${pollErr.message}`);
            try {
              pipelineBus.emit('publish:poll_tick', {
                jobId,
                request_id: rid,
                attempt: attempts,
                maxAttempts,
                uploadPostStatus: null,
                pollError: (pollErr.message || '').slice(0, 240),
              });
            } catch (_e) { /* non-fatal */ }
            if (attempts < maxAttempts) setTimeout(poll, intervalMs);
            else {
              try {
                pipelineBus.emit('publish:poll_terminal', {
                  jobId,
                  request_id: rid,
                  outcome: 'timeout',
                  attempts,
                  pollError: (pollErr.message || '').slice(0, 240),
                });
              } catch (_e4) { /* non-fatal */ }
            }
          }
        };
        setTimeout(poll, intervalMs);
      });
    }
  } catch(e) {
    const errData = e.response?.data;
    console.error('[upload-post] Publish failed:', e.message, errData || '');
    try {
      pipelineBus.emit('publish:failed', {
        jobId,
        error: (e.message || '').slice(0, 800),
        platforms: (platforms || []).join(','),
      });
    } catch (_e) { /* non-fatal */ }
    try {
      whyLedger.recordWhyLedger({
        jobId,
        gate: 'gate5',
        kind: 'publish_failure',
        passed: false,
        outcome: 'upload_post_http_error',
        reasons: [String(e.message || 'publish failed').slice(0, 500)],
        interventionType: whyLedger.INTERVENTION.NONE,
        interventionOutcome: 'blocked',
        evidenceDigest: { status: e.response?.status, errSnippet: JSON.stringify(errData || '').slice(0, 400) },
        source: 'lib/publish:handlePublish',
      });
    } catch (_w) { /* non-fatal */ }
    try {
      nrPipelineEvent('UploadPostPublishFail', {
        jobId,
        pipelineStage: 'upload_post',
        source: 'publish_route',
        metricsJobId: jobId,
        error: (e.message || '').slice(0, 500),
        platforms: (platforms || []).join(',')
      });
    } catch (_nr) { /* non-fatal */ }

    // Log failed publish attempt to upload_status.json
    logUploadAttempt({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      status: 'failed',
      platforms,
      title,
      contentType,
      driveUrl: videoUrl || driveUrl || null,
      error: e.message,
      metricsJobId: jobId
    });

    // Track failed publish
    publishTimer
      .addData('platforms', platforms.join(', '))
      .addData('platformCount', platforms.length)
      .addData('success', false)
      .addData('error', e.message);
    addStageMetrics(jobId, publishTimer.end());
    if (!metricsJobId) finalizeJobMetrics(jobId);

    res.status(500).json({ error: e.message, details: errData || null });
  }
}


/**
 * buildPublishCopySystemPrompt — shared YouTube Growth Strategist prompt (CPD-880).
 * Used by both handleGeneratePublishCopy (HTTP, assembly-time) and
 * generatePublishCopyFromScript (Gate 1 lock). Returns the system prompt string.
 *
 * The model FIRST classifies the content category (News / Sports / Twitch /
 * Podcast / Politics / Viral Entertainment) and optimizes all metadata for that
 * category's audience intent — a Trump speech and a Twitch fail clip have
 * completely different search behavior.
 */
/**
 * Index data/streamers.json for Twitch URL credits.
 * Shape on disk: { roster: [{ displayName, twitchUsername, ... }] }.
 * Indexed by BOTH twitchUsername and displayName (lowercased, no spaces) so
 * items carrying only a display name ("Jason") still resolve the real login
 * (jasontheween) instead of falling back to a guessed twitch.tv URL (CPD-962).
 */
/**
 * c0.json designDefaults.voice.showName values are ALL CAPS for on-screen chrome
 * ("TWITCH SOUP"). Descriptions are prose — convert to title case ("Twitch Soup")
 * with minor words lowercased ("Because the Light Was On"). Mixed-case values
 * pass through untouched.
 */
const TITLE_MINOR_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'or', 'so', 'the', 'to', 'yet']);

/** Canonical social profiles — Upload-Post + publish copy use these URLs. */
const CHANNEL_SOCIAL = {
  youtube:   { handle: '@clipzworldnews',    url: 'https://www.youtube.com/@clipzworldnews' },
  tiktok:    { handle: '@clipzworldstreams', url: 'https://www.tiktok.com/@clipzworldstreams' },
  instagram: { handle: '@clipzworldnews',    url: 'https://www.instagram.com/clipzworldnews/' },
};

function buildChannelConfig(showNames = {}) {
  const row = (showName) => ({
    showName,
    handle: CHANNEL_SOCIAL.youtube.handle,
    youtubeUrl: CHANNEL_SOCIAL.youtube.url,
    tiktokHandle: CHANNEL_SOCIAL.tiktok.handle,
    tiktokUrl: CHANNEL_SOCIAL.tiktok.url,
    instagramHandle: CHANNEL_SOCIAL.instagram.handle,
    instagramUrl: CHANNEL_SOCIAL.instagram.url,
    host: 'ClipzWorld News',
  });
  return {
    clips:  row(showNames.clips  || 'Twitch Soup'),
    sports: row(showNames.sports || 'Other Side of the Pillow'),
    news:   row(showNames.news   || 'Because the Light Was On'),
  };
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function countHashtagsInText(text) {
  return (String(text || '').match(/#\w+/g) || []).length;
}

function normalizeYoutubeTagToken(t) {
  return String(t || '').replace(/^#+/, '').replace(/[<>]/g, '').trim();
}

/** Discovery + niche tags used to fill the 490–500 char YouTube tag budget after GPT generation. */
const YOUTUBE_TAG_EXPANSION_BASE = [
  'twitch clips',
  'twitch highlights',
  'viral twitch',
  'streamer clips',
  'gaming clips',
  'funny twitch',
  'twitch fails',
  'twitch moments',
  'live stream highlights',
  'twitch compilation',
  'best twitch clips',
  'streamer highlights',
  'twitch shorts',
  'clipzworld',
  'clipzworld news',
  'twitch viral clips',
  'watch twitch',
  'twitch soup',
  'streamer drama',
  'gaming highlights',
  'twitch reactions',
  'live streaming',
  'twitch entertainer',
  'variety streamer',
  'twitch community',
  'gaming moments',
  'twitch funny moments',
  'stream fails',
  'viral gaming',
  'streamer news',
  'twitch news',
  'content creator',
  'youtube shorts gaming',
  'twitch clip compilation',
  'streamer moments',
  'twitch rage',
  'chaos stream',
  'twitch meta',
  'streaming platform',
];

const YOUTUBE_TAG_EXPANSION_BY_TYPE = {
  nba: ['nba highlights', 'basketball clips', 'nba shorts', 'nba news', 'nba moments'],
  news: ['breaking news', 'news shorts', 'news analysis', 'current events', 'news desk'],
  sports: ['sports highlights', 'sports clips', 'sports news', 'game highlights'],
};

const YOUTUBE_TAG_SUFFIXES = [' clips', ' highlights', ' moments', ' viral', ' compilation', ' fails', ' gaming'];

function buildYoutubeTagExpansionPool({ streamers = [], title = '', contentType = '' } = {}) {
  const ct = String(contentType || '').toLowerCase();
  const streamerTags = [];
  const titleTags = [];
  const typeTags = [];
  if (ct.includes('nba')) typeTags.push(...YOUTUBE_TAG_EXPANSION_BY_TYPE.nba);
  if (ct.includes('news')) typeTags.push(...YOUTUBE_TAG_EXPANSION_BY_TYPE.news);
  if (ct.includes('sport')) typeTags.push(...YOUTUBE_TAG_EXPANSION_BY_TYPE.sports);

  const names = streamers
    .map((s) => String(s?.login || s?.displayName || s || '').replace(/^@/, '').trim())
    .filter(Boolean);

  for (const name of names) {
    const lower = name.toLowerCase();
    const slug = lower.replace(/\s+/g, '');
    streamerTags.push(lower, slug, `${lower} twitch`, `${lower} clips`, `${slug} clips`, `${lower} highlights`);
  }

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i].toLowerCase();
      const b = names[j].toLowerCase();
      streamerTags.push(`${a} ${b}`, `${a} ${b} clips`, `${a} and ${b}`);
    }
  }

  const titleTokens = String(title || '')
    .replace(/#\w+/g, ' ')
    .split(/[\s:!?,—–\-|]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !/shorts?/i.test(w));
  for (const w of titleTokens.slice(0, 10)) {
    titleTags.push(w.toLowerCase());
  }

  return [...streamerTags, ...titleTags, ...typeTags, ...YOUTUBE_TAG_EXPANSION_BASE]
    .map(normalizeYoutubeTagToken)
    .filter(Boolean);
}

/**
 * Expand or trim YouTube tags to the 490–500 combined-char budget (plain join — matches metadata_qa).
 * Runs after GPT generation so operators never hand-pad tags before publish.
 */
function fillYoutubeTagsToBudget(tags, opts = {}) {
  const min = opts.min ?? YOUTUBE_TAGS_TARGET_MIN;
  const max = opts.max ?? YOUTUBE_TAGS_TARGET_MAX;
  let out = (Array.isArray(tags) ? tags : [])
    .map(normalizeYoutubeTagToken)
    .filter(Boolean);
  out = [...new Set(out)];

  while (out.length && youtubeTagsCombinedLength(out) > max) {
    out.pop();
  }

  let total = youtubeTagsCombinedLength(out);
  if (total >= min && total <= max) return out;

  const pool = buildYoutubeTagExpansionPool(opts);
  for (const candidate of pool) {
    if (out.includes(candidate)) continue;
    const nextTotal = total + candidate.length;
    if (nextTotal > max) continue;
    out.push(candidate);
    total = nextTotal;
    if (total >= min) return out;
  }

  let guard = 0;
  while (total < min && guard++ < 120) {
    let extended = false;
    for (let i = out.length - 1; i >= 0; i--) {
      for (const suf of YOUTUBE_TAG_SUFFIXES) {
        const candidate = out[i] + suf;
        if (out.includes(candidate)) continue;
        const nextTotal = total + candidate.length;
        if (nextTotal > max) continue;
        out.push(candidate);
        total = nextTotal;
        extended = true;
        if (total >= min) return out;
        break;
      }
      if (extended) break;
    }
    if (!extended) break;
  }

  return out;
}

/** Append 3-5 hashtags to YT description when model left them in the array only. */
function appendHashtagsToDescription(description, hashtags = []) {
  let desc = String(description || '').trim();
  if (countHashtagsInText(desc) >= 3) return desc;
  const tags = hashtags
    .map((h) => (String(h).startsWith('#') ? String(h) : `#${String(h).replace(/^#/, '')}`))
    .filter(Boolean);
  const unique = [...new Set(tags)];
  if (!unique.length) return desc;
  return `${desc}\n\n${unique.slice(0, 5).join(' ')}`.trim();
}

function appendSocialLinksBlock(description, cc = {}) {
  let desc = String(description || '').trim();
  const needsTt = cc.tiktokUrl && !/tiktok\.com/i.test(desc);
  const needsIg = cc.instagramUrl && !/instagram\.com/i.test(desc);
  const needsYt = cc.youtubeUrl && !/youtube\.com/i.test(desc);
  if (!needsTt && !needsIg && !needsYt) return desc;
  const lines = ['\n\n🔗 Follow ClipzWorld News:'];
  if (needsYt) lines.push(`YouTube: ${cc.youtubeUrl}`);
  if (needsTt) lines.push(`TikTok: ${cc.tiktokUrl}`);
  if (needsIg) lines.push(`Instagram: ${cc.instagramUrl}`);
  return `${desc}${lines.join('\n')}`.trim();
}

/** Normalize a hashtag token (no #, no spaces). */
function normalizeHashtagToken(tag) {
  return String(tag || '').replace(/^#/, '').replace(/\s+/g, '').slice(0, 40);
}

/** Discovery + niche hashtags for TikTok / Instagram Reels. */
const SOCIAL_DISCOVERY_HASHTAGS = [
  'FYP', 'ForYou', 'ForYouPage', 'Viral', 'ViralVideo', 'Twitch', 'TwitchClips',
  'TwitchHighlights', 'Streamer', 'StreamerFails', 'Gaming', 'LiveStream', 'ClipzWorldNews',
];

function streamerHashtagTokens(streamers = []) {
  return [...new Set(
    streamers
      .map((s) => (typeof s === 'string' ? s : (s.displayName || s.streamer || s.username || '')))
      .filter(Boolean)
      .map((name) => normalizeHashtagToken(name.split(/\s+/)[0]))
      .filter((t) => t.length > 2)
  )];
}

/**
 * Build a ranked hashtag pack for TikTok + Instagram (15-20 tags).
 */
function buildSocialHashtagPack({ streamers = [], ytHashtags = [], contentType = 'twitch', max = 20 } = {}) {
  const base = contentType.includes('sport') || contentType.includes('nba')
    ? ['SportsHighlights', 'SportsShorts', 'NBA', 'Highlights', ...SOCIAL_DISCOVERY_HASHTAGS]
    : contentType.includes('news')
      ? ['BreakingNews', 'WorldNews', 'NewsShorts', ...SOCIAL_DISCOVERY_HASHTAGS]
      : ['TwitchMoments', 'FunnyMoments', 'GamingClips', 'Streaming', ...SOCIAL_DISCOVERY_HASHTAGS];

  const fromYt = (ytHashtags || []).map(normalizeHashtagToken).filter(Boolean);
  const merged = [...new Set([
    ...streamerHashtagTokens(streamers),
    ...fromYt,
    ...base,
  ].map(normalizeHashtagToken).filter(Boolean))];

  return merged.slice(0, max);
}

function formatHashtagLine(tags = []) {
  return tags.map((t) => `#${normalizeHashtagToken(t)}`).filter((h) => h.length > 1).join(' ');
}

function countHashtagsInCaption(text) {
  return (String(text || '').match(/#[\w]+/g) || []).length;
}

const TIKTOK_VISIBLE_CAPTION_MAX = 300;
const TIKTOK_HASHTAG_COUNT = 5;

/** TikTok: short hook + CTA + 3-5 hashtags. No URLs, no YT description paste. */
function buildTikTokCaption({ hook, hashtags = [] } = {}) {
  const hookLine = String(hook || '')
    .replace(/#\w+/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(' ')
    .slice(0, 120);
  const tagLine = formatHashtagLine(hashtags.slice(0, TIKTOK_HASHTAG_COUNT));
  const cta = 'Follow for more Twitch clips';
  let caption = [hookLine, cta, tagLine].filter(Boolean).join('\n\n');
  if (caption.length > TIKTOK_VISIBLE_CAPTION_MAX) {
    const overhead = caption.length - hookLine.length + 1;
    const maxHook = Math.max(40, TIKTOK_VISIBLE_CAPTION_MAX - overhead);
    const trimmedHook = hookLine.slice(0, maxHook).replace(/\s+\S*$/, '').trim();
    caption = [trimmedHook, cta, tagLine].filter(Boolean).join('\n\n');
  }
  return caption.slice(0, TIKTOK_VISIBLE_CAPTION_MAX);
}

/** Instagram Reels: hook + synopsis (first 125 chars matter) + 15-20 hashtags + profile URL. */
function buildInstagramCaption({ hook, synopsis = '', hashtags = [], cc = {} } = {}) {
  const hookLine = String(hook || '').replace(/#\w+/g, '').trim();
  const syn = String(synopsis || '').replace(/#\w+/g, '').trim().split('\n')[0].slice(0, 280);
  const tagLine = formatHashtagLine(hashtags.slice(0, 20));
  const url = cc.instagramUrl || CHANNEL_SOCIAL.instagram.url;
  return `${hookLine}\n\n${syn}\n\n${tagLine}\n\n${url}`;
}

/** Rebuild TikTok + Instagram captions for shorts — never reuse raw YouTube description. */
function finalizeShortSocialCaptions(metadata, { streamers = [], cc = {}, contentType = 'twitch' } = {}) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const yt = metadata.youtube || metadata.platforms?.youtube || {};
  const hook = momentHookForSocial(
    metadata.hookMoment || yt.bestTitle?.title || yt.title || '',
    streamers,
  );
  const ytTags = (yt.hashtags || []).map((h) => String(h).replace(/^#/, ''));
  const tiktokTags = buildSocialHashtagPack({ streamers, ytHashtags: ytTags, contentType, max: TIKTOK_HASHTAG_COUNT });
  const igTags = buildSocialHashtagPack({ streamers, ytHashtags: ytTags, contentType, max: 22 });
  const synopsis = (yt.description || '').split('\n\n')[0] || '';

  if (!metadata.tiktok) metadata.tiktok = {};
  if (!metadata.instagram) metadata.instagram = {};

  metadata.tiktok.caption = buildTikTokCaption({ hook, hashtags: tiktokTags });
  metadata.instagram.caption = buildInstagramCaption({ hook, synopsis, hashtags: igTags, cc });
  metadata.tiktok.hashtagCount = countHashtagsInCaption(metadata.tiktok.caption);
  metadata.instagram.hashtagCount = countHashtagsInCaption(metadata.instagram.caption);

  const altBase = hook.replace(/#\w+/g, '').trim() || 'Twitch streamer highlight clip';
  if (!metadata.instagram.altText) metadata.instagram.altText = altBase.slice(0, 120);
  if (yt && !yt.altText) yt.altText = metadata.instagram.altText;

  return metadata;
}

function isTwitchClipShort(contentType, isShort = false) {
  if (!isShort) return false;
  const ct = String(contentType || '');
  return ct.includes('twitch') || ct === 'clips' || ct.includes('streamer');
}

/** Strip long-form show framing from twitch clip Short copy — comps are not Twitch Soup episodes. */
function sanitizeTwitchClipShortCopy(text) {
  let t = String(text || '');
  t = t.replace(
    /Watch ([^.]+?) in this Twitch clips compilation from Twitch Soup\./gi,
    'Highlights from $1 in this Twitch clips Short on ClipzWorld News.',
  );
  t = t.replace(/Watch ([^.]+?) in this Twitch clips compilation from [^.]+\./gi, (m, names) => {
    if (/twitch soup/i.test(m)) return m;
    return `Highlights from ${names} in this Twitch clips Short on ClipzWorld News.`;
  });
  const stripPhrases = [
    /\bWelcome to Twitch Soup by ClipzWorld News[^.]*\./gi,
    /\bfrom Twitch Soup\b/gi,
    /\bon Twitch Soup\b/gi,
    /\bthis Twitch Soup episode\b/gi,
    /\bTwitch Soup episode[s]?\b/gi,
    /\bpresented by Twitch Soup\b/gi,
    /\bHosted by: Bobby G\b/gi,
  ];
  for (const re of stripPhrases) t = t.replace(re, '');
  return t
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function expandShortDescriptionIfNeeded(desc, { streamers = [], cc = {}, isShort = false, contentType = '' } = {}) {
  let text = String(desc || '').trim();
  const twitchClipShort = isTwitchClipShort(contentType, isShort);
  if (twitchClipShort) text = sanitizeTwitchClipShortCopy(text);
  if (!isShort || countWords(text) >= 125) return text;
  const names = (streamers || [])
    .map((s) => (typeof s === 'string' ? s : (s.displayName || s.streamer || s.username || '')))
    .filter(Boolean);
  const namesStr = names.length ? names.join(', ') : 'today\'s featured streamers';
  const filler = twitchClipShort
    ? [
      `This YouTube Short packs viral highlights from ${namesStr} — unexpected reactions, funny moments, and chat chaos from their recent streams.`,
      'ClipzWorld News curates the best Twitch clips into quick vertical compilations so you catch the moment without watching hours of VOD footage.',
      'From wild stream reactions to hilarious chat moments, this Short delivers multiple standout clips in one fast watch.',
      'Follow @clipzworldnews for daily streamer highlights, gaming chaos, and viral moments from the biggest names on Twitch.',
      'Subscribe on YouTube, follow us on TikTok and Instagram for more clips, and comment with your favorite moment from this Short.',
      'Ring the bell so you never miss the next viral Twitch clip compilation.',
      'New Shorts drop regularly with the funniest fails, reactions, and unscripted moments from live streaming.',
    ].join('\n\n')
    : [
      `Watch ${namesStr} in this Twitch clips compilation from ${cc.showName || 'ClipzWorld News'}.`,
      'We break down the funniest, most shocking, and viral moments so you do not miss what happened live on stream.',
      'From unexpected reactions to hilarious chat moments, this Short packs multiple highlights into one quick watch.',
      'ClipzWorld News curates daily Twitch highlights for viewers who want the story without watching hours of VOD footage.',
      'Follow for more streamer reactions, gaming chaos, and viral moments from the biggest names on Twitch.',
      'Like, subscribe, and ring the bell so you never miss our next compilation.',
    ].join('\n\n');
  return `${text}\n\n${filler}`.trim();
}

function titleMentionsStreamer(title, streamers = []) {
  const titleLower = String(title || '').toLowerCase();
  return streamers.some((s) => {
    const token = String(s).toLowerCase().split(/\s+/)[0];
    return token.length > 2 && titleLower.includes(token);
  });
}

function ensureStreamerInTitle(title, streamers = []) {
  const t = String(title || '').trim();
  if (!t || !streamers.length) return t;
  const first = typeof streamers[0] === 'string' ? streamers[0] : (streamers[0].displayName || streamers[0].streamer || '');
  if (!first) return t;
  const token = first.split(/\s+/)[0];
  if (t.toLowerCase().includes(token.toLowerCase())) return t;
  const merged = `${first}: ${t}`;
  return merged.length > 100 ? merged.slice(0, 97) + '...' : merged;
}

/** Remove roster lead "streamer: " prefix — YT titles are rewritten headlines, not burned captions. */
function stripRosterColonPrefix(title, streamers = []) {
  let t = String(title || '').trim();
  if (!t || !streamers.length) return t;
  for (const s of streamers) {
    const name = typeof s === 'string' ? s : (s.displayName || s.streamer || s.twitchUsername || '');
    const token = String(name || '').split(/\s+/)[0];
    if (!token || token.length < 2) continue;
    const re = new RegExp(`^${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i');
    if (re.test(t)) return t.replace(re, '').trim();
  }
  return t;
}

function normalizeClipCompYoutubeTitle(title, streamers = []) {
  return stripRosterColonPrefix(title, streamers);
}

/** YT Short title: no "Name:" prefix; must still include streamer login for SEO QA. */
function ensureStreamerInClipCompTitle(title, streamers = []) {
  let t = normalizeClipCompYoutubeTitle(title, streamers);
  if (!t || !streamers.length) return t;
  if (titleMentionsStreamer(t, streamers)) return t;
  const first = typeof streamers[0] === 'string' ? streamers[0] : (streamers[0].displayName || streamers[0].streamer || '');
  const token = String(first || '').split(/\s+/)[0];
  if (!token) return t;
  t = t.replace(/^streamer'?s?\s+/i, '').trim();
  const merged = `${token}'s ${t}`;
  return merged.length > 100 ? merged.slice(0, 97) + '...' : merged;
}

/** Social / TikTok hook line — moment beat only, no streamer name lead-in. */
function momentHookForSocial(text, streamers = []) {
  let h = stripRosterColonPrefix(String(text || '').trim(), streamers);
  for (const s of streamers) {
    const name = typeof s === 'string' ? s : (s.displayName || s.streamer || '');
    const token = String(name || '').split(/\s+/)[0];
    if (!token || token.length < 2) continue;
    const possessive = new RegExp(`^${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s\\s+`, 'i');
    h = h.replace(possessive, '').trim();
  }
  return h.replace(/#\w+/g, '').replace(/\s+#Shorts\s*$/i, '').trim();
}

/** Fill gaps so metadata QA passes before operator review. */
function applyClipCompYoutubeTitles(metadata, streamers, fixFn) {
  const seen = new Set();
  const touch = (yt) => {
    if (!yt || typeof yt !== 'object' || seen.has(yt)) return;
    seen.add(yt);
    const base = yt.bestTitle?.title || yt.title || (Array.isArray(yt.titles) && yt.titles[0]) || '';
    const fixed = fixFn(base, streamers);
    yt.title = fixed;
    if (yt.bestTitle?.title) yt.bestTitle.title = fixFn(yt.bestTitle.title, streamers);
    if (Array.isArray(yt.titles)) {
      yt.titles = yt.titles.map((t) => fixFn(String(t || '').replace(/\s+#Shorts\s*$/i, ''), streamers));
      if (yt.titles[0] && !/#Shorts/i.test(yt.titles[0])) yt.titles[0] = `${yt.titles[0]} #Shorts`;
    }
  };
  touch(metadata.platforms?.youtube);
  touch(metadata.youtube);
  if (typeof metadata.youtube === 'string') {
    const bare = metadata.youtube.replace(/\s+#Shorts\s*$/i, '').trim();
    metadata.youtube = `${fixFn(bare, streamers)} #Shorts`.trim();
  }
}

function ensurePublishMetadataComplete(metadata, { streamers = [], cc = {}, isShort = false, clipCount = 0 } = {}) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const flat = normalizePublishCopyShape(metadata);
  Object.assign(metadata, flat);
  if (!metadata.youtube || typeof metadata.youtube === 'string') {
    if (metadata.platforms?.youtube) metadata.youtube = metadata.platforms.youtube;
    else if (!metadata.youtube) metadata.youtube = {};
  }
  const yt = typeof metadata.youtube === 'object' ? metadata.youtube : (metadata.platforms?.youtube || {});
  const baseTitle = yt.bestTitle?.title || yt.title || (Array.isArray(yt.titles) && yt.titles[0]) || 'Twitch Clips #Shorts';
  const isTwitchShort = isShort && String(metadata.contentType || '').includes('twitch');
  const multiClipComp = isShort && clipCount >= 2;
  const { appendClipCompTitleSuffix } = require('./clip_comp');
  const wrapTitleFix = (fixFn) => (title, strs) => {
    let fixed = fixFn(title, strs);
    if (multiClipComp) fixed = appendClipCompTitleSuffix(fixed, { clipCount });
    return fixed;
  };
  if (isTwitchShort) {
    applyClipCompYoutubeTitles(metadata, streamers, wrapTitleFix(ensureStreamerInClipCompTitle));
  } else {
    applyClipCompYoutubeTitles(metadata, streamers, wrapTitleFix(ensureStreamerInTitle));
  }
  const ytFinal = typeof metadata.youtube === 'object' ? metadata.youtube : metadata.platforms?.youtube;
  if (ytFinal && Array.isArray(ytFinal.titles) && ytFinal.titles[0]) ytFinal.title = ytFinal.titles[0];

  finalizeYoutubePublishMetadata(ytFinal || yt, cc, {
    streamers,
    isShort,
    contentType: metadata.contentType || (isTwitchShort ? 'twitch-short' : ''),
  });

  if (!metadata.tiktok) metadata.tiktok = {};
  if (!metadata.instagram) metadata.instagram = {};

  if (isShort) {
    finalizeShortSocialCaptions(metadata, {
      streamers,
      cc,
      contentType: metadata.contentType || 'twitch',
    });
  } else {
    const hook = yt.title.replace(/#\w+/g, '').trim();
    const descSnippet = (yt.description || '').split('\n')[0].slice(0, 200);
    if (!metadata.tiktok.caption || metadata.tiktok.caption.length < 40) {
      metadata.tiktok.caption = `${hook}\n\n${cc.tiktokUrl || CHANNEL_SOCIAL.tiktok.url}`;
    }
    if (!metadata.instagram.caption || metadata.instagram.caption.length < 40) {
      metadata.instagram.caption = descSnippet || hook;
    }
    const altBase = hook || 'Twitch streamer highlight clip';
    if (!metadata.instagram.altText) metadata.instagram.altText = altBase.slice(0, 120);
    if (!yt.altText) yt.altText = metadata.instagram.altText;
    finalizePlatformCaptions(metadata, cc);
  }

  return metadata;
}

function finalizeYoutubePublishMetadata(yt, cc = {}, opts = {}) {
  if (!yt) return;
  let desc = normalizeDescriptionNewlines(yt.description || '');
  if (isTwitchClipShort(opts.contentType, opts.isShort)) {
    desc = sanitizeTwitchClipShortCopy(desc);
  }
  desc = expandShortDescriptionIfNeeded(desc, {
    streamers: opts.streamers || [],
    cc,
    isShort: opts.isShort,
    contentType: opts.contentType,
  });
  const ct = String(opts.contentType || '');
  const isTwitchContent = ct.includes('twitch') || ct === 'clips' || ct.includes('streamer');
  if (isTwitchContent && (opts.streamers || []).length) {
    desc = appendFeaturedStreamersBlock(desc, opts.streamers);
  }
  if (!Array.isArray(yt.hashtags) || yt.hashtags.length < 3) {
    yt.hashtags = ['#Shorts', '#TwitchClips', '#FYP', '#StreamerLife', '#ClipzWorldNews'];
  }
  desc = appendSocialLinksBlock(desc, cc);
  desc = appendHashtagsToDescription(desc, yt.hashtags);
  yt.description = normalizeDescriptionNewlines(desc);
  yt.descriptionLength = desc.length;
  yt.wordCount = countWords(desc);
  yt.hashtagCount = countHashtagsInText(desc);
  yt.tags = fillYoutubeTagsToBudget(yt.tags, {
    streamers: opts.streamers || [],
    title: yt.title || yt.bestTitle?.title || (Array.isArray(yt.titles) && yt.titles[0]) || '',
    contentType: opts.contentType || '',
  });
  yt.tagsCount = yt.tags.length;
  yt.tagsCharTotal = youtubeTagsCombinedLength(yt.tags);
}

function finalizePlatformCaptions(metadata, cc = {}) {
  if (metadata.tiktok?.caption && cc.tiktokUrl && !/tiktok\.com/i.test(metadata.tiktok.caption)) {
    metadata.tiktok.caption = `${metadata.tiktok.caption.trim()}\n\n${cc.tiktokUrl}`;
  }
  if (metadata.instagram?.caption && cc.instagramUrl && !/instagram\.com/i.test(metadata.instagram.caption)) {
    metadata.instagram.caption = `${metadata.instagram.caption.trim()}\n\n${cc.instagramUrl}`;
  }
}

/** Reject internal paths / template filenames masquerading as show names. */
function isInvalidShowName(name) {
  if (!name || typeof name !== 'string') return true;
  return /\.(html|js|tsx|json|md)\b/i.test(name)
    || /\btools\//i.test(name)
    || /\blib\//i.test(name)
    || name.includes('\\');
}

function normalizeShowName(name) {
  if (!name || isInvalidShowName(name)) return null;
  if (name !== name.toUpperCase()) return name;
  const words = name.toLowerCase().split(/\s+/);
  return words.map((w, i) => {
    if (i > 0 && i < words.length - 1 && TITLE_MINOR_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

/** Strip file paths and internal tool references from publish-facing strings. */
function sanitizePublishText(text, cc = {}) {
  if (!text || typeof text !== 'string') return text;
  const handle = cc.handle || '@clipzworldnews';
  return text
    .split('\n')
    .map((line) => line
      .replace(/\bOnly on\s+(?:tools\/|lib\/)?[\w./-]+\.(html|js|tsx|json)\b/gi, `Follow ${handle}`)
      .replace(/(?:^|\s)(?:tools\/|lib\/|\.\/)[\w./-]+\.(html|js|tsx|json)\b/gi, ` ${handle}`)
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    .join('\n')
    .trim();
}

/** Apply sanitization across all publish metadata fields GPT may populate. */
function sanitizePublishMetadata(metadata, cc = {}) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const yt = metadata.youtube;
  if (yt) {
    if (yt.title) yt.title = sanitizePublishText(yt.title, cc);
    if (yt.description) yt.description = sanitizePublishText(yt.description, cc);
    if (Array.isArray(yt.titles)) yt.titles = yt.titles.map(t => sanitizePublishText(t, cc));
    if (Array.isArray(yt.tags)) yt.tags = yt.tags.map(t => sanitizePublishText(t, cc));
    if (Array.isArray(yt.hashtags)) yt.hashtags = yt.hashtags.map(h => sanitizePublishText(h, cc));
  }
  if (metadata.tiktok?.caption) metadata.tiktok.caption = sanitizePublishText(metadata.tiktok.caption, cc);
  if (metadata.instagram?.caption) metadata.instagram.caption = sanitizePublishText(metadata.instagram.caption, cc);
  return metadata;
}

function loadStreamerRoster() {
  const streamerRoster = {};
  try {
    const rosterRaw = require('fs').readFileSync(require('path').join(__dirname, '../data/streamers.json'), 'utf8');
    const parsed = JSON.parse(rosterRaw);
    const rosterArr = Array.isArray(parsed) ? parsed : (parsed.roster || []);
    for (const s of rosterArr) {
      const login = s.twitchUsername || s.username;
      if (!login) continue;
      const entry = { ...s, username: login };
      streamerRoster[login.toLowerCase()] = entry;
      if (s.displayName) streamerRoster[s.displayName.toLowerCase().replace(/\s+/g, '')] = entry;
    }
  } catch (e) {
    // non-fatal — streamer URLs will be omitted
  }
  return streamerRoster;
}

/** Unescape literal \\n from GPT JSON and normalize paragraph breaks. */
function normalizeDescriptionNewlines(text) {
  let t = String(text || '');
  t = t.replace(/\\n/g, '\n');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/\n{4,}/g, '\n\n');
  return t.trim();
}

/** Resolve display name + canonical twitch.tv URL for each featured streamer. */
function buildStreamerCreditLines(streamers = [], roster = null) {
  const streamerRoster = roster || loadStreamerRoster();
  const lines = [];
  const seen = new Set();
  for (const s of streamers) {
    const rawName = typeof s === 'string' ? s : (s.displayName || s.streamer || s.twitchUsername || s.title || '');
    const loginGuess = typeof s === 'object' && (s.twitchUsername || s.streamer)
      ? (s.twitchUsername || s.streamer)
      : rawName;
    const key = String(loginGuess || rawName).toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = streamerRoster[key];
    const username = (entry?.username || key).toLowerCase().replace(/^@/, '');
    const display = typeof s === 'object' && s.displayName
      ? s.displayName
      : (entry?.displayName || rawName || username);
    lines.push({
      display,
      username,
      url: `https://www.twitch.tv/${username}`,
    });
  }
  return lines;
}

function formatFeaturedStreamersBlock(creditLines = []) {
  if (!creditLines.length) return '';
  const body = creditLines.map(({ display, url }) => `${display}\n${url}`).join('\n');
  return `\n\n🎮 Featured Streamers (Support Them 💜)\n${body}`;
}

/** Prompt block — bullet list for GPT context. */
function buildStreamerCreditsPromptBlock(streamers = [], roster = null) {
  return buildStreamerCreditLines(streamers, roster)
    .map(({ display, url }) => `• ${display}: ${url}`)
    .join('\n');
}

function descriptionIncludesAllTwitchUrls(description, creditLines = []) {
  const desc = String(description || '');
  return creditLines.every(({ username }) =>
    new RegExp(`twitch\\.tv/${escapeRegExp(username)}`, 'i').test(desc)
  );
}

/** Append Featured Streamers block when GPT omitted URLs or used a wall of text. */
function appendFeaturedStreamersBlock(description, streamers = []) {
  let desc = normalizeDescriptionNewlines(description);
  const credits = buildStreamerCreditLines(streamers);
  if (!credits.length) return desc;
  if (descriptionIncludesAllTwitchUrls(desc, credits)) return desc;

  const block = formatFeaturedStreamersBlock(credits);
  const socialIdx = desc.search(/\n\n🔗 Follow ClipzWorld|\n🔥 Hashtags:|\n\n#/i);
  if (socialIdx > 0) {
    return `${desc.slice(0, socialIdx).trim()}${block}${desc.slice(socialIdx)}`.trim();
  }
  return `${desc}${block}`.trim();
}

function buildPublishCopySystemPrompt({
  cc,                  // channel config { showName, handle, host }
  cd,                  // content descriptor string
  date,
  isShort,
  epLabel = '',
  scriptExcerpt,
  streamerCredits = '',
  chaptersBlock = '',
  contentType,
  itemCount = 0,
  needsTikTok = false,
  needsInstagram = false,
  clipCompBrief = null,
}) {
  // Content-type-specific guidance (kept from prior prompt — proven patterns)
  const nbaSeoGuidance = (contentType === 'nba' || contentType === 'sports') ? `
SPORTS SEO GUIDANCE (apply these patterns):
- Titles: name the sport/league/teams/athletes actually in the clip — NOT "Twitch" unless streamers are featured
- For NHL/NBA/boxing/ESPN broadcast highlights: use factual moment descriptions ("Stanley Cup lift", "knockout", "game-winner") — avoid claiming exclusive rights to league footage
- Tags: league + team + player names from the script; include "sports highlights", "shorts", league name when relevant
- Description: 1-2 sentences on what happens; end with ${cc.handle} — NEVER file paths or internal tool names` : '';

  const clipCompSportsGuidance = (isShort && (contentType === 'sports' || contentType === 'sports-short')) ? `
CLIP COMP SPORTS RULES:
- Category MUST be Sports — this is NOT a Twitch compilation unless Twitch streamers are listed
- Do NOT label ESPN/NHL/NBA/boxing footage as Twitch content
- Titles must match the actual moments in the clip list (teams, players, event) — no unrelated clickbait
- YouTube Shorts description: 125-250 words with hook in first 150 chars, CTA, ${cc.tiktokUrl} + ${cc.instagramUrl}, and 3-5 hashtags inline` : '';

  const newsSeoGuidance = (contentType === 'news' && !isShort) ? `
NEWS SEO GUIDANCE:
- Titles: punchy verb ("ERUPTS", "SNAPS", "COLLAPSES", "REJECTS", "CLAIMS", "ESCALATES"), 55-70 chars, no clickbait.
- Description must cover EVERY story (${itemCount} stories) in 1-2 sentences each, grouped by region/theme, with one 🔴 bullet per story (6-10 words each).
- Subscribe CTA: "Subscribe for daily geopolitical updates, world news breakdowns, political commentary, and international conflict coverage."
- Branding line: "📺 Presented by ${cc.showName}"
- The host (Bobby G) provides dry, deadpan commentary — titles and descriptions reflect this voice, not wire-copy` : '';

  const isTwitchClipShortForm = isShort && (contentType === 'twitch' || contentType === 'clips' || (contentType || '').includes('twitch'));

  const geminiBriefGuidance = clipCompBrief?.leadTitleDraft ? `
GEMINI → CHATGPT HANDOFF (mandatory):
Gemini already analyzed each clip (visual + audio) and picked a lead streamer.
- Lead streamer: ${clipCompBrief.leadStreamer || 'see brief'}
- Lead title DRAFT (start here — improve for CTR/SEO, do not ignore): "${clipCompBrief.leadTitleDraft}"
- ${clipCompBrief.isComp ? 'Multi-clip comp — keep " and more..." in bestTitle when appropriate' : 'Solo short — no "and more..." suffix'}
- Use each clip's Observation lines for description bullets — facts only
- Burned hooks are on-screen overlays only — rewrite for YouTube title/description, never copy verbatim
- Whisper transcript (if present below) is reference only — metadata must stay TV-clean even if streamers swore on mic
- bestTitle.title MUST refine leadTitleDraft — stronger CTR, same lead moment` : '';

  const twitchClipShortDescriptionGuidance = isTwitchClipShortForm ? `
TWITCH CLIP COMP SHORTS — NOT A SHOW (critical):
- This is a standalone YouTube Short: a vertical compilation of Twitch clips on @clipzworldnews — NOT a Twitch Soup episode, NOT a hosted long-form show, NOT episodic TV
- NEVER say "Welcome to Twitch Soup", "from Twitch Soup", "Twitch Soup episode", "presented by Twitch Soup", or "Hosted by Bobby G"
- Brand as ClipzWorld News — curated Twitch clip Shorts. Name the streamers and specific moments from the clip list
- Description tone: quick highlight reel / viral moments — not a show recap or episode summary` : '';

  const twitchClipTitleGuidance = (contentType === 'twitch' || contentType === 'clips' || (contentType || '').includes('twitch')) ? `
TWITCH CLIP COMP YOUTUBE TITLE RULES (proven CTR — follow strictly):
Burned on-screen hooks are moment-only text (3-8 words) — NO streamer name on the overlay. That burned text is NOT the YouTube title.
bestTitle.title is a SEPARATE rewritten headline inspired by the clip list; do NOT copy burned hook text verbatim; do NOT copy Twitch platform clip titles.
WINNERS (500+ views): ONE specific moment — streamer name only when natural in the YouTube title phrase (not as a "Name:" prefix).
  ✓ "ExtraEmily's Rave Outfit Stuns Viewers" · "Wrong Shirt Gift Gone Wrong" · "Faked Being Sick on Stream"
  ✗ "ExtraEmily: Back for old clips" · "jasontheween: ExtraEmily's Rave Outfit" · copying Twitch clip titles verbatim
LOSERS (<50 views): generic compilation language — NEVER use these patterns:
  ✗ "Wildest Twitch Moments You Can't Miss" · "You Won't Believe These Twitch Moments"
  ✗ "OMG Moments / Inspirations Unleashed" · "Cinna and all other Twitch Fun"
  ✗ "[Lead streamer]: [anything]" · any title that could describe any compilation
- bestTitle.title and titles[0] MUST name the featured streamer (login or possessive, e.g. jasontheween's … or ExtraEmily's …) — generic "Streamer's" alone fails QA
- Multi-streamer episodes: title the #1 clip's moment only — not "Best Twitch Clips" or a roster list
- Multi-clip comps (2+ clips in one Short): end bestTitle.title with " and more..." before #Shorts (e.g. "ExtraEmily's Wrong Shirt Gift and more...")
- thumbnailTextIdeas: same rule — 2-5 words, one moment, never generic compilation filler` : '';

  const channelContext = isTwitchClipShortForm
    ? `ClipzWorld News (YouTube: ${cc.youtubeUrl || cc.handle}, TikTok: ${cc.tiktokUrl || cc.tiktokHandle}, Instagram: ${cc.instagramUrl || cc.instagramHandle}) — curated Twitch clip Shorts, not a long-form show episode`
    : `ClipzWorld News (show: ${cc.showName}, host: ${cc.host}, YouTube: ${cc.youtubeUrl || cc.handle}, TikTok: ${cc.tiktokUrl || cc.tiktokHandle}, Instagram: ${cc.instagramUrl || cc.instagramHandle})`;

  return `You are a YouTube Growth Strategist, News Editor, SEO Specialist, and Viral Content Producer working for ${channelContext}.

ABOUT THE CHANNEL — ClipzWorld News publishes: Breaking News, World News, Politics, Sports Highlights, Twitch Streamer Content, Podcast Clips, Viral Internet Moments, Entertainment News, Social Media Trends.

TARGET AUDIENCE: Ages 18-44 primary, 45-65 secondary. US, Canada, UK, Australia. News consumers, Twitch viewers, sports fans, podcast audiences, commentary viewers.

YOUR GOAL — maximize: CTR, audience retention, watch time, suggested-video placement, browse-features traffic, YouTube search traffic, Google search visibility.

STEP 1 — CLASSIFY FIRST (do this before anything else):
Identify whether this content is News, Sports, Twitch, Podcast, Politics, or Viral Entertainment. Audience intent is completely different per category — optimize every piece of metadata for the identified category's search behavior and click psychology.

CONTENT TO ANALYZE:
- Content: ${cd}
- Date: ${date}
- Form: ${isShort ? 'Short (60-90 sec vertical)' : 'Long-form compilation'}
${epLabel ? `- Episode: ${epLabel}` : ''}
${geminiBriefGuidance}${nbaSeoGuidance}${clipCompSportsGuidance}${newsSeoGuidance}${twitchClipShortDescriptionGuidance}${twitchClipTitleGuidance}
Creative brief + script excerpt (up to 4000 chars):
${scriptExcerpt}
${streamerCredits ? `\nStreamers featured:\n${streamerCredits}` : ''}
${chaptersBlock}

TASK: Generate the full publish package. Return ONLY valid JSON with this exact schema:

{
  "category": "<News | Sports | Twitch | Podcast | Politics | Viral Entertainment>",
  "categoryReason": "<one sentence: why this category and what its audience clicks on>",
  "hookMoment": "<one-line description of the single most surprising/funniest moment in the script>",
  "searchIntent": {
    "whySearching": "<why viewers search this topic>",
    "wantToLearn": "<what they want to learn/see>",
    "clickEmotions": ["<emotion driving clicks>", "..."]
  },
  "youtube": {
    "titleOptions": {
      "breakingNews": ["<5 breaking-news style titles>"],
      "highCtr": ["<5 maximum-CTR titles>"],
      "searchOptimized": ["<5 search/SEO-optimized titles>"]${isShort ? `,
      "shorts": ["<5 Shorts titles>"]` : ''}
    },
    "bestTitle": {
      "title": "<the single title most likely to generate the highest CTR>",
      "reason": "<why this title wins>"
    },
    "titles": ["<10 titles: bestTitle FIRST, then the strongest from each category, all unique>"],
    "description": "${isShort
      ? `YouTube Shorts SEO description — REQUIRED 125-250 words with REAL line breaks between paragraphs (newline characters in JSON — never literal backslash-n). Structure: (1) First 150 characters = engaging hook + primary keyword. (2) 2-4 short paragraphs on streamers/moments (blank line between each). (3) CTA (subscribe, comment, follow). (4) If 'Streamers featured' is provided above: '🎮 Featured Streamers (Support Them 💜)' — each name on its own line, full https://www.twitch.tv/login URL on the next line (PUBLISH_COPY_SPEC format). (5) Plain URLs on separate lines: ${cc.youtubeUrl || cc.handle}, ${cc.tiktokUrl || cc.tiktokHandle}, ${cc.instagramUrl || cc.instagramHandle}. (6) End with exactly 3-5 hashtags INLINE (#Shorts #TwitchClips etc.) — duplicate in hashtags array.`
      : `FULL structured description with REAL line breaks between sections (newline characters in the JSON string — never the literal two characters backslash-n) following this EXACT section order (PUBLISH_COPY_SPEC.md): (1) 'Welcome to ${cc.showName} by ClipzWorld News [show emoji] — [one-line tagline]'. (2) Episode hook: 1-2 sentences naming the single biggest specific moment + 'plus [N] more...'. (3) Per-segment breakdown: one short punchy paragraph per streamer/story/game describing their moment, each opening with the #name hashtag. (4) ONLY if a CHAPTERS block was provided above: include it VERBATIM under '⏱️ TIMESTAMPS' — if no CHAPTERS block was provided, OMIT this section entirely and NEVER invent timestamps. (5) If 'Streamers featured' was provided above, include '🎮 Featured Streamers (Support Them 💜)' listing every name + URL EXACTLY as given — never invent or alter twitch.tv URLs (NBA: '🏀 Games Featured'; News: '📰 Stories Covered'). (6) '😂 What You'll See:' 4 bullets specific to THIS episode. (7) Subscribe CTA + upload cadence + 🔔. (8) '🎤 Hosted by: ${cc.host}'. (9) '📢 Disclaimer: All content belongs to respective streamers. Used for entertainment and highlight purposes.' (10) Final line: 3-5 hashtags INLINE. Include ${cc.tiktokUrl || cc.tiktokHandle} and ${cc.instagramUrl || cc.instagramHandle}. 250-450 words.`}",
    "playlistDescription": "<60-80 word playlist description for '${cc.showName}'. Tone: dry, punchy, Bobby G voice.>",
    "tags": ["<maximum optimized YouTube tags, search-intent first, total combined length 490-500 characters (use the full YouTube tag budget; hard max 500)>"],
    "hashtags": ["<15 hashtags WITH # prefix, RANKED by importance — most important first>"],
    "thumbnailTextIdeas": ["<10 thumbnail text options, 2-5 words each, high curiosity, mobile-readable>"],
    "pinnedComment": "<pinned comment that sparks debate, invites comments, nudges subscribe + return>",
    "communityPost": "<community post promoting this video — 2-4 sentences + a question>"
  },
  "seo": {
    "primaryKeywords": ["<20 primary keywords>"],
    "longTailKeywords": ["<20 long-tail keywords>"],
    "trendingPhrases": ["<20 trending search phrases>"],
    "entities": {
      "people": [], "organizations": [], "countries": [], "teams": [], "streamers": [], "events": []
    }
  },
  "virality": {
    "ctrPotential": 0, "searchPotential": 0, "suggestedPotential": 0, "retentionPotential": 0, "overall": 0
  },
  "platformVariants": {
    "youtubeLong":  { "title": "", "description": "<2-3 sentence platform-tuned summary>" },
    "youtubeShorts": { "title": "", "description": "" },
    "facebookReels": { "caption": "<hook-first caption + 3-5 hashtags>" }
  }${needsTikTok ? `,
  "tiktok": {
    "caption": "<TikTok ONLY — 90-160 char hook describing the moment (no streamer name lead-in), then blank line, then 12-15 hashtags inline (#FYP #TwitchClips etc.), then blank line, then ${cc.tiktokUrl || cc.tiktokHandle}. NEVER paste the YouTube description here.>"
  }` : ''}${needsInstagram ? `,
  "instagram": {
    "caption": "<Instagram Reels ONLY — hook in first 125 chars describing the moment (no streamer name lead-in), 1-2 sentence synopsis (NOT the full YT essay), blank line, 15-20 hashtags inline, blank line, ${cc.instagramUrl || cc.instagramHandle}. NEVER paste the YouTube description verbatim.>"
  }` : ''}
}

STRICT RULES (counts are MANDATORY — do not return fewer items):
- Titles: under 70 chars when possible (hard max 100), primary keywords included naturally, curiosity + clarity, NO misleading clickbait
- titleOptions: exactly 5 titles per category, all unique
- "titles" array: exactly 10, bestTitle.title MUST be first
- tags: 25-35 plain words/phrases, NO # prefix; prioritize search intent; combined length 490-500 chars (hard max 500 — fill the tag budget)
- hashtags: WITH # prefix, exactly 15, ranked most-important-first
- seo.primaryKeywords: exactly 20 | seo.longTailKeywords: exactly 20 | seo.trendingPhrases: exactly 20
- thumbnailTextIdeas: exactly 10
- virality scores: integers 1-100, honest assessment — not everything is a 95
- Output ONLY valid JSON — no markdown fences, no explanation
- Use double quotes for all JSON strings
- NEVER include file paths, HTML/JS filenames, or internal dev tool names in titles or descriptions
- Shorts descriptions: 125-250 words, hook in first 150 chars, 3-5 hashtags INLINE at end, include ${cc.tiktokUrl || cc.tiktokHandle} and ${cc.instagramUrl || cc.instagramHandle}
- Long-form descriptions: 250-450 words, 3-5 hashtags INLINE at end, Subscribe CTA required
- POLITICAL ACCURACY (as of 2026): Donald Trump IS the current US President — write "President Trump" or "Trump", NEVER "former President Trump"`;
}

// Shared post-parse normalisation: bestTitle drives titles[0] / youtube.title (CPD-880)
function applyBestTitleShim(metadata) {
  if (!metadata?.youtube) return;
  const yt = metadata.youtube;
  const best = yt.bestTitle?.title;
  if (best) {
    const rest = (Array.isArray(yt.titles) ? yt.titles : []).filter(t => t && t !== best);
    yt.titles = [best, ...rest].slice(0, 10);
  }
  if (Array.isArray(yt.titles) && yt.titles.length) {
    yt.title = yt.titles[0];
  }
}

/** Build GPT script context from a job card (clip comps store script as { scenes }). */
function buildPublishScriptFromCard(card = {}) {
  if (card.fullScript && typeof card.fullScript === 'string' && card.fullScript.trim()) {
    return card.fullScript.trim();
  }
  if (card.scriptText && typeof card.scriptText === 'string' && card.scriptText.trim()) {
    return card.scriptText.trim();
  }
  const script = card.script;
  if (typeof script === 'string' && script.trim()) return script.trim();
  if (script?.raw && typeof script.raw === 'string' && script.raw.trim()) return script.raw.trim();
  if (script?.text && typeof script.text === 'string' && script.text.trim()) return script.text.trim();

  const clips = card.orderedClipUrls || [];
  const scenes = script?.scenes || [];
  if (clips.length) {
    const lines = clips.map((c, i) => {
      const who = c.displayName || c.streamer || 'streamer';
      const title = c.title || c.clipTitle || scenes[i]?.title || 'untitled clip';
      return `CLIP ${i + 1} (${who}): ${title}`;
    });
    const header = script?.title || card.title || 'Clip compilation';
    return `${header}\n\n${lines.join('\n')}`;
  }

  const items = card.order?.inputs?.items || card.items || [];
  if (items.length) {
    return items.map((it, i) => {
      const who = it.displayName || it.streamer || '';
      const title = it.title || it.headline || it.clipTitle || 'Clip';
      return `${i + 1}. ${who ? `${who}: ` : ''}${title}`;
    }).join('\n');
  }

  const sceneLines = scenes
    .filter((s) => s.type === 'source_clip' || s.title)
    .map((s, i) => `CLIP ${i + 1}: ${s.title || s.name || 'clip'}`);
  if (sceneLines.length) {
    const header = script?.title || card.title || 'Clip compilation';
    return `${header}\n\n${sceneLines.join('\n')}`;
  }

  const streamers = card.streamers || card.order?.inputs?.streamers || [];
  if (streamers.length) {
    const names = streamers.map((s) => (typeof s === 'string' ? s : (s.displayName || s.streamer || ''))).filter(Boolean);
    return `Twitch clips compilation featuring: ${names.join(', ')}`;
  }

  return String(card.title || '').trim();
}

/** Clip items for publish-copy from card shape (orderedClipUrls or order.inputs.items). */
function buildPublishItemsFromCard(card = {}) {
  const fromOrder = card.order?.inputs?.items || card.items || [];
  if (fromOrder.length) return fromOrder;
  return (card.orderedClipUrls || []).map((c, i) => ({
    title: c.title || c.clipTitle || `Clip ${i + 1}`,
    displayName: c.displayName || c.streamer || '',
    streamer: c.streamer || c.displayName || '',
    clipTitle: c.title || c.clipTitle || '',
  }));
}

async function handleGeneratePublishCopy(req, res) {
  const {
    contentType, formType, script, date,
    streamers = [], items = [], platforms = ['youtube'],
    episodeNumber = null, chapters = null,
    clipCompBrief = null,
  } = req.body;

  if (!script && !clipCompBrief) return res.status(400).json({ error: 'script or clipCompBrief required' });

  const isShort = formType === 'short' || (contentType || '').includes('-short');
  const baseContentType = (contentType || 'news').replace(/-short$/, '');
  let scriptExcerpt = script && script.length > 4000 ? script.substring(0, 4000) : (script || '');
  if (clipCompBrief) {
    try {
      const { buildClipCompSeoInput } = require('./clip_comp_hooks');
      scriptExcerpt = buildClipCompSeoInput(clipCompBrief).slice(0, 4000);
      if (script && script.length > 0 && scriptExcerpt.length < 3800) {
        scriptExcerpt = `${scriptExcerpt}\n\n${String(script).slice(0, 4000 - scriptExcerpt.length)}`;
      }
    } catch (_) { /* use script as-is */ }
  }
  const needsTikTok = platforms.includes('tiktok');
  const needsInstagram = platforms.includes('instagram');
  const needsYouTube = platforms.includes('youtube');

  // Load streamer roster for Twitch URL credits
  const streamerRoster = loadStreamerRoster();

  // Channel config: show names from customerConfig (c0.json designDefaults.voice.showName).
  let channelConfig = buildChannelConfig();
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const custCfg = loadCustomerConfig('c0', 'long-form');
    const showNames = custCfg?.designDefaults?.voice?.showName;
    if (showNames) {
      if (showNames.clips)  channelConfig.clips.showName  = normalizeShowName(showNames.clips);
      if (showNames.sports) channelConfig.sports.showName = normalizeShowName(showNames.sports);
      if (showNames.news)   channelConfig.news.showName   = normalizeShowName(showNames.news);
    }
  } catch (e) {
    // non-fatal — use hardcoded fallbacks
  }
  // Map contentType aliases to voice keys
  let ccKey = contentType;
  if (['twitch', 'clips', 'streamer'].some(t => (contentType || '').includes(t))) ccKey = 'clips';
  if (['nba', 'sports', 'basketball'].some(t => (contentType || '').includes(t))) ccKey = 'sports';
  const cc = channelConfig[ccKey] || channelConfig.news;

  // Build streamer credits block (Twitch only)
  const streamerCredits = (baseContentType === 'twitch' || (contentType || '').includes('twitch')) && streamers.length
    ? buildStreamerCreditsPromptBlock(streamers, streamerRoster)
    : '';

  // Episode label
  const epLabel = episodeNumber ? `Ep. ${episodeNumber} | ` : '';

  // Chapters block passthrough
  const chaptersBlock = chapters && typeof chapters === 'string' ? `\n\nCHAPTERS:\n${chapters}` : '';

  // NBA: build a rich per-game context block from item data
  const buildNbaContext = (itemList) => {
    if (!itemList || !itemList.length) return "today's games";
    const lines = itemList.map((it, i) => {
      const away = it.away || it.awayTeam || '';
      const home = it.home || it.homeTeam || '';
      const awayScore = it.awayScore != null ? it.awayScore : '';
      const homeScore = it.homeScore != null ? it.homeScore : '';
      const matchup = it.matchup || it.displayName || it.headline || it.title || (away && home ? `${away} vs ${home}` : '');
      const scoreStr = (awayScore !== '' && homeScore !== '') ? ` (${awayScore}-${homeScore})` : '';
      const series = it.seriesStatus || it.series || '';
      const seriesStr = series ? ` | ${series}` : '';
      return `Game ${i + 1}: ${matchup}${scoreStr}${seriesStr}`;
    });
    return `NBA highlights — ${lines.join('; ')}`;
  };

  // News: build numbered story list with category and source
  const buildNewsContext = (itemList) => {
    if (!itemList || !itemList.length) return "today's top stories";
    const lines = itemList.map((it, i) => {
      const title = it.headline || it.title || it.story || `Story ${i + 1}`;
      const category = it.category ? ` [${it.category}]` : '';
      const src = it.source ? ` (${it.source})` : '';
      return `${i + 1}. ${title}${category}${src}`;
    });
    return `World news roundup:\n${lines.join('\n')}`;
  };

  const buildSportsContext = (itemList) => {
    if (!itemList || !itemList.length) return "today's sports highlights";
    const lines = itemList.map((it, i) => {
      const title = it.headline || it.title || it.matchup || it.displayName || `Clip ${i + 1}`;
      const src = it.source || it.channel ? ` (${it.source || it.channel})` : '';
      return `${i + 1}. ${title}${src}`;
    });
    return `Sports highlights compilation:\n${lines.join('\n')}`;
  };

  // Content descriptors for prompt context
  const contentDescriptors = {
    twitch: `Twitch clips compilation featuring: ${streamers.join(', ') || 'multiple streamers'}`,
    nba:    buildSportsContext(items),
    sports: buildSportsContext(items),
    news:   buildNewsContext(items),
  };
  const cd = contentDescriptors[baseContentType] || contentDescriptors.news;

  // Shared YouTube Growth Strategist prompt (CPD-880)
  const systemPrompt = buildPublishCopySystemPrompt({
    cc, cd,
    date: date || 'today',
    isShort,
    epLabel,
    scriptExcerpt,
    streamerCredits,
    chaptersBlock,
    contentType: baseContentType,
    itemCount: items.length,
    needsTikTok,
    needsInstagram,
    clipCompBrief,
  });

  try {
    // ── Short-form: generate optimised caption + hashtags + altText first ──
    let shortCaption = null;
    if (isShort) {
      try {
        const captionScript = clipCompBrief
          ? scriptExcerpt
          : script;
        shortCaption = await generateShortFormCaption(captionScript, contentType);
        console.log(`[publish-copy] Short-form caption generated: "${shortCaption.caption.slice(0, 60)}..." (${shortCaption.caption.length} chars)`);
      } catch(e) {
        console.warn(`[publish-copy] generateShortFormCaption failed: ${e.message} — continuing without short caption`);
      }
    }

    const metadata = await _generateMetadataJson(systemPrompt, 'publish-copy');

    // bestTitle drives titles[0] / youtube.title (CPD-880)
    applyBestTitleShim(metadata);
    sanitizePublishMetadata(metadata, cc);

    // ── Inject short-form caption into platform metadata ──────────────
    if (isShort && shortCaption) {
      metadata.tiktok = metadata.tiktok || {};
      metadata.instagram = metadata.instagram || {};
      if (metadata.tiktok) {
        const ttTags = (shortCaption.hashtags || []).slice(0, TIKTOK_HASHTAG_COUNT);
        metadata.tiktok.caption = buildTikTokCaption({
          hook: shortCaption.caption,
          hashtags: ttTags,
        });
        metadata.tiktok.altText = shortCaption.altText;
      }
      if (metadata.instagram) {
        metadata.instagram.caption = shortCaption.caption + '\n\n' + shortCaption.hashtags.map(h => '#' + h).join(' ');
        metadata.instagram.altText = shortCaption.altText;
      }
      if (metadata.youtube) {
        if (metadata.youtube.title && !metadata.youtube.title.includes('#Shorts')) {
          metadata.youtube.title = metadata.youtube.title.trim() + ' #Shorts';
          if (metadata.youtube.title.length > 100) {
            metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
          }
          // Also update titles[0] to match
          if (Array.isArray(metadata.youtube.titles)) metadata.youtube.titles[0] = metadata.youtube.title;
        }
        metadata.youtube.altText = shortCaption.altText;
        if (Array.isArray(metadata.youtube.hashtags)) {
          const shortHashtags = shortCaption.hashtags.filter(h => !metadata.youtube.hashtags.includes(h));
          metadata.youtube.hashtags = [...metadata.youtube.hashtags, ...shortHashtags].slice(0, 15);
        }
      }
      metadata._shortCaption = shortCaption;
    }

    ensurePublishMetadataComplete(metadata, {
      streamers,
      cc,
      isShort,
      clipCount: items.length,
    });

    // Validate and add metrics for YouTube
    if (needsYouTube && metadata.youtube) {
      if (metadata.youtube.title && metadata.youtube.title.length > 100) {
        console.warn(`[publish-copy] YouTube title too long (${metadata.youtube.title.length} chars), truncating...`);
        metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
      }
      if (!Array.isArray(metadata.youtube.tags)) metadata.youtube.tags = [];
      if (!Array.isArray(metadata.youtube.hashtags)) metadata.youtube.hashtags = [];
      if (!Array.isArray(metadata.youtube.titles)) metadata.youtube.titles = [metadata.youtube.title || ''];
      metadata.youtube.titleLength = metadata.youtube.title?.length || 0;
      metadata.youtube.descriptionLength = metadata.youtube.description?.length || 0;
      metadata.youtube.hashtagCount = metadata.youtube.hashtags?.length || 0;
      metadata.youtube.titlesCount = metadata.youtube.titles?.length || 0;
      metadata.youtube.tagsCount = metadata.youtube.tags?.length || 0;
    }

    if (needsTikTok && metadata.tiktok) {
      metadata.tiktok.captionLength = metadata.tiktok.caption?.length || 0;
    }
    if (needsInstagram && metadata.instagram) {
      metadata.instagram.captionLength = metadata.instagram.caption?.length || 0;
    }

    const summary = platforms.map(p => {
      if (p === 'youtube' && metadata.youtube) {
        return `YouTube: ${metadata.youtube.titlesCount} titles, ${metadata.youtube.tagsCount} tags, ${metadata.youtube.hashtagCount} hashtags`;
      }
      if (p === 'tiktok' && metadata.tiktok) return `TikTok: ${metadata.tiktok.captionLength} char caption`;
      if (p === 'instagram' && metadata.instagram) return `Instagram: ${metadata.instagram.captionLength} char caption`;
      return null;
    }).filter(Boolean).join(', ');

    console.log(`[publish-copy] Generated metadata: ${summary}`);

    // Backward compatibility: if only YouTube requested, return flat structure
    if (platforms.length === 1 && platforms[0] === 'youtube' && metadata.youtube) {
      res.json({
        ok: true,
        ...metadata.youtube,
        platforms: { youtube: metadata.youtube }
      });
    } else {
      const payload = normalizePublishCopyShape({
        ok: true,
        platforms: metadata,
        contentType,
        formType,
      });
      res.json(payload);
    }

  } catch (err) {
    console.error('[publish-copy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}


/**
 * generatePublishCopyFromScript — direct (non-HTTP) version of handleGeneratePublishCopy.
 * Called at Gate 1 pass in script_gen.js so publishCopy is locked before HeyGen spend.
 *
 * @param {object} opts
 * @param {string}   opts.script       — approved script text
 * @param {string}   opts.contentType  — 'twitch' | 'nba' | 'news'
 * @param {string}   [opts.formType]   — 'short' | 'compilation'
 * @param {Array}    [opts.items]       — array of { title, headline, url } (nba/news items or streamers)
 * @param {string}   [opts.jobId]
 * @param {Array}    [opts.platforms]   — ['youtube','tiktok','instagram']
 * @param {object}   [opts.designSpec]
 * @returns {Promise<object>} — same structure as handleGeneratePublishCopy JSON response
 */
async function generatePublishCopyFromScript({ script, contentType, formType, items = [], jobId, platforms = ['youtube', 'tiktok', 'instagram'], designSpec = {} }) {
  if (!script) throw new Error('script required');

  const isShort = formType === 'short' || (contentType || '').includes('-short');
  const baseContentType = (contentType || 'news').replace('-short', '');
  const scriptExcerpt = script.length > 4000 ? script.substring(0, 4000) : script;
  const needsTikTok = platforms.includes('tiktok');
  const needsInstagram = platforms.includes('instagram');
  const needsYouTube = platforms.includes('youtube');
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Load streamer roster for Twitch URL credits
  const streamerRoster = loadStreamerRoster();

  // Channel config from customerConfig (same as handleGeneratePublishCopy)
  let channelConfig = buildChannelConfig();
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const custCfg = loadCustomerConfig('c0', 'long-form');
    const showNames = custCfg?.designDefaults?.voice?.showName;
    if (showNames) {
      if (showNames.clips)  channelConfig.clips.showName  = normalizeShowName(showNames.clips);
      if (showNames.sports) channelConfig.sports.showName = normalizeShowName(showNames.sports);
      if (showNames.news)   channelConfig.news.showName   = normalizeShowName(showNames.news);
    }
  } catch (e) {}

  // Use designSpec.voice.showName if available — but never internal file paths
  if (designSpec?.voice?.showName && !isInvalidShowName(designSpec.voice.showName)) {
    let vcKey = baseContentType;
    if (['twitch', 'clips', 'streamer'].some(t => baseContentType.includes(t))) vcKey = 'clips';
    if (['nba', 'sports', 'basketball'].some(t => baseContentType.includes(t))) vcKey = 'sports';
    const normalized = normalizeShowName(designSpec.voice.showName);
    if (normalized && channelConfig[vcKey]) channelConfig[vcKey].showName = normalized;
  }

  let ccKey = baseContentType;
  if (['twitch', 'clips', 'streamer'].some(t => baseContentType.includes(t))) ccKey = 'clips';
  if (['nba', 'sports', 'basketball'].some(t => baseContentType.includes(t))) ccKey = 'sports';
  const cc = channelConfig[ccKey] || channelConfig.news;

  // For Twitch: items are streamers — build credits block
  const streamers = baseContentType === 'twitch' ? items : [];
  const streamerCredits = streamers.length
    ? buildStreamerCreditsPromptBlock(streamers, streamerRoster)
    : '';

  // NBA: build rich per-game context from item data (same helper logic as handleGeneratePublishCopy)
  const buildNbaContextG1 = (itemList) => {
    if (!itemList || !itemList.length) return "today's games";
    const lines = itemList.map((it, i) => {
      const away = it.away || it.awayTeam || '';
      const home = it.home || it.homeTeam || '';
      const awayScore = it.awayScore != null ? it.awayScore : '';
      const homeScore = it.homeScore != null ? it.homeScore : '';
      const matchup = it.matchup || it.displayName || it.headline || it.title || (away && home ? `${away} vs ${home}` : '');
      const scoreStr = (awayScore !== '' && homeScore !== '') ? ` (${awayScore}-${homeScore})` : '';
      const series = it.seriesStatus || it.series || '';
      const seriesStr = series ? ` | ${series}` : '';
      return `Game ${i + 1}: ${matchup}${scoreStr}${seriesStr}`;
    });
    return `NBA highlights — ${lines.join('; ')}`;
  };

  // News: build numbered story list with category and source
  const buildNewsContextG1 = (itemList) => {
    if (!itemList || !itemList.length) return "today's top stories";
    const lines = itemList.map((it, i) => {
      const title = it.headline || it.title || it.story || `Story ${i + 1}`;
      const category = it.category ? ` [${it.category}]` : '';
      const src = it.source ? ` (${it.source})` : '';
      return `${i + 1}. ${title}${category}${src}`;
    });
    return `World news roundup:\n${lines.join('\n')}`;
  };

  const buildSportsContextG1 = (itemList) => {
    if (!itemList || !itemList.length) return "today's sports highlights";
    const lines = itemList.map((it, i) => {
      const title = it.headline || it.title || it.matchup || it.displayName || `Clip ${i + 1}`;
      const src = it.source || it.channel ? ` (${it.source || it.channel})` : '';
      return `${i + 1}. ${title}${src}`;
    });
    return `Sports highlights compilation:\n${lines.join('\n')}`;
  };

  const contentDescriptors = {
    twitch: `Twitch clips compilation featuring: ${streamers.map(s => (typeof s === 'object' ? s.displayName || s.title : s) || '').filter(Boolean).join(', ') || 'multiple streamers'}`,
    nba:    buildSportsContextG1(items),
    sports: buildSportsContextG1(items),
    news:   buildNewsContextG1(items),
  };
  const cd = contentDescriptors[baseContentType] || contentDescriptors.news;

  // Shared YouTube Growth Strategist prompt (CPD-880)
  const systemPrompt = buildPublishCopySystemPrompt({
    cc, cd,
    date,
    isShort,
    scriptExcerpt,
    streamerCredits,
    contentType: baseContentType,
    itemCount: items.length,
    needsTikTok,
    needsInstagram
  });

  // Short-form caption (same as handleGeneratePublishCopy)
  let shortCaption = null;
  if (isShort) {
    try {
      shortCaption = await generateShortFormCaption(script, baseContentType);
      console.log(`[publish-copy/g1] Short-form caption generated: "${shortCaption.caption.slice(0, 60)}..."`);
    } catch(e) {
      console.warn(`[publish-copy/g1] generateShortFormCaption failed: ${e.message}`);
    }
  }

  const metadata = await _generateMetadataJson(systemPrompt, 'publish-copy/g1');

  // bestTitle drives titles[0] / youtube.title (CPD-880)
  applyBestTitleShim(metadata);
  sanitizePublishMetadata(metadata, cc);

  // Inject short-form caption
  if (isShort && shortCaption) {
    metadata.tiktok = metadata.tiktok || {};
    metadata.instagram = metadata.instagram || {};
    if (metadata.tiktok) {
      const ttTags = (shortCaption.hashtags || []).slice(0, TIKTOK_HASHTAG_COUNT);
      metadata.tiktok.caption = buildTikTokCaption({
        hook: shortCaption.caption,
        hashtags: ttTags,
      });
      metadata.tiktok.altText = shortCaption.altText;
    }
    if (metadata.instagram) {
      metadata.instagram.caption = shortCaption.caption + '\n\n' + shortCaption.hashtags.map(h => '#' + h).join(' ');
      metadata.instagram.altText = shortCaption.altText;
    }
    if (metadata.youtube) {
      if (metadata.youtube.title && !metadata.youtube.title.includes('#Shorts')) {
        metadata.youtube.title = metadata.youtube.title.trim() + ' #Shorts';
        if (metadata.youtube.title.length > 100) metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
        if (Array.isArray(metadata.youtube.titles)) metadata.youtube.titles[0] = metadata.youtube.title;
      }
      metadata.youtube.altText = shortCaption.altText;
      if (Array.isArray(metadata.youtube.hashtags)) {
        const shortHashtags = shortCaption.hashtags.filter(h => !metadata.youtube.hashtags.includes(h));
        metadata.youtube.hashtags = [...metadata.youtube.hashtags, ...shortHashtags].slice(0, 15);
      }
    }
    metadata._shortCaption = shortCaption;
  }

  finalizeYoutubePublishMetadata(metadata.youtube, cc, { streamers, isShort });
  ensurePublishMetadataComplete(metadata, { streamers, cc, isShort, clipCount: items.length });

  // Validate + metrics (YouTube)
  if (needsYouTube && metadata.youtube) {
    if (metadata.youtube.title && metadata.youtube.title.length > 100) {
      metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
    }
    if (!Array.isArray(metadata.youtube.tags)) metadata.youtube.tags = [];
    if (!Array.isArray(metadata.youtube.hashtags)) metadata.youtube.hashtags = [];
    if (!Array.isArray(metadata.youtube.titles)) metadata.youtube.titles = [metadata.youtube.title || ''];
    metadata.youtube.titleLength = metadata.youtube.title?.length || 0;
    metadata.youtube.descriptionLength = metadata.youtube.description?.length || 0;
    metadata.youtube.hashtagCount = metadata.youtube.hashtags?.length || 0;
    metadata.youtube.titlesCount = metadata.youtube.titles?.length || 0;
    metadata.youtube.tagsCount = metadata.youtube.tags?.length || 0;
  }
  if (needsTikTok && metadata.tiktok) {
    metadata.tiktok.captionLength = metadata.tiktok.caption?.length || 0;
  }
  if (needsInstagram && metadata.instagram) {
    metadata.instagram.captionLength = metadata.instagram.caption?.length || 0;
  }

  // Return multi-platform structure (Gate 5 reads metadata.platforms.youtube.title)
  const payload = {
    ok: true,
    platforms: metadata,
    contentType: baseContentType,
    formType: isShort ? 'short' : 'compilation',
    // Top-level shims for backward-compat consumers that read .youtube.title directly
    youtube: metadata.youtube,
    tiktok:  metadata.tiktok  || null,
    instagram: metadata.instagram || null,
    _generatedAt: 'gate1',
    _jobId: jobId || null
  };
  try {
    const { recordPublishCopySnapshot } = require('./publish_seo_audit');
    payload.publishSeoAudit = recordPublishCopySnapshot(null, payload, 'generated');
  } catch (_audit) { /* non-fatal */ }
  return payload;
}


module.exports = {
  getDriveClient,
  getDriveFolderId,
  uploadToDrive,
  importToCanva,
  readUploadStatus,
  writeUploadStatus,
  logUploadAttempt,
  generateShortFormCaption,
  generatePublishCopyFromScript,
  buildPublishCopySystemPrompt,
  buildPublishScriptFromCard,
  buildPublishItemsFromCard,
  buildChannelConfig,
  CHANNEL_SOCIAL,
  finalizeYoutubePublishMetadata,
  finalizePlatformCaptions,
  ensurePublishMetadataComplete,
  finalizeShortSocialCaptions,
  buildSocialHashtagPack,
  buildTikTokCaption,
  buildInstagramCaption,
  formatHashtagLine,
  countHashtagsInCaption,
  expandShortDescriptionIfNeeded,
  sanitizeTwitchClipShortCopy,
  isTwitchClipShort,
  countWords,
  countHashtagsInText,
  appendHashtagsToDescription,
  sanitizePublishText,
  normalizeDescriptionNewlines,
  appendFeaturedStreamersBlock,
  buildStreamerCreditLines,
  buildStreamerCreditsPromptBlock,
  fillYoutubeTagsToBudget,
  buildYoutubeTagExpansionPool,
  normalizeYoutubeTagToken,
  handlePublish,
  handleGeneratePublishCopy
};
