'use strict';

const { parseYmd, daysBetween, ymdAddDays, yesterdayYmd } = require('./north_star_stats');

const DEFAULT_DAYS = Number(process.env.CWN_NORTH_STAR_WINDOW_DAYS) || 28;
const MAX_DAYS = Number(process.env.CWN_NORTH_STAR_MAX_DAYS) || 90;

/**
 * Resolve reporting window from query opts (days preset, or explicit start/end).
 * @returns {{ startDate: string, endDate: string, days: number, focusDate: string }}
 */
function resolveReportingRange(opts = {}) {
  let endDate = String(opts.endDate || '').slice(0, 10) || yesterdayYmd();
  let startDate = String(opts.startDate || '').slice(0, 10) || '';

  const presetDays = Number(opts.days);
  if (!startDate && Number.isFinite(presetDays) && presetDays > 0) {
    startDate = ymdAddDays(endDate, -(Math.min(presetDays, MAX_DAYS) - 1));
  }

  if (!startDate) {
    startDate = ymdAddDays(endDate, -(DEFAULT_DAYS - 1));
  }

  if (parseYmd(startDate) == null || parseYmd(endDate) == null) {
    throw new Error('Invalid reporting dates — use YYYY-MM-DD');
  }
  if (startDate > endDate) {
    throw new Error('startDate must be on or before endDate');
  }

  let span = daysBetween(endDate, startDate) + 1;
  if (span > MAX_DAYS) {
    startDate = ymdAddDays(endDate, -(MAX_DAYS - 1));
    span = MAX_DAYS;
  }

  return {
    startDate,
    endDate,
    days: span,
    focusDate: endDate,
  };
}

module.exports = {
  resolveReportingRange,
  MAX_DAYS,
  DEFAULT_DAYS,
};
