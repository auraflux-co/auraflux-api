'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonLoose, stripMarkdownFences } = require('../lib/gemini_json_parse');

test('stripMarkdownFences removes code fences', () => {
  assert.equal(stripMarkdownFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('parseJsonLoose parses markdown-wrapped hook machine JSON', () => {
  const raw = 'Here:\n```json\n{"hooks":[{"text":"Wrong Shirt Gift","rank":1,"tensionScore":90,"why":"x"}]}\n```';
  const parsed = parseJsonLoose(raw);
  assert.equal(parsed.hooks[0].text, 'Wrong Shirt Gift');
});

test('parseJsonLoose repairs truncated closing brace', () => {
  const raw = '{"leadClipIndex":0,"leadStreamer":"Ron","leadTitleDraft":"Ron Goal and more...","leadReason":"Strong beat"';
  const parsed = parseJsonLoose(raw);
  assert.equal(parsed.leadStreamer, 'Ron');
  assert.match(parsed.leadTitleDraft, /Ron Goal/);
});
