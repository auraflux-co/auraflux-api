'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const {
  buildChannelConfig,
  CHANNEL_SOCIAL,
  finalizeYoutubePublishMetadata,
  appendHashtagsToDescription,
  buildPublishScriptFromCard,
  buildPublishItemsFromCard,
} = require('../lib/publish');
const { validateYoutubeDescriptionSeo } = require('../lib/gates/metadata_qa');

describe('short social captions', () => {
  test('finalizeShortSocialCaptions builds dense TT/IG hashtag packs', () => {
    const {
      finalizeShortSocialCaptions,
      buildChannelConfig,
    } = require('../lib/publish');
    const cc = buildChannelConfig().clips;
    const metadata = {
      youtube: {
        title: 'Marlon: Streamers\' Most Unexpected Twitch Fails! #Shorts',
        description: 'Marlon and ExtraEmily deliver wild Twitch clips. Subscribe for more highlights from top streamers every week.',
        hashtags: ['#Shorts', '#TwitchClips', '#FYP'],
      },
    };
    finalizeShortSocialCaptions(metadata, {
      streamers: ['Marlon', 'ExtraEmily', 'Cinna'],
      cc,
      contentType: 'twitch-short',
    });
    expect(metadata.tiktok.caption).toMatch(/#FYP/);
    expect(metadata.tiktok.caption).toMatch(/#Marlon/i);
    expect((metadata.tiktok.caption.match(/#\w+/g) || []).length).toBeGreaterThanOrEqual(8);
    expect(metadata.instagram.caption).toMatch(/instagram\.com\/clipzworldnews/i);
    expect((metadata.instagram.caption.match(/#\w+/g) || []).length).toBeGreaterThanOrEqual(12);
    expect(metadata.tiktok.caption).not.toMatch(/Subscribe for more highlights.{80,}/);
  });
});

describe('publish YouTube SEO finalize', () => {
  test('channel config uses correct social URLs', () => {
    const cfg = buildChannelConfig();
    expect(cfg.clips.tiktokUrl).toBe('https://www.tiktok.com/@clipzworldstreams');
    expect(cfg.clips.instagramUrl).toBe('https://www.instagram.com/clipzworldnews/');
    expect(cfg.clips.tiktokHandle).toBe(CHANNEL_SOCIAL.tiktok.handle);
  });

  test('appendHashtagsToDescription adds tags when missing', () => {
    const out = appendHashtagsToDescription('Hook line here.', ['Shorts', 'TwitchClips', 'FYP']);
    expect(out).toMatch(/#Shorts/);
    expect((out.match(/#\w+/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('finalizeYoutubePublishMetadata merges hashtags and social links', () => {
    const yt = {
      description: 'A'.repeat(200) + ' Subscribe for more Twitch highlights and viral moments from top streamers.',
      hashtags: ['Shorts', 'TwitchClips', 'FYP'],
    };
    finalizeYoutubePublishMetadata(yt, buildChannelConfig().clips);
    expect(yt.description).toMatch(/tiktok\.com\/@clipzworldstreams/i);
    expect(yt.description).toMatch(/instagram\.com\/clipzworldnews/i);
    expect(yt.hashtagCount).toBeGreaterThanOrEqual(3);
    expect(yt.wordCount).toBeGreaterThan(20);
  });
});

describe('validateYoutubeDescriptionSeo', () => {
  const richShort = [
    'Marlon and ExtraEmily deliver the wildest Twitch clips this week — chaos, rage, and unforgettable moments.',
    'In this ClipzWorld News Short we break down four viral highlights from Marlon, ExtraEmily, stableronaldo, and Cinna.',
    'Each clip captures why Twitch live streaming dominates entertainment: unscripted drama, community reactions, and instant meme culture.',
    'Whether you follow competitive gaming, IRL streams, or variety content, these moments explain why millions tune in each week.',
    'ClipzWorld News curates the best Twitch highlights so you never miss the clips everyone is talking about on social media.',
    'We cover rage quits, wholesome fails, unexpected collabs, and chat-driven chaos that only happens on live broadcasts.',
    'Subscribe for more Twitch compilations, streamer news, and viral internet moments from ClipzWorld News.',
    '#TwitchClips #Shorts #FYP #Streamer #Viral',
  ].join(' ');

  test('passes rich shorts description', () => {
    const v = validateYoutubeDescriptionSeo(richShort, { isShort: true });
    expect(v).toEqual([]);
  });

  test('fails thin description with no hashtags', () => {
    const v = validateYoutubeDescriptionSeo('Quick clip.', { isShort: true });
    expect(v.some((x) => x.includes('too short'))).toBe(true);
    expect(v.some((x) => x.includes('hashtags'))).toBe(true);
  });

  test('buildPublishScriptFromCard reads clip comp orderedClipUrls', () => {
    const card = {
      title: 'Clips Comp — ExtraEmily',
      streamers: ['ExtraEmily'],
      script: { title: 'Clips Comp', scenes: [{ title: 'scene title' }] },
      orderedClipUrls: [{ displayName: 'ExtraEmily', title: 'pad box open' }],
    };
    const script = buildPublishScriptFromCard(card);
    expect(script).toMatch(/ExtraEmily/);
    expect(script).toMatch(/pad box open/);
    expect(buildPublishItemsFromCard(card)).toHaveLength(1);
  });
});
