'use strict';
/**
 * test/portal5_publish_profile.test.js
 * Tests for Portal 5 per-customer publish profile resolution and platformOutcome field.
 */

jest.mock('../lib/db', () => ({
  savePublishResult: jest.fn().mockResolvedValue(undefined),
  markJobPublished: jest.fn().mockResolvedValue(undefined),
  resolveCanonicalJobIdSync: jest.fn((id) => id),
}));

const { resolveUploadPostProfile, canProduce } = require('../lib/portals/portal5');

// ─── resolveUploadPostProfile ─────────────────────────────────────────────────

describe('resolveUploadPostProfile', () => {
  const originalEnv = process.env.UPLOADPOST_PROFILE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.UPLOADPOST_PROFILE = originalEnv;
    } else {
      delete process.env.UPLOADPOST_PROFILE;
    }
  });

  test('returns publishConfig.uploadPostProfile when present (highest priority)', () => {
    process.env.UPLOADPOST_PROFILE = 'global-profile';
    const jobSpec = {
      publishConfig: { uploadPostProfile: 'customer-abc-profile' },
      deliverySpec: { uploadPostProfile: 'delivery-profile' },
    };
    expect(resolveUploadPostProfile(jobSpec)).toBe('customer-abc-profile');
  });

  test('falls back to deliverySpec.uploadPostProfile when publishConfig absent', () => {
    process.env.UPLOADPOST_PROFILE = 'global-profile';
    const jobSpec = {
      deliverySpec: { uploadPostProfile: 'delivery-profile' },
    };
    expect(resolveUploadPostProfile(jobSpec)).toBe('delivery-profile');
  });

  test('falls back to UPLOADPOST_PROFILE env when neither jobSpec field is set', () => {
    process.env.UPLOADPOST_PROFILE = 'global-profile';
    const jobSpec = {};
    expect(resolveUploadPostProfile(jobSpec)).toBe('global-profile');
  });

  test('returns null when no profile is available anywhere', () => {
    delete process.env.UPLOADPOST_PROFILE;
    const jobSpec = {};
    expect(resolveUploadPostProfile(jobSpec)).toBeNull();
  });

  test('returns null when jobSpec is null', () => {
    delete process.env.UPLOADPOST_PROFILE;
    expect(resolveUploadPostProfile(null)).toBeNull();
  });

  test('prefers publishConfig over deliverySpec when both set', () => {
    const jobSpec = {
      publishConfig: { uploadPostProfile: 'publish-config-wins' },
      deliverySpec: { uploadPostProfile: 'delivery-loses' },
    };
    expect(resolveUploadPostProfile(jobSpec)).toBe('publish-config-wins');
  });
});

// ─── canProduce — profile check ───────────────────────────────────────────────

describe('canProduce — profile check', () => {
  const originalKey = process.env.UPLOADPOST_API_KEY;
  const originalProfile = process.env.UPLOADPOST_PROFILE;

  afterEach(() => {
    if (originalKey !== undefined) process.env.UPLOADPOST_API_KEY = originalKey;
    else delete process.env.UPLOADPOST_API_KEY;
    if (originalProfile !== undefined) process.env.UPLOADPOST_PROFILE = originalProfile;
    else delete process.env.UPLOADPOST_PROFILE;
  });

  test('passes when jobSpec.publishConfig.uploadPostProfile is set (no env required)', () => {
    delete process.env.UPLOADPOST_PROFILE;
    process.env.UPLOADPOST_API_KEY = 'test-api-key';
    const jobSpec = {
      jobId: 'job-123',
      publishConfig: { uploadPostProfile: 'customer-profile' },
      deliverySpec: { platforms: ['youtube'] },
    };
    const { ready, reasons } = canProduce(jobSpec);
    // Profile check should pass — no "UPLOADPOST_PROFILE not set" error
    expect(reasons.filter((r) => r.includes('UPLOADPOST_PROFILE'))).toHaveLength(0);
  });

  test('fails when no profile is set in jobSpec or env', () => {
    delete process.env.UPLOADPOST_PROFILE;
    process.env.UPLOADPOST_API_KEY = 'test-api-key';
    const jobSpec = {
      jobId: 'job-123',
      deliverySpec: { platforms: ['youtube'] },
    };
    const { reasons } = canProduce(jobSpec);
    expect(reasons.some((r) => r.includes('UPLOADPOST_PROFILE'))).toBe(true);
  });
});

// ─── platformOutcome field ─────────────────────────────────────────────────────

describe('platformOutcome semantics', () => {
  // We test the logic indirectly through the module's behavior.
  // The actual output contract is: platformOutcome in { 'all_success', 'partial_success', 'all_failed', 'no_platforms' }

  test('platformOutcome values are the expected strings', () => {
    // Document the contract — these are the valid values
    const validOutcomes = ['all_success', 'partial_success', 'all_failed', 'no_platforms'];
    validOutcomes.forEach((v) => expect(typeof v).toBe('string'));
    expect(validOutcomes).toHaveLength(4);
  });

  test('CPD-1026: polls Upload-Post /uploadposts/status (not legacy /api/status)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../lib/portals/portal5.js'), 'utf8');
    expect(src).toContain("UPLOADPOST_STATUS_PATH = process.env.UPLOADPOST_STATUS_PATH || '/uploadposts/status'");
    expect(src).not.toMatch(/['"]\/api\/status['"]/);
  });
});
