'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const {
  expandShortDescriptionIfNeeded,
  sanitizeTwitchClipShortCopy,
  buildPublishCopySystemPrompt,
} = require('../lib/publish');

describe('twitch clip comp shorts — not Twitch Soup show framing', () => {
  const cc = { showName: 'Twitch Soup', handle: '@clipzworldnews', host: 'Bobby G' };
  const streamers = ['jasontheween', 'Adapt', 'Marlon', 'ExtraEmily'];

  test('sanitizeTwitchClipShortCopy removes Twitch Soup show framing', () => {
    const raw = 'Watch jasontheween, Adapt, Marlon, ExtraEmily in this Twitch clips compilation from Twitch Soup. Great moments.';
    const out = sanitizeTwitchClipShortCopy(raw);
    expect(out).not.toMatch(/Twitch Soup/i);
    expect(out).toMatch(/ClipzWorld News/i);
    expect(out).toMatch(/jasontheween/);
  });

  test('expandShortDescriptionIfNeeded never appends from Twitch Soup for twitch-short', () => {
    const out = expandShortDescriptionIfNeeded('Short opener about ExtraEmily.', {
      streamers,
      cc,
      isShort: true,
      contentType: 'twitch-short',
    });
    expect(out).not.toMatch(/from Twitch Soup/i);
    expect(out).not.toMatch(/Twitch Soup/i);
    expect(out).toMatch(/@clipzworldnews|ClipzWorld News/i);
    expect(countWords(out)).toBeGreaterThanOrEqual(125);
  });

  test('prompt for twitch-short forbids show framing', () => {
    const out = buildPublishCopySystemPrompt({
      cc,
      cd: 'Twitch clips compilation',
      date: 'today',
      isShort: true,
      scriptExcerpt: 'CLIP 1: moment',
      contentType: 'twitch',
    });
    expect(out).toContain('NOT A SHOW');
    expect(out).toContain('NEVER say "Welcome to Twitch Soup"');
    expect(out).not.toContain('show: Twitch Soup');
  });
});

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
