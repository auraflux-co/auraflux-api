'use strict';
// C0-ONLY — CapCut Progressive Assembly + Short-Form (Shorts, Teach, Burn-Intro)
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { execFile } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { ffmpegPath: _ffmpegDockerPath } = require('../ffmpeg_utils');
const { SYSTEM_FONT } = require('../services/branding_assets');

const ROOT_DIR = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;
const CAPCUT_URL = process.env.CAPCUT_URL || 'http://localhost:9001';

function ffmpegPath() {
  return _ffmpegDockerPath();
}

async function capcut(endpoint, body) {
  const resp = await axios.post(`${CAPCUT_URL}${endpoint}`, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return resp.data;
}

// Active CapCut drafts: jobId → { draftId, segments, width, height, fps, contentType, format }
const capcutDrafts = {};

// ── CapCut Progressive Assembly ──────────────────────────────────
// Builds a CapCut draft incrementally as HeyGen segments complete.
// Instead of waiting for ALL segments, the draft is populated in real-time.
// Final render is triggered when the last segment is added.
//
// Flow:
//   1. POST /capcut/init         → create draft, return draft_id
//   2. POST /capcut/add-segment  → add each segment as it arrives (called repeatedly)
//   3. POST /capcut/finalize     → save draft, return CapCut draft URL
//   4. POST /capcut/ticker       → add ticker text element to draft
//   5. POST /capcut/thumbnail    → extract best frame as thumbnail

// GET /capcut/health — check if CapCut MCP server is running
router.get('/capcut/health', async (req, res) => {
  try {
    const resp = await axios.post(`${CAPCUT_URL}/health`, {}, { timeout: 5000 });
    res.json({ ok: true, capcut: 'online', url: CAPCUT_URL, data: resp.data });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: 'CapCut MCP server not running',
      url: CAPCUT_URL,
      hint: 'Start the CapCut MCP server on port 9001',
      details: e.message,
    });
  }
});

// POST /capcut/init — create a new CapCut draft for a job
router.post('/capcut/init', async (req, res) => {
  const { jobId, contentType = 'twitch', format = 'landscape' } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const width = format === 'portrait' ? 1080 : 1920;
  const height = format === 'portrait' ? 1920 : 1080;
  const fps = 30;

  try {
    const result = await capcut('/create_draft', { width, height, fps });
    const draftId = result?.result?.draft_id || result?.draft_id;
    if (!draftId)
      return res.status(500).json({ error: 'CapCut did not return draft_id', raw: result });

    capcutDrafts[jobId] = { draftId, segments: [], width, height, fps, contentType, format };
    console.log(`[capcut] ✅ Draft created for job ${jobId}: ${draftId}`);
    res.json({ ok: true, draftId, jobId });
  } catch (e) {
    console.error('[capcut] Init failed:', e.message);
    res.status(500).json({ error: e.message, hint: 'Is CapCut MCP server running on port 9001?' });
  }
});

// POST /capcut/add-segment — add a segment to the draft as it arrives
// Call this for each HeyGen avatar segment as it completes AND each source clip
router.post('/capcut/add-segment', async (req, res) => {
  const { jobId, segmentUrl, segmentType = 'avatar', label = '', localPath = '' } = req.body;
  if (!jobId || (!segmentUrl && !localPath))
    return res.status(400).json({ error: 'jobId + segmentUrl or localPath required' });

  const draft = capcutDrafts[jobId];
  if (!draft)
    return res
      .status(404)
      .json({ error: `No draft found for job ${jobId} — call /capcut/init first` });

  const position = draft.segments.length;
  const url = localPath || segmentUrl;

  try {
    // Get duration first
    const dur = await new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        url,
      ];
      execFile(ffprobePath(), args, (err, stdout) => {
        resolve(parseFloat(stdout) || 10);
      });
    });

    const result = await capcut('/add_video', {
      draft_id: draft.draftId,
      video_url: url,
      start: 0,
      end: dur,
      volume: segmentType === 'source_clip' ? 0.7 : 1.0, // source clips slightly quieter
      transition: position > 0 ? 'cut' : undefined,
    });

    draft.segments.push({ url, type: segmentType, label, duration: dur, position });
    console.log(`[capcut] ✅ Added segment ${position + 1} (${segmentType}): ${label}`);
    res.json({
      ok: true,
      position: position + 1,
      totalSegments: draft.segments.length,
      duration: dur,
    });
  } catch (e) {
    console.error(`[capcut] Add segment failed for ${label}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/ticker — add scrolling ticker text overlay to draft
router.post('/capcut/ticker', async (req, res) => {
  const {
    jobId,
    tickerText = 'CLIPZWORLD NEWS  •  THE DAILY UPDATE  •  @clipznashite  •  ',
    totalDuration,
  } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId}` });

  try {
    // Add scrolling ticker as a text element at bottom of frame
    await capcut('/add_text', {
      draft_id: draft.draftId,
      text: tickerText.repeat(5), // repeat for scroll effect
      start: 0,
      end: totalDuration || 1500,
      font_size: 24,
      font_color: '#c7af4f',
      background_color: '#22304b',
      background_alpha: 0.95,
      transform_y: draft.height - 64, // bottom of frame
      animation: 'scroll_left',
    });

    console.log(`[capcut] ✅ Ticker added to draft ${draft.draftId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[capcut] Ticker failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/logo — add CWN logo bug to draft
router.post('/capcut/logo', async (req, res) => {
  const { jobId, logoUrl, totalDuration } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId}` });

  try {
    await capcut('/add_image', {
      draft_id: draft.draftId,
      image_url: logoUrl || `http://localhost:8765/logo_cwn.png`,
      start: 0,
      end: totalDuration || 1500,
      transform_x: draft.width - 140,
      transform_y: 20,
      scale_x: 0.85,
      scale_y: 0.85,
    });

    console.log(`[capcut] ✅ Logo bug added`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[capcut] Logo failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/finalize — save draft and return path for CapCut to render
router.post('/capcut/finalize', async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId}` });

  try {
    const result = await capcut('/save_draft', { draft_id: draft.draftId });
    const draftUrl = result?.result?.draft_url || result?.draft_url || '';

    console.log(`[capcut] ✅ Draft saved: ${draftUrl}`);
    console.log(`[capcut]    Total segments: ${draft.segments.length}`);
    console.log(`[capcut]    Open CapCut → File → Open → select draft to render`);

    // Clean up draft state (keep for 1 hour in case of re-finalize)
    setTimeout(() => {
      delete capcutDrafts[jobId];
    }, 3600000);

    res.json({
      ok: true,
      draftId: draft.draftId,
      draftUrl,
      totalSegments: draft.segments.length,
      instructions: 'Open CapCut → File → Open Project → select draft → Export',
    });
  } catch (e) {
    console.error('[capcut] Finalize failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /capcut/status/:jobId — check draft build progress
router.get('/capcut/status/:jobId', (req, res) => {
  const draft = capcutDrafts[req.params.jobId];
  if (!draft) return res.status(404).json({ error: 'No draft found' });
  res.json({
    ok: true,
    draftId: draft.draftId,
    totalSegments: draft.segments.length,
    segments: draft.segments.map((s) => ({ label: s.label, type: s.type, duration: s.duration })),
  });
});

// ── Phase 2.2: Portrait Thumbnail Frame Extraction ────────────────
// POST /thumbnail-short
// Body: { videoPath, contentType, jobId }
// Finds highest-motion frame in assembled short-form video — clean still only
// (shorts are not VOD episodes; no show name / EP / tagline burn).
// Output: thumbnail_short_{type}_ep{N}_{timestamp}.png in ./output/
router.post('/thumbnail-short', async (req, res) => {
  const { videoPath, contentType = 'twitch', jobId = '' } = req.body;
  if (!videoPath) return res.status(400).json({ error: 'videoPath required' });

  const localPath = videoPath.startsWith('http')
    ? path.join(TMP_DIR, `thumb_src_${Date.now()}.mp4`)
    : videoPath;

  try {
    // Download if remote URL
    if (videoPath.startsWith('http')) {
      console.log(`[thumbnail-short] Downloading video for frame extraction...`);
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        const protocol = videoPath.startsWith('https') ? require('https') : require('http');
        protocol
          .get(videoPath, (response) => {
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          })
          .on('error', reject);
      });
    }

    // Get video duration
    const duration = await probeDuration(localPath);
    console.log(`[thumbnail-short] Video duration: ${duration.toFixed(2)}s`);

    // Find highest-motion frame using ffprobe scene detection
    // scene=0.3 threshold — picks frames with significant visual change
    let bestTimestamp = duration * 0.3; // fallback: 30% mark
    try {
      const sceneData = await new Promise((resolve, reject) => {
        const args = [
          '-i',
          localPath,
          '-vf',
          'select=gt(scene\\,0.3),showinfo',
          '-vsync',
          'vfr',
          '-f',
          'null',
          '-',
        ];
        execFile(
          ffprobePath(),
          [
            '-v',
            'quiet',
            '-show_frames',
            '-select_streams',
            'v',
            '-read_intervals',
            `%+${Math.min(duration, 60)}`,
            '-show_entries',
            'frame=pkt_pts_time,pict_type',
            '-of',
            'csv=p=0',
            localPath,
          ],
          { maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              resolve(null);
              return;
            }
            // Parse frame timestamps — find I-frames (scene changes)
            const lines = stdout.trim().split('\n').filter(Boolean);
            const iFrames = lines
              .map((l) => {
                const parts = l.split(',');
                return { t: parseFloat(parts[0]), type: parts[1] };
              })
              .filter((f) => f.type === 'I' && f.t > 3 && f.t < duration - 3); // skip first/last 3s
            if (iFrames.length > 0) {
              // Pick the I-frame closest to 40% mark (usually peak action)
              const target = duration * 0.4;
              iFrames.sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target));
              resolve(iFrames[0].t);
            } else {
              resolve(null);
            }
          }
        );
      });
      if (sceneData !== null) {
        bestTimestamp = sceneData;
        console.log(
          `[thumbnail-short] Best frame at ${bestTimestamp.toFixed(2)}s (scene detection)`
        );
      } else {
        console.log(
          `[thumbnail-short] Scene detection found no I-frames — using 30% mark (${bestTimestamp.toFixed(2)}s)`
        );
      }
    } catch (e) {
      console.warn(`[thumbnail-short] Scene detection failed: ${e.message} — using fallback`);
    }

    // Get episode counter for this content type
    const epCounters = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(ROOT_DIR, 'data/episode_counters.json'), 'utf8')
        );
      } catch (e) {
        return {};
      }
    })();
    const epKey = `${contentType}_short`;
    const epNum = (epCounters[epKey] || 0) + 1;
    epCounters[epKey] = epNum;
    try {
      fs.writeFileSync(
        path.join(ROOT_DIR, 'data/episode_counters.json'),
        JSON.stringify(epCounters, null, 2)
      );
    } catch (e) {}

    // Build output path
    const outDir = OUTPUT_DIR;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = Date.now();
    const outFile = `thumbnail_short_${contentType}_ep${epNum}_${ts}.png`;
    const outPath = path.join(outDir, outFile);

    // Extract frame — clean still (no tagline / EP badge; YT custom thumb at publish)
    const vf = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';

    await new Promise((resolve, reject) => {
      const args = [
        '-ss',
        bestTimestamp.toFixed(3),
        '-i',
        localPath,
        '-vframes',
        '1',
        '-vf',
        vf,
        '-q:v',
        '2',
        '-y',
        outPath,
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Frame extract failed: ${code}`))
      );
      proc.on('error', reject);
    });

    console.log(`[thumbnail-short] ✅ Thumbnail saved: ${outPath}`);

    // Clean up downloaded temp file
    if (videoPath.startsWith('http')) {
      try {
        fs.unlinkSync(localPath);
      } catch (e) {}
    }

    res.json({
      ok: true,
      thumbnailPath: outPath,
      thumbnailUrl: `/download/${outFile}`,
      episode: epNum,
      frameTimestamp: bestTimestamp,
      contentType,
    });
  } catch (e) {
    console.error(`[thumbnail-short] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Phase 2.3: TikTok / Reels Safety Zone Validation ─────────────
// POST /safety-zone-check
// Body: { jobId, contentType, avatarFaceX, avatarFaceY }
// Validates Bobby G avatar face position doesn't overlap platform UI buttons.
// Returns: { safe: true/false, warnings: [], zones: { tiktok, reels } }
//
// Safe zones per VISUAL_DESIGN_SPEC.md:
//   TikTok: avoid bottom-right 200×400px (x=880, y=1520)
//   Reels:  avoid bottom 150px (y=1770)
router.post('/safety-zone-check', (req, res) => {
  const {
    jobId = '',
    contentType = 'twitch',
    // Avatar face center — defaults to center of AVATAR_ZONE (540, 1200)
    avatarFaceX = 540,
    avatarFaceY = 1200,
    // Avatar face radius for overlap detection (pixels)
    avatarFaceRadius = 120,
  } = req.body;

  const SAFETY_ZONES = {
    tiktok: { x: 880, y: 1520, w: 200, h: 400, label: 'TikTok like/share/comment buttons' },
    reels: { x: 0, y: 1770, w: 1080, h: 150, label: 'Instagram Reels caption area' },
  };

  const warnings = [];
  const results = {};

  for (const [platform, zone] of Object.entries(SAFETY_ZONES)) {
    // Check if avatar face circle overlaps the UI zone rectangle
    // Simple AABB + circle overlap: closest point on rect to circle center
    const closestX = Math.max(zone.x, Math.min(avatarFaceX, zone.x + zone.w));
    const closestY = Math.max(zone.y, Math.min(avatarFaceY, zone.y + zone.h));
    const distX = avatarFaceX - closestX;
    const distY = avatarFaceY - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    const overlaps = distance < avatarFaceRadius;

    results[platform] = {
      safe: !overlaps,
      zone,
      avatarFace: { x: avatarFaceX, y: avatarFaceY, radius: avatarFaceRadius },
      distance: Math.round(distance),
      margin: Math.round(distance - avatarFaceRadius),
    };

    if (overlaps) {
      const msg = `⚠️ [safety-zone] ${platform.toUpperCase()} OVERLAP DETECTED — avatar face at (${avatarFaceX}, ${avatarFaceY}) overlaps ${zone.label} (${zone.x},${zone.y} ${zone.w}×${zone.h}). Distance: ${Math.round(distance)}px, radius: ${avatarFaceRadius}px`;
      warnings.push(msg);
      console.warn(msg);
    } else {
      console.log(
        `[safety-zone] ✅ ${platform.toUpperCase()} safe — avatar face ${Math.round(distance)}px from UI zone (margin: ${Math.round(distance - avatarFaceRadius)}px)`
      );
    }
  }

  const allSafe = warnings.length === 0;
  res.json({
    ok: true,
    safe: allSafe,
    jobId,
    contentType,
    warnings,
    zones: results,
    recommendation: allSafe
      ? '✅ Avatar position is safe for all platforms'
      : '⚠️ Avatar overlaps platform UI — flag for Rob review before publishing',
  });
});

// ── Phase 2: CapCut Thumbnail Extraction ──────────────────────────
// POST /capcut/thumbnail
// Body: { jobId, videoPath, timestamp }
// Extracts a frame from the assembled video and adds it to the CapCut draft as cover
router.post('/capcut/thumbnail', async (req, res) => {
  const { jobId, videoPath, timestamp } = req.body;
  if (!jobId || !videoPath) return res.status(400).json({ error: 'jobId and videoPath required' });

  const draft = capcutDrafts[jobId];
  if (!draft)
    return res.status(404).json({ error: `No draft for ${jobId} — call /capcut/init first` });

  try {
    // Extract frame at given timestamp (or 30% mark)
    const duration = await probeDuration(videoPath);
    const ts = timestamp || duration * 0.3;
    const thumbPath = path.join(TMP_DIR, `capcut_thumb_${jobId}_${Date.now()}.png`);

    await new Promise((resolve, reject) => {
      const args = [
        '-ss',
        ts.toFixed(3),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '2',
        '-y',
        thumbPath,
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Frame extract failed: ${code}`))
      );
      proc.on('error', reject);
    });

    // Send thumbnail to CapCut draft as cover image
    const thumbUrl = `http://localhost:3000/download/${path.basename(thumbPath)}`;
    // Copy to output dir so it's accessible via /download/
    const outThumbPath = path.join(OUTPUT_DIR, path.basename(thumbPath));
    fs.copyFileSync(thumbPath, outThumbPath);

    await capcut('/add_image', {
      draft_id: draft.draftId,
      image_url: thumbUrl,
      start: 0,
      end: 1,
      transform_x: 0,
      transform_y: 0,
      scale_x: 1.0,
      scale_y: 1.0,
      is_cover: true,
    });

    try {
      fs.unlinkSync(thumbPath);
    } catch (e) {}
    console.log(`[capcut/thumbnail] ✅ Cover frame set at ${ts.toFixed(2)}s`);
    res.json({ ok: true, timestamp: ts, thumbUrl });
  } catch (e) {
    console.error('[capcut/thumbnail] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Phase 2: Short-Form Assembly Status ───────────────────────────
// GET /short-form-status/:jobId
// Returns current status of a short-form assembly job
router.get('/short-form-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const asmJob = assemblyJobs[jobId];
  if (!asmJob) return res.status(404).json({ error: 'No assembly job found', jobId });
  res.json({
    ok: true,
    jobId,
    status: asmJob.status || 'unknown',
    pct: asmJob.pct || 0,
    outputPath: asmJob.outputPath || null,
    format: asmJob.format || 'portrait',
  });
});

// ── Teach Gemini Streamer Language ────────────────────────────────
// One-off task: Gemini watches ~10 recent VOD clips per streamer
// Stores vocabulary, recurring bits, and community references in cwn_style_guides.json
// Dashboard button: Settings → "Teach Gemini Streamer Language"
//
// POST /teach-streamer-language
// Body: { streamer: 'maya', vodUrls: ['url1','url2'...] }
//   OR: { streamer: 'maya', autoFetch: true } → fetches recent clips from Twitch
router.post('/teach-streamer-language', async (req, res) => {
  const { streamer, vodUrls = [], autoFetch = false } = req.body;
  if (!streamer) return res.status(400).json({ error: 'streamer required' });
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY required' });

  console.log(`[streamer-language] Teaching Gemini the language of ${streamer}...`);

  let clipsToAnalyze = vodUrls;

  // Auto-fetch recent clips from Twitch if no URLs provided
  if (autoFetch && !vodUrls.length) {
    try {
      const userResp = await axios.get(`https://api.twitch.tv/helix/users?login=${streamer}`, {
        headers: {
          'Client-Id': process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${process.env.TWITCH_TOKEN}`,
        },
      });
      const userId = userResp.data?.data?.[0]?.id;
      if (userId) {
        const clipsResp = await axios.get(
          `https://api.twitch.tv/helix/clips?broadcaster_id=${userId}&first=10`,
          {
            headers: {
              'Client-Id': process.env.TWITCH_CLIENT_ID,
              Authorization: `Bearer ${process.env.TWITCH_TOKEN}`,
            },
          }
        );
        const clips = clipsResp.data?.data || [];
        clipsToAnalyze = clips
          .filter((c) => c.thumbnail_url)
          .map((c) => ({ thumbnailUrl: c.thumbnail_url, title: c.title, pageUrl: c.url }));
        console.log(
          `[streamer-language] Auto-fetched ${clipsToAnalyze.length} clips for ${streamer}`
        );
      }
    } catch (e) {
      console.warn(`[streamer-language] Auto-fetch failed: ${e.message}`);
    }
  }

  if (!clipsToAnalyze.length) {
    return res
      .status(400)
      .json({ error: 'No clips to analyze — provide vodUrls or set autoFetch:true' });
  }

  // Send to client immediately — analysis runs in background
  res.json({
    ok: true,
    message: `Analyzing ${clipsToAnalyze.length} clips for ${streamer}...`,
    streamer,
  });

  // Background analysis
  (async () => {
    try {
      const prompt = `You are building a language fingerprint for a Twitch streamer named "${streamer}" for CWN (ClipzWorld News).

Watch these clips from ${streamer}'s stream and extract:

1. VOCABULARY: Words, phrases, slang specific to this streamer/community (e.g. "rizz", "W", "cooked")
2. RECURRING BITS: Running jokes, catchphrases, recurring situations
3. COMMUNITY REFERENCES: Names of frequent collaborators, in-jokes, community lore
4. CONTENT STYLE: What kind of content do they make? What's their energy level?
5. NOTABLE MOMENTS: Any specific events/stories the community references often
6. TONE: How does their community describe them? What's the vibe?

This fingerprint will be used by Claude to write setup lines for Bobby G's reactions to their clips.
The goal: make the setups feel like they were written by someone who actually watches ${streamer}.

Format your response as a structured fingerprint with clear sections.
Be specific — generic descriptions are useless. Actual vocabulary and bit names are gold.`;

      const analyses = [];
      for (const clip of clipsToAnalyze.slice(0, 10)) {
        try {
          const url = typeof clip === 'string' ? clip : clip.thumbnailUrl || '';
          if (!url) continue;
          const analysis = await geminiAnalyzeClip('', url, 'twitch', {
            streamer,
            title: clip.title || '',
            pageUrl: clip.pageUrl || '',
          });
          if (analysis && analysis.length > 20) analyses.push(analysis);
          await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          console.warn(`[streamer-language] Clip analysis failed: ${e.message}`);
        }
      }

      // Final synthesis call
      const synthesisResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [
            { parts: [{ text: `${prompt}\n\nCLIP ANALYSES:\n${analyses.join('\n---\n')}` }] },
          ],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const fingerprint = (synthesisResp.data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();

      // Save to cwn_style_guides.json under streamer key
      const guidePath = path.join(ROOT_DIR, 'data/cwn_style_guides.json');
      let guides = {};
      try {
        guides = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
      } catch (e) {}
      if (!guides.streamers) guides.streamers = {};
      guides.streamers[streamer.toLowerCase()] = {
        fingerprint,
        clipsAnalyzed: analyses.length,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(guidePath, JSON.stringify(guides, null, 2));
      console.log(
        `[streamer-language] ✅ ${streamer} language fingerprint saved (${fingerprint.length} chars)`
      );
    } catch (e) {
      console.error(`[streamer-language] Background analysis failed for ${streamer}:`, e.message);
    }
  })();
});

// GET /teach-streamer-language/status — check which streamers have been taught
router.get('/teach-streamer-language/status', (req, res) => {
  const guidePath = path.join(ROOT_DIR, 'data/cwn_style_guides.json');
  let guides = {};
  try {
    guides = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
  } catch (e) {}
  const streamers = guides.streamers || {};
  res.json({
    ok: true,
    taught: Object.entries(streamers).map(([name, data]) => ({
      streamer: name,
      clipsAnalyzed: data.clipsAnalyzed,
      updatedAt: data.updatedAt,
      fingerprintLength: data.fingerprint?.length || 0,
    })),
  });
});
// POST /publish/setup-queue — now in lib/routes/publish.js

// ── Streamer Intro Image Burn (FFmpeg) ────────────────────────────
// Burns circular profile image + origin + fact lines onto Bobby G's intro segment
// Called during assembly for each streamer's intro avatar segment
// Input: avatar intro segment + streamer data from streamers.json
// Output: new MP4 with image card burned in for first 3 seconds
//
// POST /burn-streamer-intro
// Body: { inputPath, streamer, outputPath }
router.post('/burn-streamer-intro', async (req, res) => {
  const { inputPath, streamer, outputPath } = req.body;
  if (!inputPath || !streamer)
    return res.status(400).json({ error: 'inputPath + streamer required' });

  // Load streamer data
  const streamersPath = path.join(ROOT_DIR, 'data/streamers.json');
  let streamerData = null;
  try {
    const data = JSON.parse(fs.readFileSync(streamersPath, 'utf8'));
    streamerData = data.roster?.find(
      (s) =>
        s.displayName?.toLowerCase() === streamer.toLowerCase() ||
        s.twitchUsername?.toLowerCase() === streamer.toLowerCase()
    );
  } catch (e) {
    return res.status(400).json({ error: 'streamers.json not found — copy to ~/Downloads/' });
  }

  if (!streamerData)
    return res.status(404).json({ error: `Streamer "${streamer}" not found in streamers.json` });

  const out = outputPath || inputPath.replace('.mp4', '_intro.mp4');
  const profileImgUrl = streamerData.profileImage || '';
  const origin = streamerData.origin || '';
  const fact = streamerData.fact || '';
  const name = streamerData.displayName || streamer;

  // Download profile image to tmp
  const profileImgPath = path.join(TMP_DIR, `profile_${name.replace(/\s/g, '_')}.png`);
  let hasProfileImg = false;
  if (profileImgUrl && !fs.existsSync(profileImgPath)) {
    try {
      await downloadFile(profileImgUrl, profileImgPath);
      hasProfileImg = fs.existsSync(profileImgPath) && fs.statSync(profileImgPath).size > 100;
    } catch (e) {
      console.warn(`[burn-intro] Could not download profile image for ${name}: ${e.message}`);
    }
  } else if (fs.existsSync(profileImgPath)) {
    hasProfileImg = true;
  }

  // Build FFmpeg filter for intro card (first 3 seconds only)
  // Navy overlay box + circular profile image + name + origin + fact
  try {
    const introDur = 3.0; // seconds to show intro card
    let filterComplex;

    if (hasProfileImg) {
      // With circular profile image
      // Crop image to circle, overlay on navy box, add text
      filterComplex = [
        // Create circular mask for profile image
        `[1:v]scale=120:120,format=rgba,geq=` +
          `r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
          `a='if(lte(pow(X-60,2)+pow(Y-60,2),pow(60,2)),255,0)'[circle]`,
        // Intro card: navy box overlay for first introDur seconds
        `[0:v]drawbox=x=60:y=60:w=400:h=200:color=0x22304b@0.92:t=fill:enable='lte(t,${introDur})',` +
          // Gold border on box
          `drawbox=x=60:y=60:w=400:h=200:color=0xc7af4f@1:t=3:enable='lte(t,${introDur})',` +
          // Streamer name
          `drawtext=text='${name.toUpperCase()}':x=200:y=85:fontsize=22:fontcolor=0xc7af4f:` +
          `${SYSTEM_FONT || '/Library/Fonts/Arial.ttf'}:enable='lte(t,${introDur})',` +
          // Origin
          `drawtext=text='Origin\\: ${origin}':x=200:y=115:fontsize=15:fontcolor=0xf0ede6:` +
          `${SYSTEM_FONT || '/Library/Fonts/Arial.ttf'}:enable='lte(t,${introDur})',` +
          // Fact
          `drawtext=text='${fact.replace(/'/g, "'")}':x=200:y=140:fontsize=14:fontcolor=0xf0ede6:` +
          `${SYSTEM_FONT || '/Library/Fonts/Arial.ttf'}:enable='lte(t,${introDur})'[bg]`,
        // Overlay circular profile image onto card
        `[bg][circle]overlay=x=75:y=75:enable='lte(t,${introDur})'[out]`,
      ].join(';');

      await new Promise((resolve, reject) => {
        const args = [
          '-i',
          inputPath,
          '-i',
          profileImgPath,
          '-filter_complex',
          filterComplex,
          '-map',
          '[out]',
          '-map',
          '0:a',
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-ar',
          '44100',
          '-y',
          out,
        ];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`))
        );
        proc.on('error', reject);
      });
    } else {
      // Text-only version (no profile image)
      const textFilter = [
        `drawbox=x=60:y=60:w=380:h=180:color=0x22304b@0.92:t=fill:enable='lte(t,${introDur})'`,
        `drawbox=x=60:y=60:w=380:h=180:color=0xc7af4f@1:t=3:enable='lte(t,${introDur})'`,
        `drawtext=text='${name.toUpperCase()}':x=70:y=80:fontsize=22:fontcolor=0xc7af4f:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
        `drawtext=text='Origin\\: ${origin}':x=70:y=110:fontsize=15:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
        `drawtext=text='${fact}':x=70:y=135:fontsize=14:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
      ].join(',');

      await new Promise((resolve, reject) => {
        const args = [
          '-i',
          inputPath,
          '-vf',
          textFilter,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-y',
          out,
        ];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`))
        );
        proc.on('error', reject);
      });
    }

    console.log(`[burn-intro] ✅ Intro card burned for ${name}: ${path.basename(out)}`);
    res.json({ ok: true, outputPath: out, streamer: name, hasProfileImg });
  } catch (e) {
    console.error(`[burn-intro] Failed for ${name}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /capcut/split-screen ────────────────────────────────────
// Creates split-screen short form video with CapCut API
// Requirements: 9:16, 1080p, masking, keyframes, auto-captions, 60fps
// Generates 3 platform-optimized variants (YouTube Shorts, TikTok, Instagram Reels)
router.post('/capcut/split-screen', async (req, res) => {
  const {
    sourceVideoPath, // Left side: news source video
    bobbyGVideoPath, // Right side: Bobby G reaction
    caption, // Gemini-generated caption
    contentType = 'news', // news, nba, or twitch
    platforms = ['youtube', 'tiktok', 'instagram'],
  } = req.body;

  if (!sourceVideoPath || !bobbyGVideoPath) {
    return res.status(400).json({ error: 'sourceVideoPath and bobbyGVideoPath required' });
  }

  const CAPCUT_API = 'http://localhost:9001';

  try {
    const platformVariants = {};

    // Create a variant for each platform
    for (const platform of platforms) {
      console.log(`[capcut-split] Creating ${platform} variant...`);

      // Step 1: Create draft (9:16, 1080p)
      const draftResp = await axios.post(`${CAPCUT_API}/create_draft`, {
        width: 1080,
        height: 1920,
        fps: 60,
      });

      if (!draftResp.data.ok) {
        throw new Error(`CapCut create_draft failed: ${draftResp.data.error || 'unknown error'}`);
      }

      const draftId = draftResp.data.draft_id;
      console.log(`[capcut-split] Draft created: ${draftId}`);

      // Step 2: Add source video (left 50%)
      await axios.post(`${CAPCUT_API}/add_video`, {
        draft_id: draftId,
        video_path: sourceVideoPath,
        track_index: 0,
        x: 0,
        y: 0,
        width: 540, // 50% of 1080
        height: 1920,
        start_time: 0,
        mask_type: 'rectangle', // Optional: can add mask for rounded corners
      });

      // Step 3: Add Bobby G reaction (right 50%)
      await axios.post(`${CAPCUT_API}/add_video`, {
        draft_id: draftId,
        video_path: bobbyGVideoPath,
        track_index: 1,
        x: 540, // Right half
        y: 0,
        width: 540,
        height: 1920,
        start_time: 0,
        mask_type: 'rectangle',
      });

      // Step 4: Add keyframes for dynamic zooms (platform-specific)
      const zoomKeyframes = getZoomKeyframes(platform);
      for (const kf of zoomKeyframes) {
        await axios.post(`${CAPCUT_API}/add_video_keyframe`, {
          draft_id: draftId,
          track_index: kf.track,
          time: kf.time,
          scale: kf.scale,
          x: kf.x,
          y: kf.y,
        });
      }

      // Step 5: Add auto-captions (platform-specific style)
      if (caption) {
        const captionStyle = getCaptionStyle(platform);
        await axios.post(`${CAPCUT_API}/add_subtitle`, {
          draft_id: draftId,
          text: caption,
          font_size: captionStyle.fontSize,
          font_color: captionStyle.color,
          position: captionStyle.position,
          animation: captionStyle.animation,
        });
      }

      // Step 6: Add platform-specific effects
      const effects = getPlatformEffects(platform, contentType);
      for (const effect of effects) {
        await axios.post(`${CAPCUT_API}/add_effect`, {
          draft_id: draftId,
          effect_type: effect.type,
          start_time: effect.start,
          duration: effect.duration,
        });
      }

      // Step 7: Save draft and export (1080p/60fps)
      const saveResp = await axios.post(`${CAPCUT_API}/save_draft`, {
        draft_id: draftId,
        output_path: path.join(OUTPUT_DIR, `split_screen_${platform}_${Date.now()}.mp4`),
        resolution: '1080p',
        fps: 60,
        quality: 'high',
      });

      if (!saveResp.data.ok) {
        throw new Error(
          `CapCut save_draft failed for ${platform}: ${saveResp.data.error || 'unknown error'}`
        );
      }

      platformVariants[platform] = {
        draftId,
        outputPath: saveResp.data.output_path,
        status: saveResp.data.status,
      };

      console.log(`[capcut-split] ✅ ${platform} variant saved: ${saveResp.data.output_path}`);
    }

    res.json({
      ok: true,
      platforms: platformVariants,
      caption,
    });
  } catch (err) {
    console.error('[capcut-split] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Get platform-specific zoom keyframes
function getZoomKeyframes(platform) {
  const keyframes = {
    youtube: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 2, scale: 1.1, x: -20, y: -30 }, // Subtle zoom on source
      { track: 1, time: 1, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 3, scale: 1.05, x: 540, y: -20 }, // Subtle zoom on Bobby G
    ],
    tiktok: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 1.5, scale: 1.15, x: -30, y: -40 }, // More aggressive zoom
      { track: 1, time: 0.5, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 2.5, scale: 1.1, x: 540, y: -30 },
    ],
    instagram: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 2, scale: 1.08, x: -15, y: -20 }, // Gentle zoom
      { track: 1, time: 1, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 3, scale: 1.06, x: 540, y: -15 },
    ],
  };
  return keyframes[platform] || keyframes.youtube;
}

// Helper: Get platform-specific caption style
function getCaptionStyle(platform) {
  const styles = {
    youtube: {
      fontSize: 48,
      color: '#FFFFFF',
      position: 'bottom',
      animation: 'fade_in',
    },
    tiktok: {
      fontSize: 52,
      color: '#FFFFFF',
      position: 'center_bottom',
      animation: 'pop',
    },
    instagram: {
      fontSize: 44,
      color: '#FFFFFF',
      position: 'bottom',
      animation: 'slide_up',
    },
  };
  return styles[platform] || styles.youtube;
}

// Helper: Get platform-specific effects
function getPlatformEffects(platform, contentType) {
  const effects = {
    youtube: [
      { type: 'color_correction', start: 0, duration: -1 }, // Apply to entire video
    ],
    tiktok: [
      { type: 'fast_zoom', start: 0, duration: 0.5 },
      { type: 'shake', start: 2, duration: 0.3 },
    ],
    instagram: [{ type: 'soft_glow', start: 0, duration: -1 }],
  };
  return effects[platform] || [];
}

// ── Shorts Pipeline ───────────────────────────────────────────────
// 9:16 vertical format for TikTok, Instagram Reels, YouTube Shorts
// Uses the portrait avatar ID instead of landscape
// Script is shorter: 40-60 words total, single clip per section
// Same QA gates, same Upload-Post publishing
//
// The short pipeline is handled by:
//   1. Dashboard selecting "short" format → uses portrait avatar ID
//   2. /generate-full-script with type = 'twitch-short' | 'nba-short' | 'news-short'
//   3. /assemble with format = 'portrait' (1080×1920)
//   4. Same QA gates (Gates 1, 2, 3) with same thresholds
//   5. /publish with contentType = 'short' → Upload-Post queues for TikTok/IG/YT Shorts

// GET /shorts/avatar-ids — return correct avatar IDs for short vs long form
router.get('/shorts/avatar-ids', (req, res) => {
  res.json({
    landscape: {
      avatarId: process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829',
      dimensions: '1920x1080',
      format: 'landscape',
      useFor: 'YouTube long form compilations',
    },
    portrait: {
      avatarId: process.env.HEYGEN_AVATAR_SHORT_ID || 'ed57439c9c3d4a398f3b247b75714b13',
      dimensions: '1080x1920',
      format: 'portrait',
      useFor: 'TikTok, Instagram Reels, YouTube Shorts',
    },
    voiceId: '2e598f1a6022448cb6710e5d44665325',
    baseSpeed: 0.85,
    reactionSpeed: 0.95,
  });
});

// POST /shorts/cut-from-long — extract short clip from long-form video for Shorts
// Cuts a specific streamer's section from the assembled long-form video
// Body: { longFormPath, startTime, endTime, outputName }
router.post('/shorts/cut-from-long', async (req, res) => {
  const { longFormPath, startTime, endTime, outputName } = req.body;
  if (!longFormPath || startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: 'longFormPath, startTime, endTime required' });
  }

  const inPath = path.isAbsolute(longFormPath)
    ? longFormPath
    : path.join(OUTPUT_DIR, path.basename(longFormPath));

  if (!fs.existsSync(inPath)) return res.status(404).json({ error: 'Long form video not found' });

  const outFile = outputName || `short_${Date.now()}.mp4`;
  const outPath = path.join(OUTPUT_DIR, outFile);
  const duration = endTime - startTime;

  try {
    // Cut segment, scale to 9:16 with padding if needed
    await new Promise((resolve, reject) => {
      const args = [
        '-ss',
        startTime.toString(),
        '-i',
        inPath,
        '-t',
        duration.toString(),
        '-vf',
        'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-movflags',
        '+faststart',
        '-y',
        outPath,
      ];
      const proc = execFile(ffmpegPath(), args);
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`))
      );
      proc.on('error', reject);
    });

    const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`[shorts] ✅ Cut from ${startTime}s-${endTime}s → ${outFile} (${size}MB)`);
    res.json({
      ok: true,
      outputPath: outPath,
      filename: outFile,
      duration,
      sizeMB: parseFloat(size),
    });
  } catch (e) {
    console.error('[shorts] Cut failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /gate-fix-log — append Portal 2 fix attempt to logs/gate_fixes.jsonl
// Called by client-side handleGate2Failure after each fix strategy attempt.

// POST /capcut/clip-comp — CapCut handoff for clipsOnly jobs (assembled MP4)
router.post('/capcut/clip-comp', async (req, res) => {
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const { persistedJobs } = require('../job_card');
  const { ffprobePath } = require('../ffmpeg_utils');
  const card = persistedJobs[jobId];
  if (!card || !card.clipsOnly) {
    return res.status(400).json({ error: 'clipsOnly job required' });
  }

  const port = process.env.PORT || 3000;
  let videoUrl = card.finalUrl || card.assembledUrl || card.driveUrl || '';
  if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
    videoUrl = `http://localhost:${port}${videoUrl.startsWith('/') ? '' : '/'}${videoUrl}`;
  }
  if (!videoUrl) {
    return res.status(400).json({ error: 'No assembled MP4 yet — wait for assembly to finish' });
  }

  try {
    const initResult = await capcut('/create_draft', { width: 1080, height: 1920, fps: 30 });
    const draftId = initResult?.result?.draft_id || initResult?.draft_id;
    if (!draftId) return res.status(500).json({ error: 'CapCut did not return draft_id', raw: initResult });

    capcutDrafts[jobId] = {
      draftId,
      segments: [],
      width: 1080,
      height: 1920,
      fps: 30,
      contentType: card.contentType || 'twitch',
      format: 'portrait',
    };

    const dur = await new Promise((resolve) => {
      execFile(ffprobePath(), [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', videoUrl,
      ], (err, stdout) => resolve(parseFloat(stdout) || 60));
    });

    await capcut('/add_video', {
      draft_id: draftId,
      video_url: videoUrl,
      start: 0,
      end: dur,
      volume: 1.0,
    });
    capcutDrafts[jobId].segments.push({
      url: videoUrl,
      type: 'source_clip',
      label: card.title || 'Clip comp',
      duration: dur,
      position: 0,
    });

    const saveResult = await capcut('/save_draft', { draft_id: draftId });
    const draftUrl = saveResult?.result?.draft_url || saveResult?.draft_url || '';

    res.json({
      ok: true,
      draftId,
      draftUrl,
      jobId,
      totalSegments: 1,
      instructions: 'Open CapCut → File → Open Project → select draft → polish captions/transitions → Export',
    });
  } catch (e) {
    console.error('[capcut/clip-comp] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
