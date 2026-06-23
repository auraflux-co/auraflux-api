process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

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

  test('short-form description requires full YouTube SEO block', () => {
    const out = buildPublishCopySystemPrompt({
      ...base,
      isShort: true,
      cc: { ...cc, tiktokUrl: 'https://www.tiktok.com/@clipzworldstreams', instagramUrl: 'https://www.instagram.com/clipzworldnews/' },
    });
    expect(out).toContain('125-250 words');
    expect(out).toContain('3-5 hashtags INLINE');
    expect(out).toContain('Featured Streamers');
    expect(out).toContain('clipzworldstreams');
    expect(out).not.toContain('under 120 chars');
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

  test('twitch clip comp prompt treats YT title as rewritten headline not burned caption', () => {
    const out = buildPublishCopySystemPrompt({
      ...base,
      contentType: 'twitch-short',
      isShort: true,
    });
    expect(out).toContain('SEPARATE rewritten headline');
    expect(out).toContain('do NOT copy burned hook text');
    expect(out).not.toContain('Burned on-screen hooks use');
  });
});
