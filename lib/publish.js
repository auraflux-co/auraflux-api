'use strict';
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const { log } = require('./logger');
const { callClaudeAPI } = require('./qa');
const { StageTimer, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./metrics');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const UPLOAD_STATUS_PATH = path.join(__dirname, '..', 'data', 'upload_status.json');

// Drive service account key — defined here (moved from server.js during module split)
const DRIVE_KEY_PATH   = path.join(__dirname, '..', 'cwn-drive-key.json');
const DRIVE_FOLDER_NAME = 'CWN Videos';

// Cached Drive folder ID after first lookup
let _driveFolderId = null;

// Anthropic client — module-level, mirrors server.js:536
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    try {
      const CLIENT_ID     = process.env.DRIVE_CLIENT_ID     || '281415000137-u3qh2evajigmhsmft2s3rgeidqq97ueu.apps.googleusercontent.com';
      const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET || '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';
      const oauth2Client  = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
      oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
      return google.drive({ version: 'v3', auth: oauth2Client });
    } catch(e) {
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

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Generate the short-form caption JSON now.' }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('generateShortFormCaption: could not parse JSON from Claude');

  const result = JSON.parse(jsonMatch[0]);
  // Normalise hashtags — strip any accidental # prefix
  if (Array.isArray(result.hashtags)) {
    result.hashtags = result.hashtags.map(h => h.replace(/^#/, ''));
  }
  return result;
}


async function handlePublish(req, res) {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipzworldnews';

  if (!UPLOADPOST_API_KEY) {
    return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set in .env' });
  }

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

  // Initialize metrics tracking
  const jobId = metricsJobId || `publish_${Date.now()}`;
  if (!metricsJobId) initJobMetrics(jobId);
  const publishTimer = new StageTimer(jobId, 'Upload-Post Publish');

  if (!driveUrl && !filename) {
    return res.status(400).json({ error: 'driveUrl or filename required' });
  }

  // Use Drive URL directly (Upload-Post accepts public URLs)
  const videoUrl = driveUrl || null;
  if (!videoUrl) {
    return res.status(400).json({ error: 'driveUrl required — Upload-Post needs a public URL' });
  }

  console.log(`[upload-post] Publishing to: ${platforms.join(', ')}`);
  console.log(`[upload-post] Video URL: ${videoUrl}`);
  console.log(`[upload-post] Title: ${title}`);
  if (scheduledAt) console.log(`[upload-post] Scheduled: ${scheduledAt}`);

  try {
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
    console.log(`[upload-post] ✅ Response received`);
    if (request_id) console.log(`[upload-post]    request_id: ${request_id}`);
    if (job_id) console.log(`[upload-post]    job_id: ${job_id} (scheduled)`);

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
      setImmediate(() => {
        let attempts = 0;
        const maxAttempts = 10;
        const intervalMs = 30000;
        const poll = async () => {
          attempts++;
          try {
            const statusRes = await axios.get(
              `https://api.upload-post.com/api/uploadposts/status?request_id=${request_id}`,
              { headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}` }, timeout: 10000 }
            );
            const { status, platforms: platformResults } = statusRes.data;
            console.log(`[upload-post] Poll ${attempts}/${maxAttempts} — status: ${status}`);
            if (Array.isArray(platformResults)) {
              platformResults.forEach(p => {
                console.log(`[upload-post]   ${p.platform}: ${p.status}${p.url ? ' -> ' + p.url : ''}`);
              });
            }
            if (status === 'done' || status === 'completed' || status === 'failed') return;
            if (attempts < maxAttempts) setTimeout(poll, intervalMs);
          } catch (pollErr) {
            console.warn(`[upload-post] Polling warn (attempt ${attempts}): ${pollErr.message}`);
          }
        };
        setTimeout(poll, intervalMs);
      });
    }
  } catch(e) {
    const errData = e.response?.data;
    console.error('[upload-post] Publish failed:', e.message, errData || '');

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
  let streamerRoster = {};
  try {
    const rosterRaw = require('fs').readFileSync(require('path').join(__dirname, '../data/streamers.json'), 'utf8');
    const rosterArr = JSON.parse(rosterRaw);
    for (const s of rosterArr) {
      if (s.username) streamerRoster[s.username.toLowerCase()] = s;
    }
  } catch (e) {
    // non-fatal — streamer URLs will be omitted
  }

  // Channel config: show names from customerConfig (c0.json designDefaults.voice.showName).
  // Fallback to hardcoded values if config unavailable.
  let channelConfig = {
    clips:  { showName: 'Talk Soup', handle: '@clipznashite', host: 'Bobby G' },
    sports: { showName: 'Other Side of the Pillow', handle: '@clipznashite', host: 'Bobby G' },
    news:   { showName: 'Because the Light Was On', handle: '@clipznashite', host: 'Bobby G' },
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

  // Content descriptors for prompt context
  const contentDescriptors = {
    twitch: `Twitch clips compilation featuring: ${streamers.join(', ') || 'multiple streamers'}`,
    nba:    `NBA highlights: ${items.map(it => it.headline || it.title || it.matchup || it.teams || '').filter(Boolean).join(', ') || 'today\'s games'}`,
    news:   `World news roundup: ${items.map(it => it.headline || it.title || it.story || '').filter(Boolean).join(', ') || 'today\'s top stories'}`,
  };
  const cd = contentDescriptors[contentType] || contentDescriptors.news;

  const systemPrompt = `You are an SEO copywriter for ${cc.showName} (YouTube channel, host: ${cc.host}, handle: ${cc.handle}).

Content: ${cd}
Date: ${date || 'today'}
Form: ${isShort ? 'Short (60-90 sec vertical)' : 'Long-form compilation (3-5 min)'}
${epLabel ? `Episode: ${epLabel}` : ''}

Script excerpt (up to 4000 chars):
${scriptExcerpt}
${streamerCredits ? `\nStreamers featured:\n${streamerCredits}` : ''}
${chaptersBlock}

TASK: Generate SEO-optimised YouTube publish metadata. Return ONLY valid JSON with this exact schema:

{
  "hookMoment": "<one-line description of the single funniest/most surprising moment in the script>",
  "youtube": {
    "titles": [
      "<Title option 1 — 55-60 chars, hook-first, no clickbait>",
      "<Title option 2 — different angle, same length>",
      "<Title option 3 — streamer/team/story names prominent>",
      "<Title option 4 — question or curiosity-gap format>",
      "<Title option 5 — numbers or lists format>"
    ],
    "description": "<Full YouTube description: 200-350 words. Lead with the hook moment. Summarise each segment/streamer/story in 1-2 sentences. Include subscribe CTA. End with ${cc.handle}. Use line breaks for readability.${streamerCredits ? ' Include streamer Twitch URLs section.' : ''}${chaptersBlock ? ' Include CHAPTERS section verbatim.' : ''}>",
    "playlistDescription": "<60-80 word playlist description for '${cc.showName}' YouTube playlist. Tone: dry, punchy, Bobby G voice.>",
    "tags": [<10-15 YouTube search tags as strings, no # prefix, mix broad + specific>],
    "hashtags": [<5-8 hashtags WITH # prefix for description footer, platform-appropriate>],
    "thumbnailTextIdeas": [
      "<Thumbnail text option 1 — 3-5 words max, high contrast>",
      "<Thumbnail text option 2>",
      "<Thumbnail text option 3>"
    ],
    "pinnedComment": "<Engagement question for pinned comment, 1 sentence>"
  }${needsTikTok ? `,
  "tiktok": {
    "caption": "<90-150 chars hook + 4-6 hashtags. No separate title.>"
  }` : ''}${needsInstagram ? `,
  "instagram": {
    "caption": "<Hook in first 125 chars. Full description with line breaks. 10-15 hashtags at end.>"
  }` : ''}
}

STRICT RULES:
- All 5 title options must be unique angles, 55-65 chars each (hard max: 100)
- tags: plain words/phrases, NO # prefix (e.g. "NBA highlights" not "#NBA")
- hashtags: WITH # prefix, 5-8 items (e.g. "#NBA" "#Twitch")
- Output ONLY valid JSON — no markdown fences, no explanation
- Use double quotes for all JSON strings`;

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

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Generate the metadata JSON now.' }]
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[publish-copy] Could not extract JSON from response:', text);
      throw new Error('Could not parse JSON from Claude response');
    }

    const metadata = JSON.parse(jsonMatch[0]);

    // Backward-compat shim: expose first title as metadata.youtube.title
    if (metadata.youtube && Array.isArray(metadata.youtube.titles) && metadata.youtube.titles.length) {
      metadata.youtube.title = metadata.youtube.titles[0];
    }

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


module.exports = {
  getDriveClient,
  getDriveFolderId,
  uploadToDrive,
  importToCanva,
  readUploadStatus,
  writeUploadStatus,
  logUploadAttempt,
  generateShortFormCaption,
  handlePublish,
  handleGeneratePublishCopy
};
