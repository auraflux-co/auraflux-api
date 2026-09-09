'use strict';
/**
 * lib/twitch_ccv/index.js — Customer-scoped Twitch CCV capture
 *
 * Streams Charts–style for AuraFlux brands only:
 *   1. Read twitchLogin from active client_plans.source_channels
 *   2. Poll Helix Get Streams for those logins
 *   3. Store samples + running peak while live
 *   4. When offline, finalize stream and link archive VOD via Helix Get Videos
 *
 * Requires TWITCH_CLIENT_ID + TWITCH_TOKEN (app token). No Streams Charts API.
 */

const axios = require('axios');
const { query: dbQuery } = require('../db/postgres');

const HELIX = 'https://api.twitch.tv/helix';
const POLL_MS = Math.max(30_000, parseInt(process.env.TWITCH_CCV_POLL_MS || '60000', 10));
const VOD_LINK_LOOKBACK_HOURS = Math.max(1, parseInt(process.env.TWITCH_CCV_VOD_LOOKBACK_HOURS || '48', 10));

let _timer = null;

function helixHeaders() {
  const clientId = process.env.TWITCH_CLIENT_ID || process.env.TWITCH_OAUTH_CLIENT_ID;
  const token = process.env.TWITCH_TOKEN;
  if (!clientId || !token) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN required for CCV poll');
  }
  return {
    'Client-Id': clientId,
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Active brands with a Twitch source channel login.
 * @returns {Promise<Array<{ brandId: string|null, customerId: string|null, twitchLogin: string }>>}
 */
async function listTrackedLogins() {
  const result = await dbQuery(
    `SELECT brand_id, client_id, source_channels
       FROM client_plans
      WHERE active = TRUE
        AND source_channels ? 'twitchLogin'
        AND NULLIF(TRIM(source_channels->>'twitchLogin'), '') IS NOT NULL`,
  );
  const out = [];
  const seen = new Set();
  for (const row of result.rows || []) {
    const login = String(row.source_channels?.twitchLogin || '').trim().toLowerCase();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    out.push({
      brandId: row.brand_id || null,
      customerId: row.client_id || null,
      twitchLogin: login,
    });
  }
  return out;
}

async function helixGetStreamsByLogin(logins) {
  if (!logins.length) return [];
  const headers = helixHeaders();
  const live = [];
  for (let i = 0; i < logins.length; i += 100) {
    const chunk = logins.slice(i, i + 100);
    const qs = chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const resp = await axios.get(`${HELIX}/streams?${qs}`, { headers, timeout: 15000 });
    for (const s of resp.data?.data || []) {
      live.push({
        login: String(s.user_login || '').toLowerCase(),
        userId: String(s.user_id || ''),
        streamId: String(s.id || ''),
        title: s.title || null,
        gameName: s.game_name || null,
        viewerCount: Number(s.viewer_count) || 0,
        startedAt: s.started_at || null,
      });
    }
  }
  return live;
}

async function helixFindArchiveVod(userId, startedAt) {
  if (!userId) return null;
  const headers = helixHeaders();
  const resp = await axios.get(
    `${HELIX}/videos?user_id=${encodeURIComponent(userId)}&type=archive&first=10`,
    { headers, timeout: 15000 },
  );
  const startMs = startedAt ? new Date(startedAt).getTime() : 0;
  const rows = resp.data?.data || [];
  for (const v of rows) {
    const created = new Date(v.created_at || 0).getTime();
    // Prefer VOD created near stream start (within lookback window after start)
    if (startMs && created + 60_000 < startMs) continue;
    if (startMs && created > startMs + VOD_LINK_LOOKBACK_HOURS * 3600_000) continue;
    return {
      vodId: String(v.id),
      vodUrl: v.url || `https://www.twitch.tv/videos/${v.id}`,
    };
  }
  // Fallback: newest archive
  const first = rows[0];
  if (!first) return null;
  return {
    vodId: String(first.id),
    vodUrl: first.url || `https://www.twitch.tv/videos/${first.id}`,
  };
}

async function upsertLiveSample(tracked, live) {
  const startedAt = live.startedAt || new Date().toISOString();
  const existing = await dbQuery(
    `SELECT id, started_at, peak_viewers, sample_count
       FROM twitch_ccv_streams
      WHERE twitch_login = $1 AND status = 'live'
      LIMIT 1`,
    [tracked.twitchLogin],
  );
  let streamId;
  let streamStarted = startedAt;
  if (existing.rows[0]) {
    streamId = existing.rows[0].id;
    streamStarted = existing.rows[0].started_at;
  } else {
    const ins = await dbQuery(
      `INSERT INTO twitch_ccv_streams
         (brand_id, customer_id, twitch_login, helix_user_id, helix_stream_id,
          title, game_name, started_at, peak_viewers, peak_at, peak_offset_sec,
          sample_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,0,0,'live')
       RETURNING id, started_at`,
      [
        tracked.brandId,
        tracked.customerId,
        tracked.twitchLogin,
        live.userId || null,
        live.streamId || null,
        live.title,
        live.gameName,
        startedAt,
        live.viewerCount,
      ],
    );
    streamId = ins.rows[0].id;
    streamStarted = ins.rows[0].started_at;
  }

  const offsetSec = Math.max(0, Math.floor((Date.now() - new Date(streamStarted).getTime()) / 1000));
  await dbQuery(
    `INSERT INTO twitch_ccv_samples (stream_id, viewer_count, offset_sec)
     VALUES ($1, $2, $3)`,
    [streamId, live.viewerCount, offsetSec],
  );

  const prevPeak = Number(existing.rows[0]?.peak_viewers) || 0;
  const isNewPeak = live.viewerCount >= prevPeak;
  await dbQuery(
    `UPDATE twitch_ccv_streams SET
        helix_user_id = COALESCE($2, helix_user_id),
        helix_stream_id = COALESCE($3, helix_stream_id),
        title = COALESCE($4, title),
        game_name = COALESCE($5, game_name),
        brand_id = COALESCE($6, brand_id),
        customer_id = COALESCE($7, customer_id),
        peak_viewers = $8,
        peak_at = CASE WHEN $10 THEN NOW() ELSE peak_at END,
        peak_offset_sec = CASE WHEN $10 THEN $9 ELSE peak_offset_sec END,
        sample_count = sample_count + 1,
        avg_viewers = (
          COALESCE(avg_viewers, 0) * sample_count + $11
        ) / NULLIF(sample_count + 1, 0),
        updated_at = NOW()
      WHERE id = $1`,
    [
      streamId,
      live.userId || null,
      live.streamId || null,
      live.title,
      live.gameName,
      tracked.brandId,
      tracked.customerId,
      Math.max(prevPeak, live.viewerCount),
      offsetSec,
      isNewPeak,
      live.viewerCount,
    ],
  );
  return { streamId, isNewPeak, offsetSec, viewerCount: live.viewerCount };
}

async function finalizeOfflineStreams(liveLogins) {
  const liveSet = new Set(liveLogins);
  const open = await dbQuery(
    `SELECT id, twitch_login, helix_user_id, started_at, status, vod_id
       FROM twitch_ccv_streams
      WHERE status IN ('live', 'ended')`,
  );
  const results = [];
  for (const row of open.rows || []) {
    if (row.status === 'live' && liveSet.has(row.twitch_login)) continue;

    if (row.status === 'live') {
      await dbQuery(
        `UPDATE twitch_ccv_streams
            SET status = 'ended', ended_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [row.id],
      );
    }

    if (row.vod_id) {
      results.push({ id: row.id, login: row.twitch_login, linked: true });
      continue;
    }

    try {
      const vod = await helixFindArchiveVod(row.helix_user_id, row.started_at);
      if (vod) {
        await dbQuery(
          `UPDATE twitch_ccv_streams
              SET vod_id = $2, vod_url = $3, status = 'linked', updated_at = NOW()
            WHERE id = $1`,
          [row.id, vod.vodId, vod.vodUrl],
        );
        results.push({ id: row.id, login: row.twitch_login, vodId: vod.vodId, linked: true });
      } else {
        results.push({ id: row.id, login: row.twitch_login, linked: false });
      }
    } catch (err) {
      console.warn(`[twitch-ccv] VOD link failed for ${row.twitch_login}: ${err.message}`);
      results.push({ id: row.id, login: row.twitch_login, linked: false, error: err.message });
    }
  }
  return results;
}

/**
 * One poll cycle — safe to call from cron or tests.
 */
async function pollOnce() {
  const tracked = await listTrackedLogins();
  if (!tracked.length) {
    return { tracked: 0, live: 0, samples: 0, finalized: [] };
  }
  const byLogin = new Map(tracked.map((t) => [t.twitchLogin, t]));
  const liveRows = await helixGetStreamsByLogin([...byLogin.keys()]);
  let samples = 0;
  for (const live of liveRows) {
    const t = byLogin.get(live.login);
    if (!t) continue;
    await upsertLiveSample(t, live);
    samples += 1;
  }
  const finalized = await finalizeOfflineStreams(liveRows.map((l) => l.login));
  return {
    tracked: tracked.length,
    live: liveRows.length,
    samples,
    finalized,
  };
}

function startTwitchCcvCron() {
  if (_timer) return _timer;
  if (process.env.TWITCH_CCV_ENABLED === '0') {
    console.log('[twitch-ccv] disabled (TWITCH_CCV_ENABLED=0)');
    return null;
  }
  const tick = async () => {
    try {
      const r = await pollOnce();
      if (r.samples || r.finalized.length) {
        console.log(
          `[twitch-ccv] tracked=${r.tracked} live=${r.live} samples=${r.samples} finalized=${r.finalized.length}`,
        );
      }
    } catch (err) {
      console.warn('[twitch-ccv] poll failed:', err.message);
      try {
        const { logError } = require('../error_logger');
        logError('TWITCH_CCV_POLL_FAIL', err);
      } catch { /* ignore */ }
    }
  };
  // Stagger first tick so boot isn't blocked
  setTimeout(tick, 15_000);
  _timer = setInterval(tick, POLL_MS);
  if (_timer.unref) _timer.unref();
  console.log(`[twitch-ccv] cron started (every ${POLL_MS}ms)`);
  return _timer;
}

function stopTwitchCcvCron() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/**
 * Peaks for a brand (or login) — demo / product API.
 */
async function listPeaksForBrand({ brandId, twitchLogin, limit = 10 } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  let result;
  if (brandId) {
    result = await dbQuery(
      `SELECT id, brand_id, twitch_login, title, game_name, started_at, ended_at,
              peak_viewers, peak_at, peak_offset_sec, avg_viewers, sample_count,
              vod_id, vod_url, status
         FROM twitch_ccv_streams
        WHERE brand_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [brandId, lim],
    );
  } else if (twitchLogin) {
    result = await dbQuery(
      `SELECT id, brand_id, twitch_login, title, game_name, started_at, ended_at,
              peak_viewers, peak_at, peak_offset_sec, avg_viewers, sample_count,
              vod_id, vod_url, status
         FROM twitch_ccv_streams
        WHERE twitch_login = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [String(twitchLogin).toLowerCase(), lim],
    );
  } else {
    return [];
  }
  return (result.rows || []).map((r) => ({
    id: r.id,
    brandId: r.brand_id,
    twitchLogin: r.twitch_login,
    title: r.title,
    gameName: r.game_name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    peakViewers: r.peak_viewers,
    peakAt: r.peak_at,
    peakOffsetSec: r.peak_offset_sec,
    avgViewers: r.avg_viewers != null ? Number(r.avg_viewers) : null,
    sampleCount: r.sample_count,
    vodId: r.vod_id,
    vodUrl: r.vod_url,
    status: r.status,
    peakClock: formatOffset(r.peak_offset_sec),
  }));
}

async function getSampleSeries(streamId, { maxPoints = 120 } = {}) {
  const result = await dbQuery(
    `SELECT sampled_at, viewer_count, offset_sec
       FROM twitch_ccv_samples
      WHERE stream_id = $1
      ORDER BY sampled_at ASC`,
    [streamId],
  );
  const rows = result.rows || [];
  if (rows.length <= maxPoints) {
    return rows.map((r) => ({
      at: r.sampled_at,
      viewers: r.viewer_count,
      offsetSec: r.offset_sec,
    }));
  }
  // Downsample evenly for demo charts
  const step = rows.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const r = rows[Math.min(rows.length - 1, Math.floor(i * step))];
    out.push({ at: r.sampled_at, viewers: r.viewer_count, offsetSec: r.offset_sec });
  }
  return out;
}

function formatOffset(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  const s = Math.max(0, Math.floor(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

module.exports = {
  listTrackedLogins,
  pollOnce,
  startTwitchCcvCron,
  stopTwitchCcvCron,
  listPeaksForBrand,
  getSampleSeries,
  formatOffset,
  POLL_MS,
};
