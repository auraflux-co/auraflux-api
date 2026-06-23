'use strict';

/**
 * Light ClipzWorld brand frame for solo fleet encodes — gold outer border + logo
 * bottom-right. No grid cells or name strips (CPD-1068).
 */

const fs = require('fs');
const path = require('path');
const { BRAND } = require('./feeders');
const { gridFrameMetrics } = require('./brand_overlay');

const LOGO_W = parseInt(process.env.LIVE_GRID_SOLO_BRAND_LOGO_W || '110', 10);
const LOGO_PAD = parseInt(process.env.LIVE_GRID_SOLO_BRAND_LOGO_PAD || '20', 10);

function soloBrandFrameEnabled() {
  return String(process.env.LIVE_GRID_SOLO_BRAND_FRAME ?? 'on').toLowerCase() !== 'off';
}

/** Inner video area inside the gold border (same gutter as grid frame). */
function soloFrameMetrics(outW, outH) {
  const m = gridFrameMetrics(outW, outH);
  const innerW = outW - m.borderW * 2;
  const innerH = outH - m.borderW * 2;
  return { ...m, innerW, innerH };
}

/**
 * Build -vf or -filter_complex video chain for branded solo output.
 * @returns {{ mode: 'vf'|'complex', vf?: string, filterComplex?: string, extraInputs?: string[], mapVideo?: string }}
 */
function buildSoloBrandVideoFilter({ w, h, fps }) {
  const m = soloFrameMetrics(w, h);
  const bg = BRAND.background;
  const accent = BRAND.accent;
  const logoPath = BRAND.logo;
  const hasLogo = fs.existsSync(logoPath);

  const scalePad = [
    `scale=${m.innerW}:${m.innerH}:force_original_aspect_ratio=decrease`,
    `pad=${m.innerW}:${m.innerH}:(ow-iw)/2:(oh-ih)/2:color=${bg}`,
    'setsar=1',
    `fps=${fps}`,
  ].join(',');

  const border = `drawbox=x=0:y=0:w=${w}:h=${h}:color=${accent}@1:t=${m.borderW}`;

  if (!hasLogo) {
    return {
      mode: 'vf',
      vf: `${scalePad},pad=${w}:${h}:${m.borderW}:${m.borderW}:color=${bg},${border}`,
    };
  }

  const filterComplex = [
    `[0:v]${scalePad},pad=${w}:${h}:${m.borderW}:${m.borderW}:color=${bg},${border}[framed]`,
    `[1:v]scale=${LOGO_W}:-1[logo]`,
    `[framed][logo]overlay=W-w-${LOGO_PAD}:H-h-${LOGO_PAD}[vout]`,
  ].join(';');

  return {
    mode: 'complex',
    filterComplex,
    extraInputs: [logoPath],
    mapVideo: '[vout]',
  };
}

module.exports = {
  soloBrandFrameEnabled,
  soloFrameMetrics,
  buildSoloBrandVideoFilter,
  LOGO_W,
  LOGO_PAD,
};
