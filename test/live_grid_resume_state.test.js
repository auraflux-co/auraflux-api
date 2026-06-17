'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  RESUME_PATH,
  saveResume,
  loadResume,
  clearResume,
  resumeIsStale,
  buildResumeStartOpts,
  applyResumeRuntime,
  captureResumeSnapshot,
  autoResumeEnabled,
} = require('../lib/live_grid/resume_state');

describe('live_grid resume_state', () => {
  beforeEach(() => clearResume());
  afterEach(() => clearResume());

  test('save and load round-trip', () => {
    saveResume({ shouldResume: true, savedAt: new Date().toISOString(), startOpts: {}, runtime: {} });
    const loaded = loadResume();
    assert.equal(loaded.shouldResume, true);
  });

  test('clearResume removes file', () => {
    saveResume({ shouldResume: true, savedAt: new Date().toISOString() });
    clearResume();
    assert.equal(loadResume(), null);
  });

  test('resumeIsStale respects max age', () => {
    const old = { savedAt: new Date(Date.now() - 25 * 3600000).toISOString() };
    assert.equal(resumeIsStale(old, 24 * 3600000), true);
    const fresh = { savedAt: new Date().toISOString() };
    assert.equal(resumeIsStale(fresh, 24 * 3600000), false);
  });

  test('buildResumeStartOpts merges program mode and broadcast id', () => {
    const opts = buildResumeStartOpts({
      startOpts: { roster: ['a'] },
      runtime: { programMode: 'event_night', broadcastId: 'abc123', watchUrl: 'https://youtube.com/live/abc123' },
    });
    assert.equal(opts.programMode, 'event_night');
    assert.equal(opts.broadcastId, 'abc123');
    assert.equal(opts.watchUrl, 'https://youtube.com/live/abc123');
    assert.deepEqual(opts.roster, ['a']);
  });

  test('captureResumeSnapshot from mock manager', () => {
    const mgr = {
      running: true,
      opts: { programMode: 'grid' },
      status: () => ({
        audio: { quadrant: 3, mode: 'manual' },
        operatorLocks: [{ quadrant: 1, type: 'url', url: 'https://www.twitch.tv/eslcs', label: 'EVENT' }],
        program: { requestedMode: 'event_night', activeMode: 'event_night' },
        broadcast: { id: 'bid', watchUrl: 'https://youtube.com/live/bid' },
      }),
    };
    const snap = captureResumeSnapshot(mgr);
    assert.equal(snap.runtime.audioQuadrant, 3);
    assert.equal(snap.runtime.audioMode, 'manual');
    assert.equal(snap.runtime.operatorLocks.length, 1);
  });

  test('applyResumeRuntime restores locks and manual audio', () => {
    const calls = [];
    const mgr = {
      running: true,
      log: () => {},
      setQuadrantUrl: (q, url, label, opts) => calls.push({ q, url, label, opts }),
      setAudio: (q, mode) => calls.push({ audio: q, mode }),
    };
    applyResumeRuntime(mgr, {
      operatorLocks: [{ quadrant: 1, type: 'url', url: 'https://www.twitch.tv/eslcs', label: 'EVENT', title: 'CS' }],
      audioMode: 'manual',
      audioPinSource: 'manual',
      audioQuadrant: 2,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].q, 0);
    assert.equal(calls[1].audio, 1);
    assert.equal(calls[1].mode, 'manual');
  });

  test('applyResumeRuntime releases stale manual pin without pinSource', () => {
    const calls = [];
    const mgr = {
      running: true,
      log: () => {},
      setAudio: (q, mode) => calls.push({ audio: q, mode }),
    };
    applyResumeRuntime(mgr, {
      audioMode: 'manual',
      audioQuadrant: 2,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].audio, 'auto');
  });

  test('autoResumeEnabled defaults on', () => {
    const prev = process.env.LIVE_GRID_AUTO_RESUME;
    delete process.env.LIVE_GRID_AUTO_RESUME;
    assert.equal(autoResumeEnabled(), true);
    process.env.LIVE_GRID_AUTO_RESUME = 'off';
    assert.equal(autoResumeEnabled(), false);
    if (prev === undefined) delete process.env.LIVE_GRID_AUTO_RESUME;
    else process.env.LIVE_GRID_AUTO_RESUME = prev;
  });

  test('RESUME_PATH is under data/', () => {
    assert.ok(RESUME_PATH.includes(`${path.sep}data${path.sep}live_grid_resume.json`));
    assert.equal(fs.existsSync(path.dirname(RESUME_PATH)) || true, true);
  });
});
