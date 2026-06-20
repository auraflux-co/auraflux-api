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
  if (!login || GENERIC_SOLO_LABEL.test(login)) return '';
  return login;
}

/** Match main grid title style — single streamer + Screen N suffix for Studio. */
function buildSoloLiveTitle(login, quadrant, date = new Date()) {
  const q = Number.isInteger(quadrant) ? quadrant + 1 : 1;
  const lg = normalizeSoloLogin(login);
  if (lg) {
    const base = buildGridLiveTitleHashtag([{ login: lg }], date);
    return `${base} | Screen ${q}`.slice(0, 100);
  }
  const stamp = liveTitleDateShort(date);
  return `🔴 LIVE: ${stamp} | #twitch | Screen ${q}`.slice(0, 100);
}

/**
 * @param {object} opts
 * @param {string} opts.login — streamer on this seat
 * @param {number} opts.quadrant — 0–3
 * @param {string} [opts.mainWatchUrl] — main 2×2 grid watch URL
 * @param {string[]} [opts.gridLogins] — all four on-screen logins (for cross-links)
 */
function buildSoloLiveSeo(opts = {}) {
  const login = normalizeSoloLogin(opts.login);
  const q = Number.isInteger(opts.quadrant) ? opts.quadrant + 1 : 1;
  const name = login ? displayName(login) : `Screen ${q}`;
  const stamp = liveTitleDateShort();
  const mainUrl = opts.mainWatchUrl || MAIN_GRID_URL;

  const title = buildSoloLiveTitle(login || opts.login, opts.quadrant);

  const streamer = { login: login || `screen${q}`, displayName: name, quadrant: q };
  const tags = buildYoutubeTags([streamer], { mode: 'solo', headline: name });

  const twitchUrl = twitchChannelUrl(login);
  const gridLine = (opts.gridLogins || []).filter(Boolean).slice(0, 4)
    .map((l) => displayName(l)).join(', ');

  const description = [
    `🔴 LIVE NOW — ${name} full-screen on ClipzWorld Screen ${q}`,
    '',
    `Watch ${name} solo on the ClipzWorld Live Grid — one Twitch stream, full screen, synced with our main 2×2 multiview.`,
    '',
    twitchUrl ? `STREAMER: ${name} — ${twitchUrl}` : `STREAMER: ${name}`,
    mainUrl ? `MAIN 2×2 GRID: ${mainUrl}` : '',
    gridLine ? `Also on the main grid tonight: ${gridLine}` : '',
    '',
    'ClipzWorld Screen streams are solo feeds from each quadrant of our live Twitch multiview — same production, dedicated full-screen view.',
    '',
    'SUBSCRIBER CHAT (main grid stream):',
    '🔊 !listen 1-4 — pick which screen has audio',
    '❤️ Subscribe + like milestones unlock !swap',
    '',
    'Co-stream / reaction format only — we do not rebroadcast sports broadcasts, game feeds, or copyrighted event footage.',
    '',
    `Subscribe to ${CHANNEL_NAME} for nightly Twitch multiview and solo seat streams.`,
    formatHashtagBlock([
      'LiveStream',
      'Twitch',
      name.replace(/\s+/g, ''),
      'ClipzWorldNews',
      'SoloStream',
      'Multiview',
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
