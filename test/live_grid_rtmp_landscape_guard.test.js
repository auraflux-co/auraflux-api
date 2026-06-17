'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeEncodePlan } = require('../lib/live_grid/compositor');
const { checkRtmpLandscapeEncode } = require('../lib/live_grid/rtmp_landscape_guard');

test('describeEncodePlan defaults to landscape RTMP when square pad off', () => {
  const origPad = process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD;
  const origHls = process.env.LIVE_GRID_LOCAL_HLS;
  delete process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD;
  process.env.LIVE_GRID_LOCAL_HLS = 'on';
  try {
    const plan = describeEncodePlan({
      output: 'rtmp://a.rtmp.youtube.com/live2/key',
      localHlsPath: '/tmp/preview.m3u8',
    });
    assert.equal(plan.rtmpSquare, false);
    assert.match(plan.rtmp, /1920×1080/);
    assert.equal(plan.localHls, '1920×1080');
  } finally {
    if (origPad === undefined) delete process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD;
    else process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD = origPad;
    if (origHls === undefined) delete process.env.LIVE_GRID_LOCAL_HLS;
    else process.env.LIVE_GRID_LOCAL_HLS = origHls;
  }
});

test('checkRtmpLandscapeEncode blocks square pad when enabled', () => {
  const origPad = process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD;
  const origEnforce = process.env.LIVE_GRID_ENFORCE_LANDSCAPE;
  process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD = 'on';
  process.env.LIVE_GRID_ENFORCE_LANDSCAPE = 'on';
  try {
    const r = checkRtmpLandscapeEncode({
      output: 'rtmp://a.rtmp.youtube.com/live2/key',
      localHlsPath: '/tmp/preview.m3u8',
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /1080×1080/);
  } finally {
    if (origPad === undefined) delete process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD;
    else process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD = origPad;
    if (origEnforce === undefined) delete process.env.LIVE_GRID_ENFORCE_LANDSCAPE;
    else process.env.LIVE_GRID_ENFORCE_LANDSCAPE = origEnforce;
  }
});
