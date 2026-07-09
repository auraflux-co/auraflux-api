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
    layout: { mode: 'full_bleed_crop', logo: 'corner', logoCorner: 'top_right' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'phrase_full_bleed' },
    audio: { clipAudio: true, musicBed: 'off', musicBedVolume: 0.18, cutSfx: 'off', duckSpeech: true },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  serpent_ranked: {
    preset: 'serpent_ranked',
    layout: { mode: 'full_bleed_crop', logo: 'corner', logoCorner: 'bottom_right' },
    hooks: { mode: 'hook_only', rankedList: { enabled: true, streamer: '', theme: 'MOMENTS', slotCount: 5, titlePattern: 'SAVED_BEST_FOR_LAST' } },
    captions: { whisper: false, style: 'phrase_full_bleed' },
    audio: { clipAudio: true, musicBed: 'low_trap', musicBedVolume: 0.012, bedMixWeight: 0.12, bedPerSegment: true, cutSfx: 'serpent_pack', duckSpeech: false },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  serpent_ranked_vod: {
    preset: 'serpent_ranked_vod',
    layout: { mode: 'full_bleed_crop', logo: 'corner', logoCorner: 'bottom_right' },
    hooks: { mode: 'hook_only', rankedList: { enabled: true, streamer: '', theme: 'MOMENTS', slotCount: 10, titlePattern: 'SAVED_BEST_FOR_LAST' } },
    captions: { whisper: false, style: 'phrase_full_bleed' },
    audio: { clipAudio: true, musicBed: 'low_trap', musicBedVolume: 0.012, bedMixWeight: 0.12, bedPerSegment: true, cutSfx: 'serpent_pack', duckSpeech: false },
    editorial: { enabled: true, introCard: true, ttsBridges: true },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'vod_comp', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  dahbluh_clean: {
    preset: 'dahbluh_clean',
    layout: { mode: 'full_bleed_crop', logo: 'corner', logoCorner: 'top_right' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'word_karaoke' },
    audio: { clipAudio: true, musicBed: 'off', musicBedVolume: 0.18, cutSfx: 'off', duckSpeech: true },
    editorial: { enabled: false, introCard: false, ttsBridges: false },
    effects: { transform: false, gagOverlays: false },
    delivery: { format: 'short', vodTargetMin: 8, vodTargetMax: 20, relatedVideoParentId: null, playlistSeries: null },
  },
  facecam_split: {
    preset: 'facecam_split',
    layout: { mode: 'split_screen', logo: 'corner', logoCorner: 'top_right' },
    hooks: { mode: 'both', rankedList: { enabled: false, streamer: '', theme: 'FUNNIEST', slotCount: 5, titlePattern: 'WAIT_FOR_NO_1' } },
    captions: { whisper: true, style: 'phrase_full_bleed' },
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
  serpent_ranked_vod: 'Ranked list VOD — Top 10 (Stream Serpent)',
  dahbluh_clean: 'Clean comp (DahBluh Short)',
  facecam_split: 'Facecam split (cam top / content bottom)',
  twitch_comp_vod: 'Comp VOD 8–20 min (edited comp)',
  custom: 'Custom (advanced)',
};

/**
 * Operator-facing creative catalog — code, clip rules, buttons, features.
 * Single source for GET /clip-comp/creative-catalog + dashboard labels.
 */
const COMP_CREATIVE_CATALOG = {
  classic_blur_pad: {
    code: 'C1',
    name: 'Classic ClipzWorld',
    tagline: 'Blur-pad portrait · ClipzWorld TV style',
    buttons: ['Short', 'Comp'],
    shortClips: '1 clip → 1 Short job each',
    compClips: 'Exactly 4 in lineup',
    compVodClips: null,
    whisper: true,
    hooks: 'Burned hooks + Whisper',
    layout: 'Blur-pad + logo in top fold',
    audio: 'Clip audio only',
    outcome: '4-clip streamer comp OR solo blur-pad Shorts',
  },
  full_bleed: {
    code: 'C2',
    name: 'Full Bleed',
    tagline: 'imgoochy / core_fx single-clip Shorts',
    buttons: ['Short', 'Comp'],
    shortClips: '1 clip → 1 Short (primary use)',
    compClips: 'Exactly 4 in lineup',
    compVodClips: null,
    whisper: true,
    hooks: 'Burned hooks mid-frame + Whisper',
    layout: 'Full-bleed crop · logo top-right · 16:9 auto-splits in assembly',
    audio: 'Clip audio only',
    outcome: 'Portrait-native = full bleed · landscape Twitch = cam top + full action bottom (auto)',
  },
  serpent_ranked: {
    code: 'C3',
    name: 'Serpent Ranked Short',
    tagline: 'Stream Serpent Top 5 countdown',
    buttons: ['Comp'],
    shortClips: 'Not allowed — use C2 Full Bleed for 1-clip Shorts',
    compClips: '5 ideal (2–8) · lineup sets countdown',
    compVodClips: null,
    whisper: false,
    hooks: 'Burned hooks only',
    layout: 'Ranked header + countdown column · full bleed',
    audio: 'Low trap bed + serpent cut SFX',
    outcome: 'One ranked countdown Short — clip #1 = highest rank in play',
  },
  serpent_ranked_vod: {
    code: 'C4',
    name: 'Serpent Ranked VOD',
    tagline: 'Top 10 long-form ranked edit',
    buttons: ['Comp VOD', 'Short'],
    shortClips: 'Optional 1-clip teaser Shorts',
    compClips: 'Not allowed — use Comp VOD',
    compVodClips: '8–10 clips · 8+ min footage',
    whisper: false,
    hooks: 'Burned hooks only',
    layout: 'Top 10 ranked chrome + editorial intro/bridges',
    audio: 'Low trap bed + serpent cut SFX',
    outcome: 'Long ranked VOD Top 10 → #1',
  },
  dahbluh_clean: {
    code: 'C5',
    name: 'DahBluh Clean',
    tagline: 'Full bleed + word-karaoke Whisper (same logo as C2)',
    buttons: ['Short', 'Comp'],
    shortClips: '1 clip → 1 Short each',
    compClips: 'Exactly 4 in lineup',
    compVodClips: null,
    whisper: true,
    hooks: 'Burned hooks + Whisper word-karaoke',
    layout: 'Full bleed · logo top-right (same as C2)',
    audio: 'Clip audio only',
    outcome: 'Same as C2 except Whisper renders word-by-word karaoke instead of phrase captions',
  },
  facecam_split: {
    code: 'C8',
    name: 'Facecam Split',
    tagline: 'Cam pane top · screen content bottom — desktop-capture clips',
    buttons: ['Short', 'Comp'],
    shortClips: '1 clip → 1 Short (desktop/stream-UI sources)',
    compClips: 'Exactly 4 in lineup',
    compVodClips: null,
    whisper: true,
    hooks: 'Burned hooks at pane seam + Whisper',
    layout: 'Facecam top pane · full-bleed content bottom pane · logo top-right',
    audio: 'Clip audio only',
    outcome: 'Streamer-split Short — reaction cam and screen content both visible in real time. Falls back to blur-pad when no facecam is detected.',
  },
  twitch_comp_vod: {
    code: 'C6',
    name: 'Comp VOD Edited',
    tagline: '8–20 min non-ranked long comp',
    buttons: ['Comp VOD', 'Short'],
    shortClips: 'Optional teaser Shorts',
    compClips: 'Not allowed — use Comp VOD',
    compVodClips: '4–8 clips · 8+ min footage',
    whisper: true,
    hooks: 'Burned hooks + Whisper',
    layout: 'Full bleed + corner logo · intro + TTS bridges',
    audio: 'Low trap bed + whoosh SFX',
    outcome: 'Edited long comp (not ranked countdown)',
  },
  custom: {
    code: 'C7',
    name: 'Custom Advanced',
    tagline: 'Manual overrides — operator responsibility',
    buttons: ['Short', 'Comp', 'Comp VOD'],
    shortClips: '1+ via Short button',
    compClips: '4–10 via Comp',
    compVodClips: 'Per delivery override',
    whisper: 'User picker',
    hooks: 'User picker',
    layout: 'Inherits C1 unless overridden',
    audio: 'User picker',
    outcome: 'Whatever you configure in advanced fields',
  },
};

function getCompCreativeCatalogEntry(preset) {
  const key = VALID_PRESETS.has(preset) ? preset : 'classic_blur_pad';
  const entry = COMP_CREATIVE_CATALOG[key] || COMP_CREATIVE_CATALOG.classic_blur_pad;
  return { id: key, ...entry, selectLabel: formatCompCreativeSelectLabel(key) };
}

function formatCompCreativeSelectLabel(preset) {
  const e = COMP_CREATIVE_CATALOG[preset];
  if (!e) return PRESET_LABELS[preset] || preset;
  const btn = e.buttons.join(' + ');
  const clips = e.compVodClips
    ? ('Comp VOD: ' + e.compVodClips)
    : ('Short: ' + (e.shortClips.split(' ')[0] === 'Not' ? '—' : '1') + ' · Comp: ' + (e.compClips || '').replace('Exactly ', '').replace(' in lineup', ''));
  return e.code + ' · ' + e.name + ' · ' + btn + ' · ' + clips;
}

function formatCompCreativeSummary(preset) {
  const e = getCompCreativeCatalogEntry(preset);
  const lines = [
    e.code + ' · ' + e.name.toUpperCase(),
    e.tagline,
    'Buttons: ' + e.buttons.join(', ') + ' · Short: ' + e.shortClips + ' · Comp: ' + (e.compClips || '—') + (e.compVodClips ? (' · Comp VOD: ' + e.compVodClips) : ''),
    e.layout + ' · ' + e.hooks + (e.whisper === true ? ' · Whisper on' : e.whisper === false ? ' · Whisper off' : '') + ' · ' + e.audio,
    'Outcome: ' + e.outcome,
  ];
  return lines.join('\n');
}

function getCompCreativeCatalogList() {
  return Object.keys(COMP_CREATIVE_CATALOG).map((id) => getCompCreativeCatalogEntry(id));
}

const VALID_PRESETS = new Set([...Object.keys(PRESET_DEFAULTS), 'custom']);

/** Lineup targets per preset (UI + validation). Durations exclude editorial intro/bridges. */
const COMP_LINEUP_TARGETS = {
  classic_blur_pad: { lineupSlots: 4, minClips: 2, maxClips: 4, minDurationSec: 0, maxDurationSec: 180 },
  full_bleed: { lineupSlots: 4, minClips: 2, maxClips: 4, minDurationSec: 0, maxDurationSec: 180 },
  dahbluh_clean: { lineupSlots: 4, minClips: 2, maxClips: 4, minDurationSec: 0, maxDurationSec: 180 },
  facecam_split: { lineupSlots: 4, minClips: 2, maxClips: 4, minDurationSec: 0, maxDurationSec: 180 },
  serpent_ranked: { lineupSlots: 5, minClips: 2, maxClips: 8, minDurationSec: 0, maxDurationSec: 180 },
  serpent_ranked_vod: { lineupSlots: 10, minClips: 8, maxClips: 12, minDurationSec: 480, maxDurationSec: 1200 },
  twitch_comp_vod: { lineupSlots: 8, minClips: 4, maxClips: 12, minDurationSec: 480, maxDurationSec: 1200 },
  custom: { lineupSlots: 4, minClips: 2, maxClips: 10, minDurationSec: 0, maxDurationSec: 1200 },
};

function getCompLineupTarget(preset) {
  const key = VALID_PRESETS.has(preset) ? preset : 'classic_blur_pad';
  return COMP_LINEUP_TARGETS[key] || COMP_LINEUP_TARGETS.classic_blur_pad;
}

function rankedListSlotCap(compCreative) {
  const preset = compCreative?.preset;
  if (preset === 'serpent_ranked_vod') return 12;
  if (compCreative?.delivery?.format === 'vod_comp' && compCreative?.hooks?.rankedList?.enabled) return 12;
  return 8;
}

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
  else if (c.layout?.mode === 'split_screen') chips.push('facecam split');
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

/** Rank overlay slot count follows lineup size; Short ranked ≤8, VOD ranked ≤12. */
function syncRankedListToClipCount(compCreative, clipCount) {
  if (!compCreative?.hooks?.rankedList?.enabled) return compCreative;
  const n = Number(clipCount);
  if (!Number.isFinite(n) || n < 1) return compCreative;
  const merged = JSON.parse(JSON.stringify(compCreative));
  const cap = rankedListSlotCap(merged);
  merged.hooks.rankedList.slotCount = Math.max(2, Math.min(cap, Math.floor(n)));
  return merged;
}

function rankedListClipGuidance(compCreative) {
  if (!compCreative?.hooks?.rankedList?.enabled) return null;
  if (compCreative.preset === 'serpent_ranked_vod') {
    return 'Ranked VOD — pick 8–10 clips (~8–20 min total). Use Comp VOD button. Countdown matches lineup (Top 10).';
  }
  return 'Ranked Short — pick 5 clips for classic Top 5 countdown, then Comp. Lineup size sets the list.';
}

/**
 * Validate raw clip durations for VOD-ranked targets (client + server).
 * @param {object} compCreative
 * @param {number[]} durationsSec
 */
function validateCompLineupDuration(compCreative, durationsSec = []) {
  const target = getCompLineupTarget(compCreative?.preset || 'classic_blur_pad');
  const nums = durationsSec.map(Number).filter((d) => Number.isFinite(d) && d > 0);
  const totalSec = nums.reduce((a, b) => a + b, 0);
  if (!target.minDurationSec) return { ok: true, totalSec, knownClips: nums.length };
  if (!nums.length) {
    return { ok: true, totalSec: 0, knownClips: 0, skipped: true };
  }
  if (totalSec < target.minDurationSec) {
    return {
      ok: false,
      totalSec,
      minSec: target.minDurationSec,
      message: `Lineup ~${Math.round(totalSec / 60)}m — need ~${target.minDurationSec / 60}+ min of clip footage`,
    };
  }
  if (target.maxDurationSec && totalSec > target.maxDurationSec) {
    return {
      ok: false,
      tooLong: true,
      totalSec,
      maxSec: target.maxDurationSec,
      message: `Lineup ~${Math.round(totalSec / 60)}m exceeds ${target.maxDurationSec / 60} min VOD target — trim or drop clips`,
    };
  }
  return { ok: true, totalSec, knownClips: nums.length };
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

/**
 * Gate 3a chrome expectations for clip-comp jobs — derived from compCreative preset.
 */
function compCreativeGate3Expectations(compCreative) {
  const c = compCreative || PRESET_DEFAULTS.classic_blur_pad;
  const ranked = !!(c.hooks?.rankedList?.enabled);
  const layoutMode = c.layout?.mode || 'blur_pad';
  const logoMode = c.layout?.logo || 'top_blur_fold';
  const logoCorner = c.layout?.logoCorner || 'bottom_right';
  const hasLogo = logoMode !== 'off';
  const fullBleed = layoutMode === 'full_bleed_crop';
  const splitScreen = layoutMode === 'split_screen';

  const rankedOverlay = ranked
    ? {
      enabled: true,
      streamer: String(c.hooks?.rankedList?.streamer || '').trim(),
      theme: c.hooks?.rankedList?.theme || 'MOMENTS',
      slotCount: Math.max(2, Number(c.hooks?.rankedList?.slotCount) || 5),
    }
    : null;

  return {
    hasTopBar: false,
    hasFlag: false,
    hasSidebar: false,
    hasTicker: false,
    hasLogo,
    logoPosition: logoMode === 'off'
      ? 'off'
      : (logoMode === 'corner' || fullBleed || splitScreen)
        ? (logoCorner === 'top_right' ? 'top-right' : 'bottom-right')
        : 'top-blur-fold',
    logoSize: logoMode === 'corner' ? 80 : 220,
    clipCompLayoutMode: layoutMode,
    rankedOverlay,
    hooksEnabled: c.hooks?.mode !== 'whisper_only',
    preset: c.preset || 'classic_blur_pad',
    formatDescription: ranked
      ? `Stream Serpent ranked clip comp — full-bleed portrait, header + countdown column (Top ${rankedOverlay.slotCount}), burned hooks mid-frame, CWN logo ${logoCorner === 'top_right' ? 'top-right' : 'bottom-right'}, NO broadcast chrome.`
      : splitScreen
        ? 'Facecam split portrait clip comp — cam pane top, full-bleed content pane bottom, hook at the seam, logo per preset, NO broadcast chrome.'
        : fullBleed
          ? 'Full-bleed portrait clip comp — source fills frame, logo per preset, NO broadcast chrome.'
          : 'Blur-pad portrait clip comp — sharp clip + blurred bands, logo in top blur fold when enabled, NO broadcast chrome.',
  };
}

function isLandscapeClipOrientation(orientation) {
  const o = String(orientation || 'landscape').toLowerCase();
  return o !== 'portrait' && o !== '9:16' && o !== 'vertical';
}

/** Preset default layout mode (matches dashboard presetLayoutModeForCompose). */
function resolvePresetLayoutMode(preset) {
  const p = String(preset || 'classic_blur_pad');
  if (p === 'facecam_split') return 'split_screen';
  if (p === 'full_bleed' || p.includes('serpent') || p === 'dahbluh_clean' || p === 'twitch_comp_vod') {
    return 'full_bleed_crop';
  }
  return 'blur_pad';
}

/**
 * Lock compCreative for assembly — explicit landscape split flag, no leaked split crops
 * on single-view jobs. Compose validate + EXECUTE must both pass through this.
 */
function finalizeCompCreativeForAssembly(compCreative, {
  clipOrientations = [],
  operatorLocked = false,
} = {}) {
  const merged = JSON.parse(JSON.stringify(compCreative || PRESET_DEFAULTS.classic_blur_pad));
  merged.layout = merged.layout || {};
  const hasLandscape = clipOrientations.length
    ? clipOrientations.some(isLandscapeClipOrientation)
    : true;

  if (hasLandscape) {
    const singleView = merged.layout.landscapeSplit === false;
    if (singleView) {
      merged.layout.landscapeSplit = false;
      delete merged.layout.facecamRect;
      delete merged.layout.bottomPaneRect;
      delete merged.layout.bottomPaneMode;
      delete merged.layout.topPaneSubject;
      delete merged.layout.topHeight;
      delete merged.layout.contentCx;
      const cx = Number(merged.layout.cropCx);
      const cy = Number(merged.layout.cropCy);
      if (Number.isFinite(cx)) merged.layout.cropCx = Math.max(0, Math.min(1, cx));
      else delete merged.layout.cropCx;
      if (Number.isFinite(cy)) merged.layout.cropCy = Math.max(0, Math.min(1, cy));
      else delete merged.layout.cropCy;
      if (merged.layout.mode === 'split_screen') {
        merged.layout.mode = resolvePresetLayoutMode(merged.preset);
      }
    } else {
      merged.layout.landscapeSplit = true;
      if (merged.layout.facecamRect || merged.layout.mode === 'split_screen') {
        merged.layout.mode = 'split_screen';
      }
    }
  }

  if (operatorLocked) merged.operatorLocked = true;
  merged.presetVersion = PRESET_VERSION;
  return merged;
}

/** Strip preset keys for generate-clip-comp overrides body. */
function stripPresetFromOverrides(merged) {
  if (!merged) return undefined;
  const { preset, presetVersion, ...rest } = merged;
  return rest;
}

function resolveCompCreativeFromContext({ body = {}, designSpec = null, jobCard = null } = {}) {
  // Job card compCreative is operator intent — stale designSpec from an old reassemble must not win.
  const cardCreative = jobCard?.compCreative || null;
  const cardPreset = jobCard?.compCreativePreset || cardCreative?.preset || null;
  const preset = body.compCreativePreset
    || body.compCreative?.preset
    || cardPreset
    || designSpec?.compCreative?.preset;
  const merged = mergeCompCreative({
    preset,
    overrides: body.compCreative || cardCreative || designSpec?.compCreative,
    streamerHint: jobCard?.streamers?.[0] || body.streamers?.[0] || body.compCreative?.hooks?.rankedList?.streamer,
  });
  // Ranked presets: bed volume comes from PRESET_DEFAULTS, not stale card fields.
  if (['serpent_ranked', 'serpent_ranked_vod'].includes(merged.preset)) {
    const presetAudio = PRESET_DEFAULTS[merged.preset]?.audio;
    if (presetAudio?.musicBedVolume != null) merged.audio.musicBedVolume = presetAudio.musicBedVolume;
    if (presetAudio?.bedMixWeight != null) merged.audio.bedMixWeight = presetAudio.bedMixWeight;
    if (presetAudio?.bedPerSegment != null) merged.audio.bedPerSegment = presetAudio.bedPerSegment;
    if (presetAudio?.duckSpeech === false) merged.audio.duckSpeech = false;
  } else if (body.compCreative?.audio?.musicBedVolume == null && VALID_PRESETS.has(merged.preset)) {
    const presetVol = PRESET_DEFAULTS[merged.preset]?.audio?.musicBedVolume;
    if (presetVol != null) merged.audio.musicBedVolume = presetVol;
  }
  const clipOrientations = jobCard?.orderedClipUrls?.map((c) => c.orientation)
    || body.orderedClipUrls?.map((c) => c.orientation)
    || [];
  return finalizeCompCreativeForAssembly(merged, {
    clipOrientations,
    operatorLocked: !!jobCard?.compCreative?.operatorLocked,
  });
}

const CAPTION_STYLE_OPTIONS = [
  { id: 'phrase_bottom_blur', label: 'Phrase · bottom blur fold' },
  { id: 'phrase_full_bleed', label: 'Phrase · full bleed safe zone' },
  { id: 'word_karaoke', label: 'Word karaoke (ASS)' },
];

module.exports = {
  CAPTION_STYLE_OPTIONS,
  PRESET_VERSION,
  PRESET_DEFAULTS,
  PRESET_LABELS,
  COMP_CREATIVE_CATALOG,
  VALID_PRESETS,
  COMP_LINEUP_TARGETS,
  mergeCompCreative,
  deepMergeCompCreative: deepMerge,
  compCreativeChips,
  compCreativeStatusLine,
  getCompLineupTarget,
  getCompCreativeCatalogEntry,
  getCompCreativeCatalogList,
  formatCompCreativeSelectLabel,
  formatCompCreativeSummary,
  rankedListSlotCap,
  syncRankedListToClipCount,
  rankedListClipGuidance,
  validateCompLineupDuration,
  compCreativeAssemblyFlags,
  compCreativeGate3Expectations,
  resolveCompCreativeFromContext,
  isLandscapeClipOrientation,
  resolvePresetLayoutMode,
  finalizeCompCreativeForAssembly,
  stripPresetFromOverrides,
};
