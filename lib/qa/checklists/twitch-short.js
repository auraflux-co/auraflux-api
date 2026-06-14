'use strict';
// DEPRECATED: C0 (ClipzWorld News / localhost-only). Not used by the AuraFlux portal pipeline.
/**
 * lib/qa/checklists/twitch-short.js
 *
 * QA checklist module for Twitch short-form videos.
 * Extracted verbatim from lib/qa.js claudeScriptQA if/else blocks.
 *
 * IMPORTANT: The short-form checklist (4 items) is shared across all 3 short-form content
 * types — the only difference is the contextHeader and the clipReferences/sceneGuide
 * from claudeScriptFix (which delegates to the long-form type's module).
 * geminiQACheck for short-form routes to geminiQACheckShort() which has no
 * content-type-specific branching, so geminiContext is null for all short types.
 */
const twitchLong = require('./twitch');

/**
 * contextHeader — function because it depends on runtime values.
 * Short-form twitch uses same streamer-count header structure as long-form.
 * @param {object} opts - { displayNames, clipsPerStreamer, expectedClips, expectedScenes, streamers }
 */
function contextHeader({ displayNames, clipsPerStreamer, expectedClips, expectedScenes }) {
  return `STREAMERS (use ONLY these display names): ${displayNames}
CLIPS PER STREAMER: ${clipsPerStreamer}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`;
}

/**
 * checklist — shared short-form structure check (4 items only).
 * The caption item includes per-show rules inline.
 * NOTE: opts are not used for short-form (no expectedScenes/expectedClips in checklist body).
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
  ];
}

// Short-form fix delegates to long-form twitch module for clip references + scene guide
const clipReferences = twitchLong.clipReferences;
const sceneGuide = twitchLong.sceneGuide;

/** geminiContext — short-form QA uses geminiQACheckShort(), no content-type audio note. */
const geminiContext = null;

module.exports = { contextHeader, checklist, clipReferences, sceneGuide, geminiContext };
