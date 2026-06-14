'use strict';
/**
 * test/synth_assembly_test.js
 *
 * Synthetic assembly test — no HeyGen, no real clips.
 * Generates black-frame MP4s with FFmpeg, posts them to /assemble,
 * and checks that the output file was created.
 *
 * Usage:
 *   node test/synth_assembly_test.js [news|twitch|nba]  (default: all 3)
 *
 * Requires server running on localhost:3000 and static server on localhost:8765.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const axios = require('axios');

// Use system ffmpeg for synth generation (lavfi source not available in docker ffmpeg binary)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TMP_DIR = path.join(__dirname, '..', 'tmp', 'synth_test');
const API = 'http://localhost:3000';
// Use file:// URLs — assembly.js downloads skip SSRF check for local paths
// Actually assembly downloads via downloadFile which checks TRUSTED_DOMAINS.
// Simplest: add localhost to trusted domains in test, OR copy files to tmp/ and use localhost.
// Best approach: pass absolute paths — assembly checks if file exists locally first.
const STATIC = 'http://localhost:8765/tmp/synth_test';

const args = process.argv.slice(2);
const RUN = args.length ? args : ['news', 'twitch', 'nba', 'short'];

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSynth(filename, duration = 10, source = 'testsrc', size = '1920x1080') {
  const outPath = path.join(TMP_DIR, filename);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100000) return Promise.resolve(outPath);
  return new Promise((res, rej) => {
    execFile(
      FFMPEG,
      [
        '-f',
        'lavfi',
        '-i',
        `${source}=duration=${duration}:size=${size}:rate=30`,
        '-f',
        'lavfi',
        '-i',
        `sine=f=440:b=4:duration=${duration}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-pix_fmt',
        'yuv420p',
        '-y',
        outPath,
      ],
      { timeout: 30000 },
      (err) => (err ? rej(err) : res(outPath))
    );
  });
}

function url(filename) {
  return `${STATIC}/${filename}`;
}

function avatar(label, filename) {
  return { url: url(filename), label, type: 'avatar' };
}
function clip(label, filename) {
  return {
    url: url(filename),
    label,
    type: 'source_clip',
    clipUrl: url(filename),
    pillarboxFilter: null,
    orientation: 'landscape',
  };
}

// ── payload builders ─────────────────────────────────────────────────────────

// /assemble requires a 'segments' array field (validator) even when segmentData is used
function withSegments(p) {
  return {
    ...p,
    segments: p.segmentData.filter((s) => s.type === 'avatar').map((s) => s.url),
    expectedSynth: true,
  };
}

function newsPayload() {
  // COLD_OPEN + 3 stories (sidebar should show all 3 cards) + OUTRO
  const stories = [
    { title: 'Ceasefire Holds In Lebanon', category: 'WORLD NEWS', storyId: 'story_1' },
    { title: 'Markets Rally On Rate Cut', category: 'ECONOMY', storyId: 'story_2' },
    { title: 'Amazon Rainforest Record', category: 'ENVIRONMENT', storyId: 'story_3' },
  ];
  return {
    jobTitle: 'news_synth_test',
    contentType: 'news',
    transition: 'cut',
    format: 'mp4',
    expectedClips: 3,
    segmentData: [
      { ...avatar('COLD_OPEN', 'av_10s.mp4') },
      { ...avatar('STORY1_INTRO', 'av_10s.mp4'), cardData: { ...stories[0], imageUrl: null } },
      { ...avatar('STORY1_SETUP', 'av_10s.mp4'), cardData: { ...stories[0] } },
      { ...clip('STORY1_CLIP', 'clip_9x16_10s.mp4') },
      { ...avatar('STORY1_SUMMARY', 'av_10s.mp4'), cardData: { ...stories[0] } },
      { ...avatar('STORY1_REACTION', 'av_10s.mp4'), cardData: { ...stories[0] } },
      { ...avatar('STORY2_INTRO', 'av_10s.mp4'), cardData: { ...stories[1], imageUrl: null } },
      { ...avatar('STORY2_SETUP', 'av_10s.mp4'), cardData: { ...stories[1] } },
      { ...clip('STORY2_CLIP', 'clip_9x16_10s.mp4') },
      { ...avatar('STORY2_SUMMARY', 'av_10s.mp4'), cardData: { ...stories[1] } },
      { ...avatar('STORY2_REACTION', 'av_10s.mp4'), cardData: { ...stories[1] } },
      { ...avatar('STORY3_INTRO', 'av_10s.mp4'), cardData: { ...stories[2], imageUrl: null } },
      { ...avatar('STORY3_SETUP', 'av_10s.mp4'), cardData: { ...stories[2] } },
      { ...clip('STORY3_CLIP', 'clip_9x16_10s.mp4') },
      { ...avatar('STORY3_SUMMARY', 'av_10s.mp4'), cardData: { ...stories[2] } },
      { ...avatar('STORY3_REACTION', 'av_10s.mp4'), cardData: { ...stories[2] } },
      { ...avatar('OUTRO', 'av_10s.mp4') },
    ],
  };
}

function twitchPayload() {
  // INTRO + 1 streamer (INTRO/CLIP1_SETUP/CLIP1_REACTION) + OUTRO
  return {
    jobTitle: 'twitch_synth_test',
    contentType: 'twitch',
    transition: 'cut',
    format: 'mp4',
    expectedClips: 1,
    segmentData: [
      { ...avatar('INTRO', 'av_10s.mp4') },
      {
        ...avatar('JASON_INTRO', 'av_10s.mp4'),
        cardData: {
          title: 'Jason',
          displayName: 'Jason',
          category: 'ON STREAM',
          storyId: 'streamer_0',
          origin: 'New York',
          fact: 'Just hit 50k subs',
        },
      },
      { ...avatar('JASON_CLIP1_SETUP', 'av_10s.mp4') },
      { ...clip('JASON_CLIP1', 'clip_16x9_10s.mp4') },
      { ...avatar('JASON_CLIP1_REACTION', 'av_10s.mp4') },
      { ...avatar('OUTRO', 'av_10s.mp4') },
    ],
  };
}

function nbaPayload() {
  // INTRO + 1 game (GAME_INTRO/NARRATION/SOURCE_CLIP/REACTION) + OUTRO
  const games = [
    {
      title: 'LAKERS VS CELTICS',
      category: 'NBA GAME',
      storyId: 'game_1',
      matchup: 'Lakers vs Celtics',
    },
  ];
  return {
    jobTitle: 'nba_synth_test',
    contentType: 'nba',
    transition: 'cut',
    format: 'mp4',
    expectedClips: 1,
    segmentData: [
      { ...avatar('INTRO', 'av_10s.mp4') },
      { ...avatar('GAME1_LAKERS_VS_CELTICS_INTRO', 'av_10s.mp4'), cardData: { ...games[0] } },
      { ...avatar('GAME1_LAKERS_VS_CELTICS_NARRATION', 'av_10s.mp4'), cardData: { ...games[0] } },
      { ...clip('GAME1_CLIP', 'clip_16x9_10s.mp4') },
      { ...avatar('GAME1_LAKERS_VS_CELTICS_REACTION', 'av_10s.mp4'), cardData: { ...games[0] } },
      { ...avatar('OUTRO', 'av_10s.mp4') },
    ],
  };
}

function shortPayload() {
  // Short-form split-screen: INTRO (avatar) + CLIP (source) + OUTRO (avatar)
  // contentType 'twitch-short' + format 'portrait' triggers 9:16 split-screen path
  // Avatar is portrait (9:16) from HeyGen; clip is landscape for split-screen bottom half
  return {
    jobTitle: 'twitch_short_synth_test',
    contentType: 'twitch-short',
    transition: 'cut',
    format: 'portrait',
    expectedClips: 1,
    // Caption burned onto the split-screen — sits just above the split line on Bobby G's side
    captionText: 'THIS IS A TEST CAPTION',
    captionStyle: {
      font: '/System/Library/Fonts/Supplemental/Impact.ttf',
      fontsize: 72,
      fontcolor: 'white',
      boxcolor: '0x6441A5@0.92',
      boxborderw: 20,
      position: 'above-split',
    },
    segmentData: [
      { ...avatar('INTRO', 'av_9x16_10s.mp4') },
      { ...clip('JASON_CLIP1', 'clip_16x9_10s.mp4') },
      { ...avatar('OUTRO', 'av_9x16_10s.mp4') },
    ],
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  console.log('Generating synthetic MP4s (testsrc + smptebars)...');
  // Avatar segment: testsrc pattern — recognisable grid so you can see chrome overlay clearly
  await makeSynth('av_10s.mp4', 10, 'testsrc', '1920x1080');
  // Portrait avatar (9:16) for short-form — HeyGen renders these at 1080x1920
  await makeSynth('av_9x16_10s.mp4', 10, 'testsrc', '1080x1920');
  // Landscape source clip: SMPTE color bars
  await makeSynth('clip_16x9_10s.mp4', 10, 'smptebars', '1920x1080');
  // Portrait source clip: SMPTE color bars 9:16
  await makeSynth('clip_9x16_10s.mp4', 10, 'smptebars', '1080x1920');
  console.log('  ✅ Synthetic clips ready in tmp/synth_test/\n');

  const payloads = {
    news: newsPayload,
    twitch: twitchPayload,
    nba: nbaPayload,
    short: shortPayload,
  };
  const results = [];

  for (const type of RUN) {
    const payload = withSegments(payloads[type]());
    console.log(
      `▶ Running ${type.toUpperCase()} assembly test (${payload.segmentData.length} segments)...`
    );
    try {
      const resp = await axios.post(`${API}/assemble`, payload, { timeout: 300000 });
      const asmId = resp.data?.assemblyId || resp.data?.asmId || '?';
      console.log(`  Assembly started: ${asmId}`);

      // Poll for completion — endpoint is /assemble-progress/:id, status 'done' or 'failed'
      let out = null;
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const status = await axios.get(`${API}/assemble-progress/${asmId}`).catch(() => null);
        if (!status) continue;
        const d = status.data;
        // outputPath is set before Gate 3 QA — accept as success even if Gate 3 fails synthetic content
        if (d.outputPath) {
          out = d.outputPath;
          break;
        }
        if (d.status === 'failed' && !d.outputPath) {
          throw new Error(d.error || 'Assembly failed — no output file');
        }
        process.stdout.write('.');
      }
      console.log('');

      if (out && fs.existsSync(out)) {
        const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
        console.log(`  ✅ ${type.toUpperCase()} PASS — ${path.basename(out)} (${mb} MB)\n`);
        results.push({ type, pass: true, out });
      } else {
        console.log(`  ❌ ${type.toUpperCase()} FAIL — no output file\n`);
        results.push({ type, pass: false });
      }
    } catch (e) {
      console.log(`  ❌ ${type.toUpperCase()} ERROR — ${e.message}\n`);
      results.push({ type, pass: false, error: e.message });
    }
  }

  console.log('═══════════════════════════════');
  console.log('RESULTS:');
  for (const r of results) {
    console.log(
      `  ${r.pass ? '✅' : '❌'} ${r.type.toUpperCase()}${r.error ? ' — ' + r.error : ''}`
    );
  }
  const allPass = results.every((r) => r.pass);
  process.exit(allPass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
