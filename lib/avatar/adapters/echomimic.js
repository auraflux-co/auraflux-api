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
    // 768x768 is the validated spike resolution. Portrait/landscape framing
    // is a quality-tuning lever (ticket scope), not a v1 switch.
    sampleSize: [768, 768],
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

/**
 * Submit one avatar segment: TTS → R2 → RunPod /run.
 * @returns {Promise<{ videoId: string, status: string }>}
 */
async function submitSegment({ text, title, aspectRatio = '16:9', config, enhancedDelivery = false }) {
  const endpointId = process.env.ECHOMIMIC_ENDPOINT_ID || requiredEnv('RUNPOD_ENDPOINT_ID');
  const runpodKey = requiredEnv('RUNPOD_API_KEY');
  const maxFrames = parseInt(process.env.ECHOMIMIC_MAX_FRAMES || '81', 10);

  const { wavPath, durationSec } = await ttsToWav(text, {
    voiceId: config.voiceId,
    speakSpeed: config.speakSpeed,
    enhancedDelivery
  });

  const maxSec = (maxFrames - 1) / FPS;
  if (durationSec > maxSec + 0.05) {
    fs.unlinkSync(wavPath);
    throw new Error(
      `[echomimic] audio is ${durationSec.toFixed(1)}s but the single-window limit is ${maxSec.toFixed(1)}s ` +
      `(ECHOMIMIC_MAX_FRAMES=${maxFrames}) — segment chunking lands later in CPD-991`
    );
  }

  const segTag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const folder = `avatar/echomimic/${segTag}`;
  const audioKey = `${folder}/speech.wav`;
  try {
    await uploadToR2(wavPath, 'speech.wav', { key: audioKey, contentType: 'audio/wav' });
  } finally {
    fs.unlinkSync(wavPath);
  }

  const outputKey = `${folder}/render.mp4`;
  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(config.avatarId, { method: 'GET' }),
    presignR2(audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const videoLength = framesForDuration(durationSec, maxFrames);
  console.log(`[echomimic] submitting${title ? ` "${title}"` : ''}: ${durationSec.toFixed(1)}s audio → ${videoLength} frames, steps=${config.steps}`);

  const resp = await axios.post(
    `${RUNPOD_BASE}/${endpointId}/run`,
    {
      input: {
        image_url: imageGet,
        audio_url: audioGet,
        output_put_url: outputPut,
        video_length: videoLength,
        num_inference_steps: config.steps,
        sample_size: config.sampleSize,
        fps: FPS
      }
    },
    { headers: { Authorization: `Bearer ${runpodKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const rpJobId = resp.data?.id;
  if (!rpJobId) throw new Error(`RunPod did not return a job id: ${JSON.stringify(resp.data)}`);
  return { videoId: `${rpJobId}::${outputKey}`, status: 'pending' };
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
  _wavDurationSeconds: wavDurationSeconds
};
