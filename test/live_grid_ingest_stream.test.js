'use strict';

const {
  existingIngestStream,
  allowNewIngestStream,
  resolveIngestForCreate,
  MISSING_INGEST_MSG,
} = require('../lib/live_grid/ingest_stream');

describe('existingIngestStream', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  test('returns pair when RTMP + stream id set', () => {
    process.env.LIVE_GRID_RTMP_URL = 'rtmp://a.rtmp.youtube.com/live2/abc-def';
    process.env.LIVE_GRID_STREAM_ID = 'stream123';
    expect(existingIngestStream()).toEqual({
      streamId: 'stream123',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/abc-def',
    });
  });

  test('opts override env', () => {
    expect(existingIngestStream({
      output: 'rtmp://x/live2/key',
      streamId: 'sid',
    })).toEqual({ streamId: 'sid', rtmpUrl: 'rtmp://x/live2/key' });
  });

  test('null when either field missing', () => {
    delete process.env.LIVE_GRID_RTMP_URL;
    delete process.env.LIVE_GRID_STREAM_ID;
    expect(existingIngestStream()).toBeNull();
    process.env.LIVE_GRID_RTMP_URL = 'rtmp://a/b';
    expect(existingIngestStream()).toBeNull();
  });
});

describe('allowNewIngestStream', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  test('off by default', () => {
    delete process.env.LIVE_GRID_ALLOW_NEW_STREAM;
    expect(allowNewIngestStream()).toBe(false);
  });

  test('createStream:true opts in', () => {
    expect(allowNewIngestStream({ createStream: true })).toBe(true);
  });

  test('env on opts in', () => {
    process.env.LIVE_GRID_ALLOW_NEW_STREAM = 'on';
    expect(allowNewIngestStream()).toBe(true);
  });
});

describe('resolveIngestForCreate', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  test('prefers explicit existingStream', () => {
    expect(resolveIngestForCreate({}, { streamId: 'a', rtmpUrl: 'rtmp://x' })).toEqual({
      streamId: 'a',
      rtmpUrl: 'rtmp://x',
    });
  });

  test('falls back to env', () => {
    process.env.LIVE_GRID_RTMP_URL = 'rtmp://a/b';
    process.env.LIVE_GRID_STREAM_ID = 's1';
    expect(resolveIngestForCreate()).toEqual({ streamId: 's1', rtmpUrl: 'rtmp://a/b' });
  });

  test('throws when missing and create disallowed', () => {
    delete process.env.LIVE_GRID_RTMP_URL;
    delete process.env.LIVE_GRID_STREAM_ID;
    delete process.env.LIVE_GRID_ALLOW_NEW_STREAM;
    expect(() => resolveIngestForCreate()).toThrow(MISSING_INGEST_MSG);
  });

  test('returns null when create allowed', () => {
    delete process.env.LIVE_GRID_RTMP_URL;
    delete process.env.LIVE_GRID_STREAM_ID;
    expect(resolveIngestForCreate({ createStream: true })).toBeNull();
  });
});
