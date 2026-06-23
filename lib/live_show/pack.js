'use strict';

const fs = require('fs');
const path = require('path');

const PACK_DIR = path.join(__dirname, '..', '..', 'tmp', 'live_show_pack');
const DESK_ORDER = ['news', 'sports', 'streaming'];

function deskFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('news')) return 'news';
  if (ct.includes('sport') || ct.includes('nba')) return 'sports';
  return 'streaming';
}

function packPathForDate(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return path.join(PACK_DIR, `${d}.json`);
}

function emptyPack(dateStr) {
  return {
    date: dateStr || new Date().toISOString().slice(0, 10),
    deskOrder: DESK_ORDER,
    desks: {},
    youtubeCut: {
      tool: 'tools/yt_cut.sh',
      note: 'Cut local OBS recording between YT_START and YT_END — excludes intro/outro music.',
    },
  };
}

function loadPack(dateStr) {
  const file = packPathForDate(dateStr);
  if (!fs.existsSync(file)) return emptyPack(dateStr);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...emptyPack(dateStr), ...raw, deskOrder: DESK_ORDER };
  } catch {
    return emptyPack(dateStr);
  }
}

function savePack(dateStr, pack) {
  fs.mkdirSync(PACK_DIR, { recursive: true });
  const file = packPathForDate(dateStr);
  fs.writeFileSync(file, JSON.stringify(pack, null, 2));
  return pack;
}

/**
 * Record source clips from a dashboard comp job for operator live (OBS) rundown.
 * Same clips that stitch into the portrait comp short → play landscape in live show.
 */
function recordCompClipsForLiveShow({ contentType, clips, jobId, title }) {
  if (!Array.isArray(clips) || !clips.length) return null;
  const desk = deskFromContentType(contentType);
  const date = new Date().toISOString().slice(0, 10);
  const pack = loadPack(date);
  pack.desks[desk] = {
    jobId: jobId || null,
    title: title || '',
    contentType: contentType || '',
    updatedAt: new Date().toISOString(),
    clips: clips.map((c, i) => ({
      index: i + 1,
      url: c.url || c.clipUrl || '',
      pageUrl: c.pageUrl || '',
      title: c.title || '',
      streamer: c.streamer || '',
      displayName: c.displayName || c.streamer || '',
      game: c.game || '',
    })),
  };
  savePack(date, pack);
  return { date, desk, clipCount: clips.length };
}

function buildRundown(pack) {
  const p = pack || loadPack();
  const blocks = DESK_ORDER.map((desk) => {
    const d = p.desks[desk];
    if (!d) return { desk, ready: false, clips: [] };
    return {
      desk,
      ready: !!(d.clips && d.clips.length),
      jobId: d.jobId,
      title: d.title,
      contentType: d.contentType,
      obsScene: desk === 'news' ? 'DESK_NEWS' : desk === 'sports' ? 'DESK_SPORTS' : 'DESK_STREAMING',
      clips: d.clips || [],
    };
  });
  return {
    date: p.date,
    deskOrder: DESK_ORDER,
    blocks,
    readyDesks: blocks.filter((b) => b.ready).length,
    totalClips: blocks.reduce((n, b) => n + (b.clips?.length || 0), 0),
  };
}

module.exports = {
  DESK_ORDER,
  deskFromContentType,
  loadPack,
  savePack,
  recordCompClipsForLiveShow,
  buildRundown,
  packPathForDate,
};
