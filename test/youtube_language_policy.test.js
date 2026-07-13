'use strict';

const {
  scanVulgarLanguage,
  sanitizeVulgarLanguage,
  enforceShortScriptLanguage,
  enforcePublishCaptionLanguage,
} = require('../lib/youtube_language_policy');

describe('youtube_language_policy', () => {
  test('flags heavy profanity on caption surface', () => {
    const r = scanVulgarLanguage('WHAT THE F***', { surface: 'caption' });
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(sanitizeVulgarLanguage('WHAT THE F***')).not.toMatch(/F\*\*\*/);
  });

  test('sanitizes hook line in short script', () => {
    const script = `=== TWITCH SHORT ===
HOOK: This is some bullshit and it is wild.
[CLIP PLAYS HERE]
REACTION: Chat knew.
CAPTION: WHO LET HIM COOK`;
    const { script: out, sanitized, captionText } = enforceShortScriptLanguage(script, 'twitch-short');
    expect(sanitized).toBe(true);
    expect(out).toMatch(/HOOK:.*nonsense/i);
    expect(captionText).toBe('WHO LET HIM COOK');
  });

  test('allows clean internet-speak caption', () => {
    const script = `HOOK: Jason had one job.
[CLIP PLAYS HERE]
REACTION: He chose violence.
CAPTION: L + RATIO 💀`;
    const { violations, sanitized } = enforceShortScriptLanguage(script, 'twitch-short');
    expect(violations).toHaveLength(0);
    expect(sanitized).toBe(false);
  });

  test('sanitize publish caption', () => {
    const r = enforcePublishCaptionLanguage('Holy shit moment #Shorts');
    expect(r.sanitized).toBe(true);
    expect(r.caption.toLowerCase()).not.toMatch(/shit/);
  });

  test('sanitizes scene-header hook spokenText', () => {
    const script = `=== HOOK ===
type: avatar
spokenText: This is some bullshit right here.

=== CLIP ===
type: source_clip
spokenText:

=== REACTION ===
type: avatar
spokenText: Chat knew.

CAPTION: WHO LET HIM COOK`;
    const { script: out, sanitized } = enforceShortScriptLanguage(script, 'twitch-short');
    expect(sanitized).toBe(true);
    expect(out).toMatch(/spokenText:.*nonsense/i);
  });
});
