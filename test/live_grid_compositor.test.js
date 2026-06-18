const { buildArgs, gridEncodeConfig, quadMasterInputArgs, USE_UDP_RELAY } = require('../lib/live_grid/compositor');

describe('live_grid compositor (CPD-1005)', () => {
  const orig = process.env;
  const { isUdpInputNotReady } = require('../lib/live_grid/compositor');

  beforeEach(() => {
    process.env = { ...orig, LIVE_GRID_FPS: '60', LIVE_GRID_AUDIO_BITRATE_K: '192', LIVE_GRID_BITRATE_K: '6800' };
  });

  afterEach(() => { process.env = orig; });

  test('gridEncodeConfig reads env defaults', () => {
    expect(gridEncodeConfig()).toEqual({ fps: 60, audioBitrateK: 192, bitrateK: 6800, encoder: 'videotoolbox', gop: 120 });
  });

  test('buildArgs uses UDP relay inputs by default', () => {
    process.env.LIVE_GRID_AUDIO_DIRECT = 'off';
    const args = buildArgs({ output: '/tmp/test.mp4', durationSec: 1 });
    const joined = args.join(' ');
    expect(joined).toContain('udp://127.0.0.1:5010');
    expect(joined).toContain('fps=60');
    expect(joined).toContain('192k');
    expect(joined).toContain('amix=inputs=4');
  });

  test('buildArgs direct audio skips amix and copies AAC by default', () => {
    process.env.LIVE_GRID_AUDIO_DIRECT = 'on';
    process.env.LIVE_GRID_AUDIO_COPY = 'on';
    const args = buildArgs({ output: '/tmp/test.mp4', durationSec: 1, audioQuad: 1 });
    const joined = args.join(' ');
    expect(joined).not.toContain('amix=inputs=4');
    expect(joined).toContain('-map 1:a');
    expect(joined).toContain('-c:a copy');
    expect(joined).not.toContain('[1:a]');
    expect(joined).not.toContain('aresample=44100');
  });

  test('buildArgs direct audio re-encodes via hot-switch amix when copy disabled', () => {
    process.env.LIVE_GRID_AUDIO_DIRECT = 'on';
    process.env.LIVE_GRID_AUDIO_COPY = 'off';
    const args = buildArgs({ output: '/tmp/test.mp4', durationSec: 1, audioQuad: 1 });
    const joined = args.join(' ');
    expect(joined).toContain('volume@aq1=1');
    expect(joined).toContain('amix=inputs=4');
    expect(joined).toContain('aformat=sample_rates=44100:channel_layouts=stereo');
    expect(joined).toContain('-c:a aac');
    expect(joined).not.toContain('-map 1:a');
  });

  test('buildArgs cover-fills grid cells and forces 16:9 RTMP for YouTube', () => {
    process.env.LIVE_GRID_CELL_FIT = 'cover';
    process.env.LIVE_GRID_ENCODER = 'libx264';
    process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD = 'off';
    const args = buildArgs({ output: 'rtmp://test/live/key', localHlsPath: '/tmp/preview.m3u8', durationSec: 1 });
    const joined = args.join(' ');
    expect(joined).toContain('crop=952:450');
    expect(joined).toContain('setdar=16/9');
    expect(joined).toContain('-s 1920x1080');
    expect(joined).toContain('-aspect 16:9');
    expect(joined).toContain('h264_metadata=sample_aspect_ratio=1/1');
    expect(joined).not.toContain('pad=1080:1080');
    expect(joined).toContain('flvflags=no_duration_filesize');
  });

  test('buildArgs letterboxes 16:9 HLS and square-pads RTMP when square pad enabled', () => {
    process.env.LIVE_GRID_ENCODER = 'libx264';
    process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD = 'on';
    const args = buildArgs({ output: 'rtmp://test/live/key', localHlsPath: '/tmp/preview.m3u8', durationSec: 1 });
    const joined = args.join(' ');
    expect(joined).toContain('[v_hls]');
    expect(joined).toContain('[v_yt]');
    expect(joined).toContain('pad=1080:1080');
    expect(joined).toContain('-f hls');
    expect(joined).toContain('-f flv');
    expect(joined).not.toContain('tee');
  });

  test('buildArgs includes framed layout with top brand and name strips', () => {
    process.env.LIVE_GRID_AUDIO_DIRECT = 'on';
    process.env.LIVE_GRID_AUDIO_COPY = 'off';
    const args = buildArgs({ output: '/tmp/test.mp4', durationSec: 1, audioQuad: 2 });
    const joined = args.join(' ');
    expect(joined).toContain('xstack=inputs=4:layout=');
    expect(joined).toContain('pad=1920:1080:0:0');
    expect(joined).not.toContain('scale=1920:1080:flags=fast_bilinear');
    expect(joined).toContain('drawtext@brandtitle');
    expect(joined).toContain("text='CLIPZ WORLD LIVE'");
    expect(joined).toContain('drawtext@name0');
    expect(joined).toContain('drawbox@labelrow0');
    expect(joined).toContain('overlay@onairav2');
    expect(joined).toContain('overlay@onairbadge');
    expect(joined).not.toContain('drawtext@onairtag');
    expect(joined).not.toContain('drawtext@audiobadge');
  });

  test('isUdpInputNotReady detects empty UDP port errors', () => {
    expect(isUdpInputNotReady('Error opening input: Operation not supported on socket')).toBe(true);
    expect(isUdpInputNotReady('Broken pipe')).toBe(false);
  });
});
