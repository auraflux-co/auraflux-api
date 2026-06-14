const { buildPublishCopySystemPrompt } = require('../lib/publish');

const cc = { showName: 'Twitch Soup', handle: '@clipzworldnews', host: 'Bobby G' };
const base = { cc, cd: 'twitch compilation', date: 'today', scriptExcerpt: 'script text', contentType: 'twitch' };

describe('publish copy prompt — long-form structured description (CPD-962)', () => {
  test('long-form prompt mandates every spec section', () => {
    const out = buildPublishCopySystemPrompt({
      ...base,
      isShort: false,
      streamerCredits: '• jason: https://twitch.tv/jasontheween',
      chaptersBlock: '\n\nCHAPTERS:\n0:00 Intro',
    });
    for (const marker of [
      'Welcome to Twitch Soup by ClipzWorld News',
      '⏱️ TIMESTAMPS',
      'Featured Streamers (Support Them 💜)',
      "What You'll See",
      'Hosted by: Bobby G',
      'Disclaimer',
      'VERBATIM',
    ]) {
      expect(out).toContain(marker);
    }
  });

  test('short-form description instruction stays punchy and unstructured', () => {
    const out = buildPublishCopySystemPrompt({ ...base, isShort: true });
    expect(out).toContain('1-2 punchy sentences');
    expect(out).not.toContain('Featured Streamers');
  });

  test('news-short content type resolves news context without long-form SEO block', () => {
    const out = buildPublishCopySystemPrompt({
      ...base,
      contentType: 'news-short',
      isShort: true,
      cd: '1. Iran tensions\n2. EU vote',
    });
    expect(out).toContain('Short (60-90 sec vertical)');
    expect(out).not.toContain('EVERY story');
  });
});
