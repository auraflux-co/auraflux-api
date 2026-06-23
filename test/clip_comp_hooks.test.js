'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isJunkHook,
  normalizeHookLine,
  hooksAreUsable,
  buildClipCompTitleContext,
  burnedCaptionToClipLine,
  stripStreamerPrefix,
  hookCopiesClipTitle,
} = require('../lib/clip_comp_hooks');

test('isJunkHook rejects hooks over max word count', () => {
  const prev = process.env.CLIP_HOOK_MAX_WORDS;
  process.env.CLIP_HOOK_MAX_WORDS = '7';
  assert.equal(isJunkHook('one two three four five six seven eight'), true);
  assert.equal(isJunkHook('Wrong Shirt Gift'), false);
  process.env.CLIP_HOOK_MAX_WORDS = prev;
});

test('isJunkHook rejects twitch passthrough junk and streamer-prefixed lines', () => {
  assert.equal(isJunkHook('dsda'), true);
  assert.equal(isJunkHook('wisdom'), true);
  assert.equal(isJunkHook('w tricksot'), true);
  assert.equal(isJunkHook('ExtraEmily: Back for old clips', { streamer: 'ExtraEmily' }), true);
  assert.equal(isJunkHook('Wrong Shirt Gift'), false);
});

test('hookCopiesClipTitle detects twitch title reuse', () => {
  assert.equal(hookCopiesClipTitle('emily fades in to the old clips', 'emily fades in to the old clips'), true);
  assert.equal(hookCopiesClipTitle('Wrong Shirt Gift', 'emily fades in to the old clips'), false);
});

test('normalizeHookLine strips streamer prefix and rejects title copy', () => {
  assert.equal(
    normalizeHookLine('ExtraEmily', 'ExtraEmily: Wrong Shirt Gift'),
    'Wrong Shirt Gift',
  );
  assert.equal(
    normalizeHookLine('ExtraEmily', 'Wrong Shirt Gift'),
    'Wrong Shirt Gift',
  );
  assert.equal(
    normalizeHookLine('ExtraEmily', 'emily fades in to the old clips', 'emily fades in to the old clips'),
    '',
  );
});

test('stripStreamerPrefix removes colon and possessive leads', () => {
  assert.equal(stripStreamerPrefix('ExtraEmily: Rave Outfit Shock', 'ExtraEmily'), 'Rave Outfit Shock');
  assert.equal(stripStreamerPrefix("ExtraEmily's Rave Outfit Shock", 'ExtraEmily'), 'Rave Outfit Shock');
});

test('hooksAreUsable requires full non-junk set', () => {
  assert.equal(hooksAreUsable(['Wrong Shirt Gift', 'Miami Food Meltdown'], 2), true);
  assert.equal(hooksAreUsable(['dsda', 'Miami Food Meltdown'], 2), false);
  assert.equal(hooksAreUsable(['Wrong Shirt Gift'], 2), false);
  assert.equal(hooksAreUsable(['ExtraEmily: Wrong Shirt Gift'], 1), false);
});

test('burnedCaptionToClipLine strips legacy streamer prefix', () => {
  assert.equal(burnedCaptionToClipLine('ExtraEmily: Wrong Shirt Gift'), 'Wrong Shirt Gift');
  assert.equal(burnedCaptionToClipLine('Wrong Shirt Gift'), 'Wrong Shirt Gift');
});

test('buildClipCompTitleContext feeds moment lines not raw clip titles', () => {
  const script = buildClipCompTitleContext(
    [{ displayName: 'ExtraEmily', title: 'emily fades in to the old clips' }, { displayName: 'Lacy' }],
    ['Wrong Shirt Gift', 'Miami Food Meltdown'],
  );
  assert.match(script, /CLIP 1 \(ExtraEmily\): Wrong Shirt Gift/);
  assert.match(script, /CLIP 2 \(Lacy\): Miami Food Meltdown/);
  assert.ok(!script.includes('ExtraEmily: Wrong Shirt Gift'));
  assert.match(script, /platform title was "emily fades in to the old clips"/);
  assert.ok(!script.match(/CLIP 1 \(ExtraEmily\): emily fades/));
});

test('isDesktopOrIrlStream detects Just Chatting and empty category', () => {
  const { isDesktopOrIrlStream } = require('../lib/clip_comp_hooks');
  assert.equal(isDesktopOrIrlStream({ game: 'Just Chatting' }), true);
  assert.equal(isDesktopOrIrlStream({ game: '' }), true);
  assert.equal(isDesktopOrIrlStream({ game: '509658' }), true);
  assert.equal(isDesktopOrIrlStream({ game: 'Fortnite' }), false);
});

test('buildClipCompSeoInput includes lead title and observations', () => {
  const { buildClipCompSeoInput } = require('../lib/clip_comp_hooks');
  const text = buildClipCompSeoInput({
    leadStreamer: '2xRaKai',
    leadTitleDraft: "2xRaKai's Rejection Moment and more...",
    leadReason: 'Strongest awkward beat',
    clipCount: 2,
    isComp: true,
    clips: [
      { index: 0, displayName: '2xRaKai', observation: 'Visual: close dance. Audio: chat gasps.', hook: 'Eyes Widen at Dance', platformTitle: 'wild clip' },
      { index: 1, displayName: 'funnymike', observation: 'Visual: gift reveal.', hook: 'Wrong Shirt Gift', platformTitle: 'gift' },
    ],
  });
  assert.match(text, /Lead title draft.*2xRaKai/);
  assert.match(text, /Observation \(visual\+audio\)/);
  assert.match(text, /Burned on-screen hook: Eyes Widen at Dance/);
});

test('sanitizeTvClean strips profanity from hooks', () => {
  const { sanitizeTvClean, normalizeHookLine } = require('../lib/clip_comp_hooks');
  assert.ok(!sanitizeTvClean('Oh shit moment').toLowerCase().includes('shit'));
  assert.equal(normalizeHookLine('x', 'He say I am too pussy bro'), 'He say I am too bro');
});

test('resolveHookVideoUrl prefers signed mp4 over clip page', () => {
  const { resolveHookVideoUrl } = require('../lib/clip_comp_hooks');
  assert.match(
    resolveHookVideoUrl({
      clipUrl: 'https://production.clips.twitchcdn.net/foo.mp4?sig=abc',
      pageUrl: 'https://www.twitch.tv/foo/clip/Bar-xyz',
    }),
    /clips\.twitchcdn/,
  );
});
