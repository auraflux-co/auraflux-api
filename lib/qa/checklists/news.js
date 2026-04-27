'use strict';
/**
 * lib/qa/checklists/news.js
 *
 * QA checklist module for News long-form compilations.
 * Locked intro check reads from customerConfig (c0.json → designDefaults.voice.lockedIntro.news).
 * Single source of truth: CREATIVE_CONFIG_SPEC.md → c0.json → here.
 */

/**
 * Get the locked intro check string from customerConfig.
 * Returns null if config unavailable — caller skips the check.
 */
function getLockedIntroCheck(customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('../../customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    const intro = cfg?.designDefaults?.voice?.lockedIntro?.news;
    if (intro) {
      return `9. LOCKED INTRO (-15 if wrong): The === INTRO === scene MUST contain this EXACT text: "${intro}" FAIL (-15) if the intro deviates from this wording.`;
    }
  } catch (e) {
    // non-fatal
  }
  return null;
}

/**
 * contextHeader — function because it depends on runtime values.
 * @param {object} opts - { streamers, expectedClips, expectedScenes }
 */
function contextHeader({ streamers, expectedClips, expectedScenes }) {
  return `STORIES: ${streamers.length} news stories (Gemini chose editorial order — verify by matching content, not position)
EXPECTED === STORY#_CLIP === COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`;
}

/**
 * checklist — function because some items embed expectedScenes / expectedClips.
 * @param {object} opts - { expectedScenes, expectedClips }
 */
function checklist({ expectedScenes, expectedClips, customerId = 'c0' }) {
  return [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: list each === HEADER === you find, then count your list
   - Remember: STORY1_INTRO, STORY1_SETUP, STORY1_CLIP, STORY1_SUMMARY, STORY1_REACTION are 5 SEPARATE scenes
   - Are there exactly ${expectedScenes} === HEADER === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} === STORY#_CLIP === markers (one per story) with empty spokenText?`,
    `3. OUTRO: Does the script end with "Goodnight and good luck."?`,
    `4. STORY ACCURACY: Do the STORY#_INTRO and STORY#_SETUP scenes accurately reflect the story headline and context?`,
    `5. INTRO: Is the === INTRO === scene 2-3 sentences introducing the episode?`,
    `6. STORY SETUP: Does each STORY#_SETUP scene give proper context for the clip that follows (1 sentence, new fact)?`,
    `7. CLIP SCENES: Do all === STORY#_CLIP === scenes have type: source_clip and empty spokenText?`,
    `8. STORY MATCH (most important): Gemini chose the editorial order — do NOT check by position. For each STORY# block, find the VIDEO POOL ENTRY whose analysis matches the script content, then verify accuracy. Check STORY#_INTRO and STORY#_SUMMARY describe that video's actual content. Fail only if the narration contradicts or invents facts not in any pool entry.`,
    getLockedIntroCheck(customerId),
    `10. SOURCE ATTRIBUTION (STRICT): Does any scene contain spoken source attribution? Check for "According to Al Jazeera", "Sources report", "Al Jazeera's coverage". FAIL hard (-25) if any found — Bobby G must NEVER speak the source name.`,
    `11. REACTION: Does each STORY#_REACTION scene have a flat, deadpan 1-sentence reaction?`,
    `12. VOICE STYLE (-15 if wrong): Does every scene use Bobby G's Jon Stewart + Norm MacDonald news anchor voice — facts stated plainly, one flat observation, done? FAIL this item (-15) if any scene contains:
   - Alarm words: "insane", "wild", "crazy", "unbelievable", "shocking", "you won't believe this"
   - Performed emotion: "This is SHOCKING", "I can't even process this", "What is going on?"
   - Explaining why the story matters — if it's not obvious, state the fact and move on
   - More than 4 sentences in a single story segment
   - Ellipses for drama (...) — [beat] is the only pause tool
   - ALL CAPS anywhere in spoken text
   - Call to action: "Drop your thoughts below", "Tell me what you think"
   Good: "A senator proposed a bill this week that would ban the word 'senator.' It did not pass."
   Good: "The summit ended without an agreement. Both sides described it as productive."
   Good: "He resigned citing personal reasons. The personal reason was the investigation."
   Bad: "You guys, this story is INSANE and you are NOT going to believe what happened!"
   Bad: "I can't even... like, what is going on with the world right now?"
   Bad: "This is truly shocking news that will have major implications for everyone involved."`
  ].filter(Boolean);
}

/**
 * clipReferences — builds the clip reference block for claudeScriptFix.
 * @param {Array} streamers - story title objects (with displayName or twitchUsername)
 * @param {Array} clipAnalyses - flat array of analyses aligned by index
 */
function clipReferences(streamers, clipAnalyses) {
  return streamers.map((s, i) => {
    const title = (s.displayName || s.twitchUsername || `Story ${i + 1}`).toUpperCase();
    const analysis = (Array.isArray(clipAnalyses) ? clipAnalyses[i] : null) || 'No analysis available';
    return `STORY ${i + 1} (${title}):\n${analysis}`;
  }).join('\n\n');
}

/** sceneGuide — human-readable scene naming hint used in claudeScriptFix prompt. */
const sceneGuide = 'STORY#_INTRO, STORY#_SETUP, STORY#_SUMMARY, STORY#_REACTION (where # = story number 1-5)';

/** geminiContext — no extra audio context needed for News. */
const geminiContext = null;

module.exports = { contextHeader, checklist, clipReferences, sceneGuide, geminiContext };
