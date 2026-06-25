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
  assert.equal(c.audio.duckSpeech, false);
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
  assert.equal(exp.hasLogo, false);
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
  assert.equal(spec.chrome.hasLogo, false);
  assert.equal(spec.chrome.rankedOverlay.enabled, true);
  assert.equal(spec.chrome.rankedOverlay.streamer, 'Cinna');
});

test('VALID_PRESETS includes custom', () => {
  assert.ok(VALID_PRESETS.has('custom'));
  assert.ok(VALID_PRESETS.has('classic_blur_pad'));
});
