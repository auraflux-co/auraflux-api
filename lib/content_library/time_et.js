'use strict';

function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = (t) => fmt.find((p) => p.type === t)?.value;
  return {
    ymd: `${g('year')}-${g('month')}-${g('day')}`,
    hms: `${g('hour')}:${g('minute')}:${g('second')}`,
  };
}

function findEtInstantMs(ymd, hour, min, sec) {
  const [y, m, d] = ymd.split('-').map(Number);
  const want = `${ymd} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  let hi = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const { ymd: gotYmd, hms } = etParts(new Date(mid));
    const key = `${gotYmd} ${hms}`;
    if (key < want) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function etYmd(date = new Date()) {
  return etParts(date).ymd;
}

function etDayBoundsUtc(ymd) {
  const startMs = findEtInstantMs(ymd, 0, 0, 0);
  const endMs = findEtInstantMs(ymd, 23, 59, 59) + 999;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startMs,
    endMs,
    ingestDate: ymd,
  };
}

function yesterdayEtBounds() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return etDayBoundsUtc(etYmd(d));
}

const WINDOW_MS = {
  '24h': 24 * 3600000,
  '7d': 7 * 24 * 3600000,
  '30d': 30 * 24 * 3600000,
};

function windowToSinceMs(windowKey) {
  const key = String(windowKey || 'all').toLowerCase();
  if (key === 'all' || key === 'any') return null;
  const ms = WINDOW_MS[key];
  if (!ms) return null;
  return Date.now() - ms;
}

module.exports = {
  etYmd,
  etDayBoundsUtc,
  yesterdayEtBounds,
  windowToSinceMs,
  WINDOW_MS,
};
