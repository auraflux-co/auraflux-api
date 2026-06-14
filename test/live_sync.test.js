jest.mock('axios');
jest.mock('../lib/calendar/master_plan', () => ({
  buildBroadcastToday: jest.fn(() => ({ youtubeNow: { mode: 'event_night' } })),
}));

const axios = require('axios');
const { buildBroadcastToday } = require('../lib/calendar/master_plan');
const { startCalendarLiveSync } = require('../lib/calendar/live_sync');

describe('calendar live sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CALENDAR_LIVE_SYNC = 'on';
    buildBroadcastToday.mockReturnValue({ youtubeNow: { mode: 'event_night' } });
  });

  test('hot-switches program mode without stop/start', async () => {
    axios.get.mockResolvedValue({ data: { running: true } });
    axios.post.mockResolvedValue({ data: { ok: true } });

    jest.useFakeTimers();
    const sync = startCalendarLiveSync({ baseUrl: 'http://127.0.0.1:3001', intervalMs: 60000 });

    await jest.advanceTimersByTimeAsync(0);
    buildBroadcastToday.mockReturnValue({ youtubeNow: { mode: 'news_desk' } });
    await jest.advanceTimersByTimeAsync(61000);

    expect(axios.post).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/live-grid/program-mode',
      { mode: 'news_desk' },
    );
    expect(axios.post).not.toHaveBeenCalledWith('http://127.0.0.1:3001/live-grid/stop', expect.anything());

    sync?.stop();
    jest.useRealTimers();
  });
});
