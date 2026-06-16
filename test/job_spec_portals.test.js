'use strict';

const {
  resolveActivePortals,
  resolveActiveExtensions,
  buildPortalsMap,
  PORTAL_ORDER,
} = require('../lib/job_spec');

describe('resolveActivePortals (CPD-1043)', () => {
  test('TikTok Clutch clip job activates portal0,3a,3b,4 — not portal1,2 when staging', () => {
    const spec = {
      contentType: 'clips',
      templateName: 'TikTok Clutch',
      staging: true,
      stageMap: { script: { active: false } },
    };
    const active = resolveActivePortals(spec);
    expect(active).toEqual(['portal0', 'portal3a', 'portal3b', 'portal4']);
    expect(spec.portals.portal5.active).toBe(false);
    expect(spec.portals.portal1.active).toBe(false);
    expect(spec.portals.portal4.active).toBe(true);
  });

  test('staging false enables portal5 for clip comp', () => {
    const spec = {
      contentType: 'clips',
      templateName: 'TikTok Clutch',
      staging: false,
      stageMap: { script: { active: false } },
    };
    const active = resolveActivePortals(spec);
    expect(active).toContain('portal5');
  });

  test('topic-only disables video portals', () => {
    const spec = { contentType: 'news', isTopicOnly: true };
    buildPortalsMap(spec);
    expect(spec.portals.portal3a.active).toBe(false);
    expect(spec.portals.portal5.active).toBe(false);
    expect(resolveActivePortals(spec)).toEqual(['portal0', 'portal1']);
  });

  test('returns portals in PORTAL_ORDER sequence', () => {
    const spec = {
      contentType: 'clips',
      templateName: 'YouTube Deep Dive',
      staging: true,
      stageMap: { script: { active: false } },
    };
    const active = resolveActivePortals(spec);
    const sorted = [...active].sort((a, b) => PORTAL_ORDER.indexOf(a) - PORTAL_ORDER.indexOf(b));
    expect(active).toEqual(sorted);
  });
});

describe('resolveActiveExtensions', () => {
  test('heygen add-on orders heygen_ext', () => {
    const spec = { addOns: { heygen: { active: true } }, extensions: {} };
    expect(resolveActiveExtensions(spec)).toContain('heygen_ext');
    expect(spec.extensions.heygen_ext.ordered).toBe(true);
  });
});
