'use strict';

/**
 * Side-by-side benchmarks: C0 localhost intelligence vs vidIQ MCP (platform-wide).
 * C0 learns from ClipzWorld Content Memory; vidIQ taps 135M+ channel corpus.
 */

const vidiq = require('./adapters/vidiq_mcp');
const { scorePublishMetadata } = require('../publish_optimize');
const { competitorPatterns } = require('./competitors');

/** Scenario registry — maps vidIQ MCP tools to closest C0 native path. */
const SCENARIOS = {
  optimize_title: {
    label: 'Title optimize score',
    vidiqTool: 'vidiq_score_title',
    vidiqArgs: (input) => ({
      title: input.title,
      type: input.type === 'long' ? 'long' : 'short',
    }),
    c0: (input) => scorePublishMetadata({
      title: input.title,
      description: input.description || '',
      tags: input.tags || [],
      primaryKeyword: input.primaryKeyword || input.keyword || null,
      hasThumbnail: !!input.hasThumbnail,
    }),
    summarize: (row) => ({
      vidiqScore: row.vidiq?.score ?? null,
      c0Score: row.c0?.score ?? null,
      delta: (row.vidiq?.score != null && row.c0?.score != null)
        ? row.c0.score - row.vidiq.score
        : null,
    }),
  },
  keyword_research: {
    label: 'Keyword research',
    vidiqTool: 'vidiq_keyword_research',
    vidiqArgs: (input) => ({
      mode: 'research',
      keyword: input.keyword || input.seed || 'twitch clips',
      includeRelated: true,
      limit: Math.min(20, Number(input.limit) || 10),
    }),
    c0: async (input) => {
      const intelligence = require('./index');
      const ctx = intelligence.recommendContext({
        contentType: input.contentType || 'twitch-comp',
        streamer: input.streamer || null,
        formFactor: input.formFactor || 'short',
      });
      return {
        source: 'clipzworld_content_memory',
        primaryKeywords: (ctx?.seoKeywords || []).slice(0, 10),
        titlePatterns: (ctx?.titlePatterns || []).slice(0, 5),
        note: 'C0 has no global YouTube keyword volume — only channel memory + competitor outliers',
      };
    },
    summarize: (row) => ({
      vidiqRelatedCount: (row.vidiq?.relatedKeywords || []).length,
      c0KeywordCount: (row.c0?.primaryKeywords || []).length,
    }),
  },
  outliers_shorts: {
    label: 'Shorts outliers',
    vidiqTool: 'vidiq_outliers',
    vidiqArgs: (input) => ({
      keyword: input.keyword || 'twitch',
      contentType: 'short',
      limit: Math.min(15, Number(input.limit) || 10),
      publishedWithin: input.publishedWithin || 'thisMonth',
    }),
    c0: async () => {
      const block = competitorPatterns({ limit: 10 });
      return {
        source: 'config/competitors.json + yt-dlp catalog',
        outliers: (block.outliers || []).map((o) => ({
          channel: o.channel,
          videoId: o.videoId,
          title: o.title,
          views: o.views,
          multiple: o.multiple,
        })),
      };
    },
    summarize: (row) => ({
      vidiqVideoCount: (row.vidiq?.videos || []).length,
      c0OutlierCount: (row.c0?.outliers || []).length,
    }),
  },
  channel_analytics: {
    label: 'Own channel analytics',
    vidiqTool: 'vidiq_channel_analytics',
    vidiqArgs: (input) => ({
      channelId: input.channelId || process.env.YOUTUBE_CHANNEL_ID,
      period: input.period || 'last_28_days',
    }),
    c0: async (input) => {
      const channelId = input.channelId || process.env.YOUTUBE_CHANNEL_ID;
      if (!channelId) return { error: 'YOUTUBE_CHANNEL_ID not set' };
      const { fetchChannelSummary } = require('../services/channel_analytics');
      const summary = await fetchChannelSummary(channelId, { days: 28 });
      const memory = require('./memory');
      const videos = memory.listVideos({ limit: 20 });
      return {
        source: 'youtube_analytics_api + content_memory',
        channelId,
        summary,
        memoryVideoCount: videos.length,
      };
    },
    summarize: (row) => ({
      vidiqOk: !row.vidiq?.error,
      c0MemoryVideos: row.c0?.memoryVideoCount ?? null,
    }),
  },
};

function listScenarios() {
  return Object.entries(SCENARIOS).map(([id, s]) => ({
    id,
    label: s.label,
    vidiqTool: s.vidiqTool,
  }));
}

async function runScenario(scenarioId, input = {}, opts = {}) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);

  const row = {
    scenarioId,
    label: scenario.label,
    input,
    at: new Date().toISOString(),
    vidiq: null,
    c0: null,
    notes: [],
  };

  const apiKey = opts.apiKey || process.env.VIDIQ_MCP_API_KEY;
  if (apiKey) {
    try {
      row.vidiq = await vidiq.callTool(
        scenario.vidiqTool,
        scenario.vidiqArgs(input),
        { apiKey, fetchImpl: opts.fetchImpl },
      );
    } catch (e) {
      row.vidiq = { error: e.message };
    }
  } else {
    row.notes.push('VIDIQ_MCP_API_KEY not set — vidIQ side skipped');
  }

  try {
    row.c0 = await scenario.c0(input, opts);
  } catch (e) {
    row.c0 = { error: e.message };
  }

  if (scenario.summarize) row.summary = scenario.summarize(row);
  return row;
}

async function runBenchmarkSuite(input = {}, opts = {}) {
  const ids = opts.scenarios || Object.keys(SCENARIOS);
  const results = [];
  for (const id of ids) {
    results.push(await runScenario(id, input, opts));
  }
  return {
    ok: true,
    at: new Date().toISOString(),
    vidiqConfigured: vidiq.isConfigured() || !!opts.apiKey,
    channelScope: {
      c0: 'ClipzWorld News Content Memory + configured competitors',
      vidiq: 'Platform-wide (135M+ channels)',
    },
    results,
  };
}

module.exports = {
  SCENARIOS,
  listScenarios,
  runScenario,
  runBenchmarkSuite,
};
