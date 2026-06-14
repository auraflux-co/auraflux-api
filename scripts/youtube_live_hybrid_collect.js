#!/usr/bin/env node
/**
 * Hybrid YouTube live VOD collector — yt-dlp search (no Search API quota)
 * + Data API videos.list for liveStreamingDetails + stats.
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yt = require('../lib/services/youtube_direct');

const LOGS = path.join(__dirname, '..', 'logs');
const FULL_PATH = path.join(LOGS, 'youtube_live_ranked_full.json');
const IDS_PATH = path.join(LOGS, 'youtube_live_ytdlp_ids.json');

const QUERIES = [
  'live stream', 'live news', 'live breaking news', 'live sports', 'live gaming',
  '24/7 live', 'live coverage', 'live event', 'watch party live', 'live cricket',
  'live football', 'live esports', 'live election', 'live debate', 'live awards',
  'live final', 'live press conference', 'live tornado', 'live weather', 'live launch',
  'live podcast', 'live concert', 'multiview live', 'live reaction', 'live keynote',
  'IPL live', 'NBA live', 'World Cup live', 'Eurovision live', 'valorant live',
  'roblox live', 'news live now', 'live hearing', 'live trial', 'live championship',
];

const DAYS = 30;
const YTSEARCH_N = 150;

function ytdlpIds(query) {
  try {
    const q = query.replace(/"/g, '');
    const out = execSync(
      `yt-dlp "ytsearch${YTSEARCH_N}:${q}" --flat-playlist --print "%(id)s" --no-warnings`,
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120000 },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error('yt-dlp fail', query, e.message?.slice(0, 80));
    return [];
  }
}

async function fetchVideoDetails(allIds, headers) {
  const videos = [];
  for (let i = 0; i < allIds.length; i += 50) {
    const batch = allIds.slice(i, i + 50);
    try {
      const vr = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet,statistics,liveStreamingDetails', id: batch.join(',') },
        headers,
      });
      videos.push(...(vr.data.items || []));
    } catch (e) {
      console.error('videos.list batch fail', e.response?.data?.error?.message || e.message);
    }
    if (i > 0 && i % 500 === 0) console.error(`  fetched ${i}/${allIds.length}…`);
  }
  return videos;
}

function rankLiveVods(videos, startMs, endMs) {
  return videos
    .filter((v) => v.liveStreamingDetails?.actualStartTime)
    .map((v) => {
      const live = v.liveStreamingDetails;
      const startT = new Date(live.actualStartTime).getTime();
      const endT = live.actualEndTime ? new Date(live.actualEndTime).getTime() : null;
      return {
        id: v.id,
        url: `https://youtube.com/watch?v=${v.id}`,
        views: parseInt(v.statistics?.viewCount || '0', 10),
        title: v.snippet?.title,
        channel: v.snippet?.channelTitle,
        channelId: v.snippet?.channelId,
        liveStart: live.actualStartTime,
        liveEnd: live.actualEndTime || null,
        durationHrs: endT ? +(((endT - startT) / 3600000).toFixed(1)) : null,
      };
    })
    .filter((v) => {
      const t = new Date(v.liveStart).getTime();
      return t >= startMs && t <= endMs;
    })
    .sort((a, b) => b.views - a.views);
}

async function main() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS);

  const seen = new Set();

  // Seed from prior top-200 scan
  const prior = path.join(LOGS, 'youtube_top200_live_30d.json');
  if (fs.existsSync(prior)) {
    const d = JSON.parse(fs.readFileSync(prior, 'utf8'));
    for (const v of d.all200 || []) seen.add(v.id);
    console.error(`Seeded ${seen.size} IDs from top200 file`);
  }

  for (const q of QUERIES) {
    const ids = ytdlpIds(q);
    const before = seen.size;
    ids.forEach((id) => seen.add(id));
    console.error(`yt-dlp "${q}": +${seen.size - before} new (${ids.length} returned)`);
  }

  const allIds = [...seen];
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(IDS_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: 'yt-dlp ytsearch + prior top200',
    count: allIds.length,
    ids: allIds,
  }, null, 2)}\n`);
  console.error(`Total unique IDs: ${allIds.length}`);

  const token = await yt.getAccessToken();
  const h = { Authorization: `Bearer ${token}` };
  const videos = await fetchVideoDetails(allIds, h);
  const ranked = rankLiveVods(videos, start.getTime(), end.getTime());

  fs.writeFileSync(FULL_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: 'hybrid ytdlp + videos.list',
    windowDays: DAYS,
    publishedAfter: start.toISOString(),
    publishedBefore: end.toISOString(),
    idsScanned: allIds.length,
    liveVodsMatched: ranked.length,
    ranked: ranked.map((v, i) => ({ rank: i + 1, ...v })),
  }, null, 2)}\n`);

  console.error(`Live VODs in 30d window: ${ranked.length} → ${FULL_PATH}`);
  console.log(JSON.stringify({ ok: true, ids: allIds.length, liveVods: ranked.length }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
