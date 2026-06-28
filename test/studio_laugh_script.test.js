'use strict';

const {
  injectStudioLaughPausesInScript,
  injectStudioLaughPauseInReactionText,
} = require('../lib/studio_laughter');

describe('studio_laugh script pauses', () => {
  test('last-clip reaction inserts [studio laugh] before follow line', () => {
    const out = injectStudioLaughPauseInReactionText(
      'The yellow seatbelts are a bold choice.\n[beat]\nFollow Lacy. Link in description.'
    );
    expect(out).toContain('[studio laugh]');
    expect(out.indexOf('[studio laugh]')).toBeLessThan(out.indexOf('Follow Lacy'));
    expect(out).not.toMatch(/\[beat\]\s*\nFollow/);
  });

  test('earlier-clip reaction appends [studio laugh] at end', () => {
    const out = injectStudioLaughPauseInReactionText('Subtle.');
    expect(out).toBe('Subtle.\n[studio laugh]');
  });

  test('injectStudioLaughPausesInScript handles headers without trailing newline', () => {
    const script = '=== LACY_CLIP2_REACTION ===The yellow seatbelts are a bold choice.\n[beat]\nFollow Lacy. Link in description.=== JASON_INTRO ===Next up.';
    const out = injectStudioLaughPausesInScript(script);
    expect(out).toMatch(/bold choice\.\n\[studio laugh\]\nFollow Lacy/);
  });

  test('injectStudioLaughPausesInScript patches all REACTION scenes', () => {
    const script = `=== LACY_CLIP1_REACTION ===
Subtle.

=== LACY_CLIP2_REACTION ===
The yellow seatbelts are a bold choice.
[beat]
Follow Lacy. Link in description.`;
    const out = injectStudioLaughPausesInScript(script);
    expect(out.match(/\[studio laugh\]/gi)).toHaveLength(2);
    expect(out).toMatch(/Subtle\.\n\[studio laugh\]/);
    expect(out).toMatch(/bold choice\.\n\[studio laugh\]\nFollow Lacy/);
  });
});
