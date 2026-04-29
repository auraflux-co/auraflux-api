'use strict';

/**
 * Unit tests for show_commentary job type template — CPD-75
 */

// Mock DB/file system before requiring job_spec
jest.mock('../lib/db', () => ({
  saveJob: jest.fn(),
  updateJobSpec: jest.fn(),
  loadJob: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/customerConfig', () => ({
  loadCustomerConfig: jest.fn().mockReturnValue({
    showId: 'test_show',
    designDefaults: { voice: { lockedOutro: 'outro', showName: { news: 'Test News' } } },
    templates: {
      'long-form': {
        providers: { script: 'gemini', assembly: 'internal', upload: 'upload_post' },
        designDefaults: { chrome: {}, resolution: { width: 1920, height: 1080 } },
        voice: {},
      },
    },
  }),
}));

jest.mock('../lib/scaffold', () => ({
  generateScaffold: jest.fn().mockReturnValue(null),
}));

jest.mock('../lib/chrome_overlay_ffmpeg', () => ({
  resolveChromeCfg: jest.fn().mockReturnValue({}),
  fingerprintResolvedChromeCfg: jest.fn().mockReturnValue('abc123'),
}));

const { createJobSpec } = require('../lib/job_spec');
const PRESETS = require('../lib/presets/definitions');

describe('preset_show_commentary definition', () => {
  it('exists in PRESETS', () => {
    expect(PRESETS.preset_show_commentary).toBeDefined();
  });

  it('has contentType: show_commentary', () => {
    expect(PRESETS.preset_show_commentary.contentType).toBe('show_commentary');
  });

  it('has 5 topics in scriptTemplate', () => {
    expect(PRESETS.preset_show_commentary.commentaryConfig.scriptTemplate.topicCount).toBe(5);
  });

  it('assembly mode is commentary', () => {
    expect(PRESETS.preset_show_commentary.commentaryConfig.assembly.mode).toBe('commentary');
  });

  it('all portals marked active in portalOverrides', () => {
    const overrides = PRESETS.preset_show_commentary.commentaryConfig.portalOverrides;
    ['portal0', 'portal1', 'portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5']
      .forEach((p) => {
        expect(overrides[p]).toBeDefined();
        expect(overrides[p].active).toBe(true);
      });
  });
});

describe('createJobSpec with contentType: show_commentary', () => {
  let spec;

  beforeAll(() => {
    spec = createJobSpec({
      customerId: 'c0',
      contentType: 'show_commentary',
      templateId: 'long-form',
      sourceType: 'url_list',
    });
  });

  it('returns a spec with contentType show_commentary', () => {
    expect(spec.contentType).toBe('show_commentary');
  });

  it('attaches commentaryConfig', () => {
    expect(spec.commentaryConfig).toBeDefined();
    expect(spec.commentaryConfig.scriptTemplate.format).toBe('multi_topic');
    expect(spec.commentaryConfig.assembly.mode).toBe('commentary');
  });

  it('portal1 is active (script QA)', () => {
    expect(spec.portals.portal1.active).toBe(true);
  });

  it('portal1b is active (video reviewer) — forced for show_commentary', () => {
    expect(spec.portals.portal1b.active).toBe(true);
  });

  it('portal2 is active (render quality) — forced for show_commentary', () => {
    expect(spec.portals.portal2.active).toBe(true);
  });

  it('portal4 is active (broadcast ready)', () => {
    expect(spec.portals.portal4.active).toBe(true);
  });

  it('portal5 is active (upload confirmation)', () => {
    expect(spec.portals.portal5.active).toBe(true);
  });
});
