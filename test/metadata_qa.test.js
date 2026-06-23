'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const { validatePublishMetadata, reviewHoldEnabled } = require('../lib/gates/metadata_qa');

describe('metadata_qa (CPD-1049)', () => {
  test('blocks AI in clip comp title', () => {
    const r = validatePublishMetadata(
      { contentType: 'twitch-short', designSpec: { chrome: { layout: 'clip-comp' } } },
      { title: 'Streamers Go Wild With AI', description: 'Clips' }
    );
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes('AI'))).toBe(true);
  });

  test('passes title referencing clip topic with rich description', () => {
    const desc = [
      'Jason rage quits Minecraft in this viral Twitch clip compilation from ClipzWorld News.',
      'We break down the funniest and most chaotic moments from today\'s top streamers with context and commentary.',
      'ClipzWorld News curates Twitch highlights each week so you catch every viral moment before it disappears from the timeline.',
      'From speedrun fails to chat-driven chaos, this Short captures why Minecraft remains one of the biggest categories on Twitch.',
      'We highlight reaction moments, chat spam, and the exact second Jason gives up — the kind of clip that spreads across X and TikTok within hours.',
      'If you follow variety streamers, competitive gaming, or pure entertainment broadcasts, these highlights show why live streaming beats polished uploads.',
      'ClipzWorld News packages the best moments for viewers who want the story without watching six hours of VOD footage.',
      'Follow us on TikTok and Instagram for more clips, and subscribe on YouTube for full compilations every week.',
      'Subscribe for Twitch soup, streamer drama, and viral gaming moments from ClipzWorld News.',
      '#TwitchClips #Shorts #FYP #Jason #Minecraft',
    ].join(' ');
    const r = validatePublishMetadata(
      {
        contentType: 'twitch-short',
        formType: 'short',
        designSpec: { chrome: { layout: 'clip-comp' } },
        order: { inputs: { items: [{ title: 'Jason Rage Quits Minecraft' }] } },
      },
      {
        title: 'Jason Rage Quits — Twitch Clips',
        description: desc,
        tiktok: {
          caption: [
            'Jason rage quits Minecraft — viral Twitch moment from ClipzWorld News',
            'Follow for more Twitch clips',
            '#Jason #TwitchClips #FYP #Viral #ClipzWorldNews',
          ].join('\n\n'),
        },
        instagram: {
          caption: [
            'Jason rage quits Minecraft in this viral Twitch clip — watch the full moment on ClipzWorld News.',
            '#FYP #ForYou #Twitch #TwitchClips #TwitchHighlights #StreamerFails #Gaming #LiveStream #Viral #Jason #Minecraft #ClipzWorldNews #Streaming #GamingClips',
            'https://www.instagram.com/clipzworldnews/',
          ].join('\n\n'),
          altText: 'Jason rage quits Minecraft Twitch clip',
        },
      },
    );
    expect(r.passed).toBe(true);
  });

  test('blocks missing TikTok caption on shorts', () => {
    const desc = [
      'ExtraEmily and Lacy star in this Twitch clips compilation from ClipzWorld News with hilarious viral moments.',
      'We break down the funniest and most shocking highlights from today\'s top streamers with context and commentary.',
      'ClipzWorld News curates Twitch highlights each week so you catch every viral moment before it disappears.',
      'From unexpected reactions to chat-driven chaos, this Short captures why live streaming beats polished uploads.',
      'Follow us on TikTok and Instagram for more clips, and subscribe on YouTube for full compilations every week.',
      'Subscribe for Twitch soup, streamer drama, and viral gaming moments from ClipzWorld News.',
      '#TwitchClips #Shorts #FYP #ExtraEmily #Lacy',
    ].join(' ');
    const r = validatePublishMetadata(
      {
        contentType: 'twitch-short',
        formType: 'short',
        streamers: ['ExtraEmily', 'Lacy'],
        designSpec: { chrome: { layout: 'clip-comp' } },
      },
      {
        title: 'ExtraEmily Goes Viral — Twitch Clips',
        description: desc,
        tiktok: { caption: '' },
        instagram: {
          caption: 'IG caption here with enough length for the check to pass easily.',
          altText: 'ExtraEmily clip',
        },
      },
    );
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes('TikTok'))).toBe(true);
  });

  test('blocks YouTube tags below 490 combined chars', () => {
    const r = validatePublishMetadata(
      { contentType: 'twitch-short', formType: 'short' },
      { title: 'Test Title', tags: ['short', 'clip'] },
    );
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes('490-500'))).toBe(true);
  });

  test('passes YouTube tags in 490-500 char budget', () => {
    const tags = ['a'.repeat(495)];
    const total = tags.join('').length;
    expect(total).toBeGreaterThanOrEqual(490);
    expect(total).toBeLessThanOrEqual(500);
    const r = validatePublishMetadata(
      { contentType: 'twitch-short', formType: 'short' },
      { title: 'Test Title', tags },
    );
    expect(r.violations.some((v) => v.includes('490-500'))).toBe(false);
  });

  test('review hold on by default', () => {
    delete process.env.C0_REVIEW_HOLD;
    expect(reviewHoldEnabled()).toBe(true);
  });
});
