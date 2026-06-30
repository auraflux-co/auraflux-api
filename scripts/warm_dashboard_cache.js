#!/usr/bin/env node
'use strict';
/**
 * Pre-warm dashboard disk caches (channel stats catalog, YouTube calendar, Upload-Post).
 * Run manually, via warm_dashboard_cache.sh, or pm2 cron (dashboard-cache-warm).
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(REPO, '.env'), override: true });

const LOG_PATH = process.env.DASHBOARD_CACHE_WARM_LOG
  || path.join(REPO, 'logs', 'dashboard_cache_warm.jsonl');
const LOCK_PATH = path.join(REPO, 'logs', 'dashboard_cache_warm.lock');
const LOCK_MAX_AGE_MS = Number(process.env.DASHBOARD_CACHE_WARM_LOCK_MS) || 30 * 60 * 1000;

function log(evt) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const row = { ts: new Date().toISOString(), ...evt };
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`);
  const msg = evt.msg || evt.step || JSON.stringify(evt);
  console.log(`[dashboard-cache-warm] ${msg}`);
}

function monthRangeFor(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const dim = new Date(y, m, 0).getDate();
  return {
    year: y,
    month: m,
    startDate: `${y}-${String(m).padStart(2, '0')}-01`,
    endDate: `${y}-${String(m).padStart(2, '0')}-${String(dim).padStart(2, '0')}`,
  };
}

function adjacentMonthRange(offsetMonths) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return monthRangeFor(d);
}

function loadPersistedJobs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'jobs.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim().split('\n');
    const pid = Number(raw[0]);
    const startedAt = raw[1] || null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const existing = readLock();
    if (existing) {
      const age = existing.startedAt
        ? Date.now() - new Date(existing.startedAt).getTime()
        : Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      if (pidAlive(existing.pid) && age < LOCK_MAX_AGE_MS) {
        log({ level: 'skip', msg: `Another warm still running (pid ${existing.pid}, ${Math.round(age / 1000)}s)` });
        process.exit(0);
      }
      fs.unlinkSync(LOCK_PATH);
    }
    fs.writeFileSync(LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`);
  } catch (e) {
    log({ level: 'warn', msg: `Lock failed: ${e.message}` });
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

async function warmStats(handle) {
  const { buildChannelStatsReport } = require('../lib/services/channel_stats');
  const t0 = Date.now();
  const report = await buildChannelStatsReport({
    handle,
    refresh: true,
    days: Number(process.env.DASHBOARD_CACHE_WARM_STATS_DAYS) || 14,
  });
  log({
    step: 'channel_stats',
    ok: !!report.ok,
    stale: !!report.stale,
    items: report.catalog?.totals?.items || 0,
    ms: Date.now() - t0,
  });
  return report;
}

async function warmYoutubeRange(range, persistedJobs) {
  const { getYoutubeCalendarItems } = require('../lib/calendar/youtube_studio_sync');
  const t0 = Date.now();
  const result = await getYoutubeCalendarItems({
    startDate: range.startDate,
    endDate: range.endDate,
    refresh: true,
    persistedJobs,
  });
  log({
    step: 'youtube_calendar',
    range: `${range.startDate}..${range.endDate}`,
    ok: result.ok !== false,
    count: (result.items || []).length,
    stale: !!result.stale,
    ms: Date.now() - t0,
  });
  return result;
}

async function warmUploadPostRange(range, persistedJobs) {
  const { getUploadPostCalendarItems } = require('../lib/calendar/upload_post_sync');
  const t0 = Date.now();
  const result = await getUploadPostCalendarItems({
    startDate: range.startDate,
    endDate: range.endDate,
    refresh: true,
    persistedJobs,
  });
  log({
    step: 'upload_post_calendar',
    range: `${range.startDate}..${range.endDate}`,
    ok: result.ok !== false,
    count: (result.items || []).length,
    stale: !!result.stale,
    ms: Date.now() - t0,
  });
  return result;
}

async function main() {
  if (process.env.DASHBOARD_CACHE_WARM_ENABLED === '0') {
    log({ level: 'skip', msg: 'DASHBOARD_CACHE_WARM_ENABLED=0' });
    process.exit(0);
  }

  acquireLock();
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
  const started = Date.now();
  const handle = process.env.YOUTUBE_CHANNEL_HANDLE || 'clipzworldnews';
  const jobs = loadPersistedJobs();

  try {
    log({ step: 'start', msg: 'Warming dashboard caches' });

    await warmStats(handle);

    const ranges = [monthRangeFor()];
    if (process.env.DASHBOARD_CACHE_WARM_ADJACENT_MONTHS !== '0') {
      ranges.push(adjacentMonthRange(-1), adjacentMonthRange(1));
    }

    for (const range of ranges) {
      await warmYoutubeRange(range, jobs);
      await warmUploadPostRange(range, jobs);
    }

    log({ step: 'done', msg: `Warm complete in ${Math.round((Date.now() - started) / 1000)}s` });
    process.exit(0);
  } catch (e) {
    log({ level: 'error', msg: e.message, stack: String(e.stack || '').slice(0, 400) });
    process.exit(1);
  } finally {
    releaseLock();
  }
}

main();
