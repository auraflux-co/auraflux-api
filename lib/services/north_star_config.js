'use strict';

/** ClipzWorld YouTube north star — env-driven targets (CWN dashboard only). */
function getNorthStarConfig() {
  const projectionOn = String(process.env.CWN_NORTH_STAR_PROJECTION || 'on').toLowerCase();
  return {
    dailyUsdTarget: Number(process.env.CWN_NORTH_STAR_DAILY_USD) || 300,
    viewsProxyPerDay: Number(process.env.CWN_NORTH_STAR_VIEWS_PROXY) || 100_000,
    analyticsWindowDays: Number(process.env.CWN_NORTH_STAR_WINDOW_DAYS) || 28,
    ageMatrixDays: Number(process.env.CWN_NORTH_STAR_AGE_DAYS) || 28,
    projectionEnabled: projectionOn !== 'off' && projectionOn !== '0' && projectionOn !== 'false',
    projectedRpm: {
      shorts: Number(process.env.CWN_PROJECTED_RPM_SHORTS) || 0.03,
      videos: Number(process.env.CWN_PROJECTED_RPM_VIDEOS) || 3.5,
      streams: Number(process.env.CWN_PROJECTED_RPM_STREAMS) || 2,
    },
    cadence: {
      shorts: { min: Number(process.env.CWN_CADENCE_SHORTS_MIN) || 3, max: Number(process.env.CWN_CADENCE_SHORTS_MAX) || 5 },
      videos: { min: Number(process.env.CWN_CADENCE_VIDEOS_MIN) || 1, max: Number(process.env.CWN_CADENCE_VIDEOS_MAX) || 2 },
      streams: { min: Number(process.env.CWN_CADENCE_STREAMS_MIN) || 0, max: Number(process.env.CWN_CADENCE_STREAMS_MAX) || 2 },
    },
    backCatalogTargetPct: Number(process.env.CWN_BACK_CATALOG_TARGET_PCT) || 30,
  };
}

module.exports = { getNorthStarConfig };
