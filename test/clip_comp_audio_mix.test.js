'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveBedPath,
  resolveCutSfxPath,
  shouldMixCompAudio,
  sidechainBedParams,
  buildCompAudioFilterParts,
} = require('../lib/clip_comp_audio_mix');
const { PRESET_DEFAULTS } = require('../lib/clip_comp_creative');

test('resolveBedPath maps low_trap to existing asset', () => {
  const p = resolveBedPath('low_trap');
  assert.ok(p);
  assert.ok(p.endsWith('.mp3'));
});

test('shouldMixCompAudio true when bed or sfx enabled', () => {
  assert.equal(shouldMixCompAudio(PRESET_DEFAULTS.classic_blur_pad), false);
  assert.equal(shouldMixCompAudio(PRESET_DEFAULTS.serpent_ranked), true);
});

test('serpent_pack resolves whoosh sfx', () => {
  assert.ok(resolveCutSfxPath('serpent_pack'));
});

test('serpent_ranked uses constant quiet bed without sidechain duck', () => {
  const sc = sidechainBedParams(PRESET_DEFAULTS.serpent_ranked.audio);
  assert.equal(sc, null);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur: 60,
    bedVol: 0.018,
    bedInputIdx: 1,
    duckParams: sc,
    boundaries: [12, 24],
    sfxInputStartIdx: 2,
    sfxPaths: ['whoosh.mp3', 'impact.mp3'],
  });
  const graph = filterParts.join(';');
  assert.match(graph, /volume=0\.0180.*\[bedraw\]/);
  assert.doesNotMatch(graph, /sidechaincompress/);
  assert.doesNotMatch(graph, /bedfloor/);
  assert.match(graph, /amix=inputs=4:weights=1 0\.22 0\.38 0\.38:normalize=0/);
});

test('optional duck path still available for other presets', () => {
  const sc = sidechainBedParams({ duckSpeech: true });
  assert.ok(sc);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur: 60,
    bedVol: 0.05,
    bedInputIdx: 1,
    duckParams: sc,
    boundaries: [],
    sfxInputStartIdx: 2,
    sfxPaths: [],
  });
  const graph = filterParts.join(';');
  assert.match(graph, /sidechaincompress=.*mix=0\.95/);
});

test('CPD-1295 dialogue-aware gain expr mutes bed in speech windows', () => {
  const {
    buildSpeechGainExpr,
    mergeSpeechWindows,
    speechWindowsFromWhisperPayload,
    wantsDialogueAwareMix,
    resolveEffectiveMusicBed,
    buildCompAudioFilterParts,
    dialogueMixGains,
    escapeFilterExpr,
  } = require('../lib/clip_comp_audio_mix');

  const windows = mergeSpeechWindows([
    { start: 1.0, end: 2.0 },
    { start: 2.1, end: 3.0 },
  ]);
  assert.equal(windows.length, 1); // merged near windows
  assert.ok(windows[0].start < 1.0);
  assert.ok(windows[0].end > 3.0);

  const fromWhisper = speechWindowsFromWhisperPayload({
    segments: [{ start: 0.5, end: 1.2 }, { start: 4, end: 5 }],
  });
  assert.equal(fromWhisper.length, 2);

  const bedExpr = buildSpeechGainExpr(windows, 0, 1);
  assert.match(bedExpr, /^if\(between\(t,/);
  assert.match(bedExpr, /0\.0000/);
  assert.match(bedExpr, /1\.0000/);

  assert.equal(wantsDialogueAwareMix({ musicBed: 'low_trap', duckSpeech: true }), true);
  assert.equal(wantsDialogueAwareMix({ musicBed: 'low_trap', dialogueAwareMix: false }), false);
  assert.equal(resolveEffectiveMusicBed({ musicBed: 'low_trap', bedStyle: 'complement' }), 'neutral_lofi');
  assert.equal(resolveEffectiveMusicBed({ musicBed: 'auto_complement' }), 'neutral_lofi');
  assert.equal(resolveEffectiveMusicBed({ musicBed: 'file:ES_NO MERCY - Ballpoint.mp3' }), 'file:ES_NO MERCY - Ballpoint.mp3');

  const gains = dialogueMixGains({ bedInSpeechGain: 0, sourceOutsideSpeechGain: 0.32 });
  const { filterParts } = buildCompAudioFilterParts({
    totalDur: 45,
    bedVol: 0.1,
    bedInputIdx: 1,
    duckParams: null,
    speechWindows: windows,
    dialogueGains: gains,
  });
  const graph = filterParts.join(';');
  assert.match(graph, /volume=if\(between/);
  assert.match(graph, /eval=frame/);
  assert.doesNotMatch(graph, /sidechaincompress/);
  // commas escaped for filtergraph
  assert.match(graph, /between\(t\\\,/);
  assert.equal(escapeFilterExpr('if(a,b,c)'), 'if(a\\,b\\,c)');
});

test('C9 fableflow_speed enables dialogue-aware complementary bed', () => {
  const audio = PRESET_DEFAULTS.fableflow_speed.audio;
  assert.equal(audio.dialogueAwareMix, true);
  assert.equal(audio.bedStyle, 'complement');
  assert.equal(audio.musicBed, 'neutral_lofi');
});
