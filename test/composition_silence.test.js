'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSilenceRegions, speechRegionsFromSilence } = require('../lib/composition_silence');

describe('composition_silence', () => {
  it('parses ffmpeg silencedetect output', () => {
    const stderr = 'silence_start: 1.5\nsilence_end: 3.2 | silence_duration: 1.7';
    const regions = parseSilenceRegions(stderr, 10);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].start_sec, 11.5);
    assert.equal(regions[0].end_sec, 13.2);
  });

  it('inverts silence to speech windows', () => {
    const speech = speechRegionsFromSilence(
      [{ start_sec: 5, end_sec: 8, duration_sec: 3 }],
      20,
      0,
    );
    assert.ok(speech.length >= 2);
    assert.equal(speech[0].start_sec, 0);
    assert.equal(speech[0].end_sec, 5);
  });
});
