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

  // CPD-75: Wrangler-style structured show commentary
  preset_show_commentary: {
    entry:        'fetch',
    contentType:  'show_commentary',
    templateId:   'long-form',
    description:  'Show Commentary \u2014 Wrangler-style structured commentary (5 topics, B-roll, voiceover)',
    sourceHints:  { platform: 'any', maxDurationSec: 720 },  // ~12 min target
    stageLock:    {},
    addOnDefaults: {},
    // Commentary-specific config pre-populated into job spec at creation time
    commentaryConfig: {
      scriptTemplate: {
        format:             'multi_topic',
        topicCount:         5,
        paragraphsPerTopic: 3,
        toneProfile:        'analytical_conversational',
        promptTemplate:     'You are writing a western show commentary script. Structure: [show], [episode/season], 5 topics, each with 3 paragraphs. Tone: analytical, conversational.',
      },
      assembly: {
        mode:        'commentary',
        overlayMode: 'broll_full',
        transitions: 'cut',
      },
      // All portals required for show commentary
      portalOverrides: {
        portal0:  { active: true },
        portal1:  { active: true },
        portal1b: { active: true, reason: null },   // force video reviewer active
        portal2:  { active: true, reason: null },   // force render quality active
        portal3a: { active: true },
        portal3b: { active: true },
        portal4:  { active: true },
        portal5:  { active: true },
      },
    },
  },
};

module.exports = PRESETS;
