'use strict';
/**
 * lib/clip_comp_creative.js — Clip comp creative presets + schema (CPD-1088 Phase 1)
 *
 * Phase 1: schema + preset merge + UI labels. FFmpeg/publish wiring in later phases.
 */

const PRESET_VERSION = 1;

const PRESET_DEFAULTS = {
  classic_blur_pad: {
    preset: 'classic_blur_pad',
    layout: { mode: 'blur_pad', logo: 'top_blur_fold' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'phrase_bottom_blur' },
    audio: { clipAudio: true, musicBed: 'off', musicBedVolume: 0.18, cutSfx: 'off', duckSpeech: true },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  full_bleed: {
    preset: 'full_bleed',
    layout: { mode: 'full_bleed_crop', logo: 'corner' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'phrase_full_bleed' },
    audio: { clipAudio: true, musicBed: 'off', musicBedVolume: 0.18, cutSfx: 'off', duckSpeech: true },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  serpent_ranked: {
    preset: 'serpent_ranked',
    layout: { mode: 'full_bleed_crop', logo: 'off' },
    hooks: { mode: 'both', rankedList: { enabled: true, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'phrase_full_bleed' },
    audio: { clipAudio: true, musicBed: 'low_trap', musicBedVolume: 0.18, cutSfx: 'serpent_pack', duckSpeech: true },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  dahbluh_clean: {
    preset: 'dahbluh_clean',
    layout: { mode: 'full_bleed_crop', logo: 'off' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'word_karaoke' },
    audio: { clipAudio: true, musicBed: 'off', musicBedVolume: 0.18, cutSfx: 'off', duckSpeech: true },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  twitch_comp_vod: {
    preset: 'twitch_comp_vod',
    layout: { mode: 'full_bleed_crop', logo: 'corner' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'phrase_full_bleed' },
    audio: { clipAudio: true, musicBed: 'low_trap', musicBedVolume: 0.16, cutSfx: 'whoosh', duckSpeech: true },
    editorial: { enabled: true, introCard: true, ttsBridges: true },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'vod_comp', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
};

const PRESET_LABELS = {
  classic_blur_pad: 'Classic ClipzWorld (blur-pad)',
  full_bleed: 'Full bleed (imgoochy / core_fx)',
  serpent_ranked: 'Ranked list Short (Stream Serpent)',
  dahbluh_clean: 'Clean comp (DahBluh Short)',
  twitch_comp_vod: 'Comp VOD 8–20 min (Phase 4)',
  custom: 'Custom (advanced)',
};

const VALID_PRESETS = new Set([...Object.keys(PRESET_DEFAULTS), 'custom']);

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resolve compCreative from preset name and/or partial overrides.
 * @param {{ preset?: string, overrides?: object, streamerHint?: string }} opts
 */
function mergeCompCreative(opts = {}) {
  const presetKey = VALID_PRESETS.has(opts.preset) ? opts.preset : 'classic_blur_pad';
  const base = presetKey === 'custom'
    ? deepMerge(PRESET_DEFAULTS.classic_blur_pad, { preset: 'custom' })
    : JSON.parse(JSON.stringify(PRESET_DEFAULTS[presetKey] || PRESET_DEFAULTS.classic_blur_pad));

  const merged = deepMerge(base, opts.overrides || {});
  merged.presetVersion = PRESET_VERSION;

  if (opts.streamerHint && merged.hooks?.rankedList && !merged.hooks.rankedList.streamer) {
    merged.hooks.rankedList.streamer = String(opts.streamerHint).trim();
  }

  return merged;
}

/** Human-readable chips for queue UI + status lines. */
function compCreativeChips(compCreative) {
  const c = compCreative || PRESET_DEFAULTS.classic_blur_pad;
  const chips = [];
  chips.push(PRESET_LABELS[c.preset] || c.preset || 'classic');
  if (c.layout?.mode === 'full_bleed_crop') chips.push('full bleed');
  else chips.push('blur-pad');
  if (c.hooks?.rankedList?.enabled) chips.push('ranked list');
  if (c.hooks?.mode !== 'whisper_only') chips.push('hooks');
  if (c.captions?.whisper !== false) chips.push('whisper');
  if (c.audio?.musicBed && c.audio.musicBed !== 'off') chips.push('bed');
  if (c.audio?.cutSfx && c.audio.cutSfx !== 'off') chips.push('SFX');
  if (c.delivery?.format === 'vod_comp') chips.push('VOD comp');
  else chips.push('short');
  return chips;
}

function compCreativeStatusLine(compCreative, clipCount) {
  const c = compCreative || {};
  const preset = PRESET_LABELS[c.preset] || c.preset || 'Classic';
  const n = clipCount != null ? clipCount : '?';
  return 'Creative: ' + preset + ' · ' + n + ' clip(s) · ' + compCreativeChips(c).join(' · ');
}

/** Phase 1: which flags assembly should honor (future phases read same object). */
function compCreativeAssemblyFlags(compCreative) {
  const c = compCreative || PRESET_DEFAULTS.classic_blur_pad;
  return {
    layoutMode: c.layout?.mode || 'blur_pad',
    logo: c.layout?.logo || 'top_blur_fold',
    rankedListEnabled: !!c.hooks?.rankedList?.enabled,
    musicBed: c.audio?.musicBed || 'off',
    cutSfx: c.audio?.cutSfx || 'off',
    deliveryFormat: c.delivery?.format || 'short',
    editorialEnabled: !!c.editorial?.enabled,
    captionStyle: c.captions?.style || 'phrase_bottom_blur',
    gagOverlays: !!c.effects?.gagOverlays,
    phase1SchemaOnly: false,
  };
}

function resolveCompCreativeFromContext({ body = {}, designSpec = null, jobCard = null } = {}) {
  return mergeCompCreative({
    preset: body.compCreativePreset || body.compCreative?.preset || designSpec?.compCreative?.preset || jobCard?.compCreativePreset,
    overrides: body.compCreative || designSpec?.compCreative || jobCard?.compCreative,
    streamerHint: jobCard?.streamers?.[0] || body.streamers?.[0] || body.compCreative?.hooks?.rankedList?.streamer,
  });
}

module.exports = {
  PRESET_VERSION,
  PRESET_DEFAULTS,
  PRESET_LABELS,
  VALID_PRESETS,
  mergeCompCreative,
  compCreativeChips,
  compCreativeStatusLine,
  compCreativeAssemblyFlags,
  resolveCompCreativeFromContext,
};
