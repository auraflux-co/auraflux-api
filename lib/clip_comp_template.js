'use strict';
/**
 * lib/clip_comp_template.js — locked visual template for clip comp shorts
 *
 * Golden reference (2026-06-17, approved publish look):
 *   job: script_twitch-short_1781715314184
 *   r2:  assets.auraflux.co/outputs/script_twitch-short_1781715314184/
 *        1781740375206_clips_comp_extraemily_yonnajay_hasanabi_lacy_script_twitch-short_1781715314184.mp4
 *
 * Template = hooks in sharp zone + small whisper captions in bottom blur + CWN logo top.
 * NO burned @handle, NO transform grade/grain/badge unless CLIP_COMP_EXPERIMENT=1.
 */

const GOLDEN_REFERENCE = {
  jobId: 'script_twitch-short_1781715314184',
  assembledAt: '2026-06-17',
  r2Key: 'outputs/script_twitch-short_1781715314184/1781740375206_clips_comp_extraemily_yonnajay_hasanabi_lacy_script_twitch-short_1781715314184.mp4',
};

/** Experiment mode (grade/vignette/grain/@handle badge). Off by default — publish-safe. */
function clipCompExperimentEnabled() {
  const v = String(process.env.CLIP_COMP_EXPERIMENT || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  // Legacy explicit opt-in to transform-only experiments
  if (String(process.env.CLIP_COMP_TRANSFORM || '').toLowerCase() === 'true') return true;
  return false;
}

/** Whether post-process should run clipCompTransform for this job. */
function shouldApplyClipCompTransform(clipsOnlyComp, designSpec = null) {
  if (!clipsOnlyComp) return false;
  if (clipCompExperimentEnabled()) return true;
  // CPD-1293: Review always burns Punch/look via transform — EXECUTE must match when ordered.
  const look = designSpec?.compCreative?.look?.preset || designSpec?.lookPreset;
  if (look && look !== 'auto') return true;
  if (designSpec?.compCreative?.effects?.transform === true) return true;
  return false;
}

/**
 * libass force_style suffix for whisper captions on clip comps (template mode).
 * Keeps captions in the bottom blur band — hooks stay in the sharp 16:9 zone above.
 */
function clipCompWhisperCaptionStyleSuffix(compCreative = null) {
  if (clipCompExperimentEnabled()) return '';
  const style = compCreative?.captions?.style || '';
  const fullBleed = style === 'phrase_full_bleed'
    || compCreative?.layout?.mode === 'full_bleed_crop';
  const marginV = fullBleed ? (compCreative?.hooks?.rankedList?.enabled ? 140 : 96) : 120;
  return `,Alignment=2,MarginV=${marginV},MarginL=56,MarginR=56,WrapStyle=2`;
}

module.exports = {
  GOLDEN_REFERENCE,
  clipCompExperimentEnabled,
  shouldApplyClipCompTransform,
  clipCompWhisperCaptionStyleSuffix,
};
