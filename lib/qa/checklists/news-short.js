'use strict';
// DEPRECATED: C0 (ClipzWorld News / localhost-only). Not used by the AuraFlux portal pipeline.
/**
 * lib/qa/checklists/news-short.js
 *
 * QA checklist module for News short-form videos.
 * Extracted verbatim from lib/qa.js claudeScriptQA if/else blocks.
 *
 * See twitch-short.js for design notes on shared short-form checklist.
 */
const newsLong = require('./news');

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
 * checklist — shared short-form structure check (4 items only).
 * Caption item includes per-show rules inline (shared across all 3 short types).
 */
function checklist() {
  return [
    `1. HOOK: Is there a HOOK: line with exactly 1 sentence that sets up the clip without spoiling it?`,
    `2. CLIP MARKER: Is there exactly 1 [CLIP PLAYS HERE] marker, after the HOOK?`,
    `3. REACTION: Is there a REACTION: line with exactly 1 flat sentence delivered after the clip? No hype, no exclamation points.`,
    `4. CAPTION: Is there a CAPTION: line suitable for a burned-in screen overlay?
   - Twitch short: max 4 words, all caps, internet speak, emoji OK. Examples: "WHO LET HIM COOK 💀" / "CHAT WAS RIGHT"
   - NBA short: max 3 words, uppercase, vibe-check. Examples: "ICE IN VEINS" / "COLD BLOODED"
   - News short: max 6 words, Title Case, SLIGHTLY WRONG deadpan headline. Examples: "Drones Confirmed. Someone Is Pleased." / "War Update: Still Happening." / "Alligator Released Without Charges."
     A news caption that reads like a real AP wire headline is a FAIL (-10) — it must be subtly absurd or understated, not factually accurate wire copy.
     FAIL (-10) if caption contains calls to action ("Subscribe", "Watch", "Follow", "Like"), generic hype ("Amazing", "Incredible"), or exceeds the word limit for the show.`,
    `5. YOUTUBE VULGAR LANGUAGE (https://support.google.com/youtube/answer/10072685): HOOK, REACTION, and CAPTION must contain NO heavy profanity (F-word, S-word, slurs), sexual terms, or masked spellings (f***, sh*t). CAPTION is strictest — no "damn" or "hell" either. Internet speak without profanity is OK ("L + RATIO", "WHO LET HIM COOK"). FAIL (-15) if any violation appears in HOOK, REACTION, or CAPTION.`,
  ];
}

// Short-form fix delegates to long-form news module for clip references + scene guide
const clipReferences = newsLong.clipReferences;
const sceneGuide = newsLong.sceneGuide;

/** geminiContext — short-form QA uses geminiQACheckShort(), no content-type audio note. */
const geminiContext = null;

module.exports = { contextHeader, checklist, clipReferences, sceneGuide, geminiContext };
