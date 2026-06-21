const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadPrograms,
  resolveScheduledMode,
  buildQuadrantSources,
  formatTitle,
  parseHm,
  inScheduleBlock,
  nowET,
} = require('../lib/live_grid/program_director');

describe('live_grid program director', () => {
  test('parseHm and inScheduleBlock handle overnight windows', () => {
    expect(parseHm('23:00')).toBe(23 * 60);
    expect(parseHm('03:00')).toBe(3 * 60);
    expect(inScheduleBlock(23 * 60 + 30, 23 * 60, 3 * 60)).toBe(true);
    expect(inScheduleBlock(12 * 60, 23 * 60, 3 * 60)).toBe(false);
  });

  test('event calendar resolves weekend sports block', () => {
    const { resolveCalendarEntry, loadEventCalendar } = require('../lib/live_grid/event_calendar');
    const cal = loadEventCalendar(path.join(__dirname, '..', 'config', 'live_grid_event_calendar.json'));
    const et = { weekday: 'sat', minutes: 19 * 60, dateKey: '2026-06-14' };
    const ev = resolveCalendarEntry(cal, et);
    expect(ev?.eventId).toBe('sports_watchalong');
  });

  test('resolveScheduledMode defaults to grid when schedule is empty', () => {
    const config = loadPrograms(path.join(__dirname, '..', 'config', 'live_grid_programs.json'));
    expect(config.schedule).toEqual([]);
    const et = { weekday: 'sat', minutes: 20 * 60 + 30, dateKey: '2026-06-13' };
    const { mode } = resolveScheduledMode(config, et);
    expect(mode).toBe('grid');
  });

  test('buildQuadrantSources maps news_desk file + slate + twitch', () => {
    const config = loadPrograms(path.join(__dirname, '..', 'config', 'live_grid_programs.json'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-prog-'));
    const news = path.join(tmp, 'news_desk.mp4');
    fs.writeFileSync(news, 'fake');
    const filePaths = { produced_news: news, produced_bump: null, event_primary: null };
    const poller = ['xqc', 'shroud', 'pokimane', 'summit1g'];
    const { sources, modeName } = buildQuadrantSources('news_desk', config, poller, filePaths);
    expect(modeName).toBe('news_desk');
    expect(sources[0]).toEqual({ type: 'file', path: news, label: 'NEWS DESK' });
    expect(sources[1]).toBeNull();
    expect(sources[2]).toBeNull();
    expect(sources[3]).toBe('summit1g');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('buildQuadrantSources event_night keeps co-streams on Q2-Q4', () => {
    const config = loadPrograms(path.join(__dirname, '..', 'config', 'live_grid_programs.json'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-event-'));
    const event = path.join(tmp, 'wc_final.mp4');
    fs.writeFileSync(event, 'fake');
    const poller = ['a', 'b', 'c', 'd'];
    const { sources } = buildQuadrantSources('event_night', config, poller, { event_primary: event }, {});
    expect(sources[0]).toEqual({ type: 'file', path: event, label: 'EVENT' });
    expect(sources.slice(1)).toEqual(['a', 'b', 'c']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('buildQuadrantSources event_night feed url maps co-streams from poller slot 0', () => {
    const config = loadPrograms(path.join(__dirname, '..', 'config', 'live_grid_programs.json'));
    const poller = ['lacy', 'hasanabi', 'extraemily', 'strogo'];
    const feed = { url: 'https://www.twitch.tv/ishowspeed', title: 'World Cup', channel: 'ishowspeed' };
    const { sources } = buildQuadrantSources('event_night', config, poller, {}, { event_feed: feed });
    expect(sources[0].url).toContain('ishowspeed');
    expect(sources.slice(1)).toEqual(['lacy', 'hasanabi', 'extraemily']);
  });

  test('formatTitle substitutes mode variables', () => {
    const t = formatTitle('🔴 LIVE: {eventTitle} — ClipzWorld', { eventTitle: 'World Cup Final' });
    expect(t).toContain('World Cup Final');
  });

  test('nowET returns weekday and minutes', () => {
    const et = nowET(new Date('2026-06-13T18:30:00-04:00'));
    expect(et.weekday).toBe('sat');
    expect(et.minutes).toBe(18 * 60 + 30);
  });
});
