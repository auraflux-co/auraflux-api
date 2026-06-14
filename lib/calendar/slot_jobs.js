/**
 * Calendar slot ↔ job linking and publish scheduling.
 */

const fs = require('fs');
const path = require('path');
const { parseHm } = require('../live_grid/schedule_time');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'content_calendar.json');
const ASSIGNMENTS_PATH = path.join(REPO_ROOT, 'data', 'calendar_slot_assignments.json');

const SCHEDULABLE_STAGES = new Set(['assembled', 'gate5_forced', 'gate5_failed', 'publish_scheduled']);

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function findSlotConfig(slotId) {
  return (readConfig().production?.slots || []).find((s) => s.id === slotId) || null;
}

function loadAssignments() {
  if (!fs.existsSync(ASSIGNMENTS_PATH)) return { assignments: [] };
  try {
    return JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));
  } catch (_) {
    return { assignments: [] };
  }
}

function saveAssignments(data) {
  fs.mkdirSync(path.dirname(ASSIGNMENTS_PATH), { recursive: true });
  fs.writeFileSync(ASSIGNMENTS_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

/** ET dateKey + HH:MM → ISO-8601 UTC string for scheduling_cron. */
function slotTimeToIso(dateKey, hm) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(utcGuess + offsetHours * 3600000);
    const parts = fmt.formatToParts(candidate).reduce((o, p) => (o[p.type] = p.value, o), {});
    const ck = `${parts.year}-${parts.month}-${parts.day}`;
    const mins = Number(parts.hour) * 60 + Number(parts.minute);
    if (ck === dateKey && mins === h * 60 + mi) return candidate.toISOString();
  }
  return new Date(`${dateKey}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00-04:00`).toISOString();
}

function listEligibleJobs(persistedJobs = {}, contentType, opts = {}) {
  const ct = String(contentType || '').toLowerCase();
  const altTypes = (opts.alternateTypes || []).map((t) => String(t).toLowerCase());
  return Object.entries(persistedJobs)
    .filter(([, card]) => {
      if (!card || card.status === 'dismissed') return false;
      const stage = card.stage || '';
      if (!SCHEDULABLE_STAGES.has(stage)) return false;
      const jct = String(card.contentType || '').toLowerCase();
      if (!ct) return true;
      if (jct === ct) return true;
      if (altTypes.length && altTypes.includes(jct)) return true;
      if (ct === 'alternate' && (jct === 'news-short' || jct === 'twitch-short' || jct === 'sports-short')) return true;
      if (ct === 'news-short' && jct.includes('news') && (jct.includes('short') || jct.includes('clip'))) return true;
      if (ct === 'twitch-short' && jct.includes('twitch') && (jct.includes('short') || jct.includes('clip'))) return true;
      if (ct === 'sports-short' && (jct.includes('sport') || jct.includes('nba')) && (jct.includes('short') || jct.includes('clip'))) return true;
      if (ct === 'news' && jct === 'news') return true;
      if (ct === 'twitch' && jct === 'twitch') return true;
      return false;
    })
    .map(([id, card]) => ({
      jobId: id,
      contentType: card.contentType,
      stage: card.stage,
      title: card.title || card.jobTitle || id,
      scheduledPublishAt: card.scheduledPublishAt || null,
    }))
    .sort((a, b) => (b.jobId > a.jobId ? 1 : -1));
}

function scheduleJobToSlot({ jobId, slotId, date, persistedJobs, saveJobCard }) {
  const card = persistedJobs[jobId];
  if (!card) return { ok: false, error: `Job not found: ${jobId}` };
  const stage = card.stage || '';
  if (!SCHEDULABLE_STAGES.has(stage)) {
    return { ok: false, error: `Job must be assembled before scheduling (stage=${stage})` };
  }

  const slot = findSlotConfig(slotId);
  if (!slot) return { ok: false, error: `Unknown slot: ${slotId}` };

  const scheduledAt = slotTimeToIso(date, slot.time);
  if (new Date(scheduledAt).getTime() <= Date.now()) {
    return { ok: false, error: 'Slot time already passed — schedule for a future day from Calendar' };
  }

  const platforms = slot.publishPlatforms || ['youtube'];
  card.scheduledPublishAt = scheduledAt;
  card.deliverySpec = card.deliverySpec || {};
  card.deliverySpec.scheduledAt = scheduledAt;
  card.deliverySpec.platforms = platforms;
  card.platforms = platforms;
  card.stage = 'publish_scheduled';
  card.calendarSlotId = slotId;
  card.calendarSlotDate = date;

  if (saveJobCard) saveJobCard(jobId, card);

  const data = loadAssignments();
  data.assignments = (data.assignments || []).filter((a) => !(a.date === date && a.slotId === slotId));
  data.assignments.push({
    date, slotId, jobId, scheduledAt, platforms, linkedAt: new Date().toISOString(),
  });
  saveAssignments(data);

  return {
    ok: true,
    jobId,
    slotId,
    scheduledAt,
    platforms,
    message: `Publish scheduled for ${slot.time} ET on ${platforms.join(', ')}`,
  };
}

function assignmentForSlot(date, slotId) {
  return (loadAssignments().assignments || []).find((a) => a.date === date && a.slotId === slotId) || null;
}

function enrichProductionWithAssignments(items, dateKey) {
  return items.map((item) => {
    const link = assignmentForSlot(dateKey, item.id);
    if (!link) return item;
    return {
      ...item,
      jobHint: link.jobId,
      scheduledPublishAt: link.scheduledAt,
      status: item.status === 'published' ? 'published' : 'publish_scheduled',
      linkedPlatforms: link.platforms,
    };
  });
}

function getStreamWindows() {
  const config = readConfig();
  const { parseWindow } = require('../services/stream_scheduler');
  const tt = config.liveStreams?.twitchTv?.window || '15:00-18:00';
  const parts = config.liveStreams?.youtubeLive?.dayparts || [];
  let gridStart = 18 * 60;
  let gridEnd = 3 * 60;
  if (parts.length) {
    gridStart = parseHm(parts[0].start) ?? gridStart;
    gridEnd = parseHm(parts[parts.length - 1].end) ?? gridEnd;
  }
  const gridStr = `${String(Math.floor(gridStart / 60)).padStart(2, '0')}:${String(gridStart % 60).padStart(2, '0')}-${String(Math.floor(gridEnd / 60)).padStart(2, '0')}:${String(gridEnd % 60).padStart(2, '0')}`;
  const envTv = process.env.LIVE_TV_WINDOW;
  const envGrid = process.env.LIVE_GRID_WINDOW;
  return {
    tv: parseWindow(envTv && envTv !== 'off' ? envTv : tt, parseWindow(tt)),
    grid: parseWindow(envGrid || gridStr, parseWindow(gridStr)),
    fromCalendar: !envTv && !envGrid,
  };
}

function getLiveTvStartBody() {
  try {
    const { loadCuratedPlaylist } = require('../live_tv/curated_playlist');
    const curated = loadCuratedPlaylist();
    if (curated?.videos?.length) {
      return { videos: curated.videos, curated: curated.curated !== false };
    }
  } catch (_) {}
  return { curated: true };
}

function getLiveGridStartBody(persistedJobs) {
  const { buildBroadcastToday } = require('./master_plan');
  const { resolveScheduledMode, loadPrograms } = require('../live_grid/program_director');
  const { resolveActiveEvent } = require('../live_grid/event_calendar');
  const { resolveFileSource } = require('../live_grid/file_sources');
  const today = buildBroadcastToday({ persistedJobs: persistedJobs || {} });
  const dp = today.youtubeNow;
  let mode = dp?.mode;
  if (!mode) mode = resolveScheduledMode(loadPrograms()).mode;
  const body = { privacyStatus: 'public', programMode: mode || 'auto' };
  if (mode === 'event_night') {
    const ev = resolveActiveEvent();
    if (ev?.eventTitle) body.eventTitle = ev.eventTitle;
    if (ev?.eventFile) body.eventFile = ev.eventFile;
    if (ev?.eventFeedUrl) body.eventFeedUrl = ev.eventFeedUrl;
    else {
      const fromEnv = resolveFileSource('event_primary', loadPrograms());
      if (fromEnv) body.eventFile = fromEnv;
    }
  }
  if (mode === 'news_desk') {
    try {
      const { loadNewsDeskQueue } = require('./live_also');
      const latest = loadNewsDeskQueue().items?.[0];
      if (latest?.path) {
        body.fileOverrides = { ...(body.fileOverrides || {}), news_primary: latest.path };
        body.headline = body.headline || latest.title;
      }
    } catch (_) {}
  }
  if (!body.eventTitle && dp?.label) body.eventTitle = dp.label;
  return body;
}

module.exports = {
  slotTimeToIso,
  listEligibleJobs,
  scheduleJobToSlot,
  assignmentForSlot,
  enrichProductionWithAssignments,
  getStreamWindows,
  getLiveTvStartBody,
  getLiveGridStartBody,
  findSlotConfig,
  ASSIGNMENTS_PATH,
};
