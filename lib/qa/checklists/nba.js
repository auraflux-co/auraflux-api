'use strict';
/**
 * lib/qa/checklists/nba.js
 *
 * QA checklist module for NBA long-form highlights.
 * Locked intro check reads from customerConfig (c0.json → designDefaults.voice.lockedIntro.sports).
 * Single source of truth: CREATIVE_CONFIG_SPEC.md → c0.json → here.
 */

/**
 * Get the locked intro check string from customerConfig.
 * Returns null if config unavailable — caller skips the check.
 */
function getLockedIntroCheck(customerId = undefined) {
  try {
    const { loadCustomerConfig } = require('../../customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    const intro = cfg?.designDefaults?.voice?.lockedIntro?.sports;
    if (intro) {
      return `10. LOCKED INTRO (-15 if wrong): The === INTRO === scene MUST contain this EXACT text: "${intro}" FAIL (-15) if the intro deviates from this wording.`;
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
  return `GAMES: ${streamers.length} NBA games
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`;
}

/**
 * checklist — function because some items embed expectedScenes / expectedClips.
 * @param {object} opts - { expectedScenes, expectedClips }
 */
function checklist({ expectedScenes, expectedClips, customerId = undefined }) {
  return [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: GAME1_INTRO, GAME1_NARRATION, GAME1_RECAP, GAME1_REACTION are 4 SEPARATE scenes per game
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per game, inside each NARRATION scene)?`,
    `3. OUTRO: Does the script end with "Goodnight and good luck."?`,
    `4. GAME ACCURACY: Are game scores, teams, and player stats accurately mentioned?`,
    `5. INTRO: Is the intro 2-3 sentences introducing the episode?`,
    `6. NARRATION: Does each NARRATION scene contain present-tense play-by-play from Gemini's video analysis, sized to cover the clip? Must include [beat][CLIP PLAYS HERE][beat].`,
    `7. RECAP: Does each RECAP scene have 1-2 factual sentences describing what the audience just watched? No opinion — facts only.`,
    `8. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `9. CLIP MATCH (most important): Does each NARRATION accurately reflect what Gemini saw in the highlight? No invented plays.`,
    getLockedIntroCheck(customerId),
    `11. NARRATION WORD COUNT: Does each NARRATION scene match the per-game word count target from the prompt (±15% tolerance)?`,
    `12. REACTION: Is each REACTION exactly 1 sentence — deadpan, no recap?`,
    `13. NARRATION VOICE STYLE (-15 if wrong): Does each NARRATION scene use Stuart Scott cadence — short declarative bursts, specific player names and actions, economy of language? FAIL this item if narration has any of these:
   - Generic phrases like "demonstrates his scoring prowess", "puts an exclamation point", "looked to finish strong", "both teams battled"
   - Continuous run-on sentences with no rhythm breaks
   - More than 3 consecutive sentences without a pause or scene break
   - Explaining what the viewer can clearly see ("He rises and hits the shot" instead of just "He hits the shot")
   - Color commentary filler with no specific information
   Good: "Curry. Half-court. Two steps past the logo. Nobody close enough to matter."
   Bad: "Stephen Curry dribbles the ball on the perimeter. He rises and hits a critical go-ahead three-pointer."`,
  ].filter(Boolean);
}

/**
 * clipReferences — builds the clip reference block for claudeScriptFix.
 * @param {Array} streamers - game matchup objects (with displayName)
 * @param {Array} clipAnalyses - flat array of analyses
 */
function clipReferences(streamers, clipAnalyses) {
  return streamers
    .map((s, i) => {
      const game = (s.displayName || `Game ${i + 1}`).toUpperCase();
      const analysis =
        (Array.isArray(clipAnalyses) ? clipAnalyses[i] : null) || 'No analysis available';
      return `GAME ${i + 1} (${game}):\n${analysis}`;
    })
    .join('\n\n');
}

/** sceneGuide — human-readable scene naming hint used in claudeScriptFix prompt. */
const sceneGuide =
  'GAME#_INTRO, GAME#_NARRATION, GAME#_RECAP, GAME#_REACTION (where # = game number)';

/**
 * geminiContext — extra context appended to geminiQACheck EARLY/MIDDLE/LATE audio note.
 * For NBA: host narrates live over clips so mixed audio is correct — do not fail for it.
 * Returns a string. Reads speakerName from customerConfig if customerId provided.
 */
function getGeminiContext(customerId = undefined) {
  let speakerName = 'the host';
  try {
    const { loadCustomerConfig } = require('../../customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    speakerName = cfg?.voice?.speakerName || cfg?.designDefaults?.voice?.speakerName || speakerName;
  } catch (_e) {}
  return `\nAUDIO NOTE — NBA content: ${speakerName} narrates LIVE over the highlight clip. Mixed audio (${speakerName} voice + game audio playing simultaneously) is CORRECT and expected. Do NOT fail AUDIO for two simultaneous audio sources.`;
}
const geminiContext = getGeminiContext();

/**
 * expectedScenesCount — 1 COLD OPEN + (games × 4 scenes) + 1 OUTRO.
 * NBA uses: GAME#_INTRO, GAME#_NARRATION, GAME#_RECAP, GAME#_REACTION.
 */
function expectedScenesCount(streamerCount) {
  return 1 + streamerCount * 4 + 1;
}

/** Scoring weights for geminiScriptQA DEDUCTION_MAP. NBA: items 1,2,7 = -15; 6 = -10; rest -5. */
const deductionMap = { 1: 15, 2: 15, 7: 15, 6: 10, 3: 5, 4: 5, 5: 5, 8: 5, 9: 5, 10: 5, 13: 15 };
const deductionLabels = {
  1: 'CLIP COUNT', 2: 'OUTRO', 3: 'GAME ACCURACY', 4: 'COLD OPEN',
  5: 'NARRATION', 6: 'BEAT PLACEMENT', 7: 'CLIP MATCH', 8: 'LOCKED INTRO',
  9: 'NARRATION WORD COUNT', 10: 'REACTION', 13: 'NARRATION VOICE STYLE',
};

module.exports = {
  contextHeader,
  checklist,
  clipReferences,
  sceneGuide,
  geminiContext,
  getGeminiContext,
  expectedScenesCount,
  deductionMap,
  deductionLabels,
};
