'use strict';
/**
 * lib/clip_comp_transform.js — transformative ffmpeg stack for clip comps
 *
 * Clip comps are silent (no avatar / no HeyGen). To distinguish re-edited
 * compilations from raw rebroadcasts we apply a consistent visual + audio
 * treatment: show color grade, vignette, light grain, sharpen, @handle badge,
 * speech ducking. Whisper captions run in assembly_postprocess after this pass.
 */

const { buildVideoFilterChain, buildAudioFilterChain } = require('./assembly_effects');
const { resolveClipCompVoiceKey } = require('./clip_comp');

/** Synthetic jobSpec fragment for assembly_effects — always-on for clip comps. */
function buildClipCompEffectsSpec(contentType = 'twitch-short', designSpec = {}) {
  const voiceKey = resolveClipCompVoiceKey(contentType);
  const autoPreset = voiceKey === 'sports' ? 'vivid' : voiceKey === 'news' ? 'cool' : 'crisp';
  const showHandle = process.env.UPLOADPOST_PROFILE
    ? `@${String(process.env.UPLOADPOST_PROFILE).replace(/^@/, '')}`
    : '@clipzworldnews';

  // CPD-1283: operator CapCut-style look (Compose tint) overrides auto show grade.
  const lookName = designSpec?.compCreative?.look?.preset
    || designSpec?.lookPreset
    || 'auto';
  const { applyLookToEffectsSpec } = require('./look_presets');
  let spec = {
    colorGrade: { preset: autoPreset },
    effects: {
      color: {
        vignette: true,
        film_grain: true,
        sharpen: true,
        filmGrainStrength: parseInt(process.env.CLIP_COMP_GRAIN_STRENGTH || '7', 10),
      },
      overlay: {
        socialHandle: showHandle,
        badgeFontSize: 32,
        badgeX: '36',
        badgeY: 'h-200',
      },
      audio: { duck: true },
    },
    addOns: {
      color: { vignette: true, film_grain: true },
    },
    audioOpts: { duck: true },
    designSpec,
  };
  if (lookName && lookName !== 'auto') {
    spec = applyLookToEffectsSpec(spec, lookName);
  }
  // Timed red impact flashes from Beats→FX / clip meta (Gemini Core_fx gap).
  const impact = designSpec?.compCreative?.look?.impactTint
    || designSpec?.impactTint
    || null;
  if (impact && impact.enabled !== false) {
    spec.effects = spec.effects || {};
    spec.effects.video = { ...(spec.effects.video || {}), impact_tint: impact };
    spec.addOns = { ...(spec.addOns || {}), impact_tint: impact };
  }
  return spec;
}

module.exports = {
  buildClipCompEffectsSpec,
};
