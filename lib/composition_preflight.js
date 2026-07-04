'use strict';

const {
  clipDurationAfterTrim,
  featureManifest,
} = require('./composition_spec');
const { compCreativeAssemblyFlags, getCompLineupTarget } = require('./clip_comp_creative');
const { shouldUseClipCompEditorial } = require('./clip_comp_editorial');

const PORTRAIT_LAYOUT_LABELS = {
  blur_pad: 'Blur-pad portrait (sharp clip + blurred bands)',
  full_bleed_crop: 'Full-bleed portrait (source fills frame)',
  split_screen: 'Facecam split (cam pane top, content pane bottom)',
};

const CAPTION_STYLE_LABELS = {
  phrase_bottom_blur: 'Phrase captions in bottom blur fold',
  word_karaoke: 'Whisper word-karaoke (per-word burn)',
  off: 'Captions off',
};

const HOOK_MODE_LABELS = {
  hook_only: 'Burned hook text only',
  both: 'Burned hooks + whisper captions',
  whisper_only: 'Whisper captions only (no burned hooks)',
};

/** ~3s TTS bridge between clips when editorial timeline is active. */
const EDITORIAL_BRIDGE_SEC_EST = 3;
/** Crossfade overlap when editorial xfade concat runs (news/sports/VOD editorial). */
const EDITORIAL_XFADE_SEC = 0.5;

function formatSecLabel(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function buildClipBreakdown(spec) {
  return (spec.clips || []).map((c, i) => {
    const useSec = clipDurationAfterTrim(c);
    return {
      slot: i + 1,
      streamer: c.displayName || c.streamer || '?',
      title: (c.title || '').slice(0, 80),
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      footageSec: useSec,
      footageLabel: formatSecLabel(useSec),
      hasStagedMp4: !!(c.mp4Url || c.url),
    };
  });
}

function buildAssemblySteps(spec, flags, editorial) {
  const steps = [];
  const cc = spec.compCreative || {};
  const clipCount = (spec.clips || []).length;
  const delivery = spec.deliveryFormat || 'short';

  steps.push({
    phase: 'source',
    label: 'Resolve & trim sources',
    detail: `${clipCount} clip(s) — FFmpeg trim In→Out per your Composer sliders`,
  });

  steps.push({
    phase: 'layout',
    label: 'Portrait layout',
    detail: PORTRAIT_LAYOUT_LABELS[flags.layoutMode] || flags.layoutMode,
  });

  if (flags.rankedListEnabled) {
    const slots = cc.hooks?.rankedList?.slotCount || clipCount;
    steps.push({
      phase: 'overlay',
      label: 'Ranked countdown column',
      detail: `Top ${slots} → #1 overlay on each segment`,
    });
  }

  if (flags.logo && flags.logo !== 'off') {
    steps.push({
      phase: 'overlay',
      label: 'Brand logo',
      detail: flags.logo === 'corner' ? `Logo ${cc.layout?.logoCorner || 'bottom_right'}` : 'Logo in top blur fold',
    });
  }

  const hookMode = cc.hooks?.mode || 'both';
  if (hookMode !== 'whisper_only') {
    steps.push({
      phase: 'burn',
      label: 'Burned hook text',
      detail: `${HOOK_MODE_LABELS[hookMode] || hookMode} — Gemini hook copy per clip unless you override`,
    });
  }

  if (cc.captions?.whisper !== false && hookMode !== 'hook_only') {
    steps.push({
      phase: 'burn',
      label: 'Speech captions',
      detail: CAPTION_STYLE_LABELS[flags.captionStyle] || flags.captionStyle,
    });
  }

  if (flags.gagOverlays) {
    steps.push({ phase: 'overlay', label: 'Gag overlays', detail: 'Preset gag FX on segments' });
  }

  if (flags.musicBed && flags.musicBed !== 'off') {
    steps.push({
      phase: 'audio',
      label: 'Music bed',
      detail: `Bed: ${flags.musicBed} — ducked under speech`,
    });
  }

  if (flags.cutSfx && flags.cutSfx !== 'off') {
    steps.push({ phase: 'audio', label: 'Cut SFX', detail: flags.cutSfx });
  }

  if (editorial) {
    steps.push({
      phase: 'editorial',
      label: 'Editorial bridges',
      detail: 'Intro / TTS bridges between clips / outro — xfade concat (~0.5s overlap)',
    });
  } else if (clipCount > 1) {
    steps.push({
      phase: 'concat',
      label: 'Join clips',
      detail: 'Hard concat (streamer comp) — no crossfade between segments',
    });
  }

  steps.push({
    phase: 'audio',
    label: 'Final audio mix',
    detail: 'Clip audio + bed ducking + loudnorm',
  });

  steps.push({
    phase: 'qa',
    label: 'Gate 3 QA',
    detail: 'Automated assembly QA before publish queue',
  });

  if (delivery === 'vod_comp') {
    steps.unshift({
      phase: 'delivery',
      label: 'Long-form VOD comp',
      detail: `Target ${formatSecLabel(getCompLineupTarget(spec.compCreativePreset).minDurationSec || 480)}+ footage`,
    });
  }

  return steps;
}

/**
 * Production brief shown in Compose before editor sign-off.
 * Lists duration, trims, and every assembly step FFmpeg will run.
 */
function buildProductionPreflight(spec) {
  const cc = spec.compCreative || {};
  const flags = compCreativeAssemblyFlags(cc);
  const features = featureManifest(cc);
  const clips = buildClipBreakdown(spec);
  const footageSec = clips.reduce((n, c) => n + c.footageSec, 0);
  const editorial = shouldUseClipCompEditorial(spec.contentType, cc);
  const clipCount = clips.length;

  let estimatedOutputSec = footageSec;
  let durationNotes = [];

  if (editorial && clipCount > 1) {
    const bridges = Math.max(0, clipCount - 1);
    const bridgeSec = bridges * EDITORIAL_BRIDGE_SEC_EST;
    const xfadeLoss = Math.max(0, clipCount - 1) * EDITORIAL_XFADE_SEC;
    estimatedOutputSec = footageSec + bridgeSec - xfadeLoss;
    durationNotes.push(`Includes ~${bridges} editorial bridge(s) (~${EDITORIAL_BRIDGE_SEC_EST}s each, estimated)`);
    durationNotes.push(`xfade overlap ~${EDITORIAL_XFADE_SEC}s between segments`);
  } else if (clipCount > 1) {
    durationNotes.push('Hard concat — output duration ≈ sum of trimmed clips');
  } else {
    durationNotes.push('Single clip — output duration ≈ trim length');
  }

  if (flags.rankedListEnabled) {
    durationNotes.push('Ranked overlay does not add duration');
  }

  const assemblySteps = buildAssemblySteps(spec, flags, editorial);

  const ffmpegFeatures = [
    { key: 'trim', label: 'Per-clip trim (ss/t)', active: true, controlledInEditor: true },
    { key: 'scale_pad', label: 'Portrait scale + pad / crop', active: true, controlledInEditor: true },
    { key: 'logo_overlay', label: 'Logo overlay filter', active: flags.logo !== 'off', controlledInEditor: true },
    { key: 'ranked_overlay', label: 'Ranked list burn', active: flags.rankedListEnabled, controlledInEditor: true },
    { key: 'hook_burn', label: 'Hook text burn', active: cc.hooks?.mode !== 'whisper_only', controlledInEditor: true },
    { key: 'whisper_captions', label: 'Whisper / karaoke captions', active: cc.captions?.whisper !== false && cc.hooks?.mode !== 'hook_only', controlledInEditor: true },
    { key: 'music_bed', label: 'Music bed mix', active: flags.musicBed !== 'off', controlledInEditor: true },
    { key: 'concat', label: editorial ? 'xfade concat' : 'concat demuxer', active: clipCount > 1, controlledInEditor: false },
    { key: 'loudnorm', label: 'EBU loudnorm', active: true, controlledInEditor: false },
    { key: 'editorial_tts', label: 'Editorial TTS bridges', active: editorial, controlledInEditor: true },
  ];

  return {
    deliveryFormat: spec.deliveryFormat,
    contentType: spec.contentType,
    presetLabel: features.presetLabel,
    preset: spec.compCreativePreset,
    clipCount,
    footageSec,
    footageLabel: formatSecLabel(footageSec),
    estimatedOutputSec: Math.max(1, Math.round(estimatedOutputSec)),
    estimatedOutputLabel: formatSecLabel(estimatedOutputSec),
    durationNotes,
    clips,
    assemblySteps,
    featureChips: features.chips || [],
    ffmpegFeatures,
    editorContract: {
      composeOwns: [
        'Lineup order & lead clip',
        'Per-clip trim In/Out',
        'Creative preset & overrides',
        'Delivery format (Short / Comp / VOD)',
        'Platforms',
      ],
      assemblyOwns: [
        'Source download / resolve',
        'Hook copy generation (when hooks enabled, unless overridden)',
        'Whisper transcription from audio',
        'Final encode CRF / loudnorm',
        'Gate 3 QA & publish queue',
      ],
    },
  };
}

module.exports = {
  buildProductionPreflight,
  formatSecLabel,
};
