'use strict';
/**
 * CPD-1190/1191 — ClipzWorld Intelligence Engine (C0 foundation).
 *
 * Contract:
 *   recordFromPublish(jobSpec, card, publishMeta) — write Content Memory on publish
 *   recommendContext(params) — historical hints for title/thumb/SEO generation
 *   syncPerformance(platform, opts) — pull analytics into memory
 *   recordDecision(params) — Why database for publish choices
 */

const memory = require('./memory');
const youtubeAdapter = require('./adapters/youtube');

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

function buildMetadataFromPublish(jobSpec, card, publishMeta = {}) {
  const publishCopy = jobSpec?.state?.savedOutputs?.publishCopy
    || card?.publishCopy
    || {};
  const youtube = publishCopy.youtube || {};
  const seo = publishCopy.seo || {};
  const bestTitle = youtube.bestTitle || {};

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
  };
}

function recordFromPublish(jobSpec, card, publishMeta = {}) {
  const jobId = jobSpec?.jobId || card?.jobId || card?.id;
  if (!jobId) return null;

  const platform = publishMeta.platform || 'youtube';
  let platformVideoId = publishMeta.platformVideoId || null;
  if (!platformVideoId) {
    const url = publishMeta.url
      || card?.publishRecord?.youtubeUrl
      || card?.youtubeUrl
      || jobSpec?.state?.savedOutputs?.youtubeUrl;
    platformVideoId = youtubeAdapter.extractVideoId(url);
  }
  if (!platformVideoId && platform === 'youtube') return null;

  const metadata = buildMetadataFromPublish(jobSpec, card, publishMeta);
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

function recommendContext({
  contentType,
  streamer,
  formFactor = 'short',
  limit = 5,
} = {}) {
  const performers = memory.topPerformers({
    metric: 'views',
    contentType,
    streamer,
    limit: Math.max(limit, 10),
  });

  const filtered = performers.filter((v) => {
    if (formFactor && v.formFactor && v.formFactor !== formFactor) return false;
    return true;
  }).slice(0, limit);

  const titlePatterns = filtered
    .map((v) => v.metadata?.title)
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

  const avgViews = filtered.length
    ? Math.round(filtered.reduce((s, v) => s + (v.score || 0), 0) / filtered.length)
    : 0;

  return {
    ok: true,
    sampleSize: filtered.length,
    contentType: contentType || null,
    streamer: streamer || null,
    formFactor,
    avgViews,
    winningTitles: titlePatterns,
    topTags,
    hints: filtered.length
      ? [`${filtered.length} historical videos matched; avg views ${avgViews}`]
      : ['No Content Memory yet — publish and sync analytics to enable learning'],
    performers: filtered.map((v) => ({
      platformVideoId: v.platformVideoId,
      title: v.title,
      views: v.performance?.views || v.score || 0,
      jobId: v.jobId,
    })),
  };
}

async function syncPerformance(platform = 'youtube', opts = {}) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`No intelligence adapter for platform: ${platform}`);
  if (opts.videoId) return adapter.syncVideoPerformance(opts.videoId, opts);
  return adapter.syncAllKnownVideos(opts);
}

module.exports = {
  memory,
  recordFromPublish,
  recommendContext,
  syncPerformance,
  recordDecision: memory.recordDecision,
  memoryStats: memory.memoryStats,
  listVideos: memory.listVideos,
  topPerformers: memory.topPerformers,
  getVideoByJobId: memory.getVideoByJobId,
};
