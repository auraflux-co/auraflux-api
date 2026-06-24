'use strict';
/**
 * lib/clip_comp_publish.js — Short→VOD funnel metadata (CPD-1091)
 */

const { fillTitleTemplate } = require('./clip_comp_titles');

function extractYoutubeVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function buildRelatedVideoDescriptionBlock(compCreative) {
  const parentId = extractYoutubeVideoId(compCreative?.delivery?.relatedVideoParentId);
  if (!parentId) return '';
  return `\n\n▶ Full comp VOD: https://youtu.be/${parentId}`;
}

function enrichPublishDescription(description, compCreative) {
  const parentId = parentIdFromCreative(compCreative);
  const block = buildRelatedVideoDescriptionBlock(compCreative);
  if (!block) return description || '';
  const base = String(description || '').trim();
  if (base.includes(parentIdBlock(parentId))) return base;
  return `${base}${block}`.trim();
}

function parentIdFromCreative(compCreative) {
  return extractYoutubeVideoId(compCreative?.delivery?.relatedVideoParentId);
}

function parentIdBlock(id) {
  return id ? `https://youtu.be/${id}` : '';
}

function buildCompCreativeSeoTitle(compCreative, { streamer = '', clipCount = 4 } = {}) {
  const rl = compCreative?.hooks?.rankedList || {};
  if (rl.enabled) {
    return fillTitleTemplate(rl.titlePattern || 'WAIT_FOR_NO_1', {
      streamer: rl.streamer || streamer,
      theme: rl.theme || 'FUNNIEST',
    });
  }
  if (compCreative?.delivery?.format === 'vod_comp') {
    return `${streamer || 'Streamer'} Funniest Moments This Week`.trim();
  }
  if (clipCount >= 2) return `${streamer || 'Streamer'} clips and more...`;
  return `${streamer || 'Streamer'} clip #Shorts`;
}

function resolveVodCompContentType(sourceContentType) {
  const base = String(sourceContentType || 'twitch-short').replace(/-short$/, '');
  if (base.includes('news')) return 'news-vod-comp';
  if (base.includes('sport') || base.includes('nba')) return 'sports-vod-comp';
  return 'twitch-vod-comp';
}

module.exports = {
  extractYoutubeVideoId,
  buildRelatedVideoDescriptionBlock,
  enrichPublishDescription,
  buildCompCreativeSeoTitle,
  resolveVodCompContentType,
};
