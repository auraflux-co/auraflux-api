'use strict';

/**
 * Match calendar production items to channel catalog rows for KPI breakdown.
 */

function catalogVideoId(item = {}) {
  if (item.video_id) return item.video_id;
  if (item.videoId) return item.videoId;
  const url = item.url || '';
  const m = String(url).match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

function catalogFormatFromTab(tab) {
  if (tab === 'shorts') return 'short';
  if (tab === 'streams') return 'live';
  return 'longform';
}

function catalogViews(item = {}) {
  const a = item.analytics || {};
  if (a.views != null && !Number.isNaN(Number(a.views))) return Number(a.views);
  if (item.views != null && !Number.isNaN(Number(item.views))) return Number(item.views);
  return 0;
}

function catalogEngaged(item = {}) {
  const a = item.analytics || {};
  if (a.engagedViews != null) return Number(a.engagedViews) || 0;
  if (item.engaged_views != null) return Number(item.engaged_views) || 0;
  return 0;
}

function catalogSubsGained(item = {}) {
  const a = item.analytics || {};
  if (a.subscribersGained != null) return Number(a.subscribersGained) || 0;
  if (item.subs_gained != null) return Number(item.subs_gained) || 0;
  return 0;
}

function indexCatalogByVideoId(catalogItems = []) {
  const map = new Map();
  for (const row of catalogItems || []) {
    const id = catalogVideoId(row);
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

/**
 * @param {object} opts
 * @param {object[]} opts.calendarItems — from buildCalendarRangeReport actual.items
 * @param {object[]} opts.catalogItems — channel stats catalog.items
 * @param {object} [opts.jobVideoMap] — jobId → youtubeVideoId
 */
function buildCalendarStatsKpis({ calendarItems = [], catalogItems = [], jobVideoMap = {} } = {}) {
  const byId = indexCatalogByVideoId(catalogItems);
  const byFormat = {
    short: { planned: 0, actual: 0, matched: 0, views: 0, engaged: 0, subs: 0 },
    longform: { planned: 0, actual: 0, matched: 0, views: 0, engaged: 0, subs: 0 },
    live: { planned: 0, actual: 0, matched: 0, views: 0, engaged: 0, subs: 0 },
  };

  const rows = [];
  let totalViews = 0;
  let totalEngaged = 0;
  let totalSubs = 0;
  let matchedCount = 0;

  for (const ci of calendarItems || []) {
    const fmt = ci.format || 'longform';
    if (byFormat[fmt]) byFormat[fmt].actual += 1;

    const vid = ci.youtubeVideoId || jobVideoMap[ci.jobId] || null;
    const cat = vid ? byId.get(vid) : null;
    const views = cat ? catalogViews(cat) : 0;
    const engaged = cat ? catalogEngaged(cat) : 0;
    const subs = cat ? catalogSubsGained(cat) : 0;

    if (cat) {
      matchedCount += 1;
      if (byFormat[fmt]) {
        byFormat[fmt].matched += 1;
        byFormat[fmt].views += views;
        byFormat[fmt].engaged += engaged;
        byFormat[fmt].subs += subs;
      }
      totalViews += views;
      totalEngaged += engaged;
      totalSubs += subs;
    }

    rows.push({
      jobId: ci.jobId || null,
      youtubeVideoId: vid,
      title: ci.title || ci.jobId || 'Untitled',
      format: fmt,
      pillar: ci.pillar || null,
      status: ci.status || null,
      timeEt: ci.timeEt || null,
      publishAt: ci.at || ci.publishAt || null,
      views,
      engaged,
      subsGained: subs,
      matched: !!cat,
      url: ci.url || (vid ? `https://www.youtube.com/watch?v=${vid}` : null),
      catalogTab: cat ? (cat.tab || cat.surface) : null,
    });
  }

  rows.sort((a, b) => {
    const ta = new Date(a.publishAt || 0).getTime();
    const tb = new Date(b.publishAt || 0).getTime();
    return ta - tb;
  });

  return {
    ok: true,
    totalItems: (calendarItems || []).length,
    matchedCount,
    unmatchedCount: (calendarItems || []).length - matchedCount,
    totalViews,
    totalEngaged,
    totalSubs,
    byFormat,
    rows,
  };
}

module.exports = {
  buildCalendarStatsKpis,
  catalogVideoId,
  catalogFormatFromTab,
};
