'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listMusicBedOptions } = require('../lib/clip_comp_audio_catalog');

describe('Compose music bed picker (CPD-1292)', () => {
  it('lists built-in beds plus assets/audio files', () => {
    const beds = listMusicBedOptions();
    const ids = beds.map((b) => b.id);
    assert.ok(ids.includes('off'));
    assert.ok(ids.includes('low_trap'));
    assert.ok(beds.some((b) => b.id.startsWith('file:') || b.file), 'includes scanned files');
    assert.ok(!ids.some((id) => /studio_laugh/i.test(id)), 'excludes studio laugh');
  });

  it('UI has Compose Bed select + Hear bed', () => {
    const html = fs.readFileSync(path.join(__dirname, '../cwn_production.html'), 'utf8');
    assert.match(html, /id="composer-music-bed"/);
    assert.match(html, /hearComposerMusicBed/);
    assert.match(html, /getComposerMusicBed/);
  });
});
