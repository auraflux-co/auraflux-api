/**
 * Broadcast content board — what’s scheduled, in the pipeline, ready to air, and missing.
 * Plain-language view for the Broadcast dashboard (non-operator friendly).
 */

const path = require('path');
const { buildTvCatalog, classifyTvContent, friendlyTvLabel } = require('../live_tv/curated_playlist');
const { resolveActiveEvent } = require('../live_grid/event_calendar');
const { nowET } = require('../live_grid/schedule_time');

const REPO_ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');

const STAGE_LABELS = {
  script_ready: 'Script ready — review in Job Queue',
  all_sent: 'Avatar scenes rendering',
  avatar_in_progress: 'Avatar rendering in progress',
  heygen_done: 'Rendering done — ready to assemble',
  awaiting_manual_segments: 'Waiting on manual segments',
  assembling: 'Assembling final video',
  assembled: 'Assembled — ready to publish',
  published: 'Published',
  gate5_forced: 'Published',
};

const DONE_STAGES = new Set(['published', 'done', 'completed', 'gate5_forced']);
const SKIP_STAGES = new Set(['failed', 'killed', '']);

function inferStage(job) {
  return job.stage || job.status || 'unknown';
}

function jobTitle(job, jobId) {
  const ct = job.contentType || 'video';
  const date = job.date ? String(job.date).split(',')[0] : '';
  if (ct === 'news') return date ? `News desk — ${date}` : 'News desk compilation';
  if (ct === 'nba') return date ? `NBA highlights — ${date}` : 'NBA highlights';
  if (ct === 'twitch-short') return 'Twitch short (streamer clips — not for Twitch TV loop)';
  if (ct === 'twitch') return date ? `Twitch Soup — ${date}` : 'Twitch Soup (Bobby G avatar VOD)';
  return jobId;
}

function isDismissed(job) {
  return (job.status || '') === 'dismissed';
}

function newestReadyMtime(catalog, kind) {
  const list = catalog[kind] || [];
  if (!list.length) return null;
  return list[0].mtime;
}

function daysSince(ms) {
  if (!ms) return null;
  return Math.floor((Date.now() - ms) / (86400 * 1000));
}

/** Same rules as dashboard Content Calendar (Mon=0 week index). */
function buildTodaySchedule(date = new Date()) {
  const et = nowET(date);
  const d = new Date(date);
  const dow = d.getDay(); // 0 Sun
  const weekIndex = dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
  const isTwitchLongDay = weekIndex >= 2; // Wed–Sun

  const items = [];
  items.push({
    id: 'news_long',
    kind: 'news',
    label: 'News desk compilation',
    slot: '10:45 AM ET',
    priority: 'high',
    forTwitchTv: true,
  });
  if (isTwitchLongDay) {
    items.push({
      id: 'twitch_long',
      kind: 'twitch',
      label: 'Twitch Soup — Bobby G avatar VOD',
      slot: '11:00 AM ET',
      priority: 'medium',
      forTwitchTv: true,
    });
  }
  items.push({
    id: 'news_note',
    kind: 'info',
    label: 'NBA long-form paused — season over (NFL prep starts August)',
    slot: '—',
    priority: 'info',
    forTwitchTv: false,
  });
  return { et, weekIndex, items, isTwitchLongDay };
}

function findPipelineJobs(persistedJobs = {}) {
  const rows = [];
  for (const [jobId, job] of Object.entries(persistedJobs)) {
    if (!job || isDismissed(job)) continue;
    const stage = inferStage(job);
    if (SKIP_STAGES.has(stage) || DONE_STAGES.has(stage)) continue;
    const ct = job.contentType || '';
    rows.push({
      jobId,
      contentType: ct,
      stage,
      stageLabel: STAGE_LABELS[stage] || stage.replace(/_/g, ' '),
      title: jobTitle(job, jobId),
      date: job.date || null,
      forTwitchTv: ct === 'news' || ct === 'twitch',
      isShort: ct === 'twitch-short',
      savedAt: job.savedAt || null,
    });
  }
  rows.sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
  return rows;
}

function matchScheduleStatus(scheduleItems, pipeline, catalog) {
  const newsPipe = pipeline.filter(j => j.contentType === 'news' && !DONE_STAGES.has(j.stage));
  const twitchPipe = pipeline.filter(j => j.contentType === 'twitch');
  const newsReady = (catalog.news || []).length;
  const twitchReady = (catalog.bobbyg || []).length;
  const newsAge = daysSince(newestReadyMtime(catalog, 'news'));
  const twitchAge = daysSince(newestReadyMtime(catalog, 'bobbyg'));

  return scheduleItems.filter(i => i.kind !== 'info').map((item) => {
    let status = 'gap';
    let detail = '';

    if (item.kind === 'news') {
      if (newsPipe.length) {
        status = 'pipeline';
        detail = `${newsPipe.length} job(s) in progress — ${newsPipe[0].stageLabel}`;
      } else if (newsReady && newsAge != null && newsAge <= 2) {
        status = 'ready';
        detail = `Fresh news VOD on disk (${newsAge === 0 ? 'today' : newsAge + 'd ago'})`;
      } else if (newsReady) {
        status = 'stale';
        detail = newsAge != null ? `Last news VOD is ${newsAge} days old — need new run` : 'News VOD exists but dated';
      } else {
        status = 'gap';
        detail = 'No news job running and no news VOD in rotation folder';
      }
    }

    if (item.kind === 'twitch') {
      if (twitchPipe.length) {
        status = 'pipeline';
        detail = `${twitchPipe.length} Bobby G VOD job(s) — ${twitchPipe[0].stageLabel}`;
      } else if (twitchReady) {
        status = 'ready';
        detail = twitchAge != null && twitchAge <= 3
          ? `Twitch Soup VOD ready (${twitchAge === 0 ? 'today' : twitchAge + 'd ago'})`
          : `${twitchReady} Bobby G VOD(s) in library`;
      } else {
        status = 'gap';
        detail = 'No Twitch Soup VOD in pipeline or library';
      }
    }

    return { ...item, status, detail };
  });
}

function buildContentBoard({ persistedJobs } = {}) {
  const catalog = buildTvCatalog(OUTPUT_DIR);
  const pipeline = findPipelineJobs(persistedJobs);
  const schedule = buildTodaySchedule();
  const scheduled = matchScheduleStatus(schedule.items, pipeline, catalog);
  const activeEvent = resolveActiveEvent();

  const ready = {
    bobbyg: (catalog.bobbyg || []).map((f) => ({
      label: f.label,
      durationMin: f.durationMin,
      name: f.name,
    })),
    news: (catalog.news || []).map((f) => ({
      label: f.label,
      durationMin: f.durationMin,
      name: f.name,
    })),
  };

  const pipelineForTv = pipeline.filter((j) => j.forTwitchTv);
  const pipelineShorts = pipeline.filter((j) => j.isShort);

  const gaps = scheduled.filter((s) => s.status === 'gap' || s.status === 'stale');

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    today: schedule.et.dateKey,
    weekday: schedule.et.weekday,
    activeEvent,
    scheduled,
    gaps: gaps.map((g) => ({ label: g.label, detail: g.detail, status: g.status })),
    pipeline: pipelineForTv,
    pipelineShorts,
    ready,
    readyCounts: {
      bobbyg: ready.bobbyg.length,
      news: ready.news.length,
      totalDurationMin: [...(catalog.bobbyg || []), ...(catalog.news || [])]
        .reduce((s, f) => s + (f.durationMin || 0), 0),
    },
    notes: [
      'Ready = finished MP4s you can check for Twitch TV below.',
      'Pipeline = jobs still moving through production — not on air until published.',
      'Shorts = streamer clip comps — for YouTube/TikTok, not the Twitch TV loop.',
    ],
  };
}

module.exports = { buildContentBoard, buildTodaySchedule, findPipelineJobs };
