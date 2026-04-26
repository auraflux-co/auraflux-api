#!/usr/bin/env node
/**
 * Phase A batch (Customer 0): NBA LF 1-clip → News LF 1 → Twitch LF (Jason, 2 clips) → NBA short.
 * Mirrors dashboard payloads to POST /generate-full-script.
 *
 * Usage: node scripts/phase_a_batch.cjs
 * Env:
 *   PHASE_A_JOBS — comma list to run a subset (default all four). Keys:
 *     nba_lf | news_lf | twitch_jason_2 | nba_short | news_short | twitch_short
 *     Example mini smoke: PHASE_A_JOBS=nba_lf,news_short
 *     Example: PHASE_A_JOBS=news_lf,twitch_short
 *   TWITCH_CLIENT_ID + TWITCH_TOKEN for Twitch step only.
 *   Server: PHASE_A_API (default http://127.0.0.1:3000).
 * After the four script calls: writes logs/phase_a_last_run.json, polls /job-spec every 1s for **scriptJobId** rows (see phase_a_gate_watch.cjs),
 * then writes docs/reports/phase_a_rca_<timestamp>.md. Set PHASE_A_SKIP_WATCH=1 to skip watch+RCA.
 * Defaults (unless env set): PHASE_A_WATCH_EXIT_ON_STABLE=0, PHASE_A_WATCH_MAX_MS=2h — poll until Gate 5 or max time, not "stable 2 min".
 * For 24/7 transition logging for all jobs, run `npm run job-monitor` or PM2 app `job-monitor` (see ecosystem.config.js).
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Default: keep polling until Gate 5 or max duration — do not stop on "2 min stable" while jobs are still moving.
if (process.env.PHASE_A_WATCH_EXIT_ON_STABLE === undefined) {
  process.env.PHASE_A_WATCH_EXIT_ON_STABLE = '0';
}
if (process.env.PHASE_A_WATCH_MAX_MS === undefined) {
  process.env.PHASE_A_WATCH_MAX_MS = String(2 * 60 * 60 * 1000);
}
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { watchPhaseAJobs, writeRcaReport } = require('./phase_a_gate_watch.cjs');

const BASE = process.env.PHASE_A_API || 'http://127.0.0.1:3000';
const GEN_TIMEOUT_MS = parseInt(process.env.PHASE_A_SCRIPT_TIMEOUT_MS || '720000', 10);

function etDateMinus(yesterdayPlusExtra) {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  etNow.setDate(etNow.getDate() - 1 - (yesterdayPlusExtra || 0));
  return `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, '0')}-${String(etNow.getDate()).padStart(2, '0')}`;
}

function isRealTitle(title) {
  if (!title) return false;
  const words = title.trim().split(/\s+/);
  const realWords = words.filter((w) => w.length > 2 && /[aeiou]/i.test(w));
  return realWords.length >= 2;
}

function todayLabel() {
  return new Date().toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function jobMeta(label, data) {
  return {
    label,
    scriptJobId: data.scriptJobId || data.metricsJobId,
    semanticJobId: data.semanticJobId || null
  };
}

async function generateFullScript(body, label) {
  if (process.env.QA_CONFIRM_ON_GENERATE === 'true') {
    body = { ...body, qaGenerateConfirmed: true };
  }
  console.log(`\n${'═'.repeat(12)} ${label} ${'═'.repeat(12)}`);
  const start = Date.now();
  const r = await axios.post(`${BASE}/generate-full-script`, body, {
    timeout: GEN_TIMEOUT_MS,
    validateStatus: () => true,
    headers: { 'Content-Type': 'application/json' }
  });
  const sec = ((Date.now() - start) / 1000).toFixed(1);
  if (r.status !== 200) {
    console.error(typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2).slice(0, 4000));
    throw new Error(`${label} HTTP ${r.status} (${sec}s)`);
  }
  if (r.data && r.data.error) throw new Error(`${label}: ${r.data.error}`);
  console.log(
    `OK ${sec}s — metricsJobId=${r.data.metricsJobId} words=${r.data.wordCount} geminiHits=${r.data.geminiHits}`
  );
  return r.data;
}

async function nbaLongOneClip() {
  let finalGames = [];
  let targetDate = '';
  for (let extra = 0; extra < 2; extra++) {
    targetDate = etDateMinus(extra);
    const dateKey = targetDate.replace(/-/g, '');
    const sb = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateKey}`,
      { timeout: 15000 }
    );
    const events = sb.data.events || [];
    finalGames = events.filter((ev) => {
      const completed = ev.status && ev.status.type && ev.status.type.completed;
      const evDate = (ev.date || '').slice(0, 10);
      return completed && (!evDate || evDate === targetDate);
    });
    if (finalGames.length) break;
  }
  if (!finalGames.length) {
    throw new Error('NBA long: no completed games in last 2 days (ET scoreboard)');
  }
  const ev = finalGames[0];
  const gameId = ev.id;
  const scr = await axios.post(
    `${BASE}/nba/scrape-game-highlight`,
    { gameId },
    { timeout: 120000 }
  );
  if (!scr.data.ok || !scr.data.videoUrl) {
    throw new Error(`NBA scrape failed: ${scr.data.error || JSON.stringify(scr.data)}`);
  }
  const comp = (ev.competitions || [])[0] || {};
  const competitors = comp.competitors || [];
  const away = competitors.find((c) => c.homeAway === 'away') || {};
  const home = competitors.find((c) => c.homeAway === 'home') || {};
  const item = {
    gameId,
    away: (away.team && away.team.displayName) || 'Away',
    home: (home.team && home.team.displayName) || 'Home',
    awayAbbr: (away.team && away.team.abbreviation) || 'AWY',
    homeAbbr: (home.team && home.team.abbreviation) || 'HME',
    awayScore: away.score || '',
    homeScore: home.score || '',
    leader: '',
    leaderStat: '',
    injuries: [],
    clipUrl: scr.data.videoUrl,
    clipDuration: scr.data.duration || null,
    thumbnailUrl: scr.data.thumbnail || '',
    localPath: scr.data.localPath || ''
  };
  return await generateFullScript(
    { type: 'nba', items: [item], date: todayLabel(), tone: 'deadpan' },
    '1) NBA long-form (1 clip)'
  );
}

async function newsLongOne() {
  const news = await axios.get(`${BASE}/news/us-canada-videos`, { timeout: 600000 });
  if (!news.data.ok) throw new Error(`News feed: ${news.data.error || 'not ok'}`);
  const vids = news.data.videos || [];
  const first = vids.find((v) => v.hlsUrl || v.videoUrl) || vids[0];
  if (!first) throw new Error('News: no videos in feed');
  const item = {
    title: first.title || '',
    link: first.url || '',
    pubDate: first.publishedAt || '',
    thumbnail: first.thumbnail || '',
    description: '',
    enclosure: {},
    hlsUrl: first.hlsUrl || first.videoUrl || '',
    // Must match /generate-full-script ajVideoPool + news_source portrait gate (defaults were landscape)
    sourceOrientation: (first.orientation || 'portrait').toLowerCase(),
    pillarboxFilter: first.pillarboxFilter || null
  };
  return await generateFullScript(
    { type: 'news', items: [item], date: todayLabel(), tone: 'deadpan' },
    '2) News long-form (1 clip)'
  );
}

/** News short-form — same feed item shape as long-form; template short via formType. */
async function newsShortOne() {
  const news = await axios.get(`${BASE}/news/us-canada-videos`, { timeout: 600000 });
  if (!news.data.ok) throw new Error(`News feed: ${news.data.error || 'not ok'}`);
  const vids = news.data.videos || [];
  const first = vids.find((v) => v.hlsUrl || v.videoUrl) || vids[0];
  if (!first) throw new Error('News short: no videos in feed');
  const item = {
    title: first.title || '',
    link: first.url || '',
    pubDate: first.publishedAt || '',
    thumbnail: first.thumbnail || '',
    description: '',
    enclosure: {},
    hlsUrl: first.hlsUrl || first.videoUrl || '',
    sourceOrientation: (first.orientation || 'portrait').toLowerCase(),
    pillarboxFilter: first.pillarboxFilter || null
  };
  return await generateFullScript(
    {
      type: 'news-short',
      formType: 'short',
      items: [item],
      date: todayLabel(),
      tone: 'deadpan'
    },
    'News short-form (1 story)'
  );
}

/** Twitch short-form — 1 clip, Helix (requires TWITCH_CLIENT_ID + TWITCH_TOKEN). */
async function twitchShortOne() {
  const cid = process.env.TWITCH_CLIENT_ID;
  const tok = process.env.TWITCH_TOKEN;
  if (!cid || !tok) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_TOKEN must be set in .env for twitch_short');
  }
  const login = (process.env.PHASE_A_TWITCH_SHORT_LOGIN || 'jasontheween').toLowerCase();
  const headers = { 'Client-Id': cid, Authorization: `Bearer ${tok}` };
  const userResp = await axios.get(`https://api.twitch.tv/helix/users?login=${login}`, {
    headers,
    timeout: 15000
  });
  const user = userResp.data && userResp.data.data && userResp.data.data[0];
  if (!user) throw new Error(`Twitch short: user not found — ${login}`);
  const since = new Date(Date.now() - 86400000 * 2).toISOString();
  const clipsResp = await axios.get(
    `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=20&started_at=${since}`,
    { headers, timeout: 15000 }
  );
  const raw = (clipsResp.data && clipsResp.data.data) || [];
  const minSec = parseInt(process.env.PHASE_A_TWITCH_SHORT_MIN_SEC || '30', 10) || 30;
  const valid = raw.filter((c) => isRealTitle(c.title) && Number(c.duration) >= minSec);
  valid.sort((a, b) => Number(b.duration) - Number(a.duration));
  const one = valid.slice(0, 1);
  if (one.length < 1) {
    throw new Error(
      `Twitch short: need 1 clip with title + duration>=${minSec}s in 48h for ${login} (Gate 0 short-form floor). Got ${raw.length} raw clips, ${valid.length} after filter.`
    );
  }
  const c = one[0];
  const displayName = user.display_name || login;
  const item = {
    streamer: user.display_name,
    displayName,
    notes: '',
    clipsPerStreamer: 1,
    targetClipsPerStreamer: 1,
    clips: [
      {
        rank: 1,
        isBackup: false,
        title: c.title,
        url: c.url,
        views: c.view_count,
        game: c.game_name || '',
        thumbnailUrl: c.thumbnail_url || ''
      }
    ],
    title: c.title,
    url: c.url,
    views: c.view_count,
    game: c.game_name || '',
    thumbnailUrl: c.thumbnail_url || ''
  };
  return await generateFullScript(
    {
      type: 'twitch-short',
      formType: 'short',
      items: [item],
      date: todayLabel(),
      tone: 'deadpan'
    },
    'Twitch short-form (1 clip)'
  );
}

async function twitchJasonTwoClips() {
  const cid = process.env.TWITCH_CLIENT_ID;
  const tok = process.env.TWITCH_TOKEN;
  if (!cid || !tok) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_TOKEN must be set in .env for Twitch batch step');
  }
  const login = 'jasontheween';
  const headers = { 'Client-Id': cid, Authorization: `Bearer ${tok}` };
  const userResp = await axios.get(`https://api.twitch.tv/helix/users?login=${login}`, {
    headers,
    timeout: 15000
  });
  const user = userResp.data && userResp.data.data && userResp.data.data[0];
  if (!user) throw new Error(`Twitch: user not found — ${login}`);
  const since = new Date(Date.now() - 86400000 * 2).toISOString();
  const clipsResp = await axios.get(
    `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=30&started_at=${since}`,
    { headers, timeout: 15000 }
  );
  const raw = (clipsResp.data && clipsResp.data.data) || [];
  const valid = raw.filter((c) => isRealTitle(c.title));
  const two = valid.slice(0, 2);
  if (two.length < 2) {
    throw new Error(`Twitch: need 2 titled clips for Jason in 48h window, got ${two.length}`);
  }
  const displayName = 'Jason';
  const item = {
    streamer: user.display_name,
    displayName,
    notes: 'he/him',
    clipsPerStreamer: 2,
    targetClipsPerStreamer: 2,
    clips: two.map((c, i) => ({
      rank: i + 1,
      isBackup: false,
      title: c.title,
      url: c.url,
      views: c.view_count,
      game: c.game_name || '',
      thumbnailUrl: c.thumbnail_url || ''
    })),
    title: two[0].title,
    url: two[0].url,
    views: two[0].view_count,
    game: two[0].game_name || '',
    thumbnailUrl: two[0].thumbnail_url || ''
  };
  return await generateFullScript(
    { type: 'twitch', items: [item], date: todayLabel(), tone: 'deadpan' },
    '3) Twitch long-form — Jason — 2 clips'
  );
}

async function nbaShort() {
  let targetDate = etDateMinus(0);
  let events = [];
  for (let extra = 0; extra < 2; extra++) {
    targetDate = etDateMinus(extra);
    const dateKey = targetDate.replace(/-/g, '');
    const sb = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateKey}`,
      { timeout: 15000 }
    );
    const evs = sb.data.events || [];
    const completed = evs.filter((ev) => {
      const done = ev.status && ev.status.type && ev.status.type.completed;
      const evDate = (ev.date || '').slice(0, 10);
      return done && (!evDate || evDate === targetDate);
    });
    if (completed.length) {
      events = completed;
      break;
    }
  }
  if (!events.length) throw new Error('NBA short: no completed games');
  let bestGame = events[0];
  let bestTotal = -1;
  for (const ev of events) {
    const comp = (ev.competitions || [])[0] || {};
    const comps = comp.competitors || [];
    const total = comps.reduce((a, c) => a + parseInt(c.score || 0, 10), 0);
    if (total > bestTotal) {
      bestTotal = total;
      bestGame = ev;
    }
  }
  const gameId = bestGame.id;
  const scr = await axios.post(
    `${BASE}/nba/scrape-game-highlight`,
    { gameId, formType: 'short' },
    { timeout: 120000 }
  );
  if (!scr.data.ok || !scr.data.videoUrl) {
    throw new Error(`NBA short scrape: ${scr.data.error || JSON.stringify(scr.data)}`);
  }
  const comp = (bestGame.competitions || [])[0] || {};
  const competitors = comp.competitors || [];
  const away = competitors.find((c) => c.homeAway === 'away') || {};
  const home = competitors.find((c) => c.homeAway === 'home') || {};
  const item = {
    gameId,
    away: (away.team && away.team.displayName) || 'Away',
    home: (home.team && home.team.displayName) || 'Home',
    awayScore: away.score || '?',
    homeScore: home.score || '?',
    leader: '',
    leaderStat: '',
    injuries: [],
    clipUrl: scr.data.videoUrl,
    thumbnailUrl: scr.data.thumbnail || ''
  };
  return await generateFullScript(
    {
      type: 'nba-short',
      items: [item],
      formType: 'short',
      date: todayLabel(),
      tone: 'deadpan'
    },
    '4) NBA short-form'
  );
}

const DEFAULT_PHASE_A_STEPS = ['nba_lf', 'news_lf', 'twitch_jason_2', 'nba_short'];

async function main() {
  const stepEnv = (process.env.PHASE_A_JOBS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const steps = stepEnv.length ? stepEnv : DEFAULT_PHASE_A_STEPS;

  const stepRunners = {
    nba_lf: async () => jobMeta('1_nba_lf', await nbaLongOneClip()),
    news_lf: async () => jobMeta('2_news_lf', await newsLongOne()),
    twitch_jason_2: async () => jobMeta('3_twitch_jason_2', await twitchJasonTwoClips()),
    nba_short: async () => jobMeta('4_nba_short', await nbaShort()),
    news_short: async () => jobMeta('5_news_short', await newsShortOne()),
    twitch_short: async () => jobMeta('6_twitch_short', await twitchShortOne())
  };

  console.log(`Phase A batch → ${BASE} (script timeout ${GEN_TIMEOUT_MS}ms)`);
  console.log(`Steps: ${steps.join(' → ')}`);
  const h = await axios.get(`${BASE}/health`, { timeout: 5000 });
  if (!(h.data && h.data.ok)) throw new Error('Health check failed');
  console.log('Health OK —', (h.data.dependencies && h.data.dependencies.HEYGEN_API_KEY && h.data.dependencies.HEYGEN_API_KEY.status) || '?', 'HeyGen');
  if (h.data.dependencies && h.data.dependencies.vectcut && h.data.dependencies.vectcut.status === 'offline') {
    console.warn('⚠ VectCut offline in /health — NBA overlay / some shorts may degrade; continuing.');
  }

  const jobs = [];
  for (const key of steps) {
    const run = stepRunners[key];
    if (!run) {
      throw new Error(
        `Unknown PHASE_A_JOBS key "${key}". Use: ${Object.keys(stepRunners).join(', ')}`
      );
    }
    jobs.push(await run());
  }

  const runMeta = { startedAt: new Date().toISOString(), jobs, steps };
  const lastRunPath = path.join(__dirname, '..', 'logs', 'phase_a_last_run.json');
  fs.mkdirSync(path.dirname(lastRunPath), { recursive: true });
  fs.writeFileSync(lastRunPath, JSON.stringify(runMeta, null, 2), 'utf8');
  console.log(`\n✅ Phase A batch finished ${jobs.length} /generate-full-script call(s).`);
  console.log(`Wrote ${lastRunPath}`);

  if (process.env.PHASE_A_SKIP_WATCH === '1') {
    console.log('PHASE_A_SKIP_WATCH=1 — skipping 1s gate poll + RCA (re-run: node scripts/phase_a_gate_watch.cjs --file logs/phase_a_last_run.json)');
    return;
  }

  // Gate results and /job-spec gate snapshots live on **script** job ids (script_nba_…), not the
  // semantic fetch row (c0_COMPACT_FETCH_…). Polling semantic ids makes the watch look "stuck"
  // at pending with no gates while the script job is actually moving.
  const pollId = (j) => j.scriptJobId || j.semanticJobId;
  const watchIds = jobs.map(pollId).filter(Boolean);
  const labelById = Object.fromEntries(
    jobs
      .map((j) => {
        const pid = pollId(j);
        return pid ? [pid, j.label] : null;
      })
      .filter(Boolean)
  );
  console.log('\n── Gate watch (1s interval, RCA on exit) ──');
  await watchPhaseAJobs(watchIds, { labelById });
  await writeRcaReport(jobs, runMeta);
}

main().catch((e) => {
  console.error('\n❌', e.message || e);
  process.exit(1);
});
