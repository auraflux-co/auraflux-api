'use strict';
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

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const UPLOAD_STATUS_PATH = path.join(__dirname, '..', 'data', 'upload_status.json');

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

  const typeLabel = { nba: 'NBA highlights', news: 'world news', twitch: 'Twitch clips' }[contentType] || 'content';

  const systemPrompt = `You write ultra-short social captions for ClipzWorld News (@clipzworldnews) short-form vertical videos (60-90 seconds).

Content type: ${typeLabel}
Script excerpt:
${excerpt}...

Generate a JSON object with exactly these fields:
{
  "caption": "90-150 char hook with 1-2 emojis, punchy, no hashtags inline",
  "hashtags": ["array", "of", "8-12", "tags", "no", "hash", "symbol"],
  "altText": "1-sentence accessibility description of the video content, plain English, no emojis"
}

Rules:
- caption: 90-150 chars, starts with the most compelling fact or hook, ends with a micro-CTA ("Watch 👆", "Full story 👆", "Highlights 👆")
- hashtags: mix of broad (#Shorts #FYP #ForYou) + topic-specific; no # prefix in the array values
- altText: screen-reader friendly, describes what happens in the video
- Output ONLY valid JSON, no markdown, no explanation`;

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

    // YouTube-specific
    if (platforms.includes('youtube')) {
      const ytTitle = contentType === 'short' ? title + ' #Shorts' : title;
      form.append('youtube_title', ytTitle);
      form.append('youtube_description', description || title);
      if (tags.length) tags.forEach(t => form.append('tags[]', t));
      form.append('privacyStatus', privacyStatus || 'private');
      form.append('categoryId', '24'); // Entertainment
      form.append('containsSyntheticMedia', 'true');
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
      form.append('is_aigc', 'true');
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
  needsInstagram = false
}) {
  // Content-type-specific guidance (kept from prior prompt — proven patterns)
  const nbaSeoGuidance = (contentType === 'nba') ? `
NBA SEO GUIDANCE (apply these patterns):
- Titles perform best with: team names, "Game N" if playoffs, scores or "comeback", key player names, and outcome words ("SURVIVE", "ADVANCE", "DOMINANT", "DROPS", "SILENCES", "EXPLODES")
- High-search tags: "NBA highlights today", "NBA playoffs 2026", "[Team] highlights", "[Player] highlights", "NBA recap", "basketball highlights"
- Avoid generic sports titles — be specific to these exact teams and what happened in the game
- Description should lead with the game result and best moment, then break down each team's performance` : '';

  const newsSeoGuidance = (contentType === 'news') ? `
NEWS SEO GUIDANCE:
- Titles: punchy verb ("ERUPTS", "SNAPS", "COLLAPSES", "REJECTS", "CLAIMS", "ESCALATES"), 55-70 chars, no clickbait.
- Description must cover EVERY story (${itemCount} stories) in 1-2 sentences each, grouped by region/theme, with one 🔴 bullet per story (6-10 words each).
- Subscribe CTA: "Subscribe for daily geopolitical updates, world news breakdowns, political commentary, and international conflict coverage."
- Branding line: "📺 Presented by ${cc.showName}"
- The host (Bobby G) provides dry, deadpan commentary — titles and descriptions reflect this voice, not wire-copy` : '';

  return `You are a YouTube Growth Strategist, News Editor, SEO Specialist, and Viral Content Producer working for ClipzWorld News (show: ${cc.showName}, host: ${cc.host}, YouTube handle: ${cc.handle}${cc.tiktokHandle ? `, TikTok handle: ${cc.tiktokHandle} — use the right handle for each platform's copy` : ''}).

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
${nbaSeoGuidance}${newsSeoGuidance}
Script excerpt (up to 4000 chars):
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
    "description": "${isShort ? '1-2 punchy sentences (under 120 chars total). Hook first, then ' + cc.handle + '. Hashtags go in the hashtags field — NOT inline here.' : `FULL structured description with REAL line breaks between sections (newline characters in the JSON string — never the literal two characters backslash-n) following this EXACT section order (PUBLISH_COPY_SPEC.md): (1) 'Welcome to ${cc.showName} by ClipzWorld News [show emoji] — [one-line tagline]'. (2) Episode hook: 1-2 sentences naming the single biggest specific moment + 'plus [N] more...'. (3) Per-segment breakdown: one short punchy paragraph per streamer/story/game describing their moment, each opening with the #name hashtag. (4) ONLY if a CHAPTERS block was provided above: include it VERBATIM under '⏱️ TIMESTAMPS' — if no CHAPTERS block was provided, OMIT this section entirely and NEVER invent timestamps. (5) If 'Streamers featured' was provided above, include '🎮 Featured Streamers (Support Them 💜)' listing every name + URL EXACTLY as given — never invent or alter twitch.tv URLs (NBA: '🏀 Games Featured'; News: '📰 Stories Covered'). (6) '😂 What You'll See:' 4 bullets specific to THIS episode. (7) Subscribe CTA + upload cadence + 🔔. (8) '🎤 Hosted by: ${cc.host}'. (9) '📢 Disclaimer: All content belongs to respective streamers. Used for entertainment and highlight purposes.' (10) Final line: 3-5 hashtags. 250-450 words.`}",
    "playlistDescription": "<60-80 word playlist description for '${cc.showName}'. Tone: dry, punchy, Bobby G voice.>",
    "tags": ["<maximum optimized YouTube tags, search-intent first, total combined length under 450 characters>"],
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
    "caption": "<90-150 chars hook + 4-6 hashtags. No separate title.>"
  }` : ''}${needsInstagram ? `,
  "instagram": {
    "caption": "<Hook in first 125 chars. Full description with line breaks. 10-15 hashtags at end.>"
  }` : ''}
}

STRICT RULES (counts are MANDATORY — do not return fewer items):
- Titles: under 70 chars when possible (hard max 100), primary keywords included naturally, curiosity + clarity, NO misleading clickbait
- titleOptions: exactly 5 titles per category, all unique
- "titles" array: exactly 10, bestTitle.title MUST be first
- tags: 25-35 plain words/phrases, NO # prefix; prioritize search intent; max combined length 450 chars
- hashtags: WITH # prefix, exactly 15, ranked most-important-first
- seo.primaryKeywords: exactly 20 | seo.longTailKeywords: exactly 20 | seo.trendingPhrases: exactly 20
- thumbnailTextIdeas: exactly 10
- virality scores: integers 1-100, honest assessment — not everything is a 95
- Output ONLY valid JSON — no markdown fences, no explanation
- Use double quotes for all JSON strings
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

async function handleGeneratePublishCopy(req, res) {
  const {
    contentType, formType, script, date,
    streamers = [], items = [], platforms = ['youtube'],
    episodeNumber = null, chapters = null
  } = req.body;

  if (!script) return res.status(400).json({ error: 'script required' });

  const isShort = formType === 'short';
  const scriptExcerpt = script.length > 4000 ? script.substring(0, 4000) : script;
  const needsTikTok = platforms.includes('tiktok');
  const needsInstagram = platforms.includes('instagram');
  const needsYouTube = platforms.includes('youtube');

  // Load streamer roster for Twitch URL credits
  const streamerRoster = loadStreamerRoster();

  // Channel config: show names from customerConfig (c0.json designDefaults.voice.showName).
  // Fallback to hardcoded values if config unavailable.
  let channelConfig = {
    // handle = YouTube channel; tiktokHandle = TikTok account (@clipznashite is TikTok-only — Rob 2026-06-11)
    clips:  { showName: 'Talk Soup', handle: '@clipzworldnews', tiktokHandle: '@clipznashite', host: 'Bobby G' },
    sports: { showName: 'Other Side of the Pillow', handle: '@clipzworldnews', tiktokHandle: '@clipznashite', host: 'Bobby G' },
    news:   { showName: 'Because the Light Was On', handle: '@clipzworldnews', tiktokHandle: '@clipznashite', host: 'Bobby G' },
  };
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const custCfg = loadCustomerConfig('c0', 'long-form');
    const showNames = custCfg?.designDefaults?.voice?.showName;
    if (showNames) {
      if (showNames.clips)  channelConfig.clips.showName  = showNames.clips;
      if (showNames.sports) channelConfig.sports.showName = showNames.sports;
      if (showNames.news)   channelConfig.news.showName   = showNames.news;
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
  const streamerCredits = contentType === 'twitch' && streamers.length
    ? streamers.map(s => {
        // streamers can be plain strings or {displayName, twitchUsername} objects
        const name = typeof s === 'string' ? s : (s.twitchUsername || s.displayName || '');
        const key = name.toLowerCase().replace(/\s+/g, '');
        const entry = streamerRoster[key];
        const url = entry ? `https://twitch.tv/${entry.username}` : `https://twitch.tv/${key}`;
        const display = typeof s === 'object' && s.displayName ? s.displayName : (entry ? (entry.displayName || name) : name);
        return `• ${display}: ${url}`;
      }).join('\n')
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

  // Content descriptors for prompt context
  const contentDescriptors = {
    twitch: `Twitch clips compilation featuring: ${streamers.join(', ') || 'multiple streamers'}`,
    nba:    buildNbaContext(items),
    news:   buildNewsContext(items),
  };
  const cd = contentDescriptors[contentType] || contentDescriptors.news;

  // Shared YouTube Growth Strategist prompt (CPD-880)
  const systemPrompt = buildPublishCopySystemPrompt({
    cc, cd,
    date: date || 'today',
    isShort,
    epLabel,
    scriptExcerpt,
    streamerCredits,
    chaptersBlock,
    contentType,
    itemCount: items.length,
    needsTikTok,
    needsInstagram
  });

  try {
    // ── Short-form: generate optimised caption + hashtags + altText first ──
    let shortCaption = null;
    if (isShort) {
      try {
        shortCaption = await generateShortFormCaption(script, contentType);
        console.log(`[publish-copy] Short-form caption generated: "${shortCaption.caption.slice(0, 60)}..." (${shortCaption.caption.length} chars)`);
      } catch(e) {
        console.warn(`[publish-copy] generateShortFormCaption failed: ${e.message} — continuing without short caption`);
      }
    }

    const metadata = await _generateMetadataJson(systemPrompt, 'publish-copy');

    // bestTitle drives titles[0] / youtube.title (CPD-880)
    applyBestTitleShim(metadata);

    // ── Inject short-form caption into platform metadata ──────────────
    if (isShort && shortCaption) {
      if (metadata.tiktok) {
        metadata.tiktok.caption = shortCaption.caption + '\n\n' + shortCaption.hashtags.map(h => '#' + h).join(' ');
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
      res.json({
        ok: true,
        platforms: metadata,
        contentType,
        formType
      });
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
  let channelConfig = {
    // handle = YouTube channel; tiktokHandle = TikTok account (@clipznashite is TikTok-only — Rob 2026-06-11)
    clips:  { showName: 'Talk Soup', handle: '@clipzworldnews', tiktokHandle: '@clipznashite', host: 'Bobby G' },
    sports: { showName: 'Other Side of the Pillow', handle: '@clipzworldnews', tiktokHandle: '@clipznashite', host: 'Bobby G' },
    news:   { showName: 'Because the Light Was On', handle: '@clipzworldnews', tiktokHandle: '@clipznashite', host: 'Bobby G' },
  };
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const custCfg = loadCustomerConfig('c0', 'long-form');
    const showNames = custCfg?.designDefaults?.voice?.showName;
    if (showNames) {
      if (showNames.clips)  channelConfig.clips.showName  = showNames.clips;
      if (showNames.sports) channelConfig.sports.showName = showNames.sports;
      if (showNames.news)   channelConfig.news.showName   = showNames.news;
    }
  } catch (e) {}

  // Use designSpec.voice.showName if available (highest authority)
  if (designSpec?.voice?.showName) {
    let vcKey = baseContentType;
    if (['twitch', 'clips', 'streamer'].some(t => baseContentType.includes(t))) vcKey = 'clips';
    if (['nba', 'sports', 'basketball'].some(t => baseContentType.includes(t))) vcKey = 'sports';
    if (channelConfig[vcKey]) channelConfig[vcKey].showName = designSpec.voice.showName;
  }

  let ccKey = baseContentType;
  if (['twitch', 'clips', 'streamer'].some(t => baseContentType.includes(t))) ccKey = 'clips';
  if (['nba', 'sports', 'basketball'].some(t => baseContentType.includes(t))) ccKey = 'sports';
  const cc = channelConfig[ccKey] || channelConfig.news;

  // For Twitch: items are streamers — build credits block
  const streamers = baseContentType === 'twitch' ? items : [];
  const streamerCredits = streamers.length
    ? streamers.map(s => {
        const name = typeof s === 'string' ? s : (s.twitchUsername || s.displayName || s.title || '');
        const key = name.toLowerCase().replace(/\s+/g, '');
        const entry = streamerRoster[key];
        const url = entry ? `https://twitch.tv/${entry.username}` : `https://twitch.tv/${key}`;
        const display = typeof s === 'object' && s.displayName ? s.displayName : (entry ? (entry.displayName || name) : name);
        return `• ${display}: ${url}`;
      }).join('\n')
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

  const contentDescriptors = {
    twitch: `Twitch clips compilation featuring: ${streamers.map(s => (typeof s === 'object' ? s.displayName || s.title : s) || '').filter(Boolean).join(', ') || 'multiple streamers'}`,
    nba:    buildNbaContextG1(items),
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

  // Inject short-form caption
  if (isShort && shortCaption) {
    if (metadata.tiktok) {
      metadata.tiktok.caption = shortCaption.caption + '\n\n' + shortCaption.hashtags.map(h => '#' + h).join(' ');
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
  return {
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
  handlePublish,
  handleGeneratePublishCopy
};
