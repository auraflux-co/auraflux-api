'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeCompCreative,
  compCreativeChips,
  compCreativeAssemblyFlags,
  PRESET_DEFAULTS,
  VALID_PRESETS,
} = require('../lib/clip_comp_creative');

test('mergeCompCreative defaults to classic_blur_pad', () => {
  const c = mergeCompCreative({});
  assert.equal(c.preset, 'classic_blur_pad');
  assert.equal(c.layout.mode, 'blur_pad');
  assert.equal(c.presetVersion, 1);
});

test('mergeCompCreative applies serpent_ranked preset', () => {
  const c = mergeCompCreative({ preset: 'serpent_ranked', streamerHint: 'xQc' });
  assert.equal(c.preset, 'serpent_ranked');
  assert.equal(c.layout.mode, 'full_bleed_crop');
  assert.equal(c.hooks.rankedList.enabled, true);
  assert.equal(c.hooks.rankedList.streamer, 'xQc');
  assert.equal(c.hooks.mode, 'hook_only');
  assert.equal(c.captions.whisper, false);
  assert.equal(c.audio.musicBed, 'low_trap');
  assert.equal(c.audio.musicBedVolume, 0.012);
  assert.equal(c.audio.bedMixWeight, 0.12);
  assert.equal(c.audio.bedPerSegment, true);
  assert.equal(c.audio.duckSpeech, false);
  assert.equal(c.layout.logo, 'corner');
  assert.equal(c.layout.logoCorner, 'bottom_right');
  assert.equal(c.hooks.rankedList.titlePattern, 'SAVED_BEST_FOR_LAST');
});

test('resolveCompCreativeFromContext ignores stale card musicBedVolume', () => {
  const { resolveCompCreativeFromContext } = require('../lib/clip_comp_creative');
  const c = resolveCompCreativeFromContext({
    jobCard: {
      compCreativePreset: 'serpent_ranked',
      compCreative: { preset: 'serpent_ranked', audio: { musicBedVolume: 0.1 } },
    },
  });
  assert.equal(c.audio.musicBedVolume, 0.012);
  assert.equal(c.audio.bedMixWeight, 0.12);
  assert.equal(c.audio.duckSpeech, false);
});

test('mergeCompCreative applies serpent_ranked_vod preset', () => {
  const c = mergeCompCreative({ preset: 'serpent_ranked_vod', streamerHint: 'Cinna' });
  assert.equal(c.preset, 'serpent_ranked_vod');
  assert.equal(c.delivery.format, 'vod_comp');
  assert.equal(c.hooks.rankedList.enabled, true);
  assert.equal(c.hooks.rankedList.slotCount, 10);
  assert.equal(c.editorial.enabled, true);
  assert.equal(c.editorial.ttsBridges, true);
});

test('syncRankedListToClipCount caps VOD ranked at 12', () => {
  const c = mergeCompCreative({ preset: 'serpent_ranked_vod' });
  const synced = require('../lib/clip_comp_creative').syncRankedListToClipCount(c, 10);
  assert.equal(synced.hooks.rankedList.slotCount, 10);
  const capped = require('../lib/clip_comp_creative').syncRankedListToClipCount(c, 14);
  assert.equal(capped.hooks.rankedList.slotCount, 12);
});

test('validateCompLineupDuration enforces 8+ min for ranked VOD', () => {
  const { validateCompLineupDuration, getCompLineupTarget } = require('../lib/clip_comp_creative');
  const target = getCompLineupTarget('serpent_ranked_vod');
  assert.equal(target.lineupSlots, 10);
  assert.equal(target.minDurationSec, 480);
  const short = validateCompLineupDuration({ preset: 'serpent_ranked_vod' }, [60, 60, 60, 60]);
  assert.equal(short.ok, false);
  const ok = validateCompLineupDuration({ preset: 'serpent_ranked_vod' }, [120, 120, 120, 120, 120]);
  assert.equal(ok.ok, true);
});

test('syncRankedListToClipCount matches lineup size', () => {
  const c = mergeCompCreative({ preset: 'serpent_ranked' });
  const synced = require('../lib/clip_comp_creative').syncRankedListToClipCount(c, 4);
  assert.equal(synced.hooks.rankedList.slotCount, 4);
});

test('mergeCompCreative deep-merges overrides without dropping preset fields', () => {
  const c = mergeCompCreative({
    preset: 'full_bleed',
    overrides: { audio: { musicBed: 'low_trap' } },
  });
  assert.equal(c.preset, 'full_bleed');
  assert.equal(c.layout.mode, 'full_bleed_crop');
  assert.equal(c.audio.musicBed, 'low_trap');
});

test('compCreativeChips reflects ranked list and VOD comp', () => {
  const ranked = compCreativeChips(PRESET_DEFAULTS.serpent_ranked);
  assert.ok(ranked.some((chip) => chip.includes('Ranked') || chip === 'ranked list'));
  assert.ok(ranked.includes('ranked list'));

  const vod = compCreativeChips(PRESET_DEFAULTS.twitch_comp_vod);
  assert.ok(vod.includes('VOD comp'));
});

test('compCreativeAssemblyFlags marks phase1 schema only', () => {
  const flags = compCreativeAssemblyFlags(PRESET_DEFAULTS.serpent_ranked);
  assert.equal(flags.layoutMode, 'full_bleed_crop');
  assert.equal(flags.rankedListEnabled, true);
  assert.equal(flags.phase1SchemaOnly, false);
});

test('compCreativeGate3Expectations serpent_ranked expects overlay not broadcast chrome', () => {
  const { compCreativeGate3Expectations } = require('../lib/clip_comp_creative');
  const exp = compCreativeGate3Expectations(PRESET_DEFAULTS.serpent_ranked);
  assert.equal(exp.hasLogo, true);
  assert.equal(exp.logoPosition, 'bottom-right');
  assert.equal(exp.rankedOverlay.enabled, true);
  assert.equal(exp.hasSidebar, false);
  assert.equal(exp.clipCompLayoutMode, 'full_bleed_crop');
});

test('buildClipCompDesignSpec wires gate3 chrome from preset', () => {
  const { buildClipCompDesignSpec } = require('../lib/clip_comp');
  const spec = buildClipCompDesignSpec({
    clipCount: 5,
    compCreativePreset: 'serpent_ranked',
    streamerHint: 'Cinna',
  });
  assert.equal(spec.chrome.layout, 'clip-comp');
  assert.equal(spec.chrome.hasLogo, true);
  assert.equal(spec.chrome.rankedOverlay.enabled, true);
  assert.equal(spec.chrome.rankedOverlay.streamer, 'Cinna');
});

test('VALID_PRESETS includes custom', () => {
  assert.ok(VALID_PRESETS.has('custom'));
  assert.ok(VALID_PRESETS.has('classic_blur_pad'));
});

test('fableflow_speed preset is editor-less Speed Short recipe (CPD-1287/1289)', () => {
  const c = mergeCompCreative({ preset: 'fableflow_speed' });
  assert.equal(c.preset, 'fableflow_speed');
  // CPD-1289 — split default so two people fit; solo can switch to full bleed in UI
  assert.equal(c.layout.mode, 'split_screen');
  assert.equal(c.layout.landscapeSplit, true);
  assert.equal(c.hooks.mode, 'whisper_only');
  assert.equal(c.captions.whisper, true);
  assert.equal(c.captions.style, 'phrase_full_bleed');
  assert.ok(c.audio.musicBed === 'low_trap' || c.audio.musicBed === 'neutral_lofi');
  assert.equal(c.audio.cutSfx, 'whoosh');
  assert.equal(c.look.preset, 'punch');
  assert.equal(c.transition.style, 'cut');
  assert.equal(c.effects.transform, true);
  assert.equal(c.delivery.format, 'short');
  assert.equal(c.beatSync.suggestOnPreview, true);
  assert.ok(VALID_PRESETS.has('fableflow_speed'));
  const { getCompLineupTarget } = require('../lib/clip_comp_creative');
  const t = getCompLineupTarget('fableflow_speed');
  assert.equal(t.lineupSlots, 1);
  assert.equal(t.minClips, 1);
  assert.equal(t.maxClips, 1);
});

test('reaction_short is C10 Reaction Short Transform 5/5 recipe', () => {
  const {
    mergeCompCreative,
    VALID_PRESETS,
    getCompLineupTarget,
    getCompCreativeCatalogEntry,
    resolvePresetLayoutMode,
  } = require('../lib/clip_comp_creative');
  const c = mergeCompCreative({ preset: 'reaction_short' });
  assert.equal(c.preset, 'reaction_short');
  assert.equal(c.layout.mode, 'full_bleed_crop');
  assert.equal(c.layout.landscapeSplit, false);
  assert.equal(c.hooks.mode, 'whisper_only');
  assert.equal(c.captions.whisper, true);
  assert.equal(c.audio.musicBed, 'off');
  assert.equal(c.audio.cutSfx, 'whoosh');
  assert.equal(c.look.preset, 'vivid');
  assert.equal(c.beatSync.source, 'clip');
  assert.equal(c.speedFeel, 'punch_pause');
  assert.ok(c.animatedText?.items?.length >= 4);
  assert.equal(c.delivery.format, 'short');
  assert.ok(VALID_PRESETS.has('reaction_short'));
  assert.equal(resolvePresetLayoutMode('reaction_short'), 'full_bleed_crop');
  const cat = getCompCreativeCatalogEntry('reaction_short');
  assert.equal(cat.code, 'C10');
  assert.match(cat.name, /Reaction/i);
  const t = getCompLineupTarget('reaction_short');
  assert.equal(t.lineupSlots, 1);
});

// ─── Facecam split preset (CPD-1228) ─────────────────────────────────────────

test('facecam_split preset merges with split_screen layout', () => {
  const c = mergeCompCreative({ preset: 'facecam_split' });
  assert.equal(c.preset, 'facecam_split');
  assert.equal(c.layout.mode, 'split_screen');
  assert.equal(c.layout.logoCorner, 'top_right');
  assert.equal(c.captions.style, 'phrase_full_bleed');
  assert.ok(VALID_PRESETS.has('facecam_split'));
});

test('facecam_split chips and assembly flags reflect split layout', () => {
  const c = mergeCompCreative({ preset: 'facecam_split' });
  assert.ok(compCreativeChips(c).includes('facecam split'));
  assert.equal(compCreativeAssemblyFlags(c).layoutMode, 'split_screen');
});

test('facecam_split gate3 expectations describe the split panes', () => {
  const { compCreativeGate3Expectations, getCompLineupTarget } = require('../lib/clip_comp_creative');
  const c = mergeCompCreative({ preset: 'facecam_split' });
  const exp = compCreativeGate3Expectations(c);
  assert.equal(exp.clipCompLayoutMode, 'split_screen');
  assert.equal(exp.logoPosition, 'top-right');
  assert.ok(/facecam split/i.test(exp.formatDescription));
  const target = getCompLineupTarget('facecam_split');
  assert.equal(target.lineupSlots, 4);
});
