/**
 * Event calendar — auto-rotate event_night titles from allowlist (CPD-1021)
 */

const fs = require('fs');
const path = require('path');
const { nowET, parseHm, inScheduleBlock } = require('./schedule_time');
const { eventAllowed } = require('./rights_registry');

const DEFAULT_CALENDAR = path.join(__dirname, '..', '..', 'config', 'live_grid_event_calendar.json');

function loadEventCalendar(calendarPath = process.env.LIVE_GRID_EVENT_CALENDAR || DEFAULT_CALENDAR) {
  if (!fs.existsSync(calendarPath)) return { entries: [], fallbackRotation: [] };
  return JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
}

function resolveCalendarEntry(calendar, et = nowET()) {
  for (const entry of calendar.entries || []) {
    const days = (entry.days || []).map(d => String(d).toLowerCase().slice(0, 3));
    if (days.length && !days.includes(et.weekday)) continue;
    const start = parseHm(entry.start);
    const end = parseHm(entry.end);
    if (start == null || end == null) continue;
    if (!inScheduleBlock(et.minutes, start, end)) continue;
    const allowed = eventAllowed(entry.eventId);
    if (!allowed) continue;
    return {
      eventId: entry.eventId,
      eventTitle: entry.eventTitle || allowed.label,
      eventFile: entry.eventFile || null,
      tier: allowed.tier,
      block: `${entry.start}-${entry.end}`,
    };
  }
  return null;
}

/** Day-based rotation when no calendar entry matches but mode is event_night. */
function resolveFallbackEvent(calendar, et = nowET()) {
  const ids = calendar.fallbackRotation || [];
  if (!ids.length) return null;
  const dayNum = parseInt(et.dateKey.replace(/-/g, ''), 10) || 0;
  const eventId = ids[dayNum % ids.length];
  const allowed = eventAllowed(eventId);
  if (!allowed) return null;
  return {
    eventId,
    eventTitle: allowed.label,
    eventFile: null,
    tier: allowed.tier,
    block: 'fallback',
  };
}

function resolveActiveEvent(opts = {}) {
  const calendar = loadEventCalendar(opts.calendarPath);
  const et = opts.et || nowET(opts.date);
  return resolveCalendarEntry(calendar, et) || resolveFallbackEvent(calendar, et);
}

module.exports = {
  loadEventCalendar,
  resolveCalendarEntry,
  resolveFallbackEvent,
  resolveActiveEvent,
};
