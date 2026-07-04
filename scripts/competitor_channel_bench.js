#!/usr/bin/env node
'use strict';
/**
 * Competitive bench — public YouTube catalog via yt-dlp (titles, tags, SEO patterns).
 * Usage: node scripts/competitor_channel_bench.js [--limit 40] [--out logs/competitor_bench.json]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HANDLES = [
  'imgoochy',
  'rickclipit',
  'stream.serpent',
  'core_fx',
  'DahBluh',
  'UltronOnline',
  'ContentDelta',
  'StreamScheme',
  'PhoenixyClips',
  'jaymoji',
  'clipzworldnews',
];

const TABS = ['shorts', 'videos', 'streams'];

function runYtdlp(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function extractHashtags(text) {
  return [...new Set(String(text || '').match(/#[\w.]+/g) || [])].map((h) => h.toLowerCase());
}

function titlePattern(title) {
  const t = String(title || '');
  if (/^\d{2}\.\d{2}\.\d{2}\s*\|/.test(t)) return 'date_pipe_hashtag';
  if (/^when\s/i.test(t)) return 'when_question';
  if (/\?$/.test(t.trim())) return 'question';
  if (/^(this|the)\s/i.test(t)) return 'this_the_hook';
  if (/\b(insane|crazy|wild|unbelievable|moment|reacts|react)\b/i.test(t)) return 'hype_word';
  if (t.length <= 35) return 'short_punchy';
  return 'descriptive';
}

async function listTab(handle, tab, limit) {
  const url = `https://www.youtube.com/@${handle}/${tab}`;
  const stdout = await runYtdlp(['--flat-playlist', '-j', '--playlist-end', String(limit), url]);
  const rows = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.id) rows.push({ id: d.id, title: d.title || '', tab });
    } catch { /* skip */ }
  }
  return rows;
}

async function fetchDetails(entries) {
  if (!entries.length) return [];
  const CHUNK = 6;
  const detailMap = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const urls = chunk.map((e) => `https://www.youtube.com/watch?v=${e.id}`);
    try {
      const stdout = await runYtdlp(['-j', '--no-download', ...urls], 90000);
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.id) detailMap[d.id] = d;
        } catch { /* skip */ }
      }
    } catch (e) {
      console.warn('chunk fail:', e.message.slice(0, 80));
    }
  }
  return entries.map((meta) => {
    const d = detailMap[meta.id];
    if (!d) return { ...meta, error: 'no_detail' };
    const dur = d.duration || 0;
    const desc = d.description || '';
    const tags = d.tags || [];
    const title = d.title || meta.title;
    const allTags = [...extractHashtags(title), ...extractHashtags(desc), ...tags.map((t) => `#${t.replace(/\s+/g, '')}`.toLowerCase())];
    return {
      id: meta.id,
      title,
      tab: meta.tab,
      durationSec: dur,
      isShort: dur > 0 && dur <= 60,
      isLongVod: dur > 600,
      wasLive: !!d.was_live,
      views: d.view_count || 0,
      likes: d.like_count || 0,
      comments: d.comment_count || 0,
      uploadDate: d.upload_date || '',
      channel: d.channel || d.uploader || '',
      subs: d.channel_follower_count ?? null,
      descriptionLen: desc.length,
      tagCount: tags.length,
      hashtags: [...new Set(allTags)].slice(0, 20),
      titlePattern: titlePattern(title),
      titleLen: title.length,
      hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(title),
      url: `https://www.youtube.com/watch?v=${meta.id}`,
    };
  });
}

function summarize(handle, items) {
  const ok = items.filter((i) => !i.error);
  const shorts = ok.filter((i) => i.isShort || i.tab === 'shorts');
  const vods = ok.filter((i) => !i.isShort && (i.tab === 'videos' || i.isLongVod));
  const streams = ok.filter((i) => i.tab === 'streams' || i.wasLive);
  const avg = (arr, key) => (arr.length ? Math.round(arr.reduce((s, x) => s + (x[key] || 0), 0) / arr.length) : 0);

  const patternCounts = {};
  const hashtagCounts = {};
  for (const i of ok) {
    patternCounts[i.titlePattern] = (patternCounts[i.titlePattern] || 0) + 1;
    for (const h of i.hashtags || []) hashtagCounts[h] = (hashtagCounts[h] || 0) + 1;
  }
  const topHashtags = Object.entries(hashtagCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topShorts = [...shorts].sort((a, b) => b.views - a.views).slice(0, 5);
  const topVods = [...vods].sort((a, b) => b.views - a.views).slice(0, 5);

  return {
    handle,
    channel: ok[0]?.channel || handle,
    subscriberCount: ok[0]?.subs ?? null,
    sampleSize: ok.length,
    totals: { views: ok.reduce((s, i) => s + i.views, 0) },
    bySurface: {
      shorts: { count: shorts.length, avgViews: avg(shorts, 'views'), avgTitleLen: avg(shorts, 'titleLen') },
      videos: { count: vods.length, avgViews: avg(vods, 'views'), avgTitleLen: avg(vods, 'titleLen'), avgDurationMin: Math.round(avg(vods, 'durationSec') / 60) },
      streams: { count: streams.length, avgViews: avg(streams, 'views') },
    },
    seo: {
      avgDescriptionLen: avg(ok, 'descriptionLen'),
      avgTagCount: avg(ok, 'tagCount'),
      emojiTitlePct: ok.length ? Math.round((ok.filter((i) => i.hasEmoji).length / ok.length) * 100) : 0,
      topHashtags,
      titlePatterns: patternCounts,
    },
    topShorts: topShorts.map((s) => ({ title: s.title, views: s.views, hashtags: s.hashtags.slice(0, 5), pattern: s.titlePattern })),
    topVods: topVods.map((v) => ({ title: v.title, views: v.views, durationMin: Math.round(v.durationSec / 60), hashtags: v.hashtags.slice(0, 5) })),
  };
}

async function analyzeHandle(handle, limit) {
  console.log(`[bench] @${handle}…`);
  const byId = new Map();
  for (const tab of TABS) {
    try {
      const listed = await listTab(handle, tab, limit);
      for (const row of listed) byId.set(row.id, row);
    } catch (e) {
      console.warn(`  tab ${tab}: ${e.message.slice(0, 60)}`);
    }
  }
  const items = await fetchDetails([...byId.values()]);
  return summarize(handle, items);
}

async function main() {
  const limit = Number(process.argv.find((a, i) => process.argv[i - 1] === '--limit') || 35);
  const outArg = process.argv.find((a, i) => process.argv[i - 1] === '--out');
  const outPath = outArg || path.join(__dirname, '../logs/competitor_bench.json');
  const reports = [];
  for (const h of HANDLES) {
    try {
      reports.push(await analyzeHandle(h, limit));
    } catch (e) {
      reports.push({ handle: h, error: e.message });
    }
  }
  const payload = { generatedAt: new Date().toISOString(), limit, reports };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
