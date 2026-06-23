'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadE2eProfile,
  mergedEnvLock,
  buildLockedStartPayload,
  checkGoLiveConfig,
} = require('../lib/live_grid/e2e_lockdown');

describe('live_grid e2e lockdown', () => {
  it('loads E2E profile with baseline merge', () => {
    const p = loadE2eProfile();
    assert.equal(p.name, 'c0-live-grid-e2e-lockdown');
    const env = mergedEnvLock();
    assert.equal(env.LIVE_GRID_ENCODER, 'videotoolbox');
    assert.equal(env.LIVE_GRID_DUAL_BROADCAST, 'off');
    assert.equal(env.FFMPEG_PATH, '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg');
  });

  it('buildLockedStartPayload uses go-live template locks', () => {
    const body = buildLockedStartPayload();
    assert.equal(body.createListing, false);
    assert.equal(body.usePrepared, false);
    assert.equal(body.privacyStatus, 'private');
    assert.equal(body.goPublicAt, '18:00');
    assert.equal(body._stickTemplateLocks, true);
    assert.ok(body._resumeRuntime?.operatorLocks?.length === 4);
  });

  it('go-live config has SEO template', () => {
    const r = checkGoLiveConfig();
    assert.equal(r.ok, true);
    assert.ok(r.operatorLocks >= 4);
  });
});
