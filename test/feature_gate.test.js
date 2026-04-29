'use strict';
/**
 * test/feature_gate.test.js — Unit tests for feature gating by plan
 */

const {
  FEATURE_PLANS,
  TIER_RANK,
  isFeatureEnabled,
  getEnabledFeatures,
  getPlanFeatureMatrix,
  buildFeatureFlags,
} = require('../lib/services/feature_gate');

// ─── Save and restore env vars ────────────────────────────────────────────────

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  // Simulate all credentials present by default
  process.env.VECTCUT_API_URL   = 'http://localhost:9001';
  process.env.GEMINI_API_KEY    = 'test-gemini-key';
  process.env.RUNPOD_API_KEY    = 'test-runpod-key';
  process.env.ELEVENLABS_API_KEY = 'test-el-key';
  process.env.HEYGEN_API_KEY    = 'test-heygen-key';
});
afterEach(() => { process.env = savedEnv; });

// ─── TIER_RANK ────────────────────────────────────────────────────────────────

describe('TIER_RANK', () => {
  it('orders diy < dwy < dfy < custom', () => {
    expect(TIER_RANK.diy).toBeLessThan(TIER_RANK.dwy);
    expect(TIER_RANK.dwy).toBeLessThan(TIER_RANK.dfy);
    expect(TIER_RANK.dfy).toBeLessThan(TIER_RANK.custom);
  });
});

// ─── isFeatureEnabled ─────────────────────────────────────────────────────────

describe('isFeatureEnabled', () => {
  // DIY plan
  it('enables thumbnail.frame for diy', () => {
    expect(isFeatureEnabled('thumbnail.frame', 'diy')).toBe(true);
  });
  it('enables thumbnail.designed for diy', () => {
    expect(isFeatureEnabled('thumbnail.designed', 'diy')).toBe(true);
  });
  it('does NOT enable thumbnail.vectcut for diy', () => {
    expect(isFeatureEnabled('thumbnail.vectcut', 'diy')).toBe(false);
  });
  it('does NOT enable thumbnail.imagen for diy', () => {
    expect(isFeatureEnabled('thumbnail.imagen', 'diy')).toBe(false);
  });

  // DWY plan
  it('enables thumbnail.vectcut for dwy (with env)', () => {
    expect(isFeatureEnabled('thumbnail.vectcut', 'dwy')).toBe(true);
  });
  it('enables thumbnail.gemini_ranking for dwy (with env)', () => {
    expect(isFeatureEnabled('thumbnail.gemini_ranking', 'dwy')).toBe(true);
  });
  it('does NOT enable thumbnail.imagen for dwy', () => {
    expect(isFeatureEnabled('thumbnail.imagen', 'dwy')).toBe(false);
  });
  it('enables tts.elevenlabs for dwy (with env)', () => {
    expect(isFeatureEnabled('tts.elevenlabs', 'dwy')).toBe(true);
  });
  it('does NOT enable avatar.heygen for dwy', () => {
    expect(isFeatureEnabled('avatar.heygen', 'dwy')).toBe(false);
  });

  // DFY plan
  it('enables thumbnail.imagen for dfy (with env)', () => {
    expect(isFeatureEnabled('thumbnail.imagen', 'dfy')).toBe(true);
  });
  it('enables avatar.heygen for dfy (with env)', () => {
    expect(isFeatureEnabled('avatar.heygen', 'dfy')).toBe(true);
  });
  it('enables video.wan_i2v for dfy (with env)', () => {
    expect(isFeatureEnabled('video.wan_i2v', 'dfy')).toBe(true);
  });
  it('enables publish.direct_tiktok for dfy', () => {
    expect(isFeatureEnabled('publish.direct_tiktok', 'dfy')).toBe(true);
  });

  // Custom plan
  it('enables all features for custom tier', () => {
    expect(isFeatureEnabled('thumbnail.imagen', 'custom')).toBe(true);
    expect(isFeatureEnabled('avatar.heygen', 'custom')).toBe(true);
  });

  // Missing / unknown
  it('returns false for unknown feature key', () => {
    expect(isFeatureEnabled('nonexistent.feature', 'dfy')).toBe(false);
  });
  it('returns false for null planTier', () => {
    expect(isFeatureEnabled('thumbnail.frame', null)).toBe(false);
  });
  it('returns false for undefined planTier', () => {
    expect(isFeatureEnabled('thumbnail.frame', undefined)).toBe(false);
  });

  // Env var gates (plan is high enough but credential missing)
  it('returns false when plan qualifies but required env var is missing', () => {
    delete process.env.VECTCUT_API_URL;
    expect(isFeatureEnabled('thumbnail.vectcut', 'dwy')).toBe(false);
  });
  it('returns false when GEMINI_API_KEY missing for thumbnail.imagen even on dfy', () => {
    delete process.env.GEMINI_API_KEY;
    expect(isFeatureEnabled('thumbnail.imagen', 'dfy')).toBe(false);
  });
  it('returns true when all required env vars are present', () => {
    process.env.GEMINI_API_KEY = 'present';
    expect(isFeatureEnabled('thumbnail.gemini_ranking', 'dwy')).toBe(true);
  });
});

// ─── getEnabledFeatures ───────────────────────────────────────────────────────

describe('getEnabledFeatures', () => {
  it('returns only diy-accessible features for diy plan', () => {
    const features = getEnabledFeatures('diy');
    expect(features).toContain('thumbnail.frame');
    expect(features).toContain('thumbnail.designed');
    expect(features).toContain('scheduling');
    expect(features).not.toContain('thumbnail.vectcut');
    expect(features).not.toContain('thumbnail.imagen');
    expect(features).not.toContain('avatar.heygen');
  });

  it('returns dwy features including vectcut and gemini_ranking', () => {
    const features = getEnabledFeatures('dwy');
    expect(features).toContain('thumbnail.vectcut');
    expect(features).toContain('thumbnail.gemini_ranking');
    expect(features).toContain('tts.elevenlabs');
    expect(features).not.toContain('thumbnail.imagen');
    expect(features).not.toContain('avatar.heygen');
  });

  it('returns all features for dfy plan (with all env vars set)', () => {
    const features = getEnabledFeatures('dfy');
    expect(features).toContain('thumbnail.imagen');
    expect(features).toContain('avatar.heygen');
    expect(features).toContain('video.wan_i2v');
    expect(features).toContain('publish.direct_tiktok');
  });

  it('returns empty array for null plan', () => {
    expect(getEnabledFeatures(null)).toEqual([]);
  });
});

// ─── getPlanFeatureMatrix ─────────────────────────────────────────────────────

describe('getPlanFeatureMatrix', () => {
  it('returns an entry for every feature in FEATURE_PLANS', () => {
    const matrix = getPlanFeatureMatrix('dwy');
    expect(matrix.length).toBe(Object.keys(FEATURE_PLANS).length);
  });

  it('has enabled:true for diy features on dwy plan', () => {
    const matrix = getPlanFeatureMatrix('dwy');
    const frame   = matrix.find((f) => f.key === 'thumbnail.frame');
    expect(frame.enabled).toBe(true);
  });

  it('has enabled:false for dfy features on dwy plan', () => {
    const matrix = getPlanFeatureMatrix('dwy');
    const imagen  = matrix.find((f) => f.key === 'thumbnail.imagen');
    expect(imagen.enabled).toBe(false);
  });

  it('includes label, description, min_plan on each entry', () => {
    const matrix = getPlanFeatureMatrix('diy');
    for (const entry of matrix) {
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.min_plan).toBeTruthy();
    }
  });
});

// ─── buildFeatureFlags ────────────────────────────────────────────────────────

describe('buildFeatureFlags', () => {
  it('returns a flat boolean map', () => {
    const flags = buildFeatureFlags('dwy');
    expect(typeof flags['thumbnail.frame']).toBe('boolean');
    expect(typeof flags['thumbnail.imagen']).toBe('boolean');
  });

  it('has true for diy features on dwy plan', () => {
    const flags = buildFeatureFlags('dwy');
    expect(flags['thumbnail.frame']).toBe(true);
    expect(flags['thumbnail.designed']).toBe(true);
  });

  it('has false for dfy features on dwy plan', () => {
    const flags = buildFeatureFlags('dwy');
    expect(flags['thumbnail.imagen']).toBe(false);
    expect(flags['avatar.heygen']).toBe(false);
  });

  it('returns all features true for custom tier (all envs set)', () => {
    const flags = buildFeatureFlags('custom');
    expect(flags['thumbnail.imagen']).toBe(true);
    expect(flags['avatar.heygen']).toBe(true);
  });
});
