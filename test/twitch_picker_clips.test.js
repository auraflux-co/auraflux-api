'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('fetchTwitchClips uses clip_pub_window for helix started_at/ended_at', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../lib/pickers/streamers/adapters/twitch.js'),
    'utf8',
  );
  assert.match(src, /resolveClipPubWindow/);
  assert.match(src, /if \(startedAt\) params\.set\('started_at', startedAt\)/);
  assert.match(src, /if \(endedAt\) params\.set\('ended_at', endedAt\)/);
});

test('fetchStreamerPickerClips does not force 24h when pubHours is null', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/pickers/streamers/index.js'), 'utf8');
  assert.match(src, /pubHours: pubHours != null \? pubHours : null/);
  assert.doesNotMatch(src, /pubHours: pubHours \|\| 24/);
});

test('library clip fetch exposes popular/recent sort toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, '../cwn_production.html'), 'utf8');
  assert.match(html, /function getLibraryClipSort\(/);
  assert.match(html, /setLibraryClipSort\('popular'\)/);
  assert.match(html, /clipSort=' \+ encodeURIComponent\(getLibraryClipSort\(\)\)/);
  assert.match(html, /id="library-clip-sort"/);
});

// CPD-1219 — competitor echo badge on prediction pill + CPD-1218 accuracy panel
test('dashboard wires competitor echo badge and prediction accuracy panel', () => {
  const html = fs.readFileSync(path.join(__dirname, '../cwn_production.html'), 'utf8');
  // echo badge painted from prediction.competitorEcho with short view count
  assert.match(html, /prediction\.competitorEcho/);
  assert.match(html, /_fmtViewsShort\(echo\.views\)/);
  // accuracy panel fetches the new endpoint and renders verdicts
  assert.match(html, /\/intelligence\/prediction-accuracy/);
  assert.match(html, /id="intel-acc-body"/);
  assert.match(html, /UNDER — went bigger/);
  // phase 2 button posts to streamer search
  assert.match(html, /\/intelligence\/competitors\/search-streamers/);
});

// CPD-1216 — Score sort pill orders clips by cached view-prediction score
test('library clip picker exposes score sort backed by cached predictions', () => {
  const html = fs.readFileSync(path.join(__dirname, '../cwn_production.html'), 'utf8');
  assert.match(html, /setLibraryClipSort\('score'\)/);
  assert.match(html, /<option value="score">Score<\/option>/);
  // getLibraryClipSort/setLibraryClipSort whitelist includes 'score'
  assert.match(html, /sort === 'recent' \|\| sort === 'score'/);
  // predictions cached on clip objects and used for ordering
  assert.match(html, /_pred = c\.prediction/);
  assert.match(html, /a\._pred \? a\._pred\.score : -1/);
  // fresh predictions trigger exactly one re-render when score sort is active
  assert.match(html, /getLibraryClipSort\(\) === 'score'\) rerenderTwitchPicker\(\)/);
});
