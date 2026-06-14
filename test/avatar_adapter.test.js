'use strict';
/**
 * CPD-989 — avatar adapter layer contract tests.
 * Core: engine selection, error normalisation, waitForSegment polling.
 * HeyGen adapter: request body shape, config resolution fallbacks.
 */

jest.mock('axios');
const axios = require('axios');

const avatar = require('../lib/avatar');
const heygen = require('../lib/avatar/adapters/heygen');

const ENV_KEYS = [
  'AVATAR_ENGINE', 'HEYGEN_API_KEY', 'HEYGEN_VOICE_ID', 'HEYGEN_AVATAR_ID',
  'HEYGEN_AVATAR_SHORT_ID', 'HEYGEN_AVATAR_SHORT_NBA_ID', 'HEYGEN_SPEAK_SPEED', 'HEYGEN_ENGINE'
];
let envBackup;

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
  process.env.HEYGEN_API_KEY = 'test-key';
  process.env.HEYGEN_VOICE_ID = 'voice-1';
  jest.clearAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('core engine selection', () => {
  test('defaults to heygen', () => {
    expect(avatar.resolveEngine().name).toBe('heygen');
  });

  test('AVATAR_ENGINE env selects the engine', () => {
    process.env.AVATAR_ENGINE = 'heygen';
    expect(avatar.resolveEngine().name).toBe('heygen');
  });

  test('explicit argument overrides env', () => {
    process.env.AVATAR_ENGINE = 'nonsense';
    expect(avatar.resolveEngine('heygen').name).toBe('heygen');
  });

  test('echomimic is a registered engine (CPD-991)', () => {
    expect(avatar.resolveEngine('echomimic').name).toBe('echomimic');
  });

  test('unknown engine throws with available list', () => {
    expect(() => avatar.resolveEngine('d-id')).toThrow(/Unknown avatar engine 'd-id'.*heygen.*echomimic/);
  });
});

describe('heygen adapter — submitSegment', () => {
  test('builds the v3 request body and returns videoId', async () => {
    axios.post.mockResolvedValue({ data: { data: { video_id: 'vid-123', status: 'pending' } } });

    const result = await avatar.submitSegment({
      text: 'Hello world',
      title: '00 INTRO',
      aspectRatio: '16:9',
      config: { avatarId: 'av-1', voiceId: 'voice-1', speakSpeed: 0.85, engine: 'avatar_v' }
    });

    expect(result).toEqual({ videoId: 'vid-123', status: 'pending' });
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.heygen.com/v3/videos');
    expect(body).toMatchObject({
      type: 'avatar',
      avatar_id: 'av-1',
      title: '00 INTRO',
      script: 'Hello world',
      voice_id: 'voice-1',
      voice_settings: { speed: 0.85 },
      resolution: '1080p',
      aspect_ratio: '16:9',
      engine: { type: 'avatar_v' }
    });
    expect(body.voice_settings.engine_settings).toBeUndefined();
    expect(opts.headers['X-Api-Key']).toBe('test-key');
  });

  test('enhancedDelivery switches voice engine to eleven_v3', async () => {
    axios.post.mockResolvedValue({ data: { data: { video_id: 'vid-456', status: 'pending' } } });

    await avatar.submitSegment({
      text: '[excited] Hello',
      aspectRatio: '9:16',
      config: { avatarId: 'av-1', voiceId: 'voice-1', speakSpeed: 0.85, engine: 'avatar_v' },
      enhancedDelivery: true
    });

    const body = axios.post.mock.calls[0][1];
    expect(body.voice_settings.engine_settings).toEqual({ engine_type: 'elevenlabs', model: 'eleven_v3' });
    expect(body.aspect_ratio).toBe('9:16');
  });

  test('missing video_id in response throws', async () => {
    axios.post.mockResolvedValue({ data: { error: 'quota' } });
    await expect(avatar.submitSegment({
      text: 'x', config: { avatarId: 'a', voiceId: 'v', speakSpeed: 0.85, engine: 'avatar_v' }
    })).rejects.toThrow(/did not return video_id/);
  });

  test('API error is normalised with engine name and response body', async () => {
    const apiErr = new Error('Request failed with status code 400');
    apiErr.response = { status: 400, data: { code: 'invalid_avatar' } };
    axios.post.mockRejectedValue(apiErr);

    await expect(avatar.submitSegment({
      text: 'x', config: { avatarId: 'a', voiceId: 'v', speakSpeed: 0.85, engine: 'avatar_v' }
    })).rejects.toThrow(/\[avatar:heygen\] submit failed:.*invalid_avatar/);
  });
});

describe('heygen adapter — getSegmentStatus', () => {
  test('maps completed status with video url', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'completed', video_url: 'https://cdn/x.mp4' } } });
    const s = await avatar.getSegmentStatus('vid-123');
    expect(s).toEqual({ status: 'completed', videoUrl: 'https://cdn/x.mp4', failureMessage: null });
    expect(axios.get.mock.calls[0][0]).toBe('https://api.heygen.com/v3/videos/vid-123');
  });

  test('maps failed status with failure message', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'failed', failure_message: 'render error' } } });
    const s = await avatar.getSegmentStatus('vid-123');
    expect(s.status).toBe('failed');
    expect(s.failureMessage).toBe('render error');
  });
});

describe('core waitForSegment', () => {
  test('resolves when segment completes', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { data: { status: 'processing' } } })
      .mockResolvedValueOnce({ data: { data: { status: 'completed', video_url: 'https://cdn/done.mp4' } } });

    const r = await avatar.waitForSegment('vid-1', { pollIntervalMs: 1, maxWaitMs: 5000 });
    expect(r.videoUrl).toBe('https://cdn/done.mp4');
  });

  test('throws on failed render', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'failed', failure_message: 'boom' } } });
    await expect(avatar.waitForSegment('vid-1', { pollIntervalMs: 1, maxWaitMs: 5000, label: 'SCENE_X' }))
      .rejects.toThrow(/SCENE_X: boom/);
  });

  test('times out when never completing', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'processing' } } });
    await expect(avatar.waitForSegment('vid-1', { pollIntervalMs: 5, maxWaitMs: 30 }))
      .rejects.toThrow(/timed out/);
  });
});

describe('heygen adapter — resolveConfig', () => {
  test('falls back to env vars for unknown content type', () => {
    process.env.HEYGEN_AVATAR_ID = 'env-landscape';
    process.env.HEYGEN_AVATAR_SHORT_ID = 'env-short';
    process.env.HEYGEN_SPEAK_SPEED = '0.9';

    const landscape = heygen.resolveConfig({ contentType: 'totally-unknown', format: 'landscape' });
    expect(landscape.avatarId).toBe('env-landscape');
    expect(landscape.speakSpeed).toBe(0.9);
    expect(landscape.engine).toBe('avatar_v');

    const portrait = heygen.resolveConfig({ contentType: 'totally-unknown', format: 'portrait' });
    expect(portrait.avatarId).toBe('env-short');
  });

  test('per-type short avatar fallback applies when no generic short id is set', () => {
    process.env.HEYGEN_AVATAR_SHORT_NBA_ID = 'nba-short';
    const cfg = heygen.resolveConfig({ contentType: 'nba-short-unknown', format: 'portrait' });
    expect(cfg.avatarId).toBe('nba-short');
  });

  test('HEYGEN_ENGINE env overrides default engine', () => {
    process.env.HEYGEN_ENGINE = 'avatar_iv';
    process.env.HEYGEN_AVATAR_ID = 'a';
    const cfg = heygen.resolveConfig({ contentType: 'totally-unknown', format: 'landscape' });
    expect(cfg.engine).toBe('avatar_iv');
  });
});
