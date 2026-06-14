#!/usr/bin/env node
/**
 * Benchmark wire news source fetch ease: BBC, PBS, Vox (+ combined all).
 * Usage: node scripts/test_wire_news_fetch.js [baseUrl]
 */
'use strict';

const BASE = process.argv[2] || 'http://localhost:3000';
const SOURCES = ['bbc', 'pbs', 'vox', 'all'];
const LIMIT = 15;
const RUNS = 2;

async function fetchSource(source) {
  const url = `${BASE}/news/stories?source=${encodeURIComponent(source)}&limit=${LIMIT}`;
  const t0 = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(240000) });
  const ms = Date.now() - t0;
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const videos = data.videos || [];
  const bySrc = {};
  for (const v of videos) {
    const k = v.source || source;
    bySrc[k] = (bySrc[k] || 0) + 1;
  }
  const withUrl = videos.filter(v => v.hlsUrl && v.hlsUrl.length > 20);
  const landscape = videos.filter(v => (v.orientation || 'landscape') === 'landscape').length;
  const durations = videos.map(v => v.duration).filter(Boolean);
  const avgDur = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  return {
    source,
    ms,
    count: videos.length,
    withUrl: withUrl.length,
    landscape,
    bySrc,
    avgDurSec: avgDur,
    samples: videos.slice(0, 3).map(v => ({
      title: (v.title || '').slice(0, 55),
      source: v.source,
      dur: v.duration ? `${Math.round(v.duration)}s` : '?',
      ori: v.orientation || '?',
      hasUrl: !!(v.hlsUrl && v.hlsUrl.length > 20),
    })),
  };
}

function grade(r) {
  if (r.count === 0) return 'FAIL';
  if (r.ms > 60000) return 'SLOW';
  if (r.count >= 5 && r.withUrl === r.count) return 'EASY';
  if (r.count >= 2) return 'OK';
  return 'THIN';
}

async function main() {
  console.log(`Wire news fetch benchmark → ${BASE}\n`);
  const rows = [];

  for (const source of SOURCES) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        runs.push(await fetchSource(source));
      } catch (e) {
        runs.push({ source, error: e.message, ms: 0, count: 0, withUrl: 0 });
      }
    }
    const ok = runs.filter(r => !r.error);
    const avgMs = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;
    const last = runs[runs.length - 1];
    const row = {
      source,
      grade: last.error ? 'FAIL' : grade({ ...last, ms: avgMs }),
      avgMs,
      count: last.count || 0,
      withUrl: last.withUrl || 0,
      landscape: last.landscape || 0,
      bySrc: last.bySrc || {},
      avgDurSec: last.avgDurSec,
      error: last.error || null,
      samples: last.samples || [],
    };
    rows.push(row);
    const tag = row.error ? `ERROR: ${row.error}` : `${row.count} clips, ${row.withUrl} w/ URL, ${(avgMs / 1000).toFixed(1)}s avg`;
    console.log(`[${row.grade.padEnd(4)}] ${source.padEnd(5)} — ${tag}`);
    if (row.samples.length) {
      row.samples.forEach(s => console.log(`       · ${s.source || source} ${s.dur} ${s.hasUrl ? '✓' : '✗'} ${s.title}`));
    }
    console.log('');
  }

  console.log('── Summary ──');
  console.log('Grade key: EASY ≥5 clips fast | OK 2–4 | THIN 1 | SLOW >60s | FAIL 0');
  rows.sort((a, b) => {
    const order = { EASY: 0, OK: 1, THIN: 2, SLOW: 3, FAIL: 4 };
    return (order[a.grade] ?? 9) - (order[b.grade] ?? 9) || a.avgMs - b.avgMs;
  });
  for (const r of rows) {
    console.log(`${r.grade.padEnd(5)} ${r.source.padEnd(5)} ${String(r.count).padStart(2)} clips  ${(r.avgMs / 1000).toFixed(1).padStart(5)}s`);
  }

  process.exit(rows.some(r => r.grade === 'FAIL') ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
