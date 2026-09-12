'use strict';
/**
 * Creator Schedule month APIs — brand cadence plan vs published jobs.
 *
 * GET  /schedule/month?month=YYYY-MM
 * PUT  /schedule/month/day
 * PUT  /schedule/month/defaults
 * GET  /schedule/month/eligible-jobs
 * POST /schedule/month/schedule-job
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const db = require('../db');
const {
  parseYearMonth,
  normalizePlan,
  setDayPlan,
  setMonthDefaults,
  buildMonthView,
  listEligibleJobs,
  dateKey,
} = require('../creator_calendar/month_plan');

async function loadBrandPlan(brandId, accountId) {
  const brand = await db.getBrand(brandId, accountId);
  if (!brand) return null;
  return { brand, plan: normalizePlan(brand.calendar_plan) };
}

async function savePlan(brandId, accountId, plan) {
  return db.updateBrand(brandId, accountId, { calendar_plan: plan });
}

function parseJobs(rows) {
  return (rows || []).map((r) => {
    const spec = typeof r.job_spec === 'string'
      ? (() => { try { return JSON.parse(r.job_spec); } catch { return {}; } })()
      : (r.job_spec || {});
    return { ...r, job_spec: spec };
  });
}

router.get('/schedule/month', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const accountId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!accountId || !brandId) return res.status(400).json({ ok: false, error: 'brand_required' });

    const ym = parseYearMonth(req.query.month) || (() => {
      const n = new Date();
      return { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1 };
    })();

    const loaded = await loadBrandPlan(brandId, accountId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'brand_not_found' });

    const rows = await db.listJobsByCustomer(accountId, 200, brandId);
    const view = buildMonthView(loaded.plan, parseJobs(rows), ym.year, ym.month);
    return res.json(view);
  } catch (err) {
    console.error('[schedule/month]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'month_failed' });
  }
});

router.put('/schedule/month/day', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const accountId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!accountId || !brandId) return res.status(400).json({ ok: false, error: 'brand_required' });

    const date = String(req.body?.date || '');
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return res.status(400).json({ ok: false, error: 'date_required_yyyy_mm_dd' });
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);

    const loaded = await loadBrandPlan(brandId, accountId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'brand_not_found' });

    const next = setDayPlan(loaded.plan, year, month, day, {
      short: req.body.short,
      longform: req.body.longform,
      live: req.body.live,
      note: req.body.note,
    });
    await savePlan(brandId, accountId, next);
    const rows = await db.listJobsByCustomer(accountId, 200, brandId);
    const view = buildMonthView(next, parseJobs(rows), year, month);
    return res.json({ ok: true, day: view.daysByDate[dateKey(year, month, day)], month: view });
  } catch (err) {
    console.error('[schedule/month/day]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'day_save_failed' });
  }
});

router.put('/schedule/month/defaults', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const accountId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!accountId || !brandId) return res.status(400).json({ ok: false, error: 'brand_required' });

    const ym = parseYearMonth(req.body?.month || req.query?.month);
    if (!ym) return res.status(400).json({ ok: false, error: 'month_required_yyyy_mm' });

    const loaded = await loadBrandPlan(brandId, accountId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'brand_not_found' });

    const next = setMonthDefaults(loaded.plan, ym.year, ym.month, {
      short: req.body.short,
      longform: req.body.longform,
      live: req.body.live,
    });
    await savePlan(brandId, accountId, next);
    const rows = await db.listJobsByCustomer(accountId, 200, brandId);
    const view = buildMonthView(next, parseJobs(rows), ym.year, ym.month);
    return res.json(view);
  } catch (err) {
    console.error('[schedule/month/defaults]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'defaults_failed' });
  }
});

router.get('/schedule/month/eligible-jobs', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const accountId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!accountId || !brandId) return res.status(400).json({ ok: false, error: 'brand_required' });
    const rows = await db.listJobsByCustomer(accountId, 100, brandId);
    return res.json({ ok: true, jobs: listEligibleJobs(parseJobs(rows), 40) });
  } catch (err) {
    console.error('[schedule/month/eligible-jobs]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'eligible_failed' });
  }
});

router.post('/schedule/month/schedule-job', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const accountId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!accountId || !brandId) return res.status(400).json({ ok: false, error: 'brand_required' });

    const jobId = String(req.body?.jobId || '');
    const at = String(req.body?.scheduledPublishAt || '');
    const ts = Date.parse(at);
    if (!jobId || Number.isNaN(ts)) {
      return res.status(400).json({ ok: false, error: 'jobId_and_scheduledPublishAt_required' });
    }
    if (ts < Date.now() + 30 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'scheduledPublishAt must be at least 30 minutes in the future' });
    }

    const row = await db.loadJobRow(jobId);
    if (!row || row.customer_id !== accountId) {
      return res.status(404).json({ ok: false, error: 'job_not_found' });
    }
    if (row.brand_id && row.brand_id !== brandId) {
      return res.status(403).json({ ok: false, error: 'brand_mismatch' });
    }

    await db.updateJobPublishSchedule(jobId, 'scheduled', ts);
    // Mirror into job_spec when present
    try {
      const spec = typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : (row.job_spec || {});
      if (spec && typeof spec === 'object') {
        spec.scheduledPublishAt = new Date(ts).toISOString();
        if (!spec.order) spec.order = {};
        if (!spec.order.publish) spec.order.publish = {};
        spec.order.publish.mode = 'scheduled';
        spec.order.publish.scheduledPublishAt = spec.scheduledPublishAt;
        await db.updateJobSpec(jobId, spec);
      }
    } catch (_e) { /* non-fatal */ }

    return res.json({ ok: true, jobId, scheduledPublishAt: new Date(ts).toISOString() });
  } catch (err) {
    console.error('[schedule/month/schedule-job]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'schedule_failed' });
  }
});

module.exports = router;
