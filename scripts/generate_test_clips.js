#!/usr/bin/env node
/**
 * scripts/generate_test_clips.js — Generate synthetic test clips via WAN 2.7
 *
 * Produces 4 clips covering all 6 E2E test scenarios:
 *   - 3 × short clips (9:16, 5s, 720P) → short-form source material
 *   - 1 × long clip  (16:9, 15s, 720P) → long-form source material
 *
 * Then uploads all 4 to R2 at test-clips/ and writes
 * docs/test-clips-manifest.json with URLs + per-scenario job spec examples.
 *
 * Scenarios covered:
 *   1. fetch-short-clips  — use R2 URLs as sourceConfig.urls, templateId: short-form
 *   2. fetch-long-form    — use long R2 URL as sourceConfig.urls, templateId: long-form
 *   3. upload-short-clips — use POST /v1/upload + fileId, templateId: short-form
 *   4. upload-long-form   — same via upload, templateId: long-form
 *   5. stitch-to-long     — 3 short R2 URLs, templateId: long-form (short-to-long)
 *   6. clip-to-short      — 1 long R2 URL,  templateId: short-form (long-to-short)
 *
 * Prerequisites:
 *   RUNPOD_POD_ID set in .env (WAN 2.7 via ComfyUI pod)
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_VIDEO_BUCKET in .env
 *
 * Usage:
 *   node scripts/generate_test_clips.js
 *   node scripts/generate_test_clips.js --skip-gen   # upload already-downloaded clips
 *   node scripts/generate_test_clips.js --local-only # use /output/*.mp4, skip gen + upload
 */

'use strict';

require('dotenv').config();

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const os    = require('os');

const { generateWanVideo, pollComfyResult, downloadComfyOutput } = require('../lib/ai/runpod');
const { uploadToR2 } = require('../lib/storage');

// ── Config ────────────────────────────────────────────────────────────────────

const PLAN_TIER  = 'dwy';   // wan_t2v requires dwy+
const OUTPUT_DIR = path.join(__dirname, '../output/test-clips');
const MANIFEST   = path.join(__dirname, '../docs/test-clips-manifest.json');

// Prompts are clipzworldnews-style — realistic for the platform's content types.
const CLIPS = [
  {
    id:    'short-1',
    label: 'Short clip 1 — breaking news anchor',
    mode:  't2v',
    ratio: '9:16',
    resolution: '720P',
    durationSecs: 5,
    prompt: 'Professional news anchor at a modern broadcast desk, breaking news chyron, clean studio lighting, 9:16 vertical framing, cinematic',
  },
  {
    id:    'short-2',
    label: 'Short clip 2 — sports highlight',
    mode:  't2v',
    ratio: '9:16',
    resolution: '720P',
    durationSecs: 5,
    prompt: 'Basketball arena crowd cheering, dynamic sports highlight reel, dramatic slow motion, vertical format 9:16, vibrant colors',
  },
  {
    id:    'short-3',
    label: 'Short clip 3 — tech/business broll',
    mode:  't2v',
    ratio: '9:16',
    resolution: '720P',
    durationSecs: 5,
    prompt: 'Business professional looking at smartphone with financial data charts overlay, modern office, vertical 9:16 social media format',
  },
  {
    id:    'long-1',
    label: 'Long clip — news documentary broll',
    mode:  't2v',
    ratio: '16:9',
    resolution: '720P',
    durationSecs: 15,
    prompt: 'Aerial cinematic shot of a major city skyline at golden hour, smooth drone camera pan, news documentary style, wide 16:9, high quality',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[test-clips] ${msg}`); }

async function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function extractFirstOutputFile(comfyOutputs) {
  for (const nodeOutputs of Object.values(comfyOutputs || {})) {
    for (const fileList of Object.values(nodeOutputs)) {
      const arr = Array.isArray(fileList) ? fileList : [fileList];
      for (const f of arr) {
        if (f?.filename && /\.(mp4|webm|gif)$/i.test(f.filename)) {
          return { filename: f.filename, subfolder: f.subfolder || '' };
        }
      }
    }
  }
  return null;
}

// ── Generate one clip via WAN 2.7 ─────────────────────────────────────────────

async function generateClip(clip) {
  const localPath = path.join(OUTPUT_DIR, `${clip.id}.mp4`);

  if (fs.existsSync(localPath)) {
    log(`${clip.id} — already exists locally, skipping generation`);
    return localPath;
  }

  log(`${clip.id} — submitting to WAN 2.7 (${clip.ratio}, ${clip.durationSecs}s)…`);
  const promptId = await generateWanVideo({
    positivePrompt: clip.prompt,
    modelVersion:   '2.7',
    mode:           clip.mode,
    resolution:     clip.resolution,
    ratio:          clip.ratio,
    durationSecs:   clip.durationSecs,
    planTier:       PLAN_TIER,
    promptExtend:   true,
    outputPrefix:   `test_clip_${clip.id}_${Date.now()}`,
  });

  if (promptId?.skipped) {
    log(`${clip.id} — SKIPPED: ${promptId.reason}`);
    return null;
  }

  log(`${clip.id} — queued promptId=${promptId}, polling (up to 10 min)…`);

  const outputs = await pollComfyResult(promptId, process.env.RUNPOD_POD_ID, {
    maxWaitMs: 600_000, // 10 min
    intervalMs: 8_000,
  });

  const file = await extractFirstOutputFile(outputs);
  if (!file) throw new Error(`${clip.id} — No video file in ComfyUI outputs: ${JSON.stringify(outputs)}`);

  log(`${clip.id} — downloading ${file.filename}…`);
  const buf = await downloadComfyOutput(file.filename, file.subfolder, process.env.RUNPOD_POD_ID);

  fs.writeFileSync(localPath, buf);
  log(`${clip.id} — saved to ${localPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  return localPath;
}

// ── Upload to R2 ──────────────────────────────────────────────────────────────

async function uploadClip(clip, localPath) {
  log(`${clip.id} — uploading to R2 at test-clips/${clip.id}.mp4…`);
  const url = await uploadToR2(localPath, `${clip.id}.mp4`, {
    folder: 'test-clips',
    contentType: 'video/mp4',
  });
  log(`${clip.id} — R2 URL: ${url}`);
  return url;
}

// ── Build manifest ────────────────────────────────────────────────────────────

function buildManifest(clipResults) {
  const shorts = clipResults.filter((c) => c.id.startsWith('short'));
  const long   = clipResults.find((c) => c.id.startsWith('long'));

  const shortUrls = shorts.map((c) => c.r2Url);
  const longUrl   = long?.r2Url;

  return {
    generatedAt: new Date().toISOString(),
    model:       'WAN 2.7 via RunPod ComfyUI',
    clips:       clipResults,

    // ── 6 test scenario job spec examples ─────────────────────────────────────
    scenarios: [

      {
        id:          'fetch-short-clips',
        description: 'Fetch 3 short clips via URL and produce a short-form output',
        templateId:  'short-form',
        formFactor:  'short',
        transform:   'none — sources are already short-form',
        jobSpec: {
          entry:       'fetch',
          contentType: 'clips',
          templateId:  'short-form',
          url:         shortUrls[0],
          sourceConfig: { urls: shortUrls },
          order: {
            topic:    'clipzworldnews daily sports and news highlights',
            tone:     'energetic',
            duration: '60',
            publish:  { platforms: ['youtube', 'tiktok'] },
          },
          staging: true,
        },
      },

      {
        id:          'fetch-long-form',
        description: 'Fetch one long-form clip via URL and produce a long-form compilation',
        templateId:  'long-form',
        formFactor:  'long',
        transform:   'none — source is already long-form',
        jobSpec: {
          entry:       'fetch',
          contentType: 'news',
          templateId:  'long-form',
          url:         longUrl,
          sourceConfig: { urls: [longUrl] },
          order: {
            topic:    'clipzworldnews: top stories of the day',
            tone:     'professional',
            duration: '180',
            publish:  { platforms: ['youtube'] },
          },
          staging: true,
        },
      },

      {
        id:          'upload-short-clips',
        description: 'Upload own short clips from local files and produce short-form output',
        templateId:  'short-form',
        formFactor:  'short',
        transform:   'none — uploaded clips are short-form',
        note:        'Use POST /v1/upload to get presigned URL per clip, then PUT to uploadUrl, then use returned assetUrl as sourceConfig.urls',
        uploadSteps: shorts.map((c) => ({
          clipId:   c.id,
          filename: `${c.id}.mp4`,
          r2Url:    c.r2Url,
        })),
        jobSpec: {
          entry:       'upload',
          contentType: 'clips',
          templateId:  'short-form',
          fileId:      '__replace_with_r2_key_after_upload__',
          sourceConfig: { uploadSessionId: '__replace_after_upload__', urls: shortUrls },
          order: {
            topic:    'clipzworldnews highlights reel',
            tone:     'dynamic',
            duration: '60',
            publish:  { platforms: ['youtube', 'tiktok', 'instagram'] },
          },
          staging: true,
        },
      },

      {
        id:          'upload-long-form',
        description: 'Upload own long-form clip and produce a long-form video',
        templateId:  'long-form',
        formFactor:  'long',
        transform:   'none — uploaded clip is long-form',
        note:        'Use POST /v1/upload → PUT → use assetUrl as sourceConfig.urls[0]',
        jobSpec: {
          entry:       'upload',
          contentType: 'news',
          templateId:  'long-form',
          fileId:      '__replace_with_r2_key_after_upload__',
          sourceConfig: { urls: [longUrl] },
          order: {
            topic:    'clipzworldnews documentary feature',
            tone:     'informative',
            duration: '300',
            publish:  { platforms: ['youtube'] },
          },
          staging: true,
        },
      },

      {
        id:          'stitch-short-to-long',
        description: 'Stitch 3 short (9:16) clips into a long-form (16:9) production',
        templateId:  'long-form',
        formFactor:  'long',
        transform:   'short-to-long via video_transforms.shortToLong + ffmpeg xfade',
        note:        'Submit 3 short clips as url_list with templateId: long-form — pipeline assembles them with fade transitions',
        jobSpec: {
          entry:       'fetch',
          contentType: 'clips',
          templateId:  'long-form',
          sourceType:  'url_list',
          sourceConfig: { urls: shortUrls },
          order: {
            topic:    'clipzworldnews multi-segment compilation',
            tone:     'energetic',
            duration: '180',
            output:   { formFactor: 'long', aspectRatio: '16:9' },
            publish:  { platforms: ['youtube'] },
          },
          staging: true,
        },
      },

      {
        id:          'clip-long-to-short',
        description: 'Extract a short-form highlight from a long-form clip',
        templateId:  'short-form',
        formFactor:  'short',
        transform:   'long-to-short via video_transforms.longToShort + ffmpeg crop',
        note:        'Submit long clip as sourceConfig.urls[0] with templateId: short-form — pipeline extracts best 60s segment',
        jobSpec: {
          entry:       'fetch',
          contentType: 'news',
          templateId:  'short-form',
          sourceType:  'url_list',
          sourceConfig: { urls: [longUrl] },
          order: {
            topic:    'clipzworldnews: headline moment',
            tone:     'punchy',
            duration: '60',
            output:   { formFactor: 'short', aspectRatio: '9:16' },
            publish:  { platforms: ['tiktok', 'instagram'] },
          },
          staging: true,
        },
      },

    ],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const skipGen   = args.includes('--skip-gen');
  const localOnly = args.includes('--local-only');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });

  const clipResults = [];

  for (const clip of CLIPS) {
    let localPath = path.join(OUTPUT_DIR, `${clip.id}.mp4`);
    let r2Url     = null;

    // ── Step 1: Generate (or skip if already exists) ───────────────────────
    if (!localOnly) {
      if (!skipGen) {
        try {
          localPath = await generateClip(clip) || localPath;
        } catch (err) {
          console.error(`[test-clips] ${clip.id} generation FAILED: ${err.message}`);
          clipResults.push({ ...clip, localPath: null, r2Url: null, error: err.message });
          continue;
        }
      } else {
        log(`${clip.id} — --skip-gen: using existing file if present`);
      }

      // ── Step 2: Upload to R2 ─────────────────────────────────────────────
      if (fs.existsSync(localPath)) {
        try {
          r2Url = await uploadClip(clip, localPath);
        } catch (err) {
          console.error(`[test-clips] ${clip.id} R2 upload FAILED: ${err.message}`);
        }
      } else {
        log(`${clip.id} — no local file to upload`);
      }
    } else {
      log(`${clip.id} — --local-only: skipping gen + upload, using local path`);
    }

    clipResults.push({
      id:        clip.id,
      label:     clip.label,
      ratio:     clip.ratio,
      durationSecs: clip.durationSecs,
      localPath: fs.existsSync(localPath) ? localPath : null,
      r2Url,
    });
  }

  // ── Step 3: Write manifest ─────────────────────────────────────────────────
  const manifest = buildManifest(clipResults);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

  log(`\n✅ Done — manifest written to ${MANIFEST}`);
  log(`\nClips:`);
  clipResults.forEach((c) => {
    log(`  ${c.id}: ${c.localPath ? '✓ local' : '✗ no file'} | r2: ${c.r2Url || 'not uploaded'}`);
  });
  log(`\nScenarios documented in manifest: ${manifest.scenarios.map((s) => s.id).join(', ')}`);
  log(`\nGemini test instructions:`);
  log(`  1. node scripts/generate_test_clips.js          # generate + upload`);
  log(`  2. Read docs/test-clips-manifest.json            # get job spec examples`);
  log(`  3. POST /v1/jobs with each scenario's jobSpec    # submit with staging:true`);
  log(`  4. Poll GET /v1/jobs/:id until status=complete   # wait for pipeline`);
  log(`  5. GET /v1/jobs/:id/staging-assets               # review inputs vs outputs`);
  log(`  6. POST /jobs/:id/approve-publish                # publish to clipzworldnews`);
}

main().catch((err) => {
  console.error('[test-clips] FATAL:', err.message);
  process.exit(1);
});
