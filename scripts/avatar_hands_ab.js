#!/usr/bin/env node
'use strict';
/**
 * Hands mitigation A/B — 3 variants on the gate line (clone TTS).
 *
 * 1. heygen_frame + spike8 (baseline — best eyes/mouth)
 * 2. head_only + spike8 + dynamic off (hands cropped out of reference)
 * 3. heygen_frame + spike8 + post-render bottom desk crop (no tight_head)
 *
 * Usage: bash scripts/doppler_run.sh node scripts/avatar_hands_ab.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { uploadToR2, presignR2 } = require('../lib/storage');

const TEXT = 'The stream was indeed his stream now.';
const OUT = path.join(__dirname, '..', 'output', 'avatar_hands_ab');
const GATE_WAV = path.join(__dirname, '..', 'output', 'avatar_clone_gate', 'cloned_tts.mp3');
const BOTTOM_CROP = process.env.ECHOMIMIC_BOTTOM_CROP_FILTER || 'crop=1920:900:0:0';

const VARIANTS = [
  { label: 'hands_heygen', portrait: 'heygen_frame', headPrompt: false, postCrop: false },
  { label: 'hands_head_only', portrait: 'head_only', headPrompt: true, postCrop: false },
  { label: 'hands_heygen_bottom', portrait: 'heygen_frame', headPrompt: false, postCrop: true }
];

const PORTRAITS = {
  heygen_frame: 'spike/cpd881/inputs/bobbyg_heygen_frame.png',
  head_only: 'spike/cpd881/inputs/bobbyg_head_only.png'
};

function log(msg) {
  console.log(`[hands-ab] ${msg}`);
}

function ensureWav() {
  const mp3 = fs.existsSync(GATE_WAV)
    ? GATE_WAV
    : path.join(OUT, 'cloned_tts.mp3');
  const wav = path.join(OUT, 'cloned_tts.wav');
  if (!fs.existsSync(mp3)) throw new Error('no clone TTS — run avatar_clone_gate first or set GATE_WAV');
  if (!fs.existsSync(wav)) {
    execFileSync('ffmpeg', ['-y', '-i', mp3, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { stdio: 'pipe' });
  }
  return wav;
}

async function renderVariant(variant, wavPath) {
  const echomimic = require('../lib/avatar/adapters/echomimic');
  const { wakePod } = require('../lib/avatar/echomimic_pod');
  await wakePod();

  const tune = echomimic.inferenceTuningFromEnv();
  const imageKey = PORTRAITS[variant.portrait];
  const sampleSize = echomimic.resolveSampleSizePx();
  const folder = `avatar/echomimic/hands_${Date.now().toString(36)}_${variant.label}`;
  const audioKey = `${folder}/speech.wav`;
  const outputKey = `${folder}/render.mp4`;

  await uploadToR2(wavPath, 'speech.wav', { key: audioKey, contentType: 'audio/wav' });
  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(imageKey, { method: 'GET' }),
    presignR2(audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const config = {
    steps: 8,
    sampleSize: [sampleSize, sampleSize],
    inference: {
      ...tune,
      guidanceScale: 4.5,
      audioGuidanceScale: 2.0,
      useDynamicCfg: false,
      useDynamicAcfg: false,
      negScale: 1.2,
      negSteps: 1,
      prompt: variant.headPrompt ? tune.headOnlyPrompt : tune.prompt
    }
  };

  const jobInput = echomimic.buildRenderJobInput({
    config, videoLength: 81, imageGet, audioGet, outputPut
  });

  const podId = process.env.ECHOMIMIC_POD_ID;
  const base = `https://${podId}-8000.proxy.runpod.net`;
  const t0 = Date.now();
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, { timeout: 60000 });
  const jobId = enqueue.data?.job_id;
  if (!jobId) throw new Error(`enqueue failed: ${JSON.stringify(enqueue.data).slice(0, 200)}`);

  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    const st = await axios.get(`${base}/status/${jobId}`, { timeout: 30000 });
    if (st.data?.status === 'completed') {
      const res = st.data?.result || {};
      if (!res.ok) throw new Error(res.error || 'render failed');
      break;
    }
    if (st.data?.status === 'failed') throw new Error(st.data?.result?.error || 'render failed');
    await new Promise((r) => setTimeout(r, 12000));
  }

  const localMp4 = path.join(OUT, `${variant.label}.mp4`);
  const cdnUrl = `https://assets.auraflux.co/${outputKey}`;
  const resp = await axios.get(cdnUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(localMp4, Buffer.from(resp.data));

  let finalKey = outputKey;
  if (variant.postCrop) {
    const cropped = path.join(OUT, `${variant.label}_cropped.mp4`);
    execFileSync('ffmpeg', [
      '-y', '-i', localMp4,
      '-vf', `${BOTTOM_CROP},scale=1920:1080:flags=lanczos`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'copy', cropped
    ], { stdio: 'pipe' });
    finalKey = `${folder}/render_bottom_crop.mp4`;
    await uploadToR2(cropped, 'render_bottom_crop.mp4', { key: finalKey, contentType: 'video/mp4' });
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`${variant.label} done (${sec}s)`);
  return {
    label: variant.label,
    portrait: variant.portrait,
    postCrop: variant.postCrop,
    renderSec: parseFloat(sec),
    url: `https://assets.auraflux.co/${finalKey}`,
    local: localMp4
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const wav = ensureWav();
  log(`text: "${TEXT}"`);

  const results = [];
  for (const v of VARIANTS) {
    log(`rendering ${v.label}…`);
    try {
      results.push(await renderVariant(v, wav));
    } catch (e) {
      log(`❌ ${v.label}: ${e.message}`);
      results.push({ label: v.label, error: e.message });
    }
  }

  const lines = [
    '# Hands mitigation A/B',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Text: "${TEXT}"`,
    `Bottom crop filter: \`${BOTTOM_CROP}\``,
    '',
    '## Compare',
    ...results.map((r) => {
      if (r.error) return `- \`${r.label}\` — **FAILED** ${r.error}`;
      return `- \`${r.label}\` portrait=\`${r.portrait}\` postCrop=${r.postCrop} (${r.renderSec}s) — [mp4](${r.url})`;
    }),
    '',
    '## What to look for',
    '- **hands_heygen** — baseline (eyes/mouth reference)',
    '- **hands_head_only** — hands out of frame; check eyes stay stable vs baseline',
    '- **hands_heygen_bottom** — desk crop only; hands hidden without tight_head input'
  ];

  fs.writeFileSync(path.join(OUT, 'compare.md'), lines.join('\n'));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log('✅ compare.md ready — output/avatar_hands_ab/');
}

main().catch((e) => {
  console.error(`[hands-ab] ❌ ${e.message}`);
  process.exitCode = 1;
});
