'use strict';

/**
 * TikTok + Instagram publish/schedule times from Upload-Post (source of truth).
 * Read-only — feeds Content Calendar alongside YouTube Studio sync.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { formatTimeEt, dateKeyFromIso } = require('./youtube_studio_sync');
const { classifyJobCard } = require('./content_taxonomy');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'upload_post_calendar_items.json');
const CACHE_TTL_MS = Number(process.env.UPLOADPOST_CALENDAR_CACHE_MS) || 15 * 60 * 1000;
const API_BASE = 'https://api.upload-post.com/api';
const CALENDAR_PLATFORMS = new Set(['tiktok', 'instagram']);

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\n[\s\S]*/, ' ')
    .replace(/[#@]/g, ' ')
    .replace(/[^\w\s|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function buildJobLinkIndex(persistedJobs = {}) {
  const byPlatformJobId = new Map();
  const byRequestId = new Map();

  for (const [jobId, card] of Object.entries(persistedJobs || {})) {
    if (!card || card.status === 'dismissed') continue;
    const platforms = card.gate5Result?.platforms || {};
    for (const [platform, result] of Object.entries(platforms)) {
      if (!result?.jobId) continue;
      byPlatformJobId.set(String(result.jobId), { jobId, platform });
    }
    const publishRecord = card.publishRecord || {};
    for (const [platform, rec] of Object.entries(publishRecord.platforms || {})) {
      const pid = rec?.jobId || rec?.platformJobId || rec?.requestId;
      if (pid) byPlatformJobId.set(String(pid), { jobId, platform });
      if (rec?.requestId) byRequestId.set(String(rec.requestId), { jobId, platform });
    }
  }

  try {
    const db = require('../db');
    const dbImpl = db.getDb?.() ? db : null;
    if (dbImpl?.prepare) {
      const rows = db.prepare(`
        SELECT job_id, platform, platform_job_id
        FROM publish_results
        WHERE platform IN ('tiktok', 'instagram') AND platform_job_id IS NOT NULL
      `).all();
      for (const row of rows) {
        byPlatformJobId.set(String(row.platform_job_id), {
          jobId: row.job_id,
          platform: row.platform,
        });
      }
    }
  } catch (_e) { /* sqlite optional in tests */ }

  return { byPlatformJobId, byRequestId };
}

function resolveJobLink(row, index) {
  const jobId = row.job_id || row.jobId;
  if (jobId && index.byPlatformJobId.has(String(jobId))) {
    return index.byPlatformJobId.get(String(jobId));
  }
  const reqId = row.request_id || row.requestId;
  if (reqId && index.byRequestId.has(String(reqId))) {
    return index.byRequestId.get(String(reqId));
  }
  return null;
}

function historyRowToCalendarItem(row, index, rangeStart, rangeEnd, persistedJobs = {}) {
  const platform = String(row.platform || '').toLowerCase();
  if (!CALENDAR_PLATFORMS.has(platform)) return null;
  if (row.success === false) return null;

  const publishAt = row.upload_timestamp;
  if (!publishAt) return null;
  const dateKey = dateKeyFromIso(publishAt);
  if (!dateKey || dateKey < rangeStart || dateKey > rangeEnd) return null;

  const link = resolveJobLink(row, index);
  const card = link?.jobId ? persistedJobs[link.jobId] : null;
  const titleRaw = String(row.post_title || '').split('\n')[0] || row.post_caption || platform;
  const { format, pillar } = classifyJobCard(card || { contentType: 'twitch-short' });

  return {
    source: `upload_post_${platform}`,
    platform,
    jobId: link?.jobId || null,
    uploadPostJobId: row.job_id || row.jobId || null,
    title: titleRaw.slice(0, 120),
    format,
    pillar,
    status: 'published',
    publishAt,
    dateKey,
    at: publishAt,
    timeEt: formatTimeEt(publishAt),
    url: row.post_url || null,
  };
}

function scheduledRowToCalendarItem(row, index, rangeStart, rangeEnd) {
  const publishAt = row.scheduled_date || row.scheduledDate;
  if (!publishAt) return null;
  const dateKey = dateKeyFromIso(publishAt);
  if (!dateKey || dateKey < rangeStart || dateKey > rangeEnd) return null;

  const link = resolveJobLink(row, index);
  const titleRaw = row.title || row.caption || 'Scheduled post';
  const { format, pillar } = classifyJobCard({ contentType: 'twitch-short' });

  return {
    source: `upload_post_scheduled`,
    platform: link?.platform || 'tiktok',
    jobId: link?.jobId || null,
    uploadPostJobId: row.job_id || row.jobId || null,
    title: String(titleRaw).slice(0, 120),
    format,
    pillar,
    status: 'scheduled',
    publishAt,
    dateKey,
    at: publishAt,
    timeEt: formatTimeEt(publishAt),
    url: row.preview_url || null,
  };
}

async function fetchHistoryForRange({ startDate, endDate, apiKey, index, persistedJobs }) {
  const items = [];
  const rangeStartMs = new Date(`${startDate}T00:00:00Z`).getTime() - 86400000;
  let page = 1;

  for (;;) {
    const response = await axios.get(`${API_BASE}/uploadposts/history`, {
      params: { page },
      headers: { Authorization: `Apikey ${apiKey}` },
      timeout: 25_000,
    });
    const history = response.data?.history || [];
    if (!history.length) break;

    let oldestMs = Infinity;
    for (const row of history) {
      const ts = row.upload_timestamp;
      if (ts) oldestMs = Math.min(oldestMs, new Date(ts).getTime());
      const item = historyRowToCalendarItem(row, index, startDate, endDate, persistedJobs);
      if (item) items.push(item);
    }

    if (oldestMs < rangeStartMs || history.length < 10) break;
    page += 1;
    if (page > 100) break;
  }

  return items;
}

async function fetchScheduledForRange({ startDate, endDate, apiKey, index }) {
  const response = await axios.get(`${API_BASE}/uploadposts/schedule`, {
    headers: { Authorization: `Apikey ${apiKey}` },
    timeout: 25_000,
  });
  const rows = response.data?.scheduled_posts
    || (Array.isArray(response.data) ? response.data : []);
  return rows
    .map((row) => scheduledRowToCalendarItem(row, index, startDate, endDate))
    .filter(Boolean);
}

function dedupeUploadPostItems(items) {
  const seen = new Map();
  for (const item of items) {
    const key = item.uploadPostJobId
      ? `${item.platform}:${item.uploadPostJobId}`
      : `${item.platform}:${item.title}:${item.publishAt}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    // Published actual time wins over scheduled placeholder for same upload-post job.
    if (prev.status === 'scheduled' && item.status === 'published') {
      seen.set(key, { ...prev, ...item, status: 'published' });
    }
  }
  return [...seen.values()].sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
}

async function fetchCalendarFromApi({ startDate, endDate, persistedJobs = null } = {}) {
  const apiKey = process.env.UPLOADPOST_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'UPLOADPOST_API_KEY not set',
      items: [],
    };
  }

  const index = buildJobLinkIndex(persistedJobs || {});
  const [fromHistory, fromScheduled] = await Promise.all([
    fetchHistoryForRange({ startDate, endDate, apiKey, index, persistedJobs: persistedJobs || {} }),
    fetchScheduledForRange({ startDate, endDate, apiKey, index }),
  ]);

  const items = dedupeUploadPostItems([...fromHistory, ...fromScheduled]);

  return {
    ok: true,
    items,
    fetchedAt: new Date().toISOString(),
    rangeStart: startDate,
    rangeEnd: endDate,
    scan: {
      fromHistory: fromHistory.length,
      fromScheduled: fromScheduled.length,
      total: items.length,
    },
  };
}

/**
 * TikTok / Instagram publish and schedule times for a calendar date range.
 */
async function getUploadPostCalendarItems({
  startDate,
  endDate,
  refresh = false,
  persistedJobs = null,
} = {}) {
  const start = String(startDate || '');
  const end = String(endDate || start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return { ok: false, reason: 'bad_range', message: 'startDate required (YYYY-MM-DD)', items: [] };
  }

  if (!refresh) {
    const cached = readCache();
    if (
      cached?.fetchedAt
      && Array.isArray(cached.items)
      && cached.rangeStart === start
      && cached.rangeEnd === end
    ) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return { ...cached, ok: cached.ok !== false, stale: false };
      }
    }
  }

  try {
    const fresh = await fetchCalendarFromApi({ startDate: start, endDate: end, persistedJobs });
    const payload = {
      ...fresh,
      fetchedAt: fresh.fetchedAt || new Date().toISOString(),
      rangeStart: start,
      rangeEnd: end,
    };
    writeCache(payload);
    return payload;
  } catch (e) {
    const cached = readCache();
    if (cached?.items?.length && cached.rangeStart === start && cached.rangeEnd === end) {
      return { ...cached, ok: true, stale: true, staleError: e.message };
    }
    return { ok: false, reason: 'api_error', message: e.message, items: [] };
  }
}

module.exports = {
  getUploadPostCalendarItems,
  buildJobLinkIndex,
  historyRowToCalendarItem,
  scheduledRowToCalendarItem,
  dedupeUploadPostItems,
  CALENDAR_PLATFORMS,
};
