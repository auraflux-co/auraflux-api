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

test('parseJsonLoose salvages hooks with unescaped inner quotes', () => {
  const raw = '```json\n{ "hooks": [ { "text": "What Did I Do?" She Just Laughs.", "rank": 1, "tensionScore": 88, "why": "x" } ] }\n```';
  const parsed = parseJsonLoose(raw);
  assert.equal(parsed.hooks[0].text, 'What Did I Do?" She Just Laughs.');
  assert.equal(parsed.hooks[0].rank, 1);
});

test('parseJsonLoose repairs truncated hooks array', () => {
  const raw = '```json\n{ "hooks": [ { "text": "Weed, bottles, and... World Cup", "rank": 1, "tensionScore": 85, "why": "test" }, { "text": "second hook", "rank": 2, "tensionScore": 80, "why": "y" }';
  const parsed = parseJsonLoose(raw);
  assert.ok(parsed.hooks.length >= 1);
  assert.match(parsed.hooks[0].text, /World Cup/);
});
