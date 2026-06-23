'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadHookExamples,
  buildHookMachinePrompt,
  parseHookMachineResponse,
  sortHookCandidates,
  pickFirstUsableCandidate,
  hookWordCount,
  hookMaxWords,
  localHookScore,
} = require('../lib/clip_hook_machine');

test('loadHookExamples returns patterns and examples from config', () => {
  const { examples, patterns } = loadHookExamples();
  assert.ok(examples.length >= 5);
  assert.ok(patterns.length >= 2);
  assert.ok(examples.some((e) => /Wrong Shirt Gift/i.test(e.hook)));
});

test('buildHookMachinePrompt includes few-shot examples and curiosity gap rules', () => {
  const p = buildHookMachinePrompt(
    { streamer: 'ExtraEmily', title: 'emily fades in' },
    'Visual: shirt rip. Audio: gasp.',
  );
  assert.match(p, /TOP-PERFORMING HOOKS/i);
  assert.match(p, /Curiosity gap/i);
  assert.match(p, /3-SECOND RULE/i);
  assert.match(p, /Wrong Shirt Gift/);
  assert.match(p, /Visual: shirt rip/);
});

test('parseHookMachineResponse parses ranked JSON hooks', () => {
  const raw = `Here are options:
{"hooks":[{"text":"Forks, Sushi, Confidence","rank":1,"tensionScore":92,"why":"Pattern interrupt"},{"text":"Bad Hook Title Copy","rank":2,"tensionScore":40,"why":"weak"}]}`;
  const hooks = parseHookMachineResponse(raw);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].text, 'Forks, Sushi, Confidence');
  assert.equal(hooks[0].rank, 1);
});

test('parseHookMachineResponse parses markdown-fenced JSON', () => {
  const raw = '```json\n{"hooks":[{"text":"5\'6 Went To The DM","rank":1,"tensionScore":91,"why":"specific"}]}\n```';
  const hooks = parseHookMachineResponse(raw);
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].text, /DM/);
});

test('sortHookCandidates prefers rank 1 over rank 2', () => {
  const sorted = sortHookCandidates([
    { text: 'B', rank: 2, tensionScore: 99 },
    { text: 'A', rank: 1, tensionScore: 80 },
  ]);
  assert.equal(sorted[0].text, 'A');
});

test('pickFirstUsableCandidate skips filtered hooks', () => {
  const picked = pickFirstUsableCandidate(
    [
      { text: 'dsda', rank: 1, tensionScore: 99 },
      { text: 'Wrong Shirt Gift', rank: 2, tensionScore: 90 },
    ],
    (t) => t.length > 8 && t !== 'dsda',
  );
  assert.equal(picked.text, 'Wrong Shirt Gift');
});

test('localHookScore favors shorter hooks within target', () => {
  assert.ok(localHookScore('Wrong Shirt Gift', { targetWords: 7, maxWords: 12 }) > localHookScore(
    'This hook is way too long for scroll stop power',
    { targetWords: 7, maxWords: 12 },
  ));
});

test('hookWordCount and hookMaxWords defaults', () => {
  assert.equal(hookWordCount('One two three'), 3);
  assert.equal(hookMaxWords(), 12);
});
