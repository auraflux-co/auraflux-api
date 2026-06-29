'use strict';

/**
 * Merge streamer INTRO + CLIP1_SETUP into one HeyGen render (eliminates 009 flash).
 * Clip still inserts after the merged segment via hasClipInsert on INTRO.
 */

function isStreamerIntroName(name) {
  return /_INTRO$/i.test(String(name || '')) && !/^INTRO$/i.test(String(name || ''));
}

function isClip1SetupName(name) {
  return /_CLIP1_SETUP$/i.test(String(name || ''));
}

/**
 * @param {Array<{name,text,type,hasClipInsert?}>} scenes
 * @returns {Array} scenes with CLIP1_SETUP absorbed into preceding INTRO
 */
function mergeIntroClip1SetupScenes(scenes, { contentType } = {}) {
  if (!String(contentType || '').includes('twitch') || !Array.isArray(scenes)) return scenes;

  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const next = scenes[i + 1];

    if (
      scene.type === 'avatar'
      && isStreamerIntroName(scene.name)
      && next
      && next.type === 'avatar'
      && isClip1SetupName(next.name)
    ) {
      const mergedText = [scene.text, next.text].filter(Boolean).join('\n[beat]\n');
      out.push({
        ...scene,
        text: mergedText,
        hasClipInsert: true,
        introClip1Merged: true,
        mergedFrom: [scene.name, next.name],
      });
      i += 1;
      continue;
    }

    out.push(scene);
  }
  return out;
}

function isClip2SetupName(name) {
  return /_CLIP2_SETUP$/i.test(String(name || ''));
}

function isClip1ReactionName(name) {
  return /_CLIP1_REACTION$/i.test(String(name || ''));
}

/**
 * Merge CLIP1_REACTION + CLIP2_SETUP into one HeyGen render (eliminates 055 flash).
 * Studio laugh stays between reaction line and clip2 setup copy; clip2 inserts after merged segment.
 */
function mergeReactionClip2SetupScenes(scenes, { contentType } = {}) {
  if (!String(contentType || '').includes('twitch') || !Array.isArray(scenes)) return scenes;

  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const next = scenes[i + 1];

    if (
      scene.type === 'avatar'
      && isClip1ReactionName(scene.name)
      && next
      && next.type === 'avatar'
      && isClip2SetupName(next.name)
    ) {
      const mergedText = [scene.text, next.text].filter(Boolean).join('\n');
      out.push({
        ...scene,
        text: mergedText,
        hasClipInsert: true,
        reactionClip2Merged: true,
        mergedFrom: [scene.name, next.name],
      });
      i += 1;
      continue;
    }

    out.push(scene);
  }
  return out;
}

/**
 * Apply all streamer-block HeyGen merges (009 + 055 join elimination).
 */
function mergeStreamerBlockHeyGenScenes(scenes, opts = {}) {
  let s = mergeIntroClip1SetupScenes(scenes, opts);
  s = mergeReactionClip2SetupScenes(s, opts);
  return s;
}

function mergedIntroClip1Summary(scenes) {
  return (scenes || [])
    .filter((s) => s.introClip1Merged)
    .map((s) => ({ intro: s.name, clipsFrom: s.mergedFrom?.[1], chars: s.text?.length }));
}

module.exports = {
  isStreamerIntroName,
  isClip1SetupName,
  isClip1ReactionName,
  isClip2SetupName,
  mergeIntroClip1SetupScenes,
  mergeReactionClip2SetupScenes,
  mergeStreamerBlockHeyGenScenes,
  mergedIntroClip1Summary,
};
