'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listMusicBedOptions } = require('../lib/clip_comp_audio_catalog');
const { resolveBedPath } = require('../lib/clip_comp_audio_mix');

test('listMusicBedOptions includes off and built-in beds when files exist', () => {
  const beds = listMusicBedOptions();
  assert.ok(beds.some((b) => b.id === 'off'));
  const lowTrap = beds.find((b) => b.id === 'low_trap');
  if (lowTrap) assert.ok(lowTrap.file.endsWith('.mp3'));
});

test('resolveBedPath accepts file: prefix for custom uploads', () => {
  const beds = listMusicBedOptions({ includeOff: false });
  const custom = beds.find((b) => b.id.startsWith('file:'));
  if (!custom) return;
  const resolved = resolveBedPath(custom.id);
  assert.ok(resolved);
});
