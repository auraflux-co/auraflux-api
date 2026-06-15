'use strict';
/**
 * CPD-991 — EchoMimic adapter tests.
 * TTS→R2→RunPod submit handshake, status mapping, frame math, window cap.
 * ElevenLabs/RunPod HTTP and R2 storage are mocked; ffmpeg conversion is
 * bypassed by mocking ttsToWav's collaborators at module boundaries.
 */

jest.mock('axios');
jest.mock('../lib/storage', () => ({
  uploadToR2: jest.fn().mockResolvedValue('https://r2/avatar/echomimic/x/speech.wav'),
  presignR2: jest.fn(async (key, opts = {}) => `https://presigned/${(opts.method || 'GET').toLowerCase()}/${key}`)
}));

const axios = require('axios');
const storage = require('../lib/storage');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const echomimic = require('../lib/avatar/adapters/echomimic');
const avatar = require('../lib/avatar');

const ENV_KEYS = [
  'AVATAR_ENGINE', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_DEFAULT_VOICE_ID',
  'ELEVENLABS_MODEL', 'ECHOMIMIC_AUDIO_SOURCE',
  'RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID', 'ECHOMIMIC_ENDPOINT_ID', 'ECHOMIMIC_IMAGE_KEY',
  'ECHOMIMIC_STEPS', 'ECHOMIMIC_MAX_FRAMES', 'ECHOMIMIC_SPEAK_SPEED', 'ECHOMIMIC_PORTRAIT',
  'ECHOMIMIC_PROFILE', 'ECHOMIMIC_USE_DYNAMIC_CFG', 'ECHOMIMIC_CHUNK'
];
let envBackup;

/** Write a minimal valid PCM WAV header + silence of the given duration. */
function makeWav(durationSec, sampleRate = 16000) {
  const byteRate = sampleRate * 2; // mono 16-bit
  const dataSize = Math.round(durationSec * byteRate);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  const p = path.join(os.tmpdir(), `em_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(p, buf);
  return p;
}

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
  process.env.ELEVENLABS_API_KEY = 'el-key';
  process.env.ELEVENLABS_VOICE_ID = 'el-voice';
  process.env.ECHOMIMIC_AUDIO_SOURCE = 'elevenlabs';
  process.env.RUNPOD_API_KEY = 'rp-key';
  process.env.ECHOMIMIC_ENDPOINT_ID = 'ep-1';
  process.env.ECHOMIMIC_STEPS = '8';
  jest.clearAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('frame math', () => {
  test('snaps to 4n+1 and caps at maxFrames', () => {
    // 2.0s * 25fps = 50 + 1 = 51 → snap down to 49 (4*12+1)
    expect(echomimic._framesForDuration(2.0, 81)).toBe(49);
    // 3.24s fills the validated window exactly
    expect(echomimic._framesForDuration(3.24, 81)).toBe(81);
    // over-long audio caps at the window
    expect(echomimic._framesForDuration(10, 81)).toBe(81);
    // tiny audio floors at 25 frames (1s)
    expect(echomimic._framesForDuration(0.1, 81)).toBe(25);
  });
});

describe('wav duration', () => {
  test('reads duration from RIFF header', () => {
    const p = makeWav(2.5);
    try {
      expect(echomimic._wavDurationSeconds(p)).toBeCloseTo(2.5, 1);
    } finally { fs.unlinkSync(p); }
  });
});

describe('resolveConfig', () => {
  test('defaults to spike profile — bobbyg_studio portrait, 8 steps, neg_scale 1.0', () => {
    process.env.ECHOMIMIC_PROFILE = 'spike';
    const cfg = echomimic.resolveConfig({ contentType: 'twitch', format: 'landscape' });
    expect(cfg.avatarId).toBe('spike/cpd881/inputs/bobbyg_studio.png');
    expect(cfg.steps).toBe(8);
    expect(cfg.inference.negScale).toBe(1.0);
    expect(cfg.inference.negSteps).toBe(0);
    expect(cfg.inference.useDynamicCfg).toBe(false);
    expect(cfg.inference.prompt).toMatch(/Hand and body movements are minimal/);
  });

  test('env overrides image key and steps', () => {
    process.env.ECHOMIMIC_IMAGE_KEY = 'portraits/bobby_v2.png';
    process.env.ECHOMIMIC_STEPS = '20';
    const cfg = echomimic.resolveConfig({});
    expect(cfg.avatarId).toBe('portraits/bobby_v2.png');
    expect(cfg.steps).toBe(20);
  });

  test('missing ELEVENLABS_VOICE_ID throws when elevenlabs audio', () => {
    delete process.env.ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    process.env.ECHOMIMIC_AUDIO_SOURCE = 'elevenlabs';
    expect(() => echomimic.resolveConfig({})).toThrow(/ELEVENLABS_VOICE_ID/);
  });

  test('heygen audio source does not require ElevenLabs voice id', () => {
    delete process.env.ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    process.env.ECHOMIMIC_AUDIO_SOURCE = 'heygen';
    const cfg = echomimic.resolveConfig({});
    expect(cfg.audioSource).toBe('heygen');
    expect(cfg.voiceId).toBeNull();
  });

  test('falls back to ELEVENLABS_DEFAULT_VOICE_ID', () => {
    delete process.env.ELEVENLABS_VOICE_ID;
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = 'default-voice';
    expect(echomimic.resolveConfig({}).voiceId).toBe('default-voice');
  });
});

describe('getSegmentStatus', () => {
  test('COMPLETED with ok output presigns the output key', async () => {
    axios.get.mockResolvedValue({ data: { status: 'COMPLETED', output: { ok: true } } });
    const s = await echomimic.getSegmentStatus('rp-job-1::avatar/echomimic/x/render.mp4');
    expect(s.status).toBe('completed');
    expect(s.videoUrl).toBe('https://presigned/get/avatar/echomimic/x/render.mp4');
    expect(axios.get.mock.calls[0][0]).toBe('https://api.runpod.ai/v2/ep-1/status/rp-job-1');
  });

  test('COMPLETED with worker-reported failure maps to failed', async () => {
    axios.get.mockResolvedValue({ data: { status: 'COMPLETED', output: { ok: false, error: 'infer_flash.py exit 1' } } });
    const s = await echomimic.getSegmentStatus('rp-job-1::k/render.mp4');
    expect(s.status).toBe('failed');
    expect(s.failureMessage).toMatch(/infer_flash/);
  });

  test('FAILED maps to failed', async () => {
    axios.get.mockResolvedValue({ data: { status: 'FAILED', error: 'OOM' } });
    const s = await echomimic.getSegmentStatus('rp-job-1::k/render.mp4');
    expect(s.status).toBe('failed');
    expect(s.failureMessage).toBe('OOM');
  });

  test('IN_QUEUE / IN_PROGRESS map to processing', async () => {
    axios.get.mockResolvedValue({ data: { status: 'IN_PROGRESS' } });
    const s = await echomimic.getSegmentStatus('rp-job-1::k/render.mp4');
    expect(s.status).toBe('processing');
  });

  test('malformed videoId throws', async () => {
    await expect(echomimic.getSegmentStatus('no-separator')).rejects.toThrow(/malformed videoId/);
  });

  test('core normalises RunPod API errors with engine name', async () => {
    const apiErr = new Error('Request failed with status code 401');
    apiErr.response = { status: 401, data: { error: 'bad key' } };
    axios.get.mockRejectedValue(apiErr);
    await expect(avatar.getSegmentStatus('rp-job-1::k/render.mp4', { engine: 'echomimic' }))
      .rejects.toThrow(/\[avatar:echomimic\] status failed/);
  });
});

describe('speech chunking', () => {
  test('mergeTagOnlyChunks attaches trailing tag-only to previous chunk', () => {
    const merged = echomimic._mergeTagOnlyChunks(['Hello world.', '[excited]', 'Next line.']);
    expect(merged).toEqual(['Hello world. [excited]', 'Next line.']);
  });

  test('mergeTagOnlyChunks attaches leading tag-only to next chunk', () => {
    const merged = echomimic._mergeTagOnlyChunks(['[excited]', 'Jason was surrounded by fans.']);
    expect(merged).toEqual(['[excited] Jason was surrounded by fans.']);
  });

  test('mergeTagOnlyChunks handles trailing run of tag-only slices', () => {
    const merged = echomimic._mergeTagOnlyChunks(['Hello.', '[beat]', '[pause]']);
    expect(merged).toEqual(['Hello. [beat] [pause]']);
  });

  test('mergeTagOnlyChunks drops orphan tag-only with no speakable neighbor', () => {
    expect(echomimic._mergeTagOnlyChunks(['[beat]', '[pause]'])).toEqual([]);
  });

  test('prepareTextChunksForTts rejects chunks with no speakable text', () => {
    expect(() => echomimic._prepareTextChunksForTts('[pause]', 3)).toThrow(/no speakable text/);
  });

  test('prepareTextChunksForTts keeps delivery tags when speakable words remain', () => {
    const chunks = echomimic._prepareTextChunksForTts('[excited] Jason just dropped a bomb.', 3);
    expect(chunks.length).toBeGreaterThan(0);
    expect(echomimic._speakablePlain(chunks[0])).toMatch(/Jason/);
  });

  test('prepareTextChunksForTts preserves leading tags on first window of long sentence', () => {
    const long = '[curious] ' + 'word '.repeat(20).trim() + '.';
    const chunks = echomimic._prepareTextChunksForTts(long, 3);
    expect(chunks[0]).toMatch(/^\[curious\]/);
    expect(echomimic._speakablePlain(chunks[0])).toMatch(/word/);
  });

  test('prepareTextChunksForTts does not split <break/> tags across word windows', () => {
    const text = 'Jason was surrounded by fans, many wearing United States flag apparel. <break time="0.5s"/> He found himself face-to-face with a fellow internet personality.';
    const maxSec = (81 - 1) / 25 - 0.15;
    const chunks = echomimic._prepareTextChunksForTts(text, maxSec);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^<break time="0\.$/);
      expect(echomimic._speakablePlain(chunk).length).toBeGreaterThan(0);
    }
    expect(chunks.some((c) => c.includes('<break time="0.5s"/>'))).toBe(true);
  });
});

describe('submitSegment', () => {
  // ttsToWav shells out to ffmpeg; stub the ElevenLabs response and ffmpeg
  // by mocking axios.post for TTS (arraybuffer) then intercepting execFile via
  // a pre-made wav: easiest is to spy on the module's ttsToWav path indirectly —
  // instead we mock axios.post twice (TTS, RunPod) and replace ffmpeg work by
  // having the test write the wav where the adapter expects it. Since that is
  // brittle, we instead only verify the over-long-audio guard which fails
  // before any RunPod call, using a real ffmpeg-produced wav when available.

  test('rejects audio longer than the single-window cap before any RunPod spend', async () => {
    // 10s of "speech" — ElevenLabs mock returns a real 10s wav as mp3 stand-in;
    // ffmpeg will faithfully convert pcm→pcm.
    const longWav = makeWav(10);
    const mp3Bytes = fs.readFileSync(longWav);
    fs.unlinkSync(longWav);
    axios.post.mockResolvedValueOnce({ data: mp3Bytes }); // TTS call

    const config = echomimic.resolveConfig({});
    await expect(echomimic.submitSegment({ text: 'long monologue', config }))
      .rejects.toThrow(/window/);
    // RunPod /run must never have been called
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(storage.uploadToR2).not.toHaveBeenCalled();
  }, 20000);

  test('happy path: uploads wav, presigns three URLs, submits to RunPod', async () => {
    const shortWav = makeWav(2.0);
    const bytes = fs.readFileSync(shortWav);
    fs.unlinkSync(shortWav);
    axios.post
      .mockResolvedValueOnce({ data: bytes }) // ElevenLabs TTS
      .mockResolvedValueOnce({ data: { id: 'rp-abc', status: 'IN_QUEUE' } }); // RunPod /run

    const config = echomimic.resolveConfig({});
    config.inference = { ...config.inference }; // ensure spike path
    process.env.ECHOMIMIC_PROFILE = 'spike';
    const r = await echomimic.submitSegment({ text: 'short hook', title: '00 INTRO', config });

    expect(r.status).toBe('pending');
    expect(r.videoId).toMatch(/^rp-abc::avatar\/echomimic\/.+\/part\.mp4$/);

    // wav uploaded with exact key
    const [, , upOpts] = storage.uploadToR2.mock.calls[0];
    expect(upOpts.key).toMatch(/^avatar\/echomimic\/.+\/speech\.wav$/);
    expect(upOpts.contentType).toBe('audio/wav');

    // RunPod call shape
    const [url, body, opts] = axios.post.mock.calls[1];
    expect(url).toBe('https://api.runpod.ai/v2/ep-1/run');
    expect(body.input.image_url).toContain('presigned/get/spike/cpd881/inputs/bobbyg_studio.png');
    expect(body.input.neg_scale).toBe(1.0);
    expect(body.input.neg_steps).toBe(0);
    expect(body.input.audio_url).toContain('presigned/get/avatar/echomimic/');
    expect(body.input.output_put_url).toContain('presigned/put/avatar/echomimic/');
    expect(body.input.video_length).toBe(49); // 2.0s → 49 frames (4n+1)
    expect(body.input.num_inference_steps).toBe(8);
    expect(body.input.audio_guidance_scale).toBe(2.0);
    expect(body.input.guidance_scale).toBe(4.5);
    expect(opts.headers.Authorization).toBe('Bearer rp-key');
  }, 20000);

  test('TTS uses eleven_v3 when enhancedDelivery', async () => {
    const wav = makeWav(1.0);
    const bytes = fs.readFileSync(wav);
    fs.unlinkSync(wav);
    axios.post
      .mockResolvedValueOnce({ data: bytes })
      .mockResolvedValueOnce({ data: { id: 'rp-x' } });

    const config = echomimic.resolveConfig({});
    await echomimic.submitSegment({ text: '[excited] hi', config, enhancedDelivery: true });

    const [ttsUrl, ttsBody] = axios.post.mock.calls[0];
    expect(ttsUrl).toContain('api.elevenlabs.io/v1/text-to-speech/el-voice');
    expect(ttsBody.model_id).toBe('eleven_v3');
  }, 20000);
});
