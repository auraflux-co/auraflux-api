'use strict';

/**
 * YouTube catalog is source of truth for published status (CPD-1127 follow-on).
 * Stale job cards (awaiting_review, gate5_running, etc.) are promoted to
 * published when the video is on the channel catalog or publish_results confirms YouTube.
 */

const fs = require('fs');
const path = require('path');
const { resolvePublishedVideoUrl } = require('./post_live/repurpose');
const { youtubeVideoId } = require('./post_live/claims_csv');

const CACHE_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE || 'clipzworldnews';

let _catalogCache = { mtimeMs: 0, index: null };

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[#@]/g, ' ')
    .replace(/[^\w\s|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveJobTitle(card = {}) {
  const pc = card.publishCopy || card.state?.savedOutputs?.publishCopy || {};
  return pc.platforms?.youtube?.title
    || pc.platforms?.youtube?.bestTitle
    || pc.youtube?.title
    || pc.title
    || card.title
    || card.scriptTitle
    || '';
}

function resolveYoutubeVideoIdFromPublishResults(jobId) {
  if (!jobId) return null;
  try {
    const db = require('./db');
    const rows = db.getPublishedResults(jobId) || [];
    for (const row of rows) {
      if (row.platform !== 'youtube') continue;
      const id = youtubeVideoId(row.platform_job_id) || String(row.platform_job_id || '').trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
  } catch (_e) { /* sqlite optional in tests */ }
  return null;
}

function loadYoutubeCatalogIndex(handle = DEFAULT_HANDLE) {
  const filePath = path.join(CACHE_DIR, `channel_stats_${String(handle).replace(/^@/, '')}.json`);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (_catalogCache.index && _catalogCache.mtimeMs === stat.mtimeMs) {
    return _catalogCache.index;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }

  const items = raw?.catalog?.items || [];
  const byVideoId = new Map();
  const byTitle = new Map();

  for (const item of items) {
    const id = item.id || youtubeVideoId(item.url);
    if (!id) continue;
    byVideoId.set(id, item);
    const norm = normalizeTitle(item.title);
    if (norm && !byTitle.has(norm)) byTitle.set(norm, item);
  }

  _catalogCache = {
    mtimeMs: stat.mtimeMs,
    index: { byVideoId, byTitle, fetchedAt: raw.fetchedAt || raw.catalog?.fetchedAt || null },
  };
  return _catalogCache.index;
}

function findCatalogMatch(card, index) {
  if (!index) return null;

  const url = resolvePublishedVideoUrl(card);
  const urlId = youtubeVideoId(url);
  if (urlId && index.byVideoId.has(urlId)) {
    return { item: index.byVideoId.get(urlId), match: 'url' };
  }

  const resultsId = resolveYoutubeVideoIdFromPublishResults(card.jobId || card.id);
  if (resultsId && index.byVideoId.has(resultsId)) {
    return { item: index.byVideoId.get(resultsId), match: 'publish_results' };
  }

  const title = normalizeTitle(resolveJobTitle(card));
  if (title && index.byTitle.has(title)) {
    return { item: index.byTitle.get(title), match: 'title_exact' };
  }

  if (title) {
    for (const [norm, item] of index.byTitle.entries()) {
      if (norm.length >= 12 && (norm.includes(title) || title.includes(norm))) {
        return { item, match: 'title_fuzzy' };
      }
    }
  }

  return null;
}

/**
 * Promote card to published when YouTube catalog confirms the video exists.
 * @returns {{ card: object, changed: boolean, youtubeConfirmed: boolean, match: string|null }}
 */
function reconcileJobCardYouTube(card, index = null) {
  const out = { ...card };
  const catalogIndex = index || loadYoutubeCatalogIndex();
  const match = findCatalogMatch(out, catalogIndex);
  if (!match) {
    return { card: out, changed: false, youtubeConfirmed: false, match: null };
  }

  const item = match.item;
  const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
  const stage = out.stage || '';
  const alreadyPublished = stage === 'published';

  out.youtubeConfirmedPublished = true;
  out.youtubeCatalogMatch = match.match;
  out.youtubeVideoId = item.id;
  out.youtubeCatalogTitle = item.title || null;

  if (!out.gate5Result) out.gate5Result = {};
  if (!out.gate5Result.platforms) out.gate5Result.platforms = {};
  if (!out.gate5Result.platforms.youtube) out.gate5Result.platforms.youtube = {};
  if (!out.gate5Result.platforms.youtube.url) {
    out.gate5Result.platforms.youtube.url = videoUrl;
  }

  if (alreadyPublished) {
    return { card: out, changed: false, youtubeConfirmed: true, match: match.match };
  }

  out.stage = 'published';
  out.publishedAt = out.publishedAt || item.published || new Date().toISOString();
  out.status = out.status === 'dismissed' ? out.status : 'completed';
  out.publishRecord = {
    ...(out.publishRecord || {}),
    gate4: out.publishRecord?.gate4 || 'pass',
    youtubeUrl: videoUrl,
    publishedAt: out.publishedAt,
    source: 'youtube_catalog_reconcile',
  };

  return { card: out, changed: true, youtubeConfirmed: true, match: match.match };
}

function reconcileAllJobCardsWithYouTube(cards, { persist, saveJobCard } = {}) {
  const index = loadYoutubeCatalogIndex();
  if (!index) return { reconciled: 0, promoted: 0 };

  let reconciled = 0;
  let promoted = 0;

  for (const card of cards || []) {
    const jobKey = card.jobId || card.id;
    if (!jobKey) continue;
    const result = reconcileJobCardYouTube(card, index);
    if (result.youtubeConfirmed) reconciled += 1;
    if (result.changed) {
      promoted += 1;
      if (persist && typeof saveJobCard === 'function') {
        saveJobCard(jobKey, result.card);
      }
    }
    Object.assign(card, result.card);
  }

  return { reconciled, promoted, catalogFetchedAt: index.fetchedAt };
}

module.exports = {
  normalizeTitle,
  resolveJobTitle,
  loadYoutubeCatalogIndex,
  findCatalogMatch,
  reconcileJobCardYouTube,
  reconcileAllJobCardsWithYouTube,
};
