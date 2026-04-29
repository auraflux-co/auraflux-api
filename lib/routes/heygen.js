'use strict';

// ── C0-only HeyGen utility routes ─────────────────────────────────────────────
// These routes exist to support C0 (Rob's localhost dashboard) where HeyGen Avatar V
// is used for video generation.
//
// NOTE — C1+ HeyGen path (CPD-68):
//   C1+ jobs that order HeyGen as an add-on go through lib/portals/portal_heygen_ext.js,
//   NOT these utility routes. These routes remain for the C0 dashboard UI only.
//   The distinction: C0 calls these routes directly from the browser; C1+ declares
//   addOns.heygen.active=true in POST /jobs and the portal sequence handles the rest.
//
// GET  /heygen/latest-videos    — fetch recent HeyGen account videos (REFRESH IDs)
// POST /heygen/video-urls       — fetch URLs for a specific list of video IDs
// POST /admin/heygen/delete-all — bulk-delete all HeyGen videos (dangerous, token-gated)
// POST /log-heygen-metrics      — dashboard logs per-job HeyGen rendering metrics

const axios = require('axios');
const router = require('express').Router();

const { StageTimer, jobMetrics, initJobMetrics, addStageMetrics } = require('../metrics');

// ── Helper: bulk delete all HeyGen videos ────────────────────────────────────
async function bulkDeleteHeyGenVideos({
  apiKey,
  dryRun = false,
  maxPasses = 100,
  perPassLimit = 100,
}) {
  const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
  const failures = [];
  let totalDeleted = 0,
    totalSeen = 0,
    passCount = 0;

  const listVideos = async () => {
    const resp = await axios.get(
      `https://api.heygen.com/v1/video.list?limit=${Math.max(1, Math.min(100, perPassLimit))}`,
      { headers: { 'X-Api-Key': apiKey }, timeout: 30000 }
    );
    return resp.data?.data?.videos || [];
  };

  const deleteOne = async (video) => {
    const attempts = [
      () =>
        axios.post(
          'https://api.heygen.com/v1/video.delete',
          { video_id: video.video_id },
          { headers, timeout: 30000 }
        ),
      () =>
        axios.post(
          'https://api.heygen.com/v1/video.delete',
          { video_id: video.video_id, type: video.type || 'GENERATED' },
          { headers, timeout: 30000 }
        ),
      () =>
        axios.delete(`https://api.heygen.com/v3/videos/${video.video_id}`, {
          headers: { 'X-Api-Key': apiKey },
          timeout: 30000,
        }),
    ];
    let lastErr = null;
    for (const run of attempts) {
      try {
        return await run();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };

  while (passCount < maxPasses) {
    passCount++;
    const videos = await listVideos();
    if (!videos.length) break;
    totalSeen += videos.length;
    if (dryRun) continue;
    for (const video of videos) {
      try {
        await deleteOne(video);
        totalDeleted++;
      } catch (err) {
        failures.push({
          video_id: video.video_id,
          title: video.video_title || null,
          error: err.response?.data || err.message || 'unknown_error',
        });
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  const remaining = (await listVideos()).length;
  return {
    passCount,
    totalSeen,
    totalDeleted,
    remaining,
    failedCount: failures.length,
    failures: failures.slice(0, 50),
  };
}

// GET /heygen/latest-videos
router.get('/heygen/latest-videos', async (req, res) => {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) return res.status(400).json({ error: 'HEYGEN_API_KEY not set' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  try {
    const listResp = await axios.get(`https://api.heygen.com/v1/video.list?limit=${limit}`, {
      headers: { 'X-Api-Key': HEYGEN_API_KEY },
      timeout: 15000,
    });
    const videos = listResp.data?.data?.videos || [];
    console.log(`[heygen/latest-videos] Fetched ${videos.length} videos`);

    const completedVideos = videos.filter((v) => v.status === 'completed');
    const batchSize = 10;
    const withUrls = [];

    for (let i = 0; i < completedVideos.length; i += batchSize) {
      const batch = completedVideos.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (v) => {
          try {
            const statusResp = await axios.get(
              `https://api.heygen.com/v1/video_status.get?video_id=${v.video_id}`,
              { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
            );
            const data = statusResp.data?.data || {};
            return {
              video_id: v.video_id,
              title: v.video_title || v.video_id,
              status: v.status,
              created_at: v.created_at,
              video_url: data.video_url || data.url || null,
              duration: data.duration || null,
            };
          } catch (e) {
            return {
              video_id: v.video_id,
              title: v.video_title || v.video_id,
              status: v.status,
              created_at: v.created_at,
              video_url: null,
              error: e.message,
            };
          }
        })
      );
      withUrls.push(...results);
      if (i + batchSize < completedVideos.length) await new Promise((r) => setTimeout(r, 500));
    }

    const nonCompleted = videos
      .filter((v) => v.status !== 'completed')
      .map((v) => ({
        video_id: v.video_id,
        title: v.video_title || v.video_id,
        status: v.status,
        created_at: v.created_at,
        video_url: null,
      }));
    const allVideos = [...withUrls, ...nonCompleted].sort(
      (a, b) => (b.created_at || 0) - (a.created_at || 0)
    );
    res.json({ ok: true, count: allVideos.length, videos: allVideos });
  } catch (e) {
    console.error('[heygen/latest-videos] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/heygen/delete-all
router.post('/admin/heygen/delete-all', async (req, res) => {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) return res.status(400).json({ ok: false, error: 'HEYGEN_API_KEY not set' });
  const adminToken = process.env.HEYGEN_ADMIN_TOKEN;
  if (!adminToken)
    return res
      .status(503)
      .json({ ok: false, error: 'HEYGEN_ADMIN_TOKEN not configured; endpoint disabled' });
  if (req.headers['x-admin-token'] !== adminToken)
    return res.status(403).json({ ok: false, error: 'Forbidden: invalid admin token' });
  if (req.body?.confirmDeleteAll !== 'DELETE_ALL_HEYGEN_VIDEOS')
    return res.status(400).json({
      ok: false,
      error: 'Explicit confirmation required',
      expected: { confirmDeleteAll: 'DELETE_ALL_HEYGEN_VIDEOS' },
    });

  try {
    const result = await bulkDeleteHeyGenVideos({
      apiKey: HEYGEN_API_KEY,
      dryRun: !!req.body?.dryRun,
      maxPasses: Math.max(1, Math.min(500, Number(req.body?.maxPasses) || 100)),
      perPassLimit: Math.max(1, Math.min(100, Number(req.body?.perPassLimit) || 100)),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'delete failed',
      details: err.response?.data || null,
    });
  }
});

// POST /heygen/video-urls
router.post('/heygen/video-urls', async (req, res) => {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) return res.status(400).json({ error: 'HEYGEN_API_KEY not set' });
  const { videoIds } = req.body;
  if (!Array.isArray(videoIds) || !videoIds.length)
    return res.status(400).json({ error: 'videoIds array required' });
  if (videoIds.length > 100)
    return res.status(400).json({ error: 'Max 100 video IDs per request' });

  console.log(`[heygen/video-urls] Fetching URLs for ${videoIds.length} video IDs`);
  const batchSize = 10;
  const results = [];

  for (let i = 0; i < videoIds.length; i += batchSize) {
    const batch = videoIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (videoId) => {
        try {
          const statusResp = await axios.get(
            `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
            { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
          );
          const data = statusResp.data?.data || {};
          return {
            video_id: videoId,
            status: data.status || 'unknown',
            video_url: data.video_url || data.url || null,
            duration: data.duration || null,
          };
        } catch (e) {
          return { video_id: videoId, status: 'error', video_url: null, error: e.message };
        }
      })
    );
    results.push(...batchResults);
    if (i + batchSize < videoIds.length) await new Promise((r) => setTimeout(r, 300));
  }

  const completed = results.filter((r) => r.video_url).length;
  console.log(`[heygen/video-urls] ${completed}/${videoIds.length} have URLs`);
  res.json({ ok: true, results });
});

// POST /log-heygen-metrics — dashboard logs per-job rendering metrics to NR
router.post('/log-heygen-metrics', async (req, res) => {
  const { jobId, segmentCount, totalWaitTimeMs, avgRenderTimeMs, segments } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    if (!jobMetrics[jobId]) initJobMetrics(jobId);

    const timer = new StageTimer(jobId, 'Segment Rendering');
    timer.startTime = Date.now() - totalWaitTimeMs;
    timer
      .addData('segmentCount', segmentCount || 0)
      .addData('avgRenderTimeMs', avgRenderTimeMs || 0)
      .addData('avgRenderTimeSec', ((avgRenderTimeMs || 0) / 1000).toFixed(2))
      .addData('totalWaitTimeMs', totalWaitTimeMs || 0)
      .addData('totalWaitTimeSec', ((totalWaitTimeMs || 0) / 1000).toFixed(2));

    if (segments?.length) {
      timer.addData('segmentDetails', segments);
      timer.addData(
        'totalRetries',
        segments.reduce((sum, s) => sum + (s.retries || 0), 0)
      );
    }

    addStageMetrics(jobId, timer.end());
    console.log(
      `[metrics:${jobId}] Segment rendering metrics logged: ${segmentCount} segments, ${(totalWaitTimeMs / 1000).toFixed(2)}s total`
    );
    res.json({ ok: true, jobId, message: 'Metrics logged successfully' });
  } catch (e) {
    console.error(`[metrics] Failed to log metrics: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
