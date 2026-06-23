'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaimsCsv, youtubeVideoId } = require('../lib/post_live/claims_csv');
const { timeToSec, mergeRanges, analyzableWindows, mapMuteRangesToClip } = require('../lib/post_live/time_ranges');

test('youtubeVideoId parses watch URLs', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('parseClaimsCsv groups claim rows by video', () => {
  const csv = [
    'title,url,streamer,claim_start,claim_end,action',
    'Plaqueboymax LIVE,https://www.youtube.com/watch?v=abc123xyz01,plaqueboymax,12:34,13:10,exclude',
    'Plaqueboymax LIVE,https://www.youtube.com/watch?v=abc123xyz01,plaqueboymax,45:00,45:40,mute',
  ].join('\n');
  const { sessions, errors } = parseClaimsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].excludeRanges.length, 1);
  assert.equal(sessions[0].muteRanges.length, 1);
  assert.equal(sessions[0].excludeRanges[0].start, timeToSec('12:34'));
});

test('parseClaimsCsv accepts VOD-only row without claims', () => {
  const csv = 'title,url,streamer\nSolo Live,https://youtu.be/abc123xyz01,marlon\n';
  const { sessions } = parseClaimsCsv(csv);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].excludeRanges.length, 0);
});

test('analyzableWindows skips excluded ranges', () => {
  const windows = analyzableWindows(0, 600, [{ start: 100, end: 200 }]);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].end, 100);
  assert.equal(windows[1].start, 200);
});

test('mergeRanges combines overlapping intervals', () => {
  const merged = mergeRanges([
    { start: 10, end: 20 },
    { start: 18, end: 30 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, 30);
});

test('mapMuteRangesToClip converts VOD timestamps to clip-local mute windows', () => {
  const local = mapMuteRangesToClip([{ start: 3740, end: 3750 }], 3720, 3780);
  assert.equal(local.length, 1);
  assert.equal(local[0].start, 20);
  assert.equal(local[0].end, 30);
});
