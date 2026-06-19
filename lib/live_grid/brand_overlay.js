'use strict';

const fs = require('fs');

/**
 * Live Grid framed layout — pixel contract (1920×1080)
 *
 * Viewers see this via the master encode (YouTube / Twitch RTMP), NOT the local-watch page.
 *
 * ┌─ borderW ───────────────────────────────── borderW ─┐
 * │ stripH  title (full width, no mid gutter)         │
 * │         video Q1          video Q2   (navy seam, no gold divider) │
 * │         stripH name       stripH name                           │
 * │────────── hgutter ─────────────────────────────────────────────│
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
const AVATAR_SIZE = parseInt(process.env.LIVE_GRID_NAME_AVATAR_SIZE || '38', 10);
const BADGE_W = parseInt(process.env.LIVE_GRID_ON_AIR_BADGE_W || '42', 10);
const BADGE_H = parseInt(process.env.LIVE_GRID_ON_AIR_BADGE_H || '42', 10);
const NAME_EDGE_PAD = parseInt(process.env.LIVE_GRID_NAME_EDGE_PAD || '24', 10);
const NAME_FLANK_GAP = parseInt(process.env.LIVE_GRID_NAME_FLANK_GAP || '20', 10);
/** Approximate half-width per character at fontsize 36 (Bebas) — anchors flanks near name. */
const NAME_CHAR_HALF_W = parseInt(process.env.LIVE_GRID_NAME_CHAR_HALF_W || '9', 10);
/** Max half-width of the name cluster — keeps flanks tight to the label. */
const NAME_CLUSTER_HALF_MAX = parseInt(process.env.LIVE_GRID_NAME_CLUSTER_HALF_MAX || '72', 10);

function gridFrameMetrics(outW = 1920, outH = 1080) {
  const stripH = parseInt(process.env.LIVE_GRID_FRAME_STRIP_H || '52', 10);
  const borderW = parseInt(process.env.LIVE_GRID_FRAME_GUTTER || '8', 10);
  const onAirBorder = parseInt(process.env.LIVE_GRID_FRAME_ONAIR_BORDER || String(borderW), 10);
  const innerX = borderW;
  const innerY = borderW;
  const innerW = outW - borderW * 2;
  const innerH = outH - borderW * 2;
  /** Two columns flush — no center seam (horizontal hgutter only). */
  const cellW = Math.floor(innerW / 2);
  const rowSpanW = cellW * 2;
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
    nameEdgePad: NAME_EDGE_PAD,
    nameFlankGap: NAME_FLANK_GAP,
    nameCharHalfW: NAME_CHAR_HALF_W,
    nameClusterHalfMax: NAME_CLUSTER_HALF_MAX,
  };
}

function readNameText(q) {
  try {
    return fs.readFileSync(nameFile(q), 'utf8').trim();
  } catch {
    return '';
  }
}

function colX(col, m) {
  return m.innerX + col * m.cellW;
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

function effectiveBadgeMetrics(m) {
  const h = Math.max(32, m.stripH - 10);
  const w = Math.min(m.badgeW, Math.round(h * 2.15));
  return { badgeW: w, badgeH: h };
}

function effectiveAvatarSize(m) {
  return Math.min(m.avatarSize, Math.max(34, m.stripH - 8));
}

function stripMidY(labelY, m) {
  return labelY + Math.floor(m.stripH / 2);
}

/**
 * On-air flank cluster — avatar + badge bracket the streamer name at cell center.
 */
function nameStripFlankPositions(q, m, nameText) {
  const b = cellBlockOrigin(q, m);
  const { badgeW, badgeH } = effectiveBadgeMetrics(m);
  const avatarSize = effectiveAvatarSize(m);
  const midY = stripMidY(b.labelY, m);
  const avatarY = midY - Math.floor(avatarSize / 2);
  const badgeY = midY - Math.floor(badgeH / 2);
  const centerX = b.x + Math.floor(m.cellW / 2);
  const clusterHalf = m.nameClusterHalfMax;
  let avatarX = centerX - clusterHalf - m.nameFlankGap - avatarSize;
  let badgeX = centerX + clusterHalf + m.nameFlankGap;
  avatarX = Math.max(b.x + 10, avatarX);
  badgeX = Math.min(b.x + m.cellW - badgeW - 10, badgeX);
  const nameZoneLeft = avatarX + avatarSize + m.nameFlankGap;
  const nameZoneRight = badgeX - m.nameFlankGap;
  return {
    avatarX,
    avatarY,
    badgeX,
    badgeY,
    avatarSize,
    badgeW,
    badgeH,
    nameZoneLeft,
    nameZoneRight,
    hiddenX: -400,
  };
}

/** drawtext x expression — on-air quad centers inside flank safe zone, not full cell. */
function nameStripTextX(q, m, audioQuad = -1, nameText) {
  const b = cellBlockOrigin(q, m);
  const cellCenter = `${b.x}+(${m.cellW}-text_w)/2`;
  if (q !== audioQuad || audioQuad < 0) return cellCenter;
  const flank = nameStripFlankPositions(q, m, nameText);
  const span = flank.nameZoneRight - flank.nameZoneLeft;
  if (span < 48) return cellCenter;
  return `${flank.nameZoneLeft}+(${span}-text_w)/2`;
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

/** Full-width navy band per name row — no vertical seam between Q1/Q2 strips. */
function nameRowBackgroundFilter(row, m) {
  const b = cellBlockOrigin(row * 2, m);
  return `drawbox@labelrow${row}=x=${m.innerX}:y=${b.labelY}:w=${m.innerW}:h=${m.stripH}:color=${BRAND.primary}@1:t=fill`;
}

function nameDrawtextFilter(q, m, esc, audioQuad = -1) {
  const b = cellBlockOrigin(q, m);
  const ty = stripTextY(b.labelY, m);
  const nameX = nameStripTextX(q, m, audioQuad);
  return (
    `drawtext@name${q}=fontfile='${esc(BRAND.fontHead)}':textfile='${esc(nameFile(q))}':reload=1:` +
    `x=${nameX}:y=${ty}:fontsize=36:fontcolor=${BRAND.accent}`
  );
}

/** Gold gutters — horizontal row divider only (no vertical center line). */
function gutterFilters(m) {
  const midRowY = m.innerY + m.stripH + m.rowBlockH;
  return [
    `drawbox@hgutter=x=${m.innerX}:y=${midRowY}:w=${m.innerW}:h=${m.borderW}:color=${BRAND.accent}@1:t=fill`,
  ];
}

function buildFrameOverlayFilters(m, audioQuad, opts, esc) {
  const titleY = m.innerY + Math.max(8, Math.floor((m.stripH - 40) / 2));
  const titleTextX = `(${m.innerX}+(${m.rowSpanW}-text_w)/2)`;
  const parts = [
    `drawbox@titlebg=x=${m.innerX}:y=${m.innerY}:w=${m.rowSpanW}:h=${m.stripH}:color=${BRAND.primary}@1:t=fill`,
    nameRowBackgroundFilter(0, m),
    nameRowBackgroundFilter(1, m),
    ...gutterFilters(m),
    ...[0, 1, 2, 3].map((q) => nameDrawtextFilter(q, m, esc, audioQuad)),
    `drawbox=x=0:y=0:w=${m.outW}:h=${m.outH}:color=${BRAND.accent}@1:t=${m.outerBorder}`,
    `drawtext@brandtitle=fontfile='${esc(BRAND.fontHead)}':text='${m.brandTitle}':` +
      `x=${titleTextX}:y=${titleY}:fontsize=44:fontcolor=${BRAND.accent}`,
    muteStatusFilter(opts, esc),
  ];
  return parts.join(',');
}

/** Twitch avatar — square with thin gold frame. */
function buildAvatarFilter(inputIdx, size, outLabel = 'avpic') {
  const inner = Math.max(28, size - 4);
  const pad = Math.floor((size - inner) / 2);
  return (
    `[${inputIdx}:v]scale=${inner}:${inner}:flags=fast_bilinear,` +
    `pad=${size}:${size}:${pad}:${pad}:color=${BRAND.accent},format=rgba[${outLabel}]`
  );
}

/** ON AIR badge — square, aspect preserved, gold letterbox pad. */
function buildOnAirBadgeFilter(inputIdx, badgeW, badgeH) {
  return (
    `[${inputIdx}:v]scale=${badgeW}:${badgeH}:flags=fast_bilinear:` +
    `force_original_aspect_ratio=decrease,` +
    `pad=${badgeW}:${badgeH}:(ow-iw)/2:(oh-ih)/2:color=${BRAND.accent},format=rgba[onairpic]`
  );
}

/** Overlay chain after [grid]: per-quad avatars (hot-switch via zmq) + on-air badge. */
function nameStripImageOverlays(m, audioQuad, opts, esc, inputIdx) {
  const onAir = Number.isInteger(audioQuad)
    && audioQuad >= 0 && audioQuad <= 3
    && !opts.muted
    && !opts.fallbackMusicActive;
  const hidden = -400;
  const avBase = inputIdx.avatar;
  const badgeIdx = inputIdx.badge;
  const flank = onAir ? nameStripFlankPositions(audioQuad, m, readNameText(audioQuad)) : null;
  const avSize = flank?.avatarSize ?? m.avatarSize;
  const badgeW = flank?.badgeW ?? m.badgeW;
  const badgeH = flank?.badgeH ?? m.badgeH;
  const parts = [];
  for (let q = 0; q < 4; q++) {
    parts.push(buildAvatarFilter(avBase + q, avSize, `avpic${q}`));
  }
  parts.push(buildOnAirBadgeFilter(badgeIdx, badgeW, badgeH));
  let chain = '[grid]';
  for (let q = 0; q < 4; q++) {
    const show = onAir && q === audioQuad;
    const pos = show ? nameStripFlankPositions(q, m, readNameText(q)) : null;
    const x = pos ? pos.avatarX : hidden;
    const y = pos ? pos.avatarY : 0;
    const out = q === 3 ? 'gridav' : `gav${q}`;
    parts.push(`${chain}[avpic${q}]overlay@onairav${q}=x=${x}:y=${y}:format=auto[${out}]`);
    chain = `[${out}]`;
  }
  parts.push(
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
  const onAir = !muted && !fallbackMusicActive;
  for (let i = 0; i < 4; i++) {
    cmds += `cdrawtext@name${i} -1 fontcolor ${BRAND.accent}\n`;
    const nameX = nameStripTextX(i, m, onAir ? q : -1);
    cmds += `cdrawtext@name${i} -1 x ${nameX}\n`;
  }
  cmds += `cdrawbox@labelrow0 -1 color ${BRAND.primary}@1\n`;
  cmds += `cdrawbox@labelrow1 -1 color ${BRAND.primary}@1\n`;
  cmds += `cdrawbox@hgutter -1 color ${BRAND.accent}@1\n`;
  const flank = onAir ? nameStripFlankPositions(q, m, readNameText(q)) : null;
  const hidden = -400;
  for (let i = 0; i < 4; i++) {
    const show = onAir && i === q;
    const pos = show ? nameStripFlankPositions(q, m, readNameText(q)) : null;
    cmds += `coverlay@onairav${i} -1 x ${show ? pos.avatarX : hidden}\n`;
    cmds += `coverlay@onairav${i} -1 y ${show ? pos.avatarY : 0}\n`;
  }
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
  nameStripTextX,
  cellVideoScaleFilter,
  buildCellFilter,
  xstackLayout,
  xstackFilter,
  buildFrameOverlayFilters,
  buildOnAirBadgeFilter,
  buildAvatarFilter,
  nameStripImageOverlays,
  muteStatusFilter,
  audioFrameZmqCommands,
  onAirVideoCropRect,
  compositorImageInputs,
};
