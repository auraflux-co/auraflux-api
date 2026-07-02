'use strict';
/**
 * CPD-1209 — Productized competitor tracking.
 *
 * Pulls each configured channel's recent Shorts catalog via yt-dlp flat
 * playlists (public data, no API quota), snapshots into competitor_videos,
 * detects outliers (views >= 3x channel median), and exposes title patterns
 * for recommendContext injection.
 *
 * yt-dlp execution is injectable (opts.fetchCatalog) so tests run offline.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getDb } = require('../db');

const CONFIG_PATH = path.join(__dirname, '../../config/competitors.json');
const OUTLIER_MULTIPLE = 3;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { youtube: [], limitPerChannel: 30 };
  }
}

function ytDlpCatalog(handle, limit) {
  const url = `https://www.youtube.com/@${handle}/shorts`;
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', ['--flat-playlist', '--playlist-end', String(limit), '-J', url],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          resolve((data.entries || []).map((e) => ({
            videoId: e.id,
            title: e.title || '',
            views: Number(e.view_count || 0),
            durationSec: Number(e.duration || 0),
            isShort: true,
          })));
        } catch (e) {
          reject(e);
        }
      });
  });
}

/**
 * Sync all configured competitor channels. Returns per-channel counts and
 * newly discovered videos (upload alerts).
 */
async function syncCompetitors(opts = {}) {
  const config = loadConfig();
  const channels = opts.handles
    ? config.youtube.filter((c) => opts.handles.includes(c.handle))
    : config.youtube;
  const limit = opts.limitPerChannel || config.limitPerChannel || 30;
  const fetchCatalog = opts.fetchCatalog || ytDlpCatalog;
  const db = getDb();
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO competitor_videos (platform, channel_handle, video_id, title, views, duration_sec, is_short, first_seen_at, fetched_at)
    VALUES ('youtube', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, video_id) DO UPDATE SET
      title = excluded.title,
      views = excluded.views,
      duration_sec = excluded.duration_sec,
      fetched_at = excluded.fetched_at
  `);
  const exists = db.prepare('SELECT 1 FROM competitor_videos WHERE platform = ? AND video_id = ?');

  const results = [];
  const newVideos = [];
  for (const ch of channels) {
    try {
      const catalog = await fetchCatalog(ch.handle, limit);
      let added = 0;
      for (const v of catalog) {
        if (!v.videoId) continue;
        const isNew = !exists.get('youtube', v.videoId);
        upsert.run(ch.handle, v.videoId, v.title, v.views, v.durationSec, v.isShort ? 1 : 0, now, now);
        if (isNew) {
          added += 1;
          newVideos.push({ channel: ch.handle, videoId: v.videoId, title: v.title, views: v.views });
        }
      }
      results.push({ ok: true, channel: ch.handle, fetched: catalog.length, new: added });
    } catch (e) {
      results.push({ ok: false, channel: ch.handle, error: e.message });
    }
  }
  return { ok: true, results, newVideos };
}

function listCompetitorVideos({ channel, limit = 50 } = {}) {
  const db = getDb();
  const rows = channel
    ? db.prepare('SELECT * FROM competitor_videos WHERE channel_handle = ? ORDER BY views DESC LIMIT ?').all(channel, limit)
    : db.prepare('SELECT * FROM competitor_videos ORDER BY views DESC LIMIT ?').all(limit);
  return rows;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Outliers: videos with views >= OUTLIER_MULTIPLE x their channel's median.
 * These are the titles worth pattern-matching against.
 */
function detectOutliers({ limit = 20 } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM competitor_videos').all();
  const byChannel = new Map();
  for (const r of rows) {
    if (!byChannel.has(r.channel_handle)) byChannel.set(r.channel_handle, []);
    byChannel.get(r.channel_handle).push(r);
  }
  const outliers = [];
  for (const [channel, vids] of byChannel) {
    const med = median(vids.map((v) => v.views || 0));
    if (med <= 0) continue;
    for (const v of vids) {
      if ((v.views || 0) >= med * OUTLIER_MULTIPLE) {
        outliers.push({
          channel,
          videoId: v.video_id,
          title: v.title,
          views: v.views,
          multiple: Math.round(((v.views || 0) / med) * 10) / 10,
        });
      }
    }
  }
  return outliers.sort((a, b) => b.views - a.views).slice(0, limit);
}

/**
 * Prompt block of competitor title patterns for recommendContext.
 * Best-effort from the local snapshot — no network.
 */
function competitorPatterns({ limit = 5 } = {}) {
  const outliers = detectOutliers({ limit });
  if (!outliers.length) return null;
  const lines = outliers.map((o) => `  • [${o.channel}] "${o.title}" — ${Number(o.views).toLocaleString()} views (${o.multiple}x channel median)`);
  return {
    outliers,
    promptBlock: `Competitor outlier titles (study the pattern — hook structure, named streamer, curiosity gap — do NOT copy):\n${lines.join('\n')}`,
  };
}

module.exports = {
  loadConfig,
  syncCompetitors,
  listCompetitorVideos,
  detectOutliers,
  competitorPatterns,
};
