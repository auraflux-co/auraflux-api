'use strict';

/**
 * Live Grid on-stream brand overlays — audio badge, frame bug, mute pill.
 * Shared math for compositor hot-switch (zmq) and unit tests.
 */

const { BRAND } = require('./feeders');

const BADGE_W = 108;
const BADGE_MARGIN = 14;

/** Top-right corner of quadrant q (0–3) inside the 2×2 grid. */
function audioBadgeXY(audioQuad, cellW, cellH) {
  const q = Number.isInteger(audioQuad) ? Math.min(3, Math.max(0, audioQuad)) : 0;
  const ax = (q % 2) * cellW;
  const ay = Math.floor(q / 2) * cellH;
  return {
    ax,
    ay,
    x: ax + cellW - BADGE_W - BADGE_MARGIN,
    y: ay + BADGE_MARGIN,
  };
}

/** Badge label for current audio state. Empty hides the corner tag. */
function audioBadgeText({ muted, fallbackMusicActive } = {}) {
  if (fallbackMusicActive) return 'MUSIC BED';
  if (muted) return '';
  return 'AUDIO';
}

/** ffmpeg drawtext filter for hot-movable on-air badge (named @audiobadge). */
function audioBadgeFilter({ ax, ay, cellW, cellH, muted, fallbackMusicActive }, esc) {
  const x = ax + cellW - BADGE_W - BADGE_MARGIN;
  const y = ay + BADGE_MARGIN;
  const text = audioBadgeText({ muted, fallbackMusicActive });
  const label = text || ' ';
  return (
    `drawtext@audiobadge=fontfile='${esc(BRAND.fontHead)}':text='${label}':` +
    `x=${x}:y=${y}:fontsize=26:fontcolor=${BRAND.background}:` +
    `box=1:boxcolor=${BRAND.accent}@0.96:boxborderw=8`
  );
}

/** Top-left frame bug — compact watermark, does not cover the full grid width. */
function frameBrandFilters(outW, esc) {
  return (
    `drawtext@brandbug=fontfile='${esc(BRAND.fontHead)}':text='CLIPZ WORLD LIVE':` +
    `x=18:y=14:fontsize=26:fontcolor=${BRAND.accent}:` +
    `box=1:boxcolor=${BRAND.primary}@0.82:boxborderw=8`
  );
}

/** Bottom mute / copyright pill when master is muted or on royalty bed. */
function muteStatusFilter({ muted, fallbackMusicActive }, esc) {
  if (!muted && !fallbackMusicActive) {
    return `drawtext@mutestatus=fontfile='${esc(BRAND.fontBody)}':text=' ':x=-400:y=0:fontsize=1`;
  }
  const text = fallbackMusicActive ? 'ROYALTY-FREE MUSIC BED' : 'AUDIO MUTED';
  return (
    `drawtext@mutestatus=fontfile='${esc(BRAND.fontBody)}':text='${text}':` +
    `x=(w-text_w)/2:y=h-52:fontsize=22:fontcolor=${BRAND.background}:` +
    `box=1:boxcolor=${BRAND.accent}@0.92:boxborderw=10`
  );
}

/** zmq commands to reposition audio badge on quadrant hop or mute/bed change. */
function audioBadgeZmqCommands(q, cellW, cellH, { muted, fallbackMusicActive } = {}) {
  const { x, y } = audioBadgeXY(q, cellW, cellH);
  const text = audioBadgeText({ muted, fallbackMusicActive });
  let cmds = '';
  cmds += `cdrawtext@audiobadge -1 x ${x}\n`;
  cmds += `cdrawtext@audiobadge -1 y ${y}\n`;
  cmds += `cdrawtext@audiobadge -1 text ${text || ' '}\n`;
  const muteText = fallbackMusicActive ? 'ROYALTY-FREE MUSIC BED' : (muted ? 'AUDIO MUTED' : ' ');
  cmds += `cdrawtext@mutestatus -1 text ${muteText}\n`;
  return cmds;
}

module.exports = {
  BRAND,
  BADGE_W,
  BADGE_MARGIN,
  audioBadgeXY,
  audioBadgeText,
  audioBadgeFilter,
  frameBrandFilters,
  muteStatusFilter,
  audioBadgeZmqCommands,
};
