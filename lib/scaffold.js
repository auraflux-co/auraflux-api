'use strict';
/**
 * lib/scaffold.js — Script Scaffold Generator
 *
 * The system (not Gemini) generates the script structure. Gemini fills dialogue only.
 * Scene headers use underscores (normalized at generation time).
 * [CLIP PLAYS HERE] markers are positionally locked — Gemini cannot move them.
 *
 * Usage:
 *   const { generateScaffold } = require('./lib/scaffold');
 *   const { scaffold, expectedSceneCount, expectedClipCount, sceneHeaders } = generateScaffold(jobSpec);
 *
 * Supported templateIds (Customer 0):
 *   news-long     1 INTRO + (items × 5 scenes) + 1 OUTRO  [INTRO,SETUP,CLIP,SUMMARY,REACTION]
 *   clips-long    1 INTRO + (items × 7 scenes) + 1 OUTRO  [INTRO,CLIP1_SETUP,CLIP1_REACTION,CLIP2_SETUP,CLIP2_REACTION,CLIP3_SETUP,CLIP3_REACTION]
 *   sports-long   1 INTRO + (items × 4 scenes) + 1 OUTRO  [INTRO,CLIP,NARRATION,OUTRO]
 *   news-short    INTRO + HOOK + CLIP + REACTION + OUTRO   (split-screen, all 3 short types identical)
 *   clips-short   INTRO + HOOK + CLIP + REACTION + OUTRO
 *   sports-short  INTRO + HOOK + CLIP + REACTION + OUTRO
 */

// ─── Template definitions ─────────────────────────────────────────────────────

/**
 * Normalize a string for use as a scene header component.
 * Converts spaces → underscores, uppercases.
 */
function normalizeHeaderPart(str) {
  if (!str) return '';
  return str.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

/**
 * Build a scene header string: === HEADER_NAME ===
 */
function header(name) {
  return `=== ${normalizeHeaderPart(name)} ===`;
}

/**
 * Build a scene block with a header and a [DIALOGUE] slot.
 */
function scene(name, includeClipMarker = false) {
  const lines = [header(name), '[DIALOGUE]'];
  if (includeClipMarker) lines.push('[CLIP PLAYS HERE]');
  return lines.join('\n');
}

/**
 * Build a scene block with pre-filled locked text (Gemini must not change it).
 */
function lockedScene(name, lockedText) {
  return [header(name), lockedText].join('\n');
}

// Locked intro/outro lines per show — system-owned, not Gemini-owned
const LOCKED_INTROS = {
  'news-long':    `I'm Bobby G, and this is Because the Light was on. I'm told this is the news.`,
  'sports-long':  `What's up, ClipzWorld! Grab your shades, because we're heading to the Other Side of the Pillow. I'm Bobby G, and we're breaking down the highlights that weren't just good—they were cold.`,
  'clips-long':   `Welcome to Twitch Soup. I'm your host Bobby G, and for the next few minutes I'll be your guide through the world of livestreaming. Let's get into it.`,
  'news-short':   `I'm Bobby G, and this is Because the Light was on. I'm told this is the news.`,
  'sports-short': `What's up, ClipzWorld! Grab your shades, because we're heading to the Other Side of the Pillow. I'm Bobby G, and we're breaking down the highlights that weren't just good—they were cold.`,
  'clips-short':  `Welcome to Twitch Soup. I'm your host Bobby G, and for the next few minutes I'll be your guide through the world of livestreaming. Let's get into it.`
};

const LOCKED_OUTROS = {
  'news-long':    `That's the news, folks. I'm Bobby G... and I've been told I'm the only thing standing between you and a 12-hour documentary on dorky haircuts. Goodnight and good luck.`,
  'sports-long':  `That's the news, folks. I'm Bobby G... and I've been told I'm the only thing standing between you and a 12-hour documentary on dorky haircuts. Goodnight and good luck.`,
  'clips-long':   `That's the news, folks. I'm Bobby G... and I've been told I'm the only thing standing between you and a 12-hour documentary on dorky haircuts. Goodnight and good luck.`,
  'news-short':   `Subscribe. Appreciate you.`,
  'sports-short': `Subscribe. Appreciate you.`,
  'clips-short':  `Subscribe. Appreciate you.`
};

// ─── Long-form scene builders ─────────────────────────────────────────────────

/**
 * news-long: 1 INTRO + (items × 5 scenes) + 1 OUTRO
 * Per item: STORY#_INTRO, STORY#_SETUP, STORY#_CLIP (with marker), STORY#_SUMMARY, STORY#_REACTION
 * Matches the 5-scene-per-story structure in the Gemini script prompt.
 */
function buildNewsLong(items) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', LOCKED_INTROS['news-long']));

  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    scenes.push(scene(`STORY${n}_INTRO`));
    scenes.push(scene(`STORY${n}_SETUP`));
    scenes.push(scene(`STORY${n}_CLIP`, true));
    scenes.push(scene(`STORY${n}_SUMMARY`));
    scenes.push(scene(`STORY${n}_REACTION`));
  }

  scenes.push(lockedScene('OUTRO', LOCKED_OUTROS['news-long']));
  return scenes;
}

/**
 * clips-long: 1 INTRO + (items × 7 scenes) + 1 OUTRO
 * Per item: ITEM#_INTRO, ITEM#_CLIP1_SETUP, ITEM#_CLIP1_REACTION, ITEM#_CLIP2_SETUP, ITEM#_CLIP2_REACTION, ITEM#_CLIP3_SETUP, ITEM#_CLIP3_REACTION
 * Matches the prompt structure: INTRO + (CLIP#_SETUP + CLIP#_REACTION) × clipsPerStreamer
 * No per-streamer OUTRO — Bobby G transitions directly after last reaction.
 */
function buildClipsLong(items, clipsPerStreamer = 3) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', LOCKED_INTROS['clips-long']));

  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    scenes.push(scene(`ITEM${n}_INTRO`));
    for (let c = 1; c <= clipsPerStreamer; c++) {
      scenes.push(scene(`ITEM${n}_CLIP${c}_SETUP`, true));
      scenes.push(scene(`ITEM${n}_CLIP${c}_REACTION`));
    }
  }

  scenes.push(lockedScene('OUTRO', LOCKED_OUTROS['clips-long']));
  return scenes;
}

/**
 * sports-long: 1 INTRO + (items × 4 scenes) + 1 OUTRO
 * Per item: GAME#_[TEAMS]_INTRO, GAME#_CLIP (with marker), GAME#_NARRATION, GAME#_OUTRO
 */
function buildSportsLong(items) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', LOCKED_INTROS['sports-long']));

  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    const teamTag = normalizeHeaderPart(items[i].teams || items[i].title || `GAME${n}`);
    scenes.push(scene(`GAME${n}_${teamTag}_INTRO`));
    scenes.push(scene(`GAME${n}_${teamTag}_CLIP`, true));
    scenes.push(scene(`GAME${n}_${teamTag}_NARRATION`));
    scenes.push(scene(`GAME${n}_${teamTag}_OUTRO`));
  }

  scenes.push(lockedScene('OUTRO', LOCKED_OUTROS['sports-long']));
  return scenes;
}

// ─── Short-form scene builders ────────────────────────────────────────────────

/**
 * news-short: INTRO + HOOK + CLIP + REACTION + OUTRO
 * Split-screen: Bobby G top reacting, source clip bottom. Caption burned on video.
 * Same structure as all short-form content types.
 */
function buildNewsShort(items) {
  return [
    lockedScene('INTRO', LOCKED_INTROS['news-short']),
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION'),
    lockedScene('OUTRO', LOCKED_OUTROS['news-short'])
  ];
}

/**
 * clips-short: INTRO + HOOK + CLIP + REACTION + OUTRO
 * Split-screen: Bobby G top reacting, source clip bottom. Caption burned on video.
 */
function buildClipsShort(items) {
  return [
    lockedScene('INTRO', LOCKED_INTROS['clips-short']),
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION'),
    lockedScene('OUTRO', LOCKED_OUTROS['clips-short'])
  ];
}

/**
 * sports-short: INTRO + HOOK + CLIP + REACTION + OUTRO
 * Split-screen: Bobby G top reacting, source clip bottom. Caption burned on video.
 * Same structure as all short-form — NOT the long-form voiceover mode.
 */
function buildSportsShort(items) {
  return [
    lockedScene('INTRO', LOCKED_INTROS['sports-short']),
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION'),
    lockedScene('OUTRO', LOCKED_OUTROS['sports-short'])
  ];
}

// ─── Template routing ─────────────────────────────────────────────────────────

const TEMPLATE_BUILDERS = {
  'news-long':    buildNewsLong,
  'clips-long':   buildClipsLong,
  'sports-long':  buildSportsLong,
  'news-short':   buildNewsShort,
  'clips-short':  buildClipsShort,
  'sports-short': buildSportsShort
};

/**
 * Infer templateId from jobSpec if not explicitly provided.
 */
function inferTemplateId(jobSpec) {
  // contentType lives at top level or order.contentType
  const contentType = (jobSpec?.contentType || jobSpec?.order?.contentType || '').toLowerCase();
  // formFactor lives at order.output.formFactor or templateId suffix or order.formType
  const formFactor = (
    jobSpec?.order?.output?.formFactor ||
    jobSpec?.order?.formType ||
    (jobSpec?.templateId?.includes('short') ? 'short' : 'long')
  ).toLowerCase();

  // Map content type aliases
  let type = contentType;
  if (['twitch', 'clips', 'streamer'].some(t => type.includes(t))) type = 'clips';
  if (['nba', 'sports', 'basketball', 'football'].some(t => type.includes(t))) type = 'sports';
  if (['news', 'world', 'global'].some(t => type.includes(t))) type = 'news';

  const form = formFactor.includes('short') ? 'short' : 'long';
  return `${type}-${form}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a script scaffold for a job.
 *
 * @param {Object} jobSpec - Job specification
 * @returns {{
 *   scaffold: string,
 *   expectedSceneCount: number,
 *   expectedClipCount: number,
 *   sceneHeaders: string[],
 *   templateId: string
 * }}
 */
function generateScaffold(jobSpec) {
  if (!jobSpec) throw new Error('jobSpec is required');

  const templateId = jobSpec.order?.templateId || inferTemplateId(jobSpec);
  const builder = TEMPLATE_BUILDERS[templateId];

  if (!builder) {
    throw new Error(`Unknown templateId "${templateId}". Supported: ${Object.keys(TEMPLATE_BUILDERS).join(', ')}`);
  }

  let items = jobSpec.order?.inputs?.items || [];
  // For short-form, items may be empty at scaffold time (source scraping runs after)
  // Use a placeholder so scaffold can generate universal structure
  if (items.length === 0) {
    const isShort = templateId.includes('short') || jobSpec.contentType?.includes('-short');
    if (isShort) {
      items = [{ title: 'STORY', name: 'ITEM', id: 'item_0' }]; // placeholder — real data comes from source
    } else {
      throw new Error('jobSpec.order.inputs.items must have at least one item');
    }
  }

  // Pass clipsPerStreamer for clips-long (from jobSpec or default 3)
  const clipsPerStreamer = jobSpec.order?.inputs?.clipsPerStreamer
    || jobSpec.clipsPerStreamer
    || 3;
  const sceneBlocks = templateId === 'clips-long' ? builder(items, clipsPerStreamer) : builder(items);
  // Prepend instructions so Gemini knows what is locked vs what needs filling
  const scaffoldInstructions = [
    `SCAFFOLD INSTRUCTIONS:`,
    `- Fill every [DIALOGUE] slot with spoken content in Bobby G's voice`,
    `- DO NOT change any scene headers (=== HEADER ===)`,
    `- DO NOT move or remove [CLIP PLAYS HERE] markers`,
    `- The INTRO and OUTRO text below is LOCKED — copy it exactly as written, do not paraphrase or change`,
    `- All other scenes: write fresh dialogue in Bobby G's voice`,
    ``
  ].join('\n');
  const scaffold = scaffoldInstructions + sceneBlocks.join('\n\n') + '\n';

  // Extract scene headers from scaffold (normalized)
  const headerRegex = /===\s*([A-Z0-9_]+)\s*===/g;
  const sceneHeaders = [];
  let match;
  while ((match = headerRegex.exec(scaffold)) !== null) {
    sceneHeaders.push(match[1]);
  }

  // Count [CLIP PLAYS HERE] markers — only in scene blocks, not in instructions header
  const scenesOnly = sceneBlocks.join('\n\n');
  const clipMatches = scenesOnly.match(/\[CLIP PLAYS HERE\]/g) || [];
  const expectedClipCount = clipMatches.length;
  const expectedSceneCount = sceneHeaders.length;

  return {
    scaffold,
    expectedSceneCount,
    expectedClipCount,
    sceneHeaders,
    templateId
  };
}

module.exports = { generateScaffold, normalizeHeaderPart };
