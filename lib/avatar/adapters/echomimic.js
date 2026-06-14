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
 *   ELEVENLABS_VOICE_ID    ElevenLabs voice (optional if DEFAULT set)
 *   ELEVENLABS_DEFAULT_VOICE_ID  fallback when VOICE_ID unset
 *   ECHOMIMIC_AUDIO_SOURCE  'elevenlabs' (default) | 'heygen' | 'auto'
 *   ECHOMIMIC_HEYGEN_AUDIO_FALLBACK  default on — if elevenlabs TTS fails, use HeyGen
 *                          extract (disable when HeyGen account closes)
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
const metrics = require('../echomimic_metrics');
const {
  resolvePortraitKey,
  isHeadPortraitKey
} = require('../echomimic_post');

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

const DEFAULT_PROMPT = (
  'A bearded man in a tan blazer over a black t-shirt sits at a desk in a '
  + 'streaming studio, a purple neon world map glowing on the wall behind him, '
  + 'a broadcast microphone on an arm at frame left. He speaks naturally to the '
  + 'camera with a closed relaxed mouth when silent. Eyes stay fixed on the camera — '
  + 'stable gaze, no eye rolling or darting with head motion. Only the mouth and jaw '
  + 'move during speech. Lip and jaw movement stays anatomically correct — natural teeth, '
  + 'no exaggerated mouth opening. Hands remain below the desk and out of frame — '
  + 'no visible hands, no gestures. Arm and body movements remain minimal. '
  + 'Hand movements remain minimal. Minimal head motion. Preserve background integrity '
  + 'lighting and color temperature.'
);

const HEAD_ONLY_PROMPT = (
  'A bearded man speaks naturally to the camera in a streaming studio. '
  + 'Head and shoulders only — no hands visible in frame. Eyes fixed on camera; '
  + 'gaze stable — do not move eyes when the head shifts slightly. Only mouth and jaw '
  + 'animate during speech. Lip and jaw movement stays anatomically correct — natural teeth, '
  + 'no exaggerated mouth opening. Minimal head motion. '
  + 'Preserve face identity, lighting, and background from the reference image.'
);

const DEFAULT_NEGATIVE_PROMPT = (
  'Gesture is bad. Gesture is unclear. Strange and twisted hands. Bad hands. '
  + 'Bad fingers. Extra fingers, missing fingers, fused fingers. Visible hands, '
  + 'waving hands, pointing gesture, raised hands, hands on desk. '
  + 'Unclear and blurry hands. Unclear gestures, broken hands. '
  + '手部快速摆动, 手指频繁抽搐, 夸张手势, 重复机械性动作. '
  + 'Exaggerated mouth opening. Teeth distortion.'
);

function envTruthy(name, defaultOn = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultOn;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function inferenceTuningFromEnv() {
  const dynamicCfg = envTruthy('ECHOMIMIC_USE_DYNAMIC_CFG', false);
  const portraitKey = resolvePortraitKey();
  const useHead = isHeadPortraitKey(portraitKey);
  const defaultPrompt = useHead ? HEAD_ONLY_PROMPT : DEFAULT_PROMPT;
  return {
    guidanceScale: parseFloat(process.env.ECHOMIMIC_GUIDANCE_SCALE || '4.5'),
    audioGuidanceScale: parseFloat(process.env.ECHOMIMIC_AUDIO_GUIDANCE_SCALE || '2.0'),
    audioScale: parseFloat(process.env.ECHOMIMIC_AUDIO_SCALE || '1.0'),
    seed: parseInt(process.env.ECHOMIMIC_SEED || '43', 10),
    numSkipStartSteps: parseInt(process.env.ECHOMIMIC_SKIP_START_STEPS || '5', 10),
    teacacheThreshold: parseFloat(process.env.ECHOMIMIC_TEACACHE_THRESHOLD || '0.1'),
    useDynamicCfg: dynamicCfg,
    useDynamicAcfg: envTruthy('ECHOMIMIC_USE_DYNAMIC_ACFG', dynamicCfg),
    negScale: parseFloat(process.env.ECHOMIMIC_NEG_SCALE || (dynamicCfg ? '1.5' : '1.2')),
    negSteps: parseInt(process.env.ECHOMIMIC_NEG_STEPS || (dynamicCfg ? '2' : '1'), 10),
    negativePrompt: process.env.ECHOMIMIC_NEGATIVE_PROMPT || DEFAULT_NEGATIVE_PROMPT,
    prompt: process.env.ECHOMIMIC_PROMPT || defaultPrompt,
    headOnlyPrompt: process.env.ECHOMIMIC_HEAD_PROMPT || HEAD_ONLY_PROMPT
  };
}

/** 768 on 24GB+ (4090/L40S); auto 512 on L4 when ECHOMIMIC_SAMPLE_SIZE unset. */
function resolveSampleSizePx() {
  const explicit = process.env.ECHOMIMIC_SAMPLE_SIZE;
  if (explicit != null && explicit !== '') {
    return parseInt(explicit, 10);
  }
  const gpu = String(process.env.ECHOMIMIC_LAST_GPU_TYPE || '');
  if (/L4/i.test(gpu)) return 512;
  // RunPod REST often omits gpuTypeId — L4 EU-RO-1 ~$0.39/hr vs 4090 ~$0.59/hr
  const cost = parseFloat(process.env.ECHOMIMIC_POD_COST_PER_HR || '');
  if (Number.isFinite(cost) && cost > 0 && cost < 0.45) return 512;
  return 768;
}

function buildRenderJobInput({ config, videoLength, imageGet, audioGet, outputPut }) {
  const tune = config.inference || inferenceTuningFromEnv();
  return {
    image_url: imageGet,
    audio_url: audioGet,
    output_put_url: outputPut,
    video_length: videoLength,
    num_inference_steps: config.steps,
    sample_size: config.sampleSize,
    fps: FPS,
    prompt: tune.prompt,
    guidance_scale: tune.guidanceScale,
    audio_guidance_scale: tune.audioGuidanceScale,
    audio_scale: tune.audioScale,
    seed: tune.seed,
    num_skip_start_steps: tune.numSkipStartSteps,
    teacache_threshold: tune.teacacheThreshold,
    use_dynamic_cfg: tune.useDynamicCfg,
    use_dynamic_acfg: tune.useDynamicAcfg,
    neg_scale: tune.negScale,
    neg_steps: tune.negSteps,
    negative_prompt: tune.negativePrompt
  };
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set in environment (required for echomimic engine)`);
  return v;
}

function audioSourceFromEnv() {
  return String(process.env.ECHOMIMIC_AUDIO_SOURCE || 'elevenlabs').toLowerCase();
}

function heygenAudioFallbackEnabled() {
  const src = audioSourceFromEnv();
  if (src === 'heygen') return false;
  if (src === 'auto') return true;
  return !['0', 'false', 'no', 'off'].includes(
    String(process.env.ECHOMIMIC_HEYGEN_AUDIO_FALLBACK || '1').toLowerCase()
  );
}

function resolveElevenLabsVoiceId() {
  const id = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const src = audioSourceFromEnv();
  if (!id && (src === 'elevenlabs' || src === 'auto')) {
    throw new Error('ELEVENLABS_VOICE_ID or ELEVENLABS_DEFAULT_VOICE_ID required for echomimic (elevenlabs audio)');
  }
  return id || null;
}

/**
 * Engine config for a content type + format.
 * Same contract shape as heygen.resolveConfig — avatarId here is the R2 key
 * of the base portrait (the "avatar" is a portrait image, not a HeyGen look).
 */
function resolveConfig({ contentType = 'twitch', format = 'landscape' } = {}) {
  const inference = inferenceTuningFromEnv();
  const avatarId = resolvePortraitKey();
  return {
    avatarId,
    voiceId: resolveElevenLabsVoiceId(),
    audioSource: audioSourceFromEnv(),
    speakSpeed: parseFloat(process.env.ECHOMIMIC_SPEAK_SPEED || '0.85'),
    engine: 'echomimic',
    steps: parseInt(process.env.ECHOMIMIC_STEPS || '8', 10), // spike winner — QA 2026-06-14
    sampleSize: (() => {
      const n = resolveSampleSizePx();
      return [n, n];
    })(),
    inference,
    format,
    contentType
  };
}

/** ElevenLabs TTS → local 16kHz mono WAV. Returns { wavPath, durationSec }. */
async function ttsToWav(text, { voiceId, speakSpeed, enhancedDelivery }) {
  const apiKey = requiredEnv('ELEVENLABS_API_KEY');
  if (!speakablePlain(text)) {
    throw new Error('[echomimic] refusing TTS: no speakable text after delivery-tag strip');
  }
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

/** HeyGen Bobby G render → extract 16kHz mono WAV (no ElevenLabs clone needed). */
async function heygenTextToWav(text, { contentType, format, aspectRatio, enhancedDelivery }) {
  if (!speakablePlain(text)) {
    throw new Error('[echomimic] refusing HeyGen audio: no speakable text after delivery-tag strip');
  }
  const heygen = require('./heygen');
  const hgConfig = heygen.resolveConfig({ contentType, format });
  const { videoId } = await heygen.submitSegment({
    text,
    title: `EM_AUDIO_${Date.now().toString(36)}`,
    aspectRatio: aspectRatio || '16:9',
    config: hgConfig,
    enhancedDelivery
  });

  const maxWait = parseInt(process.env.ECHOMIMIC_HEYGEN_AUDIO_TIMEOUT_MS || '600000', 10);
  const pollMs = parseInt(process.env.ECHOMIMIC_HEYGEN_AUDIO_POLL_MS || '8000', 10);
  const deadline = Date.now() + maxWait;
  let videoUrl = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = await heygen.getSegmentStatus(videoId);
    if (st.status === 'completed' && st.videoUrl) {
      videoUrl = st.videoUrl;
      break;
    }
    if (st.status === 'failed') {
      throw new Error(`[echomimic] HeyGen audio source failed: ${st.failureMessage || 'unknown'}`);
    }
  }
  if (!videoUrl) {
    throw new Error(`[echomimic] HeyGen audio source timed out after ${maxWait}ms (videoId=${videoId})`);
  }

  const tmpBase = path.join(os.tmpdir(), `em_hg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const mp4Path = `${tmpBase}.mp4`;
  const wavPath = `${tmpBase}.wav`;
  try {
    await downloadUrlToFile(videoUrl, mp4Path);
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', mp4Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        (err) => err ? reject(new Error(`ffmpeg HeyGen mp4→wav failed: ${err.message}`)) : resolve());
    });
    return { wavPath, durationSec: wavDurationSeconds(wavPath) };
  } finally {
    try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch (_e) { /* non-fatal */ }
  }
}

async function textToWav(text, opts) {
  const source = opts.config?.audioSource || audioSourceFromEnv();
  const heygenOpts = {
    contentType: opts.config?.contentType,
    format: opts.config?.format,
    aspectRatio: opts.aspectRatio,
    enhancedDelivery: opts.enhancedDelivery
  };

  if (source === 'heygen') {
    return heygenTextToWav(text, heygenOpts);
  }

  try {
    return await ttsToWav(text, {
      voiceId: opts.config.voiceId,
      speakSpeed: opts.config.speakSpeed,
      enhancedDelivery: opts.enhancedDelivery
    });
  } catch (e) {
    if (!heygenAudioFallbackEnabled() || !process.env.HEYGEN_API_KEY) throw e;
    console.warn(`[echomimic] ElevenLabs TTS failed (${e.message}) — HeyGen audio fallback`);
    return heygenTextToWav(text, heygenOpts);
  }
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
    .replace(/<break[^>]*\/?>\s*/gi, ' ')
    .replace(/<break[^>]*>[\s\S]*?<\/break>/gi, ' ')
    .replace(/<break[^>]*$/gi, ' ') // word-split can orphan "<break time=\"0."
    .replace(/<\/break>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTagOnlyChunk(text) {
  return !speakablePlain(text);
}

/** Placeholder-wrap <break/> tags so sentence/word splitters never cut inside them. */
function shieldBreakTags(text) {
  const tags = [];
  const shielded = String(text || '').replace(/<break[^>]*\/?>/gi, (m) => {
    tags.push(m);
    return `\x00B${tags.length - 1}\x00`;
  });
  return { shielded, tags };
}

function unshieldBreakTags(text, tags) {
  return String(text || '').replace(/\x00B(\d+)\x00/g, (_, i) => tags[Number(i)] || '');
}

/** Leading [tags] and <break/> from enhanced delivery text (before speakable words). */
function leadingDeliveryTags(text) {
  let rest = String(text || '').trim();
  const tags = [];
  const tagRe = /^(\[[^\]]{1,80}\]|<break[^>]*\/?>)\s*/i;
  let m;
  while ((m = rest.match(tagRe))) {
    tags.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { prefix: tags.join(' '), rest };
}

/**
 * Merge tag-only slices into speakable neighbors.
 * Backward pass: trailing tags → previous chunk. Forward pass: leading tags → next chunk.
 */
function mergeTagOnlyChunks(chunks) {
  const items = chunks.map((c) => String(c || '').trim()).filter(Boolean);
  if (!items.length) return [];

  const afterBackward = [];
  for (const chunk of items) {
    if (isTagOnlyChunk(chunk) && afterBackward.length && !isTagOnlyChunk(afterBackward[afterBackward.length - 1])) {
      afterBackward[afterBackward.length - 1] = `${afterBackward[afterBackward.length - 1]} ${chunk}`.trim();
    } else {
      afterBackward.push(chunk);
    }
  }

  const merged = [];
  const leading = [];
  for (const chunk of afterBackward) {
    if (isTagOnlyChunk(chunk)) {
      leading.push(chunk);
      continue;
    }
    merged.push(leading.length ? `${leading.join(' ')} ${chunk}`.trim() : chunk);
    leading.length = 0;
  }

  return merged.filter((c) => speakablePlain(c).length > 0);
}

/** Split spoken text into sentence-aware chunks that fit the EchoMimic window. */
function splitTextIntoSpeechChunks(text, maxSec) {
  const { shielded, tags: breakTags } = shieldBreakTags(text);
  const maxWords = Math.max(4, Math.floor(maxSec * 2.2));
  const normalized = shielded.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks = [];
  let buf = [];
  let wc = 0;

  const flush = () => {
    if (buf.length) {
      chunks.push(unshieldBreakTags(buf.join(' ').trim(), breakTags));
      buf = [];
      wc = 0;
    }
  };

  const wordCount = (s) => {
    const plain = speakablePlain(unshieldBreakTags(s, breakTags));
    return plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  };

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const partWords = wordCount(trimmed);
    if (!partWords) {
      if (buf.length) buf.push(trimmed);
      else chunks.push(unshieldBreakTags(trimmed, breakTags));
      continue;
    }
    if (partWords > maxWords) {
      flush();
      const unshielded = unshieldBreakTags(trimmed, breakTags);
      const { prefix, rest } = leadingDeliveryTags(unshielded);
      const breaks = (rest.match(/<break[^>]*\/?>/gi) || []);
      const restNoBreaks = rest.replace(/<break[^>]*\/?>\s*/gi, ' ');
      const plain = speakablePlain(restNoBreaks || unshielded);
      const words = plain.split(/\s+/).filter(Boolean);
      const built = [];
      for (let i = 0; i < words.length; i += maxWords) {
        built.push(words.slice(i, i + maxWords).join(' '));
      }
      if (breaks.length && built.length) {
        built[built.length - 1] = `${built[built.length - 1]} ${breaks.join(' ')}`.trim();
      }
      for (let i = 0; i < built.length; i++) {
        chunks.push(i === 0 && prefix ? `${prefix} ${built[i]}`.trim() : built[i]);
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

async function probeMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ], (err, stdout) => {
      if (err) reject(err);
      else resolve(parseFloat(String(stdout).trim()) || 0);
    });
  });
}

async function xfadePair(leftPath, rightPath, outPath, durationSec) {
  const d0 = await probeMediaDuration(leftPath);
  const offset = Math.max(0.05, d0 - durationSec);
  const filter = `[0:v][1:v]xfade=transition=fade:duration=${durationSec}:offset=${offset.toFixed(3)}[v];`
    + `[0:a][1:a]acrossfade=d=${durationSec}[a]`;
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', leftPath, '-i', rightPath,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      outPath
    ], (err) => (err ? reject(new Error(`xfade failed: ${err.message}`)) : resolve()));
  });
}

async function concatMp4WithCrossfade(inputPaths, outPath) {
  const xfadeSec = parseFloat(process.env.ECHOMIMIC_CHUNK_XFADE_SEC || '0.12');
  const xfadeOff = String(process.env.ECHOMIMIC_CHUNK_XFADE || 'on').toLowerCase() === 'off';
  if (inputPaths.length <= 1 || xfadeOff || !(xfadeSec > 0)) {
    return concatMp4Files(inputPaths, outPath);
  }
  let current = inputPaths[0];
  const tmpDir = path.dirname(outPath);
  for (let i = 1; i < inputPaths.length; i++) {
    const isLast = i === inputPaths.length - 1;
    const nextOut = isLast ? outPath : path.join(tmpDir, `_xfade_${i}_${Date.now()}.mp4`);
    await xfadePair(current, inputPaths[i], nextOut, xfadeSec);
    if (current !== inputPaths[0] && fs.existsSync(current)) {
      try { fs.unlinkSync(current); } catch (_e) { /* non-fatal */ }
    }
    current = nextOut;
  }
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
  const elapsed = metrics.startTimer();
  metrics.record('render_start', {
    steps: jobInput.num_inference_steps,
    videoLength: jobInput.video_length,
    gpuType: process.env.ECHOMIMIC_LAST_GPU_TYPE || null
  });
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000
  });
  const jobId = enqueue.data?.job_id;
  if (!jobId) {
    metrics.record('render_fail', { durationMs: elapsed(), error: 'no job_id', phase: 'enqueue' });
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
        if (!out.ok) {
          metrics.record('render_fail', {
            durationMs: elapsed(),
            error: out.error || 'pod render failed',
            phase: 'infer',
            logTail: String(out.log_tail || '').slice(-200)
          });
          throw new Error(out.error || 'pod render failed');
        }
        metrics.record('render_ok', {
          durationMs: elapsed(),
          renderSeconds: out.render_seconds || null,
          steps: jobInput.num_inference_steps,
          videoLength: jobInput.video_length
        });
        return;
      }
      if (status === 'failed') {
        const out = st.data?.result || {};
        metrics.record('render_fail', {
          durationMs: elapsed(),
          error: out.error || 'pod render failed',
          phase: 'infer'
        });
        throw new Error(out.error || 'pod render failed');
      }
    } catch (e) {
      if (e.response?.status === 404) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (!String(e.message).includes('pod render failed')) {
        metrics.record('render_fail', { durationMs: elapsed(), error: e.message, phase: 'poll' });
      }
      throw e;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  metrics.record('render_fail', { durationMs: elapsed(), error: 'timeout', phase: 'poll' });
  throw new Error(`[echomimic] pod job ${jobId} timed out after ${maxWait}ms`);
}

/** Speech → R2 → render one window; returns R2 output key for the chunk mp4. */
async function renderSpeechWindow({ text, folder, chunkIdx, config, enhancedDelivery, maxFrames, runpodKey, aspectRatio }) {
  if (!speakablePlain(text)) {
    throw new Error(`[echomimic] chunk ${chunkIdx ?? 0} has no speakable text — refusing audio spend`);
  }

  const audioSource = config.audioSource || audioSourceFromEnv();
  if (audioSource === 'heygen') {
    console.log(`[echomimic] audio source: heygen${chunkIdx != null ? ` chunk ${chunkIdx}` : ''}`);
  } else if (heygenAudioFallbackEnabled() && process.env.HEYGEN_API_KEY) {
    console.log(`[echomimic] audio source: elevenlabs (heygen fallback armed)${chunkIdx != null ? ` chunk ${chunkIdx}` : ''}`);
  }

  const { wavPath, durationSec } = await textToWav(text, {
    config,
    aspectRatio,
    enhancedDelivery
  });

  const maxSec = (maxFrames - 1) / FPS;
  let fitSec = durationSec;
  if (durationSec > maxSec + 0.05) {
    if (enhancedDelivery || durationSec <= maxSec + 0.9) {
      const trimmed = `${wavPath}.trim.wav`;
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-y', '-i', wavPath, '-t', String(maxSec - 0.02),
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', trimmed
        ], (err) => (err ? reject(new Error(`wav trim failed: ${err.message}`)) : resolve()));
      });
      fs.unlinkSync(wavPath);
      fs.renameSync(trimmed, wavPath);
      fitSec = wavDurationSeconds(wavPath);
      console.log(`[echomimic] trimmed chunk ${chunkIdx ?? 0} audio ${durationSec.toFixed(1)}s → ${fitSec.toFixed(1)}s`);
    } else {
      fs.unlinkSync(wavPath);
      throw new Error(
        `[echomimic] chunk ${chunkIdx} audio is ${durationSec.toFixed(1)}s > ${maxSec.toFixed(1)}s window — tighten splitTextIntoSpeechChunks`
      );
    }
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

  const jobInput = buildRenderJobInput({
    config,
    videoLength: framesForDuration(durationSec, maxFrames),
    imageGet,
    audioGet,
    outputPut
  });

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
    ? prepareTextChunksForTts(text, maxSec - (enhancedDelivery ? 0.35 : 0.15))
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
        runpodKey,
        aspectRatio
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
    await concatMp4WithCrossfade(localParts, combined);
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
  _prepareTextChunksForTts: prepareTextChunksForTts,
  buildRenderJobInput,
  inferenceTuningFromEnv,
  resolveSampleSizePx
};
