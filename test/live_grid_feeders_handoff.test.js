jest.mock('../lib/live_grid/stream_probe', () => ({
  twitchChannelLive: jest.fn(),
  streamlinkAvailable: jest.fn(),
}));

jest.mock('child_process', () => {
  const fakeProc = () => ({
    stdout: { on: jest.fn(), pipe: jest.fn() },
    stdin: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
    pid: 999,
  });
  return {
    spawn: jest.fn(() => fakeProc()),
    execFile: jest.fn((cmd, args, cb) => cb && cb(null, '')),
  };
});

const { twitchChannelLive } = require('../lib/live_grid/stream_probe');
const { QuadrantFeeders } = require('../lib/live_grid/feeders');

describe('live_grid feeder offline→online handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.LIVE_GRID_FEEDER_RETRY_MS = '5000';
    process.env.LIVE_GRID_FEEDER_RETRY_MAX_MS = '60000';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('offline streamer stays on slate without starting streamlink', async () => {
    twitchChannelLive.mockResolvedValue(false);
    const feeders = new QuadrantFeeders({ log: () => {} });
    feeders.setQuadrant(0, 'tylil');
    await Promise.resolve();
    expect(twitchChannelLive).toHaveBeenCalledWith('tylil');
    expect(feeders.quads[0].kind).toBe('slate');
    expect(feeders.quads[0].procs).toHaveLength(1);
    expect(feeders.quads[0].pendingLogin).toBe('tylil');
  });

  test('live streamer starts channel feeder after probe', async () => {
    twitchChannelLive.mockResolvedValue(true);
    const feeders = new QuadrantFeeders({ log: () => {} });
    feeders.setQuadrant(1, 'moonmoon');
    await Promise.resolve();
    expect(feeders.quads[1].kind).toBe('channel');
    expect(feeders.quads[1].procs.length).toBeGreaterThanOrEqual(2);
  });

  test('retry uses exponential backoff when offline', async () => {
    twitchChannelLive.mockResolvedValue(false);
    const feeders = new QuadrantFeeders({ log: () => {} });
    feeders.setQuadrant(2, 'clix');
    await Promise.resolve();
    expect(twitchChannelLive).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(twitchChannelLive).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(10000);
    await Promise.resolve();
    expect(twitchChannelLive).toHaveBeenCalledTimes(3);
  });
});
