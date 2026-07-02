'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  serializePicks,
  applyPicks,
  countSavedClips,
} = require('../lib/library_clip_picks');

describe('library_clip_picks', () => {
  it('round-trips selected clips and collapsed state', () => {
    const streamers = [{
      name: 'cinna',
      displayName: 'Cinna',
      selected: true,
      collapsed: true,
      clips: [
        { url: 'https://clips.twitch.tv/A', title: 'Clip A', selected: true },
        { url: 'https://clips.twitch.tv/B', title: 'Clip B', selected: false },
      ],
      clipsRaw: [
        { url: 'https://clips.twitch.tv/A', title: 'Clip A', selected: true },
        { url: 'https://clips.twitch.tv/B', title: 'Clip B', selected: false },
      ],
    }];
    const saved = serializePicks(streamers, { streamerLogins: ['cinna'] });
    assert.equal(countSavedClips(saved), 1);

    const fresh = [{
      name: 'cinna',
      displayName: 'Cinna',
      selected: false,
      collapsed: false,
      clips: [
        { url: 'https://clips.twitch.tv/A', title: 'Clip A', selected: false },
        { url: 'https://clips.twitch.tv/B', title: 'Clip B', selected: false },
      ],
      clipsRaw: [
        { url: 'https://clips.twitch.tv/A', title: 'Clip A', selected: false },
        { url: 'https://clips.twitch.tv/B', title: 'Clip B', selected: false },
      ],
    }];
    applyPicks(fresh, saved);
    assert.equal(fresh[0].clips[0].selected, true);
    assert.equal(fresh[0].collapsed, true);
    assert.equal(fresh[0].selected, true);
  });
});
