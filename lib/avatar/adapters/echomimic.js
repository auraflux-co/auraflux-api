'use strict';
/**
 * EchoMimicV3-Flash avatar adapter (CPD-991).
 *
 * Two-stage pipeline replacing HeyGen's single call:
 *   1. TTS — ElevenLabs renders the scene text to speech (mp3), converted
 *      locally to 16kHz mono WAV (what the worker's wav2vec2 expects).
 *   2. Render — the WAV + base portrait go to the CPD-990 RunPod serverless
 *      worker via presigned R2 URLs; the worker PUTs the mp4 back to R2.
 *
 * The worker never holds R2 credentials — it only sees presigned URLs.
 *
 * videoId format: `<runpodJobId>::<r2OutputKey>` — composite so status
 * polling survives a server restart (no in-memory job map needed).
 *
 * Env:
 *   ELEVENLABS_API_KEY     TTS auth (required)
 *   ELEVENLABS_VOICE_ID    voice for Bobby G (required)
 *   RUNPOD_API_KEY         RunPod auth (required)
 *   ECHOMIMIC_ENDPOINT_ID  serverless endpoint id (required)
 *   ECHOMIMIC_IMAGE_KEY    R2 key of the base portrait
 *                          (default: the validated spike portrait)
 *   ECHOMIMIC_STEPS        inference steps (default 8 — spike setting;
 *                          quality tuning raises to 15-25)
 *   ECHOMIMIC_MAX_FRAMES   single-window frame cap (default 81 = 3.24s,
 *                          the validated window; chunking is the CPD-991
 *                          follow-up before production cutover)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const { uploadToR2, presignR2 } = require('../../storage');

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
const RUNPOD_BASE = 'https://api.runpod.ai/v2';
const FPS = 25;

function podBaseUrl() {
  const explicit = process.env.ECHOMIMIC_POD_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const podId = process.env.ECHOMIMIC_POD_ID;
  if (podId) return `https://${podId}-8000.proxy.runpod.net`;
  return null;
}

function usePodRender() {
  return String(process.env.ECHOMIMIC_RENDER_MODE || '').toLowerCase() === 'pod' || !!podBaseUrl();
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set in environment (required for echomimic engine)`);
  return v;
}

/**
 * Engine config for a content type + format.
 * Same contract shape as heygen.resolveConfig — avatarId here is the R2 key
 * of the base portrait (the "avatar" is a portrait image, not a HeyGen look).
 */
function resolveConfig({ contentType = 'twitch', format = 'landscape' } = {}) {
  return {
    avatarId: process.env.ECHOMIMIC_IMAGE_KEY || 'spike/cpd881/inputs/bobbyg_studio.png',
    voiceId: requiredEnv('ELEVENLABS_VOICE_ID'),
    speakSpeed: parseFloat(process.env.ECHOMIMIC_SPEAK_SPEED || '1.0'),
    engine: 'echomimic',
    steps: parseInt(process.env.ECHOMIMIC_STEPS || '8', 10),
    // Spike validated 768×768 on a dedicated 24GB+ pod. Serverless can land on
    // ~20GB workers — ECHOMIMIC_SAMPLE_SIZE=512 avoids VAE OOM there.
    sampleSize: (() => {
      const n = parseInt(process.env.ECHOMIMIC_SAMPLE_SIZE || '768', 10);
      return [n, n];
    })(),
    format,
    contentType
  };
}

/** ElevenLabs TTS → local 16kHz mono WAV. Returns { wavPath, durationSec }. */
async function ttsToWav(text, { voiceId, speakSpeed, enhancedDelivery }) {
  const apiKey = requiredEnv('ELEVENLABS_API_KEY');
  // eleven_v3 interprets [bracket] audio tags as delivery direction —
  // same behaviour we previously got via HeyGen's eleven_v3 passthrough.
  const modelId = enhancedDelivery
    ? 'eleven_v3'
    : (process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2');

  const resp = await axios.post(
    `${ELEVENLABS_BASE}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      text,
      model_id: modelId,
      ...(speakSpeed && speakSpeed !== 1.0 ? { voice_settings: { speed: speakSpeed } } : {})
    },
    {
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 120000
    }
  );

  const tmpBase = path.join(os.tmpdir(), `em_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const mp3Path = `${tmpBase}.mp3`;
  const wavPath = `${tmpBase}.wav`;
  fs.writeFileSync(mp3Path, Buffer.from(resp.data));

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
      (err) => err ? reject(new Error(`ffmpeg mp3→wav failed: ${err.message}`)) : resolve());
  });
  fs.unlinkSync(mp3Path);

  return { wavPath, durationSec: wavDurationSeconds(wavPath) };
}

/** Duration of a PCM WAV from its RIFF header (we control the encoding, so this is safe). */
function wavDurationSeconds(wavPath) {
  const fd = fs.openSync(wavPath, 'r');
  try {
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    const byteRate = header.readUInt32LE(28);
    const dataSize = fs.statSync(wavPath).size - 44;
    if (!byteRate) throw new Error('invalid WAV header (byteRate=0)');
    return dataSize / byteRate;
  } finally {
    fs.closeSync(fd);
  }
}

/** Audio duration → Wan-compatible frame count (4n+1), capped at the validated window. */
function framesForDuration(durationSec, maxFrames) {
  const raw = Math.ceil(durationSec * FPS) + 1;
  const snapped = Math.floor((raw - 1) / 4) * 4 + 1;
  return Math.max(25, Math.min(snapped, maxFrames));
}

/** Strip ElevenLabs v3 delivery tags — mirrors what the API removes before synthesis. */
function speakablePlain(text) {
  return String(text || '')
    .replace(/\[[^\]]{1,80}\]/g, ' ')
    .replace(/<break[^>]*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Merge tag-only slices into neighbors so TTS never receives empty speakable input. */
function mergeTagOnlyChunks(chunks) {
  if (!chunks.length) return [];
  const merged = [];
  for (const chunk of chunks) {
    const trimmed = String(chunk || '').trim();
    if (!trimmed) continue;
    if (!speakablePlain(trimmed)) {
      if (merged.length) merged[merged.length - 1] = `${merged[merged.length - 1]} ${trimmed}`.trim();
      continue;
    }
    merged.push(trimmed);
  }
  return merged.filter((c) => speakablePlain(c).length > 0);
}

/** Split spoken text into sentence-aware chunks that fit the EchoMimic window. */
function splitTextIntoSpeechChunks(text, maxSec) {
  const maxWords = Math.max(4, Math.floor(maxSec * 2.2));
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks = [];
  let buf = [];
  let wc = 0;

  const flush = () => {
    if (buf.length) {
      chunks.push(buf.join(' ').trim());
      buf = [];
      wc = 0;
    }
  };

  const wordCount = (s) => {
    const plain = speakablePlain(s);
    return plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  };

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const partWords = wordCount(trimmed);
    if (!partWords) {
      // tag-only sentence fragment — attach to current buffer or next chunk
      if (buf.length) buf.push(trimmed);
      else chunks.push(trimmed);
      continue;
    }
    if (partWords > maxWords) {
      flush();
      const plain = speakablePlain(trimmed);
      const words = plain.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(' '));
      }
      continue;
    }
    if (wc + partWords <= maxWords) {
      buf.push(trimmed);
      wc += partWords;
    } else {
      flush();
      buf.push(trimmed);
      wc = partWords;
    }
  }
  flush();
  return mergeTagOnlyChunks(chunks);
}

function prepareTextChunksForTts(text, maxSec) {
  const raw = splitTextIntoSpeechChunks(text, maxSec);
  const chunks = mergeTagOnlyChunks(raw.length ? raw : [text].filter(Boolean));
  for (let i = 0; i < chunks.length; i++) {
    if (!speakablePlain(chunks[i])) {
      throw new Error(`[echomimic] chunk ${i + 1}/${chunks.length} has no speakable text after tag strip`);
    }
  }
  if (!chunks.length) {
    throw new Error('[echomimic] no speakable text in segment');
  }
  return chunks;
}

function chunkingEnabled() {
  return String(process.env.ECHOMIMIC_CHUNK || 'on').toLowerCase() !== 'off';
}

async function concatMp4Files(inputPaths, outPath) {
  if (!inputPaths.length) throw new Error('[echomimic] concat: no inputs');
  if (inputPaths.length === 1) {
    fs.copyFileSync(inputPaths[0], outPath);
    return;
  }
  const listPath = `${outPath}.concat.txt`;
  fs.writeFileSync(listPath, inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
      (err) => err ? reject(new Error(`ffmpeg concat failed: ${err.message}`)) : resolve());
  });
  try { fs.unlinkSync(listPath); } catch (_e) { /* non-fatal */ }
}

async function downloadUrlToFile(url, outPath) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(outPath, Buffer.from(resp.data));
}

async function renderPodJob(base, jobInput) {
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000
  });
  const jobId = enqueue.data?.job_id;
  if (!jobId) {
    throw new Error(`pod did not return job_id: ${JSON.stringify(enqueue.data).slice(0, 500)}`);
  }

  const pollMs = parseInt(process.env.ECHOMIMIC_POD_POLL_MS || '15000', 10);
  const maxWait = parseInt(process.env.ECHOMIMIC_POD_TIMEOUT_MS || '1800000', 10);
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const st = await axios.get(`${base}/status/${jobId}`, { timeout: 30000 });
      const status = st.data?.status;
      if (status === 'completed') {
        const out = st.data?.result || {};
        if (!out.ok) throw new Error(out.error || 'pod render failed');
        return;
      }
      if (status === 'failed') {
        const out = st.data?.result || {};
        throw new Error(out.error || 'pod render failed');
      }
    } catch (e) {
      // Job file may not exist for a tick after enqueue, or /tmp cleared on pod restart
      if (e.response?.status === 404) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      throw e;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`[echomimic] pod job ${jobId} timed out after ${maxWait}ms`);
}

/** TTS → R2 → render one window; returns R2 output key for the chunk mp4. */
async function renderSpeechWindow({ text, folder, chunkIdx, config, enhancedDelivery, maxFrames, runpodKey }) {
  if (!speakablePlain(text)) {
    throw new Error(`[echomimic] chunk ${chunkIdx ?? 0} has no speakable text — refusing TTS spend`);
  }

  const { wavPath, durationSec } = await ttsToWav(text, {
    voiceId: config.voiceId,
    speakSpeed: config.speakSpeed,
    enhancedDelivery
  });

  const maxSec = (maxFrames - 1) / FPS;
  if (durationSec > maxSec + 0.05) {
    fs.unlinkSync(wavPath);
    throw new Error(
      `[echomimic] chunk ${chunkIdx} audio is ${durationSec.toFixed(1)}s > ${maxSec.toFixed(1)}s window — tighten splitTextIntoSpeechChunks`
    );
  }

  const suffix = chunkIdx == null ? '' : `_c${chunkIdx}`;
  const audioKey = `${folder}/speech${suffix}.wav`;
  try {
    await uploadToR2(wavPath, 'speech.wav', { key: audioKey, contentType: 'audio/wav' });
  } finally {
    fs.unlinkSync(wavPath);
  }

  const outputKey = `${folder}/part${suffix || ''}.mp4`;
  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(config.avatarId, { method: 'GET' }),
    presignR2(audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const jobInput = {
    image_url: imageGet,
    audio_url: audioGet,
    output_put_url: outputPut,
    video_length: framesForDuration(durationSec, maxFrames),
    num_inference_steps: config.steps,
    sample_size: config.sampleSize,
    fps: FPS
  };

  if (usePodRender()) {
    const base = podBaseUrl();
    if (!base) throw new Error('[echomimic] pod mode but no ECHOMIMIC_POD_ID');
    await renderPodJob(base, jobInput);
    return { outputKey, durationSec };
  }

  const endpointId = process.env.ECHOMIMIC_ENDPOINT_ID || requiredEnv('RUNPOD_ENDPOINT_ID');
  const resp = await axios.post(
    `${RUNPOD_BASE}/${endpointId}/run`,
    { input: jobInput },
    { headers: { Authorization: `Bearer ${runpodKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  const rpJobId = resp.data?.id;
  if (!rpJobId) throw new Error(`RunPod did not return a job id: ${JSON.stringify(resp.data)}`);
  return { outputKey, durationSec, rpJobId, pending: true };
}

/**
 * Submit one avatar segment: TTS → R2 → RunPod /run.
 * Long scenes are split into ≤3.24s windows, rendered, and concatenated.
 * @returns {Promise<{ videoId: string, status: string, videoUrl?: string }>}
 */
async function submitSegment({ text, title, aspectRatio = '16:9', config, enhancedDelivery = false }) {
  const runpodKey = requiredEnv('RUNPOD_API_KEY');
  const maxFrames = parseInt(process.env.ECHOMIMIC_MAX_FRAMES || '81', 10);
  const maxSec = (maxFrames - 1) / FPS;
  const segTag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const folder = `avatar/echomimic/${segTag}`;
  const outputKey = `${folder}/render.mp4`;
  const mode = usePodRender() ? 'pod' : 'serverless';

  const textChunks = (chunkingEnabled() && usePodRender())
    ? prepareTextChunksForTts(text, maxSec - 0.15)
    : [text];

  if (textChunks.length > 1) {
    console.log(`[echomimic] chunking${title ? ` "${title}"` : ''}: ${textChunks.length} windows`);
  }

  if (usePodRender()) {
    const { wakePod } = require('../echomimic_pod');
    await wakePod();
  }

  const tmpDir = path.join(os.tmpdir(), `em_seg_${segTag}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const localParts = [];
  let totalSec = 0;
  let pendingJob = null;

  try {
    for (let i = 0; i < textChunks.length; i++) {
      const chunkText = textChunks[i];
      console.log(`[echomimic] window ${i + 1}/${textChunks.length} (${mode})${title ? ` "${title}"` : ''}`);
      const r = await renderSpeechWindow({
        text: chunkText,
        folder,
        chunkIdx: textChunks.length > 1 ? i : null,
        config,
        enhancedDelivery,
        maxFrames,
        runpodKey
      });
      totalSec += r.durationSec || 0;
      if (r.pending) {
        pendingJob = r;
        break;
      }
      const partLocal = path.join(tmpDir, `part_${i}.mp4`);
      const partUrl = await presignR2(r.outputKey, { method: 'GET' });
      await downloadUrlToFile(partUrl, partLocal);
      localParts.push(partLocal);
    }

    if (pendingJob) {
      return { videoId: `${pendingJob.rpJobId}::${pendingJob.outputKey}`, status: 'pending' };
    }

    if (localParts.length === 1 && textChunks.length === 1) {
      console.log(`[echomimic] done (${mode})${title ? ` "${title}"` : ''}: ${totalSec.toFixed(1)}s → ${outputKey}`);
      if (localParts[0] && fs.existsSync(localParts[0])) {
        // single chunk used part key — copy to canonical render.mp4 key
        const combined = path.join(tmpDir, 'render.mp4');
        fs.copyFileSync(localParts[0], combined);
        await uploadToR2(combined, 'render.mp4', { key: outputKey, contentType: 'video/mp4' });
      }
      const videoUrl = await presignR2(outputKey, { method: 'GET' });
      return { videoId: `pod::${outputKey}`, status: 'completed', videoUrl };
    }

    const combined = path.join(tmpDir, 'render.mp4');
    await concatMp4Files(localParts, combined);
    await uploadToR2(combined, 'render.mp4', { key: outputKey, contentType: 'video/mp4' });
    console.log(`[echomimic] concatenated ${localParts.length} windows (${totalSec.toFixed(1)}s) → ${outputKey}`);
    const videoUrl = await presignR2(outputKey, { method: 'GET' });
    return { videoId: `pod::${outputKey}`, status: 'completed', videoUrl };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* non-fatal */ }
  }
}

/**
 * Poll one segment. videoId is `<runpodJobId>::<r2OutputKey>`.
 * @returns {Promise<{ status: string, videoUrl: string|null, failureMessage: string|null }>}
 */
async function getSegmentStatus(videoId) {
  const sep = videoId.indexOf('::');
  if (sep === -1) throw new Error(`[echomimic] malformed videoId (expected rpJobId::outputKey): ${videoId}`);
  const rpJobId = videoId.slice(0, sep);
  const outputKey = videoId.slice(sep + 2);

  if (rpJobId === 'pod') {
    const videoUrl = await presignR2(outputKey, { method: 'GET' });
    return { status: 'completed', videoUrl, failureMessage: null };
  }

  const endpointId = process.env.ECHOMIMIC_ENDPOINT_ID || requiredEnv('RUNPOD_ENDPOINT_ID');
  const runpodKey = requiredEnv('RUNPOD_API_KEY');

  const resp = await axios.get(`${RUNPOD_BASE}/${endpointId}/status/${rpJobId}`, {
    headers: { Authorization: `Bearer ${runpodKey}` },
    timeout: 15000
  });

  const rpStatus = resp.data?.status;
  if (rpStatus === 'COMPLETED') {
    const out = resp.data.output || {};
    if (out.ok === false) {
      return { status: 'failed', videoUrl: null, failureMessage: out.error || 'worker reported failure' };
    }
    const videoUrl = await presignR2(outputKey, { method: 'GET' });
    return { status: 'completed', videoUrl, failureMessage: null };
  }
  if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(rpStatus)) {
    return { status: 'failed', videoUrl: null, failureMessage: resp.data?.error || `RunPod job ${rpStatus}` };
  }
  return { status: 'processing', videoUrl: null, failureMessage: null };
}

module.exports = {
  name: 'echomimic',
  resolveConfig,
  submitSegment,
  getSegmentStatus,
  // exported for tests
  _framesForDuration: framesForDuration,
  _wavDurationSeconds: wavDurationSeconds,
  _splitTextIntoSpeechChunks: splitTextIntoSpeechChunks,
  _speakablePlain: speakablePlain,
  _mergeTagOnlyChunks: mergeTagOnlyChunks,
  _prepareTextChunksForTts: prepareTextChunksForTts
};
