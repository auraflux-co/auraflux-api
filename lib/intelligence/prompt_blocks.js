'use strict';
/**
 * CPD-1194 — Format Content Memory + comp style for downstream prompts.
 */

function formatRecommendPromptBlock(ctx = {}) {
  if (!ctx.sampleSize) {
    return '(No Content Memory yet — use category guidance above; avoid generic compilation titles.)';
  }

  const lines = [
    `Historical performance: ${ctx.sampleSize} similar video(s), avg views ${ctx.avgViews || 0}.`,
  ];

  if (ctx.winningTitles?.length) {
    lines.push('Winning title patterns (adapt phrasing — do not copy verbatim):');
    ctx.winningTitles.slice(0, 5).forEach((t) => lines.push(`  • "${t}"`));
  }

  if (ctx.topTags?.length) {
    lines.push(`Tags that performed: ${ctx.topTags.slice(0, 12).join(', ')}`);
  }

  if (ctx.compStylePrompt) {
    lines.push('', ctx.compStylePrompt);
  }

  if (ctx.hints?.length) {
    lines.push('', ...ctx.hints.slice(0, 3));
  }

  return lines.join('\n').trim();
}

function formatKeywordPromptBlock(keywordBlock = {}) {
  if (!keywordBlock.keywords?.length) return '';
  return [
    'Keyword intelligence (merge naturally into tags, title, description):',
    keywordBlock.keywords.slice(0, 20).join(', '),
  ].join('\n');
}

function formatThumbnailIntelligenceBlock(ctx = {}) {
  const ideas = (ctx.topThumbnailIdeas || []).filter(Boolean);
  if (!ideas.length && !ctx.sampleSize) {
    return '';
  }
  const lines = [];
  if (ctx.sampleSize) {
    lines.push(`Top performers in memory: ${ctx.sampleSize} video(s), avg views ${ctx.avgViews || 0}.`);
  }
  if (ideas.length) {
    lines.push('High-performing thumbnail text from history (2-5 words, mobile-readable):');
    ideas.slice(0, 8).forEach((t) => lines.push(`  • "${t}"`));
  }
  return lines.join('\n').trim();
}

module.exports = {
  formatRecommendPromptBlock,
  formatKeywordPromptBlock,
  formatThumbnailIntelligenceBlock,
};
