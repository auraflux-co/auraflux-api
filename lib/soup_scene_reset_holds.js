'use strict';

/**
 * Scene-reset holds — CPD-1201 / CPD-1144
 * SETUP scenes never get leading holds (merged into intro/reaction renders).
 * Streamer INTRO + OUTRO: leading [scene hold] → 1s HeyGen pause before speech.
 * Cross-streamer handoff uses assembly sceneReset stitch; this tags script for HeyGen silence.
 */

const { SCENE_HOLD_MARKER } = require('./heygen_script');

function setupNeedsLeadingHold() {
  return false;
}

function applySceneResetHoldsToSceneText(sceneName, text) {
  const name = String(sceneName || '');
  const body = String(text || '').trim();
  if (!body) return body;
  if (/^OUTRO$/i.test(name)) {
    return leadingHoldIfMissing(body);
  }
  if (isStreamerIntroScene(name)) {
    return leadingHoldIfMissing(body);
  }
  return body;
}

function isStreamerIntroScene(sceneName) {
  return /_INTRO$/i.test(String(sceneName || '')) && !/^(INTRO|OUTRO)$/i.test(String(sceneName || ''));
}

function leadingHoldIfMissing(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/^\[scene hold\]/i.test(t)) return t;
  return `${SCENE_HOLD_MARKER}\n${t}`;
}

function injectSceneResetHoldsInScript(script) {
  if (!script || typeof script !== 'string') return script;

  return script.replace(
    /===\s*([A-Za-z_0-9]+)\s*===\s*([\s\S]*?)(?====\s*[A-Za-z_0-9]+\s*===|$)/g,
    (full, sceneName, body) => {
      const updated = applySceneResetHoldsToSceneText(sceneName, body.trim());
      return `=== ${sceneName} ===\n${updated}\n\n`;
    }
  );
}

module.exports = {
  setupNeedsLeadingHold,
  applySceneResetHoldsToSceneText,
  injectSceneResetHoldsInScript,
};
