'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExtractionWithRetry, mergeExtractions } = require('../lib/hook_training/ingest');

test('parseExtractionWithRetry succeeds on second attempt', async () => {
  let calls = 0;
  const result = await parseExtractionWithRetry(
    'return json',
    async () => {
      calls++;
      return calls === 1
        ? 'Here is my analysis: not json'
        : '{"principles":[{"id":"curiosity_gap","text":"Tease without spoiling","layer":"psychology","sourceId":"test"}],"formulas":[],"anti_patterns":[],"verbatim_hooks":[],"twitch_comp_notes":[]}';
    },
    { logFn: () => {}, label: 'test' },
  );
  assert.equal(calls, 2);
  assert.ok(result.parsed);
  assert.equal(result.parsed.principles[0].id, 'curiosity_gap');
});

test('mergeExtractions dedupes principles by id', () => {
  const merged = mergeExtractions([
    { principles: [{ id: 'a', text: 'One' }], formulas: [], anti_patterns: [], verbatim_hooks: [], twitch_comp_notes: [] },
    { principles: [{ id: 'a', text: 'One duplicate' }, { id: 'b', text: 'Two' }], formulas: [], anti_patterns: [], verbatim_hooks: [], twitch_comp_notes: [] },
  ]);
  assert.equal(merged.principles.length, 2);
});
