'use strict';
/**
 * lib/services/thumbnail_stage.js — Thumbnail approval stage orchestrator
 *
 * Manages the thumbnail approval lifecycle between Portal 4 and Portal 5.
 * Five generation paths run in parallel and results are presented to the
 * customer (or auto-ranked by Gemini for C1+):
 *
 *   frame    — FFmpeg extracts 5 candidate frames from assembled video, scored by position
 *   designed — Puppeteer-rendered HTML template via lib/thumbnail.js
 *   vectcut  — CapCut-styled composition (frame + hook text) via VectCut API
 *   imagen   — Gemini Imagen 3 AI-generated image from hook text prompt
 *   custom   — Customer uploads their own image (handled by route, stored here)
 *
 * For C1+, Gemini analyzes all candidates via vision and returns a ranked
 * recommendation with creative rationale. Customers can accept the
 * recommendation or override with any candidate they prefer.
 *
 * jobSpec.state.thumbnail shape:
 *   {
 *     status:                'pending' | 'approved' | 'skipped',
 *     method:                'frame' | 'vectcut' | 'designed' | 'imagen' | 'custom' | null,
 *     selectedPath:          string | null,
 *     r2Url:                 string | null,
 *     candidates:            [{ index, path, offsetSeconds, score, url, method }],
 *     designedUrl:           string | null,
 *     vectcutUrl:            string | null,
 *     imagenUrl:             string | null,
 *     geminiRanking:         [{ index, rank, rationale, recommended }] | null,
 *     geminiRecommendation:  { index, method, rationale } | null,
 *     initiatedAt:           ISO string,
 *     approvedAt:            ISO string | null,
 *   }
 */

const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const http    = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { ffmpegPath, ffprobePath } = require('../ffmpeg_utils');
const { generateThumbnail }       = require('../thumbnail');
const { uploadFile }              = require('../storage');
const { saveJob }                 = require('../db');
const pipelineBus                 = require('../pipeline_events');
const { logError }                = require('../error_logger');
const { isFeatureEnabled }        = require('./feature_gate');

const execFileAsync = promisify(execFile);

const THUMB_TMP_DIR = path.join(__dirname, '..', '..', 'tmp', 'thumbnails');

// Percentage offsets to extract frames at (of total duration)
const FRAME_OFFSETS_PCT = [0.10, 0.25, 0.50, 0.75, 0.90];

// ─── FFmpeg helpers ──────────────────────────────────────────────────────────

async function getVideoDuration(videoPath) {
  const res = await execFileAsync(ffprobePath(), [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    videoPath,
  ]);
  // promisify resolves with { stdout, stderr } in real Node;
  // test mocks may resolve with a plain string — handle both.
  const stdout = (res && typeof res === 'object' && 'stdout' in res) ? res.stdout : String(res || '');
  const data = JSON.parse(stdout);
  return parseFloat(data.format?.duration || '0');
}

async function extractFrameAt(videoPath, offsetSeconds, outputPath) {
  await execFileAsync(ffmpegPath(), [
    '-y',
    '-ss', String(offsetSeconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '3',
    outputPath,
  ]);
}

// ─── Frame extraction ────────────────────────────────────────────────────────

/**
 * Extract up to 5 candidate frames from the assembled video.
 * Scores are a simple positional heuristic (midpoint preferred over intro/outro).
 */
async function extractCandidateFrames(videoPath, jobId) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found for frame extraction: ${videoPath}`);
  }

  if (!fs.existsSync(THUMB_TMP_DIR)) {
    fs.mkdirSync(THUMB_TMP_DIR, { recursive: true });
  }

  const duration = await getVideoDuration(videoPath);
  if (!duration || duration < 1) {
    throw new Error(`Could not read video duration from: ${videoPath}`);
  }

  const frames = [];
  for (let i = 0; i < FRAME_OFFSETS_PCT.length; i++) {
    const offset = Math.max(1, Math.floor(duration * FRAME_OFFSETS_PCT[i]));
    const framePath = path.join(THUMB_TMP_DIR, `${jobId}_frame_${i}.jpg`);
    try {
      await extractFrameAt(videoPath, offset, framePath);
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 500) {
        const score = parseFloat((1 - Math.abs(i - 2) / 4).toFixed(3));
        frames.push({ index: i, path: framePath, offsetSeconds: offset, score, method: 'frame' });
      }
    } catch (e) {
      logError('THUMBNAIL_FRAME_EXTRACT_FAIL', e, { jobId, offset, frameIndex: i });
    }
  }

  return frames.sort((a, b) => b.score - a.score);
}

// ─── VectCut path (CapCut composition) ──────────────────────────────────────

/**
 * Compose a styled thumbnail using the VectCut CapCut API:
 *   1. Upload best frame → 2. Create draft → 3. Add image → 4. Add text overlay
 *   5. Export draft to video → 6. FFmpeg extract frame 0 as PNG → 7. Upload to R2
 *
 * Returns null when VECTCUT_API_URL is not configured (optional path).
 * Falls back to null (non-fatal) on any API error.
 */
async function generateVectcutThumbnail(jobSpec, bestFramePath) {
  const planTier = jobSpec.planTier;
  // Feature gate: dwy+ and VECTCUT_API_URL must be set
  if (!isFeatureEnabled('thumbnail.vectcut', planTier)) return { path: null, url: null };
  const apiUrl = process.env.VECTCUT_API_URL;
  if (!apiUrl) return { path: null, url: null };
  if (!bestFramePath || !fs.existsSync(bestFramePath)) return { path: null, url: null };

  const jobId      = jobSpec.jobId;
  const formatType = jobSpec.deliverySpec?.formatType || 'long';
  const isPortrait = formatType === 'short';
  const width      = isPortrait ? 1080 : 1920;
  const height     = isPortrait ? 1920 : 1080;
  const hookText   = jobSpec.state?.savedOutputs?.publishCopy?.youtube?.thumbnailTextOptions?.[0]
    || jobSpec.state?.savedOutputs?.publishCopy?.youtube?.title
    || '';

  const mod = apiUrl.startsWith('https') ? https : http;

  const apiPost = (endpoint, payload) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(`${apiUrl}${endpoint}`);
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`VectCut parse error [${endpoint}]: ${data.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  try {
    // 1. Upload frame image to VectCut
    const frameUrl = await uploadFile(bestFramePath, path.basename(bestFramePath), { folder: `thumbnails/${jobId}` });
    if (!frameUrl) throw new Error('Frame upload for VectCut failed');

    // 2. Create draft
    const draft = await apiPost('/create_draft', { width, height });
    if (!draft?.output?.draft_id) throw new Error(`VectCut create_draft failed: ${JSON.stringify(draft)}`);
    const draftId = draft.output.draft_id;

    // 3. Add background frame image (1-second clip)
    await apiPost('/add_image', { draft_id: draftId, image_url: frameUrl, start: 0, end: 1, scale_x: 1.0, scale_y: 1.0 });

    // 4. Add hook text overlay (bold white with black stroke — CapCut styled)
    if (hookText) {
      await apiPost('/add_text', {
        draft_id:       draftId,
        text:           hookText.slice(0, 60).toUpperCase(),
        start:          0,
        end:            1,
        font_size:      isPortrait ? 72 : 56,
        font_color:     '#FFFFFF',
        is_bold:        true,
        stroke_enabled: true,
        stroke_color:   '#000000',
        stroke_width:   4.0,
        shadow_enabled: true,
        shadow_color:   '#000000',
        shadow_angle:   315,
        shadow_distance: 8,
        shadow_smooth:  4,
        alignment_h:    'center',
        alignment_v:    isPortrait ? 'bottom' : 'middle',
        pos_y:          isPortrait ? -0.15 : 0,
      });
    }

    // 5. Export draft to video
    const exportRes = await apiPost('/export_draft_to_video', { draft_id: draftId });
    if (!exportRes?.output?.video_url && !exportRes?.output?.download_url) {
      throw new Error(`VectCut export failed: ${JSON.stringify(exportRes)}`);
    }
    const videoUrl = exportRes.output.video_url || exportRes.output.download_url;

    // 6. Download exported video and extract frame 0 as PNG
    const vcVideoPath = path.join(THUMB_TMP_DIR, `${jobId}_vectcut.mp4`);
    const vcPngPath   = path.join(THUMB_TMP_DIR, `${jobId}_vectcut.jpg`);

    // Download video file
    await new Promise((resolve, reject) => {
      const dlMod = videoUrl.startsWith('https') ? https : http;
      const file  = fs.createWriteStream(vcVideoPath);
      dlMod.get(videoUrl, (res) => { res.pipe(file); file.on('finish', resolve); }).on('error', reject);
    });

    // Extract first frame
    await execFileAsync(ffmpegPath(), ['-y', '-ss', '0.5', '-i', vcVideoPath, '-frames:v', '1', '-q:v', '2', vcPngPath]);

    // 7. Upload PNG to R2
    const r2Url = await uploadFile(vcPngPath, `thumbnail_${jobId}_vectcut.jpg`, { folder: `thumbnails/${jobId}` });

    // Cleanup temp video
    try { fs.unlinkSync(vcVideoPath); } catch (_) {}

    return { path: vcPngPath, url: r2Url || null };
  } catch (e) {
    logError('THUMBNAIL_VECTCUT_FAIL', e, { jobId });
    return { path: null, url: null };
  }
}

// ─── Imagen 3 path (AI-generated) ───────────────────────────────────────────

/**
 * Generate a fully AI-created thumbnail using Gemini Imagen 3.
 *
 * Builds a detailed visual prompt from the job spec's hook text, content
 * type, and format. Returns the generated image uploaded to R2.
 * Requires GEMINI_API_KEY. Non-fatal — returns null on failure.
 */
async function generateImagenThumbnail(jobSpec) {
  // Feature gate: dfy+ and GEMINI_API_KEY must be set
  if (!isFeatureEnabled('thumbnail.imagen', jobSpec.planTier)) return { path: null, url: null };
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { path: null, url: null };

  const jobId      = jobSpec.jobId;
  const hookText   = jobSpec.state?.savedOutputs?.publishCopy?.youtube?.thumbnailTextOptions?.[0]
    || jobSpec.state?.savedOutputs?.publishCopy?.youtube?.title
    || jobSpec.order?.inputs?.items?.[0]?.title
    || '';
  const contentType = jobSpec.contentType || 'news';
  const formatType  = jobSpec.deliverySpec?.formatType || 'long';
  const isPortrait  = formatType === 'short';

  if (!hookText) return { path: null, url: null };

  // Build a visually descriptive prompt for a YouTube/TikTok thumbnail
  const contentStyleMap = {
    news:              'breaking news broadcast, dramatic lighting, professional news studio aesthetic',
    nba:               'NBA basketball action, dynamic sports photography, court atmosphere',
    twitch:            'gaming reaction streaming, vibrant colors, esports broadcast style',
    show_commentary:   'TV show commentary reaction, cinematic still, editorial style',
  };
  const style = contentStyleMap[contentType] || 'professional content creator thumbnail';
  const aspectHint = isPortrait ? '9:16 vertical format, close-up framing' : '16:9 horizontal format, wide composition';

  const prompt = `Professional YouTube thumbnail image: "${hookText}". Visual style: ${style}. ${aspectHint}. High contrast, attention-grabbing composition. Bold text space reserved at ${isPortrait ? 'bottom' : 'center'}. No text or words in image. Photorealistic. High quality.`;

  try {
    const requestBody = JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: isPortrait ? '9:16' : '16:9',
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
      },
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'us-central1-aiplatform.googleapis.com',
        path: `/v1/projects/generativelanguage/locations/us-central1/publishers/google/models/imagen-3.0-generate-002:predict`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Imagen parse error: ${data.slice(0, 100)}`)); }
        });
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    // Imagen returns base64-encoded PNG
    const b64 = result?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) {
      // Fallback: try via Generative Language API (simpler, uses API key directly)
      return await generateImagenViaGenAI(jobSpec, prompt, apiKey);
    }

    const imgPath = path.join(THUMB_TMP_DIR, `${jobId}_imagen.png`);
    if (!fs.existsSync(THUMB_TMP_DIR)) fs.mkdirSync(THUMB_TMP_DIR, { recursive: true });
    fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));

    const r2Url = await uploadFile(imgPath, `thumbnail_${jobId}_imagen.png`, { folder: `thumbnails/${jobId}` });
    return { path: imgPath, url: r2Url || null };
  } catch (e) {
    logError('THUMBNAIL_IMAGEN_FAIL', e, { jobId });
    // Try the simpler genai path as fallback
    try { return await generateImagenViaGenAI(jobSpec, null, apiKey); } catch (_) {}
    return { path: null, url: null };
  }
}

/**
 * Imagen 3 via the Generative Language API (API key auth — simpler fallback).
 * Uses imagen-3.0-generate-002 through the generativelanguage endpoint.
 */
async function generateImagenViaGenAI(jobSpec, prompt, apiKey) {
  const jobId     = jobSpec.jobId;
  const hookText  = jobSpec.state?.savedOutputs?.publishCopy?.youtube?.thumbnailTextOptions?.[0]
    || jobSpec.state?.savedOutputs?.publishCopy?.youtube?.title
    || '';
  const usedPrompt = prompt || `Professional YouTube thumbnail. Subject: "${hookText}". High contrast, cinematic, no text in image.`;

  const body = JSON.stringify({
    instances: [{ prompt: usedPrompt }],
    parameters: { sampleCount: 1 },
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const b64 = result?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) return { path: null, url: null };

  const imgPath = path.join(THUMB_TMP_DIR, `${jobId}_imagen.png`);
  if (!fs.existsSync(THUMB_TMP_DIR)) fs.mkdirSync(THUMB_TMP_DIR, { recursive: true });
  fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
  const r2Url = await uploadFile(imgPath, `thumbnail_${jobId}_imagen.png`, { folder: `thumbnails/${jobId}` });
  return { path: imgPath, url: r2Url || null };
}

// ─── Gemini creative ranking ─────────────────────────────────────────────────

/**
 * Use Gemini to analyze all generated candidates and rank them with
 * creative rationale. Returns a ranked array and a top recommendation.
 *
 * Candidates with no URL are skipped (couldn't be generated/uploaded).
 * Non-fatal — if Gemini fails, returns null ranking (all paths still available).
 *
 * @param {Object} jobSpec
 * @param {Array}  candidates  — array of { index, url, method, score }
 * @returns {Promise<{ ranking: Array, recommendation: Object|null }>}
 */
async function rankWithGemini(jobSpec, candidates) {
  // Feature gate: dwy+ and GEMINI_API_KEY must be set
  if (!isFeatureEnabled('thumbnail.gemini_ranking', jobSpec.planTier)) return { ranking: null, recommendation: null };
  const { callGemini, isConfigured } = require('./gemini');
  if (!isConfigured()) return { ranking: null, recommendation: null };

  const rankable = candidates.filter((c) => c.url);
  if (rankable.length < 2) return { ranking: null, recommendation: null };

  const jobId       = jobSpec.jobId;
  const hookText    = jobSpec.state?.savedOutputs?.publishCopy?.youtube?.thumbnailTextOptions?.[0]
    || jobSpec.state?.savedOutputs?.publishCopy?.youtube?.title
    || '(no hook text)';
  const contentType = jobSpec.contentType || 'news';
  const platform    = (jobSpec.deliverySpec?.platforms || ['youtube'])[0];

  const candidateList = rankable.map((c, i) =>
    `${i + 1}. Method: ${c.method || 'frame'} | index: ${c.index} | URL: ${c.url}`
  ).join('\n');

  let historicalBlock = '';
  try {
    const intelligence = require('../intelligence');
    const thumbCtx = intelligence.getThumbnailIntelligenceContext(jobSpec);
    if (thumbCtx.promptBlock) historicalBlock = `\n${thumbCtx.promptBlock}\n`;
  } catch {
    /* non-fatal */
  }

  const prompt = `You are a professional creative director for short-form and long-form video content.

Job context:
- Content type: ${contentType}
- Platform: ${platform}
- Hook text / title: "${hookText}"
${historicalBlock}
Generated thumbnail candidates (by URL):
${candidateList}

Analyze each thumbnail candidate as a creative director would. Consider:
1. Visual impact and contrast against typical ${platform} feed
2. How well the visual supports the hook text "${hookText}"
3. Platform-specific best practices (${platform})
4. Which combination of visual + hook text will drive the highest CTR

Return a JSON object with this exact shape:
{
  "ranking": [
    { "index": <candidate index value>, "method": "<method>", "rank": <1=best>, "rationale": "<1-2 sentence creative reasoning>", "recommended": <true/false — only one true> }
  ],
  "recommendation": {
    "index": <best candidate index value>,
    "method": "<method>",
    "rationale": "<2-3 sentence explanation of why this thumbnail wins>"
  }
}

Only return valid JSON — no markdown, no explanation outside the JSON.`;

  try {
    const raw = await callGemini(prompt, { maxOutputTokens: 800, temperature: 0.4 });
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed  = JSON.parse(jsonStr);
    if (parsed.recommendation?.method) {
      try {
        const intelligence = require('../intelligence');
        intelligence.recordThumbnailDecision(jobId, parsed.recommendation);
      } catch {
        /* non-fatal */
      }
    }
    return {
      ranking:        parsed.ranking || null,
      recommendation: parsed.recommendation || null,
    };
  } catch (e) {
    logError('THUMBNAIL_GEMINI_RANK_FAIL', e, { jobId });
    return { ranking: null, recommendation: null };
  }
}

// ─── Upload helpers ──────────────────────────────────────────────────────────

async function uploadCandidate(localPath, jobId, index) {
  try {
    const fileName = `thumbnail_${jobId}_frame_${index}.jpg`;
    const url = await uploadFile(localPath, fileName, { folder: `thumbnails/${jobId}` });
    return url || null;
  } catch (e) {
    logError('THUMBNAIL_CANDIDATE_UPLOAD_FAIL', e, { jobId, index });
    return null;
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Initiate the thumbnail approval stage for a job that has completed Portal 4.
 *
 * Runs all available generation paths in parallel:
 *   - FFmpeg frame extraction (5 candidates)
 *   - Puppeteer designed thumbnail
 *   - VectCut CapCut composition (when VECTCUT_API_URL set)
 *   - Imagen 3 AI-generated (when GEMINI_API_KEY set)
 *
 * For C1+, Gemini ranks all candidates with creative rationale.
 * Sets jobSpec.state.thumbnail, persists to DB, emits approval_needed event.
 *
 * @param {Object} jobSpec
 * @returns {Promise<{passed: boolean, outcome: string, thumbnail: Object}>}
 */
async function initiateApprovalStage(jobSpec) {
  const jobId     = jobSpec.jobId;
  const videoPath = jobSpec.state?.savedOutputs?.assembledVideoPath
    || jobSpec.state?.assembledVideoPath
    || null;

  const thumbnailState = {
    status:               'pending',
    method:               null,
    selectedPath:         null,
    r2Url:                null,
    candidates:           [],
    designedUrl:          null,
    vectcutUrl:           null,
    imagenUrl:            null,
    geminiRanking:        null,
    geminiRecommendation: null,
    initiatedAt:          new Date().toISOString(),
    approvedAt:           null,
  };

  let bestFramePath = null;

  // ── Frame extraction ────────────────────────────────────────────────────────
  if (videoPath && fs.existsSync(videoPath)) {
    try {
      const frames = await extractCandidateFrames(videoPath, jobId);
      const withUrls = await Promise.all(
        frames.map(async (f) => ({
          ...f,
          url: await uploadCandidate(f.path, jobId, f.index),
        }))
      );
      thumbnailState.candidates.push(...withUrls);
      // Best frame = highest score with a valid local path
      bestFramePath = withUrls.find((f) => f.path && fs.existsSync(f.path))?.path || null;
    } catch (e) {
      logError('THUMBNAIL_FRAME_STAGE_FAIL', e, { jobId });
    }
  } else {
    console.warn(`[thumbnail_stage:${jobId}] No assembled video path — skipping frame extraction`);
  }

  // ── Run designed + VectCut + Imagen in parallel ─────────────────────────────
  const [designedResult, vectcutResult, imagenResult] = await Promise.all([
    // Puppeteer HTML template
    generateThumbnail(jobSpec).catch((e) => { logError('THUMBNAIL_DESIGNED_FAIL', e, { jobId }); return { ok: false }; }),
    // VectCut CapCut composition
    generateVectcutThumbnail(jobSpec, bestFramePath),
    // Imagen 3 AI-generated
    generateImagenThumbnail(jobSpec),
  ]);

  if (designedResult?.ok) {
    thumbnailState.designedUrl = designedResult.driveUrl || null;
    thumbnailState.candidates.push({
      index: 'designed', path: designedResult.pngPath, offsetSeconds: null,
      score: 1.0, url: designedResult.driveUrl || null, method: 'designed',
    });
  }

  if (vectcutResult?.url) {
    thumbnailState.vectcutUrl = vectcutResult.url;
    thumbnailState.candidates.push({
      index: 'vectcut', path: vectcutResult.path, offsetSeconds: null,
      score: 1.0, url: vectcutResult.url, method: 'vectcut',
    });
  }

  if (imagenResult?.url) {
    thumbnailState.imagenUrl = imagenResult.url;
    thumbnailState.candidates.push({
      index: 'imagen', path: imagenResult.path, offsetSeconds: null,
      score: 1.0, url: imagenResult.url, method: 'imagen',
    });
  }

  // ── Gemini creative ranking (C1+ — requires uploaded URLs) ─────────────────
  if (thumbnailState.candidates.filter((c) => c.url).length >= 2) {
    try {
      const { ranking, recommendation } = await rankWithGemini(jobSpec, thumbnailState.candidates);
      thumbnailState.geminiRanking        = ranking;
      thumbnailState.geminiRecommendation = recommendation;
    } catch (e) {
      logError('THUMBNAIL_GEMINI_RANK_FAIL', e, { jobId });
    }
  }

  // ── Persist and notify ──────────────────────────────────────────────────────
  if (!jobSpec.state) jobSpec.state = {};
  jobSpec.state.thumbnail = thumbnailState;

  try { await saveJob(jobId, jobSpec); }
  catch (e) { logError('THUMBNAIL_STATE_PERSIST_FAIL', e, { jobId }); }

  try {
    pipelineBus.emit('thumbnail:approval_needed', {
      jobId,
      candidateCount: thumbnailState.candidates.length,
      geminiRecommendation: thumbnailState.geminiRecommendation,
      candidates: thumbnailState.candidates.map((c) => ({
        index: c.index, url: c.url, score: c.score, method: c.method || 'frame',
      })),
    });
  } catch (_e) { /* non-fatal */ }

  return {
    passed:    true,
    outcome:   'thumbnail_candidates_ready',
    thumbnail: thumbnailState,
  };
}

// ─── Approval / skip ─────────────────────────────────────────────────────────

/**
 * Mark a job's thumbnail as approved with the selected candidate.
 * Called from the route handler (POST /jobs/:jobId/thumbnail/approve).
 */
async function approveThumbnail(jobSpec, { method, candidateIndex, r2Url }) {
  const jobId = jobSpec.jobId;
  const thumb = jobSpec.state?.thumbnail;
  if (!thumb) throw new Error(`No thumbnail state on job ${jobId} — run initiateApprovalStage first`);

  let selectedUrl  = r2Url || null;
  let selectedPath = null;

  if (!selectedUrl && candidateIndex !== null && candidateIndex !== undefined) {
    const candidate = thumb.candidates.find((c) => String(c.index) === String(candidateIndex));
    if (!candidate) throw new Error(`Candidate index ${candidateIndex} not found in job ${jobId}`);
    selectedUrl  = candidate.url;
    selectedPath = candidate.path || null;
  }

  thumb.status       = 'approved';
  thumb.method       = method || 'frame';
  thumb.selectedPath = selectedPath;
  thumb.r2Url        = selectedUrl;
  thumb.approvedAt   = new Date().toISOString();

  try { await saveJob(jobId, jobSpec); }
  catch (e) { logError('THUMBNAIL_APPROVE_PERSIST_FAIL', e, { jobId }); }

  try { pipelineBus.emit('thumbnail:approved', { jobId, method: thumb.method, r2Url: thumb.r2Url }); }
  catch (_e) { /* non-fatal */ }

  return thumb;
}

/**
 * Skip thumbnail approval for a job (operator action).
 * Portal 5 will proceed without a thumbnail URL.
 */
async function skipThumbnailApproval(jobSpec) {
  const jobId = jobSpec.jobId;
  if (!jobSpec.state) jobSpec.state = {};
  if (!jobSpec.state.thumbnail) jobSpec.state.thumbnail = {};
  jobSpec.state.thumbnail.status     = 'skipped';
  jobSpec.state.thumbnail.approvedAt = new Date().toISOString();

  try { await saveJob(jobId, jobSpec); } catch (e) { logError('THUMBNAIL_SKIP_PERSIST_FAIL', e, { jobId }); }
  try { pipelineBus.emit('thumbnail:skipped', { jobId }); } catch (_e) {}

  return jobSpec.state.thumbnail;
}

module.exports = {
  extractCandidateFrames,
  generateVectcutThumbnail,
  generateImagenThumbnail,
  rankWithGemini,
  initiateApprovalStage,
  approveThumbnail,
  skipThumbnailApproval,
  THUMB_TMP_DIR,
};
