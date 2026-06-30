'use strict';

/**
 * Monthly content calendar — planned cadence vs actual publishes (jobs + YouTube).
 */

const fs = require('fs');
const path = require('path');
const { nowET } = require('../live_grid/schedule_time');
const { classifyJobCard, classifyYoutubeItem, formatIcon, pillarIcon } = require('./content_taxonomy');
const { formatTimeEt } = require('./youtube_studio_sync');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, 'data', 'monthly_content_plan.json');

const DEFAULT_TARGETS = { short: 3, longform: 1, live: 1 };

function loadMonthlyPlan() {
  if (!fs.existsSync(PLAN_PATH)) {
    return { version: 1, timezone: 'America/New_York', defaultDailyTargets: { ...DEFAULT_TARGETS }, months: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  } catch (_) {
    return { version: 1, timezone: 'America/New_York', defaultDailyTargets: { ...DEFAULT_TARGETS }, months: {} };
  }
}

function saveMonthlyPlan(data) {
  fs.mkdirSync(path.dirname(PLAN_PATH), { recursive: true });
  fs.writeFileSync(PLAN_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

function monthStorageKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function dateKeyForDay(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function etDateKeyFromIso(iso) {
  if (!iso) return null;
  return nowET(new Date(iso)).dateKey;
}

function getPlannedForDay(planData, dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  const mk = monthStorageKey(y, m);
  const month = planData.months?.[mk] || {};
  const dayPlan = month.days?.[dateKey];
  const defaults = month.defaultDailyTargets || planData.defaultDailyTargets || DEFAULT_TARGETS;
  const merged = { ...defaults, ...(dayPlan || {}) };
  return {
    short: Number(merged.short) || 0,
    longform: Number(merged.longform) || 0,
    live: Number(merged.live) || 0,
    note: merged.note || '',
    custom: !!dayPlan,
  };
}

function jobPublishTimestamp(card) {
  if (card.stage === 'published' && card.publishedAt) return card.publishedAt;
  if (card.stage === 'published') {
    return card.publishRecord?.publishedAt || card.gate5Result?.publishedAt || card.assembledAt || null;
  }
  if (card.scheduledPublishAt) return card.scheduledPublishAt;
  return null;
}

function jobStatusForCalendar(card) {
  if (card.stage === 'published') return 'published';
  if (card.stage === 'publish_scheduled' || card.scheduledPublishAt) return 'scheduled';
  if (['awaiting_review', 'metadata_review', 'assembled', 'gate5_running', 'gate5_forced'].includes(card.stage)) {
    return 'ready';
  }
  return null;
}

function collectJobItems(persistedJobs = {}) {
  const items = [];
  for (const [jobId, card] of Object.entries(persistedJobs || {})) {
    if (!card || card.status === 'dismissed') continue;
    const status = jobStatusForCalendar(card);
    if (!status) continue;
    const ts = jobPublishTimestamp(card);
    if (!ts) continue;
    const { format, pillar } = classifyJobCard(card);
    const title = card.publishCopy?.youtube?.title
      || card.publishCopy?.platforms?.youtube?.title
      || card.title
      || card.scriptTitle
      || jobId;
    items.push({
      source: 'job',
      jobId,
      title: String(title).slice(0, 120),
      format,
      pillar,
      status,
      dateKey: etDateKeyFromIso(ts),
      at: ts,
      publishAt: ts,
      timeEt: formatTimeEt(ts),
      youtubeVideoId: card.youtubeVideoId || null,
      contentType: card.contentType || null,
      calendarSlotId: card.calendarSlotId || null,
    });
  }
  return items;
}

function collectYoutubeItems(youtubeItems = []) {
  return (youtubeItems || []).map((it) => {
    const { format, pillar } = classifyYoutubeItem(it);
    return {
      source: it.source || 'youtube_studio',
      jobId: it.jobId || null,
      youtubeVideoId: it.videoId || it.broadcastId || null,
      title: String(it.title || '').slice(0, 120),
      format,
      pillar,
      status: it.status === 'live_scheduled' ? 'scheduled' : (it.status || 'scheduled'),
      dateKey: it.dateKey || etDateKeyFromIso(it.publishAt),
      at: it.publishAt,
      publishAt: it.publishAt,
      timeEt: it.timeEt || (it.publishAt ? formatTimeEt(it.publishAt) : ''),
      url: it.url || null,
      contentType: it.kind || null,
    };
  });
}

function mergeActualItems(jobItems, ytItems) {
  const byKey = new Map();
  for (const item of jobItems) {
    const key = item.jobId || `${item.source}:${item.youtubeVideoId || item.title}`;
    byKey.set(key, item);
  }
  for (const item of ytItems) {
    const key = item.jobId
      ? `job:${item.jobId}`
      : `yt:${item.youtubeVideoId || item.title}:${item.dateKey}`;
    if (item.jobId && byKey.has(item.jobId)) {
      const prev = byKey.get(item.jobId);
      const ytFirst = item.source === 'youtube_studio' || String(item.source || '').includes('youtube');
      byKey.set(item.jobId, {
        ...prev,
        ...item,
        title: prev.title || item.title,
        jobId: item.jobId || prev.jobId,
        at: ytFirst ? (item.at || prev.at) : (prev.at || item.at),
        publishAt: ytFirst ? (item.publishAt || prev.publishAt) : (prev.publishAt || item.publishAt),
        timeEt: ytFirst ? (item.timeEt || prev.timeEt) : (prev.timeEt || item.timeEt),
        youtubeVideoId: item.youtubeVideoId || prev.youtubeVideoId,
        url: item.url || prev.url,
        source: 'job+youtube',
      });
      continue;
    }
    if (item.youtubeVideoId) {
      let matchedByVid = false;
      for (const [k, prev] of byKey.entries()) {
        if (prev.youtubeVideoId && prev.youtubeVideoId === item.youtubeVideoId) {
          byKey.set(k, {
            ...prev,
            ...item,
            jobId: prev.jobId || item.jobId,
            at: item.at || prev.at,
            publishAt: item.publishAt || prev.publishAt,
            timeEt: item.timeEt || prev.timeEt,
            url: item.url || prev.url,
            source: prev.jobId ? 'job+youtube' : item.source,
          });
          matchedByVid = true;
          break;
        }
      }
      if (matchedByVid) continue;
    }
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return sortCalendarItems([...byKey.values()]);
}

function sortCalendarItems(items) {
  return [...items].sort((a, b) => {
    const ta = new Date(a.at || a.publishAt || 0).getTime();
    const tb = new Date(b.at || b.publishAt || 0).getTime();
    return ta - tb;
  });
}

function countByFormat(items) {
  const counts = { short: 0, longform: 0, live: 0 };
  for (const it of items) {
    if (it.format && counts[it.format] != null) counts[it.format] += 1;
  }
  return counts;
}

function goalStatus(planned, actualCounts, isPast) {
  const formats = ['short', 'longform', 'live'];
  const detail = {};
  let met = 0;
  let total = 0;
  for (const f of formats) {
    const target = planned[f] || 0;
    if (target <= 0) continue;
    total += 1;
    const got = actualCounts[f] || 0;
    detail[f] = { planned: target, actual: got, met: got >= target };
    if (got >= target) met += 1;
  }
  if (total === 0) return { state: 'no_plan', met: 0, total: 0, detail };
  if (met === total) return { state: isPast ? 'met' : 'on_track', met, total, detail };
  if (!isPast) return { state: 'pending', met, total, detail };
  return { state: met > 0 ? 'partial' : 'missed', met, total, detail };
}

function buildMonthPlan({ year, month, persistedJobs = {}, youtubeItems = [] } = {}) {
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || (new Date().getMonth() + 1);
  const planData = loadMonthlyPlan();
  const todayKey = nowET(new Date()).dateKey;
  const dim = daysInMonth(y, m);
  const firstDow = new Date(y, m - 1, 1).getDay();
  const pad = firstDow === 0 ? 6 : firstDow - 1;

  const allJobItems = collectJobItems(persistedJobs);
  const allYtItems = collectYoutubeItems(youtubeItems);

  const days = [];
  for (let d = 1; d <= dim; d++) {
    const dateKey = dateKeyForDay(y, m, d);
    const planned = getPlannedForDay(planData, dateKey);
    const isPast = dateKey < todayKey;
    const isToday = dateKey === todayKey;

    const dayItems = mergeActualItems(
      allJobItems.filter((it) => it.dateKey === dateKey),
      allYtItems.filter((it) => it.dateKey === dateKey),
    );
    const actualCounts = countByFormat(dayItems);
    const goals = goalStatus(planned, actualCounts, isPast);

    days.push({
      date: dateKey,
      day: d,
      isToday,
      isPast,
      planned,
      actual: { counts: actualCounts, items: sortCalendarItems(dayItems) },
      goals,
    });
  }

  const monthTotals = days.reduce((acc, day) => {
    acc.planned.short += day.planned.short;
    acc.planned.longform += day.planned.longform;
    acc.planned.live += day.planned.live;
    acc.actual.short += day.actual.counts.short;
    acc.actual.longform += day.actual.counts.longform;
    acc.actual.live += day.actual.counts.live;
    if (day.isPast && day.goals.state === 'met') acc.daysMet += 1;
    if (day.isPast && day.goals.total > 0) acc.daysWithPlan += 1;
    return acc;
  }, {
    planned: { short: 0, longform: 0, live: 0 },
    actual: { short: 0, longform: 0, live: 0 },
    daysMet: 0,
    daysWithPlan: 0,
  });

  return {
    ok: true,
    year: y,
    month: m,
    monthLabel: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1)),
    timezone: planData.timezone || 'America/New_York',
    defaultDailyTargets: planData.defaultDailyTargets || DEFAULT_TARGETS,
    gridPad: pad,
    days,
    monthTotals,
    northStarReminder: {
      short: '3–5/day',
      longform: '1–2/day',
      live: '0–2/day',
    },
  };
}

function setDayPlan({ year, month, dateKey, targets, note }) {
  const planData = loadMonthlyPlan();
  const mk = monthStorageKey(year, month);
  planData.months[mk] = planData.months[mk] || { days: {} };
  planData.months[mk].days = planData.months[mk].days || {};
  planData.months[mk].days[dateKey] = {
    short: Number(targets.short) || 0,
    longform: Number(targets.longform) || 0,
    live: Number(targets.live) || 0,
    note: note || '',
    updatedAt: new Date().toISOString(),
  };
  saveMonthlyPlan(planData);
  return { ok: true, dateKey, plan: planData.months[mk].days[dateKey] };
}

function setMonthDefaultTargets({ year, month, targets }) {
  const planData = loadMonthlyPlan();
  const mk = monthStorageKey(year, month);
  planData.months[mk] = planData.months[mk] || { days: {} };
  planData.months[mk].defaultDailyTargets = {
    short: Number(targets.short) || 0,
    longform: Number(targets.longform) || 0,
    live: Number(targets.live) || 0,
  };
  saveMonthlyPlan(planData);
  return { ok: true, defaultDailyTargets: planData.months[mk].defaultDailyTargets };
}

function stampJobCalendarMeta(card) {
  const meta = classifyJobCard(card);
  card.calendarFormat = meta.format;
  card.calendarPillar = meta.pillar;
  return card;
}

function jobYoutubeVideoId(card = {}) {
  if (card.youtubeVideoId) return card.youtubeVideoId;
  const candidates = [
    card.gate5Result?.platforms?.youtube?.url,
    card.gate5Result?.platforms?.youtube?.videoId,
    card.publish_results?.youtube?.url,
    card.youtubeUrl,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    const m = s.match(/[?&]v=([^&]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  }
  return null;
}

function eachDateKeyInRange(startDate, endDate, fn) {
  const d = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  while (d <= end) {
    fn(nowET(d).dateKey);
    d.setDate(d.getDate() + 1);
  }
}

function buildCalendarRangeReport({ startDate, endDate, persistedJobs = {}, youtubeItems = [] } = {}) {
  const start = String(startDate || '');
  const end = String(endDate || start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { ok: false, error: 'startDate and endDate required (YYYY-MM-DD)' };
  }
  if (start > end) return { ok: false, error: 'startDate must be <= endDate' };

  const planData = loadMonthlyPlan();
  const allJobItems = collectJobItems(persistedJobs);
  const allYtItems = collectYoutubeItems(youtubeItems);
  const todayKey = nowET(new Date()).dateKey;

  const planned = { short: 0, longform: 0, live: 0 };
  const days = [];
  const rangeItems = [];

  eachDateKeyInRange(start, end, (dateKey) => {
    const dayPlanned = getPlannedForDay(planData, dateKey);
    planned.short += dayPlanned.short;
    planned.longform += dayPlanned.longform;
    planned.live += dayPlanned.live;

    const dayItems = mergeActualItems(
      allJobItems.filter((it) => it.dateKey === dateKey),
      allYtItems.filter((it) => it.dateKey === dateKey),
    );
    rangeItems.push(...dayItems);
    const actualCounts = countByFormat(dayItems);
    const isPast = dateKey < todayKey;
    days.push({
      date: dateKey,
      isPast,
      planned: dayPlanned,
      actual: { counts: actualCounts, items: sortCalendarItems(dayItems) },
      goals: goalStatus(dayPlanned, actualCounts, isPast),
    });
  });

  const actualCounts = countByFormat(rangeItems);
  const jobIds = [...new Set(rangeItems.map((it) => it.jobId).filter(Boolean))];
  const youtubeVideoIds = [...new Set(rangeItems.map((it) => it.youtubeVideoId).filter(Boolean))];
  const jobVideoMap = {};
  for (const [jid, card] of Object.entries(persistedJobs || {})) {
    const vid = jobYoutubeVideoId(card);
    if (vid) jobVideoMap[jid] = vid;
  }
  for (const jid of jobIds) {
    if (!jobVideoMap[jid] && persistedJobs[jid]) {
      const vid = jobYoutubeVideoId(persistedJobs[jid]);
      if (vid) jobVideoMap[jid] = vid;
    }
  }

  return {
    ok: true,
    startDate: start,
    endDate: end,
    label: start === end ? start : `${start} → ${end}`,
    planned,
    actual: { counts: actualCounts, items: rangeItems },
    days,
    jobIds,
    youtubeVideoIds: [...new Set([...youtubeVideoIds, ...Object.values(jobVideoMap)])],
    jobVideoMap,
    goals: goalStatus(planned, actualCounts, end < todayKey),
  };
}

module.exports = {
  loadMonthlyPlan,
  saveMonthlyPlan,
  buildMonthPlan,
  buildCalendarRangeReport,
  setDayPlan,
  setMonthDefaultTargets,
  stampJobCalendarMeta,
  jobYoutubeVideoId,
  formatIcon,
  pillarIcon,
  DEFAULT_TARGETS,
};
