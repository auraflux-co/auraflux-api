'use strict';
/**
 * Creator post-publish stats — platform-agnostic core.
 */

const { listJobsByCustomer, getPublishResults } = require('../db');
const { listConnectedPlatforms } = require('../services/token_store');
const { listUploadPostAccounts } = require('../services/uploadpost_users');
const uploadPost = require('./adapters/upload_post');
const youtube = require('./adapters/youtube');

const DEST_PLATFORMS = ['youtube', 'tiktok', 'instagram'];

async function connectedDestinations(customerId, brandId) {
  const [oauth, up] = await Promise.all([
    listConnectedPlatforms(customerId, brandId).catch(() => []),
    listUploadPostAccounts(brandId).catch(() => []),
  ]);
  const map = {};
  for (const a of oauth || []) {
    const p = String(a.platform || '').toLowerCase();
    if (!DEST_PLATFORMS.includes(p)) continue;
    map[p] = {
      platform: p,
      handle: a.platformHandle || a.handle || null,
      source: 'oauth',
    };
  }
  for (const a of up || []) {
    const p = String(a.platform || '').toLowerCase();
    if (!DEST_PLATFORMS.includes(p)) continue;
    if (map[p]) continue;
    map[p] = {
      platform: p,
      handle: a.handle || a.platformHandle || null,
      source: 'upload_post',
    };
  }
  return Object.values(map);
}

/**
 * Summary rollup for Creator Stats page.
 */
async function buildStatsSummary(customerId, brandId) {
  const connected = await connectedDestinations(customerId, brandId);
  const platforms = connected.map((c) => c.platform);
  const want = platforms.length ? platforms : DEST_PLATFORMS;

  const [up, yt] = await Promise.all([
    uploadPost.fetchProfileAnalytics(brandId, want),
    platforms.includes('youtube') || want.includes('youtube')
      ? youtube.fetchYoutubeLiteSummary(customerId, brandId, { days: 28 })
      : Promise.resolve({ ok: true, available: false, reason: 'youtube_not_in_scope' }),
  ]);

  return {
    ok: true,
    brandId,
    connected,
    uploadPost: up,
    youtube: yt,
  };
}

/**
 * Recent published jobs + optional Upload-Post post metrics.
 */
async function buildStatsPosts(customerId, brandId, { limit = 20 } = {}) {
  const rows = await listJobsByCustomer(customerId, Math.min(80, Math.max(limit * 3, 20)), brandId);
  const posts = [];

  for (const row of rows) {
    if (posts.length >= limit) break;
    const spec = typeof row.job_spec === 'string'
      ? (() => { try { return JSON.parse(row.job_spec); } catch { return {}; } })()
      : (row.job_spec || {});
    const status = row.status || spec.status || null;
    let results = [];
    try {
      results = await getPublishResults(row.id);
    } catch (_e) {
      results = [];
    }
    const publishedRows = (results || []).filter((r) => r.status === 'published' || r.driveUrl);
    if (!publishedRows.length && status !== 'published') continue;

    const title =
      spec.title ||
      spec.metadata?.title ||
      spec.topic ||
      publishedRows[0]?.title ||
      row.id;

    const rid = publishedRows.find((r) => r.requestId)?.requestId || null;

    let metrics = null;
    if (rid) {
      const pa = await uploadPost.fetchPostAnalytics(rid);
      if (pa.ok) metrics = pa.metrics;
    }

    posts.push({
      jobId: row.id,
      title: String(title).slice(0, 200),
      publishedAt:
        publishedRows.map((r) => r.publishedAt).find(Boolean) ||
        (row.updated_at ? new Date(Number(row.updated_at) || row.updated_at).toISOString() : null),
      platforms: publishedRows.map((r) => ({
        platform: r.platform,
        url: r.driveUrl,
        status: r.status,
        requestId: r.requestId || null,
        platformJobId: r.platformJobId || null,
      })),
      requestId: rid,
      metrics,
      metricsNote: rid
        ? metrics
          ? null
          : 'Post metrics unavailable yet for this Upload-Post request.'
        : 'No Upload-Post request_id stored — open live URLs for platform-native stats.',
    });
  }

  return { ok: true, posts };
}

module.exports = {
  buildStatsSummary,
  buildStatsPosts,
  connectedDestinations,
};
