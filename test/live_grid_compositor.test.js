const { buildArgs, gridEncodeConfig, quadMasterInputArgs, USE_UDP_RELAY } = require('../lib/live_grid/compositor');

describe('live_grid compositor (CPD-1005)', () => {
  const orig = process.env;

  beforeEach(() => {
    process.env = { ...orig, LIVE_GRID_FPS: '60', LIVE_GRID_AUDIO_BITRATE_K: '192', LIVE_GRID_BITRATE_K: '6800' };
  });

  afterEach(() => { process.env = orig; });

  test('gridEncodeConfig reads env defaults', () => {
    expect(gridEncodeConfig()).toEqual({ fps: 60, audioBitrateK: 192, bitrateK: 6800, encoder: 'videotoolbox', gop: 120 });
  });

  test('buildArgs uses UDP relay inputs by default', () => {
    const args = buildArgs({ output: '/tmp/test.mp4', durationSec: 1 });
    const joined = args.join(' ');
    expect(joined).toContain('udp://127.0.0.1:5010');
    expect(joined).toContain('fps=60');
    expect(joined).toContain('192k');
    expect(joined).toContain('aresample=async=1');
  });
});
