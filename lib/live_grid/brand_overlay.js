'use strict';

/**
 * Live Grid framed layout — pixel contract (1920×1080)
 *
 * Viewers see this via the master encode (YouTube / Twitch RTMP), NOT the local-watch page.
 *
 * ┌─ borderW ───────────────────────────────── borderW ─┐
 * │ stripH  title (full width, no mid gutter)         │
 * │         video Q1     │ gutter │ video Q2            │
 * │         stripH name  │        │ stripH name         │
 * │────────── hgutter ────────────────────────────────│
 * │         video Q3     │        │ video Q4            │
 * │         stripH name  │        │ stripH name         │
 * └────────────────────────────────────────────────────┘
 *
 * Name strip (on-air quad): [avatar]  NAME (centered)  [on-air badge image]
 */

const path = require('path');
const { nameFile, BRAND, GRID_DIR } = require('./feeders');

const BRAND_TITLE = process.env.LIVE_GRID_BRAND_TITLE || 'CLIPZ WORLD LIVE';
const ON_AIR_BADGE_PATH = process.env.LIVE_GRID_ON_AIR_BADGE
  || path.join(__dirname, '..', '..', 'assets', 'live_grid', 'on_air_badge.png');
const AVATAR_SIZE = parseInt(process.env.LIVE_GRID_NAME_AVATAR_SIZE || '40', 10);
const BADGE_W = parseInt(process.env.LIVE_GRID_ON_AIR_BADGE_W || '72', 10);
const BADGE_H = parseInt(process.env.LIVE_GRID_ON_AIR_BADGE_H || '48', 10);
const FLANK_MARGIN = parseInt(process.env.LIVE_GRID_NAME_FLANK_MARGIN || '16', 10);

function gridFrameMetrics(outW = 1920, outH = 1080) {
  const stripH = parseInt(process.env.LIVE_GRID_FRAME_STRIP_H || '52', 10);
  const borderW = parseInt(process.env.LIVE_GRID_FRAME_GUTTER || '8', 10);
  const onAirBorder = parseInt(process.env.LIVE_GRID_FRAME_ONAIR_BORDER || String(borderW), 10);
  const innerX = borderW;
  const innerY = borderW;
  const innerW = outW - borderW * 2;
  const innerH = outH - borderW * 2;
  const cellW = Math.floor((innerW - borderW) / 2);
  const rowSpanW = cellW * 2 + borderW;
  const gridH = innerH - stripH;
  const rowBlockH = Math.floor((gridH - borderW) / 2);
  const cellVideoH = rowBlockH - stripH;
  return {
    outW,
    outH,
    stripH,
    gutter: borderW,
    borderW,
    onAirBorder,
    outerBorder: borderW,
    innerX,
    innerY,
    innerW,
    innerH,
    cellW,
    cellVideoH,
    rowBlockH,
    rowSpanW,
    brandTitle: BRAND_TITLE,
    avatarSize: AVATAR_SIZE,
    badgeW: BADGE_W,
    badgeH: BADGE_H,
    flankMargin: FLANK_MARGIN,
  };
}

function colX(col, m) {
  return m.innerX + (col === 0 ? 0 : m.cellW + m.borderW);
}

function cellBlockOrigin(q, m) {
  const row = Math.floor(q / 2);
  const col = q % 2;
  const y = m.innerY + m.stripH + row * (m.rowBlockH + m.borderW);
  const x = colX(col, m);
  return {
    x,
    y,
    w: m.cellW,
    h: m.rowBlockH,
    videoY: y,
    labelY: y + m.cellVideoH,
  };
}

function stripTextY(labelY, m) {
  return labelY + Math.max(8, Math.floor((m.stripH - 36) / 2));
}

/** Fixed flank positions — name stays centered; avatar/badge sit in margins. */
function nameStripFlankPositions(q, m) {
  const b = cellBlockOrigin(q, m);
  const avatarY = b.labelY + Math.floor((m.stripH - m.avatarSize) / 2);
  const badgeY = b.labelY + Math.floor((m.stripH - m.badgeH) / 2);
  return {
    avatarX: b.x + m.flankMargin,
    avatarY,
    badgeX: b.x + m.cellW - m.badgeW - m.flankMargin,
    badgeY,
    hiddenX: -400,
  };
}

function buildCellFilter(q, m, esc, fps = 30) {
  return (
    `[${q}:v]${cellVideoScaleFilter(m.cellW, m.cellVideoH)}fps=${fps}:round=near,setsar=1[q${q + 1}]`
  );
}

function cellVideoScaleFilter(cellW, cellVideoH) {
  const fit = String(process.env.LIVE_GRID_CELL_FIT || 'letterbox').toLowerCase();
  if (fit === 'contain' || fit === 'letterbox') {
    return `scale=${cellW}:${cellVideoH}:flags=fast_bilinear:force_original_aspect_ratio=decrease,` +
      `pad=${cellW}:${cellVideoH}:(ow-iw)/2:(oh-ih)/2:color=${BRAND.background},`;
  }
  return `scale=${cellW}:${cellVideoH}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${cellW}:${cellVideoH},`;
}

function xstackFilter(cells, m) {
  return (
    `${cells.join('')}xstack=inputs=4:layout=${xstackLayout(m)}[stackraw];` +
    `[stackraw]pad=${m.outW}:${m.outH}:0:0:color=${BRAND.background}`
  );
}

function xstackLayout(m) {
  const x1 = colX(1, m);
  const y1 = m.innerY + m.stripH + m.rowBlockH + m.borderW;
  const y0 = m.innerY + m.stripH;
  return `${colX(0, m)}_${y0}|${x1}_${y0}|${colX(0, m)}_${y1}|${x1}_${y1}`;
}

function labelStripFilters(q, m, esc) {
  const b = cellBlockOrigin(q, m);
  const ty = stripTextY(b.labelY, m);
  const nameX = `${b.x}+(${m.cellW}-text_w)/2`;
  return [
    `drawbox@labelbg${q}=x=${b.x}:y=${b.labelY}:w=${m.cellW}:h=${m.stripH}:color=${BRAND.primary}@1:t=fill`,
    `drawtext@name${q}=fontfile='${esc(BRAND.fontHead)}':textfile='${esc(nameFile(q))}':reload=1:` +
      `x=${nameX}:y=${ty}:fontsize=36:fontcolor=${BRAND.accent}`,
  ].join(',');
}

function buildFrameOverlayFilters(m, audioQuad, opts, esc) {
  const titleY = m.innerY + Math.max(8, Math.floor((m.stripH - 40) / 2));
  const midRowY = m.innerY + m.stripH + m.rowBlockH;
  const vGutterX = m.innerX + m.cellW;
  const vGutterY = m.innerY + m.stripH;
  const vGutterH = m.innerH - m.stripH;
  const titleTextX = `(${m.innerX}+(${m.rowSpanW}-text_w)/2)`;
  const parts = [
    `drawbox=x=0:y=0:w=${m.outW}:h=${m.outH}:color=${BRAND.background}@1:t=fill`,
    `drawbox@titlebg=x=${m.innerX}:y=${m.innerY}:w=${m.rowSpanW}:h=${m.stripH}:color=${BRAND.primary}@1:t=fill`,
    `drawbox@vgutter=x=${vGutterX}:y=${vGutterY}:w=${m.borderW}:h=${vGutterH}:color=${BRAND.accent}@1:t=fill`,
    `drawbox@hgutter=x=${m.innerX}:y=${midRowY}:w=${m.innerW}:h=${m.borderW}:color=${BRAND.accent}@1:t=fill`,
    ...[0, 1, 2, 3].map((q) => labelStripFilters(q, m, esc)),
    `drawbox=x=0:y=0:w=${m.outW}:h=${m.outH}:color=${BRAND.accent}@1:t=${m.outerBorder}`,
    `drawtext@brandtitle=fontfile='${esc(BRAND.fontHead)}':text='${m.brandTitle}':` +
      `x=${titleTextX}:y=${titleY}:fontsize=44:fontcolor=${BRAND.accent}`,
    muteStatusFilter(opts, esc),
  ];
  return parts.join(',');
}

/** Overlay chain after [grid]: avatar + on-air badge (zmq-movable). */
function nameStripImageOverlays(m, audioQuad, opts, esc, inputIdx) {
  const onAir = Number.isInteger(audioQuad)
    && audioQuad >= 0 && audioQuad <= 3
    && !opts.muted
    && !opts.fallbackMusicActive;
  const flank = onAir ? nameStripFlankPositions(audioQuad, m) : null;
  const hidden = -400;
  const avIdx = inputIdx.avatar;
  const badgeIdx = inputIdx.badge;
  const parts = [];
  parts.push(
    `[${avIdx}:v]scale=${m.avatarSize}:${m.avatarSize}:flags=fast_bilinear,format=rgba[avpic]`,
    `[${badgeIdx}:v]scale=${m.badgeW}:${m.badgeH}:flags=fast_bilinear,format=rgba[onairpic]`,
    `[grid][avpic]overlay@onairavatar=x=${flank ? flank.avatarX : hidden}:y=${flank ? flank.avatarY : 0}:format=auto[gridav]`,
    `[gridav][onairpic]overlay@onairbadge=x=${flank ? flank.badgeX : hidden}:y=${flank ? flank.badgeY : 0}:format=auto[gridout]`
  );
  return parts.join(';');
}

function muteStatusFilter({ muted, fallbackMusicActive }, esc) {
  if (!muted && !fallbackMusicActive) {
    return `drawtext@mutestatus=fontfile='${esc(BRAND.fontBody)}':text=' ':x=-400:y=0:fontsize=1`;
  }
  const text = fallbackMusicActive ? 'ROYALTY-FREE MUSIC BED' : 'AUDIO MUTED';
  return (
    `drawtext@mutestatus=fontfile='${esc(BRAND.fontBody)}':text='${text}':` +
    `x=(w-text_w)/2:y=h-40:fontsize=18:fontcolor=${BRAND.background}:` +
    `box=1:boxcolor=${BRAND.accent}@0.92:boxborderw=8`
  );
}

function audioFrameZmqCommands(q, m, { muted, fallbackMusicActive } = {}) {
  const onCell = cellBlockOrigin(q, m);
  const onT = 0;
  let cmds = '';
  cmds += `cdrawbox@onair -1 x ${onCell.x}\n`;
  cmds += `cdrawbox@onair -1 y ${onCell.y}\n`;
  cmds += `cdrawbox@onair -1 w ${onCell.w}\n`;
  cmds += `cdrawbox@onair -1 h ${onCell.h}\n`;
  cmds += `cdrawbox@onair -1 t ${onT}\n`;
  for (let i = 0; i < 4; i++) {
    cmds += `cdrawbox@labelbg${i} -1 color ${BRAND.primary}@1\n`;
    cmds += `cdrawtext@name${i} -1 fontcolor ${BRAND.accent}\n`;
    const b = cellBlockOrigin(i, m);
    cmds += `cdrawtext@name${i} -1 x ${b.x}+(${m.cellW}-text_w)/2\n`;
  }
  const onAir = !muted && !fallbackMusicActive;
  const flank = onAir ? nameStripFlankPositions(q, m) : null;
  const hidden = -400;
  cmds += `coverlay@onairavatar -1 x ${flank ? flank.avatarX : hidden}\n`;
  cmds += `coverlay@onairavatar -1 y ${flank ? flank.avatarY : 0}\n`;
  cmds += `coverlay@onairbadge -1 x ${flank ? flank.badgeX : hidden}\n`;
  cmds += `coverlay@onairbadge -1 y ${flank ? flank.badgeY : 0}\n`;
  const muteText = fallbackMusicActive ? 'ROYALTY-FREE MUSIC BED' : (muted ? 'AUDIO MUTED' : ' ');
  cmds += `cdrawtext@mutestatus -1 text ${muteText}\n`;
  return cmds;
}

function onAirVideoCropRect(q, m) {
  const b = cellBlockOrigin(q, m);
  return { x: b.x, y: b.videoY, w: b.w, h: m.cellVideoH };
}

function compositorImageInputs() {
  const { avatarFile, ensureAvatarPlaceholder } = require('./avatar_cache');
  for (let q = 0; q < 4; q++) ensureAvatarPlaceholder(q);
  const inputs = [];
  for (let q = 0; q < 4; q++) {
    inputs.push({ path: avatarFile(q), label: `quad${q + 1}_avatar` });
  }
  inputs.push({ path: ON_AIR_BADGE_PATH, label: 'on_air_badge' });
  return inputs;
}

module.exports = {
  BRAND,
  BRAND_TITLE,
  ON_AIR_BADGE_PATH,
  GRID_DIR,
  gridFrameMetrics,
  cellBlockOrigin,
  colX,
  nameStripFlankPositions,
  cellVideoScaleFilter,
  buildCellFilter,
  xstackLayout,
  xstackFilter,
  buildFrameOverlayFilters,
  nameStripImageOverlays,
  muteStatusFilter,
  audioFrameZmqCommands,
  onAirVideoCropRect,
  compositorImageInputs,
};
