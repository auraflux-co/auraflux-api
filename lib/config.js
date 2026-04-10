// MOVED FROM: server.js:161 (CONFIG constant)
// CWN production configuration constants

'use strict';

const CONFIG = {
  INTRO_CARD: {
    CANVAS_WIDTH: 720,
    CANVAS_HEIGHT: 840,
    CIRCLE_CENTER_Y: 330,
    CIRCLE_RADIUS: 260,
    NAME_FONT_SIZE: 68,
    ORIGIN_FONT_SIZE: 44,
    FACT_FONT_SIZE_START: 44,
    FACT_FONT_SIZE_MIN: 28,
    DURATION_SECONDS: 3.5
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
    HEIGHT: 64,
    FPS: 15
  },
  VISUAL_LAYOUTS: {
    LONG_FORM: {
      WIDTH: 1920,
      HEIGHT: 1080,
      AVATAR_SAFE_ZONE: { x: 0, y: 720, w: 1920, h: 360 }, // Bottom third
      OVERLAY_ZONE: { x: 40, y: 40, w: 640, h: 360 },     // "TV Shape" Top Left (facing Bobby G)
      LOGO_POS: { x: 1780, y: 20, size: 120 }
    },
    SHORT_FORM: {
      WIDTH: 1080,
      HEIGHT: 1920,
      CLIP_ZONE: { x: 0, y: 0, w: 1080, h: 960 },        // Top Half
      AVATAR_ZONE: { x: 0, y: 960, w: 1080, h: 960 },    // Bottom Half
      BURN_IN_ZONE: { x: 540, y: 960, anchor: 'center' }, // Floating middle
      LOGO_POS: { x: 985, y: 15, size: 80 }
    }
  }
};

module.exports = { CONFIG };
