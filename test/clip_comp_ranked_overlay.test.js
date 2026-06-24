'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRankedOverlayDrawtext,
  burnRankedListOverlay,
  rankedOverlayMetrics,
} = require('../lib/clip_comp_ranked_overlay');
const { fillTitleTemplate, resolveActiveRankSlot } = require('../lib/clip_comp_titles');
const { PRESET_DEFAULTS } = require('../lib/clip_comp_creative');

test('fillTitleTemplate WAIT_FOR_NO_1', () => {
  const t = fillTitleTemplate('WAIT_FOR_NO_1', { streamer: 'Lacy', theme: 'FUNNIEST' });
  assert.ok(t.includes('Lacy'));
  assert.ok(t.includes('WAIT FOR NO. 1'));
});

test('buildRankedOverlayDrawtext compact layout for Top 10 VOD', () => {
  const vf = buildRankedOverlayDrawtext(PRESET_DEFAULTS.serpent_ranked_vod, { activeSlot: 10 });
  assert.ok(vf.includes('drawtext='));
  assert.ok(vf.includes('fontsize=52'));
  const metrics = rankedOverlayMetrics(10);
  assert.equal(metrics.rowGap, 52);
});

test('resolveActiveRankSlot countdown from first clip', () => {
  assert.equal(resolveActiveRankSlot(PRESET_DEFAULTS.serpent_ranked, 0, 4), 5);
  assert.equal(resolveActiveRankSlot(PRESET_DEFAULTS.serpent_ranked, 3, 4), 2);
});

test('resolveActiveRankSlot follows synced slotCount', () => {
  const c = { hooks: { rankedList: { enabled: true, slotCount: 4 } } };
  assert.equal(resolveActiveRankSlot(c, 0, 4), 4);
  assert.equal(resolveActiveRankSlot(c, 3, 4), 1);
});

test('buildRankedListHeader neutral MOMENTS theme', () => {
  const { buildRankedListHeader } = require('../lib/clip_comp_titles');
  const header = buildRankedListHeader({
    hooks: { rankedList: { streamer: 'Cinna', theme: 'MOMENTS' } },
  });
  assert.equal(header, 'RANKING CINNA MOMENTS');
  assert.ok(!header.includes('MOMENTS MOMENTS'));
});

test('burnRankedListOverlay no-op when disabled', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const inp = path.join(os.tmpdir(), 'ranked_in.mp4');
  const out = path.join(os.tmpdir(), 'ranked_out.mp4');
  fs.writeFileSync(inp, 'fake');
  const ok = await burnRankedListOverlay(inp, out, { compCreative: PRESET_DEFAULTS.full_bleed });
  assert.equal(ok, false);
  fs.unlinkSync(inp);
  if (fs.existsSync(out)) fs.unlinkSync(out);
});
