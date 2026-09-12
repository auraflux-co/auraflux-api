'use strict';
/**
 * Creator brand month calendar — plan cadence vs published/scheduled jobs.
 * Customer brand month calendar — not ops/broadcast calendar (lib/calendar/*).
 */

const DEFAULT_TARGETS = { short: 1, longform: 0, live: 0 };

function emptyPlan() {
  return {
    version: 1,
    timezone: 'UTC',
    defaultDailyTargets: { ...DEFAULT_TARGETS },
    months: {},
  };
}

function normalizePlan(raw) {
  const base = emptyPlan();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 1,
    timezone: raw.timezone || 'UTC',
    defaultDailyTargets: {
      ...DEFAULT_TARGETS,
      ...(raw.defaultDailyTargets || {}),
    },
    months: raw.months && typeof raw.months === 'object' ? raw.months : {},
  };
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseYearMonth(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function getPlannedForDay(plan, y, m, d) {
  const mk = monthKey(y, m);
  const dk = dateKey(y, m, d);
  const month = plan.months?.[mk] || {};
  const dayPlan = month.days?.[dk];
  const defaults = month.defaultDailyTargets || plan.defaultDailyTargets || DEFAULT_TARGETS;
  const merged = { ...defaults, ...(dayPlan || {}) };
  return {
    short: Math.max(0, Number(merged.short) || 0),
    longform: Math.max(0, Number(merged.longform) || 0),
    live: Math.max(0, Number(merged.live) || 0),
    note: typeof merged.note === 'string' ? merged.note : '',
    custom: !!dayPlan,
  };
}

function setDayPlan(plan, y, m, d, patch) {
  const next = normalizePlan(plan);
  const mk = monthKey(y, m);
  const dk = dateKey(y, m, d);
  if (!next.months[mk]) next.months[mk] = { days: {} };
  if (!next.months[mk].days) next.months[mk].days = {};
  const prev = next.months[mk].days[dk] || {};
  next.months[mk].days[dk] = {
    short: Math.max(0, Number(patch.short ?? prev.short ?? next.months[mk].defaultDailyTargets?.short ?? next.defaultDailyTargets.short) || 0),
    longform: Math.max(0, Number(patch.longform ?? prev.longform ?? next.months[mk].defaultDailyTargets?.longform ?? next.defaultDailyTargets.longform) || 0),
    live: Math.max(0, Number(patch.live ?? prev.live ?? next.months[mk].defaultDailyTargets?.live ?? next.defaultDailyTargets.live) || 0),
    note: patch.note != null ? String(patch.note).slice(0, 500) : (prev.note || ''),
  };
  return next;
}

function setMonthDefaults(plan, y, m, targets) {
  const next = normalizePlan(plan);
  const mk = monthKey(y, m);
  if (!next.months[mk]) next.months[mk] = { days: {} };
  next.months[mk].defaultDailyTargets = {
    short: Math.max(0, Number(targets.short) || 0),
    longform: Math.max(0, Number(targets.longform) || 0),
    live: Math.max(0, Number(targets.live) || 0),
  };
  return next;
}

function classifyJobForm(job) {
  const spec = job.job_spec || job.spec || {};
  const form =
    job.formType ||
    spec.formType ||
    spec.formFactor ||
    (spec.templateId === 'short-form' ? 'short' : null) ||
    spec.contentType;
  const s = String(form || '').toLowerCase();
  if (s.includes('live') || s === 'stream') return 'live';
  if (s.includes('long') || s === 'vod' || s === 'video') return 'longform';
  return 'short';
}

function jobTimeIso(job) {
  const spec = typeof job.job_spec === 'string'
    ? (() => { try { return JSON.parse(job.job_spec); } catch { return {}; } })()
    : (job.job_spec || {});
  return (
    job.scheduled_publish_at ||
    job.published_at ||
    spec.scheduledPublishAt ||
    spec.publishedAt ||
    job.updated_at ||
    null
  );
}

function toDateKeyUTC(isoOrMs) {
  if (!isoOrMs) return null;
  const d = new Date(typeof isoOrMs === 'number' ? isoOrMs : isoOrMs);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function statusOfJob(job) {
  const spec = typeof job.job_spec === 'string'
    ? (() => { try { return JSON.parse(job.job_spec); } catch { return {}; } })()
    : (job.job_spec || {});
  return String(job.status || spec.status || '').toLowerCase();
}

function isPublishedOrScheduled(job) {
  const st = statusOfJob(job);
  if (['published', 'queued_scheduled'].includes(st)) return true;
  if (job.scheduled_publish_at || job.published_at) return true;
  const spec = typeof job.job_spec === 'object' ? job.job_spec : {};
  return !!(spec.scheduledPublishAt || spec.publishedAt);
}

function isEligibleToSchedule(job) {
  const st = statusOfJob(job);
  if (['published', 'cancelled', 'failed', 'credit_paused'].includes(st)) return false;
  // Ready-ish outputs or already scheduled (for reschedule)
  return ['complete', 'staged', 'operator_review', 'queued_scheduled', 'held', 'processing', 'running'].includes(st)
    || !!job.scheduled_publish_at;
}

/**
 * Build month payload for Creator Schedule.
 */
function buildMonthView(planRaw, jobs, year, month) {
  const plan = normalizePlan(planRaw);
  const mk = monthKey(year, month);
  const dim = daysInMonth(year, month);
  const monthDefaults = plan.months?.[mk]?.defaultDailyTargets || plan.defaultDailyTargets;

  const byDay = {};
  for (let d = 1; d <= dim; d++) {
    const dk = dateKey(year, month, d);
    const planned = getPlannedForDay(plan, year, month, d);
    byDay[dk] = {
      date: dk,
      planned,
      actual: { short: 0, longform: 0, live: 0, total: 0 },
      jobs: [],
      status: 'empty', // empty | met | partial | missed | future
    };
  }

  const todayKey = new Date().toISOString().slice(0, 10);

  for (const job of jobs || []) {
    if (!isPublishedOrScheduled(job)) continue;
    const iso = jobTimeIso(job);
    const dk = toDateKeyUTC(iso);
    if (!dk || !byDay[dk]) continue;
    const form = classifyJobForm(job);
    byDay[dk].actual[form] = (byDay[dk].actual[form] || 0) + 1;
    byDay[dk].actual.total += 1;
    const spec = typeof job.job_spec === 'object' ? job.job_spec : {};
    byDay[dk].jobs.push({
      jobId: job.id || job.jobId,
      title: String(spec.title || spec.topic || spec.metadata?.title || job.id || '').slice(0, 120),
      form,
      status: statusOfJob(job),
      at: typeof iso === 'number' ? new Date(iso).toISOString() : String(iso),
    });
  }

  const days = [];
  let plannedDays = 0;
  let metDays = 0;
  for (let d = 1; d <= dim; d++) {
    const dk = dateKey(year, month, d);
    const cell = byDay[dk];
    const pTotal = cell.planned.short + cell.planned.longform + cell.planned.live;
    if (pTotal > 0) plannedDays += 1;
    if (dk > todayKey) {
      cell.status = pTotal > 0 ? 'planned' : 'empty';
    } else if (pTotal <= 0 && cell.actual.total <= 0) {
      cell.status = 'empty';
    } else if (cell.actual.total >= pTotal && pTotal > 0) {
      cell.status = 'met';
      metDays += 1;
    } else if (cell.actual.total > 0) {
      cell.status = 'partial';
    } else if (pTotal > 0) {
      cell.status = 'missed';
    } else {
      cell.status = 'empty';
    }
    days.push(cell);
  }

  // Week grid: Monday-first rows of date keys (null = padding)
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 Sun
  const mondayOffset = (firstDow + 6) % 7; // Mon=0
  const cells = [];
  for (let i = 0; i < mondayOffset; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(dateKey(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return {
    ok: true,
    month: mk,
    year,
    monthNum: month,
    defaults: monthDefaults,
    globalDefaults: plan.defaultDailyTargets,
    weeks,
    daysByDate: byDay,
    days,
    summary: { plannedDays, metDays, dayCount: dim },
  };
}

function listEligibleJobs(jobs, limit = 30) {
  const out = [];
  for (const job of jobs || []) {
    if (!isEligibleToSchedule(job)) continue;
    const spec = typeof job.job_spec === 'object' ? job.job_spec : {};
    out.push({
      jobId: job.id || job.jobId,
      title: String(spec.title || spec.topic || job.id || '').slice(0, 120),
      status: statusOfJob(job),
      form: classifyJobForm(job),
      scheduledPublishAt: job.scheduled_publish_at
        ? new Date(Number(job.scheduled_publish_at) || job.scheduled_publish_at).toISOString()
        : (spec.scheduledPublishAt || null),
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  DEFAULT_TARGETS,
  emptyPlan,
  normalizePlan,
  monthKey,
  dateKey,
  parseYearMonth,
  getPlannedForDay,
  setDayPlan,
  setMonthDefaults,
  buildMonthView,
  listEligibleJobs,
  classifyJobForm,
};
