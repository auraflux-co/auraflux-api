'use strict';

/**
 * Scene-reset holds — reactions only.
 * SETUP scenes (CLIP1/2/3) never get leading holds.
 * Streamer INTRO: speech only, no trailing hold.
 * Gold join pattern: hold+crowd on reaction exit → speech on incoming (intro or setup).
 */

function applySceneResetHoldsToSceneText(_sceneName, text) {
  return String(text || '').trim();
}

function injectSceneResetHoldsInScript(script) {
  return script;
}

module.exports = {
  setupNeedsLeadingHold: () => false,
  applySceneResetHoldsToSceneText,
  injectSceneResetHoldsInScript,
};
