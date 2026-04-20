#!/usr/bin/env node
/**
 * Phase A batch (Customer 0): NBA LF 1-clip → News LF 1 → Twitch LF (Jason, 2 clips) → NBA short.
 * Mirrors dashboard payloads to POST /generate-full-script.
 *
 * Usage: node scripts/phase_a_batch.cjs
 * Env: TWITCH_CLIENT_ID + TWITCH_TOKEN for Twitch step; server on PHASE_A_API (default http://127.0.0.1:3000).
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

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

async function generateFullScript(body, label) {
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
  await generateFullScript(
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
    hlsUrl: first.hlsUrl || first.videoUrl || ''
  };
  await generateFullScript(
    { type: 'news', items: [item], date: todayLabel(), tone: 'deadpan' },
    '2) News long-form (1 clip)'
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
  await generateFullScript(
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
  await generateFullScript(
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

async function main() {
  console.log(`Phase A batch → ${BASE} (script timeout ${GEN_TIMEOUT_MS}ms)`);
  const h = await axios.get(`${BASE}/health`, { timeout: 5000 });
  if (!(h.data && h.data.ok)) throw new Error('Health check failed');
  console.log('Health OK —', (h.data.dependencies && h.data.dependencies.HEYGEN_API_KEY && h.data.dependencies.HEYGEN_API_KEY.status) || '?', 'HeyGen');
  if (h.data.dependencies && h.data.dependencies.vectcut && h.data.dependencies.vectcut.status === 'offline') {
    console.warn('⚠ VectCut offline in /health — NBA overlay / some shorts may degrade; continuing.');
  }

  await nbaLongOneClip();
  await newsLongOne();
  await twitchJasonTwoClips();
  await nbaShort();

  console.log('\n✅ Phase A batch finished all four /generate-full-script calls.');
}

main().catch((e) => {
  console.error('\n❌', e.message || e);
  process.exit(1);
});
