'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadHeygenShows,
  resolveHeygenShow,
  heygenShowPreflight,
} = require('../lib/heygen_shows');

describe('heygen_shows', () => {
  const origAvatar = process.env.HEYGEN_AVATAR_ID;
  const origVoice = process.env.HEYGEN_VOICE_ID;

  before(() => {
    process.env.HEYGEN_AVATAR_ID = 'avatar-test-123';
    process.env.HEYGEN_VOICE_ID = 'voice-test-456';
  });

  after(() => {
    if (origAvatar == null) delete process.env.HEYGEN_AVATAR_ID;
    else process.env.HEYGEN_AVATAR_ID = origAvatar;
    if (origVoice == null) delete process.env.HEYGEN_VOICE_ID;
    else process.env.HEYGEN_VOICE_ID = origVoice;
  });

  it('loadHeygenShows includes talkSoup from c0 config', () => {
    const shows = loadHeygenShows('c0');
    assert.ok(shows.talkSoup);
    assert.equal(shows.talkSoup.avatarEnv, 'HEYGEN_AVATAR_ID');
  });

  it('resolveHeygenShow resolves default talkSoup avatar', () => {
    const r = resolveHeygenShow({ customerId: 'c0' });
    assert.equal(r.ok, true);
    assert.equal(r.showKey, 'talkSoup');
    assert.equal(r.avatarId, 'avatar-test-123');
    assert.equal(r.heygenFolder, 'TalkSoup');
  });

  it('resolveHeygenShow fails when avatar env missing', () => {
    delete process.env.HEYGEN_AVATAR_ID;
    const r = resolveHeygenShow({ customerId: 'c0' });
    assert.equal(r.ok, false);
    assert.match(r.error, /HEYGEN_AVATAR_ID/);
    process.env.HEYGEN_AVATAR_ID = 'avatar-test-123';
  });

  it('heygenShowPreflight returns summary when ok', () => {
    const pf = heygenShowPreflight({ customerId: 'c0' });
    assert.equal(pf.ok, true);
    assert.match(pf.summary, /Talk Soup/);
  });
});
