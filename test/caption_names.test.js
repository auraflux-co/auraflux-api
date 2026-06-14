// CPD-978: whisper caption streamer-name correction
const { _correctStreamerNames, _streamerNamePromptBias } = require('../lib/assembly_postprocess');

const ROSTER = [
  { displayName: 'Yonna', twitchUsername: 'yonnajay', onAirName: 'Yonna', phonetic: 'Yawn-uh' },
  { displayName: 'Adapt', twitchUsername: 'adapt', onAirName: 'Adapt', phonetic: 'AD-apt' },
  { displayName: 'Jason', twitchUsername: 'jasontheween', onAirName: 'Jason' },
];

describe('_correctStreamerNames', () => {
  test('replaces phonetic respelling with on-air name', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nThis is Yawn-uh and she is live\n';
    expect(_correctStreamerNames(srt, ROSTER)).toContain('This is Yonna and');
  });

  test('replaces de-hyphenated and spaced phonetic variants', () => {
    expect(_correctStreamerNames('say hi to Yawnuh today', ROSTER)).toContain('Yonna today');
    expect(_correctStreamerNames('say hi to yawn uh today', ROSTER)).toContain('Yonna today');
  });

  test('replaces leaked twitch username with on-air name', () => {
    expect(_correctStreamerNames('follow jasontheween now', ROSTER)).toContain('follow Jason now');
  });

  test('is case-insensitive but leaves unrelated words alone', () => {
    const out = _correctStreamerNames('AD-APT did adapt to the meta', ROSTER);
    expect(out).toContain('Adapt did');
    // username "adapt" differs from on-air "Adapt" only by case — skipped, so
    // the common verb is never falsely "corrected"
    expect(out).toContain('did adapt to the meta');
  });

  test('no-ops on empty roster', () => {
    expect(_correctStreamerNames('Yawn-uh stays', [])).toBe('Yawn-uh stays');
  });
});

describe('_streamerNamePromptBias', () => {
  test('lists unique on-air names', () => {
    const bias = _streamerNamePromptBias(ROSTER);
    expect(bias).toContain('Yonna');
    expect(bias).toContain('Adapt');
    expect(bias).toContain('Jason');
  });

  test('empty roster gives empty string', () => {
    expect(_streamerNamePromptBias([])).toBe('');
  });
});
