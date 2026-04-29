'use strict';
/**
 * Content Preset Definitions — CPD-24
 *
 * Presets are restrictions LIFTED — not imposed.
 * Each preset provides sensible defaults for a content type so customers
 * don't need to construct a full job spec from scratch. All preset
 * defaults can be overridden by the caller.
 *
 * Structure:
 *   entry        — maps to jobs_c1.js entry type (fetch|upload|generate)
 *   contentType  — default contentType for this preset
 *   templateId   — default template (long-form|short-form)
 *   description  — human-readable label for UI
 *   sourceHints  — platform hints passed to Portal 0 for clip discovery
 *   stageLock    — stageMap overrides (e.g. skip portal1 for upload presets)
 *   addOnDefaults — default addOn config (e.g. tts.active for commentary)
 */

const PRESETS = {
  preset_twitch_highlights: {
    entry:        'fetch',
    contentType:  'clips',
    templateId:   'short-form',
    description:  'Twitch Highlights — short-form clips from live stream',
    sourceHints:  { platform: 'twitch', maxDurationSec: 90 },
    stageLock:    {},
    addOnDefaults: {},
  },

  preset_news_daily: {
    entry:        'fetch',
    contentType:  'news',
    templateId:   'long-form',
    description:  'Daily News — full-length news video from web sources',
    sourceHints:  { platform: 'news', maxDurationSec: 300 },
    stageLock:    {},
    addOnDefaults: {},
  },

  preset_sports_nba: {
    entry:        'fetch',
    contentType:  'sports',
    templateId:   'short-form',
    description:  'Sports Highlights — NBA / sports clip compilation',
    sourceHints:  { platform: 'nba', maxDurationSec: 120 },
    stageLock:    {},
    addOnDefaults: {},
  },

  preset_custom_upload: {
    entry:        'upload',
    contentType:  'custom',
    templateId:   'long-form',
    description:  'Custom Upload — bring your own video file',
    sourceHints:  {},
    // Portal 1 (script QA) runs but ownScript defaults to true for uploads
    stageLock:    { portal1: { skip: false } },
    addOnDefaults: {},
  },

  preset_custom_youtube_feed: {
    entry:        'fetch',
    contentType:  'custom',
    templateId:   'long-form',
    description:  'YouTube Feed — pull from a YouTube channel or playlist',
    sourceHints:  { platform: 'youtube', maxDurationSec: 600 },
    stageLock:    {},
    addOnDefaults: {},
  },

  preset_custom_podcast_feed: {
    entry:        'fetch',
    contentType:  'custom',
    templateId:   'long-form',
    description:  'Podcast Feed — RSS or audio/video podcast content',
    sourceHints:  { platform: 'podcast', maxDurationSec: 1800 },
    stageLock:    {},
    addOnDefaults: {},
  },
};

module.exports = PRESETS;
