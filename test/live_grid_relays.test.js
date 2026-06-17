describe('live_grid UDP relays (CPD-1006)', () => {
  beforeAll(() => { process.env.LIVE_GRID_UDP_RELAY = 'on'; jest.resetModules(); });
  afterAll(() => { jest.resetModules(); });

  test('relay URLs use base port + quadrant index', () => {
    const { relayListenUrl, relayPublishUrl, UDP_BASE_PORT } = require('../lib/live_grid/relays');
    expect(UDP_BASE_PORT).toBe(5010);
    expect(relayPublishUrl(0)).toContain('5010');
    expect(relayListenUrl(1)).toContain('5011');
  });

  test('master input uses resilient mpegts UDP when relay enabled', () => {
    const { quadMasterInputArgs, USE_UDP_RELAY } = require('../lib/live_grid/relays');
    const args = quadMasterInputArgs(2);
    expect(args[0]).toBe('-f');
    expect(args[1]).toBe('mpegts');
    expect(args[2]).toBe('-fflags');
    expect(args[3]).toContain('discardcorrupt');
    expect(args).toContain('-err_detect');
    expect(args[args.length - 1]).toContain('udp://127.0.0.1:5012');
    expect(USE_UDP_RELAY).toBe(true);
  });

  test('legacy RTSP master input when relay disabled', () => {
    const orig = process.env.LIVE_GRID_UDP_RELAY;
    process.env.LIVE_GRID_UDP_RELAY = 'off';
    jest.resetModules();
    const { quadMasterInputArgs: argsFn } = require('../lib/live_grid/relays');
    expect(argsFn(0)).toContain('-rtsp_transport');
    process.env.LIVE_GRID_UDP_RELAY = orig;
    jest.resetModules();
  });

  test('QuadRelays.waitForRunning resolves when relays are up', async () => {
    const { QuadRelays } = require('../lib/live_grid/relays');
    const relays = new QuadRelays({ log: () => {} });
    relays.procs = [{}, {}, {}, {}];
    const r = await relays.waitForRunning({ minRunning: 4, timeoutMs: 1000 });
    expect(r.ready).toBe(true);
    expect(r.running).toBe(4);
  });
});
