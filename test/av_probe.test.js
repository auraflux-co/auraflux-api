'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVolumedetect,
  parseSignalstats,
  parseSilenceEvents,
  classifyVideo,
  classifyAudio,
  classifyAudioContinuity,
} = require('../lib/live_grid/av_probe');

describe('av_probe parsers', () => {
  it('parseVolumedetect extracts mean and max', () => {
    const stderr = `[Parsed_volumedetect_0 @ 0x] mean_volume: -22.4 dB\nmax_volume: -4.1 dB\n`;
    const v = parseVolumedetect(stderr);
    assert.equal(v.meanDb, -22.4);
    assert.equal(v.maxDb, -4.1);
  });

  it('parseSignalstats extracts YAVG and YDIF', () => {
    const stderr = 'lavfi.signalstats.YAVG=48.2 lavfi.signalstats.YDIF=9.1';
    const s = parseSignalstats(stderr);
    assert.equal(s.yavg, 48.2);
    assert.equal(s.ydif, 9.1);
  });
});

describe('av_probe classify', () => {
  it('flags black frame', () => {
    const c = classifyVideo({ yavg: 5, ydif: 8 });
    assert.equal(c.level, 'critical');
    assert.ok(c.issues.includes('black_or_blank_frame'));
  });

  it('flags frozen streak', () => {
    const c = classifyVideo({ yavg: 40, ydif: 6 }, { frozenStreak: 2 });
    assert.equal(c.level, 'critical');
    assert.ok(c.issues.includes('frozen_frame_suspected'));
  });

  it('flags silent audio when mean and peak are both quiet', () => {
    const c = classifyAudio({ meanDb: -70, maxDb: -40 });
    assert.equal(c.level, 'critical');
    assert.ok(c.issues.includes('silent_or_near_silent'));
  });

  it('does not flag silent when mean is low but peaks exist in window', () => {
    const c = classifyAudio({ meanDb: -70, maxDb: -8 });
    assert.notEqual(c.level, 'critical');
    assert.ok(!c.issues.includes('silent_or_near_silent'));
  });

  it('passes healthy audio', () => {
    const c = classifyAudio({ meanDb: -24, maxDb: -6 });
    assert.equal(c.level, 'good');
  });

  it('does not warn clipping on peak-at-0 alone (relay transcode)', () => {
    const c = classifyAudio({ meanDb: -12.2, maxDb: 0 });
    assert.equal(c.level, 'good');
    assert.ok(!c.issues.includes('clipping_suspected'));
  });

  it('warns clipping when mean and peak are both hot', () => {
    const c = classifyAudio({ meanDb: -6, maxDb: 0 });
    assert.equal(c.level, 'warn');
    assert.ok(c.issues.includes('clipping_suspected'));
  });

  it('detects choppy audio from silence gaps', () => {
    const stderr = [
      'silence_end: 2.1 | silence_duration: 0.07',
      'silence_end: 3.0 | silence_duration: 0.59',
      'silence_end: 4.1 | silence_duration: 0.77',
      'silence_end: 7.1 | silence_duration: 1.26',
    ].join('\n');
    const silence = parseSilenceEvents(stderr);
    const c = classifyAudioContinuity(silence, 8);
    assert.equal(c.level, 'critical');
    assert.ok(c.issues.includes('audio_choppy_gaps'));
    assert.equal(c.gapCount, 4);
  });

  it('flags long single dropout as choppy', () => {
    const c = classifyAudioContinuity({
      gapCount: 1,
      totalSilenceSec: 0.94,
      gaps: [{ durationSec: 0.94 }],
    }, 6);
    assert.ok(c.issues.includes('audio_dropout'));
    assert.equal(c.level, 'critical');
  });
});
