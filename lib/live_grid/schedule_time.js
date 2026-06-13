/** ET schedule helpers — shared to avoid program_director ↔ event_calendar cycle */

const TZ = 'America/New_York';

function nowET(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  const weekday = parts.weekday?.toLowerCase().slice(0, 3) || 'sun';
  return {
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
  };
}

function parseHm(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function inScheduleBlock(minutes, start, end) {
  if (start === end) return false;
  return start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
}

module.exports = { nowET, parseHm, inScheduleBlock };
