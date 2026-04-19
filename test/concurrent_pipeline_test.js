#!/usr/bin/env node
/**
 * concurrent_pipeline_test.js
 *
 * Runs up to 100 concurrent Gate 0 + Gate 1 tests across all content types.
 * HeyGen is disabled via GATE_TEST_MODE=true — no credits burned.
 *
 * Fetches real clips from live sources (bypasses localStorage dedup).
 * Reports pass/fail per gate per job, writes summary to test/output/concurrent_results.json
 *
 * Usage:
 *   node test/concurrent_pipeline_test.js [--concurrency 100] [--content all|twitch|nba|news]
 */

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const RESULTS_FILE = path.join(__dirname, 'output', 'concurrent_results.json');
const TWITCH_TOKEN = process.env.TWITCH_TOKEN || require('dotenv').config({ path: path.join(__dirname, '../.env') }) && process.env.TWITCH_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;

// Parse CLI args
const args = process.argv.slice(2);
const concurrencyIdx = args.indexOf('--concurrency');
const contentIdx = args.indexOf('--content');
const concurrency = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1]) : 100;
const contentFilter = contentIdx !== -1 ? args[contentIdx + 1] : 'all';

// ─── Shared cache — fetch news/nba once, reuse across all test cases ─────────
let _newsCache = null;
let _nbaCache = null;

// ─── Real clip fetchers (bypass localStorage dedup) ─────────────────────────

async function fetchTwitchItems(streamerName, clipsPerStreamer = 1) {
  try {
    const userResp = await axios.get(`https://api.twitch.tv/helix/users?login=${streamerName}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${TWITCH_TOKEN}` },
      timeout: 8000
    });
    const user = userResp.data?.data?.[0];
    if (!user) return null;

    const since = new Date(Date.now() - 86400000 * 2).toISOString();
    const clipsResp = await axios.get(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=20&started_at=${since}`,
      { headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${TWITCH_TOKEN}` }, timeout: 8000 }
    );
    const clips = (clipsResp.data?.data || []).slice(0, clipsPerStreamer);
    if (!clips.length) return null;

    return {
      streamer: user.display_name,
      displayName: user.display_name,
      targetClipsPerStreamer: clipsPerStreamer,
      clips: clips.map((c, i) => ({
        rank: i + 1,
        isBackup: false,
        title: c.title,
        url: c.url,
        views: c.view_count,
        game: c.game_name || '',
        thumbnailUrl: c.thumbnail_url || ''
      })),
      title: clips[0].title,
      url: clips[0].url,
      views: clips[0].view_count,
      game: clips[0].game_name || '',
      thumbnailUrl: clips[0].thumbnail_url || ''
    };
  } catch (e) {
    return null;
  }
}

async function fetchNbaItems() {
  if (_nbaCache) return _nbaCache;
  try {
    // Step 1: get yesterday's games from ESPN directly
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    et.setDate(et.getDate() - 1);
    const dateKey = et.toISOString().slice(0, 10).replace(/-/g, '');
    const espnResp = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateKey}`,
      { timeout: 15000 }
    );
    const events = (espnResp.data?.events || []).filter(ev => ev.status?.type?.completed).slice(0, 1);
    if (!events.length) return [];

    const ev = events[0];
    const comp = (ev.competitions || [])[0] || {};
    const competitors = comp.competitors || [];
    const away = competitors.find(c => c.homeAway === 'away') || competitors[0] || {};
    const home = competitors.find(c => c.homeAway === 'home') || competitors[1] || {};

    // Step 2: scrape highlight clip via backend
    const scrapeResp = await axios.post(`${BASE_URL}/nba/scrape-game-highlight`,
      { gameId: ev.id }, { timeout: 60000 }
    );

    if (!scrapeResp.data?.ok || !scrapeResp.data?.videoUrl) { _nbaCache = []; return []; }

    _nbaCache = [{
      gameId: ev.id,
      away: away.team?.displayName || 'Away',
      home: home.team?.displayName || 'Home',
      awayAbbr: away.team?.abbreviation || 'AWY',
      homeAbbr: home.team?.abbreviation || 'HME',
      awayScore: away.score || '',
      homeScore: home.score || '',
      clipUrl: scrapeResp.data.videoUrl,
      clipDuration: scrapeResp.data.duration || null,
      thumbnailUrl: scrapeResp.data.thumbnail || '',
      localPath: scrapeResp.data.localPath || ''
    }];
    return _nbaCache;
  } catch (e) {
    _nbaCache = [];
    return [];
  }
}

async function fetchNewsItems(count = 1) {
  if (_newsCache) return _newsCache.slice(0, count);
  try {
    const resp = await axios.get(`${BASE_URL}/news/us-canada-videos`, { timeout: 30000 });
    // endpoint returns { videos: [...] } not { items: [...] }
    const videos = resp.data?.videos || resp.data?.items || [];
    _newsCache = videos.map(it => ({
      title: (it.title || '').trim(),
      desc: (it.description || '').replace(/<[^>]+>/g, '').slice(0, 1200),
      source: 'Al Jazeera',
      link: it.link || it.url || '',
      thumbnailUrl: it.thumbnail || '',
      videoUrl: it.hlsUrl || it.videoUrl || '',
      pubDate: it.pubDate || ''
    })).filter(it => it.videoUrl);
    return _newsCache.slice(0, count);
  } catch (e) {
    _newsCache = [];
    return [];
  }
}

// ─── Test case builders ──────────────────────────────────────────────────────

const STREAMERS = [
  'jasontheween','hasanabi','stableronaldo','jaycinco','yonnajay',
  'adapt','lacy','marlon','cinna','maya','extraemily','yourragegaming'
];

async function buildTwitchTest(id) {
  const streamer = STREAMERS[id % STREAMERS.length];
  const item = await fetchTwitchItems(streamer, 1);
  if (!item) return null;
  return {
    id: `twitch_long_${id}`,
    type: 'twitch',
    form: 'long',
    payload: {
      type: 'twitch',
      date: new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }),
      items: [item]
    }
  };
}

async function buildTwitchShortTest(id) {
  const streamer = STREAMERS[id % STREAMERS.length];
  const item = await fetchTwitchItems(streamer, 1);
  if (!item) return null;
  return {
    id: `twitch_short_${id}`,
    type: 'twitch-short',
    form: 'short',
    payload: {
      type: 'twitch-short',
      date: new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }),
      items: [item]
    }
  };
}

async function buildNbaTest(id) {
  const items = await fetchNbaItems();
  if (!items.length) return null;
  return {
    id: `nba_long_${id}`,
    type: 'nba',
    form: 'long',
    payload: {
      type: 'nba',
      date: new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }),
      items
    }
  };
}

async function buildNbaShortTest(id) {
  const items = await fetchNbaItems();
  if (!items.length) return null;
  return {
    id: `nba_short_${id}`,
    type: 'nba-short',
    form: 'short',
    payload: {
      type: 'nba-short',
      date: new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }),
      items: items.slice(0, 1)
    }
  };
}

async function buildNewsTest(id) {
  const items = await fetchNewsItems(1);
  if (!items.length) return null;
  return {
    id: `news_long_${id}`,
    type: 'news',
    form: 'long',
    payload: {
      type: 'news',
      date: new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }),
      items
    }
  };
}

async function buildNewsShortTest(id) {
  const items = await fetchNewsItems(1);
  if (!items.length) return null;
  return {
    id: `news_short_${id}`,
    type: 'news-short',
    form: 'short',
    payload: {
      type: 'news-short',
      date: new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }),
      items
    }
  };
}

// ─── Run single test ─────────────────────────────────────────────────────────

async function runTest(testCase) {
  const start = Date.now();
  const result = {
    id: testCase.id,
    type: testCase.type,
    form: testCase.form,
    startedAt: new Date().toISOString(),
    gate0: null,
    gate1: null,
    status: 'running',
    error: null,
    durationMs: null
  };

  try {
    const resp = await axios.post(`${BASE_URL}/generate-full-script`, testCase.payload, {
      timeout: 300000, // 5 min — NBA long-form Gemini analysis takes 2-3 min
      validateStatus: () => true // don't throw on 4xx/5xx
    });

    result.durationMs = Date.now() - start;
    result.httpStatus = resp.status;

    if (resp.status === 422 && resp.data?.gate === 'gate0') {
      result.gate0 = 'HARD_FAIL';
      result.gate1 = 'SKIPPED';
      result.status = 'gate0_fail';
      result.error = resp.data?.error || 'Gate 0 hard fail';
    } else if (resp.status === 422 && resp.data?.gate === 'gate1') {
      result.gate0 = 'PASS';
      result.gate1 = 'HARD_FAIL';
      result.status = 'gate1_fail';
      result.error = resp.data?.error;
    } else if (resp.status === 400 && resp.data?.errorCode === 'NEWS_CLIP_GATE_FAIL') {
      result.gate0 = 'HARD_FAIL';
      result.gate1 = 'SKIPPED';
      result.status = 'gate0_fail';
      result.error = resp.data?.error;
    } else if (resp.status === 200 && resp.data?.script) {
      result.gate0 = 'PASS';
      result.gate1 = resp.data?.scriptQA?.outcome === 'pass' ? 'PASS' :
                     resp.data?.scriptQA?.outcome === 'sendback' ? 'SENDBACK' : 'MANUAL';
      result.gate1Score = resp.data?.scriptQA?.score;
      result.wordCount = resp.data?.wordCount;
      result.status = result.gate1 === 'PASS' ? 'pass' : 'gate1_review';
    } else {
      result.gate0 = 'ERROR';
      result.gate1 = 'SKIPPED';
      result.status = 'error';
      result.error = resp.data?.error || `HTTP ${resp.status}`;
    }
  } catch (e) {
    result.durationMs = Date.now() - start;
    result.status = 'error';
    result.error = e.message;
    result.gate0 = 'ERROR';
    result.gate1 = 'SKIPPED';
  }

  const icon = result.status === 'pass' ? '✅' :
               result.status === 'gate0_fail' ? '❌G0' :
               result.status === 'gate1_fail' ? '❌G1' :
               result.status === 'gate1_review' ? '🟡G1' : '💥';
  console.log(`${icon} [${result.id}] ${result.status} | G0:${result.gate0} G1:${result.gate1}${result.gate1Score ? ' score:'+result.gate1Score : ''} | ${result.durationMs}ms${result.error ? ' | '+result.error.slice(0,80) : ''}`);

  return result;
}

// ─── Build test queue ────────────────────────────────────────────────────────

async function buildTestQueue(total) {
  console.log(`\nBuilding ${total} test cases — fetching real clips from live sources...`);

  const builders = [];
  const types = contentFilter === 'all'
    ? ['twitch', 'twitch-short', 'nba', 'nba-short', 'news', 'news-short']
    : [contentFilter];

  for (let i = 0; i < total; i++) {
    const type = types[i % types.length];
    const idx = Math.floor(i / types.length);
    if (type === 'twitch') builders.push(buildTwitchTest(idx));
    else if (type === 'twitch-short') builders.push(buildTwitchShortTest(idx));
    else if (type === 'nba') builders.push(buildNbaTest(idx));
    else if (type === 'nba-short') builders.push(buildNbaShortTest(idx));
    else if (type === 'news') builders.push(buildNewsTest(idx));
    else if (type === 'news-short') builders.push(buildNewsShortTest(idx));
  }

  // Build all test cases concurrently (just fetching metadata, not running pipeline)
  const cases = await Promise.all(builders);
  const valid = cases.filter(Boolean);
  console.log(`Built ${valid.length}/${total} test cases (${total - valid.length} skipped — no clips available)`);
  return valid;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🧪 CONCURRENT PIPELINE TEST — ${concurrency} jobs, HeyGen OFF`);
  console.log(`   Content: ${contentFilter} | Gate_TEST_MODE: ON | No HeyGen credits`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Verify server is up
  try {
    await axios.get(`${BASE_URL}/disk-usage`, { timeout: 5000 });
  } catch (e) {
    console.error('❌ Server not running on port 3000. Start with: npm run start');
    process.exit(1);
  }

  // Verify GATE_TEST_MODE
  console.log('✅ Server online');
  console.log('⚠️  Ensure GATE_TEST_MODE=true in .env before running\n');

  // Pre-fetch shared sources once to avoid hammering scrapers with 100 concurrent requests
  console.log('Pre-fetching shared sources (news, NBA)...');
  await Promise.all([fetchNewsItems(1), fetchNbaItems()]);
  console.log(`  News: ${_newsCache?.length || 0} stories | NBA: ${_nbaCache?.length || 0} games\n`);

  const testCases = await buildTestQueue(concurrency);
  if (!testCases.length) {
    console.error('❌ No test cases built — check source availability');
    process.exit(1);
  }

  console.log(`\nFiring ${testCases.length} concurrent jobs...\n`);
  const startAll = Date.now();

  // Run all concurrently
  const results = await Promise.all(testCases.map(runTest));

  const totalMs = Date.now() - startAll;

  // ─── Summary ───────────────────────────────────────────────────────────────
  const passed    = results.filter(r => r.status === 'pass').length;
  const g0fail    = results.filter(r => r.status === 'gate0_fail').length;
  const g1fail    = results.filter(r => r.status === 'gate1_fail').length;
  const g1review  = results.filter(r => r.status === 'gate1_review').length;
  const errors    = results.filter(r => r.status === 'error').length;

  const byType = {};
  results.forEach(r => {
    if (!byType[r.type]) byType[r.type] = { pass: 0, g0fail: 0, g1fail: 0, review: 0, error: 0 };
    if (r.status === 'pass') byType[r.type].pass++;
    else if (r.status === 'gate0_fail') byType[r.type].g0fail++;
    else if (r.status === 'gate1_fail') byType[r.type].g1fail++;
    else if (r.status === 'gate1_review') byType[r.type].review++;
    else byType[r.type].error++;
  });

  const avgDuration = Math.round(results.reduce((s, r) => s + (r.durationMs || 0), 0) / results.length);
  const g1scores = results.filter(r => r.gate1Score).map(r => r.gate1Score);
  const avgG1Score = g1scores.length ? Math.round(g1scores.reduce((a, b) => a + b, 0) / g1scores.length) : null;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 RESULTS SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Total:     ${results.length} jobs in ${(totalMs/1000).toFixed(1)}s`);
  console.log(`✅ Pass:    ${passed} (${Math.round(passed/results.length*100)}%)`);
  console.log(`❌ Gate 0:  ${g0fail} (${Math.round(g0fail/results.length*100)}%)`);
  console.log(`❌ Gate 1:  ${g1fail} (${Math.round(g1fail/results.length*100)}%)`);
  console.log(`🟡 Review:  ${g1review} (${Math.round(g1review/results.length*100)}%)`);
  console.log(`💥 Error:   ${errors} (${Math.round(errors/results.length*100)}%)`);
  console.log(`Avg time:  ${avgDuration}ms per job`);
  if (avgG1Score) console.log(`Avg G1 score: ${avgG1Score}/100`);
  console.log('\nBy content type:');
  Object.entries(byType).forEach(([type, counts]) => {
    console.log(`  ${type.padEnd(12)} pass:${counts.pass} g0:${counts.g0fail} g1:${counts.g1fail} review:${counts.review} err:${counts.error}`);
  });

  // Top errors
  const errorGroups = {};
  results.filter(r => r.error).forEach(r => {
    const key = (r.error || '').slice(0, 80);
    errorGroups[key] = (errorGroups[key] || 0) + 1;
  });
  if (Object.keys(errorGroups).length) {
    console.log('\nTop errors:');
    Object.entries(errorGroups).sort((a,b) => b[1]-a[1]).slice(0, 5).forEach(([msg, count]) => {
      console.log(`  ${count}x: ${msg}`);
    });
  }

  // Write results
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({
    runAt: new Date().toISOString(),
    concurrency,
    contentFilter,
    totalMs,
    summary: { passed, g0fail, g1fail, g1review, errors, avgDuration, avgG1Score },
    byType,
    results
  }, null, 2));
  console.log(`\nFull results: test/output/concurrent_results.json`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
