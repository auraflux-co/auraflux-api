'use strict';
/**
 * Creator My Library — AuraFlux outputs + connected destination catalogs.
 *
 * GET /library/mine?platform=all|auraflux|youtube|tiktok|instagram
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const db = require('../db');
const { connectedDestinations, buildStatsPosts } = require('../stats');

function parseJobs(rows) {
  return (rows || []).map((r) => {
    const spec = typeof r.job_spec === 'string'
      ? (() => { try { return JSON.parse(r.job_spec); } catch { return {}; } })()
      : (r.job_spec || {});
    return { ...r, job_spec: spec };
  });
}

function jobThumb(job) {
  const spec = job.job_spec || {};
  return spec.thumbnailUrl || spec.outputThumb || null;
}

async function loadSourceChannels(accountId, brandId) {
  try {
    const where = brandId
      ? 'brand_id = $1 AND active = TRUE'
      : 'client_id = $1 AND active = TRUE';
    const param = brandId || accountId;
    const result = await db.query(
      `SELECT source_channels FROM client_plans WHERE ${where} LIMIT 1`,
      [param],
    );
    return result.rows[0]?.source_channels || {};
  } catch (_e) {
    return {};
  }
}

router.get('/library/mine', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!customerId || !brandId) {
      return res.status(400).json({ ok: false, error: 'brand_required' });
    }

    const platform = String(req.query.platform || 'all').toLowerCase();
    const connected = await connectedDestinations(customerId, brandId);
    const sourceChannels = await loadSourceChannels(customerId, brandId);

    const youtubeHandle =
      connected.find((c) => c.platform === 'youtube')?.handle ||
      sourceChannels.youtubeHandle ||
      null;

    const postsRes = await buildStatsPosts(customerId, brandId, { limit: 40 });
    let aurafluxItems = (postsRes.posts || []).map((p) => ({
      id: p.jobId,
      kind: 'auraflux',
      title: p.title,
      publishedAt: p.publishedAt,
      platforms: p.platforms,
      thumbnailUrl: null,
      url: p.platforms?.find((x) => x.url)?.url || null,
    }));

    try {
      const rows = parseJobs(await db.listJobsByCustomer(customerId, 80, brandId));
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      aurafluxItems = aurafluxItems.map((item) => {
        const row = byId[item.id];
        if (!row) return item;
        return {
          ...item,
          thumbnailUrl: jobThumb(row),
          title: item.title || row.job_spec?.title || row.job_spec?.topic || item.id,
        };
      });
    } catch (_e) { /* non-fatal */ }

    const filterPlatform = (name) =>
      aurafluxItems.filter((i) =>
        (i.platforms || []).some((p) => p.platform === name && (p.url || p.status === 'published')),
      );

    let auraflux = aurafluxItems;
    if (platform === 'tiktok') auraflux = filterPlatform('tiktok');
    else if (platform === 'instagram') auraflux = filterPlatform('instagram');
    else if (platform === 'youtube') auraflux = filterPlatform('youtube');
    else if (platform === 'auraflux') auraflux = aurafluxItems;

    let channelCatalog = [];
    let catalogNote = null;

    if ((platform === 'youtube' || platform === 'all') && youtubeHandle) {
      try {
        const YouTubeClient = require('../clients/youtube_client');
        const client = new YouTubeClient();
        const handle = String(youtubeHandle).replace(/^@/, '');
        const channel = await client.getChannelByHandle(handle);
        if (channel) {
          const raw = await client.getContent(channel.id, 40, { type: 'all' });
          channelCatalog = (raw || []).slice(0, 30).map((item) => ({
            id: item.id || item.url,
            kind: 'youtube_channel',
            title: item.title,
            thumbnailUrl: item.thumbnailUrl || item.thumbnail || null,
            url: item.url,
            duration: item.duration,
            publishedAt: item.publishedAt,
            viewCount: item.viewCount,
            platform: 'youtube',
          }));
        } else {
          catalogNote = 'youtube_channel_not_found';
        }
      } catch (err) {
        catalogNote = err.message || 'youtube_catalog_failed';
      }
    } else if (platform === 'youtube' && !youtubeHandle) {
      catalogNote = 'Connect YouTube under Social or set a YouTube handle under My Channels.';
    }

    return res.json({
      ok: true,
      platform,
      connected,
      handles: {
        youtube: youtubeHandle,
        tiktok: connected.find((c) => c.platform === 'tiktok')?.handle || null,
        instagram: connected.find((c) => c.platform === 'instagram')?.handle || null,
      },
      auraflux,
      channelCatalog,
      catalogNote,
      notes: {
        tiktok:
          'TikTok has no browse catalog here — showing AuraFlux posts published to TikTok when connected.',
        instagram:
          'Instagram has no browse catalog here — showing AuraFlux posts published to Instagram when connected.',
      },
    });
  } catch (err) {
    console.error('[library/mine]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'library_failed' });
  }
});

module.exports = router;
