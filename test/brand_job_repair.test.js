'use strict';

const {
  extractTwitchLoginFromSpec,
  applyBrandIdentityPatch,
} = require('../lib/services/brand_job_repair');
const { publishResultsHadSuccess } = require('../lib/services/approve_publish');

describe('brand_job_repair (CPD-1020)', () => {
  test('extractTwitchLoginFromSpec reads twitch clip URL', () => {
    const login = extractTwitchLoginFromSpec({
      order: {
        inputs: {
          items: [{ url: 'https://www.twitch.tv/bogur/clip/SomeClipId-abc' }],
        },
      },
    });
    expect(login).toBe('bogur');
  });

  test('applyBrandIdentityPatch sets branding + chrome streamer', () => {
    const spec = { order: { inputs: { items: [{}] } }, state: {} };
    applyBrandIdentityPatch(spec, { id: 'brand-1', name: 'bogur', slug: 'bogur' }, 'bogur');
    expect(spec.brandId).toBe('brand-1');
    expect(spec.addOns.branding.active).toBe(true);
    expect(spec.designSpec.chrome.streamer).toBe('bogur');
    expect(spec.state.chromeApplied).toBe(false);
  });
});

describe('approve_publish (CPD-1020)', () => {
  test('publishResultsHadSuccess true when youtube ok', () => {
    expect(publishResultsHadSuccess({ youtube: { ok: true, platformJobId: 'abc' } })).toBe(true);
  });

  test('publishResultsHadSuccess false when all platforms errored', () => {
    expect(publishResultsHadSuccess({
      youtube: { failed: true, error: 'canPublishDirect is not a function' },
    })).toBe(false);
  });
});
