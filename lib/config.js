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
    DURATION_SECONDS: 3.5     // unchanged — how long card is visible
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
      OVERLAY_ZONE: { x: 1240, y: 40, w: 640, h: 360 },   // "TV Shape" Top Right (facing Bobby G, who faces viewer's left)
      LOGO_POS: { x: 20, y: 20, size: 120 }
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
