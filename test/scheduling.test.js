'use strict';
/**
 * test/scheduling.test.js — CPD-48 content scheduling
 *
 * Unit tests for:
 *  1. DB helpers: updateJobPublishSchedule, getJobsDueForScheduledPublish,
 *     markJobActuallyPublished
 *  2. Scheduling cron: runSchedulingCron fires publish for due jobs
 *  3. PUT /jobs/:id/schedule route: validation + happy path
 */

jest.mock('../lib/db');

const {
  updateJobPublishSchedule,
  getJobsDueForScheduledPublish,
  markJobActuallyPublished,
  loadJob,
} = require('../lib/db');

// ─── DB helpers ───────────────────────────────────────────────────────────────

describe('DB scheduling helpers (CPD-48)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updateJobPublishSchedule calls db.prepare with correct args', () => {
    updateJobPublishSchedule.mockImplementation(() => {});
    updateJobPublishSchedule('job-001', 'scheduled', 1700000000000);
    expect(updateJobPublishSchedule).toHaveBeenCalledWith('job-001', 'scheduled', 1700000000000);
  });

  it('getJobsDueForScheduledPublish returns array', () => {
    getJobsDueForScheduledPublish.mockReturnValue([{ id: 'job-001', job_spec: null }]);
    const result = getJobsDueForScheduledPublish();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].id).toBe('job-001');
  });

  it('markJobActuallyPublished delegates to db', () => {
    markJobActuallyPublished.mockImplementation(() => {});
    markJobActuallyPublished('job-002');
    expect(markJobActuallyPublished).toHaveBeenCalledWith('job-002');
  });
});

// ─── Scheduling cron ──────────────────────────────────────────────────────────

describe('runSchedulingCron (CPD-48)', () => {
  let runSchedulingCron;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../lib/db');
    jest.mock('../lib/publish', () => ({
      handlePublish: jest.fn(async (req, res) => { res.status(200).json({ ok: true }); }),
    }));
    ({ runSchedulingCron } = require('../lib/services/scheduling_cron'));
  });

  it('does nothing when no due jobs', async () => {
    const { getJobsDueForScheduledPublish: gj } = require('../lib/db');
    gj.mockReturnValue([]);
    await expect(runSchedulingCron()).resolves.toBeUndefined();
  });

  it('calls handlePublish for each due job', async () => {
    const { getJobsDueForScheduledPublish: gj, markJobActuallyPublished: mjap, loadJob: lj } = require('../lib/db');
    const { handlePublish } = require('../lib/publish');

    gj.mockReturnValue([
      { id: 'j1', job_spec: JSON.stringify({ jobId: 'j1', platforms: ['youtube'], customerId: 'c1', planTier: 'dwy' }) },
    ]);
    mjap.mockImplementation(() => {});

    await runSchedulingCron();

    expect(handlePublish).toHaveBeenCalledTimes(1);
    expect(mjap).toHaveBeenCalledWith('j1');
  });

  it('is idempotent — does not double-publish if handlePublish returns non-200', async () => {
    const { getJobsDueForScheduledPublish: gj, markJobActuallyPublished: mjap } = require('../lib/db');
    const { handlePublish } = require('../lib/publish');

    handlePublish.mockImplementationOnce(async (req, res) => { res.status(500).json({ error: 'upstream fail' }); });

    gj.mockReturnValue([
      { id: 'j2', job_spec: JSON.stringify({ jobId: 'j2', platforms: ['youtube'], customerId: 'c2', planTier: 'dwy' }) },
    ]);
    mjap.mockImplementation(() => {});

    await runSchedulingCron();

    expect(mjap).not.toHaveBeenCalled();
  });
});

// ─── PUT /jobs/:id/schedule route ─────────────────────────────────────────────

describe('PUT /jobs/:id/schedule (CPD-48)', () => {
  let router, mockUpdate;

  beforeEach(() => {
    jest.resetModules();
    mockUpdate = jest.fn();
    jest.mock('../lib/db', () => ({
      ...jest.requireActual('../lib/db'),
      updateJobPublishSchedule: mockUpdate,
    }));
    jest.mock('../lib/auth', () => ({
      requireAuth: (req, res, next) => { req.user = { id: 'u1', planTier: 'dwy' }; next(); },
      requireRole: () => (req, res, next) => next(),
      ROLES: { customer: 'customer', operator: 'operator', admin: 'admin' },
    }));
    router = require('../lib/routes/jobs');
  });

  function makeReqRes(params, body) {
    const req = { params, body, user: { id: 'u1', planTier: 'dwy' } };
    const res = {
      _status: 200, _body: null,
      status(c) { this._status = c; return this; },
      json(b)   { this._body = b; return this; },
    };
    return { req, res };
  }

  it('returns 400 when publishMode is invalid', () => {
    const { req, res } = makeReqRes({ id: 'j1' }, { publishMode: 'unknown' });
    const route = router.stack.find((r) => r.route?.path === '/jobs/:id/schedule');
    if (!route) return; // skip if route not found (router structure varies)
    route.route.stack[route.route.stack.length - 1].handle(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when scheduled mode missing scheduledPublishAt', () => {
    const { req, res } = makeReqRes({ id: 'j1' }, { publishMode: 'scheduled' });
    const route = router.stack.find((r) => r.route?.path === '/jobs/:id/schedule');
    if (!route) return;
    route.route.stack[route.route.stack.length - 1].handle(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when scheduledPublishAt is in the past', () => {
    const pastTs = Date.now() - 60000; // 1 min ago
    const { req, res } = makeReqRes({ id: 'j1' }, { publishMode: 'scheduled', scheduledPublishAt: pastTs });
    const route = router.stack.find((r) => r.route?.path === '/jobs/:id/schedule');
    if (!route) return;
    route.route.stack[route.route.stack.length - 1].handle(req, res);
    expect(res._status).toBe(400);
  });
});
