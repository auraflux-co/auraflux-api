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
 *   news-long     1 INTRO + (items × 4 scenes) + 1 OUTRO
 *   clips-long    1 INTRO + (items × 7 scenes) + 1 OUTRO
 *   sports-long   1 INTRO + (items × 4 scenes) + 1 OUTRO
 *   news-short    INTRO + 1 story + OUTRO (no [CLIP PLAYS HERE])
 *   clips-short   INTRO + HOOK + CLIP + REACTION + OUTRO
 *   sports-short  INTRO + CLIP + NARRATION + OUTRO
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
 * news-long: 1 INTRO + (items × 4 scenes) + 1 OUTRO
 * Per item: STORY#_INTRO, STORY#_CLIP (with marker), STORY#_REACTION, STORY#_OUTRO
 */
function buildNewsLong(items) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', LOCKED_INTROS['news-long']));

  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    scenes.push(scene(`STORY${n}_INTRO`));
    scenes.push(scene(`STORY${n}_CLIP`, true));
    scenes.push(scene(`STORY${n}_REACTION`));
    scenes.push(scene(`STORY${n}_OUTRO`));
  }

  scenes.push(lockedScene('OUTRO', LOCKED_OUTROS['news-long']));
  return scenes;
}

/**
 * clips-long: 1 INTRO + (items × 7 scenes) + 1 OUTRO
 * Per item: #_INTRO, #_CLIP1, #_REACTION1, #_CLIP2, #_REACTION2, #_CLIP3, #_OUTRO
 */
function buildClipsLong(items) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', LOCKED_INTROS['clips-long']));

  for (let i = 0; i < items.length; i++) {
    const tag = normalizeHeaderPart(items[i].name || items[i].id || `STREAMER${i + 1}`);
    scenes.push(scene(`${tag}_INTRO`));
    scenes.push(scene(`${tag}_CLIP1`, true));
    scenes.push(scene(`${tag}_REACTION1`));
    scenes.push(scene(`${tag}_CLIP2`, true));
    scenes.push(scene(`${tag}_REACTION2`));
    scenes.push(scene(`${tag}_CLIP3`, true));
    scenes.push(scene(`${tag}_OUTRO`));
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
 * news-short: INTRO + 1 story + OUTRO (avatar only, no [CLIP PLAYS HERE])
 */
function buildNewsShort(items) {
  const item = items[0] || {};
  const tag = normalizeHeaderPart(item.title || item.topic || 'STORY');
  return [
    lockedScene('INTRO', LOCKED_INTROS['news-short']),
    scene(`${tag}_SETUP`),
    scene(`${tag}_HOOK`),
    lockedScene('OUTRO', LOCKED_OUTROS['news-short'])
  ];
}

/**
 * clips-short: INTRO + HOOK + CLIP + REACTION + OUTRO
 */
function buildClipsShort(items) {
  const item = items[0] || {};
  const tag = normalizeHeaderPart(item.name || item.id || 'CLIP');
  return [
    lockedScene('INTRO', LOCKED_INTROS['clips-short']),
    scene(`${tag}_HOOK`),
    scene(`${tag}_CLIP`, true),
    scene(`${tag}_REACTION`),
    lockedScene('OUTRO', LOCKED_OUTROS['clips-short'])
  ];
}

/**
 * sports-short: INTRO + CLIP + NARRATION + OUTRO
 */
function buildSportsShort(items) {
  const item = items[0] || {};
  const tag = normalizeHeaderPart(item.teams || item.title || 'GAME');
  return [
    lockedScene('INTRO', LOCKED_INTROS['sports-short']),
    scene(`${tag}_CLIP`, true),
    scene(`${tag}_NARRATION`),
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

  const items = jobSpec.order?.inputs?.items || [];
  if (items.length === 0) {
    throw new Error('jobSpec.order.inputs.items must have at least one item');
  }

  const sceneBlocks = builder(items);
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

  // Count [CLIP PLAYS HERE] markers
  const clipMatches = scaffold.match(/\[CLIP PLAYS HERE\]/g) || [];
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
