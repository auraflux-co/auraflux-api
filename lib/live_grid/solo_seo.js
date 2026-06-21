'use strict';
/**
 * CPD-1047 — YouTube SEO for solo seat streams (Q1–Q4).
 */

const {
  displayName,
  buildYoutubeTags,
  buildGridLiveTitleHashtag,
  liveTitleDateShort,
  formatHashtagBlock,
  twitchChannelUrl,
} = require('./seo');

const CHANNEL_NAME = process.env.YOUTUBE_CHANNEL_NAME || 'ClipzWorld News';
const MAIN_GRID_URL = process.env.LIVE_GRID_MAIN_WATCH_URL || process.env.LIVE_GRID_WATCH_URL || '';

const GENERIC_SOLO_LABEL = /^screen\s*\d+$/i;

function normalizeSoloLogin(raw) {
  const login = String(raw || '').trim().toLowerCase().replace(/^@/, '');
  if (!login || GENERIC_SOLO_LABEL.test(login) || /^screen\d+$/.test(login)) return '';
  return login;
}

/** Match main grid title style — streamer lock drops Screen N from title (URL follows login). */
function buildSoloLiveTitle(login, quadrant, date = new Date(), opts = {}) {
  const q = Number.isInteger(quadrant) ? quadrant + 1 : 1;
  const lg = normalizeSoloLogin(login);
  const streamerLock = opts.streamerLock ?? String(process.env.LIVE_GRID_SOLO_STREAMER_LOCK ?? 'on').toLowerCase() !== 'off';
  if (lg) {
    const base = buildGridLiveTitleHashtag([{ login: lg }], date);
    if (streamerLock) return base.slice(0, 100);
    return `${base} | Screen ${q}`.slice(0, 100);
  }
  const stamp = liveTitleDateShort(date);
  return `🔴 LIVE: ${stamp} | #twitch | Screen ${q}`.slice(0, 100);
}

/**
 * @param {object} opts
 * @param {string} opts.login — streamer on this seat
 * @param {number} opts.quadrant — 0–3 (grid) or derived from fleet slot
 * @param {number} [opts.fleetSlot] — 1–10 permanent solo roster slot
 * @param {string} [opts.mainWatchUrl] — main 2×2 grid watch URL
 * @param {string[]} [opts.gridLogins] — all four on-screen logins (for cross-links)
 */
function buildSoloLiveSeo(opts = {}) {
  const login = normalizeSoloLogin(opts.login);
  const fleetSlot = Number.isInteger(opts.fleetSlot) ? opts.fleetSlot : null;
  const q = fleetSlot != null ? fleetSlot : (Number.isInteger(opts.quadrant) ? opts.quadrant + 1 : 1);
  const name = login ? displayName(login) : `Screen ${q}`;
  const stamp = liveTitleDateShort();
  const mainUrl = opts.mainWatchUrl || MAIN_GRID_URL;
  const streamerLock = opts.streamerLock ?? String(process.env.LIVE_GRID_SOLO_STREAMER_LOCK ?? 'on').toLowerCase() !== 'off';
  const fleetMode = fleetSlot != null || String(process.env.LIVE_GRID_PROGRAM_MODE || '').toLowerCase() === 'solo_roster';

  const title = buildSoloLiveTitle(login || opts.login, fleetMode ? q - 1 : (opts.quadrant ?? 0), new Date(), {
    streamerLock: streamerLock || fleetMode,
  });

  const streamer = { login: login || `screen${q}`, displayName: name, quadrant: q };
  const tags = buildYoutubeTags([streamer], { mode: 'solo', headline: name });

  const twitchUrl = twitchChannelUrl(login);
  const gridLine = (opts.gridLogins || []).filter(Boolean).slice(0, 4)
    .map((l) => displayName(l)).join(', ');

  const screenLine = fleetMode && login
    ? `Dedicated ClipzWorld News live slot ${q} for ${name} — same YouTube URL every time they go live.`
    : streamerLock && login
      ? `Currently on ClipzWorld Screen ${q} of our live multiview (your link stays the same if they move).`
      : `Watch ${name} solo on the ClipzWorld Live Grid — one Twitch stream, full screen, synced with our main 2×2 multiview.`;

  const description = [
    `🔴 LIVE NOW — ${name} on ${CHANNEL_NAME}`,
    '',
    screenLine,
    '',
    twitchUrl ? `STREAMER: ${name} — ${twitchUrl}` : `STREAMER: ${name}`,
    fleetMode ? '' : (mainUrl ? `MAIN 2×2 GRID: ${mainUrl}` : ''),
    fleetMode ? '' : (gridLine ? `Also on the main grid tonight: ${gridLine}` : ''),
    '',
    fleetMode
      ? 'Live mirror of the source stream — restream / co-stream format only; we do not rebroadcast sports broadcasts or copyrighted event feeds.'
      : 'ClipzWorld Screen streams are solo feeds from each quadrant of our live Twitch multiview — same production, dedicated full-screen view.',
    '',
    'LIVE CHAT: Subscribers and channel members can chat — no minimum time subscribed or joined.',
    '',
    `Subscribe to ${CHANNEL_NAME} for live streams and clips.`,
    formatHashtagBlock([
      'LiveStream',
      'Twitch',
      name.replace(/\s+/g, ''),
      'ClipzWorldNews',
      fleetMode ? 'Livestreams' : 'SoloStream',
      login,
    ]),
  ].filter((line, i, arr) => line !== '' || (arr[i - 1] !== '' && arr[i + 1] !== '')).join('\n').slice(0, 5000);

  return {
    title,
    description,
    tags,
    hashtags: ['LiveStream', 'Twitch', 'ClipzWorldNews', 'SoloStream', name.replace(/\s+/g, ''), login],
    thumbnailHeadline: name.slice(0, 40),
    thumbnailSubline: `Screen ${q} · Solo`,
  };
}

module.exports = {
  buildSoloLiveSeo,
  buildSoloLiveTitle,
  normalizeSoloLogin,
};
