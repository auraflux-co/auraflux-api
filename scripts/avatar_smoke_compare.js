#!/usr/bin/env node
'use strict';
/**
 * Avatar smoke compare — one scene, HeyGen vs EchoMimic variants.
 *
 * Usage:
 *   node scripts/avatar_smoke_compare.js
 *   node scripts/avatar_smoke_compare.js "The stream was indeed his stream now."
 *
 * Outputs land in output/avatar_smoke_compare/ + results.json manifest.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');

const avatar = require('../lib/avatar');
const { uploadToR2, presignR2 } = require('../lib/storage');

const TEXT = process.argv[2] || 'The stream was indeed his stream now.';
const OUT_DIR = path.join(__dirname, '..', 'output', 'avatar_smoke_compare');
const HEADSHOT_LOCAL = path.join(__dirname, '..', 'spike', 'cpd881', 'inputs', 'bobbyg_headshot.png');
const HEADSHOT_R2_KEY = 'spike/cpd881/inputs/bobbyg_headshot.png';

const HEYGEN_ARCHIVE = {
  jobId: 'script_twitch_1781140275746',
  scene: 'JASON_CLIP1_REACTION',
  note: 'Prior HeyGen long-form twitch job (different line text — same scene slot)'
};

function log(msg) {
  const line = `[compare] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'run.log'), `${new Date().toISOString()} ${line}\n`);
}

function promisifyExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${stderr || ''}`));
      else resolve(stdout);
    });
  });
}

async function downloadUrl(url, dest) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(dest, Buffer.from(resp.data));
  return dest;
}

async function wakePodWithRetry() {
  process.env.ECHOMIMIC_POD_HEALTH_MS = process.env.ECHOMIMIC_POD_HEALTH_MS || '600000';
  const { wakePod, waitForHealth, podId: getPodId } = require('../lib/avatar/echomimic_pod');
  const maxWait = parseInt(process.env.ECHOMIMIC_POD_HEALTH_MS, 10);
  try {
    return await wakePod();
  } catch (e) {
    log(`pod wake retry after: ${e.message}`);
    const id = getPodId();
    if (id) await waitForHealth(id, { maxWaitMs: maxWait, intervalMs: 15000 });
    return id;
  }
}

async function ensureHeadshotOnR2() {
  if (!fs.existsSync(HEADSHOT_LOCAL)) {
    throw new Error(`headshot missing: ${HEADSHOT_LOCAL} — run ffmpeg crop first`);
  }
  await uploadToR2(HEADSHOT_LOCAL, 'bobbyg_headshot.png', {
    key: HEADSHOT_R2_KEY,
    contentType: 'image/png'
  });
  log(`headshot uploaded → ${HEADSHOT_R2_KEY}`);
}

async function runHeyGenFresh(label, text) {
  log(`HeyGen submit: "${text}"`);
  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'heygen' });
  const t0 = Date.now();
  const { videoId } = await avatar.submitSegment(
    { text, title: `SMOKE_${label}`, aspectRatio: '16:9', config },
    { engine: 'heygen' }
  );
  log(`HeyGen videoId=${videoId} — polling…`);
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    engine: 'heygen',
    maxWaitMs: 10 * 60 * 1000,
    pollIntervalMs: 8000,
    label
  });
  const dest = path.join(OUT_DIR, `${label}.mp4`);
  await downloadUrl(videoUrl, dest);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`HeyGen ✅ ${label} (${sec}s) → ${dest}`);
  return { label, dest, videoUrl, videoId, renderSec: parseFloat(sec), engine: 'heygen' };
}

async function runEchoMimicVariant({ label, steps, imageKey, speakSpeed, ttsModel, voiceId }) {
  const prev = {
    steps: process.env.ECHOMIMIC_STEPS,
    image: process.env.ECHOMIMIC_IMAGE_KEY,
    speed: process.env.ECHOMIMIC_SPEAK_SPEED,
    model: process.env.ELEVENLABS_MODEL,
    voice: process.env.ELEVENLABS_VOICE_ID
  };
  process.env.ECHOMIMIC_STEPS = String(steps);
  process.env.ECHOMIMIC_IMAGE_KEY = imageKey;
  process.env.ECHOMIMIC_SPEAK_SPEED = String(speakSpeed);
  if (ttsModel) process.env.ELEVENLABS_MODEL = ttsModel;
  if (voiceId) process.env.ELEVENLABS_VOICE_ID = voiceId;

  log(`EchoMimic submit ${label}: steps=${steps} image=${path.basename(imageKey)} speed=${speakSpeed}`);
  await wakePodWithRetry();
  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'echomimic' });
  const t0 = Date.now();
  const { videoId, videoUrl: immediateUrl } = await avatar.submitSegment(
    { text: TEXT, title: `SMOKE_${label}`, aspectRatio: '16:9', config },
    { engine: 'echomimic' }
  );

  let videoUrl = immediateUrl;
  if (!videoUrl) {
    const waited = await avatar.waitForSegment(videoId, {
      engine: 'echomimic',
      maxWaitMs: 20 * 60 * 1000,
      pollIntervalMs: 12000,
      label
    });
    videoUrl = waited.videoUrl;
  }

  const dest = path.join(OUT_DIR, `${label}.mp4`);
  await downloadUrl(videoUrl, dest);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`EchoMimic ✅ ${label} (${sec}s) → ${dest}`);

  Object.assign(process.env, {
    ECHOMIMIC_STEPS: prev.steps,
    ECHOMIMIC_IMAGE_KEY: prev.image,
    ECHOMIMIC_SPEAK_SPEED: prev.speed,
    ELEVENLABS_MODEL: prev.model,
    ELEVENLABS_VOICE_ID: prev.voice
  });

  return {
    label,
    dest,
    videoUrl,
    videoId,
    renderSec: parseFloat(sec),
    engine: 'echomimic',
    steps,
    imageKey,
    speakSpeed,
    ttsModel: ttsModel || process.env.ELEVENLABS_MODEL,
    voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID
  };
}

/** Render one window using pre-built WAV (HeyGen audio) — isolates visual/lip-sync from TTS voice. */
async function runEchoMimicFromWav({ label, wavPath, imageKey, steps }) {
  const echomimic = require('../lib/avatar/adapters/echomimic');
  const { wakePod, waitForHealth, podId: getPodId } = require('../lib/avatar/echomimic_pod');
  try {
    await wakePod();
  } catch (e) {
    log(`pod wake for WAV render: ${e.message}`);
    const id = getPodId();
    if (id) await waitForHealth(id, { maxWaitMs: 600000, intervalMs: 15000 });
  }

  const FPS = 25;
  const maxFrames = parseInt(process.env.ECHOMIMIC_MAX_FRAMES || '81', 10);
  const folder = `avatar/echomimic/smoke_${Date.now().toString(36)}`;
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

  const sampleSize = parseInt(process.env.ECHOMIMIC_SAMPLE_SIZE || '768', 10);
  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(imageKey, { method: 'GET' }),
    presignR2(audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const podId = process.env.ECHOMIMIC_POD_ID;
  const base = `https://${podId}-8000.proxy.runpod.net`;
  const jobInput = {
    image_url: imageGet,
    audio_url: audioGet,
    output_put_url: outputPut,
    video_length: videoLength,
    num_inference_steps: steps,
    sample_size: [sampleSize, sampleSize],
    fps: FPS
  };

  log(`EchoMimic WAV render ${label}: ${durationSec.toFixed(2)}s audio, steps=${steps}`);
  const t0 = Date.now();
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, { timeout: 60000 });
  const jobId = enqueue.data?.job_id;
  if (!jobId) throw new Error(`pod enqueue failed: ${JSON.stringify(enqueue.data).slice(0, 300)}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const st = await axios.get(`${base}/status/${jobId}`, { timeout: 30000 });
    if (st.data?.status === 'completed') break;
    if (st.data?.status === 'failed') {
      throw new Error(st.data?.result?.error || 'pod render failed');
    }
    await new Promise((r) => setTimeout(r, 12000));
  }

  const videoUrl = await presignR2(outputKey, { method: 'GET' });
  const dest = path.join(OUT_DIR, `${label}.mp4`);
  await downloadUrl(videoUrl, dest);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`EchoMimic WAV ✅ ${label} (${sec}s) → ${dest}`);
  return { label, dest, videoUrl, renderSec: parseFloat(sec), engine: 'echomimic', steps, imageKey, audioSource: 'heygen_extract' };
}

async function extractWav(mp4Path, wavPath) {
  await promisifyExec('ffmpeg', ['-y', '-i', mp4Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
  return wavPath;
}

async function downloadHeyGenArchive() {
  const jobs = require('../data/jobs.json');
  const card = jobs[HEYGEN_ARCHIVE.jobId];
  const seg = card?.heygen?.videoJobs?.find((v) => v.sceneName === HEYGEN_ARCHIVE.scene);
  if (!seg?.video_url) {
    log(`archive HeyGen skip — no URL on ${HEYGEN_ARCHIVE.jobId}`);
    return null;
  }
  const dest = path.join(OUT_DIR, 'heygen_archive_reaction.mp4');
  await downloadUrl(seg.video_url, dest);
  log(`HeyGen archive ✅ ${HEYGEN_ARCHIVE.jobId} → ${dest}`);
  return {
    label: 'heygen_archive_reaction',
    dest,
    videoUrl: seg.video_url,
    engine: 'heygen',
    note: HEYGEN_ARCHIVE.note,
    textLength: seg.textLength
  };
}

async function downloadProductionEchoMimic() {
  const jobs = require('../data/jobs.json');
  const card = jobs['script_twitch_1781375085847'];
  const seg = card?.heygen?.videoJobs?.find((v) => v.sceneName === 'JASON_CLIP1_REACTION');
  if (!seg?.video_url) return null;
  const dest = path.join(OUT_DIR, 'em_production_job_reaction.mp4');
  await downloadUrl(seg.video_url, dest);
  log(`Production EchoMimic ✅ job reaction → ${dest}`);
  return { label: 'em_production_job_reaction', dest, engine: 'echomimic', note: 'Jason job render (George voice, steps=8, full portrait)' };
}

async function loadExistingResults() {
  const p = path.join(OUT_DIR, 'results.json');
  if (!fs.existsSync(p)) return { text: TEXT, startedAt: new Date().toISOString(), variants: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function hasVariant(results, label) {
  return results.variants.some((v) => v.label === label && fs.existsSync(v.dest));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`scene text: "${TEXT}"`);
  log(`output dir: ${OUT_DIR}`);

  const results = await loadExistingResults();
  if (!results.variants.length) results.startedAt = new Date().toISOString();

  await ensureHeadshotOnR2();

  if (!hasVariant(results, 'heygen_archive_reaction')) {
    const archive = await downloadHeyGenArchive();
    if (archive) results.variants.push(archive);
  } else log('skip heygen_archive_reaction (exists)');

  if (!hasVariant(results, 'em_production_job_reaction')) {
    const prodEm = await downloadProductionEchoMimic();
    if (prodEm) results.variants.push(prodEm);
  } else log('skip em_production_job_reaction (exists)');

  let heygenFresh = results.variants.find((v) => v.label === 'heygen_fresh_reaction');
  if (!heygenFresh || !fs.existsSync(heygenFresh.dest)) {
    heygenFresh = await runHeyGenFresh('heygen_fresh_reaction', TEXT);
    results.variants = results.variants.filter((v) => v.label !== 'heygen_fresh_reaction');
    results.variants.push(heygenFresh);
  } else log('skip heygen_fresh_reaction (exists)');

  if (!hasVariant(results, 'em_baseline_steps8_full')) {
    results.variants.push(await runEchoMimicVariant({
    label: 'em_baseline_steps8_full',
    steps: 8,
    imageKey: 'spike/cpd881/inputs/bobbyg_studio.png',
    speakSpeed: 1.0,
    ttsModel: 'eleven_flash_v2_5',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb'
  }));
  } else log('skip em_baseline_steps8_full (exists)');

  if (!hasVariant(results, 'em_steps20_headshot')) {
    results.variants.push(await runEchoMimicVariant({
    label: 'em_steps20_headshot',
    steps: 20,
    imageKey: HEADSHOT_R2_KEY,
    speakSpeed: 0.85,
    ttsModel: 'eleven_multilingual_v2',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb'
  }));
  } else log('skip em_steps20_headshot (exists)');

  const wavPath = path.join(OUT_DIR, 'heygen_fresh_reaction.wav');
  if (!fs.existsSync(wavPath)) await extractWav(heygenFresh.dest, wavPath);

  if (!hasVariant(results, 'em_steps20_headshot_heygen_audio')) {
    results.variants.push(await runEchoMimicFromWav({
    label: 'em_steps20_headshot_heygen_audio',
    wavPath,
    imageKey: HEADSHOT_R2_KEY,
    steps: 20
  }));
  } else log('skip em_steps20_headshot_heygen_audio (exists)');

  results.completedAt = new Date().toISOString();
  results.summary = {
    heygen: results.variants.filter((v) => v.engine === 'heygen').map((v) => v.label),
    echomimic: results.variants.filter((v) => v.engine === 'echomimic').map((v) => v.label),
    voiceNote: 'No Bobby G ElevenLabs clone — em_* still use George unless em_steps20_headshot_heygen_audio (HeyGen audio extract)'
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  log('✅ compare complete — see output/avatar_smoke_compare/results.json');
}

(async () => {
  try {
    await main();
  } catch (e) {
    log(`❌ ${e.message}`);
    console.error(e);
    process.exitCode = 1;
  } finally {
    // Leave pod running between compare variants — stop only on full success
    if (process.exitCode === 0 && (process.env.ECHOMIMIC_RENDER_MODE === 'pod' || process.env.ECHOMIMIC_POD_ID)) {
      try {
        await require('../lib/avatar/echomimic_pod').stopPod();
      } catch (e) {
        log(`pod stop: ${e.message}`);
      }
    }
  }
})();
