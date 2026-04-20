'use strict';

/**
 * lib/chrome_overlay_ffmpeg.js
 *
 * Universal broadcast chrome engine — pure FFmpeg drawtext/drawbox filter chains.
 * Replaces the Puppeteer → PNG → overlay pipeline from lib/chrome_overlay.js.
 *
 * Implements CHROME_OVERLAY_FFMPEG_SPEC.md (2026-04-19).
 * Reads ALL values from customerConfig (config/customers/c0.json designDefaults.chrome).
 * No hardcoded colors. No browser. No alpha channel corruption. No localhost dependency.
 *
 * Customer 1 onboarding: drop c1.json with chrome block → zero code changes here.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { logError } = require('./error_logger');

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const FONTS_DIR  = path.join(ASSETS_DIR, 'fonts');

// ── Font availability check (run once at module load) ──────────────────────
const FONT_FILES = {
  headline: path.join(FONTS_DIR, 'BebasNeue-Regular.ttf'),
  body:     path.join(FONTS_DIR, 'BarlowCondensed-SemiBold.ttf'),
  small:    path.join(FONTS_DIR, 'BarlowCondensed-Regular.ttf')
};

const FONT_AVAILABLE = {
  headline: fs.existsSync(FONT_FILES.headline),
  body:     fs.existsSync(FONT_FILES.body),
  small:    fs.existsSync(FONT_FILES.small)
};

if (!FONT_AVAILABLE.headline || !FONT_AVAILABLE.body || !FONT_AVAILABLE.small) {
  console.warn('[chrome-ffmpeg] WARN: Custom font files missing. Falling back to FFmpeg built-in sans.');
  console.warn('[chrome-ffmpeg] Expected at:', FONTS_DIR);
  console.warn('[chrome-ffmpeg] headline:', FONT_AVAILABLE.headline ? 'OK' : 'MISSING');
  console.warn('[chrome-ffmpeg] body:',     FONT_AVAILABLE.body     ? 'OK' : 'MISSING');
  console.warn('[chrome-ffmpeg] small:',    FONT_AVAILABLE.small    ? 'OK' : 'MISSING');
} else {
  console.log('[chrome-ffmpeg] Custom fonts loaded from', FONTS_DIR);
}

// ── Hex CSS (#RRGGBB) → FFmpeg (0xRRGGBB@A) ────────────────────────────────
function cssToFfmpeg(hex, alpha = '1.0') {
  const clean = (hex || '#000000').replace('#', '');
  return `0x${clean}@${alpha}`;
}

// ── Resolve effective chromeCfg from customerConfig + contentType overrides ─
function resolveChromeCfg(customerConfig, contentType) {
  const template = customerConfig?.templates?.['long-form'];
  const base = template?.designDefaults?.chrome || {};

  // Build base config with sensible defaults if fields are missing
  const cfg = {
    name:    base.name    || 'CLIPZWORLD NEWS',
    colors: {
      primary:    base.colors?.primary    || '#22304b',
      accent:     base.colors?.accent     || '#c7af4f',
      active:     base.colors?.active     || '#C0392B',
      text:       base.colors?.text       || '#ffffff',
      background: base.colors?.background || '#0d1424'
    },
    topBar: {
      height:        base.topBar?.height        || 48,
      episodePrefix: base.topBar?.episodePrefix  || 'Episode'
    },
    flag: {
      width:         base.flag?.width         || 620,
      height:        base.flag?.height        || 88,
      borderWidth:   base.flag?.borderWidth   || 4,
      maxTitleChars: base.flag?.maxTitleChars || 50,
      categoryLabel: base.flag?.categoryLabel || { news: 'WORLD NEWS', clips: 'ON STREAM', sports: 'NBA GAME' }
    },
    sidebar: {
      top:             base.sidebar?.top             || 120,
      rightMargin:     base.sidebar?.rightMargin     || 32,
      width:           base.sidebar?.width           || 420,
      itemHeight:      base.sidebar?.itemHeight      || 90,
      itemGap:         base.sidebar?.itemGap         || 12,
      maxItems:        base.sidebar?.maxItems        || 5,
      borderWidth:     base.sidebar?.borderWidth     || 4,
      activeBorderWidth: base.sidebar?.activeBorderWidth || 5
    },
    logo: {
      asset:   base.logo?.asset   || 'assets/cwn_logo.png',
      x:       base.logo?.x       ?? 1725,
      y:       base.logo?.y       ?? 910,
      size:    base.logo?.size    || 90,
      opacity: base.logo?.opacity ?? 0.85
    },
    font: {
      headline: base.font?.headline || null,
      body:     base.font?.body     || null,
      small:    base.font?.small    || null
    }
  };

  // Apply contentTypeOverrides (deep merge colors + name)
  const overrides = base.contentTypeOverrides?.[contentType] || {};
  if (overrides.name) cfg.name = overrides.name;
  if (overrides.colors) {
    cfg.colors = { ...cfg.colors, ...overrides.colors };
  }

  return cfg;
}

// ── Font file selection — falls back to no fontfile (FFmpeg built-in) ───────
function fontfileArg(chromeCfg, type) {
  // type: 'headline' | 'body' | 'small'
  const configPath = chromeCfg.font?.[type];
  if (configPath) {
    const resolved = path.resolve(__dirname, '..', configPath);
    if (fs.existsSync(resolved)) return `fontfile='${resolved.replace(/'/g, "\\'")}':`;
  }
  // Fall back to built-in font files
  if (FONT_AVAILABLE[type]) return `fontfile='${FONT_FILES[type].replace(/'/g, "\\'")}':`;
  return ''; // FFmpeg will use default sans
}

// ── Truncate text to maxLen chars with ellipsis ──────────────────────────────
function truncate(text, maxLen) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

// ── Escape text for FFmpeg drawtext ─────────────────────────────────────────
function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\u2019") // replace straight apostrophe with curly (avoids filter parse issues)
    .replace(/:/g,  '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g,  '\\,');
}

/**
 * buildChromeFilterChain(chromeParams, chromeCfg)
 *
 * Returns:
 *   {
 *     extraInputs: [string]   — array of extra -i args (just the logo PNG path)
 *     filterComplex: string   — complete FFmpeg -filter_complex string
 *   }
 *
 * The caller integrates this into their FFmpeg command:
 *   ffmpeg -i INPUT ...extraInputs... -filter_complex filterComplex -map [out] ...
 */
function buildChromeFilterChain(chromeParams, chromeCfg) {
  const {
    showFlag    = false,
    showSidebar = false,
    episodeNumber = 'Episode 1',
    showName      = chromeCfg.name || 'CLIPZWORLD NEWS',
    dateStr       = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase(),
    flagCategory  = 'WORLD NEWS',
    flagTitle     = '',
    sidebarItems  = [],
    activeIdx     = 0
  } = chromeParams;

  const c = chromeCfg.colors;
  const topBarH  = chromeCfg.topBar.height;   // 48
  const flagW    = chromeCfg.flag.width;        // 620
  const flagH    = chromeCfg.flag.height;       // 88
  const row1H    = 38;
  const row2H    = flagH - row1H;              // 50
  const sbLeft   = 1920 - chromeCfg.sidebar.rightMargin - chromeCfg.sidebar.width; // 1468
  const sbTop    = chromeCfg.sidebar.top;      // 120
  const sbW      = chromeCfg.sidebar.width;    // 420
  const sbIH     = chromeCfg.sidebar.itemHeight; // 90
  const sbGap    = chromeCfg.sidebar.itemGap;    // 12

  // FFmpeg color strings
  const COL_PRIMARY    = cssToFfmpeg(c.primary,    '0.97');
  const COL_ACCENT     = cssToFfmpeg(c.accent,     '1.0');
  const COL_ACTIVE     = cssToFfmpeg(c.active,     '1.0');
  const COL_TEXT       = cssToFfmpeg(c.text,       '1.0');
  const COL_BACKGROUND = cssToFfmpeg(c.background, '1.0');
  const COL_DARK       = '0x080e1c@1.0'; // inactive sidebar item background

  // Font selectors
  const FF_HEADLINE = fontfileArg(chromeCfg, 'headline');
  const FF_BODY     = fontfileArg(chromeCfg, 'body');
  const FF_SMALL    = fontfileArg(chromeCfg, 'small');

  const filters = [];

  // ── 1. Top Bar ─────────────────────────────────────────────────────────────
  // Background
  filters.push(`drawbox=x=0:y=0:w=1920:h=${topBarH}:color=${COL_PRIMARY}:t=fill`);
  // Bottom accent border
  filters.push(`drawbox=x=0:y=${topBarH - 2}:w=1920:h=2:color=${COL_ACCENT}:t=fill`);
  // Episode number (left)
  filters.push(`drawtext=${FF_HEADLINE}text='${escapeDrawtext(episodeNumber)}':fontsize=22:fontcolor=${COL_ACCENT}:x=32:y=14`);
  // Show name (center)
  filters.push(`drawtext=${FF_HEADLINE}text='${escapeDrawtext(showName)}':fontsize=22:fontcolor=${COL_ACCENT}:x=(w-text_w)/2:y=14`);
  // LIVE badge
  filters.push(`drawbox=x=1640:y=8:w=80:h=32:color=${COL_ACTIVE}:t=fill`);
  filters.push(`drawtext=${FF_HEADLINE}text='LIVE':fontsize=14:fontcolor=white:x=1648:y=18`);
  // Date (right of LIVE)
  filters.push(`drawtext=${FF_HEADLINE}text='${escapeDrawtext(dateStr)}':fontsize=18:fontcolor=${COL_ACCENT}:x=1740:y=15`);

  // ── 2. Flag (top-left, conditional) ───────────────────────────────────────
  if (showFlag) {
    const category = truncate(flagCategory, 40).toUpperCase();
    const title    = truncate(flagTitle, chromeCfg.flag.maxTitleChars);

    // Check if title needs two lines (split at word boundary if > 28 chars)
    const needsTwoLines = title.length > 28;
    let titleLine1 = title;
    let titleLine2 = '';
    if (needsTwoLines) {
      const words = title.split(' ');
      let line1 = '';
      for (let i = 0; i < words.length; i++) {
        const candidate = line1 ? `${line1} ${words[i]}` : words[i];
        if (candidate.length > 28 && line1) {
          titleLine2 = words.slice(i).join(' ');
          break;
        }
        line1 = candidate;
      }
      titleLine1 = line1 || title.slice(0, 28);
      if (!titleLine2) titleLine2 = title.slice(28);
    }

    const row2Height = needsTwoLines ? 72 : row2H; // expand if 2 lines
    const totalFlagH = row1H + row2Height;

    // Row 1 — category label (accent background)
    filters.push(`drawbox=x=0:y=${topBarH}:w=${flagW}:h=${row1H}:color=${COL_ACCENT}:t=fill`);
    filters.push(`drawtext=${FF_SMALL}text='${escapeDrawtext(category)}':fontsize=14:fontcolor=${COL_BACKGROUND}:x=32:y=${topBarH + 12}`);

    // Row 2 — title (primary background + accent left border)
    const row2Y = topBarH + row1H;
    filters.push(`drawbox=x=0:y=${row2Y}:w=${flagW}:h=${row2Height}:color=${COL_PRIMARY}:t=fill`);
    filters.push(`drawbox=x=0:y=${row2Y}:w=${chromeCfg.flag.borderWidth}:h=${row2Height}:color=${COL_ACCENT}:t=fill`);
    filters.push(`drawtext=${FF_BODY}text='${escapeDrawtext(titleLine1)}':fontsize=28:fontcolor=${COL_TEXT}:x=16:y=${row2Y + 12}`);
    if (needsTwoLines && titleLine2) {
      filters.push(`drawtext=${FF_BODY}text='${escapeDrawtext(titleLine2)}':fontsize=28:fontcolor=${COL_TEXT}:x=16:y=${row2Y + 44}`);
    }
  }

  // ── 3. Sidebar (right, conditional) ───────────────────────────────────────
  if (showSidebar && sidebarItems.length > 0) {
    const items = sidebarItems.slice(0, chromeCfg.sidebar.maxItems);
    items.forEach((item, i) => {
      const itemY   = sbTop + (i * (sbIH + sbGap));
      const isActive = i === activeIdx;
      const itemTitle    = escapeDrawtext(truncate(item.title || '', 35));
      const itemCategory = escapeDrawtext((item.category || '').toUpperCase());

      if (isActive) {
        // Active item — primary background + active border + "▶ ON AIR" badge
        filters.push(`drawbox=x=${sbLeft}:y=${itemY}:w=${sbW}:h=${sbIH}:color=${COL_PRIMARY}:t=fill`);
        filters.push(`drawbox=x=${sbLeft}:y=${itemY}:w=${chromeCfg.sidebar.activeBorderWidth}:h=${sbIH}:color=${COL_ACTIVE}:t=fill`);
        filters.push(`drawtext=${FF_SMALL}text='\\u25B6 ON AIR':fontsize=12:fontcolor=${COL_ACTIVE}:x=${sbLeft + 14}:y=${itemY + 10}`);
        filters.push(`drawtext=${FF_BODY}text='${itemTitle}':fontsize=22:fontcolor=${COL_TEXT}:x=${sbLeft + 14}:y=${itemY + 30}`);
      } else {
        // Inactive item — dark background + accent border
        filters.push(`drawbox=x=${sbLeft}:y=${itemY}:w=${sbW}:h=${sbIH}:color=${COL_DARK}:t=fill`);
        filters.push(`drawbox=x=${sbLeft}:y=${itemY}:w=${chromeCfg.sidebar.borderWidth}:h=${sbIH}:color=${COL_ACCENT}:t=fill`);
        filters.push(`drawtext=${FF_SMALL}text='${itemCategory}':fontsize=12:fontcolor=${COL_ACCENT}:x=${sbLeft + 14}:y=${itemY + 10}`);
        filters.push(`drawtext=${FF_BODY}text='${itemTitle}':fontsize=22:fontcolor=${COL_TEXT}:x=${sbLeft + 14}:y=${itemY + 30}`);
      }
    });
  }

  // ── Logo input args and filter chain ──────────────────────────────────────
  const logoAssetRel = chromeCfg.logo.asset || 'assets/cwn_logo.png';
  const logoAsset    = path.resolve(__dirname, '..', logoAssetRel);
  const logoExists   = fs.existsSync(logoAsset);

  let filterComplex;
  let extraInputs = [];

  if (logoExists) {
    const logoSize    = chromeCfg.logo.size || 90;
    const logoX       = chromeCfg.logo.x ?? 1725;
    const logoY       = chromeCfg.logo.y ?? 910;
    const logoOpacity = chromeCfg.logo.opacity ?? 0.85;

    extraInputs = ['-i', logoAsset];

    // Chain: [0:v] → draw filters → [drawn]; logo → scale → (opacity) → [logo]; overlay → [out]
    const drawChain = filters.join(',');
    const needsOpacity = logoOpacity < 1.0;
    const logoOpacityFilter = needsOpacity
      ? `[1:v]scale=${logoSize}:-1,colorchannelmixer=aa=${logoOpacity}[logo];`
      : `[1:v]scale=${logoSize}:-1[logo];`;

    filterComplex = `[0:v]${drawChain}[drawn];${logoOpacityFilter}[drawn][logo]overlay=x=${logoX}:y=${logoY}[out]`;
  } else {
    // No logo — just the draw filters
    if (logoAssetRel && !logoExists) {
      console.warn(`[chrome-ffmpeg] WARN: Logo asset not found: ${logoAsset} — skipping logo overlay`);
    }
    const drawChain = filters.join(',');
    extraInputs = [];
    filterComplex = `[0:v]${drawChain}[out]`;
  }

  return { extraInputs, filterComplex };
}

/**
 * buildAndBurnChrome(inputPath, chromeParams, chromeCfg, outputPath)
 *
 * High-level function called from assembly.js per scene.
 * Builds the filter chain and runs FFmpeg.
 *
 * @param {string} inputPath    - Source video path
 * @param {object} chromeParams - Per-scene params (see CHROME_OVERLAY_FFMPEG_SPEC.md section 4)
 * @param {object} chromeCfg   - Resolved chrome config (from resolveChromeCfg)
 * @param {string} outputPath   - Output video path
 * @returns {Promise<string>}   - Output path on success
 */
async function buildAndBurnChrome(inputPath, chromeParams, chromeCfg, outputPath) {
  const { extraInputs, filterComplex } = buildChromeFilterChain(chromeParams, chromeCfg);

  const args = [
    '-i', inputPath,
    ...extraInputs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '44100',
    '-y', outputPath
  ];

  await new Promise((resolve, reject) => {
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 100 * 1024 * 1024 });
    let stderr = '';
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        const reason = stderr.slice(-400).replace(/\n/g, ' ').trim();
        reject(new Error(`Chrome FFmpeg burn failed (exit ${code}): ${reason}`));
      }
    });
    proc.on('error', reject);
  });

  return outputPath;
}

module.exports = {
  resolveChromeCfg,
  buildChromeFilterChain,
  buildAndBurnChrome,
  FONT_AVAILABLE,
  FONT_FILES
};
