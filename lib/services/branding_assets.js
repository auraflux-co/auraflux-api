'use strict';
/**
 * lib/services/branding_assets.js — shared branding file paths
 *
 * Exports resolved paths for branding assets (logo, banner) and a
 * system font path suitable for FFmpeg drawtext (no spaces in filename).
 *
 * Consumers: server.js, lib/routes/c0_gate_tools.js, lib/routes/c0_capcut.js
 *
 * Usage:
 *   const { SYSTEM_FONT, CWN_LOGO_PATH, CWN_BANNER_PATH, findBrandingAsset } =
 *     require('../services/branding_assets');
 */

const fs   = require('fs');
const path = require('path');

const ROOT_DIR        = path.join(__dirname, '..', '..');
const TMP_DIR         = path.join(ROOT_DIR, 'tmp');
const ASSETS_DIR      = ROOT_DIR;

/**
 * Find a branding image asset by base name.
 * Tries common image extensions; returns the first match or null.
 *
 * @param {string} name  — base file name without extension (e.g. 'logo-80px')
 * @returns {string|null}
 */
function findBrandingAsset(name) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.PNG', '.JPG']) {
    const p = path.join(ASSETS_DIR, name + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve system font path for FFmpeg drawtext.
 * FFmpeg drawtext cannot handle spaces in font paths, so we copy the font
 * to tmp/cwn_font.ttf on first run and use that path thereafter.
 *
 * @returns {string|null}
 */
function findSystemFont() {
  const localCopy = path.join(TMP_DIR, 'cwn_font.ttf');
  if (fs.existsSync(localCopy)) return localCopy;

  const candidates = [
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Andale Mono.ttf',
    '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];

  for (const src of candidates) {
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.copyFileSync(src, localCopy);
        console.log(`[font] Copied ${src} → ${localCopy}`);
        return localCopy;
      } catch (e) {
        console.warn(`[font] Copy failed: ${e.message} — using original path`);
        return src;
      }
    }
  }
  console.warn('[font] No system font found — drawtext overlays may fail');
  return null;
}

// Resolved once at module load — safe to re-require
const SYSTEM_FONT    = findSystemFont();
const CWN_LOGO_PATH  = path.join(ROOT_DIR, 'assets', 'cwn_logo.png');
const CWN_BANNER_PATH = path.join(ROOT_DIR, 'assets', 'cwn_banner.png');
// CPD-1006: AuraFlux platform watermark — bottom-right on all sub-brand outputs
const AURAFLUX_WATERMARK_PATH = [
  path.join(ROOT_DIR, 'assets', 'cwn_logo.png'),
  path.join(ROOT_DIR, 'assets', 'brand_logo.png'),
  path.join(ROOT_DIR, 'app', 'public', 'brand', 'logo.png'),
].find((p) => fs.existsSync(p)) || CWN_LOGO_PATH;

module.exports = {
  findBrandingAsset,
  findSystemFont,
  SYSTEM_FONT,
  CWN_LOGO_PATH,
  CWN_BANNER_PATH,
  AURAFLUX_WATERMARK_PATH,
};
