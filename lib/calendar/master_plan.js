/**
 * Master content calendar — production, live streams, and VOD publish schedule.
 * Single source of truth: config/content_calendar.json + data/calendar_overrides.json
 */

const fs = require('fs');
const path = require('path');
const { nowET, parseHm, inScheduleBlock } = require('../live_grid/schedule_time');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'content_calendar.json');
const OVERRIDES_PATH = path.join(REPO_ROOT, 'data', 'calendar_overrides.json');

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return { overrides: [], liveOverrides: [] };
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (_) {
    return { overrides: [], liveOverrides: [] };
  }
}

function saveOverrides(data) {
  fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

function weekdayKey(date = new Date()) {
  const et = nowET(date);
  return et.weekday;
}

function dateKey(date = new Date()) {
  return nowET(date).dateKey;
}

function mondayOfWeek(date = new Date()) {
  const d = new Date(date);
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + daysToMon);
  d.setHours(12, 0, 0, 0);
  return d;
}

function slotApplies(slot, dayIndex, dateStr, overrides) {
  const ov = (overrides.overrides || []).find((o) => o.date === dateStr && o.slotId === slot.id);
  if (ov?.disabled) return { apply: false, reason: ov.reason || 'Owner disabled' };
  if (ov?.forced) return { apply: true, reason: ov.reason || 'Owner forced' };
  if (slot.enabled === false) return { apply: false, reason: slot.disabledReason || 'Disabled in calendar' };
  if (slot.daily) return { apply: true };
  if (slot.days?.length) {
    const key = DAY_NAMES[dayIndex];
    return { apply: slot.days.includes(key) };
  }
  if (slot.when === 'dayAfterGames') return { apply: false, reason: slot.disabledReason || 'Requires games yesterday' };
  return { apply: true };
}

function resolveProductionDay(date, config, overrides) {
  const et = nowET(date);
  const dayIndex = et.weekday === 'sun' ? 6 : DAY_NAMES.indexOf(et.weekday);
  const dk = et.dateKey;
  const items = [];

  for (const slot of config.production?.slots || []) {
    const { apply, reason } = slotApplies(slot, dayIndex, dk, overrides);
    if (!apply) {
      if (slot.daily || slot.days) {
        items.push({ ...slot, date: dk, status: 'skipped', skipReason: reason });
      }
      continue;
    }
    items.push({
      ...slot,
      date: dk,
      status: 'scheduled',
      publishPlatforms: slot.publishPlatforms || [],
      scheduledAtEt: `${slot.time} ET`,
    });
  }
  return items;
}

function resolveLiveDayparts(date, config, overrides) {
  const et = nowET(date);
  const dk = et.dateKey;
  const ytl = config.liveStreams?.youtubeLive?.dayparts || [];
  const liveOv = (overrides.liveOverrides || []).find((o) => o.date === dk);

  const dayparts = ytl.map((dp) => {
    const days = (dp.days || []).map((d) => String(d).slice(0, 3).toLowerCase());
    if (days.length && !days.includes(et.weekday)) return null;
    const ov = liveOv?.daypartId === dp.id ? liveOv : null;
    return {
      ...dp,
      mode: ov?.mode || dp.mode,
      label: ov?.label || dp.label,
      overridden: !!ov,
      overrideReason: ov?.reason || null,
    };
  }).filter(Boolean);

  const twitch = config.liveStreams?.twitchTv || {};
  const twitchOv = liveOv?.twitchTv || null;

  return {
    twitchTv: {
      ...twitch,
      window: twitchOv?.window || twitch.window,
      composition: twitchOv?.composition || twitch.composition,
      overridden: !!twitchOv,
    },
    youtubeLive: { dayparts },
    currentDaypart: resolveCurrentYoutubeDaypart(dayparts, et),
  };
}

function resolveCurrentYoutubeDaypart(dayparts, et) {
  for (const dp of dayparts) {
    const start = parseHm(dp.start);
    const end = parseHm(dp.end);
    if (start == null || end == null) continue;
    if (inScheduleBlock(et.minutes, start, end)) return dp;
  }
  return null;
}

function matchJobStatus(items, persistedJobs = {}) {
  const jobs = Object.entries(persistedJobs).map(([id, j]) => ({
    id,
    contentType: j.contentType,
    stage: j.stage,
    scheduledPublishAt: j.scheduledPublishAt,
    publishedAt: j.publishedAt,
  }));

  return items.map((item) => {
    if (item.status === 'skipped') return item;
    const ct = item.contentType === 'alternate' ? null : item.contentType;
    const related = ct
      ? jobs.filter((j) => j.contentType === ct || j.contentType?.startsWith(String(ct).replace('-short', '')))
      : [];
    const inFlight = related.find((j) => j.stage && !['published', 'failed', 'killed', ''].includes(j.stage));
    const published = related.find((j) => j.stage === 'published');
    const scheduled = related.find((j) => j.stage === 'publish_scheduled' || j.scheduledPublishAt);

    let status = 'scheduled';
    if (published) status = 'published';
    else if (scheduled) status = 'publish_scheduled';
    else if (inFlight) status = 'in_production';

    return {
      ...item,
      status,
      jobHint: inFlight?.id || published?.id || scheduled?.id || null,
    };
  });
}

function buildWeekPlan({ persistedJobs, startDate } = {}) {
  const config = loadConfig();
  const overrides = loadOverrides();
  const mon = mondayOfWeek(startDate || new Date());
  const days = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    const dk = dateKey(d);
    let production = matchJobStatus(resolveProductionDay(d, config, overrides), persistedJobs);
    try {
      const { enrichProductionWithAssignments } = require('./slot_jobs');
      production = enrichProductionWithAssignments(production, dk);
    } catch (_) {}
    const live = resolveLiveDayparts(d, config, overrides);
    days.push({
      date: dateKey(d),
      weekday: weekdayKey(d),
      isToday: dateKey(d) === dateKey(new Date()),
      production,
      live,
    });
  }

  return {
    ok: true,
    timezone: config.timezone,
    guidelines: config.guidelines,
    vodPublish: config.vodPublish,
    schedulingCapabilities: config.schedulingCapabilities || null,
    ownerOverride: config.ownerOverride,
    overridesActive: (overrides.overrides?.length || 0) + (overrides.liveOverrides?.length || 0),
    days,
  };
}

function buildBroadcastToday({ persistedJobs } = {}) {
  const config = loadConfig();
  const overrides = loadOverrides();
  const today = new Date();
  const dk = dateKey(today);
  let production = matchJobStatus(resolveProductionDay(today, config, overrides), persistedJobs);
  try {
    const { enrichProductionWithAssignments } = require('./slot_jobs');
    production = enrichProductionWithAssignments(production.filter((p) => p.status !== 'skipped'), dk);
  } catch (_) {
    production = production.filter((p) => p.status !== 'skipped');
  }
  const live = resolveLiveDayparts(today, config, overrides);
  const liveOv = (overrides.liveOverrides || []).find((o) => o.date === dk);
  const liveStreamsPaused = !!(liveOv?.livePaused
    || (liveOv?.twitchTv?.window === 'off' && liveOv?.youtubeGrid?.window === 'off'));
  const twitchOff = !!(liveOv?.livePaused || liveOv?.twitchTv?.window === 'off');
  const gridOff = !!(liveOv?.livePaused || liveOv?.youtubeGrid?.window === 'off');

  return {
    ok: true,
    date: dk,
    guidelines: config.guidelines,
    production,
    live,
    twitchTv: live.twitchTv,
    youtubeNow: live.currentDaypart,
    vodPublish: config.vodPublish,
    schedulingCapabilities: config.schedulingCapabilities || null,
    liveStreamsPaused,
    twitchAutoOff: twitchOff,
    youtubeGridAutoOff: gridOff,
    livePauseReason: liveOv?.reason || null,
  };
}

function applyOwnerOverride({ pin, type, date, slotId, daypartId, patch, reason }) {
  const { verifyOwnerPin } = require('./owner_gate');
  const gate = verifyOwnerPin(pin);
  if (!gate.ok) return gate;

  const data = loadOverrides();
  const entry = {
    date,
    reason: reason || 'Owner override',
    at: new Date().toISOString(),
    by: 'owner',
  };

  if (type === 'production') {
    const idx = (data.overrides || []).findIndex((o) => o.date === date && o.slotId === slotId);
    const row = { ...entry, slotId, ...patch };
    if (idx >= 0) data.overrides[idx] = row;
    else {
      data.overrides = data.overrides || [];
      data.overrides.push(row);
    }
  } else if (type === 'live') {
    const idx = (data.liveOverrides || []).findIndex((o) => o.date === date && (o.daypartId === daypartId || !daypartId));
    const row = { ...entry, daypartId, ...patch };
    if (idx >= 0) data.liveOverrides[idx] = row;
    else {
      data.liveOverrides = data.liveOverrides || [];
      data.liveOverrides.push(row);
    }
  } else {
    return { ok: false, error: 'Unknown override type' };
  }

  saveOverrides(data);
  return { ok: true, message: 'Override saved', overrides: data };
}

module.exports = {
  loadConfig,
  loadOverrides,
  buildWeekPlan,
  buildBroadcastToday,
  applyOwnerOverride,
  CONFIG_PATH,
  OVERRIDES_PATH,
};
