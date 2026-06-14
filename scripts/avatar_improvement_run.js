#!/usr/bin/env node
'use strict';
/**
 * Avatar quality improvement run — clone TTS audio + tuned EchoMimic variants.
 *
 * 1. Uploads latest handler.py to R2 + restarts pod (picks up dynamic CFG)
 * 2. Builds head-only portraits
 * 3. Renders a curated variant grid
 * 4. Uploads QA compare sheet to output/avatar_improvement/
 *
 * Usage:
 *   bash scripts/doppler_run.sh node scripts/avatar_improvement_run.js
 *   bash scripts/doppler_run.sh node scripts/avatar_improvement_run.js --skip-restart
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { uploadToR2, presignR2 } = require('../lib/storage');

const TEXT = process.argv.includes('--text')
  ? process.argv[process.argv.indexOf('--text') + 1]
  : 'The stream was indeed his stream now.';
const SKIP_RESTART = process.argv.includes('--skip-restart');
const OUT_DIR = path.join(__dirname, '..', 'output', 'avatar_improvement');
const WORKER_DIR = path.join(__dirname, '..', 'worker', 'echomimic');
const FPS = 25;

const PORTRAITS = {
  heygen_frame: 'spike/cpd881/inputs/bobbyg_heygen_frame.png',
  head_only: 'spike/cpd881/inputs/bobbyg_head_only.png',
  tight_head: 'spike/cpd881/inputs/bobbyg_tight_head.png',
  mouth_focus: 'spike/cpd881/inputs/bobbyg_mouth_focus.png',
  baseline_head: 'spike/cpd881/inputs/bobbyg_baseline_head.png',
  headshot: 'spike/cpd881/inputs/bobbyg_headshot.png'
};

/** Curated grid from research + mouth sweep winners */
const VARIANTS = [
  { label: 'spike8_heygen', portrait: 'heygen_frame', steps: 8, ags: 2.0, g: 4.5, dynamic: false, skip: 5 },
  { label: 'sweep_heygen', portrait: 'heygen_frame', steps: 25, ags: 2.5, g: 3.5, dynamic: false, skip: 5 },
  { label: 'dynamic_heygen', portrait: 'heygen_frame', steps: 25, ags: 2.5, g: 4.0, dynamic: true, skip: 5 },
  { label: 'spike8_head', portrait: 'head_only', steps: 8, ags: 2.0, g: 4.5, dynamic: true, skip: 5, headPrompt: true },
  { label: 'sweep_head', portrait: 'head_only', steps: 25, ags: 2.5, g: 3.5, dynamic: true, skip: 5, headPrompt: true },
  { label: 'dynamic_tight', portrait: 'tight_head', steps: 25, ags: 2.5, g: 3.5, dynamic: true, skip: 5, headPrompt: true },
  { label: 'dynamic_mouth', portrait: 'mouth_focus', steps: 25, ags: 2.5, g: 3.5, dynamic: true, skip: 5, headPrompt: true },
  { label: 'dynamic_bline', portrait: 'baseline_head', steps: 25, ags: 2.5, g: 3.5, dynamic: true, skip: 5, headPrompt: true },
  { label: 'spike8_bline', portrait: 'baseline_head', steps: 8, ags: 2.0, g: 4.5, dynamic: true, skip: 5, headPrompt: true }
];

function log(msg) {
  const line = `[improve] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'run.log'), `${new Date().toISOString()} ${line}\n`);
}

function promisifyExec(cmd, args) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${err.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

async function uploadHandlerToR2() {
  await uploadToR2(path.join(WORKER_DIR, 'handler.py'), 'handler.py', {
    key: 'build/echomimic/handler.py',
    contentType: 'text/x-python'
  });
  await uploadToR2(path.join(WORKER_DIR, 'http_server.py'), 'http_server.py', {
    key: 'build/echomimic/http_server.py',
    contentType: 'text/x-python'
  });
  log('uploaded handler + http_server to R2');
}

/** Stop → start same pod so bootstrap re-fetches handler from R2. Never creates a new pod. */
async function restartExistingPod() {
  const { wakePod, stopPod, getPod, waitForHealth } = require('../lib/avatar/echomimic_pod');
  let id = process.env.ECHOMIMIC_POD_ID;
  if (!id) {
    log('no ECHOMIMIC_POD_ID — wakePod will probe GPU types (4090 → L4 fallback)');
    return wakePod();
  }

  const pod = await getPod(id);
  if (!pod) {
    log(`pod ${id} not found — wakePod will create or reuse a worker`);
    delete process.env.ECHOMIMIC_POD_ID;
    return wakePod();
  }

  if (pod.desiredStatus !== 'EXITED' && pod.desiredStatus !== 'STOPPED') {
    log(`restarting pod ${id} for fresh handler`);
    await stopPod({ force: true });
    await new Promise((r) => setTimeout(r, 12000));
  }

  const axios = require('axios');
  const key = process.env.RUNPOD_API_KEY;
  try {
    await axios.post(`https://rest.runpod.io/v1/pods/${id}/start`, {}, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });
  } catch (e) {
    const msg = e.response?.data?.error || e.message;
    log(`start failed (${msg}) — wakePod will probe GPU types`);
    delete process.env.ECHOMIMIC_POD_ID;
    return wakePod();
  }
  await waitForHealth(id, { maxWaitMs: 600000, intervalMs: 15000 });
  log(`pod ${id} ready`);
  return id;
}

async function uploadHandlerAndRestartPod() {
  await uploadHandlerToR2();
  if (SKIP_RESTART) {
    log('skip-restart — pod may still run old handler until stop/start');
    return;
  }
  await restartExistingPod();
}

async function recoverPodAfterError() {
  log('pod degraded — cooling 20s then restart…');
  await new Promise((r) => setTimeout(r, 20000));
  try {
    await restartExistingPod();
  } catch (e) {
    log(`restart failed (${e.message}) — wakePod fallback`);
    const { wakePod } = require('../lib/avatar/echomimic_pod');
    await wakePod();
  }
}

async function ensureCloneWav() {
  const mp3 = path.join(OUT_DIR, 'cloned_tts.mp3');
  const wav = path.join(OUT_DIR, 'cloned_tts.wav');
  if (!fs.existsSync(mp3)) {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not set');
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      { text: TEXT, model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2' },
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 120000
      }
    );
    fs.writeFileSync(mp3, Buffer.from(resp.data));
    log(`cloned TTS mp3 → ${mp3}`);
  }
  if (!fs.existsSync(wav)) {
    await promisifyExec('ffmpeg', ['-y', '-i', mp3, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    log(`converted → ${wav}`);
  }
  return wav;
}

function wavDurationSec(wavPath) {
  const stat = fs.statSync(wavPath);
  const fd = fs.openSync(wavPath, 'r');
  const header = Buffer.alloc(44);
  fs.readSync(fd, header, 0, 44, 0);
  fs.closeSync(fd);
  const byteRate = header.readUInt32LE(28);
  return (stat.size - 44) / byteRate;
}

async function renderVariant(variant, wavPath) {
  const echomimic = require('../lib/avatar/adapters/echomimic');
  const tune = echomimic.inferenceTuningFromEnv();
  const imageKey = PORTRAITS[variant.portrait];
  if (!imageKey) throw new Error(`unknown portrait: ${variant.portrait}`);

  const maxFrames = parseInt(process.env.ECHOMIMIC_MAX_FRAMES || '81', 10);
  const sampleSize = parseInt(process.env.ECHOMIMIC_SAMPLE_SIZE || '768', 10);
  const durationSec = wavDurationSec(wavPath);
  const raw = Math.ceil(durationSec * FPS) + 1;
  const videoLength = Math.max(25, Math.min(Math.floor((raw - 1) / 4) * 4 + 1, maxFrames));

  const folder = `avatar/echomimic/improve_${Date.now().toString(36)}_${variant.label}`;
  const audioKey = `${folder}/speech.wav`;
  const outputKey = `${folder}/render.mp4`;

  await uploadToR2(wavPath, 'speech.wav', { key: audioKey, contentType: 'audio/wav' });
  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(imageKey, { method: 'GET' }),
    presignR2(audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const prompt = variant.headPrompt ? tune.headOnlyPrompt : tune.prompt;
  const config = {
    steps: variant.steps,
    sampleSize: [sampleSize, sampleSize],
    inference: {
      ...tune,
      guidanceScale: variant.g,
      audioGuidanceScale: variant.ags,
      numSkipStartSteps: variant.skip ?? tune.numSkipStartSteps,
      useDynamicCfg: variant.dynamic,
      useDynamicAcfg: variant.dynamic,
      negScale: variant.dynamic ? 1.5 : 1.0,
      negSteps: variant.dynamic ? 2 : 0,
      prompt
    }
  };

  const jobInput = echomimic.buildRenderJobInput({
    config, videoLength, imageGet, audioGet, outputPut
  });

  const podId = process.env.ECHOMIMIC_POD_ID;
  const base = `https://${podId}-8000.proxy.runpod.net`;
  const t0 = Date.now();
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, { timeout: 60000 });
  const jobId = enqueue.data?.job_id;
  if (!jobId) throw new Error(`enqueue failed: ${JSON.stringify(enqueue.data).slice(0, 200)}`);

  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const st = await axios.get(`${base}/status/${jobId}`, { timeout: 30000 });
    if (st.data?.status === 'completed') {
      const res = st.data?.result || {};
      if (!res.ok) throw new Error(res.error || res.result?.error || 'render failed');
      break;
    }
    if (st.data?.status === 'failed') {
      throw new Error(st.data?.result?.error || 'render failed');
    }
    await new Promise((r) => setTimeout(r, 12000));
  }

  const videoUrl = await presignR2(outputKey, { method: 'GET' });
  const dest = path.join(OUT_DIR, `${variant.label}.mp4`);
  const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(dest, Buffer.from(resp.data));
  const renderSec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`✅ ${variant.label} (${renderSec}s) portrait=${variant.portrait} steps=${variant.steps} ags=${variant.ags}`);

  const domain = process.env.R2_ASSETS_DOMAIN;
  const publicUrl = domain ? `https://${domain}/${outputKey}` : videoUrl;
  return {
    label: variant.label,
    dest,
    publicUrl,
    r2Key: outputKey,
    renderSec: parseFloat(renderSec),
    ...variant
  };
}

function loadResults() {
  const p = path.join(OUT_DIR, 'results.json');
  if (!fs.existsSync(p)) return { variants: [], completed: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveResults(results) {
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
}

function writeCompareMd(results) {
  const lines = [
    '# Avatar improvement — compare links',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Text: "${TEXT}"`,
    'Audio: ElevenLabs Bobby G clone',
    '',
    '## HeyGen baseline',
    '- [heygen_baseline.mp4](https://assets.auraflux.co/qa/gate/heygen_baseline.mp4)',
    '',
    '## Variants (newest run)'
  ];
  for (const v of results.variants) {
    lines.push(`- \`${v.label}\` — portrait \`${v.portrait}\` steps=${v.steps} ags=${v.ags} dynamic=${v.dynamic} — [mp4](${v.publicUrl})`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'compare.md'), lines.join('\n'));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = loadResults();
  results.text = TEXT;
  results.startedAt = results.startedAt || new Date().toISOString();
  if (!results.variants) results.variants = [];
  if (!results.completed) results.completed = {};

  log('building portraits…');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execFileSync('node', [path.join(__dirname, 'build_avatar_portraits.js')], { stdio: 'inherit' });

  await uploadHandlerToR2();
  if (!SKIP_RESTART) await restartExistingPod();
  else log('skip-restart');

  const wavPath = await ensureCloneWav();

  const jobs = VARIANTS.filter((v) => {
    if (results.completed[v.label] && fs.existsSync(path.join(OUT_DIR, `${v.label}.mp4`))) {
      log(`skip ${v.label}`);
      return false;
    }
    return true;
  });

  log(`plan: ${jobs.length} renders (${VARIANTS.length - jobs.length} skipped)`);

  const restartEvery = parseInt(process.env.ECHOMIMIC_RESTART_EVERY || '2', 10);
  let sinceRestart = 0;

  for (const variant of jobs) {
    if (sinceRestart >= restartEvery) {
      log(`proactive pod restart after ${sinceRestart} renders`);
      await recoverPodAfterError();
      sinceRestart = 0;
    }
    try {
      const r = await renderVariant(variant, wavPath);
      sinceRestart += 1;
      results.variants = results.variants.filter((x) => x.label !== variant.label);
      results.variants.push(r);
      results.completed[variant.label] = true;
      saveResults(results);
      writeCompareMd(results);
    } catch (e) {
      log(`❌ ${variant.label}: ${e.message}`);
      results.errors = results.errors || [];
      results.errors.push({ label: variant.label, error: e.message, at: new Date().toISOString() });
      saveResults(results);
      if (/502|404|500|timeout|ECONNREFUSED/i.test(e.message)) {
        log('retrying after pod restart…');
        try {
          await recoverPodAfterError();
          sinceRestart = 0;
          const r = await renderVariant(variant, wavPath);
          sinceRestart += 1;
          results.variants = results.variants.filter((x) => x.label !== variant.label);
          results.variants.push(r);
          results.completed[variant.label] = true;
          saveResults(results);
          writeCompareMd(results);
          log(`✅ ${variant.label} (retry ok)`);
        } catch (e2) {
          log(`❌ ${variant.label} retry failed: ${e2.message}`);
          results.errors.push({ label: variant.label, error: e2.message, at: new Date().toISOString(), retry: true });
          saveResults(results);
        }
      }
    }
  }

  // Production gate tracks QA winner (spike8_heygen)
  const prodLabel = results.variants.find((v) => v.label === 'spike8_heygen')
    || results.variants.find((v) => v.label === 'sweep_heygen')
    || results.variants[results.variants.length - 1];
  if (prodLabel?.dest && fs.existsSync(prodLabel.dest)) {
    const gateDest = path.join(__dirname, '..', 'output', 'avatar_clone_gate', 'em_clone_production.mp4');
    fs.mkdirSync(path.dirname(gateDest), { recursive: true });
    fs.copyFileSync(prodLabel.dest, gateDest);
    // Versioned CDN keys — never rely on em_clone_production.mp4 (Cloudflare caches in place)
    await uploadToR2(prodLabel.dest, 'em_clone_spike8.mp4', {
      key: 'qa/gate/em_clone_spike8.mp4',
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=31536000, immutable'
    });
    const sweep = path.join(__dirname, '..', 'output', 'avatar_improvement', 'sweep_heygen.mp4');
    if (fs.existsSync(sweep)) {
      await uploadToR2(sweep, 'em_clone_sweep25.mp4', {
        key: 'qa/gate/em_clone_sweep25.mp4',
        contentType: 'video/mp4',
        cacheControl: 'public, max-age=31536000, immutable'
      });
    }
    log(`CDN gate → qa/gate/em_clone_spike8.mp4 (${prodLabel.label})`);
  }

  results.completedAt = new Date().toISOString();
  saveResults(results);
  writeCompareMd(results);
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
