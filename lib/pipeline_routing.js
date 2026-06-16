/**
 * lib/pipeline_routing.js — Pipeline routing logic (single source of truth)
 *
 * These functions determine which production profile, template shape, and portal
 * sequence a job gets based on the request body. They are extracted here so they
 * can be:
 *   1. Required by developer_api.js (runtime)
 *   2. Tested by scripts/validate_pipeline_routing.js (pre-commit / CI)
 *   3. Dry-run by the E2E test script before submitting any job
 *
 * Rule: any change to routing logic happens here. developer_api.js imports it.
 * Never duplicate this logic elsewhere — if you see a copy, delete it and require this.
 */

'use strict';

/** API-facing presentation profile → internal legacy content type key. */
const PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE = {
  broadcast_desk: 'news',
  vertical_reel:  'clips',
  live_event:     'sports',
};

/** Legacy contentType → production profile (for backwards-compat API clients). */
const LEGACY_CONTENT_TYPE_TO_PRODUCTION_PROFILE = {
  news:   'broadcast_desk',
  clips:  'vertical_reel',
  sports: 'live_event',
};

/**
 * Content types that must never be overridden by the profile→contentType mapping.
 * When a caller explicitly provides contentType alongside productionProfile, the
 * contentType always wins for content routing; productionProfile is formatting-only.
 * CPD-236: show_commentary, custom added.
 * CPD-239: clips, sports added.
 */
const NON_ALIAS_CONTENT_TYPES = new Set(['show_commentary', 'custom', 'clips', 'sports']);

function _normalizeLegacyContentType(ct) {
  if (!ct || typeof ct !== 'string') return null;
  return ct.replace(/-short$/, '').replace(/-long$/, '');
}

/**
 * Resolve productionProfile and contentType from the job submission body.
 *
 * Key rules:
 * - contentType in NON_ALIAS_CONTENT_TYPES always wins for content routing
 * - format:longform overrides vertical_reel → broadcast_desk (CPD-486)
 *   so longform clip compilations produce 16:9, not 9:16
 * - productionProfile is formatting-only when contentType is explicit
 */
function resolveProductionProfileAndContentType(body) {
  const b = body || {};

  if (b.contentType && NON_ALIAS_CONTENT_TYPES.has(_normalizeLegacyContentType(b.contentType) || b.contentType)) {
    const base = _normalizeLegacyContentType(b.contentType) || b.contentType;
    let profile = b.productionProfile || LEGACY_CONTENT_TYPE_TO_PRODUCTION_PROFILE[base] || 'broadcast_desk';
    // CPD-486: format:longform or format:landscape explicitly opts out of portrait crop
    if ((b.format === 'longform' || b.format === 'long' || b.format === 'landscape') && profile === 'vertical_reel') {
      profile = 'broadcast_desk';
    }
    return { productionProfile: profile, contentType: base };
  }

  if (b.productionProfile && PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE[b.productionProfile]) {
    return {
      productionProfile: b.productionProfile,
      contentType: PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE[b.productionProfile],
    };
  }
  if (b.contentType) {
    const base = _normalizeLegacyContentType(b.contentType) || b.contentType;
    const profile = LEGACY_CONTENT_TYPE_TO_PRODUCTION_PROFILE[base] || 'broadcast_desk';
    return { productionProfile: profile, contentType: base };
  }
  return { productionProfile: 'broadcast_desk', contentType: 'news' };
}

/**
 * Resolve the internal templateId ('short-form' | 'long-form') from the body.
 * Determines which script scaffold and portal sequence the job uses.
 */
function resolveTemplateIdFromBody(b, contentTypeStr) {
  if (b.templateId && ['short-form', 'long-form'].includes(b.templateId)) return b.templateId;
  if (b.format === 'short'    || b.format === 'portrait')  return 'short-form';
  if (b.format === 'long'     || b.format === 'longform' ||
      b.format === 'landscape')                             return 'long-form';
  const ct = contentTypeStr || '';
  if (typeof ct === 'string' && ct.includes('-short')) return 'short-form';
  return 'long-form';
}

/**
 * KNOWN CLEAN PATHS — the expected routing outcome for every template type.
 *
 * These are the ground truth. Before any job submission, validate the body against
 * this table. If routing diverges, stop and alert — do NOT submit the job.
 *
 * Fields:
 *   submission      — the minimum body fields that define this template's path
 *   expectedRouting — what resolveProductionProfileAndContentType must return
 *   expectedPortals — which portals should be active (portal4 active for clip pixel QA — CPD-1046)
 *   outputShape     — expected output dimensions / aspect ratio
 *   notes           — why certain choices were made
 *
 * Maintained by: update manually when a template changes; updated automatically
 * by run_11_template_matrix.py when a template achieves grade=100 for the first time.
 *
 * NOTE (CPD-485): The dashboard wizard also offers "Quick Preset" chips (e.g. "Viral Moment",
 * "Gaming Recap"). These are intentionally CLIENT-ONLY shortcuts that set a combination of
 * contentType + format + templateId on the front-end before the request is submitted.
 * They do NOT represent distinct server-side templates; once they hit POST /jobs or POST /v1/jobs
 * the resulting contentType+templateId is already a KNOWN_CLEAN_PATH entry above.
 * No server-side changes are needed to support Quick Presets — they are a UI convenience only.
 */
const KNOWN_CLEAN_PATHS = {
  tiktok_clutch: {
    submission: { contentType: 'clips', format: 'portrait', platforms: ['tiktok', 'youtube', 'instagram'] },
    expectedRouting: { productionProfile: 'vertical_reel', templateId: 'short-form' },
    expectedPortals: { portal0: true, portal3a: true, portal3b: true, portal4: true, portal5: true, portal1: false, portal2: false },
    outputShape: { aspectRatio: '9:16', dimensions: '720x1280' },
    notes: 'Short-form clip compilation. Portrait crop. No avatar. Portal 4 full-video QA before publish (CPD-1046).',
  },
  youtube_deep_dive: {
    submission: { contentType: 'clips', format: 'longform', platforms: ['youtube'] },
    expectedRouting: { productionProfile: 'broadcast_desk', templateId: 'long-form' },
    expectedPortals: { portal0: true, portal3a: true, portal3b: true, portal4: true, portal5: true, portal1: false, portal2: false },
    outputShape: { aspectRatio: '16:9', dimensions: '1920x1080' },
    notes: 'Longform clip compilation. Landscape. No avatar. Portal 4 full-video QA (CPD-1046).',
  },
  irl_story_time: {
    submission: { contentType: 'clips', format: 'portrait', platforms: ['tiktok', 'instagram'] },
    expectedRouting: { productionProfile: 'vertical_reel', templateId: 'short-form' },
    expectedPortals: { portal0: true, portal3a: true, portal3b: true, portal4: true, portal5: true, portal1: false, portal2: false },
    outputShape: { aspectRatio: '9:16', dimensions: '720x1280' },
    notes: 'IRL portrait compilation. Warm grade. Bottom captions. Portal 4 QA (CPD-1046).',
  },
  montage_hype_reel: {
    submission: { contentType: 'clips', format: 'portrait', platforms: ['tiktok', 'youtube'] },
    expectedRouting: { productionProfile: 'vertical_reel', templateId: 'short-form' },
    expectedPortals: { portal0: true, portal3a: true, portal3b: true, portal4: true, portal5: true, portal1: false, portal2: false },
    outputShape: { aspectRatio: '9:16', dimensions: '720x1280' },
    notes: 'High-energy portrait montage. Vivid grade, zoom + transitions. Portal 4 QA (CPD-1046).',
  },
  reaction_cut: {
    submission: { contentType: 'clips', format: 'longform', platforms: ['youtube'] },
    expectedRouting: { productionProfile: 'broadcast_desk', templateId: 'long-form' },
    expectedPortals: { portal0: true, portal3a: true, portal3b: true, portal4: true, portal5: true, portal1: false, portal2: false },
    outputShape: { aspectRatio: '16:9', dimensions: '1920x1080' },
    notes: 'Longform reaction compilation. Landscape. Portal 4 QA (CPD-1046).',
  },
  quick_guide: {
    submission: { contentType: 'clips', format: 'portrait', platforms: ['youtube', 'tiktok'] },
    expectedRouting: { productionProfile: 'vertical_reel', templateId: 'short-form' },
    expectedPortals: { portal0: true, portal3a: true, portal3b: true, portal4: true, portal5: true, portal1: false, portal2: false },
    outputShape: { aspectRatio: '9:16', dimensions: '720x1280' },
    notes: 'Short tutorial/guide format. Cool grade, clean captions. Portal 4 QA (CPD-1046).',
  },
};

/**
 * Validate a submission body against a template's known clean path.
 * Returns { valid: true } or { valid: false, errors: [...] }.
 *
 * Use this in E2E scripts BEFORE submitting a job to catch routing mismatches early.
 */
function validateSubmissionAgainstPath(templateId, body) {
  const path = KNOWN_CLEAN_PATHS[templateId];
  if (!path) return { valid: true, note: `No registered clean path for templateId="${templateId}" — running without validation` };

  const { productionProfile, contentType } = resolveProductionProfileAndContentType(body);
  const resolvedTemplateId = resolveTemplateIdFromBody(body, contentType);
  const errors = [];

  if (productionProfile !== path.expectedRouting.productionProfile) {
    errors.push(
      `productionProfile mismatch: got "${productionProfile}", expected "${path.expectedRouting.productionProfile}". ` +
      `Check format field — body.format="${body.format}", body.contentType="${body.contentType}".`
    );
  }
  if (resolvedTemplateId !== path.expectedRouting.templateId) {
    errors.push(
      `templateId mismatch: got "${resolvedTemplateId}", expected "${path.expectedRouting.templateId}". ` +
      `Check format field — body.format="${body.format}".`
    );
  }

  return errors.length ? { valid: false, errors } : { valid: true };
}

module.exports = {
  resolveProductionProfileAndContentType,
  resolveTemplateIdFromBody,
  KNOWN_CLEAN_PATHS,
  validateSubmissionAgainstPath,
  PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE,
  LEGACY_CONTENT_TYPE_TO_PRODUCTION_PROFILE,
  NON_ALIAS_CONTENT_TYPES,
};
