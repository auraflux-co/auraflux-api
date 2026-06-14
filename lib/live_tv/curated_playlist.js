/**
 * Curated ClipzWorld TV playlist (config/live_tv_playlist.json).
 * Dashboard + /live-tv/start use this instead of scanning all of output/.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isTwitchTvPlayable } = require('../live_grid/rights_registry');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'config', 'live_tv_playlist.json');
const REPO_ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');

const _durCache = new Map();

function classifyTvContent(name) {
  const n = String(name).toLowerCase();
  if (/twitch-short|clips_comp|_0clips_|synth_prebuild|clip_short_/.test(n)) return 'hidden';
  if (/nba/.test(n)) return 'nba';
  if (/script_twitch/.test(n) || (/^twitch_/.test(n) && /avatar/.test(n)) || (/^cwn_/.test(n) && /twitch/.test(n))) {
    return 'bobbyg';
  }
  if (/news|because|light/.test(n)) return 'news';
  return 'other';
}

function probeDurationSec(absPath) {
  const key = path.resolve(absPath);
  if (_durCache.has(key)) return _durCache.get(key);
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${JSON.stringify(key)}`,
      { encoding: 'utf8', timeout: 30000 },
    ).trim();
    const sec = Math.round(Number(out) || 0);
    _durCache.set(key, sec);
    return sec;
  } catch (_) {
    _durCache.set(key, 0);
    return 0;
  }
}

function toRel(absPath) {
  return path.relative(REPO_ROOT, path.resolve(absPath)).replace(/\\/g, '/');
}

function resolveVideoPath(relOrAbs) {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, String(relOrAbs));
  return path.resolve(p);
}

function loadCuratedPlaylist(configPath = process.env.LIVE_TV_PLAYLIST || DEFAULT_PATH) {
  if (!fs.existsSync(configPath)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return null;
  }
  const rels = raw.videos || [];
  const videos = rels.map((rel) => resolveVideoPath(rel)).filter((abs) => {
    try { return fs.statSync(abs).isFile(); } catch (_) { return false; }
  });
  if (!videos.length) return null;
  return {
    videos,
    videoRels: videos.map(toRel),
    curated: raw.curated !== false,
    notes: raw.notes || null,
    targetDurationMin: raw.targetDurationMin || null,
    updated: raw.updated || null,
  };
}

function saveCuratedPlaylist({ videos, notes, targetDurationMin, curated = true } = {}) {
  const rels = (videos || [])
    .map((v) => toRel(resolveVideoPath(v)))
    .filter((rel) => {
      try { return fs.statSync(resolveVideoPath(rel)).isFile(); } catch (_) { return false; }
    });
  if (!rels.length) throw new Error('Playlist is empty — pick at least one video');
  const payload = {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    curated: curated !== false,
    notes: notes || 'Saved from Broadcast dashboard',
    targetDurationMin: targetDurationMin || null,
    videos: rels,
  };
  fs.mkdirSync(path.dirname(DEFAULT_PATH), { recursive: true });
  fs.writeFileSync(DEFAULT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  return loadCuratedPlaylist();
}

/** Recommended ~1h: newest Bobby G twitch VODs + one news desk piece (no NBA, no streamer shorts). */
function recommendedPlaylist(catalog) {
  const pick = (group, maxMin) => {
    let total = 0;
    const out = [];
    for (const item of group) {
      const d = item.durationSec || 0;
      if (d < 60) continue;
      if (total + d > maxMin * 60 + 120 && total >= maxMin * 60 * 0.85) break;
      out.push(item.abs);
      total += d;
      if (total >= maxMin * 60) break;
    }
    return out;
  };
  const bobby = (catalog.bobbyg || []).slice().sort((a, b) => b.mtime - a.mtime);
  const news = (catalog.news || []).slice().sort((a, b) => b.mtime - a.mtime);
  const bobbyPick = pick(bobby, 48);
  const newsPick = pick(news, 12);
  const merged = [...bobbyPick];
  for (const p of newsPick) {
    if (!merged.includes(p)) merged.push(p);
  }
  if (merged.length) return merged;
  return (catalog.bobbyg || []).slice(0, 2).map((x) => x.abs);
}

function buildTvCatalog(outputDir = OUTPUT_DIR) {
  let names = [];
  try { names = fs.readdirSync(outputDir); } catch (_) { names = []; }

  const groups = { bobbyg: [], news: [], nba: [], other: [] };
  for (const name of names) {
    if (!/\.mp4$/i.test(name)) continue;
    const abs = path.join(outputDir, name);
    let size = 0;
    try { size = fs.statSync(abs).size; } catch (_) { continue; }
    if (!isTwitchTvPlayable(name, size)) continue;
    const kind = classifyTvContent(name);
    if (kind === 'hidden') continue;
    const durationSec = probeDurationSec(abs);
    if (durationSec < 60) continue;
    const entry = {
      abs,
      path: toRel(abs),
      name,
      kind,
      durationSec,
      durationMin: Math.round((durationSec / 60) * 10) / 10,
      mtime: fs.statSync(abs).mtimeMs,
      label: friendlyTvLabel(name),
    };
    (groups[kind] || groups.other).push(entry);
  }

  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => b.mtime - a.mtime);
  }
  return groups;
}

function friendlyTvLabel(name) {
  const n = String(name);
  if (/22clips.*script_twitch/i.test(n)) return 'Twitch Soup — 22 clips (Bobby G avatar)';
  if (/57_avatar.*script_twitch/i.test(n)) return 'Twitch Soup — full avatar edition (Bobby G)';
  if (/14clips.*script_twitch|37_avatar/i.test(n)) return 'Twitch Soup — Bobby G avatar VOD';
  if (/script_twitch/i.test(n) && /cwn_/i.test(n)) return 'Twitch Soup — Bobby G avatar VOD';
  if (/news/i.test(n) && /clips/i.test(n)) return 'News desk — produced VOD';
  if (/news/i.test(n)) return 'News desk VOD';
  if (/nba/i.test(n)) return 'NBA highlights (off-season — hidden by default)';
  return n.replace(/\.mp4$/i, '').replace(/_/g, ' ').slice(0, 72);
}

function markSelected(catalog, selectedAbsSet) {
  const out = {};
  for (const [k, list] of Object.entries(catalog)) {
    out[k] = list.map((item) => ({ ...item, selected: selectedAbsSet.has(item.abs) }));
  }
  return out;
}

function totalDurationMin(items) {
  const sec = items.reduce((s, i) => s + (i.durationSec || 0), 0);
  return Math.round((sec / 60) * 10) / 10;
}

module.exports = {
  loadCuratedPlaylist,
  saveCuratedPlaylist,
  buildTvCatalog,
  classifyTvContent,
  recommendedPlaylist,
  friendlyTvLabel,
  markSelected,
  totalDurationMin,
  DEFAULT_PATH,
  REPO_ROOT,
};
