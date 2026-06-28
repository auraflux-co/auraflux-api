'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  registerSessionFromJob,
  isPublishedTalkSoupJob,
  resolvePublishedVideoUrl,
} = require('../lib/post_live/register_from_job');

const STORE_PATH = path.join(__dirname, '..', 'data', 'post_live_vod_sessions.json');
const STORE_BACKUP = STORE_PATH + '.testbak';

describe('register_from_job', () => {
  it('isPublishedTalkSoupJob detects published twitch long-form', () => {
    assert.equal(isPublishedTalkSoupJob({ contentType: 'twitch', stage: 'published' }), true);
    assert.equal(isPublishedTalkSoupJob({ contentType: 'twitch-short', stage: 'published' }), false);
    assert.equal(isPublishedTalkSoupJob({ contentType: 'twitch', clipsOnly: true }), false);
  });

  it('resolvePublishedVideoUrl finds youtube url on card', () => {
    const url = resolvePublishedVideoUrl({
      publishRecord: { youtubeUrl: 'https://www.youtube.com/watch?v=abc123xyz01' },
    });
    assert.match(url, /abc123xyz01/);
  });

  it('registerSessionFromJob seeds sceneCandidates from rundown', () => {
    let prev = null;
    if (fs.existsSync(STORE_PATH)) {
      prev = fs.readFileSync(STORE_PATH, 'utf8');
      fs.writeFileSync(STORE_BACKUP, prev);
    }
    try {
      const card = {
        contentType: 'twitch',
        stage: 'published',
        title: 'Test Soup Episode',
        publishRecord: { youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        postAssemblyRundown: {
          totalSec: 90,
          entries: [
            { segmentLabel: 'JASON_CLIP1', startSec: 30, endSec: 60, durationSec: 30 },
          ],
        },
      };
      const r = registerSessionFromJob('script_twitch_test123', card);
      assert.equal(r.videoId, 'dQw4w9WgXcQ');
      assert.equal(r.session.sessionKind, 'published_episode');
      assert.equal(r.session.sourceJobId, 'script_twitch_test123');
      assert.ok(r.repurpose.candidates.length >= 1);
    } finally {
      if (prev != null) fs.writeFileSync(STORE_PATH, prev);
      else if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
      if (fs.existsSync(STORE_BACKUP)) fs.unlinkSync(STORE_BACKUP);
    }
  });
});
