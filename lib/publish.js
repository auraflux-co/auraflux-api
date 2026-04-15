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
  const { contentType, formType, script, date, streamers = [], items = [], platforms = ['youtube'] } = req.body;

  if (!script) return res.status(400).json({ error: 'script required' });

  const isShort = formType === 'short';
  const scriptExcerpt = script.substring(0, 600);
  // Build story headline list for news content (Gap #13)
  const newsHeadlines = items.length
    ? items.map((it, i) => `${i + 1}. ${it.headline || it.title || it.story || ''}`.trim()).filter(Boolean).join('\n')
    : '';
  // Build game matchup list for NBA content (Gap #34)
  const gameMatchups = items.length
    ? items.map((it, i) => {
        const teams = it.matchup || it.teams || it.title || '';
        const score = it.score || it.finalScore || '';
        return `${i + 1}. ${teams}${score ? ` (${score})` : ''}`.trim();
      }).filter(Boolean).join('\n')
    : '';
  const needsTikTok = platforms.includes('tiktok');
  const needsInstagram = platforms.includes('instagram');
  const needsYouTube = platforms.includes('youtube');

  // Multi-platform prompt - generates metadata for all requested platforms
  const prompts = {
    nba: `Generate publish metadata for this NBA ${isShort ? 'Short' : 'highlights compilation'} for ${platforms.join(', ')}.

Date: ${date}
${gameMatchups ? `\nGames covered:\n${gameMatchups}\n` : ''}Script excerpt:
${scriptExcerpt}...

Generate metadata for each platform with these requirements:

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '50-100'} chars max, include team names + hook
- Description: ${isShort ? '100-150 words' : '200-300 words'}, game summary, stats, subscribe CTA
- Hashtags: ${isShort ? '10-15' : '5-8'} tags (#NBA, #Lakers, etc.)
- Pinned Comment: Engagement question
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars optimal (max 2200), hook in first 40 chars, include emojis
- Mix 4-6 hashtags into caption naturally (#NBA #LeBron #FYP #ForYou)
- No separate title/description - ONE caption field
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: 125 char hook, then full description with line breaks, max 2200 chars total
- Include emojis and call-to-action
- 10-15 hashtags at end of caption (#NBA #Reels #Explore #Lakers etc.)
- No separate title - ONE caption field
` : ''}

Output as JSON with this structure:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`,

    news: `Generate publish metadata for this world news ${isShort ? 'Short' : 'compilation'} for ${platforms.join(', ')}.

Date: ${date}
${newsHeadlines ? `\nStory headlines covered:\n${newsHeadlines}\n` : ''}Script excerpt:
${scriptExcerpt}...

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '50-100'} chars, main story hook
- Description: ${isShort ? '100-150 words' : '200-300 words'}, story summaries, subscribe CTA
- Hashtags: ${isShort ? '10-15' : '5-8'} tags (#News, #WorldNews, topic-specific)
- Pinned Comment: Ask which story concerns viewers most
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars, urgent/compelling hook with emojis
- Mix 4-6 hashtags (#News #Breaking #FYP #ForYou)
- ONE caption field (no separate title/description)
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Hook in first 125 chars, full story summary, emojis, line breaks
- 10-15 hashtags at end (#News #WorldNews #Reels #Explore)
- ONE caption field
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`,

    twitch: `Generate publish metadata for this Twitch clips ${isShort ? 'Short' : 'compilation'} for ${platforms.join(', ')}.

Date: ${date}
Streamers: ${streamers.join(', ') || 'Multiple streamers'}
Script excerpt:
${scriptExcerpt}...

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '50-100'} chars, streamer names + funny hook
- Description: ${isShort ? '100-150 words' : 'List each streamer with Twitch link, what they did, subscribe CTA'}
- Hashtags: ${isShort ? '10-15' : '5-8'} tags (#Twitch, streamer names, #Gaming)
- Pinned Comment: Ask which clip was funniest
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars, funniest moment hook with emojis
- Mix 4-6 hashtags (#Twitch #Gaming #FYP #ForYou)
- Include streamer names naturally
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Hook + clip description with emojis, line breaks for readability
- 10-15 hashtags (#Twitch #Gaming #Reels #Explore #StreamerName)
- Tag streamers if possible: @streamername
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`
  };

  const showNames = { nba: 'ClipzWorld Sports', news: 'ClipzWorld News', twitch: 'ClipzWorld' };
  const showName = showNames[contentType] || 'ClipzWorld News';

  const voiceRules = `Bobby G's voice: flat delivery, never says "incredible/amazing/crazy/wild", short punchy sentences, lets clips speak, ends compilations with "I'm Bobby G. See you tomorrow." and shorts with "Subscribe. Appreciate you."`;

  const systemPrompt = `You generate multi-platform publish metadata for ${showName} (@clipzworldnews).

${voiceRules}

${prompts[contentType] || prompts.twitch}

STRICT RULES:
- YouTube titles: max 100 chars (hard limit)
- TikTok captions: optimal 90-150 chars for engagement (max 2200)
- Instagram captions: hook in first 125 chars (gets truncated)
- All platforms: include "${showName}" or "@clipzworldnews" mention
- Hashtags: platform-appropriate (#Shorts for YouTube, #FYP for TikTok, #Reels for Instagram)
- Output ONLY valid JSON, no markdown code blocks, no explanation
- Use double quotes for all JSON strings`;

  try {
    // ── Short-form: generate optimised caption + hashtags + altText first ──
    // These are injected into the platform metadata for TikTok/Reels/Shorts
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Generate the metadata as JSON now.' }]
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Extract JSON (Claude might wrap in ```json or include explanation)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[publish-copy] Could not extract JSON from response:', text);
      throw new Error('Could not parse JSON from Claude response');
    }

    const metadata = JSON.parse(jsonMatch[0]);

    // ── Inject short-form caption into platform metadata ──────────────
    // For short-form: override TikTok/Instagram captions with the optimised
    // short caption, and add altText + hashtags to all platforms.
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
        // For YouTube Shorts: append #Shorts to title if not already there
        if (metadata.youtube.title && !metadata.youtube.title.includes('#Shorts')) {
          metadata.youtube.title = metadata.youtube.title.trim() + ' #Shorts';
          if (metadata.youtube.title.length > 100) {
            metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
          }
        }
        metadata.youtube.altText = shortCaption.altText;
        // Add short-form hashtags to YouTube hashtags array
        if (Array.isArray(metadata.youtube.hashtags)) {
          const shortHashtags = shortCaption.hashtags.filter(h => !metadata.youtube.hashtags.includes(h));
          metadata.youtube.hashtags = [...metadata.youtube.hashtags, ...shortHashtags].slice(0, 15);
        }
      }
      // Attach raw short caption data for dashboard display
      metadata._shortCaption = shortCaption;
    }

    // Validate platform-specific metadata
    if (needsYouTube && metadata.youtube) {
      // Enforce YouTube title length (hard limit is 100 chars)
      if (metadata.youtube.title && metadata.youtube.title.length > 100) {
        console.warn(`[publish-copy] YouTube title too long (${metadata.youtube.title.length} chars), truncating...`);
        metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
      }

      // Ensure hashtags is array
      if (!Array.isArray(metadata.youtube.hashtags)) {
        metadata.youtube.hashtags = [];
      }

      // Add metrics
      metadata.youtube.titleLength = metadata.youtube.title?.length || 0;
      metadata.youtube.descriptionLength = metadata.youtube.description?.length || 0;
      metadata.youtube.hashtagCount = metadata.youtube.hashtags?.length || 0;
    }

    if (needsTikTok && metadata.tiktok) {
      metadata.tiktok.captionLength = metadata.tiktok.caption?.length || 0;
    }

    if (needsInstagram && metadata.instagram) {
      metadata.instagram.captionLength = metadata.instagram.caption?.length || 0;
    }

    // Log summary
    const summary = platforms.map(p => {
      if (p === 'youtube' && metadata.youtube) {
        return `YouTube: ${metadata.youtube.titleLength} char title, ${metadata.youtube.hashtagCount} hashtags`;
      }
      if (p === 'tiktok' && metadata.tiktok) {
        return `TikTok: ${metadata.tiktok.captionLength} char caption`;
      }
      if (p === 'instagram' && metadata.instagram) {
        return `Instagram: ${metadata.instagram.captionLength} char caption`;
      }
      return null;
    }).filter(Boolean).join(', ');

    console.log(`[publish-copy] Generated metadata: ${summary}`);

    // Backward compatibility: if only YouTube requested, return flat structure
    if (platforms.length === 1 && platforms[0] === 'youtube' && metadata.youtube) {
      res.json({
        ok: true,
        ...metadata.youtube,  // Flat structure for backward compatibility
        platforms: { youtube: metadata.youtube }  // Also include nested for future use
      });
    } else {
      res.json({
        ok: true,
        platforms: metadata,
        // Add convenience fields if all platforms have same content type
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
