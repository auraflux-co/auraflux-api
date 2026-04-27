'use strict';
/**
 * lib/qa/checklists/twitch.js
 *
 * QA checklist module for Twitch long-form compilations.
 * Locked intro check reads from customerConfig (c0.json → designDefaults.voice.lockedIntro.clips).
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
    const intro = cfg?.designDefaults?.voice?.lockedIntro?.clips;
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
 * @param {object} opts - { displayNames, clipsPerStreamer, expectedClips, expectedScenes, streamers }
 */
function contextHeader({ displayNames, clipsPerStreamer, expectedClips, expectedScenes }) {
  return `STREAMERS (use ONLY these display names): ${displayNames}
CLIPS PER STREAMER: ${clipsPerStreamer}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
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
   - Method: Search through script and list each header you find, then count your list
   - Remember: Scenes with numbers (CLIP1, CLIP2, CLIP3) are SEPARATE scenes, not one scene
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?`,
    `3. OUTRO: Does the script end with "Goodnight and good luck."?`,
    `4. DISPLAY NAMES: Are only the approved display names used (no Twitch usernames)?`,
    `5. INTRO LENGTH: Is each streamer intro 2 or 3 sentences? (2 minimum, 3 maximum — 3 sentences is PASS, only FAIL if 1 sentence or 4+ sentences)`,
    `6. REACTION LENGTH: Is each reaction exactly 1 sentence? (FAIL only if 2 or more sentences)`,
    `7. SETUP LENGTH: Are clips 2 and 3 setups 2 sentences each? (FAIL only if 1 sentence or 3+ sentences)`,
    `8. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `9. CLIP MATCH (most important): Does each setup accurately describe what happens in the clip? Check each one.`,
    getLockedIntroCheck(customerId),
    `11. WORD COUNT: Is each streamer section approximately 80-100 words?`,
    `12. VOICE STYLE (-15 if wrong): Does every scene use Bobby G's Norm MacDonald + Jon Stewart deadpan voice? FAIL this item (-15) if any scene contains:
   - Hype words: "incredible", "amazing", "crazy", "wild", "insane", "unbelievable", "epic", "lit", "fire", "COOKING"
   - Performed enthusiasm or exclamation points in spoken text
   - Audience address: "You guys", "Let me know in the comments", "Drop a like", "What do you think?"
   - Explaining the joke or spelling out why something is funny
   - Ellipses for drama (...) — [beat] is the only pause tool
   - Sentences that go up at the end — everything lands flat
   Good: "He spent forty minutes trying to open a door that was already open. This is a licensed streamer."
   Good: "Chat told him to do it. He did it. Nobody won."
   Good: "She has four thousand subscribers and the confidence of a man with forty million. Respect."
   Bad: "This clip is absolutely INSANE! I can't believe what I just watched!"
   Bad: "You guys, this streamer is absolutely COOKING right now!"
   Bad: "Let me know in the comments what you think about this!"`,
  ].filter(Boolean);
}

/**
 * clipReferences — builds the clip reference block for claudeScriptFix.
 * @param {Array} streamers - streamer objects (with displayName / twitchUsername)
 * @param {Array} clipAnalyses - 2D array [[s0c0, s0c1], [s1c0, s1c1], ...]
 */
function clipReferences(streamers, clipAnalyses) {
  return streamers
    .map((s, si) => {
      const name = (s.displayName || s.twitchUsername || '').toUpperCase().replace(/\s+/g, '_');
      const analysesList = Array.isArray(clipAnalyses[si])
        ? clipAnalyses[si]
        : [clipAnalyses[si] || ''];
      return analysesList
        .map((a, ci) => name + ' CLIP ' + (ci + 1) + ': ' + (a || 'No analysis available'))
        .join('\n');
    })
    .join('\n');
}

/** sceneGuide — human-readable scene naming hint used in claudeScriptFix prompt. */
const sceneGuide = 'streamer INTRO, CLIP#_SETUP, CLIP#_REACTION sections';

/**
 * getGeminiContext — extra context appended to geminiQACheck audio note.
 * For Twitch: host reacts live over streamer clips. Mixed audio (host + game) is expected.
 * Returns a string or null. Reads speakerName from customerConfig if customerId provided.
 */
function getGeminiContext(customerId = 'c0') {
  let speakerName = 'the host';
  try {
    const { loadCustomerConfig } = require('../../customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    speakerName = cfg?.voice?.speakerName || cfg?.designDefaults?.voice?.speakerName || speakerName;
  } catch (_e) {}
  return `\nAUDIO NOTE — Twitch content: ${speakerName} reacts live over streamer clips. Mixed audio (${speakerName} commentary + stream audio simultaneously) is CORRECT and expected. Do NOT fail AUDIO for two simultaneous audio sources.`;
}
const geminiContext = getGeminiContext();

module.exports = { contextHeader, checklist, clipReferences, sceneGuide, geminiContext, getGeminiContext };
