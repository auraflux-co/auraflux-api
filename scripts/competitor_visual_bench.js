#!/usr/bin/env node
'use strict';
/**
 * Gemini 2.5 Flash multimodal competitor review — visual + audio patterns.
 * Downloads 5 Shorts + 2 VODs per channel, analyzes each, rolls up channel themes.
 *
 * Usage:
 *   node scripts/competitor_visual_bench.js
 *   node scripts/competitor_visual_bench.js --handle stream.serpent
 *   node scripts/competitor_visual_bench.js --out logs/competitor_visual_bench.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../lib/qa');
const { parseJsonLoose } = require('../lib/gemini_json_parse');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const HANDLES = [
  'imgoochy',
  'rickclipit',
  'stream.serpent',
  'core_fx',
  'DahBluh',
  'clipzworldnews',
];

const SHORT_COUNT = 5;
const VOD_COUNT = 2;
const TMP_ROOT = path.join(__dirname, '..', 'tmp', 'competitor_visual');

const CWN_STACK = `ClipzWorld News / AuraFlux C0 creative stack (replication baseline):
- clip-comp Shorts: up to 4 Twitch clips stitched portrait 9:16, blur-pad letterbox, burned text hooks (Hook Machine + playbook), optional intro/outro cards, CWN logo in top blur fold
- twitch-short: split-screen (Bobby G avatar top / source clip bottom) or full-frame clip variants
- VOD today: mostly raw multi-hour YouTube live DVR replays + occasional long news chrome
- Publish: Upload-Post / YouTube direct; SEO metadata heavy on ClipzWorld, lighter on competitors
- Missing today: ranked-list overlay templates (RANKING X MOMENTS 1-5), Related Video Short→VOD funnel wiring, themed series branding`;

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function geminiJsonConfig() {
  return {
    responseMimeType: 'application/json',
    temperature: 0.2,
    maxOutputTokens: 8192,
  };
}

async function listWithDetails(handle, tab, limit = 40) {
  const url = `https://www.youtube.com/@${handle}/${tab}`;
  try {
    const stdout = await run('yt-dlp', ['--no-update', '--flat-playlist', '-j', '--playlist-end', String(limit), url], 120000);
    const ids = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.id) ids.push(d.id);
      } catch { /* skip */ }
    }
    if (!ids.length) return [];

    const details = [];
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const urls = chunk.map((id) => `https://www.youtube.com/watch?v=${id}`);
      try {
        const out = await run('yt-dlp', ['--no-update', '-j', '--no-download', ...urls], 120000);
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          try { details.push(JSON.parse(line)); } catch { /* skip */ }
        }
      } catch (e) {
        console.warn(`[${handle}/${tab}] detail chunk fail:`, e.message.slice(0, 100));
      }
    }
    return details;
  } catch (e) {
    console.warn(`[${handle}/${tab}] tab unavailable:`, e.message.split('\n')[0].slice(0, 120));
    return [];
  }
}

function pickSamples(shorts, vods) {
  const sortedShorts = [...shorts]
    .filter((d) => (d.duration || 0) <= 90 || d.duration == null)
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
  const sortedVods = [...vods]
    .filter((d) => {
      const dur = d.duration || 0;
      const live = d.is_live || d.live_status === 'is_live' || (d.duration == null && dur === 0);
      return dur >= 60 && !live;
    })
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0));

  return {
    shorts: sortedShorts.slice(0, SHORT_COUNT),
    vods: sortedVods.slice(0, VOD_COUNT),
  };
}

async function downloadVideo(videoId, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 50000) return destPath;
  await run('yt-dlp', [
    '--no-update',
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', destPath,
    `https://www.youtube.com/watch?v=${videoId}`,
  ], 420000);
  return destPath;
}

async function trimForAnalysis(srcPath, durationSec, outPath) {
  if (!fs.existsSync(srcPath)) throw new Error('missing src');
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', srcPath], 30000);
  const total = parseFloat(probe.trim()) || durationSec;
  const clipSec = Math.min(90, Math.max(30, Math.floor(total)));
  if (total <= 95) {
    if (srcPath !== outPath) fs.copyFileSync(srcPath, outPath);
    return { analyzedSec: total, totalSec: total, trimmed: false };
  }
  await run('ffmpeg', [
    '-y', '-ss', '0', '-i', srcPath, '-t', String(clipSec),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '128k', outPath,
  ], 120000);
  return { analyzedSec: clipSec, totalSec: total, trimmed: true };
}

async function callGeminiVideo(prompt, fileUri) {
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }, { fileData: { mimeType: 'video/mp4', fileUri } }] }],
      generationConfig: geminiJsonConfig(),
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 180000 },
  );
  const parts = resp.data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

async function callGeminiText(prompt) {
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: geminiJsonConfig(),
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
  );
  const parts = resp.data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

function perVideoPrompt(meta, surface, trimInfo) {
  return `You are a competitive creative analyst for Twitch/YouTube clip reaction channels.

Watch this ${surface} and return JSON only (no markdown).

CHANNEL: @${meta.handle}
VIDEO TITLE: ${meta.title}
VIEWS: ${meta.view_count ?? 'unknown'}
DURATION: ${meta.duration ?? 'unknown'}s (you are seeing ${trimInfo.analyzedSec}s${trimInfo.trimmed ? ` — opening sample of ${trimInfo.totalSec}s VOD` : ''})
SURFACE: ${surface}

${CWN_STACK}

Analyze VISUAL and AUDIO. Report patterns, not one-off quirks.

Return JSON:
{
  "title": "${(meta.title || '').replace(/"/g, '\\"')}",
  "surface": "${surface}",
  "visual": {
    "layout": "describe frame layout (full bleed, split, list overlay, blur pad, etc.)",
    "on_screen_text": ["burned captions, headers, ranked lists, emojis on screen"],
    "branding": "logo, colors, template consistency",
    "pacing_cuts": "cut frequency, jump cuts, dead air",
    "thumbnail_style_note": "what the opening frame suggests for feed thumbnail"
  },
  "audio": {
    "source": "stream audio, music bed, sfx, silence cuts",
    "mix": "clip audio only vs layered music vs voiceover",
    "hook_audio": "what you hear in first 3 seconds"
  },
  "content_theme": "streamer/topic/drama axis",
  "features_used": ["numbered list", "multi-clip countdown", "single moment", "avatar reaction", etc.],
  "seo_packaging": "how title relates to what is on screen",
  "replication": {
    "difficulty": "easy|medium|hard",
    "score_1_to_5": 3,
    "already_in_cwn_stack": ["what we can do today"],
    "missing_in_cwn_stack": ["specific gaps vs this video"],
    "effort_estimate": "e.g. 2h template in After Effects vs config flag"
  }
}`;
}

function channelRollupPrompt(handle, channelName, analyses) {
  return `You are synthesizing competitor channel creative patterns for ClipzWorld News.

CHANNEL: @${handle} (${channelName || handle})
Samples analyzed: ${analyses.length} videos (mix of Shorts + VODs)

${CWN_STACK}

Per-video analyses:
${JSON.stringify(analyses, null, 2)}

Return JSON:
{
  "handle": "${handle}",
  "channel_name": "${(channelName || '').replace(/"/g, '\\"')}",
  "signature_patterns": ["dominant visual/audio/content patterns across samples"],
  "themes": ["recurring content themes — streamers, list types, drama axes"],
  "features_catalog": [{"feature":"name","frequency":"always|often|sometimes","description":"..."}],
  "shorts_vs_vods": {
    "shorts_role": "discovery / list item / standalone moment",
    "vods_role": "or none if no VODs sampled"
  },
  "why_views_work": "2-4 sentences on retention/discoverability mechanics",
  "replication_roadmap": {
    "easy_wins": ["can ship with current stack in <1 week"],
    "medium_builds": ["needs new template or pipeline config"],
    "hard_gaps": ["major creative or ops investment"],
    "priority_for_clipzworld": ["ordered list of what to add first"]
  },
  "clipzworld_delta": "what we are missing vs this channel in one paragraph"
}`;
}

async function analyzeOneVideo(meta, surface, handleDir) {
  const videoId = meta.id;
  const rawPath = path.join(handleDir, `${surface}_${videoId}_raw.mp4`);
  const analyzePath = path.join(handleDir, `${surface}_${videoId}_analyze.mp4`);

  console.log(`  ↓ download ${surface} ${videoId} — ${(meta.title || '').slice(0, 50)}`);
  await downloadVideo(videoId, rawPath);
  const trimInfo = await trimForAnalysis(rawPath, meta.duration || 60, analyzePath);

  let geminiFile;
  try {
    geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(analyzePath));
    const raw = await callGeminiVideo(
      perVideoPrompt({ ...meta, handle: path.basename(handleDir) }, surface, trimInfo),
      geminiFile.uri,
    );
    const parsed = parseJsonLoose(raw);
    return { ...parsed, video_id: videoId, views: meta.view_count, duration_sec: meta.duration, trim: trimInfo };
  } finally {
    if (geminiFile?.name) await deleteGeminiFile(geminiFile.name);
  }
}

async function analyzeChannel(handle) {
  console.log(`\n=== @${handle} ===`);
  const handleDir = path.join(TMP_ROOT, handle);
  fs.mkdirSync(handleDir, { recursive: true });

  const [shortDetails, videoDetails] = await Promise.all([
    listWithDetails(handle, 'shorts', 50),
    listWithDetails(handle, 'videos', 40),
  ]);

  const { shorts, vods } = pickSamples(shortDetails, videoDetails);
  console.log(`  picked ${shorts.length} shorts, ${vods.length} vods`);

  const channelName = shorts[0]?.channel || vods[0]?.channel || handle;
  const perVideo = [];

  for (const s of shorts) {
    try {
      perVideo.push(await analyzeOneVideo({ ...s, handle }, 'short', handleDir));
    } catch (e) {
      console.warn(`  ✗ short ${s.id}:`, e.message.slice(0, 120));
      perVideo.push({ error: e.message, video_id: s.id, surface: 'short', title: s.title });
    }
  }
  for (const v of vods) {
    try {
      perVideo.push(await analyzeOneVideo({ ...v, handle }, 'vod', handleDir));
    } catch (e) {
      console.warn(`  ✗ vod ${v.id}:`, e.message.slice(0, 120));
      perVideo.push({ error: e.message, video_id: v.id, surface: 'vod', title: v.title });
    }
  }

  const ok = perVideo.filter((v) => !v.error);
  let rollup = null;
  if (ok.length) {
    try {
      const raw = await callGeminiText(channelRollupPrompt(handle, channelName, ok));
      rollup = parseJsonLoose(raw);
    } catch (e) {
      rollup = { error: e.message };
    }
  }

  return {
    handle,
    channel_name: channelName,
    sampled: { shorts: shorts.length, vods: vods.length },
    subscriber_count: shorts[0]?.channel_follower_count || vods[0]?.channel_follower_count || null,
    videos: perVideo,
    rollup,
  };
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY required');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let outPath = path.join(__dirname, '..', 'logs', 'competitor_visual_bench.json');
  let handles = HANDLES;
  let synthesizeOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
    if (args[i] === '--handle' && args[i + 1]) handles = [args[++i]];
    if (args[i] === '--synthesize-only') synthesizeOnly = true;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model: GEMINI_MODEL,
    samples_per_channel: { shorts: SHORT_COUNT, vods: VOD_COUNT },
    cwn_baseline: CWN_STACK,
    channels: [],
  };

  if (fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (Array.isArray(prev.channels)) report.channels = prev.channels;
      if (prev.cross_channel) report.cross_channel = prev.cross_channel;
    } catch { /* fresh start */ }
  }

  if (!synthesizeOnly) {
    for (const handle of handles) {
      report.channels = report.channels.filter((c) => c.handle !== handle);
      report.channels.push(await analyzeChannel(handle));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`  checkpoint → ${outPath}`);
    }
  }

  // Cross-channel synthesis
  const rollups = report.channels.filter((c) => c.rollup && !c.rollup.error);
  if (rollups.length >= 2) {
    try {
      const raw = await callGeminiText(`Synthesize cross-channel competitive insights for ClipzWorld News.

${CWN_STACK}

Channel rollups:
${JSON.stringify(rollups.map((c) => ({ handle: c.handle, rollup: c.rollup })), null, 2)}

Return JSON:
{
  "top_patterns_across_competitors": [],
  "unique_to_stream_serpent": [],
  "unique_to_core_fx_imgoochy": [],
  "unique_to_dahbluh": [],
  "clipzworld_priority_adds": ["ordered — what to build first"],
  "replication_matrix": [{"feature":"...","channels_using_it":[],"cwn_has_it":false,"difficulty":"easy|medium|hard"}]
}`);
      report.cross_channel = parseJsonLoose(raw);
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    } catch (e) {
      report.cross_channel = { error: e.message };
    }
  }

  console.log(`\nDone → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
