#!/usr/bin/env node
/**
 * Bucket completed live VODs by view count: 5k → 10k → 20k … → 250k+ (doubling).
 * Reads logs/youtube_live_ranked_full.json or runs scan first.
 *
 *   node scripts/youtube_live_view_bands.js
 *   node scripts/youtube_live_view_bands.js --scan
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOGS = path.join(__dirname, '..', 'logs');
const FULL_PATH = path.join(LOGS, 'youtube_live_ranked_full.json');
const OUT_PATH = path.join(LOGS, 'youtube_live_view_bands_30d.json');

const FLOOR = 5000;
const CEILING = 250000;

function classify(v) {
  const t = `${v.title || ''} ${v.channel || ''}`.toLowerCase();
  const rules = [
    ['world_cup_sports_match', /world cup|fifa|usa vs|mexico vs|paraguay|opening ceremony|full match|ipl |rcb vs|cricket|nba finals|knicks|spurs|uefa|champions league|psg|arsenal|fa cup|premier league|football live|goal post|cric|nfl |super bowl|mlb |wwe|ufc/i],
    ['breaking_news_politics', /live:|breaking|protest|senate|hearing|ndtv|cnbc|cnn|ms now|meidastouch|reuters|parliament|trump|election|syed suahil|bharat ki baat|news18|gma news|24 oras|untv|liputan6|associated press|hajj|news live|press conference/i],
    ['gaming_showcase_event', /game fest|game awards|xbox|playstation|nintendo direct|keynote|showcase|summer game|state of play|devolver/i],
    ['esports_tournament', /valorant|masters|grand final|mpl|bgmi|pmgo|pmpl|league of legends|cs2|dota|esports|tournament|championship final/i],
    ['irl_creator_hangout', /live stream$|just chatting|hangout|podcast live|streamer/i],
    ['creator_milestone_event', /million subscriber|subathon|subscriber live|500 million|100 million/i],
    ['entertainment_awards', /eurovision|power slap|awards|grammy|oscar|billboard/i],
    ['roblox_gaming_live', /roblox|admin abuse|minecraft live|fortnite live/i],
    ['weather_disaster', /tornado|hurricane|earthquake|wildfire|weather coverage|storm/i],
    ['space_tech', /spacex|starship|nasa|rocket|launch stream/i],
    ['music_concert', /concert live|festival live|coachella|live performance/i],
  ];
  for (const [cat, re] of rules) {
    if (re.test(t)) return cat;
  }
  return 'other';
}

function buildBands() {
  const bands = [];
  let min = FLOOR;
  while (min < CEILING) {
    const next = Math.min(min * 2, CEILING);
    bands.push({ min, max: next - 1, label: `${formatK(min)}–${formatK(next - 1)}` });
    min = next;
  }
  bands.push({ min: CEILING, max: Infinity, label: `${formatK(CEILING)}+` });
  return bands;
}

function formatK(n) {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function analyzeBand(items, band) {
  const inBand = items.filter((v) => v.views >= band.min && v.views <= band.max);
  if (!inBand.length) {
    return {
      ...band,
      count: 0,
      summary: 'No streams in this view band.',
      streams: [],
      categoryBreakdown: [],
    };
  }

  const views = inBand.map((v) => v.views);
  const durs = inBand.map((v) => v.durationHrs).filter((d) => d != null);
  const byCat = {};
  for (const v of inBand) {
    const cat = classify(v);
    if (!byCat[cat]) byCat[cat] = { count: 0, views: [] };
    byCat[cat].count++;
    byCat[cat].views.push(v.views);
  }

  const categoryBreakdown = Object.entries(byCat)
    .map(([cat, o]) => ({
      category: cat,
      count: o.count,
      pct: +((o.count / inBand.length) * 100).toFixed(1),
      avgViews: Math.round(o.views.reduce((a, b) => a + b, 0) / o.count),
    }))
    .sort((a, b) => b.count - a.count);

  const topCats = categoryBreakdown.slice(0, 3).map((c) => c.category.replace(/_/g, ' ')).join(', ');
  const streams = [...inBand]
    .sort((a, b) => b.views - a.views)
    .slice(0, 15)
    .map((v, i) => ({
      n: i + 1,
      views: v.views,
      durationHrs: v.durationHrs,
      channel: v.channel,
      title: v.title,
      url: v.url,
      category: classify(v),
    }));

  const summary = [
    `${inBand.length} completed live VODs`,
    `views ${band.label} (median ${median(views).toLocaleString()}, avg ${Math.round(views.reduce((a, b) => a + b, 0) / views.length).toLocaleString()})`,
    durs.length ? `typical runtime ${median(durs)}h` : null,
    `dominant formats: ${topCats || 'mixed'}`,
  ].filter(Boolean).join(' · ');

  return {
    ...band,
    count: inBand.length,
    medianViews: median(views),
    avgViews: Math.round(views.reduce((a, b) => a + b, 0) / views.length),
    medianDurationHrs: durs.length ? median(durs) : null,
    summary,
    categoryBreakdown,
    streams,
  };
}

function loadRanked() {
  if (!fs.existsSync(FULL_PATH)) return null;
  const data = JSON.parse(fs.readFileSync(FULL_PATH, 'utf8'));
  return data.ranked || data.all || [];
}

async function main() {
  const doScan = process.argv.includes('--scan') || !loadRanked()?.length;

  if (doScan) {
    console.error('Running live VOD scan (saves full ranked list)…');
    execSync('node scripts/youtube_live_rank_scan.js --top 10000 --from 1 --to 10000 --out youtube_live_scan_latest.json', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  }

  const ranked = loadRanked();
  if (!ranked?.length) {
    console.error('No ranked data — scan failed or quota exhausted.');
    process.exit(2);
  }

  const items = ranked.filter((v) => v.views >= FLOOR);
  const bands = buildBands();
  const bandResults = bands.map((b) => analyzeBand(items, b));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: FULL_PATH,
    windowNote: 'Last 30 days · completed live VODs · US-en search pool',
    totalLiveVodsInPool: ranked.length,
    atLeast5000Views: items.length,
    bands: bandResults,
  };

  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`\nYouTube Live VOD view bands (${items.length} streams ≥5k views, pool ${ranked.length})\n`);
  console.log('='.repeat(72));

  for (const b of bandResults) {
    console.log(`\n## ${b.label} views — ${b.count} streams`);
    console.log(b.summary);
    if (!b.streams.length) continue;
    console.log('\n| views | hrs | channel | title |');
    console.log('|------:|----:|---------|-------|');
    for (const s of b.streams.slice(0, 10)) {
      const title = (s.title || '').replace(/\|/g, '/').slice(0, 55);
      const ch = (s.channel || '').slice(0, 20);
      console.log(`| ${s.views.toLocaleString()} | ${s.durationHrs ?? '?'} | ${ch} | ${title} |`);
    }
    if (b.streams.length > 10) console.log(`| … | | | +${b.streams.length - 10} more in JSON |`);
  }

  console.log(`\nWrote ${OUT_PATH}\n`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
