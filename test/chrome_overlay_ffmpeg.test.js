'use strict';

const {
  resolveChromeCfg,
  fingerprintResolvedChromeCfg,
  buildChromeFilterChain
} = require('../lib/chrome_overlay_ffmpeg');

describe('chrome_overlay_ffmpeg', () => {
  test('fingerprintResolvedChromeCfg changes when news flag layout overrides change', () => {
    const baseCustomer = JSON.parse(
      require('fs').readFileSync(require('path').join(__dirname, '../config/customers/c0.json'), 'utf8')
    );
    const a = resolveChromeCfg(baseCustomer, 'news');
    const bCfg = JSON.parse(JSON.stringify(baseCustomer));
    bCfg.templates['long-form'].designDefaults.chrome.contentTypeOverrides.news.flag.topGapBelowTopBar = 99;
    const b = resolveChromeCfg(bCfg, 'news');
    expect(fingerprintResolvedChromeCfg(a)).not.toBe(fingerprintResolvedChromeCfg(b));
  });

  test('buildChromeFilterChain uses looped logo input and overlay shortest=1', () => {
    const customer = JSON.parse(
      require('fs').readFileSync(require('path').join(__dirname, '../config/customers/c0.json'), 'utf8')
    );
    const cfg = resolveChromeCfg(customer, 'news');
    const { extraInputs, filterComplex } = buildChromeFilterChain(
      {
        showFlag: true,
        showSidebar: true,
        episodeNumber: 'Episode 1',
        flagCategory: 'WORLD NEWS',
        flagTitle: 'Test headline for overlay',
        sidebarItems: [{ title: 'One', category: 'NEWS' }],
        activeIdx: 0
      },
      cfg
    );
    expect(extraInputs[0]).toBe('-loop');
    expect(extraInputs[1]).toBe('1');
    expect(filterComplex).toMatch(/overlay=x=\d+:y=\d+:shortest=1/);
    expect(filterComplex).toMatch(/scale=\d+:-2/);
  });
});
