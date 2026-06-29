'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('reddit candidates route allows library perSub up to 50', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/routes/c0_sources.js'), 'utf8');
  assert.match(src, /Math\.min\(50, parseInt\(req\.query\.perSub/);
  assert.match(src, /limit: rawLimit/);
});

test('library reddit fetch uses same per-source cap as twitch', () => {
  const html = fs.readFileSync(path.join(__dirname, '../cwn_production.html'), 'utf8');
  assert.match(html, /LIBRARY_PICKER_ITEMS_PER = 50/);
  assert.match(html, /function getRedditPerSub\(/);
  assert.match(html, /perSub >= LIBRARY_PICKER_ITEMS_PER \? 180000 : 120000/);
});
