'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_STREAMERS_PER_GROUP,
  normalizeHandle,
  normalizeGroup,
  parseStoredGroups,
  validateGroup,
  upsertGroup,
  deleteGroup,
} = require('../lib/clip_picker_groups');

test('normalizeHandle strips @ and lowercases', () => {
  assert.equal(normalizeHandle('@Maya'), 'maya');
});

test('normalizeGroup caps at four unique streamers', () => {
  const g = normalizeGroup({
    name: 'Test pack',
    streamers: ['a', 'b', 'c', 'd', 'e', 'a'],
  });
  assert.equal(g.streamers.length, 4);
  assert.deepEqual(g.streamers, ['a', 'b', 'c', 'd']);
});

test('validateGroup requires name and streamers', () => {
  assert.equal(validateGroup({ name: '', streamers: [] }).ok, false);
  assert.equal(validateGroup({ name: 'Pack A', streamers: ['maya'] }).ok, true);
});

test('upsertGroup inserts and updates', () => {
  let groups = [];
  const first = upsertGroup(groups, { name: 'A', streamers: ['maya', 'lacy'] });
  assert.equal(first.ok, true);
  assert.equal(first.groups.length, 1);
  const id = first.group.id;
  const second = upsertGroup(first.groups, { id, name: 'A renamed', streamers: ['maya', 'hasanabi', 'cinna', 'adapt'] });
  assert.equal(second.groups.length, 1);
  assert.equal(second.groups[0].name, 'A renamed');
  assert.equal(second.groups[0].streamers.length, 4);
});

test('deleteGroup removes by id', () => {
  const groups = parseStoredGroups('[{"id":"x","name":"n","streamers":["a"]}]');
  const out = deleteGroup(groups, 'x');
  assert.equal(out.ok, true);
  assert.equal(out.groups.length, 0);
});

test('parseStoredGroups ignores invalid json', () => {
  assert.deepEqual(parseStoredGroups('not-json'), []);
});

test('MAX_STREAMERS_PER_GROUP is 4', () => {
  assert.equal(MAX_STREAMERS_PER_GROUP, 4);
});
