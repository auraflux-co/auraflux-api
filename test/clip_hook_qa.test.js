'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  clipHookClaudeQaEnabled,
  buildClipHookQaPrompt,
  claudeClipHookQA,
  PASS_THRESHOLD,
} = require('../lib/gates/clip_hook_qa');
const {
  clipHookGeminiPassCount,
  clipHookQaMaxRetries,
  mergeObservationPasses,
  buildVisualPassPrompt,
  buildAudioPassPrompt,
} = require('../lib/clip_comp_hooks');

test('clipHookClaudeQaEnabled respects CLIP_HOOK_CLAUDE_QA=0', () => {
  const prev = process.env.CLIP_HOOK_CLAUDE_QA;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLIP_HOOK_CLAUDE_QA = '0';
  assert.equal(clipHookClaudeQaEnabled(), false);
  process.env.CLIP_HOOK_CLAUDE_QA = prev;
  process.env.ANTHROPIC_API_KEY = prevKey;
});

test('buildClipHookQaPrompt includes observation and hook', () => {
  const p = buildClipHookQaPrompt({
    observation: 'Visual: gift box. Audio: gasp.',
    hook: 'Wrong Shirt Gift',
    platformTitle: 'wild clip',
    streamer: 'ExtraEmily',
  });
  assert.match(p, /Wrong Shirt Gift/);
  assert.match(p, /Visual: gift box/);
  assert.match(p, /NOT a full script/);
  assert.match(p, new RegExp(String(PASS_THRESHOLD)));
});

test('claudeClipHookQA skips when disabled', async () => {
  const prev = process.env.CLIP_HOOK_CLAUDE_QA;
  process.env.CLIP_HOOK_CLAUDE_QA = '0';
  const r = await claudeClipHookQA({ observation: 'x', hook: 'Wrong Shirt Gift' });
  assert.equal(r.skipped, true);
  assert.equal(r.passed, true);
  process.env.CLIP_HOOK_CLAUDE_QA = prev;
});

test('claudeClipHookQA fails empty hook without API call', async () => {
  const prev = process.env.CLIP_HOOK_CLAUDE_QA;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLIP_HOOK_CLAUDE_QA = '1';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const r = await claudeClipHookQA({ observation: 'Visual beat', hook: '' });
  assert.equal(r.passed, false);
  assert.match(r.violations.join(' '), /empty hook/);
  process.env.CLIP_HOOK_CLAUDE_QA = prev;
  process.env.ANTHROPIC_API_KEY = prevKey;
});

test('clipHookGeminiPassCount clamps 1-3', () => {
  const prev = process.env.CLIP_HOOK_GEMINI_PASSES;
  process.env.CLIP_HOOK_GEMINI_PASSES = '9';
  assert.equal(clipHookGeminiPassCount(), 3);
  process.env.CLIP_HOOK_GEMINI_PASSES = '0';
  assert.equal(clipHookGeminiPassCount(), 1);
  process.env.CLIP_HOOK_GEMINI_PASSES = prev;
});

test('clipHookQaMaxRetries clamps 0-3', () => {
  const prev = process.env.CLIP_HOOK_QA_MAX_RETRIES;
  process.env.CLIP_HOOK_QA_MAX_RETRIES = '99';
  assert.equal(clipHookQaMaxRetries(), 3);
  process.env.CLIP_HOOK_QA_MAX_RETRIES = prev;
});

test('buildVisualPassPrompt and buildAudioPassPrompt are visual/audio scoped', () => {
  const v = buildVisualPassPrompt({ streamer: 'x', title: 'junk', game: 'Fortnite' });
  const a = buildAudioPassPrompt({ title: 'junk' });
  assert.match(v, /VISUAL PASS ONLY/i);
  assert.match(a, /AUDIO PASS ONLY/i);
});

test('mergeObservationPasses returns single pass when other side empty', async () => {
  const out = await mergeObservationPasses({ title: 't' }, '', 'Hear gasp.');
  assert.equal(out, 'Hear gasp.');
  const out2 = await mergeObservationPasses({ title: 't' }, 'See gift.', '');
  assert.equal(out2, 'See gift.');
});
