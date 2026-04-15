// lib/chromeDirectives.js
// Red 4 — Proactive chrome directive architecture
// Zod schema + validateScript() for News (and future NBA/Twitch) structured scripts.
//
// Design doc: CHROME_DIRECTIVE_ARCHITECTURE.md
// Handoff:    CLINE_HANDOFF_NEWS_FULL_FIX_BEFORE_TEST_10.md (Subtask 4.1)
//
// Gemini writes JSON scripts with per-scene chrome directives.
// Assembly reads them literally — no string matching, no state machine.

'use strict';

const { z } = require('zod');

// ── Per-element chrome schemas ─────────────────────────────────────────────

const ChromeFlagSchema = z.object({
  visible: z.boolean(),
  text: z.string().optional(),       // UPPERCASE 2-4 word punchy summary, e.g. "TRUMP IRAN PEACE DEAL"
  source: z.string().optional(),     // Publisher name, e.g. "Al Jazeera"
  urgencyBadge: z.string().optional() // e.g. "BREAKING" — future use
});

// ChromeTvCardSchema removed — smoke test 12: TV card scrapped, sidebar + flag sufficient

const ChromeSidebarSchema = z.object({
  visible: z.boolean(),
  activeIndex: z.number().int().nonnegative().default(0), // 0-indexed story highlight
  cap: z.number().int().positive().default(5)             // max cards shown
});

const ChromeDirectiveSchema = z.object({
  flag:    ChromeFlagSchema,
  sidebar: ChromeSidebarSchema,
  ticker:  z.object({ visible: z.boolean() }).default({ visible: true }),
  logo:    z.object({ visible: z.boolean() }).default({ visible: true })
});

// ── Per-scene schemas (discriminated union on type) ────────────────────────

const AvatarSceneSchema = z.object({
  id:                   z.string(),
  type:                 z.literal('avatar'),
  storyIndex:           z.number().int(),          // -1 for COLD_OPEN/OUTRO, 0+ for stories
  spokenText:           z.string().min(1),
  estimatedDurationSec: z.number().positive(),
  chrome:               ChromeDirectiveSchema
});

const SourceClipSceneSchema = z.object({
  id:                z.string(),
  type:              z.literal('source_clip'),
  storyIndex:        z.number().int(),
  clipUrl:           z.string().url(),
  clipMaxDurationSec: z.number().positive().default(25),
  chrome:            ChromeDirectiveSchema
});

const SceneSchema = z.discriminatedUnion('type', [
  AvatarSceneSchema,
  SourceClipSceneSchema
]);

// ── Top-level script schema ────────────────────────────────────────────────

const ScriptSchema = z.object({
  scriptVersion:             z.literal(1),
  contentType:               z.enum(['news', 'nba', 'twitch']),
  clientId:                  z.string(),
  brandConfig: z.object({
    primaryHex:    z.string(),
    accentHex:     z.string(),
    showName:      z.string(),
    episodeNumber: z.number().int().positive()
  }),
  estimatedTotalDurationSec: z.number().positive(),
  storyList: z.array(z.object({
    index:  z.number().int().nonnegative(),
    title:  z.string(),
    source: z.string()
  })),
  scenes: z.array(SceneSchema).min(3) // minimum: INTRO + 1 story scene + OUTRO
});

// ── Validation helper ──────────────────────────────────────────────────────

/**
 * Validate a parsed script object against the ScriptSchema.
 * Returns { ok: true, errors: [] } on success.
 * Returns { ok: false, errors: string[] } on failure.
 *
 * @param {object} script - Parsed JSON script object
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateScript(script) {
  try {
    ScriptSchema.parse(script);
    return { ok: true, errors: [] };
  } catch (e) {
    if (e.errors) {
      // Zod ZodError — flatten to readable strings
      const errors = e.errors.map(err => {
        const path = err.path.join('.');
        return path ? `${path}: ${err.message}` : err.message;
      });
      return { ok: false, errors };
    }
    return { ok: false, errors: [e.message || String(e)] };
  }
}

/**
 * Extract all spokenText from avatar scenes, joined for HeyGen submission.
 * Preserves [beat] and [CLIP PLAYS HERE] markers from spokenText fields.
 *
 * @param {object} script - Validated script object
 * @returns {string} - Full spoken script text
 */
function extractSpokenText(script) {
  return script.scenes
    .filter(s => s.type === 'avatar')
    .map(s => `=== ${s.id} ===\n${s.spokenText}`)
    .join('\n\n');
}

/**
 * Build the storyData object expected by generateNewscastOverlay() from a directive.
 * Used by the directive consumer to bridge to the existing Puppeteer overlay function.
 *
 * @param {object} directive - scene.chrome directive object
 * @param {object} context   - { storyList, episodeNumber, brandPrimary, brandAccent }
 * @returns {object} - storyData compatible with generateNewscastOverlay()
 */
function directiveToOverlayParams(directive, context) {
  const { storyList = [], episodeNumber = 'Episode 1' } = context;

  const allStories = storyList.map(s => ({
    title:    s.title,
    category: 'WORLD NEWS', // Never show news outlet name (AL JAZEERA, BBC etc) as category label
    storyId:  `story_${s.index}`
  }));

  const activeIndex = directive.sidebar?.activeIndex ?? 0;

  return {
    storyData: {
      title:      directive.flag?.text || (allStories[activeIndex]?.title) || 'Breaking News',
      category:   'WORLD NEWS', // Never show news outlet name (AL JAZEERA, BBC etc) as category label
      allStories
    },
    storyIndex:    activeIndex,
    showLowerThird: directive.flag?.visible ?? false,
    hideSidebar:   !(directive.sidebar?.visible ?? true),
    episodeNumber,
    activeCategory: 'WORLD NEWS' // Always WORLD NEWS — never the news outlet name
    // tvCard removed — smoke test 12: TV card scrapped from all sets
  };
}

module.exports = {
  ChromeFlagSchema,
  ChromeSidebarSchema,
  ChromeDirectiveSchema,
  AvatarSceneSchema,
  SourceClipSceneSchema,
  SceneSchema,
  ScriptSchema,
  validateScript,
  extractSpokenText,
  directiveToOverlayParams
};
