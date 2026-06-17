'use strict';

const { normalizePublishCopyShape } = require('../lib/publish_copy_normalize');

describe('publish_copy_normalize', () => {
  test('prefers platforms.youtube when top-level youtube is a stub', () => {
    const rich = {
      title: 'ExtraEmily: Emily Pad Box #Shorts',
      description: 'A '.repeat(130) + 'Subscribe for more #Shorts #TwitchClips #FYP',
      hashtags: ['#Shorts', '#TwitchClips', '#FYP'],
    };
    const stub = { title: 'ExtraEmily: Twitch Clips #Shorts', description: 'Short stub only.' };
    const out = normalizePublishCopyShape({
      ok: true,
      platforms: { youtube: rich, tiktok: { caption: 'tiktok caption here with enough length' } },
      youtube: stub,
    });
    expect(out.youtube.description).toBe(rich.description);
    expect(out.tiktok.caption).toMatch(/tiktok/);
  });
});
