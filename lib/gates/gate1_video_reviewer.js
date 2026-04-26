'use strict';
/**
 * Gate 1b — Gemini video reviewer (independent of the script-writing Gemini).
 * Watches the same source clip the job confirmed at Gate 0 and checks whether
 * the spoken script invents verifiable facts that contradict the video.
 *
 * Controlled by env GATE1_VIDEO_REVIEW (default on). Set GATE1_VIDEO_REVIEW=0 to skip.
 *
 * Source downloads are cached on disk (keyed by URL + max seconds) so Gate 1
 * retries and parallel jobs with the same clip do not re-fetch HLS/MP4 every time.
 * GATE1_VIDEO_CACHE_TTL_MS (default 20m), GATE1_VIDEO_CACHE_MAX_FILES (default 32).
 * Optional: GATE1_VIDEO_CACHE_DIR (absolute cache root), GATE1_VIDEO_CACHE_PART_MAX_AGE_MS
 * for abandoned *.part_* temp files (default max(1h, 3× cache TTL)).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../qa');
const { captureAIMemoryTrace } = require('../ai_memory_trace');

const GEMINI_MODEL = process.env.GEMINI_SCRIPT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const DEFAULT_MAX_SECS = 90;
const CACHE_TTL_MS = Math.max(60_000, parseInt(process.env.GATE1_VIDEO_CACHE_TTL_MS || String(20 * 60 * 1000), 10));
const CACHE_MAX_FILES = Math.max(4, parseInt(process.env.GATE1_VIDEO_CACHE_MAX_FILES || '32', 10));

/** @returns {number} ms; env override or max(1h, 3× cache entry TTL). */
function partStaleMaxAgeMs() {
  const raw = process.env.GATE1_VIDEO_CACHE_PART_MAX_AGE_MS;
  if (raw != null && String(raw).trim() !== '') {
    const v = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return Math.max(3_600_000, CACHE_TTL_MS * 3);
}

let lastStalePartPruneAt = 0;
const STALE_PART_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function cacheRootPath() {
  const raw = process.env.GATE1_VIDEO_CACHE_DIR;
  if (raw && String(raw).trim()) return path.resolve(String(raw).trim());
  return path.join(os.tmpdir(), 'cwn_gate1b_video_cache');
}

function cacheDir() {
  const d = cacheRootPath();
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (_e) { /* ignore */ }
  const now = Date.now();
  if (now - lastStalePartPruneAt >= STALE_PART_PRUNE_INTERVAL_MS) {
    lastStalePartPruneAt = now;
    pruneStalePartFiles(d);
  }
  return d;
}

function cacheKeyForUrl(videoUrl, maxSecs) {
  return crypto.createHash('sha256').update(`${videoUrl}\n${maxSecs}`).digest('hex').slice(0, 40);
}

/** @returns {string} absolute path to cached mp4 (may not exist yet) */
function cacheFileForSourceUrl(videoUrl, maxSecs = DEFAULT_MAX_SECS) {
  return path.join(cacheDir(), `${cacheKeyForUrl(videoUrl, maxSecs)}.mp4`);
}

function cacheEntryIsUsable(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return false;
    const st = fs.statSync(cachePath);
    if (!st.isFile() || st.size < 1000) return false;
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Remove abandoned download temps (`{hash}.mp4.part_{pid}_{time}`) older than partStaleMaxAgeMs().
 * In-progress downloads younger than that age are left intact.
 */
function pruneStalePartFiles(dir) {
  if (!dir) return;
  const maxAge = partStaleMaxAgeMs();
  const now = Date.now();
  try {
    const names = fs.readdirSync(dir);
    for (const n of names) {
      if (!n.includes('.part_')) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs <= maxAge) continue;
        fs.unlinkSync(p);
      } catch (_e) { /* ignore */ }
    }
  } catch (_e) { /* ignore */ }
}

/**
 * Keep cache dir bounded — delete oldest .mp4 files when over CACHE_MAX_FILES.
 */
function pruneVideoCache() {
  try {
    const d = cacheDir();
    pruneStalePartFiles(d);
    const names = fs.readdirSync(d).filter((n) => n.endsWith('.mp4'));
    if (names.length <= CACHE_MAX_FILES) return;
    const scored = names
      .map((n) => {
        const p = path.join(d, n);
        try {
          return { p, m: fs.statSync(p).mtimeMs };
        } catch (_e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.m - b.m);
    const drop = scored.length - CACHE_MAX_FILES;
    for (let i = 0; i < drop; i++) {
      try {
        fs.unlinkSync(scored[i].p);
      } catch (_e) { /* ignore */ }
    }
  } catch (_e) { /* ignore */ }
}

/**
 * Populate cache file from network (or refresh if stale). Caller checks cacheEntryIsUsable first.
 */
async function downloadIntoCachePath(videoUrl, cachePath, maxSecs) {
  const { downloadVideoForAnalysis } = require('../downloader');
  const part = `${cachePath}.part_${process.pid}_${Date.now()}`;
  await downloadVideoForAnalysis(videoUrl, part, { maxSecs });
  const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (size < 1000) {
    try {
      fs.unlinkSync(part);
    } catch (_e) { /* ignore */ }
    throw new Error(`cache download too small: ${size}`);
  }
  try {
    fs.renameSync(part, cachePath);
  } catch (_e) {
    try {
      fs.copyFileSync(part, cachePath);
    } finally {
      try {
        fs.unlinkSync(part);
      } catch (_e2) { /* ignore */ }
    }
  }
  pruneVideoCache();
}

/**
 * Copy cache → per-job temp file for Gemini upload (upload may delete/move temp).
 */
function materializeCacheToTemp(cachePath, tmpPath) {
  fs.copyFileSync(cachePath, tmpPath);
}

function contentTypeNeedsVideoReview(ct) {
  const s = (ct || '').toLowerCase();
  return s.includes('nba') || s.includes('news');
}

function firstSourceUrl(gate0Report, jobSpec) {
  const cs = gate0Report?.confirmedSources;
  if (Array.isArray(cs) && cs[0]?.url) return String(cs[0].url).trim();
  const items = jobSpec?.order?.inputs?.items || [];
  const it = items[0] || {};
  return String(it.url || it.clipUrl || it.videoUrl || it.hlsUrl || '').trim();
}

function tryParseReviewerJson(rawText) {
  if (rawText == null || typeof rawText !== 'string') return null;
  let s = String(rawText).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  while (s.startsWith('```')) {
    s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object') return o;
  } catch (_) { /* fall through */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      if (o && typeof o === 'object') return o;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * @returns {Promise<{ skipped?: boolean, reason?: string, error?: string, fabricationFound?: boolean, examples?: string[], observedSummary?: string }>}
 */
async function reviewScriptAgainstVideo({ jobSpec, script, gate0Report }) {
  if (process.env.GATE1_VIDEO_REVIEW === '0') {
    return { skipped: true, reason: 'GATE1_VIDEO_REVIEW=0' };
  }
  if (!GEMINI_APIKEY) {
    return { skipped: true, reason: 'GEMINI_API_KEY missing' };
  }

  const contentType = jobSpec?.contentType || jobSpec?.order?.contentType || '';
  if (!contentTypeNeedsVideoReview(contentType)) {
    return { skipped: true, reason: 'content_type' };
  }

  const videoUrl = firstSourceUrl(gate0Report, jobSpec);
  if (!videoUrl) {
    return { skipped: true, reason: 'no_source_url' };
  }

  const jobId = jobSpec?.jobId || 'unknown';
  const tmpPath = path.join(os.tmpdir(), `gate1b_${jobId.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.mp4`);
  const maxSecs = DEFAULT_MAX_SECS;
  const cachePath = cacheFileForSourceUrl(videoUrl, maxSecs);
  let geminiFile = null;

  try {
    if (cacheEntryIsUsable(cachePath)) {
      console.log(`[gate1b-video] Cache HIT ${path.basename(cachePath)} — skip re-download`);
      materializeCacheToTemp(cachePath, tmpPath);
    } else {
      console.log(`[gate1b-video] Cache MISS — fetching → ${path.basename(cachePath)}`);
      try {
        await downloadIntoCachePath(videoUrl, cachePath, maxSecs);
      } catch (e) {
        if (cacheEntryIsUsable(cachePath)) {
          console.warn(`[gate1b-video] Cache race recovered: ${e.message}`);
        } else {
          throw e;
        }
      }
      if (!cacheEntryIsUsable(cachePath)) {
        return { skipped: true, reason: 'cache_fill_failed' };
      }
      materializeCacheToTemp(cachePath, tmpPath);
    }

    const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
    if (size < 1000) {
      return { skipped: true, reason: `download_too_small:${size}` };
    }

    geminiFile = await uploadToGeminiFiles(tmpPath);
    geminiFile = await waitForGeminiFile(geminiFile);

    const authorizedLines = [];
    const items = jobSpec?.order?.inputs?.items || [];
    for (const item of items) {
      if (item.awayScore != null && item.homeScore != null) {
        authorizedLines.push(
          `${item.away || ''} ${item.awayScore} — ${item.home || ''} ${item.homeScore}`
        );
      } else if (item.matchup || item.title) {
        authorizedLines.push(String(item.matchup || item.title));
      }
    }
    const authBlock =
      authorizedLines.length > 0
        ? `AUTHORIZED SCORE / MATCHUP LINES (from job order — do not flag as fabrication if the script matches these):\n${authorizedLines.join('\n')}`
        : 'No authorized box score in job order — be conservative: only flag clear visual contradictions.';

    const prompt = `You are an INDEPENDENT video fact-checker for a broadcast pipeline.
You did NOT write the script below. Another model wrote it.

TASK:
1) Watch the attached video carefully (listen to crowd/audio if useful).
2) Read the SCRIPT text.
3) Set fabricationFound=true ONLY if the script states SPECIFIC, VERIFIABLE facts about what happens in THIS video
   (exact final score, specific player actions clearly not in the clip, quarter-by-quarter scores, roster claims
   that contradict what you see/hear) that are NOT supported by the video and are NOT covered by AUTHORIZED lines.

Do NOT flag opinions, tone, jokes, or generic sports language.
If uncertain, fabricationFound=false.

${authBlock}

SCRIPT:
---
${String(script || '').slice(0, 12000)}
---

Return JSON ONLY:
{
  "fabricationFound": boolean,
  "examples": ["short strings — max 3, only if fabricationFound"],
  "observedSummary": "one sentence what the video actually shows (teams/moment, no invented scores)"
}`;

    captureAIMemoryTrace({
      provider: 'gemini',
      model: GEMINI_MODEL,
      gate: 'gate1b',
      jobId,
      stage: 'gate1_video_review',
      prompt,
      inputs: { videoUrl: videoUrl.slice(0, 200), scriptLen: (script || '').length },
      metadata: { contentType, source: 'lib/gates/gate1_video_reviewer' }
    });

    const genResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { mimeType: 'video/mp4', fileUri: geminiFile.uri } },
              { text: prompt }
            ]
          }
        ],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.15 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );

    const text = (genResp.data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    const parsed = tryParseReviewerJson(text) || {};
    const fabricationFound = !!parsed.fabricationFound;
    const examples = Array.isArray(parsed.examples) ? parsed.examples.map(String).slice(0, 5) : [];
    const observedSummary = typeof parsed.observedSummary === 'string' ? parsed.observedSummary : '';

    return {
      fabricationFound,
      examples,
      observedSummary,
      rawHead: text.slice(0, 400)
    };
  } catch (e) {
    return { skipped: true, error: e.message || String(e) };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_e) { /* ignore */ }
    if (geminiFile && geminiFile.name) {
      try {
        await deleteGeminiFile(geminiFile.name);
      } catch (_e) { /* ignore */ }
    }
  }
}

module.exports = {
  reviewScriptAgainstVideo,
  contentTypeNeedsVideoReview,
  firstSourceUrl,
  tryParseReviewerJson,
  cacheFileForSourceUrl,
  cacheEntryIsUsable,
  cacheKeyForUrl,
  pruneStalePartFiles,
  cacheRootPath
};
