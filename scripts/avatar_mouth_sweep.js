#!/usr/bin/env node
'use strict';
/**
 * EchoMimic mouth-quality sweep — grid audio_guidance × steps × portrait.
 * Uses HeyGen audio extract (correct Bobby G voice) to isolate mouth/lip-sync.
 *
 * Usage (secrets from Doppler — not .env):
 *   bash scripts/doppler_run.sh node scripts/avatar_mouth_sweep.js
 *   bash scripts/doppler_run.sh node scripts/avatar_mouth_sweep.js --portrait heygen_frame
 *
 * Output: output/avatar_mouth_sweep/{label}.mp4 + results.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const { uploadToR2, presignR2 } = require('../lib/storage');

const TEXT = 'The stream was indeed his stream now.';
const OUT_DIR = path.join(__dirname, '..', 'output', 'avatar_mouth_sweep');
const HEYGEN_MP4 = path.join(__dirname, '..', 'output', 'avatar_smoke_compare', 'heygen_fresh_reaction.mp4');
const HEYGEN_WAV = path.join(OUT_DIR, 'heygen_audio.wav');
const QUICK = process.argv.includes('--quick');
const PORTRAIT_FILTER = (() => {
  const i = process.argv.indexOf('--portrait');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const PORTRAITS = [
  { key: 'spike/cpd881/inputs/bobbyg_heygen_frame.png', tag: 'heygen_frame' },
  { key: 'spike/cpd881/inputs/bobbyg_mouth_focus.png', tag: 'mouth_focus' },
  { key: 'spike/cpd881/inputs/bobbyg_headshot.png', tag: 'headshot' }
];

const AUDIO_GUIDANCE = QUICK ? [2.5, 3.0, 3.5] : [2.0, 2.5, 3.0, 3.5, 4.0];
const STEPS = QUICK ? [20, 28] : [20, 25, 28];
const GUIDANCE = [3.5, 4.0];

function log(msg) {
  const line = `[sweep] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'run.log'), `${new Date().toISOString()} ${line}\n`);
}

function promisifyExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${err.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

async function uploadPortraits() {
  const base = path.join(__dirname, '..', 'spike', 'cpd881', 'inputs');
  const map = {
    'spike/cpd881/inputs/bobbyg_heygen_frame.png': 'bobbyg_heygen_frame.png',
    'spike/cpd881/inputs/bobbyg_mouth_focus.png': 'bobbyg_mouth_focus.png',
    'spike/cpd881/inputs/bobbyg_headshot.png': 'bobbyg_headshot.png',
    'spike/cpd881/inputs/bobbyg_studio.png': 'bobbyg_studio.png'
  };
  for (const [key, file] of Object.entries(map)) {
    const local = path.join(base, file);
    if (!fs.existsSync(local)) continue;
    await uploadToR2(local, file, { key, contentType: 'image/png' });
    log(`uploaded portrait ${key}`);
  }
}

async function ensureHeygenWav() {
  if (!fs.existsSync(HEYGEN_MP4)) {
    throw new Error(`missing ${HEYGEN_MP4} — run avatar_smoke_compare first`);
  }
  if (!fs.existsSync(HEYGEN_WAV)) {
    await promisifyExec('ffmpeg', ['-y', '-i', HEYGEN_MP4, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', HEYGEN_WAV]);
    log(`extracted HeyGen audio → ${HEYGEN_WAV}`);
  }
}

async function wakePod() {
  process.env.ECHOMIMIC_POD_HEALTH_MS = process.env.ECHOMIMIC_POD_HEALTH_MS || '600000';
  const { wakePod, waitForHealth, podId: getPodId } = require('../lib/avatar/echomimic_pod');
  try {
    await wakePod();
  } catch (e) {
    log(`pod wake retry: ${e.message}`);
    const id = getPodId();
    if (id) await waitForHealth(id, { maxWaitMs: 600000, intervalMs: 15000 });
  }
}

async function renderVariant({ label, imageKey, wavPath, steps, audioGuidance, guidanceScale }) {
  const FPS = 25;
  const maxFrames = parseInt(process.env.ECHOMIMIC_MAX_FRAMES || '81', 10);
  const sampleSize = parseInt(process.env.ECHOMIMIC_SAMPLE_SIZE || '768', 10);
  const folder = `avatar/echomimic/sweep_${Date.now().toString(36)}_${label}`;
  const audioKey = `${folder}/speech.wav`;
  const outputKey = `${folder}/render.mp4`;

  await uploadToR2(wavPath, 'speech.wav', { key: audioKey, contentType: 'audio/wav' });

  const stat = fs.statSync(wavPath);
  const fd = fs.openSync(wavPath, 'r');
  const header = Buffer.alloc(44);
  fs.readSync(fd, header, 0, 44, 0);
  fs.closeSync(fd);
  const byteRate = header.readUInt32LE(28);
  const durationSec = (stat.size - 44) / byteRate;
  const raw = Math.ceil(durationSec * FPS) + 1;
  const videoLength = Math.max(25, Math.min(Math.floor((raw - 1) / 4) * 4 + 1, maxFrames));

  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(imageKey, { method: 'GET' }),
    presignR2(audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const echomimic = require('../lib/avatar/adapters/echomimic');
  const config = {
    steps,
    sampleSize: [sampleSize, sampleSize],
    inference: {
      guidanceScale,
      audioGuidanceScale: audioGuidance,
      audioScale: 1.0,
      seed: 43,
      numSkipStartSteps: 3,
      teacacheThreshold: 0.1,
      prompt: process.env.ECHOMIMIC_PROMPT || undefined
    }
  };
  const jobInput = echomimic.buildRenderJobInput
    ? echomimic.buildRenderJobInput({ config, videoLength, imageGet, audioGet, outputPut })
    : {
      image_url: imageGet,
      audio_url: audioGet,
      output_put_url: outputPut,
      video_length: videoLength,
      num_inference_steps: steps,
      sample_size: [sampleSize, sampleSize],
      fps: FPS,
      guidance_scale: guidanceScale,
      audio_guidance_scale: audioGuidance
    };

  const podId = process.env.ECHOMIMIC_POD_ID;
  const base = `https://${podId}-8000.proxy.runpod.net`;
  const t0 = Date.now();
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, { timeout: 60000 });
  const jobId = enqueue.data?.job_id;
  if (!jobId) throw new Error(`enqueue failed: ${JSON.stringify(enqueue.data).slice(0, 200)}`);

  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    const st = await axios.get(`${base}/status/${jobId}`, { timeout: 30000 });
    if (st.data?.status === 'completed') break;
    if (st.data?.status === 'failed') throw new Error(st.data?.result?.error || 'render failed');
    await new Promise((r) => setTimeout(r, 12000));
  }

  const videoUrl = await presignR2(outputKey, { method: 'GET' });
  const dest = path.join(OUT_DIR, `${label}.mp4`);
  const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(dest, Buffer.from(resp.data));
  const renderSec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`✅ ${label} (${renderSec}s) ags=${audioGuidance} steps=${steps} g=${guidanceScale}`);
  return { label, dest, videoUrl, renderSec: parseFloat(renderSec), imageKey, steps, audioGuidance, guidanceScale };
}

function loadResults() {
  const p = path.join(OUT_DIR, 'results.json');
  if (!fs.existsSync(p)) return { variants: [], completed: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveResults(results) {
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = loadResults();
  results.text = TEXT;
  results.startedAt = results.startedAt || new Date().toISOString();
  if (!results.variants) results.variants = [];
  if (!results.completed) results.completed = {};

  await uploadPortraits();
  await ensureHeygenWav();
  await wakePod();

  const portraits = PORTRAIT_FILTER
    ? PORTRAITS.filter((p) => p.tag === PORTRAIT_FILTER)
    : PORTRAITS;
  if (!portraits.length) throw new Error(`unknown portrait filter: ${PORTRAIT_FILTER}`);

  const jobs = [];
  for (const portrait of portraits) {
    for (const ags of AUDIO_GUIDANCE) {
      for (const steps of STEPS) {
        for (const g of (QUICK ? [4.0] : GUIDANCE)) {
          const label = `${portrait.tag}_ags${String(ags).replace('.', 'p')}_s${steps}_g${String(g).replace('.', 'p')}`;
          if (results.completed[label] && fs.existsSync(path.join(OUT_DIR, `${label}.mp4`))) {
            log(`skip ${label}`);
            continue;
          }
          jobs.push({ label, imageKey: portrait.key, steps, audioGuidance: ags, guidanceScale: g });
        }
      }
    }
  }

  log(`plan: ${jobs.length} renders (${QUICK ? 'quick' : 'full'} mode)`);

  for (const job of jobs) {
    try {
      const r = await renderVariant({ ...job, wavPath: HEYGEN_WAV });
      results.variants = results.variants.filter((v) => v.label !== job.label);
      results.variants.push(r);
      results.completed[job.label] = true;
      saveResults(results);
    } catch (e) {
      log(`❌ ${job.label}: ${e.message}`);
      results.errors = results.errors || [];
      results.errors.push({ label: job.label, error: e.message, at: new Date().toISOString() });
      saveResults(results);
    }
  }

  results.completedAt = new Date().toISOString();
  saveResults(results);
  log(`done — ${results.variants.length} variants in ${OUT_DIR}`);
}

(async () => {
  try {
    await main();
  } catch (e) {
    log(`fatal: ${e.message}`);
    console.error(e);
    process.exitCode = 1;
  }
})();
