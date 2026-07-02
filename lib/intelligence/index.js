'use strict';
/**
 * CPD-1190–1197 — ClipzWorld Intelligence Engine (C0).
 *
 * Contract:
 *   recordFromPublish(jobSpec, card, publishMeta) — write Content Memory on publish
 *   recommendContext(params) — historical hints for title/thumb/SEO generation
 *   syncPerformance(platform, opts) — pull analytics into memory + reconcile outcomes
 *   recordDecision(params) — Why database for publish choices
 *   backfillFromJobs(opts) — seed memory from published job cards
 *   reconcileOutcomes(opts) — attach performance to pending decisions
 */

const memory = require('./memory');
const youtubeAdapter = require('./adapters/youtube');
const promptBlocks = require('./prompt_blocks');

const ADAPTERS = {
  youtube: youtubeAdapter,
};

function inferFormFactor(jobSpec, card) {
  const ct = jobSpec?.contentType || card?.contentType || '';
  if (ct.includes('short') || jobSpec?.order?.output?.formFactor === 'short') return 'short';
  if (ct.includes('long') || card?.longForm) return 'long';
  return ct.includes('short') ? 'short' : 'long';
}

function inferStreamer(jobSpec, card) {
  const streamers = jobSpec?.streamers || card?.streamers;
  if (Array.isArray(streamers) && streamers.length) return streamers[0];
  if (typeof streamers === 'string') return streamers;
  return card?.streamer || null;
}

function normalizeContentType(contentType) {
  return String(contentType || '').replace(/-short$/, '').replace(/-long$/, '') || null;
}

function buildMetadataFromPublish(jobSpec, card, publishMeta = {}) {
  const publishCopy = jobSpec?.state?.savedOutputs?.publishCopy
    || card?.publishCopy
    || {};
  const youtube = publishCopy.youtube || {};
  const seo = publishCopy.seo || {};
  const bestTitle = youtube.bestTitle || {};
  const virality = publishCopy.virality || seo.virality || publishCopy.platforms?.virality || {};

  return {
    title: publishMeta.title || youtube.bestTitle?.title || card?.title || null,
    description: youtube.description || null,
    tags: youtube.tags || [],
    hashtags: youtube.hashtags || [],
    pinnedComment: youtube.pinnedComment || null,
    thumbnailTextIdeas: youtube.thumbnailTextIdeas || [],
    primaryKeywords: seo.primaryKeywords || [],
    longTailKeywords: seo.longTailKeywords || [],
    category: publishCopy.category || null,
    bestTitleReason: bestTitle.reason || null,
    platformJobId: publishMeta.platformJobId || null,
    driveUrl: publishMeta.driveUrl || card?.driveUrl || null,
    virality,
  };
}

function buildGenomeFromPublish(publishCopy = {}, metadata = {}) {
  const virality = metadata.virality || publishCopy.virality || {};
  return {
    category: metadata.category || publishCopy.category || null,
    viralityScores: virality,
    formFactor: publishCopy.formType || null,
  };
}

function recordFromPublish(jobSpec, card, publishMeta = {}) {
  const jobId = jobSpec?.jobId || card?.jobId || card?.id;
  if (!jobId) return null;

  const platform = publishMeta.platform || 'youtube';
  let platformVideoId = publishMeta.platformVideoId || null;
  if (!platformVideoId) {
    const url = publishMeta.url
      || card?.gate5Result?.platforms?.youtube?.url
      || card?.publishRecord?.youtubeUrl
      || card?.youtubeUrl
      || jobSpec?.state?.savedOutputs?.youtubeUrl;
    platformVideoId = youtubeAdapter.extractVideoId(url);
  }
  if (!platformVideoId && platform === 'youtube') return null;

  const publishCopy = jobSpec?.state?.savedOutputs?.publishCopy || card?.publishCopy || {};
  const metadata = buildMetadataFromPublish(jobSpec, card, publishMeta);
  const genome = buildGenomeFromPublish(publishCopy, metadata);

  const video = memory.upsertVideo({
    platform,
    platformVideoId,
    jobId,
    channelId: process.env.YOUTUBE_CHANNEL_ID || null,
    title: metadata.title,
    contentType: jobSpec?.contentType || card?.contentType || null,
    streamer: inferStreamer(jobSpec, card),
    formFactor: inferFormFactor(jobSpec, card),
    publishedAt: Date.now(),
    metadata,
    genome,
  });

  if (metadata.bestTitleReason || metadata.title) {
    memory.recordDecision({
      jobId,
      kind: 'publish_title',
      choice: { title: metadata.title, platformVideoId },
      reasons: metadata.bestTitleReason
        ? [metadata.bestTitleReason]
        : ['publish_copy_best_title'],
      outcome: null,
    });
  }

  return video;
}

function loadCompStylePrompt(streamer, contentType) {
  const ct = normalizeContentType(contentType);
  if (ct !== 'twitch' && ct !== 'clips' && !streamer) return null;
  try {
    const { buildCompStyleExamples, formatCompStylePromptBlock } = require('../post_live/comp_style_context');
    const compStyle = buildCompStyleExamples({ streamer, limitComps: 3 });
    if (!compStyle.examples?.length) return null;
    return formatCompStylePromptBlock(compStyle);
  } catch {
    return null;
  }
}

function recommendContext({
  contentType,
  streamer,
  formFactor = 'short',
  limit = 5,
  includeCompStyle = true,
} = {}) {
  const baseType = normalizeContentType(contentType);
  const performers = memory.topPerformers({
    metric: 'views',
    contentType: baseType || contentType,
    streamer,
    limit: Math.max(limit, 10),
  });

  const filtered = performers.filter((v) => {
    if (formFactor && v.formFactor && v.formFactor !== formFactor) return false;
    return true;
  }).slice(0, limit);

  const titlePatterns = filtered
    .map((v) => v.metadata?.title || v.title)
    .filter(Boolean);

  const tagPool = filtered.flatMap((v) => v.metadata?.tags || []);
  const tagCounts = {};
  for (const t of tagPool) {
    const key = String(t).toLowerCase();
    tagCounts[key] = (tagCounts[key] || 0) + 1;
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);

  const thumbPool = filtered.flatMap((v) => v.metadata?.thumbnailTextIdeas || []);
  const topThumbnailIdeas = [...new Set(thumbPool.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);

  const avgViews = filtered.length
    ? Math.round(filtered.reduce((s, v) => s + (v.score || 0), 0) / filtered.length)
    : 0;

  const compStylePrompt = includeCompStyle ? loadCompStylePrompt(streamer, baseType || contentType) : null;

  let competitorBlock = null;
  try {
    competitorBlock = require('./competitors').competitorPatterns({ limit: 5 });
  } catch { /* competitor snapshot optional */ }

  const ctx = {
    ok: true,
    sampleSize: filtered.length,
    contentType: contentType || null,
    streamer: streamer || null,
    formFactor,
    avgViews,
    winningTitles: titlePatterns,
    topTags,
    topThumbnailIdeas,
    compStylePrompt,
    competitorPatterns: competitorBlock?.promptBlock || null,
    competitorOutliers: competitorBlock?.outliers || [],
    hints: filtered.length
      ? [`${filtered.length} historical videos matched; avg views ${avgViews}`]
      : ['No Content Memory yet — publish and sync analytics to enable learning'],
    performers: filtered.map((v) => ({
      platformVideoId: v.platformVideoId,
      title: v.title,
      views: v.performance?.views || v.score || 0,
      jobId: v.jobId,
      thumbnailTextIdeas: v.metadata?.thumbnailTextIdeas || [],
    })),
  };

  ctx.promptBlock = promptBlocks.formatRecommendPromptBlock(ctx);
  return ctx;
}

function getPublishIntelligenceContext({
  contentType,
  streamer,
  formFactor = 'short',
  publishCopy = null,
} = {}) {
  const intelligenceContext = recommendContext({ contentType, streamer, formFactor });
  let keywordBlock = { ok: true, keywords: [], sources: { publishCopy: 0, historical: 0 } };
  try {
    const seo = require('../seo');
    keywordBlock = seo.buildKeywordContext({ publishCopy, intelligenceContext });
  } catch {
    /* non-fatal */
  }
  return {
    intelligenceContext,
    keywordBlock,
    promptBlock: [
      intelligenceContext.promptBlock,
      promptBlocks.formatKeywordPromptBlock(keywordBlock),
    ].filter(Boolean).join('\n\n'),
  };
}

function getThumbnailIntelligenceContext(jobSpec = {}) {
  const contentType = jobSpec.contentType || 'twitch';
  const streamer = inferStreamer(jobSpec, jobSpec);
  const formFactor = inferFormFactor(jobSpec, jobSpec);
  const ctx = recommendContext({
    contentType,
    streamer,
    formFactor,
    limit: 5,
    includeCompStyle: false,
  });
  return {
    ...ctx,
    promptBlock: promptBlocks.formatThumbnailIntelligenceBlock(ctx),
  };
}

function recordPublishGenerationDecisions(jobId, metadata = {}, intelligenceContext = null) {
  if (!jobId) return [];
  const recorded = [];
  const yt = metadata.youtube || metadata.platforms?.youtube || {};
  const best = yt.bestTitle || {};

  if (best.title || yt.title) {
    recorded.push(memory.recordDecision({
      jobId,
      kind: 'publish_title_generated',
      choice: { title: best.title || yt.title },
      reasons: best.reason ? [best.reason] : ['llm_best_title'],
      outcome: null,
    }));
  }

  if (intelligenceContext?.sampleSize > 0) {
    recorded.push(memory.recordDecision({
      jobId,
      kind: 'intelligence_context_used',
      choice: {
        sampleSize: intelligenceContext.sampleSize,
        avgViews: intelligenceContext.avgViews,
        topTags: (intelligenceContext.topTags || []).slice(0, 8),
      },
      reasons: intelligenceContext.hints || ['content_memory_injected'],
      outcome: null,
    }));
  }

  return recorded.filter(Boolean);
}

function recordThumbnailDecision(jobId, recommendation = {}) {
  if (!jobId || !recommendation?.method) return null;
  return memory.recordDecision({
    jobId,
    kind: 'thumbnail_selected',
    choice: {
      index: recommendation.index,
      method: recommendation.method,
      rationale: recommendation.rationale || null,
    },
    reasons: ['gemini_ranking'],
    outcome: null,
  });
}

function reconcileOutcomes({ limit = 200 } = {}) {
  const pending = memory.listPendingOutcomeDecisions({ limit });
  let updated = 0;
  for (const decision of pending) {
    const video = memory.getVideoByJobId(decision.jobId);
    if (!video?.performance?.views) continue;
    memory.updateDecisionOutcome(decision.id, {
      views: video.performance.views,
      averageViewPercentage: video.performance.averageViewPercentage || null,
      subscribersGained: video.performance.subscribersGained || null,
      syncedAt: video.syncedAt || Date.now(),
    });
    updated += 1;
  }
  return { ok: true, pending: pending.length, updated };
}

function cardToJobSpec(jobId, card) {
  return {
    jobId,
    contentType: card.contentType || card.type || null,
    streamers: card.streamers || (card.streamer ? [card.streamer] : []),
    state: card.state || { savedOutputs: card.savedOutputs || {} },
  };
}

function backfillFromJobs({ limit = 100, jobsFile } = {}) {
  const { loadJobsFromDisk } = require('../post_live/comp_style_context');
  const allJobs = loadJobsFromDisk(jobsFile);
  const entries = Object.entries(allJobs || {})
    .map(([jobId, job]) => ({ jobId, job }))
    .filter(({ job }) => {
      const stage = job?.stage || '';
      const url = job?.gate5Result?.platforms?.youtube?.url
        || job?.publishRecord?.youtubeUrl
        || job?.youtubeUrl
        || job?.state?.savedOutputs?.youtubeUrl;
      return (stage === 'published' || job?.publishedAt) && url;
    })
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));

  const results = [];
  for (const { jobId, job } of entries) {
    try {
      const jobSpec = cardToJobSpec(jobId, job);
      const video = recordFromPublish(jobSpec, { ...job, jobId, id: jobId }, {
        platform: 'youtube',
        url: job.gate5Result?.platforms?.youtube?.url || job.publishRecord?.youtubeUrl || job.youtubeUrl || null,
        title: job.title || null,
        driveUrl: job.driveUrl || null,
      });
      results.push({ ok: !!video, jobId, platformVideoId: video?.platformVideoId || null });
    } catch (e) {
      results.push({ ok: false, jobId, error: e.message });
    }
  }
  return { ok: true, scanned: entries.length, results };
}

async function syncPerformance(platform = 'youtube', opts = {}) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`No intelligence adapter for platform: ${platform}`);
  let results;
  if (opts.videoId) {
    results = [await adapter.syncVideoPerformance(opts.videoId, opts)];
  } else {
    results = await adapter.syncAllKnownVideos(opts);
  }
  const reconcile = reconcileOutcomes({ limit: opts.reconcileLimit || 200 });
  return { results, reconcile };
}

module.exports = {
  memory,
  promptBlocks,
  recordFromPublish,
  recommendContext,
  getPublishIntelligenceContext,
  getThumbnailIntelligenceContext,
  recordPublishGenerationDecisions,
  recordThumbnailDecision,
  reconcileOutcomes,
  backfillFromJobs,
  syncPerformance,
  recordDecision: memory.recordDecision,
  memoryStats: memory.memoryStats,
  listVideos: memory.listVideos,
  topPerformers: memory.topPerformers,
  getVideoByJobId: memory.getVideoByJobId,
};
