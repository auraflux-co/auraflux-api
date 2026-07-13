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
 *   sports-long   1 INTRO + (items × 4 scenes) + 1 OUTRO  [INTRO,CLIP,NARRATION,OUTRO] — NBA: optional LOCKED timestamp map inside each *_CLIP when nbaClipTiming is set
 *   news-short    HOOK + CLIP + REACTION  (3 scenes only — no INTRO, no OUTRO)
 *   clips-short   HOOK + CLIP + REACTION  (3 scenes only — no INTRO, no OUTRO)
 *   reddit-long    1 INTRO + POST_SETUP + (BEATn_REACT + BEATn_CLIP)×N + THREAD_CLOSE + OUTRO
 *   reddit-short   HOOK + BEAT1_REACT + BEAT1_CLIP + BEAT2_REACT (2-beat algorithm test)
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

// Fallback locked intro/outro lines — used only if customerConfig cannot be loaded.
// These are the AUTHORITATIVE values from CREATIVE_CONFIG_SPEC.md.
// Code reads from customerConfig (c0.json) first; these are the safety net.
const LOCKED_INTROS_FALLBACK = {
  'news-long':    `I'm Bobby G, and this is Because the Light was on. I'm told this is the news. A recent study shows that people who watch news programs are 40% more likely to be aware that a news program is currently happening. ... [Pause] ... Here are some things that occurred while we weren't looking.`,
  'sports-long':  `What's up, ClipzWorld! Grab your shades, because we're heading to the Other Side of the Pillow. I'm Bobby G, and we're breaking down the highlights that weren't just good—they were cold.`,
  'clips-long':   `Welcome to Twitch Soup. I'm Bobby G, looking at the streams that make us laugh, cry, and wonder why the chat is screaming 'W'`
};

const LOCKED_OUTROS_FALLBACK = `That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck.`;

/**
 * Get locked intro text for a template from customerConfig.
 * Falls back to LOCKED_INTROS_FALLBACK if config unavailable.
 * @param {string} templateId - e.g. 'news-long', 'sports-long', 'clips-long'
 * @param {string} [customerId='c0']
 * @returns {string}
 */
function getLockedIntro(templateId, customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    // Map templateId to voice key: 'news-long' → 'news', 'sports-long' → 'sports', 'clips-long' → 'clips'
    const baseType = templateId.replace(/-long$/, '').replace(/-short$/, '');
    const intro = cfg?.designDefaults?.voice?.lockedIntro?.[baseType];
    if (intro) return intro;
  } catch (e) {
    // non-fatal — fall through to fallback
  }
  return LOCKED_INTROS_FALLBACK[templateId] || LOCKED_INTROS_FALLBACK['news-long'];
}

/**
 * Get locked outro text from customerConfig.
 * Falls back to LOCKED_OUTROS_FALLBACK if config unavailable.
 * @param {string} [customerId='c0']
 * @returns {string}
 */
function getLockedOutro(customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    const outro = cfg?.designDefaults?.voice?.lockedOutro;
    if (outro) return outro;
  } catch (e) {
    // non-fatal — fall through to fallback
  }
  return LOCKED_OUTROS_FALLBACK;
}

// ─── Long-form scene builders ─────────────────────────────────────────────────

/**
 * news-long: 1 INTRO + (items × 5 scenes) + 1 OUTRO
 * Per item: STORY#_INTRO, STORY#_SETUP, STORY#_CLIP (with marker), STORY#_SUMMARY, STORY#_REACTION
 * Matches the 5-scene-per-story structure in the Gemini script prompt.
 */
function buildNewsLong(items) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', getLockedIntro('news-long')));

  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    scenes.push(scene(`STORY${n}_INTRO`));
    scenes.push(scene(`STORY${n}_SETUP`));
    scenes.push(scene(`STORY${n}_CLIP`, true));
    scenes.push(scene(`STORY${n}_SUMMARY`));
    scenes.push(scene(`STORY${n}_REACTION`));
  }

  scenes.push(lockedScene('OUTRO', getLockedOutro()));
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
  scenes.push(lockedScene('INTRO', getLockedIntro('clips-long')));

  for (let i = 0; i < items.length; i++) {
    // Use streamer display name in headers — matches what Gemini prompt generates
    // e.g. JASON_INTRO, JASON_CLIP1_SETUP, JASON_CLIP1_REACTION
    const nameTag = normalizeHeaderPart(
      items[i].displayName || items[i].name || items[i].streamer || `ITEM${i + 1}`
    );
    scenes.push(scene(`${nameTag}_INTRO`));
    for (let c = 1; c <= clipsPerStreamer; c++) {
      scenes.push(scene(`${nameTag}_CLIP${c}_SETUP`, true));
      scenes.push(scene(`${nameTag}_CLIP${c}_REACTION`));
    }
  }

  scenes.push(lockedScene('OUTRO', getLockedOutro()));
  return scenes;
}

/** Format seconds as M:SS or M:SS.s for NBA timestamp rows (matches Gemini table style). */
function formatNbaTimestampSec(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, sec);
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  const rounded = Math.round(ss * 10) / 10;
  if (Number.isInteger(rounded) || Math.abs(rounded - Math.round(rounded)) < 0.001) {
    return `${mm}:${String(Math.round(rounded)).padStart(2, '0')}`;
  }
  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  return `${mm}:${String(whole).padStart(2, '0')}${frac > 0.001 ? frac.toFixed(1).slice(1) : ''}`;
}

/**
 * LOCKED block placed in each NBA long-form CLIP scene so Gemini must ground play-by-play
 * on discrete timeline windows (not free-form recap like the previous run).
 */
/** Delimiters stripped from spoken text before HeyGen / duration estimates (see lib/qa.js sanitizeSceneText). */
const NBA_TS_LOCK_START = '<<<CWN_NBA_TS_LOCK>>>';
const NBA_TS_LOCK_END = '<<<CWN_NBA_TS_UNLOCK>>>';

function buildNbaClipTimingLockedBlock(clipTimingTargets) {
  const targets = Array.isArray(clipTimingTargets) ? clipTimingTargets : [];
  let inner;
  if (!targets.length) {
    inner = [
      'LOCKED — TIMESTAMP GROUNDING (no discrete rows extracted for this clip):',
      '- Write the spoken play-by-play slot (immediately below this block) using ONLY moments from the Gemini analysis in GAME DATA.',
      '- Do not summarize the whole game; anchor lines to specific seconds/plays as they appear in the analysis.',
      '- If the analysis includes a Timestamp | Narration table, follow those rows in order verbatim in spirit.'
    ].join('\n');
  } else {
    const rows = targets.map((t) => {
      const start = formatNbaTimestampSec(t.startSec);
      const endStr = t.endSec == null ? 'end' : formatNbaTimestampSec(t.endSec);
      const narr = String(t.narration || '').trim() || '(moment)';
      return `${start}-${endStr} | ${narr}`;
    });
    inner = [
      'LOCKED — TIMESTAMP MAP (from Gemini video analysis — do NOT edit these rows; copy the time windows exactly):',
      'Your [DIALOGUE] below must follow this table in order: one Stuart Scott burst cluster per row, same chronology, no skipped windows, no invented plays between rows.',
      'Timestamp | Narration',
      ...rows
    ].join('\n');
  }
  return [NBA_TS_LOCK_START, inner, NBA_TS_LOCK_END].join('\n');
}

/**
 * NBA/sports long-form CLIP scene: locked timeline + [DIALOGUE] slot + marker.
 */
function buildSportsLongClipScene(gameHeaderBase, clipTimingTargets) {
  const timing = buildNbaClipTimingLockedBlock(clipTimingTargets);
  return [header(`${gameHeaderBase}_CLIP`), timing, '[DIALOGUE]', '[CLIP PLAYS HERE]'].join('\n');
}

/**
 * sports-long: 1 INTRO + (items × 4 scenes) + 1 OUTRO
 * Per item: GAME#_[TEAMS]_INTRO, GAME#_CLIP (with marker), GAME#_NARRATION, GAME#_OUTRO
 *
 * @param {Array} [nbaClipTimingByGame] — optional, parallel to items: { clipTimingTargets } from nba_source / orderedClipUrls
 */
function buildSportsLong(items, nbaClipTimingByGame) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', getLockedIntro('sports-long')));

  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    const teamTag = normalizeHeaderPart(items[i].teams || items[i].title || `GAME${n}`);
    const base = `GAME${n}_${teamTag}`;
    const timingEntry = nbaClipTimingByGame && nbaClipTimingByGame[i];
    const targets = timingEntry && Array.isArray(timingEntry.clipTimingTargets)
      ? timingEntry.clipTimingTargets
      : null;

    scenes.push(scene(`${base}_INTRO`));
    if (targets && targets.length) {
      scenes.push(buildSportsLongClipScene(`${base}`, targets));
    } else {
      scenes.push(scene(`${base}_CLIP`, true));
    }
    scenes.push(scene(`${base}_NARRATION`));
    scenes.push(scene(`${base}_OUTRO`));
  }

  scenes.push(lockedScene('OUTRO', getLockedOutro()));
  return scenes;
}

// ─── Short-form scene builders ────────────────────────────────────────────────

/**
 * news-short: HOOK + CLIP + REACTION (3 scenes)
 * Split-screen: Bobby G top reacting, source clip bottom. Caption burned on video.
 * NO INTRO, NO OUTRO — per SHORT_FORM_SPEC.md
 */
function buildNewsShort(items) {
  return [
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION')
  ];
}

/**
 * clips-short: HOOK + CLIP + REACTION (3 scenes)
 * Split-screen: Bobby G top reacting, source clip bottom. Caption burned on video.
 * NO INTRO, NO OUTRO — per SHORT_FORM_SPEC.md
 */
function buildClipsShort(items) {
  return [
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION')
  ];
}

/**
 * sports-short: HOOK + CLIP + REACTION (3 scenes)
 * Split-screen: Bobby G top reacting, source clip bottom. Caption burned on video.
 * NO INTRO, NO OUTRO — per SHORT_FORM_SPEC.md. NOT the long-form voiceover mode.
 */
function buildRedditLong(items, beatCount = 5) {
  const scenes = [];
  scenes.push(lockedScene('INTRO', getLockedIntro('news-long')));
  scenes.push(scene('POST_SETUP'));
  const n = Math.max(2, Math.min(8, beatCount || items[0]?.beatCount || 5));
  for (let b = 1; b <= n; b++) {
    scenes.push(scene(`BEAT${b}_REACT`));
    scenes.push(scene(`BEAT${b}_CLIP`, true));
  }
  scenes.push(scene('THREAD_CLOSE'));
  scenes.push(lockedScene('OUTRO', getLockedOutro()));
  return scenes;
}

/**
 * reddit-short: HOOK + CLIP + REACTION (same assembly path as news-short).
 */
function buildRedditShort(items) {
  return [
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION'),
  ];
}

function buildSportsShort(items) {
  return [
    scene('HOOK'),
    scene('CLIP', true),
    scene('REACTION')
  ];
}

// ─── Template routing ─────────────────────────────────────────────────────────

const TEMPLATE_BUILDERS = {
  'news-long':    buildNewsLong,
  'clips-long':   buildClipsLong,
  'sports-long':  buildSportsLong,
  'news-short':   buildNewsShort,
  'clips-short':  buildClipsShort,
  'sports-short': buildSportsShort,
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
  const isShortTemplate = templateId.includes('short');
  const nbaClipTiming = jobSpec.nbaClipTiming;
  const useNbaTimingScaffold = templateId === 'sports-long'
    && Array.isArray(nbaClipTiming)
    && nbaClipTiming.length === items.length
    && nbaClipTiming.some((row) => (row.clipTimingTargets || []).length > 0);

  const redditDesk = items.some((i) => i.postId || i.redditPostId || i.redditSource);
  const beatCount = jobSpec.order?.inputs?.beatCount || jobSpec.beatCount || 5;

  const sceneBlocks = templateId === 'clips-long'
    ? builder(items, clipsPerStreamer)
    : templateId === 'news-long' && redditDesk
      ? buildRedditLong(items, beatCount)
    : templateId === 'sports-long' && useNbaTimingScaffold
      ? buildSportsLong(items, nbaClipTiming)
      : builder(items);
  // Prepend instructions so Gemini knows what is locked vs what needs filling
  const scaffoldInstructions = isShortTemplate ? [
    `SCAFFOLD INSTRUCTIONS (SHORT-FORM):`,
    `- Fill every [DIALOGUE] slot with spoken content in Bobby G's voice`,
    `- DO NOT change any scene headers (=== HEADER ===)`,
    `- DO NOT move or remove [CLIP PLAYS HERE] markers`,
    `- Structure is HOOK → CLIP → REACTION only — no INTRO, no OUTRO`,
    `- Add a CAPTION: line after the REACTION dialogue (per content type word limit)`,
    ``
  ].join('\n') : [
    `SCAFFOLD INSTRUCTIONS:`,
    `- Fill every [DIALOGUE] slot with spoken content in Bobby G's voice`,
    `- DO NOT change any scene headers (=== HEADER ===)`,
    `- DO NOT move or remove [CLIP PLAYS HERE] markers`,
    `- The INTRO and OUTRO text below is LOCKED — copy it exactly as written, do not paraphrase or change`,
    `- All other scenes: write fresh dialogue in Bobby G's voice`,
    ...(useNbaTimingScaffold ? [
      `- Each GAME#_*_CLIP scene contains a LOCKED "Timestamp | Narration" map — do NOT edit those lines`,
      `- Fill only the [DIALOGUE] slot in *_CLIP scenes: spoken play-by-play must follow the map row-by-row in order`,
    ] : []),
    ``
  ].join('\n');
  const scenesOnly = sceneBlocks.join('\n\n');
  const scaffold = scaffoldInstructions + scenesOnly + '\n';

  // Extract scene headers only from scene blocks (not instruction text),
  // otherwise "(=== HEADER ===)" in guidance gets counted as a real scene.
  const headerRegex = /===\s*([A-Z0-9_]+)\s*===/g;
  const sceneHeaders = [];
  let match;
  while ((match = headerRegex.exec(scenesOnly)) !== null) {
    sceneHeaders.push(match[1]);
  }

  // Count [CLIP PLAYS HERE] markers — only in scene blocks, not in instructions header
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

module.exports = {
  generateScaffold,
  normalizeHeaderPart,
  getLockedIntro,
  getLockedOutro,
  buildNbaClipTimingLockedBlock,
  formatNbaTimestampSec,
  NBA_TS_LOCK_START,
  NBA_TS_LOCK_END
};
