describe('solo broadcast create guard', () => {
  const orig = {};

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LIVE_GRID_SOLO')) orig[k] = process.env[k];
    }
    delete process.env.LIVE_GRID_SOLO_CREATE_BROADCAST;
    jest.resetModules();
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LIVE_GRID_SOLO') && !(k in orig)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(orig)) process.env[k] = v;
    jest.resetModules();
  });

  test('soloCreateBroadcastsEnabled defaults off', () => {
    const { soloCreateBroadcastsEnabled } = require('../lib/live_grid/solo_listings_env');
    expect(soloCreateBroadcastsEnabled()).toBe(false);
    process.env.LIVE_GRID_SOLO_CREATE_BROADCAST = 'on';
    jest.resetModules();
    expect(require('../lib/live_grid/solo_listings_env').soloCreateBroadcastsEnabled()).toBe(true);
  });

  test('resolveSoloBroadcastIdFromMap prefers override map', () => {
    const { resolveSoloBroadcastIdFromMap } = require('../lib/live_grid/solo_listings_env');
    expect(resolveSoloBroadcastIdFromMap(0, { 1: 'AAA' }, 'env')).toBe('AAA');
    expect(resolveSoloBroadcastIdFromMap(2, ['a', 'b', 'c'], 'env')).toBe('c');
    expect(resolveSoloBroadcastIdFromMap(1, null, 'env')).toBe('env');
  });
});
