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
      { title: 'Jason Rage Quits — Twitch Clips', description: desc }
    );
    expect(r.passed).toBe(true);
  });

  test('review hold on by default', () => {
    delete process.env.C0_REVIEW_HOLD;
    expect(reviewHoldEnabled()).toBe(true);
  });
});
