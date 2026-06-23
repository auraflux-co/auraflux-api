'use strict';

/** ClipzWorld YouTube north star — env-driven targets (CWN dashboard only). */
function getNorthStarConfig() {
  return {
    dailyUsdTarget: Number(process.env.CWN_NORTH_STAR_DAILY_USD) || 300,
    /** Interim progress bar when revenue OAuth scope missing */
    viewsProxyPerDay: Number(process.env.CWN_NORTH_STAR_VIEWS_PROXY) || 100_000,
    analyticsWindowDays: Number(process.env.CWN_NORTH_STAR_WINDOW_DAYS) || 28,
    ageMatrixDays: Number(process.env.CWN_NORTH_STAR_AGE_DAYS) || 28,
    cadence: {
      shorts: { min: Number(process.env.CWN_CADENCE_SHORTS_MIN) || 3, max: Number(process.env.CWN_CADENCE_SHORTS_MAX) || 5 },
      videos: { min: Number(process.env.CWN_CADENCE_VIDEOS_MIN) || 1, max: Number(process.env.CWN_CADENCE_VIDEOS_MAX) || 2 },
      streams: { min: Number(process.env.CWN_CADENCE_STREAMS_MIN) || 0, max: Number(process.env.CWN_CADENCE_STREAMS_MAX) || 2 },
    },
    backCatalogTargetPct: Number(process.env.CWN_BACK_CATALOG_TARGET_PCT) || 30,
  };
}

module.exports = { getNorthStarConfig };
