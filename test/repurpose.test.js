'use strict';
// CPD-998: repurpose step — published longform spawns a vertical sibling.
const { pickRepurposeAction, isEnabled } = require('../lib/services/repurpose');

describe('repurpose — isEnabled', () => {
  const orig = process.env.REPURPOSE_SHORTS;
  afterEach(() => {
    if (orig === undefined) delete process.env.REPURPOSE_SHORTS;
    else process.env.REPURPOSE_SHORTS = orig;
  });

  test('default off', () => {
    delete process.env.REPURPOSE_SHORTS;
    expect(isEnabled()).toBe(false);
  });

  test('on enables', () => {
    process.env.REPURPOSE_SHORTS = 'on';
    expect(isEnabled()).toBe(true);
  });
});

describe('repurpose — pickRepurposeAction', () => {
  const twitchCard = {
    jobId: 'script_twitch_123',
    contentType: 'twitch',
    orderedClipUrls: [
      { url: 'https://cdn/clip1.mp4', pageUrl: 'https://twitch.tv/c1', streamer: 'ron', displayName: 'Ron', title: 'Clutch 1' },
      { url: 'https://cdn/clip2.mp4', pageUrl: 'https://twitch.tv/c2', streamer: 'lacy', displayName: 'Lacy', title: 'Clutch 2' },
    ],
  };

  test('twitch longform → clip short from first clip', () => {
    const a = pickRepurposeAction(twitchCard);
    expect(a.kind).toBe('clip-short');
    expect(a.path).toBe('/generate-clip-comp');
    expect(a.body.clips).toHaveLength(1);
    expect(a.body.clips[0].url).toBe('https://cdn/clip1.mp4');
    expect(a.body.contentType).toBe('twitch-short');
    expect(a.body.repurposedFrom).toBe('script_twitch_123');
  });

  test('top10 variant → clip short from LAST clip (countdown #1)', () => {
    const a = pickRepurposeAction({ ...twitchCard, scriptVariant: 'top10' });
    expect(a.body.clips[0].url).toBe('https://cdn/clip2.mp4');
  });

  test('news longform → news-short via generate-full-script', () => {
    const a = pickRepurposeAction({
      jobId: 'script_news_9',
      contentType: 'news',
      newsItems: [{ title: 'Story A', videoUrl: 'https://v/a.mp4' }, { title: 'Story B' }],
    });
    expect(a.kind).toBe('full-script-short');
    expect(a.path).toBe('/generate-full-script');
    expect(a.body.type).toBe('news-short');
    expect(a.body.items).toEqual([{ title: 'Story A', videoUrl: 'https://v/a.mp4' }]);
    expect(a.body.repurposedFrom).toBe('script_news_9');
  });

  test('nba longform → nba-short', () => {
    const a = pickRepurposeAction({ jobId: 'j', contentType: 'nba', nbaItems: [{ matchup: 'NYK @ BOS' }] });
    expect(a.body.type).toBe('nba-short');
  });

  test('loop guard: short-form cards never repurpose', () => {
    expect(pickRepurposeAction({ contentType: 'twitch-short', orderedClipUrls: twitchCard.orderedClipUrls })).toBeNull();
    expect(pickRepurposeAction({ contentType: 'news-short', newsItems: [{ title: 'x' }] })).toBeNull();
  });

  test('loop guard: clips-only and already-repurposed cards never repurpose', () => {
    expect(pickRepurposeAction({ ...twitchCard, clipsOnly: true })).toBeNull();
    expect(pickRepurposeAction({ ...twitchCard, repurposedFrom: 'script_twitch_1' })).toBeNull();
  });

  test('no source material → null', () => {
    expect(pickRepurposeAction({ contentType: 'twitch', orderedClipUrls: [] })).toBeNull();
    expect(pickRepurposeAction({ contentType: 'news', newsItems: [] })).toBeNull();
    expect(pickRepurposeAction(null)).toBeNull();
  });
});
