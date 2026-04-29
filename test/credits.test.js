'use strict';

/**
 * Unit tests for credit consumption service — CPD-43
 * Uses Jest mocks to isolate business logic from actual DB/pipelineBus.
 */

jest.mock('../lib/db', () => ({
  getClientPlan: jest.fn(),
  getCreditBalance: jest.fn(),
  logCreditEvent: jest.fn(),
  getActivePacks: jest.fn(),
  deductPackCredits: jest.fn(),
  getOrCreateBillingPeriod: jest.fn(),
  getPool: jest.fn(),
}));

jest.mock('../lib/pipeline_events', () => ({ emit: jest.fn() }));

const db = require('../lib/db');
const pipelineBus = require('../lib/pipeline_events');

// Mock pool for both direct queries and transaction client
const mockClient = {
  query: jest.fn().mockResolvedValue({ rows: [] }),
  release: jest.fn(),
};
const mockPool = {
  connect: jest.fn().mockResolvedValue(mockClient),
  query: jest.fn().mockResolvedValue({ rows: [] }),
};
db.getPool.mockReturnValue(mockPool);

const { consumeCredits } = require('../lib/services/credits');

const BASE_PLAN = {
  client_id: 'test_client',
  tier: 'diy',
  credits_included: 50,
  overage_price_cents: 25,
  billing_anchor_day: 1,
  overage_cap_credits: null,
};

const BASE_BALANCE = {
  includedUsed: 0,
  includedRemaining: 50,
  packCredits: 0,
  overageUsed: 0,
  creditsIncluded: 50,
  tier: 'diy',
};

beforeEach(() => {
  jest.clearAllMocks();
  // pool.query for idempotency check and other direct queries
  mockPool.query.mockImplementation(async (sql) => {
    if (typeof sql === 'string' && sql.includes('credit_ledger WHERE job_id')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  // transaction client
  mockClient.query.mockResolvedValue({ rows: [] });
  db.getClientPlan.mockResolvedValue(BASE_PLAN);
  db.getCreditBalance.mockResolvedValue({ ...BASE_BALANCE });
  db.getActivePacks.mockResolvedValue([]);
  db.getOrCreateBillingPeriod.mockResolvedValue({});
});

describe('consumeCredits — first job (included credits available)', () => {
  it('returns ok:true and deducts from included allowance', async () => {
    const result = await consumeCredits('test_client', 'job_001', 5);
    expect(result.ok).toBe(true);
    expect(result.balance).toBeDefined();
    // Should have called BEGIN and COMMIT
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });
});

describe('consumeCredits — idempotency', () => {
  it('returns ALREADY_CHARGED when job_id already in ledger', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('credit_ledger WHERE job_id')) {
        return { rows: [{ id: 1, job_id: 'job_002', credits_used: 5, type: 'included' }] };
      }
      return { rows: [] };
    });
    const result = await consumeCredits('test_client', 'job_002', 5);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('ALREADY_CHARGED');
    // Should NOT have called BEGIN (no transaction started)
    const beginCalls = mockClient.query.mock.calls.filter((c) => c[0] === 'BEGIN');
    expect(beginCalls.length).toBe(0);
  });
});

describe('consumeCredits — 100% included, triggers overage', () => {
  it('charges overage when included credits exhausted', async () => {
    db.getCreditBalance
      .mockResolvedValueOnce({ ...BASE_BALANCE, includedRemaining: 0, includedUsed: 50 })
      .mockResolvedValue({ ...BASE_BALANCE, includedRemaining: 0, includedUsed: 50, overageUsed: 3 });
    const result = await consumeCredits('test_client', 'job_003', 3);
    expect(result.ok).toBe(true);
    // Should have inserted an overage row
    const overageCalls = mockClient.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes("'overage'")
    );
    expect(overageCalls.length).toBeGreaterThan(0);
  });
});

describe('consumeCredits — pack credits (FIFO)', () => {
  it('deducts from pack before included', async () => {
    db.getActivePacks.mockResolvedValue([
      { id: 10, credits_remaining: 100, expires_at: null },
    ]);
    db.getCreditBalance.mockResolvedValue({ ...BASE_BALANCE, packCredits: 100 });
    const result = await consumeCredits('test_client', 'job_004', 10);
    expect(result.ok).toBe(true);
    const packCalls = mockClient.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('credit_packs')
    );
    expect(packCalls.length).toBeGreaterThan(0);
  });
});

describe('consumeCredits — overage cap', () => {
  it('returns PAUSED when overage cap would be exceeded', async () => {
    db.getClientPlan.mockResolvedValue({ ...BASE_PLAN, overage_cap_credits: 5 });
    db.getCreditBalance.mockResolvedValue({
      ...BASE_BALANCE,
      includedRemaining: 0,
      includedUsed: 50,
      overageUsed: 4,
    });
    const result = await consumeCredits('test_client', 'job_005', 10);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('PAUSED');
  });
});

describe('consumeCredits — no plan', () => {
  it('returns NO_PLAN when client has no active plan', async () => {
    db.getClientPlan.mockResolvedValue(null);
    const result = await consumeCredits('unknown_client', 'job_006', 5);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('NO_PLAN');
  });
});

describe('consumeCredits — invalid args', () => {
  it('rejects missing clientId', async () => {
    const result = await consumeCredits(null, 'job_007', 5);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_ARGS');
  });

  it('rejects zero credits', async () => {
    const result = await consumeCredits('test_client', 'job_008', 0);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_ARGS');
  });
});
