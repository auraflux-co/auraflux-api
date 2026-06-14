#!/usr/bin/env node
/**
 * Scan YouTube completed live VODs (last N days), rank by views, save slice.
 * Usage:
 *   node scripts/youtube_live_rank_scan.js
 *   node scripts/youtube_live_rank_scan.js --top 1000 --from 300 --to 1000
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const yt = require('../lib/services/youtube_direct');

const REPO_ROOT = path.join(__dirname, '..');
const LOGS = path.join(REPO_ROOT, 'logs');

const QUERIES = [
  'live stream', 'live news', 'watch party live', 'live breaking news',
  'live sports', 'live gaming', '24/7 live', 'live coverage', 'live event',
  'multiview live', 'live podcast', 'live concert', 'live election',
  'live debate', 'live awards', 'live championship', 'live final',
  'live press conference', 'live announcement', 'live reaction',
  'live cricket', 'live football', 'live esports', 'live keynote',
  'live tornado', 'live weather', 'live launch', 'live trial',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    days: 30,
    top: 1000,
    from: 1,
    to: 1000,
    pagesPerQuery: 5,
    out: 'youtube_top1000_live_30d.json',
    fromIds: null,
    saveFullRanked: true,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') opts.days = Number(args[++i]);
    else if (args[i] === '--top') opts.top = Number(args[++i]);
    else if (args[i] === '--from') opts.from = Number(args[++i]);
    else if (args[i] === '--to') opts.to = Number(args[++i]);
    else if (args[i] === '--pages') opts.pagesPerQuery = Number(args[++i]);
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--from-ids') opts.fromIds = args[++i];
  }
  return opts;
}

async function collectIds(opts, headers) {
  if (opts.fromIds) {
    const p = path.isAbsolute(opts.fromIds) ? opts.fromIds : path.join(LOGS, opts.fromIds);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ids = Array.isArray(raw) ? raw : (raw.ids || raw.allIds || []);
    console.error(`Loaded ${ids.length} IDs from cache ${p}`);
    return ids;
  }

  const seen = new Set();
  for (const q of QUERIES) {
    let pageToken = null;
    for (let page = 0; page < opts.pagesPerQuery; page++) {
      const params = {
        part: 'snippet',
        type: 'video',
        eventType: 'completed',
        order: 'viewCount',
        publishedAfter: opts.publishedAfter,
        publishedBefore: opts.publishedBefore,
        q,
        maxResults: 50,
        relevanceLanguage: 'en',
        regionCode: 'US',
      };
      if (pageToken) params.pageToken = pageToken;
      try {
        const sr = await axios.get('https://www.googleapis.com/youtube/v3/search', { params, headers });
        for (const item of sr.data.items || []) {
          const id = item.id?.videoId;
          if (id) seen.add(id);
        }
        pageToken = sr.data.nextPageToken;
        if (!pageToken) break;
      } catch (e) {
        const msg = e.response?.data?.error?.message || e.message;
        console.error('search fail', q, msg);
        if (/quota exceeded/i.test(msg)) throw new Error('YOUTUBE_SEARCH_QUOTA_EXCEEDED');
        break;
      }
    }
  }

  const ids = [...seen];
  const cachePath = path.join(LOGS, 'youtube_live_search_ids.json');
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowDays: opts.days,
    publishedAfter: opts.publishedAfter,
    publishedBefore: opts.publishedBefore,
    count: ids.length,
    ids,
  }, null, 2)}\n`);
  console.error(`Cached ${ids.length} search IDs → ${cachePath}`);
  return ids;
}

async function fetchVideoDetails(allIds, headers) {
  const videos = [];
  for (let i = 0; i < allIds.length; i += 50) {
    const batch = allIds.slice(i, i + 50);
    const vr = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'snippet,statistics,liveStreamingDetails', id: batch.join(',') },
      headers,
    });
    videos.push(...(vr.data.items || []));
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
  const opts = parseArgs();
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - opts.days);
  opts.publishedAfter = start.toISOString();
  opts.publishedBefore = end.toISOString();
  const startMs = start.getTime();
  const endMs = end.getTime();

  const token = await yt.getAccessToken();
  const h = { Authorization: `Bearer ${token}` };

  let allIds;
  try {
    allIds = await collectIds(opts, h);
  } catch (e) {
    if (e.message === 'YOUTUBE_SEARCH_QUOTA_EXCEEDED') {
      const cachePath = path.join(LOGS, 'youtube_live_search_ids.json');
      if (fs.existsSync(cachePath)) {
        console.error('Search quota hit — falling back to cached ID list');
        opts.fromIds = cachePath;
        allIds = await collectIds(opts, h);
      } else {
        console.error('\nYouTube Search quota exhausted and no ID cache exists.');
        console.error('The Jun 13 scan found 2,752 live VODs but only saved ranks 1–200.');
        console.error('Re-run after daily quota reset (midnight Pacific):');
        console.error('  node scripts/youtube_live_rank_scan.js --top 1000 --from 300 --to 1000\n');
        process.exit(2);
      }
    } else {
      throw e;
    }
  }

  console.error(`Collected ${allIds.length} unique IDs`);

  const videos = await fetchVideoDetails(allIds, h);
  const ranked = rankLiveVods(videos, startMs, endMs);

  if (opts.saveFullRanked) {
    const fullPath = path.join(LOGS, 'youtube_live_ranked_full.json');
    fs.writeFileSync(fullPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      windowDays: opts.days,
      publishedAfter: opts.publishedAfter,
      publishedBefore: opts.publishedBefore,
      liveVodsMatched: ranked.length,
      ranked: ranked.map((v, i) => ({ rank: i + 1, ...v })),
    }, null, 2)}\n`);
    console.error(`Saved full ranked list (${ranked.length}) → ${fullPath}`);
  }

  const topN = ranked.slice(0, opts.top).map((v, i) => ({ rank: i + 1, ...v }));
  const sliceFrom = Math.max(1, opts.from);
  const sliceTo = Math.min(opts.to, topN.length);
  const slice = topN.filter((v) => v.rank >= sliceFrom && v.rank <= sliceTo);

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: opts.days,
    publishedAfter: opts.publishedAfter,
    publishedBefore: opts.publishedBefore,
    idsScanned: allIds.length,
    liveVodsMatched: ranked.length,
    topSaved: topN.length,
    rankRange: { from: sliceFrom, to: sliceTo, count: slice.length },
    top20: topN.slice(0, 20),
    [`ranks${sliceFrom}to${sliceTo}`]: slice,
    all: topN,
  };

  fs.mkdirSync(LOGS, { recursive: true });
  const outPath = path.join(LOGS, opts.out);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`Ranked ${ranked.length} live VODs; saved top ${topN.length} → ${outPath}`);
  console.log(`\n=== RANKS ${sliceFrom}–${sliceTo} (${slice.length} videos) ===\n`);
  console.log('| rank | views | hrs | channel | title |');
  console.log('|------|------:|----:|---------|-------|');
  for (const v of slice) {
    const title = (v.title || '').replace(/\|/g, '/').slice(0, 52);
    const ch = (v.channel || '').slice(0, 22);
    console.log(`| ${v.rank} | ${v.views.toLocaleString()} | ${v.durationHrs ?? '?'} | ${ch} | ${title} |`);
  }
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
