'use strict';
/**
 * test/concierge.test.js — CPD-83 / CPD-309: AI Concierge backend unit tests
 *
 * Tests: getPortalContracts, validateJobSpec, buildSystemPrompt,
 *        buildSystemStatus, chatWithConcierge (mocked)
 */

const {
  getPortalContracts,
  validateJobSpec,
  buildSystemPrompt,
  buildSystemStatus,
  chatWithConcierge,
  PORTAL_CONTRACTS,
} = require('../lib/services/concierge');

// ─── Mock dependencies ────────────────────────────────────────────────────────

jest.mock('../lib/services/gemini', () => ({
  callGeminiChat: jest.fn(),
  isConfigured:   jest.fn(() => true),
}));

jest.mock('../lib/services/feature_gate', () => ({
  isFeatureEnabled: jest.fn((feature, plan) => {
    if (feature === 'concierge') return plan === 'guided' || plan === 'managed' || plan === 'custom';
    return true;
  }),
}));

// DB mock — used by buildSystemStatus and buildCustomerMemory
const mockDbQuery = jest.fn();
jest.mock('../lib/db', () => ({
  query:              (...args) => mockDbQuery(...args),
  listJobsByCustomer: jest.fn().mockResolvedValue([]),
  listTemplates:      jest.fn().mockResolvedValue([]),
}));

const { callGeminiChat, isConfigured } = require('../lib/services/gemini');

// ─── getPortalContracts ───────────────────────────────────────────────────────

describe('getPortalContracts', () => {
  it('returns an array of portal contracts', () => {
    const contracts = getPortalContracts();
    expect(Array.isArray(contracts)).toBe(true);
    expect(contracts.length).toBeGreaterThanOrEqual(7);
  });

  it('is the same reference as PORTAL_CONTRACTS', () => {
    expect(getPortalContracts()).toBe(PORTAL_CONTRACTS);
  });

  it('each contract has portal, label, description, required fields', () => {
    for (const c of getPortalContracts()) {
      expect(c).toHaveProperty('portal');
      expect(c).toHaveProperty('label');
      expect(c).toHaveProperty('description');
      expect(Array.isArray(c.required)).toBe(true);
    }
  });

  it('includes portal0 through portal5', () => {
    const ids = getPortalContracts().map((c) => c.portal);
    expect(ids).toContain('portal0');
    expect(ids).toContain('portal1');
    expect(ids).toContain('portal2');
    expect(ids).toContain('portal3a');
    expect(ids).toContain('portal3b');
    expect(ids).toContain('portal4');
    expect(ids).toContain('portal5');
  });
});

// ─── validateJobSpec ──────────────────────────────────────────────────────────

describe('validateJobSpec', () => {
  it('fails with empty spec', () => {
    const result = validateJobSpec({});
    expect(result.overall).toBe('fail');
    expect(result.blockedPortals.length).toBeGreaterThan(0);
    expect(result.readyPortals.length).toBe(0);
  });

  it('partial spec gives partial result', () => {
    const spec = {
      jobId:       'abc-123',
      contentType: 'news-long',
      entryType:   'fetch',
      customerId:  'cust-1',
      deliverySpec: { platforms: ['youtube'] },
      fetchSpec:    { sourceUrls: ['https://example.com'] },
    };
    const result = validateJobSpec(spec);
    expect(result.portals[0].ready).toBe(true);  // portal0 ready
    expect(result.overall).toBe('partial');
  });

  it('portal0 passes when all required + conditional fields present', () => {
    const spec = {
      jobId:       'abc-123',
      contentType: 'news-long',
      entryType:   'fetch',
      customerId:  'cust-1',
      deliverySpec: { platforms: ['youtube'] },
      fetchSpec:    { sourceUrls: ['https://example.com/clip.mp4'] },
    };
    const portal0 = validateJobSpec(spec).portals.find((p) => p.portal === 'portal0');
    expect(portal0.ready).toBe(true);
    expect(portal0.missing.length).toBe(0);
  });

  it('portal0 fails when deliverySpec.platforms is missing', () => {
    const spec = {
      contentType: 'news-long',
      entryType:   'fetch',
      customerId:  'cust-1',
      // deliverySpec missing — portal0 should fail
    };
    const portal0 = validateJobSpec(spec).portals.find((p) => p.portal === 'portal0');
    expect(portal0.ready).toBe(false);
    expect(portal0.missing.some((m) => m.field === 'deliverySpec.platforms')).toBe(true);
  });

  it('returns suggestions for missing fields', () => {
    const portal0 = validateJobSpec({}).portals.find((p) => p.portal === 'portal0');
    expect(portal0.suggestions.length).toBeGreaterThan(0);
    expect(portal0.suggestions[0]).toMatch(/Set /);
  });

  it('conditional field: fetchSpec.sourceUrls required when entryType === fetch', () => {
    const spec = {
      jobId: 'abc', contentType: 'news-long', entryType: 'fetch',
      customerId: 'c1', deliverySpec: { platforms: ['youtube'] },
    };
    const p0 = validateJobSpec(spec).portals.find((p) => p.portal === 'portal0');
    // portal0 required fields are present, but conditional fetchSpec.sourceUrls is missing
    expect(p0.missing.some((m) => m.field === 'fetchSpec.sourceUrls')).toBe(true);
  });

  it('conditional field: uploadSpec.fileKeys required when entryType === upload', () => {
    const spec = {
      jobId: 'abc', contentType: 'news-long', entryType: 'upload',
      customerId: 'c1', deliverySpec: { platforms: ['youtube'] },
    };
    const p0 = validateJobSpec(spec).portals.find((p) => p.portal === 'portal0');
    expect(p0.missing.some((m) => m.field === 'uploadSpec.fileKeys')).toBe(true);
  });

  it('conditional field: createSpec.promptText required when entryType === create', () => {
    const spec = {
      jobId: 'abc', contentType: 'news-long', entryType: 'create',
      customerId: 'c1', deliverySpec: { platforms: ['youtube'] },
    };
    const p0 = validateJobSpec(spec).portals.find((p) => p.portal === 'portal0');
    expect(p0.missing.some((m) => m.field === 'createSpec.promptText')).toBe(true);
  });

  it('returns readyPortals and blockedPortals arrays', () => {
    const result = validateJobSpec({});
    expect(Array.isArray(result.readyPortals)).toBe(true);
    expect(Array.isArray(result.blockedPortals)).toBe(true);
  });
});

// ─── buildSystemPrompt ────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('contains AuraFlux branding and instructs against Gemini self-identification', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/AuraFlux/);
    // The prompt should tell the AI not to reveal the underlying model
    expect(prompt.toLowerCase()).toMatch(/never mention gemini/);
    // The prompt should NOT present itself as a Gemini product
    expect(prompt.toLowerCase()).not.toMatch(/you are gemini/);
    expect(prompt.toLowerCase()).not.toMatch(/i am gemini/);
  });

  it('includes key platform knowledge sections', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('WHAT AURAFLUX IS');
    expect(prompt).toContain('PLANS');
    expect(prompt).toContain('CREDITS');
    expect(prompt).toContain('JOB WIZARD');
    expect(prompt).toContain('PRODUCTION PIPELINE');
    expect(prompt).toContain('SYSTEM HEALTH');
  });

  it('covers all three source methods in wizard section', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Browse My Channels');
    expect(prompt).toContain('Upload files');
    expect(prompt).toContain('Short clips');
  });

  it('guide mode mentions Operate plan', () => {
    const guidePrompt = buildSystemPrompt('guide');
    expect(guidePrompt).toMatch(/Operate/i);
  });

  it('full mode returns non-empty string', () => {
    const fullPrompt = buildSystemPrompt('full');
    expect(typeof fullPrompt).toBe('string');
    expect(fullPrompt.length).toBeGreaterThan(100);
  });
});

// ─── chatWithConcierge ────────────────────────────────────────────────────────

describe('chatWithConcierge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isConfigured.mockReturnValue(true);
    callGeminiChat.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Hello from AuraFlux assistant' }] } }],
    });
  });

  it('returns text from Gemini response', async () => {
    const result = await chatWithConcierge(
      [{ role: 'user', content: 'How do I start?' }],
      {},
      { planTier: 'guided' }
    );
    expect(result).toBe('Hello from AuraFlux assistant');
  });

  it('calls callGeminiChat with systemInstruction', async () => {
    await chatWithConcierge(
      [{ role: 'user', content: 'Test' }],
      {},
      { planTier: 'guided' }
    );
    const call = callGeminiChat.mock.calls[0];
    expect(call[1]).toHaveProperty('systemInstruction');
    expect(call[1].systemInstruction).toContain('AuraFlux');
  });

  it('injects spec context into last user message when spec is provided', async () => {
    await chatWithConcierge(
      [{ role: 'user', content: 'What is missing?' }],
      { contentType: 'news-long', entryType: 'fetch' },
      { planTier: 'guided' }
    );
    const contents = callGeminiChat.mock.calls[0][0];
    const lastMsg = contents[contents.length - 1];
    expect(lastMsg.parts[0].text).toContain('news-long');
  });

  it('does not inject spec context when spec is empty', async () => {
    await chatWithConcierge(
      [{ role: 'user', content: 'Hello' }],
      {},
      { planTier: 'guided' }
    );
    const contents = callGeminiChat.mock.calls[0][0];
    const lastMsg = contents[contents.length - 1];
    expect(lastMsg.parts[0].text).toBe('Hello');
  });

  it('converts role "assistant" → "model" for Gemini', async () => {
    await chatWithConcierge(
      [
        { role: 'user',      content: 'Q' },
        { role: 'assistant', content: 'A' },
        { role: 'user',      content: 'Follow up' },
      ],
      {},
      { planTier: 'guided' }
    );
    const contents = callGeminiChat.mock.calls[0][0];
    expect(contents[1].role).toBe('model');
    expect(contents[0].role).toBe('user');
  });

  it('throws when Gemini is not configured', async () => {
    isConfigured.mockReturnValue(false);
    await expect(
      chatWithConcierge([{ role: 'user', content: 'Hi' }], {}, { planTier: 'guided' })
    ).rejects.toThrow('GEMINI_API_KEY');
  });

  it('throws when plan does not support concierge', async () => {
    const { isFeatureEnabled } = require('../lib/services/feature_gate');
    isFeatureEnabled.mockImplementation((f, p) => {
      if (f === 'concierge') return false;
      return true;
    });
    await expect(
      chatWithConcierge([{ role: 'user', content: 'Hi' }], {}, { planTier: 'operate' })
    ).rejects.toThrow('operate plan or higher');
  });

  it('returns empty string when Gemini returns no candidates', async () => {
    const { isFeatureEnabled } = require('../lib/services/feature_gate');
    isFeatureEnabled.mockImplementation((f, p) => {
      if (f === 'concierge') return p === 'guided' || p === 'managed' || p === 'custom';
      return true;
    });
    callGeminiChat.mockResolvedValue({ candidates: [] });
    const result = await chatWithConcierge(
      [{ role: 'user', content: 'Hi' }],
      {},
      { planTier: 'guided' }
    );
    expect(result).toBe('');
  });
});

// ─── buildSystemStatus ────────────────────────────────────────────────────────

describe('buildSystemStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env vars that affect integration health lines
    delete process.env.GEMINI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
  });

  it('returns a formatted status block with job counts and failure rate', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total: '10', failed: '2', active: '3', completed: '5' }],
    });
    const status = await buildSystemStatus();
    expect(status).toContain('LIVE SYSTEM STATUS');
    expect(status).toContain('10 total');
    expect(status).toContain('2 failed');
    expect(status).toContain('20% failure rate');
  });

  it('flags ⚠️ HIGH FAILURE RATE when ≥50% of ≥5 jobs fail', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total: '10', failed: '6', active: '0', completed: '4' }],
    });
    const status = await buildSystemStatus();
    expect(status).toContain('HIGH FAILURE RATE');
  });

  it('flags ⚠️ ELEVATED FAILURE RATE when 25–49% of ≥5 jobs fail', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total: '8', failed: '2', active: '1', completed: '5' }],
    });
    const status = await buildSystemStatus();
    expect(status).toContain('ELEVATED FAILURE RATE');
  });

  it('shows ✅ Normal when failure rate is low', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total: '20', failed: '1', active: '5', completed: '14' }],
    });
    const status = await buildSystemStatus();
    expect(status).toContain('Normal');
  });

  it('reflects integration configured/not-configured based on env vars', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total: '5', failed: '0', active: '2', completed: '3' }],
    });
    process.env.GEMINI_API_KEY = 'test-key';
    const status = await buildSystemStatus();
    expect(status).toMatch(/AI features.*configured/);
  });

  it('returns empty string when DB throws', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('DB unreachable'));
    const status = await buildSystemStatus();
    expect(status).toBe('');
  });
});
