/**
 * Schedule-ahead YouTube broadcast — prepare RTMP + metadata before encoder starts.
 * State file survives until consumed by /live-grid/start or cleared.
 */

const fs = require('fs');
const path = require('path');

const PREPARED_PATH = path.join(__dirname, '..', '..', 'data', 'live_grid_prepared.json');

function scheduleAheadEnabled() {
  return String(process.env.LIVE_GRID_SCHEDULE_AHEAD || 'off').toLowerCase() === 'on';
}

function prepareAheadMinutes() {
  return Math.max(5, parseInt(process.env.LIVE_GRID_PREPARE_AHEAD_MINUTES || '30', 10));
}

/** Minutes-from-midnight → ISO scheduled start (next occurrence in ET). */
function gridStartIsoFromMinutes(startMinutes, date = new Date()) {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  const h = Math.floor(startMinutes / 60);
  const mi = startMinutes % 60;
  let dk = `${et.year}-${et.month}-${et.day}`;
  const nowM = (Number(et.hour) % 24) * 60 + Number(et.minute);
  if (startMinutes <= nowM) {
    const d = new Date(`${dk}T12:00:00`);
    d.setDate(d.getDate() + 1);
    dk = d.toISOString().slice(0, 10);
  }
  const { slotTimeToIso } = require('../calendar/slot_jobs');
  return slotTimeToIso(dk, `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
}

function loadPrepared() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREPARED_PATH, 'utf8'));
    if (!raw?.broadcastId || !raw?.rtmpUrl) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function savePrepared(data) {
  fs.mkdirSync(path.dirname(PREPARED_PATH), { recursive: true });
  fs.writeFileSync(PREPARED_PATH, `${JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2)}\n`);
}

function clearPrepared() {
  try { fs.unlinkSync(PREPARED_PATH); } catch (_) {}
}

/** True when now is in [windowStart - ahead, windowStart). */
function inPrepareWindow(nowMinutes, window, aheadMin = prepareAheadMinutes()) {
  const start = window.start;
  let prepStart = start - aheadMin;
  if (prepStart < 0) prepStart += 24 * 60;
  if (start > window.end || window.end > start) {
    if (prepStart < start) return nowMinutes >= prepStart && nowMinutes < start;
    return nowMinutes >= prepStart || nowMinutes < start;
  }
  return nowMinutes >= prepStart && nowMinutes < start;
}

function preparedIsStale(prepared, maxAgeMs = 6 * 3600000) {
  if (!prepared?.savedAt) return true;
  return Date.now() - new Date(prepared.savedAt).getTime() > maxAgeMs;
}

function scheduledStartReady(prepared, slackMs = 5 * 60 * 1000) {
  if (!prepared?.scheduledStartTime) return true;
  return Date.now() >= new Date(prepared.scheduledStartTime).getTime() - slackMs;
}

module.exports = {
  PREPARED_PATH,
  scheduleAheadEnabled,
  prepareAheadMinutes,
  gridStartIsoFromMinutes,
  loadPrepared,
  savePrepared,
  clearPrepared,
  inPrepareWindow,
  preparedIsStale,
  scheduledStartReady,
};
