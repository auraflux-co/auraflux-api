// MOVED FROM: server.js:161 (CONFIG constant)
// CWN production configuration constants

'use strict';

const CONFIG = {
  INTRO_CARD: {
    // TV Rectangle design (1280×720 canvas → 640×360 final after FFmpeg scale)
    // All 3 content types (Twitch, NBA, News) use this same TV-rectangle design
    CANVAS_WIDTH: 1280,
    CANVAS_HEIGHT: 720,
    IMAGE_SIZE: 600,          // profile image square edge (left side)
    IMAGE_MARGIN: 60,         // left margin of image
    TEXT_GAP: 80,             // gap between image right edge and text column
    NAME_FONT_SIZE: 136,      // 2× of final 68pt (gold, bold)
    ORIGIN_FONT_SIZE: 88,     // 2× of final 44pt (white)
    FACT_FONT_SIZE: 64,       // 2× of final 32pt (grey italic, word-wrapped)
    FACT_FONT_SIZE_MIN: 36,   // minimum fact font size before truncation
    BORDER_WIDTH: 10,         // 2× of final 5px gold border
    DURATION_TWITCH: 10,      // Gap #44: Twitch 10s (unchanged from original)
    DURATION_NBA: 8,          // Gap #44: NBA 8s — Rob directive 2026-04-12 evening
    DURATION_NEWS: 12         // Gap #44: News 12s — Rob directive 2026-04-12 evening
  },
  TRANSITIONS: {
    DISSOLVE_DURATION: 0.7,
    CROSSFADE_DURATION: 0.3,
    FADE_DURATION: 0.5
  },
  GEMINI: {
    MAX_FILE_SIZE: 34 * 1024 * 1024, // 34MB
    MAX_VIDEO_RETRIES: 3,
    UPLOAD_TIMEOUT: 120000
  },
  VIDEO: {
    ANALYSIS_QUALITIES: ['720', '480', '360'],
    ASSEMBLY_QUALITIES: ['1080', '720', 'best'],
    MIN_SEGMENT_SIZE: 100000, // 100KB
    MAX_SEGMENT_SIZE: 2 * 1024 * 1024 * 1024 // 2GB
  },
  ASSEMBLY: {
    ESTIMATED_SIZE_PER_SEGMENT_MB: 20,
    OVERHEAD_MB: 500,
    TIMEOUT_MS: 1800000 // 30 minutes
  },
  TICKER: {
    CACHE_TTL_MS: 3600000, // 1 hour
    DURATION_SECONDS: 60,
    WIDTH: 1920,
    HEIGHT: 64,   // reverted from 72 — ticker HTML designed for 64px; capturing at 72 produced 8px transparent gap. Long-term fix: redesign ticker HTML for taller height (2026-04-12)
    FPS: 30
  },
  VISUAL_LAYOUTS: {
    LONG_FORM: {
      WIDTH: 1920,
      HEIGHT: 1080,
      AVATAR_SAFE_ZONE: { x: 0, y: 720, w: 1920, h: 360 }, // Bottom third
      OVERLAY_ZONE: { x: 1360, y: 60, w: 520, h: 293 },   // "TV Shape" Top-Right — 520×293 exact 16:9 (520÷293=1.7748), 60px top padding, 40px right margin (1360+520=1880), broadcast over-the-shoulder style next to Bobby G's head (2026-04-11 late revision)
      LOGO_POS: { x: 1725, y: 910, size: 90, opacity: 0.85 },  // Bottom-right on Bobby G's coffee mug — all long-form shows
      LOGO_POS_NEWS: { x: 1725, y: 910, size: 90, opacity: 0.85 }  // News-specific alias (same position, keep for compatibility)
    },
    SHORT_FORM: {
      WIDTH: 1080,
      HEIGHT: 1920,
      CLIP_ZONE: { x: 0, y: 0, w: 1080, h: 960 },        // Top Half
      AVATAR_ZONE: { x: 0, y: 960, w: 1080, h: 960 },    // Bottom Half
      BURN_IN_ZONE: { x: 540, y: 960, anchor: 'center' }, // Floating middle
      LOGO_POS: { x: 900, y: 1800, size: 80, opacity: 0.85 }  // Bottom-right on Bobby G's coffee mug (avatar is bottom half, y=960-1920)
    }
  },
  NBA: {
    AD_TRIM_SECONDS: 15  // ESPN pre-roll ad duration to skip at assembly time (not yet wired)
  },
  FFMPEG: {
    // Quality settings — VideoToolbox uses -q:v (0-100, higher=better)
    // libx264 uses -crf (0-51, lower=better)
    HW_QUALITY_FLAG:  ['-q:v', '45'],   // VideoToolbox: 45 ≈ libx264 crf 23 (standard quality, ~4Mbps)
    HW_QUALITY_HQ:    ['-q:v', '55'],   // VideoToolbox: 55 ≈ libx264 crf 18 (chrome burns, ~6Mbps)
    SW_QUALITY_FLAGS: ['-preset', 'ultrafast', '-crf', '23'],  // Railway: ultrafast > fast
    SW_QUALITY_HQ:    ['-preset', 'fast', '-crf', '18'],       // Chrome burns: keep quality
    THREADS: ['-threads', '0']  // 0 = auto-detect all cores
  }
};

module.exports = { CONFIG };
