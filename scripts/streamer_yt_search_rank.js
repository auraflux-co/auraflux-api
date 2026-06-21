#!/usr/bin/env node
/**
 * Rank Twitch roster candidates by YouTube *search* demand (not viewCount).
 *
 * Uses search.list order=relevance and sums pageInfo.totalResults across
 * query templates — higher total ≈ more indexed search surface for that name.
 *
 * Usage:
 *   node scripts/streamer_yt_search_rank.js
 *   node scripts/streamer_yt_search_rank.js --names adapt,marlon,maya
 *   node scripts/streamer_yt_search_rank.js --out logs/streamer_yt_search_rank.json
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const QUERY_TEMPLATES = [
  '{name} live',
  '{name} twitch live',
  '{name} stream live',
  'watch {name} live twitch',
];

const DEFAULT_NAMES = [
  'adapt', 'marlon', 'extraemily', 'maya', 'cinna', 'yonnajay', 'jaycinco', 'hasanabi',
  'plaqueboymax', 'caseoh_', 'jynxzi', 'n3on', 'trainwreckstv', 'mizkif', 'emiru', 'ishowspeed',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { out: path.join(__dirname, '..', 'logs', 'streamer_yt_search_rank.json'), names: DEFAULT_NAMES };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--names') opts.names = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (args[i] === '--out') opts.out = args[i + 1].startsWith('/') ? args[++i] : path.join(process.cwd(), args[++i]);
  }
  return opts;
}

async function searchOne(http, key, q, order) {
  const params = {
    part: 'snippet',
    type: 'video',
    q,
    maxResults: 5,
    order,
    key,
    relevanceLanguage: 'en',
    regionCode: 'US',
  };
  const r = await http.get('https://www.googleapis.com/youtube/v3/search', { params });
  const total = Number(r.data.pageInfo?.totalResults || 0);
  const titles = (r.data.items || []).map(i => i.snippet?.title || '');
  const firstToken = q.split(/\s+/)[0];
  const nameMatch = titles.filter(t => new RegExp(firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)).length;
  return { total, nameMatch, topTitle: titles[0] || '' };
}

async function rankName(http, key, name) {
  let relevanceTotal = 0;
  let viewTotal = 0;
  let relevanceHits = 0;
  let sample = null;
  const errors = [];

  for (const tpl of QUERY_TEMPLATES) {
    const q = tpl.replace('{name}', name);
    try {
      const rel = await searchOne(http, key, q, 'relevance');
      const vc = await searchOne(http, key, q, 'viewCount');
      relevanceTotal += rel.total;
      viewTotal += vc.total;
      relevanceHits += rel.nameMatch;
      if (tpl === '{name} twitch live') {
        sample = { q, relTotal: rel.total, relTop: rel.topTitle.slice(0, 80) };
      }
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      errors.push({ q, message: e.response?.data?.error?.message || e.message });
    }
  }

  return { name, relevanceTotal, viewTotal, relevanceHits, sample, errors };
}

async function main() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error('YOUTUBE_API_KEY not set');
    process.exit(1);
  }
  const opts = parseArgs();
  const http = axios.create({
    timeout: 20000,
    headers: { Referer: 'https://auraflux-api.onrender.com/' },
  });

  const rows = [];
  for (const name of opts.names) {
    process.stderr.write(`search ${name}…\n`);
    rows.push(await rankName(http, key, name));
  }
  rows.sort((a, b) => b.relevanceTotal - a.relevanceTotal);

  const payload = {
    generatedAt: new Date().toISOString(),
    methodology: 'YouTube search.list — order=relevance, sum pageInfo.totalResults across 4 query templates (search demand proxy, not viewCount)',
    queryTemplates: QUERY_TEMPLATES,
    rows,
  };

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);

  console.log('Ranked by search relevance (totalResults sum):\n');
  for (const r of rows) {
    console.log(
      String(r.relevanceTotal).padStart(12),
      'hits',
      String(r.relevanceHits).padStart(2),
      r.name.padEnd(16),
      '|',
      (r.sample?.relTop || r.errors[0]?.message || '').slice(0, 55),
    );
  }
  console.log(`\n→ ${opts.out}`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
