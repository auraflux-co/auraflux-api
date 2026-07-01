'use strict';

/**
 * Swap clip1 ↔ clip2 for one streamer in orderedClipUrls + script scene text.
 * Used when setup/reaction copy was paired with the wrong source clip.
 */

function normalizeStreamerKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function swapStreamerClipPairInLineup(orderedClipUrls, streamerKey, clipsPerStreamer = 2) {
  if (!Array.isArray(orderedClipUrls) || clipsPerStreamer !== 2) {
    return { swapped: false, orderedClipUrls, reason: 'requires 2 clips per streamer' };
  }
  const key = normalizeStreamerKey(streamerKey);
  const indices = [];
  for (let i = 0; i < orderedClipUrls.length; i++) {
    const clip = orderedClipUrls[i];
    const ck = normalizeStreamerKey(clip?.streamer || clip?.displayName || clip?.twitchUsername);
    if (ck === key || ck.includes(key) || key.includes(ck)) indices.push(i);
  }
  if (indices.length !== 2) {
    return { swapped: false, orderedClipUrls, reason: `expected 2 clips for ${streamerKey}, found ${indices.length}` };
  }
  const out = orderedClipUrls.slice();
  const [a, b] = indices;
  [out[a], out[b]] = [out[b], out[a]];
  return { swapped: true, orderedClipUrls: out, indices: [a, b] };
}

function swapScriptClipScenes(script, prefix) {
  const p = String(prefix || '').toUpperCase();
  if (!script || !p) return script;

  const sceneRe = new RegExp(
    `(===\\s*(${p}_CLIP1_(SETUP|REACTION))\\s*===\\s*)([\\s\\S]*?)(?=\\n===\\s*${p}_CLIP2_(SETUP|REACTION)\\s*===)`,
    'i'
  );
  const blockRe = new RegExp(
    `(===\\s*${p}_CLIP1_SETUP\\s*===[\\s\\S]*?)(===\\s*${p}_CLIP1_REACTION\\s*===[\\s\\S]*?)(===\\s*${p}_CLIP2_SETUP\\s*===[\\s\\S]*?)(===\\s*${p}_CLIP2_REACTION\\s*===[\\s\\S]*?)(?=\\n===|$)`,
    'i'
  );

  const m = script.match(blockRe);
  if (!m) return script;

  const [, s1Setup, s1Rx, s2Setup, s2Rx] = m;
  const extractBody = (block) => block.replace(/^===\s*[A-Z0-9_]+\s*===\s*/i, '').trim();

  const b1Setup = extractBody(s1Setup);
  const b1Rx = extractBody(s1Rx);
  const b2Setup = extractBody(s2Setup);
  const b2Rx = extractBody(s2Rx);

  const rebuilt =
    `=== ${p}_CLIP1_SETUP ===\n${b2Setup}\n\n` +
    `=== ${p}_CLIP1_REACTION ===\n${b2Rx}\n\n` +
    `=== ${p}_CLIP2_SETUP ===\n${b1Setup}\n\n` +
    `=== ${p}_CLIP2_REACTION ===\n${b1Rx}\n\n`;

  return script.replace(blockRe, rebuilt);
}

function swapStreamerClipPairOnCard(card, streamerKey) {
  const cps = card.clipsPerStreamer || 2;
  const lineup = swapStreamerClipPairInLineup(card.orderedClipUrls || [], streamerKey, cps);
  if (!lineup.swapped) return { ok: false, ...lineup };

  let script = card.script?.raw || card.script?.fullScript || '';
  const prefix = String(streamerKey).toUpperCase().replace(/[^A-Z0-9]/g, '');
  script = swapScriptClipScenes(script, prefix);

  card.orderedClipUrls = lineup.orderedClipUrls;
  if (card.script) {
    card.script.raw = script;
    if (Array.isArray(card.script.scenes)) {
      for (const sc of card.script.scenes) {
        if (!sc.name) continue;
        const n = sc.name.toUpperCase();
        if (n === `${prefix}_CLIP1_SETUP`) sc.text = extractScene(script, sc.name);
        if (n === `${prefix}_CLIP1_REACTION`) sc.text = extractScene(script, sc.name);
        if (n === `${prefix}_CLIP2_SETUP`) sc.text = extractScene(script, sc.name);
        if (n === `${prefix}_CLIP2_REACTION`) sc.text = extractScene(script, sc.name);
      }
    }
  }
  card.clipPairSwapped = card.clipPairSwapped || [];
  card.clipPairSwapped.push({ streamer: streamerKey, at: new Date().toISOString() });
  return { ok: true, indices: lineup.indices };
}

function extractScene(script, sceneName) {
  const re = new RegExp(`===\\s*${sceneName}\\s*===\\s*([\\s\\S]*?)(?=\\n===|$)`, 'i');
  const m = script.match(re);
  return m ? m[1].trim() : '';
}

module.exports = {
  swapStreamerClipPairInLineup,
  swapScriptClipScenes,
  swapStreamerClipPairOnCard,
};
