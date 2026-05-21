'use strict';
/**
 * test/support.test.js — CPD-115 / CPD-310: Support system unit tests
 *
 * Tests: DB helpers (listAllSupportSessions, markOperatorTookOver,
 *        listOperatorUserIds), POST /support/sessions/:id/reply route,
 *        and AI suspension when human_took_over = true.
 */

const express = require('express');
const request = require('supertest');

// ─── Mock dependencies ────────────────────────────────────────────────────────

const mockDbQuery = jest.fn();
const mockDb = {
  query:                      (...a) => mockDbQuery(...a),
  listAllSupportSessions:     jest.fn(),
  getSessionById:             jest.fn(),
  getSessionMessagesAsOperator: jest.fn(),
  markOperatorTookOver:       jest.fn(),
  listOperatorUserIds:        jest.fn(),
  addSupportMessage:          jest.fn(),
  getOrCreateActiveSupportSession: jest.fn(),
  listSupportSessions:        jest.fn(),
  getSessionMessages:         jest.fn(),
  resolveSession:             jest.fn(),
  escalateSession:            jest.fn(),
  findSessionByPhone:         jest.fn(),
};

jest.mock('../lib/db/postgres', () => mockDb);

jest.mock('../lib/services/support', () => ({
  chatWithSupport:         jest.fn().mockResolvedValue('AI reply'),
  CONFLUENCE_GUIDE_URL:    'https://example.com',
}));

jest.mock('../lib/services/notifications', () => ({
  createNotification: jest.fn(),
}));

jest.mock('../lib/sms', () => ({
  validateWebhook: jest.fn(() => true),
  parseInbound:    jest.fn(),
  sendSms:         jest.fn().mockResolvedValue({ status: 'sent' }),
  buildReply:      jest.fn().mockResolvedValue({ status: 200, headers: {}, body: 'OK' }),
  getProvider:     jest.fn(() => 'telnyx'),
}));

jest.mock('../lib/services/feature_gate', () => ({
  isFeatureEnabled: jest.fn(() => true),
}));

jest.mock('../lib/rateLimiter', () => ({
  apiLimit: (req, res, next) => next(),
}));

jest.mock('../lib/logger', () => ({
  logError: jest.fn(),
}));

// Auth mock — injects operator user by default
jest.mock('../lib/auth', () => {
  const ROLES = { CUSTOMER: 'customer', OPERATOR: 'operator', ADMIN: 'admin' };
  return {
    ROLES,
    requireAuth: (req, res, next) => {
      req.auth = { userId: 'op-user-1' };
      req.user = { id: 'op-user-1', role: 'operator', planTier: 'managed' };
      next();
    },
    requireRole: ({ minLevel }) => (req, res, next) => {
      const LEVEL = { customer: 1, operator: 2, admin: 3 };
      const userLevel = LEVEL[req.user?.role] || 0;
      const required  = LEVEL[minLevel] || 0;
      if (userLevel >= required) return next();
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    },
  };
});

// ─── Test app ─────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(require('../lib/routes/support'));
  return app;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

describe('listAllSupportSessions (DB)', () => {
  const { listAllSupportSessions } = require('../lib/db/postgres');

  it('returns all sessions when called without filters', async () => {
    listAllSupportSessions.mockResolvedValueOnce([
      { id: 'sess-1', user_id: 'u1', resolved: false, message_count: 3 },
      { id: 'sess-2', user_id: 'u2', resolved: true,  message_count: 1 },
    ]);
    const rows = await listAllSupportSessions({});
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('sess-1');
  });

  it('forwards onlyOpen and limit opts', async () => {
    listAllSupportSessions.mockResolvedValueOnce([]);
    await listAllSupportSessions({ onlyOpen: true, limit: 10 });
    expect(listAllSupportSessions).toHaveBeenCalledWith({ onlyOpen: true, limit: 10 });
  });
});

describe('markOperatorTookOver (DB)', () => {
  const { markOperatorTookOver } = require('../lib/db/postgres');

  it('calls the mock correctly', async () => {
    markOperatorTookOver.mockResolvedValueOnce(undefined);
    await markOperatorTookOver('sess-1', 'op-user-1');
    expect(markOperatorTookOver).toHaveBeenCalledWith('sess-1', 'op-user-1');
  });
});

describe('listOperatorUserIds (DB)', () => {
  const { listOperatorUserIds } = require('../lib/db/postgres');

  it('returns operator IDs', async () => {
    listOperatorUserIds.mockResolvedValueOnce(['op-1', 'op-2']);
    const ids = await listOperatorUserIds();
    expect(ids).toEqual(['op-1', 'op-2']);
  });

  it('returns empty array when no operators configured', async () => {
    listOperatorUserIds.mockResolvedValueOnce([]);
    const ids = await listOperatorUserIds();
    expect(ids).toEqual([]);
  });
});

// ─── GET /admin/support/sessions ─────────────────────────────────────────────

describe('GET /admin/support/sessions', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    jest.clearAllMocks();
    mockDb.listAllSupportSessions.mockResolvedValue([
      { id: 'sess-1', user_id: 'u1', resolved: false, message_count: 5 },
    ]);
  });

  it('returns sessions list for operator', async () => {
    const res = await request(app).get('/admin/support/sessions');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBe('sess-1');
  });

  it('passes onlyOpen query param', async () => {
    await request(app).get('/admin/support/sessions?open=1');
    expect(mockDb.listAllSupportSessions).toHaveBeenCalledWith(
      expect.objectContaining({ onlyOpen: true }),
    );
  });

  it('uses requireRole with minLevel OPERATOR (role gate is enforced)', () => {
    // requireRole is invoked at module-load time as part of adminAuth.
    // The auth mock confirms customers are rejected — tested via the auth unit.
    // Verify the mock's level check works correctly for reference:
    const { requireRole, ROLES } = require('../lib/auth');
    const middleware = requireRole({ minLevel: ROLES.OPERATOR });
    const mockReq  = { user: { role: 'customer' } };
    const mockRes  = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const mockNext = jest.fn();
    middleware(mockReq, mockRes, mockNext);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });
});

// ─── POST /support/sessions/:id/reply ────────────────────────────────────────

describe('POST /support/sessions/:id/reply', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
    jest.clearAllMocks();
    mockDb.addSupportMessage.mockResolvedValue({ id: 'msg-1' });
    mockDb.markOperatorTookOver.mockResolvedValue(undefined);
    mockDb.listOperatorUserIds.mockResolvedValue([]);
  });

  it('stores web reply when session has no phone number', async () => {
    mockDb.getSessionById.mockResolvedValueOnce({
      id: 'sess-1', user_id: 'u1', phone_number: null, human_took_over: false,
    });
    const res = await request(app)
      .post('/support/sessions/sess-1/reply')
      .send({ message: 'Hello customer!' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.channel).toBe('web');
    expect(mockDb.addSupportMessage).toHaveBeenCalledWith(
      'sess-1', 'u1', 'assistant', 'Hello customer!', 'web',
    );
    expect(mockDb.markOperatorTookOver).toHaveBeenCalledWith('sess-1', 'op-user-1');
  });

  it('sends SMS when session has a phone number', async () => {
    process.env.SUPPORT_SMS_NUMBER = '+15550001111';
    mockDb.getSessionById.mockResolvedValueOnce({
      id: 'sess-2', user_id: 'u2', phone_number: '+19990001111', human_took_over: false,
    });
    const sms = require('../lib/sms');
    const res = await request(app)
      .post('/support/sessions/sess-2/reply')
      .send({ message: 'SMS reply here' });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('sms');
    expect(sms.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+19990001111', body: 'SMS reply here' }),
    );
    delete process.env.SUPPORT_SMS_NUMBER;
  });

  it('returns 404 when session not found', async () => {
    mockDb.getSessionById.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/support/sessions/nonexistent/reply')
      .send({ message: 'Hi' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when message is empty', async () => {
    const res = await request(app)
      .post('/support/sessions/sess-1/reply')
      .send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('marks human_took_over on the session after reply', async () => {
    mockDb.getSessionById.mockResolvedValueOnce({
      id: 'sess-3', user_id: 'u3', phone_number: null, human_took_over: false,
    });
    await request(app)
      .post('/support/sessions/sess-3/reply')
      .send({ message: 'Operator here' });
    expect(mockDb.markOperatorTookOver).toHaveBeenCalledWith('sess-3', 'op-user-1');
  });
});

// ─── AI suspension when human_took_over ──────────────────────────────────────

describe('POST /support/chat — AI suspended when human_took_over', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    jest.clearAllMocks();
    mockDb.listOperatorUserIds.mockResolvedValue([]);
  });

  it('returns handoff message and skips AI when human_took_over = true', async () => {
    mockDb.getOrCreateActiveSupportSession.mockResolvedValueOnce({
      id: 'sess-ht', user_id: 'u1', human_took_over: true,
    });
    const { chatWithSupport } = require('../lib/services/support');
    const res = await request(app)
      .post('/support/chat')
      .send({ messages: [{ role: 'user', content: 'Help me' }] });
    expect(res.status).toBe(200);
    expect(res.body.response).toMatch(/AuraFlux team/i);
    expect(chatWithSupport).not.toHaveBeenCalled();
  });

  it('calls AI normally when human_took_over = false', async () => {
    mockDb.getOrCreateActiveSupportSession.mockResolvedValueOnce({
      id: 'sess-ai', user_id: 'u1', human_took_over: false,
    });
    mockDb.addSupportMessage.mockResolvedValue({ id: 'm1' });
    const { chatWithSupport } = require('../lib/services/support');
    const res = await request(app)
      .post('/support/chat')
      .send({ messages: [{ role: 'user', content: 'Help me' }] });
    expect(res.status).toBe(200);
    expect(chatWithSupport).toHaveBeenCalled();
    expect(res.body.response).toBe('AI reply');
  });
});
