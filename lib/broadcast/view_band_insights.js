/**
 * View-band insights for Programming Playbook — feed vs produced + regions.
 */

const fs = require('fs');
const path = require('path');
const { classifyStreamType, isNewsOrSports, STREAM_TYPE_META } = require('./stream_type');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BANDS_PATH = path.join(REPO_ROOT, 'logs', 'youtube_live_view_bands_30d.json');
const RANKED_PATH = path.join(REPO_ROOT, 'logs', 'youtube_live_ranked_full.json');

function loadViewBandsFile() {
  if (!fs.existsSync(BANDS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BANDS_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadRankedPool() {
  if (!fs.existsSync(RANKED_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(RANKED_PATH, 'utf8'));
    return data.ranked || [];
  } catch (_) {
    return [];
  }
}

function countByType(items) {
  const out = { feed: 0, produced: 0, watchparty: 0, mixed: 0 };
  for (const v of items) {
    const { type } = classifyStreamType(v);
    out[type] = (out[type] || 0) + 1;
  }
  return out;
}

function enrichStream(v) {
  const st = classifyStreamType(v);
  return {
    views: v.views,
    title: v.title,
    channel: v.channel,
    url: v.url,
    durationHrs: v.durationHrs,
    streamType: st.type,
    streamTypeLabel: st.label,
    region: st.region,
  };
}

function buildRegionBreakdown(items) {
  const byRegion = {};
  for (const v of items) {
    const { region, type } = classifyStreamType(v);
    if (!byRegion[region]) byRegion[region] = { total: 0, feed: 0, produced: 0, watchparty: 0, mixed: 0, examples: [] };
    const row = byRegion[region];
    row.total++;
    row[type] = (row[type] || 0) + 1;
    if (row.examples.length < 3) row.examples.push(enrichStream(v));
  }
  return Object.entries(byRegion)
    .map(([region, stats]) => ({ region, ...stats }))
    .sort((a, b) => b.total - a.total);
}

function buildViewBandInsights() {
  const bandsFile = loadViewBandsFile();
  const ranked = loadRankedPool();
  const newsSportsMid = ranked.filter((v) => v.views >= 5000 && v.views < 160000 && isNewsOrSports(v));

  const bands = (bandsFile?.bands || []).map((b) => {
    const streams = (b.streams || []).map(enrichStream);
    const typeCounts = countByType(b.streams || []);
    return {
      label: b.label,
      count: b.count,
      summary: b.summary,
      typeCounts,
      dominantCategories: (b.categoryBreakdown || []).slice(0, 3).map((c) => c.category.replace(/_/g, ' ')),
      examples: streams.slice(0, 8),
    };
  });

  const midBandTypeCounts = countByType(newsSportsMid);

  return {
    generatedAt: bandsFile?.generatedAt || null,
    sourceNote: bandsFile?.windowNote || 'Run scripts/youtube_live_hybrid_collect.js + youtube_live_view_bands.js',
    poolSize: bandsFile?.totalLiveVodsInPool || ranked.length,
    atLeast5k: bandsFile?.atLeast5000Views || ranked.filter((v) => v.views >= 5000).length,
    bands,
    newsSports5kTo160k: {
      count: newsSportsMid.length,
      typeCounts: midBandTypeCounts,
      regions: buildRegionBreakdown(newsSportsMid),
      note: 'Local news & sports in the 5k–160k band — mostly India/UK cricket + court/weather feeds, not US DMA newscasts.',
    },
    streamTypeLegend: Object.entries(STREAM_TYPE_META).map(([id, m]) => ({
      id,
      label: m.label,
      short: m.short,
      clipzworld: m.clipzworld,
    })),
  };
}

module.exports = { buildViewBandInsights, enrichStream, countByType };
