const { classifyStreamType, classifyRegion, isNewsOrSports } = require('../lib/broadcast/stream_type');
const { buildViewBandInsights, countByType } = require('../lib/broadcast/view_band_insights');
const { buildProgrammingPlaybook } = require('../lib/broadcast/programming_playbook');

describe('stream_type', () => {
  test('police chase = feed', () => {
    const r = classifyStreamType({
      title: 'LIVE: Los Angeles police chase',
      channel: 'FOX 11 Los Angeles',
      durationHrs: 2,
    });
    expect(r.type).toBe('feed');
    expect(r.region).toMatch(/US — local/);
  });

  test('watch party = watchparty', () => {
    const r = classifyStreamType({
      title: 'Knicks vs Spurs: LIVE watch party in New York',
      channel: 'Associated Press',
      durationHrs: 1.2,
    });
    expect(r.type).toBe('watchparty');
  });

  test('Morning Footy analysis = produced', () => {
    const r = classifyStreamType({
      title: 'Morning Footy LIVE: World Cup News, Analysis & Debate',
      channel: 'CBS Sports Golazo',
      durationHrs: 2,
    });
    expect(['produced', 'mixed']).toContain(r.type);
  });

  test('isNewsOrSports filters cricket', () => {
    expect(isNewsOrSports({ title: 'IPL Final Live', channel: 'CricTalks' })).toBe(true);
    expect(isNewsOrSports({ title: 'Playing Roblox', channel: 'FrRexan' })).toBe(false);
  });
});

describe('view_band_insights', () => {
  test('buildViewBandInsights returns bands when data exists', () => {
    const vb = buildViewBandInsights();
    if (!vb.bands?.length) {
      expect(vb.sourceNote).toBeTruthy();
      return;
    }
    expect(vb.streamTypeLegend.length).toBe(4);
    expect(vb.bands[0].typeCounts).toBeDefined();
  });

  test('playbook includes viewBands', () => {
    const pb = buildProgrammingPlaybook();
    expect(pb.ok).toBe(true);
    expect(pb.viewBands).toBeDefined();
    expect(pb.viewBands.streamTypeLegend?.length).toBe(4);
  });
});

describe('countByType', () => {
  test('aggregates types', () => {
    const items = [
      { title: 'LIVE police chase', channel: 'FOX 11', durationHrs: 2 },
      { title: 'LIVE: trial hearing', channel: 'Law&Crime', durationHrs: 4 },
    ];
    const c = countByType(items);
    expect(c.feed + c.mixed).toBeGreaterThan(0);
  });
});
