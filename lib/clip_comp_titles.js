'use strict';
/**
 * lib/clip_comp_titles.js — ranked-list + comp title templates (CPD-1090)
 */

const TITLE_TEMPLATES = {
  WAIT_FOR_NO_1: '{streamer} {theme} Moments — WAIT FOR NO. 1 #Shorts',
  NO_1_IS_THE_FUNNIEST: 'NO. 1 IS THE FUNNIEST — {streamer} {theme} #Shorts',
  RANKED_SHORT: 'RANKING {streamer} {theme} MOMENTS #Shorts',
};

function fillTitleTemplate(templateId, vars = {}) {
  const tpl = TITLE_TEMPLATES[templateId] || TITLE_TEMPLATES.WAIT_FOR_NO_1;
  const merged = {
    streamer: vars.streamer || 'Streamer',
    theme: vars.theme || 'FUNNIEST',
    ...vars,
  };
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(merged[k] ?? '').trim()).replace(/\s+/g, ' ').trim();
}

function buildRankedListHeader(compCreative) {
  const rl = compCreative?.hooks?.rankedList || {};
  const streamer = String(rl.streamer || 'STREAMER').toUpperCase();
  const theme = String(rl.theme || 'MOMENTS').toUpperCase();
  if (!theme || theme === 'MOMENTS' || theme === 'NONE') {
    return `RANKING ${streamer} MOMENTS`;
  }
  return `RANKING ${streamer} ${theme} MOMENTS`;
}

function resolveActiveRankSlot(compCreative, clipIndex, clipCount) {
  const slotCount = compCreative?.hooks?.rankedList?.slotCount || 5;
  const n = Math.max(1, clipCount || slotCount);
  // Countdown: first clip in comp = highest rank number still in play
  const fromTop = slotCount - clipIndex;
  return Math.max(1, Math.min(slotCount, fromTop));
}

module.exports = {
  TITLE_TEMPLATES,
  fillTitleTemplate,
  buildRankedListHeader,
  resolveActiveRankSlot,
};
