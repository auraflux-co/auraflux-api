'use strict';
/**
 * lib/kick_ccv/index.js — Customer-scoped Kick CCV capture
 *
 * Official Kick Dev public API only (no Apify, no scrape):
 *   1. Read kickUsername from active client_plans.source_channels
 *   2. App token (client_credentials) → GET /public/v1/channels?slug=
 *      and GET /public/v1/users/livestreams?user_id= for livestream UUID
 *   3. Store samples + running peak while live
 *   4. When offline, link VOD as https://kick.com/{slug}/videos/{uuid}?t={intSeconds}
 *
 * Requires KICK_CLIENT_ID + KICK_CLIENT_SECRET.
 * Partner/Verified Analytics is out of scope — public player ?t= only.
 */

const fetch = require('node-fetch');
const { query: dbQuery } = require('../db/postgres');

const API_BASE = 'https://api.kick.com/public/v1';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const POLL_MS = Math.max(30_000, parseInt(process.env.KICK_CCV_POLL_MS || '60000', 10));

let _timer = null;
let _appToken = null;
let _appTokenExpiresAt = 0;

async function getAppAccessToken() {
  const clientId = process.env.KICK_CLIENT_ID;
  const clientSecret = process.env.KICK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('KICK_CLIENT_ID / KICK_CLIENT_SECRET required for Kick CCV poll');
  }
  const now = Date.now();
  if (_appToken && now < _appTokenExpiresAt - 60_000) return _appToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    timeout: 20000,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kick app token failed (${res.status}): ${text.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Kick app token non-JSON: ${text.slice(0, 200)}`);
  }
  _appToken = data.access_token;
  const expiresIn = Number(data.expires_in) || 3600;
  _appTokenExpiresAt = now + expiresIn * 1000;
  return _appToken;
}

async function kickGet(pathWithQuery) {
  const token = await getAppAccessToken();
  const res = await fetch(`${API_BASE}${pathWithQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kick API ${pathWithQuery} → ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Kick API non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * @returns {Promise<Array<{ brandId: string|null, customerId: string|null, kickSlug: string }>>}
 */
async function listTrackedSlugs() {
  const result = await dbQuery(
    `SELECT brand_id, client_id, source_channels
       FROM client_plans
      WHERE active = TRUE
        AND source_channels ? 'kickUsername'
        AND NULLIF(TRIM(source_channels->>'kickUsername'), '') IS NOT NULL`,
  );
  const out = [];
  const seen = new Set();
  for (const row of result.rows || []) {
    const slug = String(row.source_channels?.kickUsername || '').trim().toLowerCase().replace(/^@/, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      brandId: row.brand_id || null,
      customerId: row.client_id || null,
      kickSlug: slug,
    });
  }
  return out;
}

/**
 * Resolve live state for one slug via official channels + livestreams endpoints.
 */
async function fetchLiveForSlug(slug) {
  const chBody = await kickGet(`/channels?slug=${encodeURIComponent(slug)}`);
  const ch = (chBody?.data || [])[0];
  if (!ch) return null;

  const stream = ch.stream || {};
  const isLive = !!stream.is_live;
  const userId = ch.broadcaster_user_id != null ? String(ch.broadcaster_user_id) : null;
  if (!isLive) {
    return {
      slug,
      userId,
      isLive: false,
      viewerCount: 0,
      streamId: null,
      title: ch.stream_title || null,
      categoryName: ch.category?.name || null,
      startedAt: null,
    };
  }

  let streamId = null;
  if (userId) {
    try {
      const liveBody = await kickGet(`/users/livestreams?user_id=${encodeURIComponent(userId)}`);
      const lives = liveBody?.data || [];
      const match = lives.find((l) => String(l?.channel?.slug || '').toLowerCase() === slug) || lives[0];
      if (match?.id) streamId = String(match.id);
      if (match?.title && !ch.stream_title) ch.stream_title = match.title;
      if (match?.started_at) stream.start_time = match.started_at;
      if (match?.viewer_count != null) stream.viewer_count = match.viewer_count;
      if (match?.category?.name) ch.category = match.category;
    } catch (err) {
      console.warn(`[kick-ccv] users/livestreams failed for ${slug}: ${err.message}`);
    }
  }

  return {
    slug,
    userId,
    isLive: true,
    viewerCount: Number(stream.viewer_count) || 0,
    streamId,
    title: ch.stream_title || null,
    categoryName: ch.category?.name || null,
    startedAt: stream.start_time || null,
  };
}

function buildVodUrl(slug, vodId) {
  if (!slug || !vodId) return null;
  return `https://kick.com/${encodeURIComponent(slug)}/videos/${vodId}`;
}

async function upsertLiveSample(tracked, live) {
  const startedAt = live.startedAt && live.startedAt !== '0001-01-01T00:00:00Z'
    ? live.startedAt
    : new Date().toISOString();
  const existing = await dbQuery(
    `SELECT id, started_at, peak_viewers, sample_count
       FROM kick_ccv_streams
      WHERE kick_slug = $1 AND status = 'live'
      LIMIT 1`,
    [tracked.kickSlug],
  );
  let streamId;
  let streamStarted = startedAt;
  if (existing.rows[0]) {
    streamId = existing.rows[0].id;
    streamStarted = existing.rows[0].started_at;
  } else {
    const provisionalVod = live.streamId
      ? buildVodUrl(tracked.kickSlug, live.streamId)
      : null;
    const ins = await dbQuery(
      `INSERT INTO kick_ccv_streams
         (brand_id, customer_id, kick_slug, kick_user_id, kick_stream_id,
          title, category_name, started_at, peak_viewers, peak_at, peak_offset_sec,
          sample_count, vod_id, vod_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,0,0,$10,$11,'live')
       RETURNING id, started_at`,
      [
        tracked.brandId,
        tracked.customerId,
        tracked.kickSlug,
        live.userId || null,
        live.streamId || null,
        live.title,
        live.categoryName,
        startedAt,
        live.viewerCount,
        live.streamId || null,
        provisionalVod,
      ],
    );
    streamId = ins.rows[0].id;
    streamStarted = ins.rows[0].started_at;
  }

  const offsetSec = Math.max(0, Math.floor((Date.now() - new Date(streamStarted).getTime()) / 1000));
  await dbQuery(
    `INSERT INTO kick_ccv_samples (stream_id, viewer_count, offset_sec)
     VALUES ($1, $2, $3)`,
    [streamId, live.viewerCount, offsetSec],
  );

  const prevPeak = Number(existing.rows[0]?.peak_viewers) || 0;
  const isNewPeak = live.viewerCount >= prevPeak;
  const vodUrl = live.streamId ? buildVodUrl(tracked.kickSlug, live.streamId) : null;
  await dbQuery(
    `UPDATE kick_ccv_streams SET
        kick_user_id = COALESCE($2, kick_user_id),
        kick_stream_id = COALESCE($3, kick_stream_id),
        title = COALESCE($4, title),
        category_name = COALESCE($5, category_name),
        brand_id = COALESCE($6, brand_id),
        customer_id = COALESCE($7, customer_id),
        peak_viewers = $8,
        peak_at = CASE WHEN $10 THEN NOW() ELSE peak_at END,
        peak_offset_sec = CASE WHEN $10 THEN $9 ELSE peak_offset_sec END,
        sample_count = sample_count + 1,
        avg_viewers = (
          COALESCE(avg_viewers, 0) * sample_count + $11
        ) / NULLIF(sample_count + 1, 0),
        vod_id = COALESCE($12, vod_id),
        vod_url = COALESCE($13, vod_url),
        updated_at = NOW()
      WHERE id = $1`,
    [
      streamId,
      live.userId || null,
      live.streamId || null,
      live.title,
      live.categoryName,
      tracked.brandId,
      tracked.customerId,
      Math.max(prevPeak, live.viewerCount),
      offsetSec,
      isNewPeak,
      live.viewerCount,
      live.streamId || null,
      vodUrl,
    ],
  );
  return { streamId, isNewPeak, offsetSec, viewerCount: live.viewerCount };
}

async function finalizeOfflineStreams(liveSlugs) {
  const liveSet = new Set(liveSlugs);
  const open = await dbQuery(
    `SELECT id, kick_slug, kick_stream_id, vod_id, status
       FROM kick_ccv_streams
      WHERE status IN ('live', 'ended')`,
  );
  const results = [];
  for (const row of open.rows || []) {
    if (row.status === 'live' && liveSet.has(row.kick_slug)) continue;

    if (row.status === 'live') {
      await dbQuery(
        `UPDATE kick_ccv_streams
            SET status = 'ended', ended_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [row.id],
      );
    }

    const vodId = row.vod_id || row.kick_stream_id;
    if (vodId) {
      const vodUrl = buildVodUrl(row.kick_slug, vodId);
      await dbQuery(
        `UPDATE kick_ccv_streams
            SET vod_id = $2, vod_url = $3, status = 'linked', updated_at = NOW()
          WHERE id = $1`,
        [row.id, vodId, vodUrl],
      );
      results.push({ id: row.id, slug: row.kick_slug, vodId, linked: true });
    } else {
      results.push({ id: row.id, slug: row.kick_slug, linked: false });
    }
  }
  return results;
}

async function pollOnce() {
  const tracked = await listTrackedSlugs();
  if (!tracked.length) {
    return { tracked: 0, live: 0, samples: 0, finalized: [] };
  }
  const liveSlugs = [];
  let samples = 0;
  for (const t of tracked) {
    try {
      const live = await fetchLiveForSlug(t.kickSlug);
      if (!live || !live.isLive) continue;
      liveSlugs.push(t.kickSlug);
      await upsertLiveSample(t, live);
      samples += 1;
    } catch (err) {
      console.warn(`[kick-ccv] poll ${t.kickSlug} failed: ${err.message}`);
    }
  }
  const finalized = await finalizeOfflineStreams(liveSlugs);
  return {
    tracked: tracked.length,
    live: liveSlugs.length,
    samples,
    finalized,
  };
}

function startKickCcvCron() {
  if (_timer) return _timer;
  if (process.env.KICK_CCV_ENABLED === '0') {
    console.log('[kick-ccv] disabled (KICK_CCV_ENABLED=0)');
    return null;
  }
  if (!process.env.KICK_CLIENT_ID || !process.env.KICK_CLIENT_SECRET) {
    console.log('[kick-ccv] skipped (missing KICK_CLIENT_ID / KICK_CLIENT_SECRET)');
    return null;
  }
  const tick = async () => {
    try {
      const r = await pollOnce();
      if (r.samples || r.finalized.length) {
        console.log(
          `[kick-ccv] tracked=${r.tracked} live=${r.live} samples=${r.samples} finalized=${r.finalized.length}`,
        );
      }
    } catch (err) {
      console.warn('[kick-ccv] poll failed:', err.message);
      try {
        const { logError } = require('../error_logger');
        logError('KICK_CCV_POLL_FAIL', err);
      } catch { /* ignore */ }
    }
  };
  setTimeout(tick, 25_000);
  _timer = setInterval(tick, POLL_MS);
  if (_timer.unref) _timer.unref();
  console.log(`[kick-ccv] cron started (every ${POLL_MS}ms)`);
  return _timer;
}

function stopKickCcvCron() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

async function listPeaksForBrand({ brandId, kickSlug, limit = 10 } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  const slug = kickSlug ? String(kickSlug).trim().toLowerCase().replace(/^@/, '') : null;
  let result;
  if (brandId && slug) {
    result = await dbQuery(
      `SELECT id, brand_id, kick_slug, title, category_name, started_at, ended_at,
              peak_viewers, peak_at, peak_offset_sec, avg_viewers, sample_count,
              vod_id, vod_url, status
         FROM kick_ccv_streams
        WHERE brand_id = $1 OR kick_slug = $2
        ORDER BY started_at DESC
        LIMIT $3`,
      [brandId, slug, lim],
    );
  } else if (brandId) {
    result = await dbQuery(
      `SELECT id, brand_id, kick_slug, title, category_name, started_at, ended_at,
              peak_viewers, peak_at, peak_offset_sec, avg_viewers, sample_count,
              vod_id, vod_url, status
         FROM kick_ccv_streams
        WHERE brand_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [brandId, lim],
    );
  } else if (slug) {
    result = await dbQuery(
      `SELECT id, brand_id, kick_slug, title, category_name, started_at, ended_at,
              peak_viewers, peak_at, peak_offset_sec, avg_viewers, sample_count,
              vod_id, vod_url, status
         FROM kick_ccv_streams
        WHERE kick_slug = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [slug, lim],
    );
  } else {
    return [];
  }
  return (result.rows || []).map((r) => ({
    id: r.id,
    brandId: r.brand_id,
    kickSlug: r.kick_slug,
    title: r.title,
    categoryName: r.category_name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    peakViewers: r.peak_viewers,
    peakAt: r.peak_at,
    peakOffsetSec: r.peak_offset_sec,
    avgViewers: r.avg_viewers != null ? Number(r.avg_viewers) : null,
    sampleCount: r.sample_count,
    vodId: r.vod_id,
    vodUrl: r.vod_url,
    vodUrlAtPeak: vodUrlAtPeak(r.vod_url, r.peak_offset_sec),
    status: r.status,
    peakClock: formatOffset(r.peak_offset_sec),
  }));
}

async function getSampleSeries(streamId, { maxPoints = 120 } = {}) {
  const result = await dbQuery(
    `SELECT sampled_at, viewer_count, offset_sec
       FROM kick_ccv_samples
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

/**
 * Kick public player: integer seconds only (?t=3600 works; ?t=3600s / ?t=1h do not).
 */
function formatKickTimestamp(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  return String(Math.max(0, Math.floor(Number(sec))));
}

function vodUrlAtPeak(vodUrl, peakOffsetSec) {
  if (!vodUrl) return null;
  const t = formatKickTimestamp(peakOffsetSec);
  if (t == null) return vodUrl;
  try {
    const u = new URL(vodUrl);
    u.searchParams.set('t', t);
    return u.toString();
  } catch {
    const sep = String(vodUrl).includes('?') ? '&' : '?';
    return `${vodUrl}${sep}t=${t}`;
  }
}

module.exports = {
  listTrackedSlugs,
  pollOnce,
  startKickCcvCron,
  stopKickCcvCron,
  listPeaksForBrand,
  getSampleSeries,
  formatOffset,
  formatKickTimestamp,
  vodUrlAtPeak,
  buildVodUrl,
  POLL_MS,
};
