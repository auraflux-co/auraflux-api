'use strict';
/**
 * CPD-1208 — Post-publish A/B rotation for titles and thumbnails.
 *
 * TubeBuddy-style testing, autonomous: variants rotate on a fixed period
 * (default 24h, aligned with how YouTube reports daily analytics), views-per-
 * hour is the comparison rate (impressions/CTR are not exposed per-video by
 * the Analytics API), and a two-rate z-test at 95% picks the winner once each
 * variant has enough evidence.
 *
 * YouTube calls are injectable (opts.yt) so tests run without network:
 *   yt.getVideoStatistics(videoId) -> { viewCount }
 *   yt.updateVideoTitle(videoId, title) -> bool
 *   yt.setVideoThumbnail(videoId, path) -> bool
 */

const { getDb } = require('../db');
const memory = require('./memory');

const ROTATION_HOURS_DEFAULT = 24;
const MIN_PERIODS_PER_VARIANT = 2;
const MIN_TOTAL_VIEWS = 100;
const Z_95 = 1.96;

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function rowToTest(row) {
  if (!row) return null;
  return {
    id: row.id,
    platformVideoId: row.platform_video_id,
    jobId: row.job_id,
    kind: row.kind,
    variantA: parseJson(row.variant_a_json, null),
    variantB: parseJson(row.variant_b_json, null),
    activeVariant: row.active_variant,
    periods: parseJson(row.periods_json, []),
    status: row.status,
    winner: row.winner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultYt() {
  const {
    getVideoStatistics,
    updateVideoTitle,
    setVideoThumbnail,
  } = require('../services/youtube_direct');
  return { getVideoStatistics, updateVideoTitle, setVideoThumbnail };
}

async function applyVariant(test, variantKey, yt) {
  const variant = variantKey === 'a' ? test.variantA : test.variantB;
  if (test.kind === 'title') return yt.updateVideoTitle(test.platformVideoId, variant.title);
  if (test.kind === 'thumbnail') return yt.setVideoThumbnail(test.platformVideoId, variant.path);
  throw new Error(`Unknown ab test kind: ${test.kind}`);
}

/**
 * Start a test. Variant A is assumed to be what is currently live —
 * we only open the measurement period; no API write happens until rotation.
 */
async function startTest({ platformVideoId, jobId, kind, variantA, variantB }, opts = {}) {
  if (!platformVideoId || !kind || !variantA || !variantB) {
    throw new Error('platformVideoId, kind, variantA, variantB are required');
  }
  const yt = opts.yt || defaultYt();
  const stats = await yt.getVideoStatistics(platformVideoId);
  if (!stats) throw new Error(`Video not found on YouTube: ${platformVideoId}`);
  const now = opts.now || Date.now();
  const periods = [{ variant: 'a', startedAt: now, startViews: stats?.viewCount || 0 }];

  const db = getDb();
  const info = db.prepare(`
    INSERT INTO content_memory_ab_tests
      (platform_video_id, job_id, kind, variant_a_json, variant_b_json, active_variant, periods_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'a', ?, 'running', ?, ?)
  `).run(platformVideoId, jobId || null, kind, JSON.stringify(variantA), JSON.stringify(variantB), JSON.stringify(periods), now, now);

  return getTest(info.lastInsertRowid);
}

function getTest(id) {
  const db = getDb();
  return rowToTest(db.prepare('SELECT * FROM content_memory_ab_tests WHERE id = ?').get(id));
}

function listTests({ status, limit = 50 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM content_memory_ab_tests WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM content_memory_ab_tests ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(rowToTest);
}

function saveTest(test) {
  const db = getDb();
  db.prepare(`
    UPDATE content_memory_ab_tests
    SET active_variant = ?, periods_json = ?, status = ?, winner = ?, updated_at = ?
    WHERE id = ?
  `).run(test.activeVariant, JSON.stringify(test.periods), test.status, test.winner || null, Date.now(), test.id);
  return getTest(test.id);
}

/** Aggregate closed periods into per-variant totals (views + hours). */
function variantTotals(periods) {
  const totals = { a: { views: 0, hours: 0, periods: 0 }, b: { views: 0, hours: 0, periods: 0 } };
  for (const p of periods) {
    if (p.endedAt == null || p.endViews == null) continue;
    const t = totals[p.variant];
    if (!t) continue;
    t.views += Math.max(0, p.endViews - p.startViews);
    t.hours += (p.endedAt - p.startedAt) / 3_600_000;
    t.periods += 1;
  }
  return totals;
}

/**
 * Two-rate z-test on views/hour. Returns { decided, winner, z, rates }.
 * Rates modelled as Poisson: z = (r1 - r2) / sqrt(r1/t1 + r2/t2).
 */
function evaluate(periods, opts = {}) {
  const minPeriods = opts.minPeriods ?? MIN_PERIODS_PER_VARIANT;
  const minViews = opts.minViews ?? MIN_TOTAL_VIEWS;
  const totals = variantTotals(periods);
  const { a, b } = totals;

  const result = {
    decided: false,
    winner: null,
    z: null,
    rates: {
      a: a.hours > 0 ? a.views / a.hours : 0,
      b: b.hours > 0 ? b.views / b.hours : 0,
    },
    totals,
  };

  if (a.periods < minPeriods || b.periods < minPeriods) return result;
  if (a.views + b.views < minViews) return result;
  if (a.hours <= 0 || b.hours <= 0) return result;

  const ra = a.views / a.hours;
  const rb = b.views / b.hours;
  const se = Math.sqrt(ra / a.hours + rb / b.hours);
  if (se === 0) return result;

  const z = (ra - rb) / se;
  result.z = z;
  if (Math.abs(z) >= (opts.zThreshold ?? Z_95)) {
    result.decided = true;
    result.winner = z > 0 ? 'a' : 'b';
  }
  return result;
}

/**
 * Rotate all running tests whose current period is older than rotationHours.
 * Closes the period with fresh view counts, evaluates, and either applies the
 * winner (test complete) or flips to the other variant for the next period.
 */
async function rotateDue(opts = {}) {
  const yt = opts.yt || defaultYt();
  const now = opts.now || Date.now();
  const rotationMs = (opts.rotationHours || ROTATION_HOURS_DEFAULT) * 3_600_000;

  const results = [];
  for (const test of listTests({ status: 'running' })) {
    const current = test.periods[test.periods.length - 1];
    if (!current || now - current.startedAt < rotationMs) continue;

    try {
      const stats = await yt.getVideoStatistics(test.platformVideoId);
      current.endedAt = now;
      current.endViews = stats?.viewCount ?? current.startViews;

      const verdict = evaluate(test.periods, opts);
      if (verdict.decided) {
        test.status = 'complete';
        test.winner = verdict.winner;
        await applyVariant(test, verdict.winner, yt);
        test.activeVariant = verdict.winner;
        memory.recordDecision({
          jobId: test.jobId || test.platformVideoId,
          kind: 'ab_test_winner',
          choice: {
            testId: test.id,
            kind: test.kind,
            winner: verdict.winner,
            variant: verdict.winner === 'a' ? test.variantA : test.variantB,
          },
          reasons: [`z=${verdict.z?.toFixed(2)} rateA=${verdict.rates.a.toFixed(2)}/h rateB=${verdict.rates.b.toFixed(2)}/h`],
          outcome: verdict.totals,
        });
      } else {
        const next = test.activeVariant === 'a' ? 'b' : 'a';
        await applyVariant(test, next, yt);
        test.activeVariant = next;
        test.periods.push({ variant: next, startedAt: now, startViews: current.endViews });
      }
      results.push({ ok: true, testId: test.id, status: test.status, winner: test.winner, activeVariant: test.activeVariant, z: verdict.z });
      saveTest(test);
    } catch (e) {
      results.push({ ok: false, testId: test.id, error: e.message });
    }
  }
  return { ok: true, rotated: results.length, results };
}

module.exports = {
  startTest,
  getTest,
  listTests,
  rotateDue,
  evaluate,
  variantTotals,
};
