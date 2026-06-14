/**
 * ESPN scoreboard + summary API — all highlight clips per event.
 * League paths discovered from ESPN dropdown (web URL → API path).
 */
const axios = require('axios');
const { getEspnRegistry, resolveEspnLeagueKey } = require('./espn_discovery');

function extractHlsUrl(video) {
  const src = video?.links?.source || {};
  return src.HLS?.HD?.href || src.HLS?.href || src.HD?.href || src.mezzanine?.href || '';
}

function leagueCfg(leagueKey) {
  const reg = getEspnRegistrySync();
  const id = resolveEspnLeagueKey(leagueKey, reg);
  if (!id) return null;
  return reg.leagues[id];
}

function getEspnRegistrySync() {
  return require('./espn_discovery').getEspnRegistrySync();
}

function parseScoreboardEvent(ev, leagueKey) {
  const comp = (ev.competitions || [])[0] || {};
  const comps = comp.competitors || [];
  const away = comps.find(c => c.homeAway === 'away') || comps[0] || {};
  const home = comps.find(c => c.homeAway === 'home') || comps[1] || {};
  const completed = !!(ev.status && ev.status.type && ev.status.type.completed);
  return {
    gameId: ev.id,
    league: leagueKey,
    completed,
    away: away.team?.displayName || 'Away',
    home: home.team?.displayName || 'Home',
    awayAbbr: away.team?.abbreviation || 'AWY',
    homeAbbr: home.team?.abbreviation || 'HME',
    awayScore: away.score || '',
    homeScore: home.score || '',
    publishedAt: ev.date || comp.date || null,
  };
}

async function fetchScoreboardByPath(apiPath, dateYmd) {
  const dateKey = String(dateYmd || '').replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${apiPath}/scoreboard?dates=${dateKey}`;
  const resp = await axios.get(url, { timeout: 12000 });
  const events = resp.data?.events || [];
  return events;
}

async function fetchScoreboard(leagueKey, dateYmd) {
  const cfg = leagueCfg(leagueKey);
  if (!cfg) throw new Error(`Unknown ESPN league: ${leagueKey}`);
  const events = await fetchScoreboardByPath(cfg.path, dateYmd);
  const id = resolveEspnLeagueKey(leagueKey, getEspnRegistrySync()) || leagueKey;
  return events.map(ev => parseScoreboardEvent(ev, id)).filter(g => g.completed);
}

/** Completed games whose start time falls inside pubHours window. */
async function scoreboardGamesInWindow(leagueKey, pubHours = 48) {
  const cfg = leagueCfg(leagueKey);
  if (!cfg) return [];
  const since = Date.now() - pubHours * 3600000;
  const id = resolveEspnLeagueKey(leagueKey, getEspnRegistrySync()) || leagueKey;
  const dates = [];
  const today = new Date();
  for (let i = 0; i < Math.ceil(pubHours / 24) + 1; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const games = [];
  for (const d of dates) {
    try {
      const events = await fetchScoreboardByPath(cfg.path, d);
      for (const ev of events) {
        const g = parseScoreboardEvent(ev, id);
        if (!g.completed) continue;
        const t = new Date(g.publishedAt || 0).getTime();
        if (Number.isFinite(t) && t >= since) games.push(g);
      }
    } catch (_) { /* no scoreboard */ }
  }
  return games;
}

async function fetchGameClips(leagueKey, gameId) {
  const cfg = leagueCfg(leagueKey);
  if (!cfg || !gameId) return [];
  const id = resolveEspnLeagueKey(leagueKey, getEspnRegistrySync()) || leagueKey;
  const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/summary?event=${gameId}`;
  const resp = await axios.get(summaryUrl, { timeout: 12000 });
  const summaryData = resp.data || {};
  const articleVideos = Array.isArray(summaryData.article?.video)
    ? summaryData.article.video
    : (summaryData.article?.video ? [summaryData.article.video] : []);
  const topVideos = summaryData.videos || [];
  const pool = [...topVideos, ...articleVideos];
  const maxSec = cfg.maxClipSec || 600;

  return pool
    .map(v => {
      const hlsUrl = extractHlsUrl(v);
      if (!hlsUrl) return null;
      const duration = v.duration || 0;
      if (!duration || duration > maxSec) return null;
      const title = (v.headline || v.title || v.description || 'Highlight').trim();
      return {
        url: `https://www.espn.com/video/_/gameId/${gameId}`,
        title,
        hlsUrl,
        duration,
        thumbnail: (typeof v.thumbnail === 'string' ? v.thumbnail : v.thumbnail?.href) || '',
        publishedAt: summaryData.header?.competitions?.[0]?.date || null,
        orientation: 'landscape',
        pillarboxFilter: null,
        source: id,
        provider: 'espn',
        category: id,
        meta: {
          gameId,
          league: id,
          apiPath: cfg.path,
          webUrl: cfg.webUrl || '',
          clipKind: /game highlights|highlights$/i.test(title) ? 'highlights_reel' : 'play_clip',
        },
      };
    })
    .filter(Boolean);
}

async function fetchLeagueHighlights({ league = 'nba', dateYmd, limit = 40, concurrency = 6 }) {
  const cfg = leagueCfg(league);
  if (!cfg) throw new Error(`Unknown ESPN league: ${league}`);
  const id = resolveEspnLeagueKey(league, getEspnRegistrySync()) || league;

  const today = new Date();
  const dates = [];
  if (dateYmd) {
    dates.push(dateYmd);
  } else {
    dates.push(today.toISOString().slice(0, 10));
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    dates.push(y.toISOString().slice(0, 10));
  }

  let games = [];
  for (const d of dates) {
    try {
      const g = await fetchScoreboard(league, d);
      games.push(...g);
    } catch (_) { /* league may not have scoreboard that day */ }
  }
  const seenGames = new Set();
  games = games.filter(g => {
    if (seenGames.has(g.gameId)) return false;
    seenGames.add(g.gameId);
    return true;
  });

  const results = [];
  for (let i = 0; i < games.length && results.length < limit; i += concurrency) {
    const batch = games.slice(i, i + concurrency);
    const batchClips = await Promise.all(batch.map(async g => {
      try {
        const clips = await fetchGameClips(league, g.gameId);
        return clips.map(c => ({
          ...c,
          title: c.title || `${g.awayAbbr} @ ${g.homeAbbr}`,
          meta: {
            ...c.meta,
            away: g.away,
            home: g.home,
            awayAbbr: g.awayAbbr,
            homeAbbr: g.homeAbbr,
            awayScore: g.awayScore,
            homeScore: g.homeScore,
          },
          publishedAt: c.publishedAt || g.publishedAt || null,
        }));
      } catch {
        return [];
      }
    }));
    for (const group of batchClips) {
      for (const clip of group) {
        if (results.length < limit) results.push(clip);
      }
    }
  }

  return results;
}

/** Probe: recent completed games + confirm at least one clip exists. */
async function probeLeagueRecentVideo(leagueKey, pubHours = 48) {
  const cfg = leagueCfg(leagueKey);
  const id = resolveEspnLeagueKey(leagueKey, getEspnRegistrySync()) || leagueKey;
  if (!cfg) return { active: false, provider: 'espn', id: leagueKey };
  try {
    const recentGames = await scoreboardGamesInWindow(leagueKey, pubHours);
    if (!recentGames.length) return { active: false, provider: 'espn', id };

    let clipCount = 0;
    let newestAt = recentGames[0].publishedAt;
    for (const g of recentGames.slice(0, 3)) {
      const clips = await fetchGameClips(leagueKey, g.gameId);
      const since = Date.now() - pubHours * 3600000;
      const recent = clips.filter(c => {
        const t = new Date(c.publishedAt || g.publishedAt || 0).getTime();
        return Number.isFinite(t) && t >= since;
      });
      clipCount += recent.length;
      if (recent.length && recent[0].publishedAt) newestAt = recent[0].publishedAt;
      if (clipCount > 0) break;
    }

    if (!clipCount) return { active: false, provider: 'espn', id };
    return {
      active: true,
      provider: 'espn',
      id,
      label: cfg.label,
      clipCount,
      newestAt,
      webUrl: cfg.webUrl || '',
      apiPath: cfg.path,
    };
  } catch {
    return { active: false, provider: 'espn', id };
  }
}

module.exports = {
  extractHlsUrl,
  leagueCfg,
  fetchScoreboard,
  scoreboardGamesInWindow,
  fetchGameClips,
  fetchLeagueHighlights,
  probeLeagueRecentVideo,
};
