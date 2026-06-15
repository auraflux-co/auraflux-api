#!/usr/bin/env node
'use strict';
/**
 * CPD-881 Gate2 validation — spike-exact inference on A/B/C lines + Gemini score vs HeyGen.
 *
 * Uses pre-cut spike audio + HeyGen refs from R2 (same as launch_spike.py).
 * Pass bar: overall_broadcast_ready >= 9 on each line (see spike/cpd881/gate2_scores.json).
 *
 * Usage:
 *   bash scripts/doppler_run.sh node scripts/avatar_gate2_validation.js
 *   bash scripts/doppler_run.sh node scripts/avatar_gate2_validation.js --skip-restart
 *   bash scripts/doppler_run.sh node scripts/avatar_gate2_validation.js --score-only
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const { presignR2, uploadToR2 } = require('../lib/storage');
const echomimic = require('../lib/avatar/adapters/echomimic');
const {
  GATE2_LINES,
  GATE2_PASS_BROADCAST_READY,
  SPIKE_INFERENCE,
  SPIKE_STEPS,
  SPIKE_MAX_FRAMES,
  resolveSpikePortraitKey
} = require('../lib/avatar/echomimic_spike');
const { scorePair, summarizePassFail } = require('../lib/avatar/avatar_gate2_score');

const OUT = path.join(__dirname, '..', 'output', 'avatar_gate2');
const SKIP_RESTART = process.argv.includes('--skip-restart');
const SCORE_ONLY = process.argv.includes('--score-only');
const WORKER_DIR = path.join(__dirname, '..', 'worker', 'echomimic');

function log(msg) {
  console.log(`[gate2] ${msg}`);
}

function publicR2Url(key) {
  const domain = process.env.R2_ASSETS_DOMAIN;
  if (!domain) return null;
  return `https://${domain}/${key}`;
}

async function uploadGate2Clip(localPath, lineKey, suffix) {
  const key = `qa/gate/gate2_${lineKey}_${suffix}.mp4`;
  const url = await uploadToR2(localPath, path.basename(localPath), {
    key,
    contentType: 'video/mp4',
    cacheControl: 'public, max-age=31536000, immutable'
  });
  return { key, url: url || publicR2Url(key) };
}

async function uploadHandlerAndRestartPod() {
  await uploadToR2(path.join(WORKER_DIR, 'handler.py'), 'handler.py', {
    key: 'build/echomimic/handler.py',
    contentType: 'text/x-python'
  });
  log('uploaded handler.py → R2 build/echomimic/');
  if (SKIP_RESTART) {
    log('skip-restart — pod may run stale handler until stop/start');
    return;
  }
  const { wakePod, stopPod, getPod } = require('../lib/avatar/echomimic_pod');
  const id = process.env.ECHOMIMIC_POD_ID;
  if (!id) {
    await wakePod();
    return;
  }
  const pod = await getPod(id);
  if (pod && pod.desiredStatus !== 'EXITED' && pod.desiredStatus !== 'STOPPED') {
    log(`restarting pod ${id} for spike handler`);
    await stopPod({ force: true });
    await new Promise((r) => setTimeout(r, 12000));
  }
  const key = process.env.RUNPOD_API_KEY;
  await axios.post(`https://rest.runpod.io/v1/pods/${id}/start`, {}, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 60000
  });
  const { waitForHealth } = require('../lib/avatar/echomimic_pod');
  await waitForHealth(id, { maxWaitMs: 600000, intervalMs: 15000 });
  log(`pod ${id} ready`);
}

async function transcribeSpikeAudio(apiKey, wavPath) {
  const size = fs.statSync(wavPath).size;
  const start = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    { file: { display_name: path.basename(wavPath) } },
    {
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': 'audio/wav',
        'Content-Type': 'application/json'
      }
    }
  );
  const uploadUrl = start.headers['x-goog-upload-url'];
  const finalize = await axios.post(uploadUrl, fs.readFileSync(wavPath), {
    headers: {
      'Content-Length': String(size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    maxBodyLength: Infinity
  });
  const name = finalize.data?.file?.name;
  for (let i = 0; i < 30; i++) {
    const st = await axios.get(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`);
    if (st.data?.state === 'ACTIVE') {
      const model = process.env.GEMINI_SCORE_MODEL || 'gemini-2.5-flash';
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          contents: [{
            parts: [
              { file_data: { mime_type: 'audio/wav', file_uri: st.data.uri } },
              { text: 'Transcribe the spoken words verbatim. Return plain text only, no punctuation changes.' }
            ]
          }],
          generationConfig: { temperature: 0.1 }
        },
        { timeout: 120000 }
      );
      return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('audio file never became ACTIVE for transcription');
}

async function ensureHeygenRef(lineKey, lineDef, refPath, apiKey) {
  if (fs.existsSync(refPath)) return refPath;
  try {
    await downloadR2Key(lineDef.heygenRefKey, refPath);
    log(`HeyGen ref from R2 → ${refPath}`);
    return refPath;
  } catch (_e) {
    log(`HeyGen ref missing on R2 for ${lineKey} — generating from HeyGen API…`);
  }

  const wavPath = path.join(OUT, `${lineKey}_spike.wav`);
  await downloadR2Key(lineDef.audioKey, wavPath);
  const text = await transcribeSpikeAudio(apiKey, wavPath);
  if (!text) throw new Error('empty transcription from spike audio');

  const avatar = require('../lib/avatar');
  const hgConfig = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'heygen' });
  log(`${lineKey} HeyGen render: "${text.slice(0, 80)}…"`);
  const { videoId } = await avatar.submitSegment(
    { text, title: `GATE2_REF_${lineKey}`, aspectRatio: '16:9', config: hgConfig },
    { engine: 'heygen' }
  );
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    engine: 'heygen', maxWaitMs: 25 * 60 * 1000, pollIntervalMs: 12000, label: lineKey
  });
  const rawRef = path.join(OUT, `${lineKey}_heygen_raw.mp4`);
  const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(rawRef, Buffer.from(resp.data));
  execFileSync('ffmpeg', [
    '-y', '-i', rawRef, '-t', '3.24', '-c', 'copy', refPath
  ], { stdio: 'pipe' });

  try {
    await uploadToR2(refPath, path.basename(refPath), {
      key: lineDef.heygenRefKey,
      contentType: 'video/mp4'
    });
    log(`uploaded HeyGen ref → ${lineDef.heygenRefKey}`);
  } catch (e) {
    log(`warn: could not upload HeyGen ref to R2: ${e.message}`);
  }
  return refPath;
}

async function downloadR2Key(key, dest) {
  const url = await presignR2(key, { method: 'GET' });
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(dest, Buffer.from(resp.data));
}

async function renderLine(lineKey, lineDef) {
  process.env.ECHOMIMIC_PROFILE = 'spike';
  delete process.env.ECHOMIMIC_PORTRAIT;
  delete process.env.ECHOMIMIC_IMAGE_KEY;
  process.env.ECHOMIMIC_CHUNK = 'off';

  const { wakePod } = require('../lib/avatar/echomimic_pod');
  await wakePod();

  const sampleSize = echomimic.resolveSampleSizePx();
  const folder = `avatar/echomimic/gate2_${Date.now().toString(36)}_${lineKey}`;
  const outputKey = `${folder}/render.mp4`;
  const imageKey = resolveSpikePortraitKey();

  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(imageKey, { method: 'GET' }),
    presignR2(lineDef.audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const config = {
    steps: SPIKE_STEPS,
    sampleSize: [sampleSize, sampleSize],
    avatarId: imageKey,
    inference: { ...SPIKE_INFERENCE }
  };

  const jobInput = echomimic.buildRenderJobInput({
    config,
    videoLength: SPIKE_MAX_FRAMES,
    imageGet,
    audioGet,
    outputPut
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
      if (!res.ok) throw new Error(res.error || res.log_tail || 'render failed');
      break;
    }
    if (st.data?.status === 'failed') throw new Error(st.data?.result?.error || 'render failed');
    await new Promise((r) => setTimeout(r, 12000));
  }

  const localMp4 = path.join(OUT, `${lineKey}.mp4`);
  await downloadR2Key(outputKey, localMp4);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`${lineKey} render done (${sec}s) → ${localMp4}`);
  return { localMp4, outputKey, renderSec: parseFloat(sec) };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY required for Gate2 scoring');

  const manifest = {
    profile: 'spike',
    portrait: resolveSpikePortraitKey(),
    inference: SPIKE_INFERENCE,
    steps: SPIKE_STEPS,
    passThreshold: GATE2_PASS_BROADCAST_READY,
    startedAt: new Date().toISOString(),
    renders: {},
    scores: {}
  };

  if (!SCORE_ONLY) {
    await uploadHandlerAndRestartPod();
    for (const [key, def] of Object.entries(GATE2_LINES)) {
      log(`rendering ${key}…`);
      try {
        manifest.renders[key] = await renderLine(key, def);
      } catch (e) {
        log(`❌ render ${key}: ${e.message}`);
        manifest.renders[key] = { error: e.message };
      }
    }
  }

  for (const [key, def] of Object.entries(GATE2_LINES)) {
    const cand = path.join(OUT, `${key}.mp4`);
    const ref = path.join(OUT, `${key}_heygen.mp4`);
    if (!fs.existsSync(cand)) {
      manifest.scores[key] = { error: 'missing candidate mp4 — run render first' };
      continue;
    }
    try {
      await ensureHeygenRef(key, def, ref, apiKey);
    } catch (e) {
      manifest.scores[key] = { error: `HeyGen ref: ${e.message}` };
      continue;
    }
    log(`scoring ${key}…`);
    try {
      manifest.scores[key] = await scorePair(apiKey, cand, ref);
      log(JSON.stringify(manifest.scores[key], null, 2));
    } catch (e) {
      manifest.scores[key] = { error: e.message };
      log(`❌ score ${key}: ${e.message}`);
    }
  }

  const summary = summarizePassFail(manifest.scores, GATE2_PASS_BROADCAST_READY);
  manifest.summary = summary;
  manifest.links = {};
  for (const lineKey of Object.keys(GATE2_LINES)) {
    const cand = path.join(OUT, `${lineKey}.mp4`);
    const ref = path.join(OUT, `${lineKey}_heygen.mp4`);
    manifest.links[lineKey] = {};
    if (fs.existsSync(cand)) {
      try {
        manifest.links[lineKey].em = await uploadGate2Clip(cand, lineKey, 'em');
      } catch (e) {
        log(`warn: upload ${lineKey} em: ${e.message}`);
      }
    }
    if (fs.existsSync(ref)) {
      try {
        manifest.links[lineKey].heygen = await uploadGate2Clip(ref, lineKey, 'heygen');
      } catch (e) {
        log(`warn: upload ${lineKey} heygen: ${e.message}`);
      }
    }
  }
  manifest.completedAt = new Date().toISOString();

  fs.writeFileSync(path.join(OUT, 'gate2_scores.json'), JSON.stringify(manifest.scores, null, 2));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (Object.keys(manifest.links).length) {
    fs.writeFileSync(path.join(OUT, 'links.json'), JSON.stringify(manifest.links, null, 2));
  }

  const md = [
    '# Avatar Gate2 validation (spike profile)',
    '',
    `Generated: ${manifest.completedAt}`,
    `Portrait: \`${manifest.portrait}\``,
    `Pass threshold: overall_broadcast_ready ≥ ${GATE2_PASS_BROADCAST_READY}`,
    '',
    '## Results',
    ...summary.rows.flatMap((r) => {
      if (r.error) return [`- **${r.label}** — FAILED: ${r.error}`];
      const links = manifest.links[r.label] || {};
      const lines = [
        `- **${r.label}** — broadcast_ready=${r.overall_broadcast_ready} motion=${r.motion_naturalness} face=${r.facial_realism} — ${r.pass ? '✅ PASS' : '❌ FAIL'}`
      ];
      if (links.em?.url) lines.push(`  - EchoMimic: [${path.basename(links.em.key)}](${links.em.url})`);
      if (links.heygen?.url) lines.push(`  - HeyGen ref: [${path.basename(links.heygen.key)}](${links.heygen.url})`);
      return lines;
    }),
    '',
    `## Overall: ${summary.allPass ? '✅ PASS' : '❌ FAIL'}`,
    '',
    'Local copies: `output/avatar_gate2/`'
  ];
  fs.writeFileSync(path.join(OUT, 'compare.md'), md.join('\n'));

  log(summary.allPass ? '✅ Gate2 PASS' : '❌ Gate2 FAIL — see output/avatar_gate2/compare.md');
  if (!summary.allPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[gate2] ❌ ${e.message}`);
  process.exitCode = 1;
});
