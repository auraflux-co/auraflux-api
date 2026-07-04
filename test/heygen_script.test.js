'use strict';

const {
  prepareHeyGenScript,
  validateHeyGenScript,
  parseHeyGenApiError,
} = require('../lib/heygen_script');

describe('heygen_script', () => {
  test('prepareHeyGenScript converts [beat] to 1s break', () => {
    const out = prepareHeyGenScript('Hello [beat] world');
    expect(out).toBe('Hello <break time="1s"/> world');
  });

  test('prepareHeyGenScript rewrites legacy 1000ms breaks', () => {
    const out = prepareHeyGenScript('Hi <break time="1000ms"/> there');
    expect(out).toContain('<break time="1s"/>');
    expect(out).not.toContain('1000ms');
  });

  test('validateHeyGenScript flags ms breaks', () => {
    expect(validateHeyGenScript('x <break time="500ms"/> y')).toEqual([
      'Break tags must use seconds (<break time="1s"/>), not milliseconds',
    ]);
  });

  test('prepareHeyGenScript normalizes dashboard pause=4.0 alias', () => {
    const out = prepareHeyGenScript('Done. <pause=4.0> Follow up.', { reactionPauseSec: 4 });
    expect(out).toContain('<break time="4s"/>');
  });

  test('prepareHeyGenScript converts [studio laugh] to 4s break', () => {
    const out = prepareHeyGenScript('Subtle.\n[studio laugh]\nFollow Lacy. Link in description.', {
      sceneName: 'LACY_CLIP2_REACTION',
      reactionPauseSec: 4,
    });
    expect(out).toContain('<break time="4s"/>');
    expect(out).toMatch(/Subtle\./);
    // Phonetic roster (data/streamers.json) rewrites "Lacy" for TTS
    expect(out).toMatch(/Follow (Lacy|LAY-see)/);
  });

  test('prepareHeyGenScript converts [studio laugh] on clip1 reaction', () => {
    const out = prepareHeyGenScript('Subtle.\n[studio laugh]', {
      sceneName: 'LACY_CLIP1_REACTION',
      reactionPauseSec: 4,
    });
    expect(out).toContain('<break time="4s"/>');
    expect(out).toMatch(/Subtle\./);
  });

  test('parseHeyGenApiError extracts v3 invalid_parameter', () => {
    const msg = parseHeyGenApiError({
      error: {
        code: 'invalid_parameter',
        message: 'Extra inputs are not permitted',
        param: 'input_type',
      },
    }, 400);
    expect(msg).toContain('Extra inputs are not permitted');
    expect(msg).toContain('input_type');
  });
});
