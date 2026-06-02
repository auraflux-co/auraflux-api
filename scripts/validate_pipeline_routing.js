#!/usr/bin/env node
/**
 * scripts/validate_pipeline_routing.js
 *
 * Static validator for the AuraFlux pipeline routing layer.
 *
 * Run this whenever developer_api.js, pipeline_routing.js, or any portal file
 * changes to confirm that all known template types still route correctly through
 * the pipeline BEFORE submitting any real jobs.
 *
 * Usage:
 *   node scripts/validate_pipeline_routing.js          # validates all templates
 *   node scripts/validate_pipeline_routing.js --verbose # prints full routing table
 *
 * Exit code 0 = all paths OK
 * Exit code 1 = one or more paths broken — do NOT run tests until fixed
 *
 * This script is wired into the pre-commit hook for changes to:
 *   - lib/routes/developer_api.js
 *   - lib/pipeline_routing.js
 *   - lib/portals/portal*.js
 *   - lib/assembly_service.js
 */

'use strict';

const {
  resolveProductionProfileAndContentType,
  resolveTemplateIdFromBody,
  KNOWN_CLEAN_PATHS,
} = require('../lib/pipeline_routing');

const VERBOSE = process.argv.includes('--verbose');

// ── Test cases ────────────────────────────────────────────────────────────────
// Each test specifies an input body and the exact routing outcome expected.
// These are derived from KNOWN_CLEAN_PATHS + additional edge cases.

const TEST_CASES = [
  // ── Registered templates (from KNOWN_CLEAN_PATHS) ─────────────────────────
  {
    id: 'tiktok_clutch',
    body: { contentType: 'clips', format: 'portrait', platforms: ['tiktok', 'youtube', 'instagram'] },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },
  {
    id: 'youtube_deep_dive',
    body: { contentType: 'clips', format: 'longform', platforms: ['youtube'] },
    expected: { productionProfile: 'broadcast_desk', contentType: 'clips', templateId: 'long-form' },
  },
  {
    id: 'irl_story_time',
    body: { contentType: 'clips', format: 'portrait', platforms: ['tiktok', 'instagram'] },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },
  {
    id: 'montage_hype_reel',
    body: { contentType: 'clips', format: 'portrait', platforms: ['tiktok', 'youtube'] },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },
  {
    id: 'reaction_cut',
    body: { contentType: 'clips', format: 'longform', platforms: ['youtube'] },
    expected: { productionProfile: 'broadcast_desk', contentType: 'clips', templateId: 'long-form' },
  },
  {
    id: 'quick_guide',
    body: { contentType: 'clips', format: 'portrait', platforms: ['youtube', 'tiktok'] },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },

  // ── Legacy / broadcast paths (must not regress) ────────────────────────────
  {
    id: 'broadcast_news (legacy)',
    body: { contentType: 'news' },
    expected: { productionProfile: 'broadcast_desk', contentType: 'news', templateId: 'long-form' },
  },
  {
    id: 'broadcast_news via productionProfile',
    body: { productionProfile: 'broadcast_desk' },
    expected: { productionProfile: 'broadcast_desk', contentType: 'news', templateId: 'long-form' },
  },
  {
    id: 'sports/live_event (legacy)',
    body: { contentType: 'sports' },
    expected: { productionProfile: 'live_event', contentType: 'sports', templateId: 'long-form' },
  },
  {
    id: 'show_commentary (CPD-236)',
    body: { contentType: 'show_commentary', productionProfile: 'broadcast_desk' },
    expected: { productionProfile: 'broadcast_desk', contentType: 'show_commentary', templateId: 'long-form' },
  },
  {
    id: 'show_commentary should not be overridden by vertical_reel',
    body: { contentType: 'show_commentary', productionProfile: 'vertical_reel' },
    expected: { productionProfile: 'vertical_reel', contentType: 'show_commentary', templateId: 'long-form' },
  },

  // ── Regression: CPD-486 longform override ────────────────────────────────
  {
    id: 'clips+longform must NOT be vertical_reel (CPD-486)',
    body: { contentType: 'clips', format: 'longform' },
    expected: { productionProfile: 'broadcast_desk', contentType: 'clips', templateId: 'long-form' },
  },
  {
    id: 'clips+long must NOT be vertical_reel (CPD-486)',
    body: { contentType: 'clips', format: 'long' },
    expected: { productionProfile: 'broadcast_desk', contentType: 'clips', templateId: 'long-form' },
  },
  {
    id: 'clips+portrait must be vertical_reel',
    body: { contentType: 'clips', format: 'portrait' },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },
  {
    id: 'clips with no format must be vertical_reel (default)',
    body: { contentType: 'clips' },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'long-form' },
  },

  // ── templateId resolution edge cases ─────────────────────────────────────
  {
    id: 'explicit templateId:short-form passthrough',
    body: { templateId: 'short-form', contentType: 'clips' },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },
  {
    id: 'explicit templateId:long-form passthrough',
    body: { templateId: 'long-form', contentType: 'clips' },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'long-form' },
  },
  {
    id: 'format:short → short-form',
    body: { contentType: 'clips', format: 'short' },
    expected: { productionProfile: 'vertical_reel', contentType: 'clips', templateId: 'short-form' },
  },
  {
    id: 'empty body → broadcast_desk default',
    body: {},
    expected: { productionProfile: 'broadcast_desk', contentType: 'news', templateId: 'long-form' },
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

for (const tc of TEST_CASES) {
  const { productionProfile, contentType } = resolveProductionProfileAndContentType(tc.body);
  const templateId = resolveTemplateIdFromBody(tc.body, contentType);

  const actual = { productionProfile, contentType, templateId };
  const ok = (
    actual.productionProfile === tc.expected.productionProfile &&
    actual.contentType       === tc.expected.contentType &&
    actual.templateId        === tc.expected.templateId
  );

  if (ok) {
    passed++;
    if (VERBOSE) {
      console.log(`  ✅  ${tc.id}`);
      console.log(`       profile=${actual.productionProfile}  contentType=${actual.contentType}  templateId=${actual.templateId}`);
    }
  } else {
    failed++;
    const diff = [];
    if (actual.productionProfile !== tc.expected.productionProfile)
      diff.push(`productionProfile: got "${actual.productionProfile}", want "${tc.expected.productionProfile}"`);
    if (actual.contentType !== tc.expected.contentType)
      diff.push(`contentType: got "${actual.contentType}", want "${tc.expected.contentType}"`);
    if (actual.templateId !== tc.expected.templateId)
      diff.push(`templateId: got "${actual.templateId}", want "${tc.expected.templateId}"`);
    failures.push({ id: tc.id, diff });
    console.error(`  ❌  ${tc.id}`);
    diff.forEach((d) => console.error(`       ${d}`));
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log('');
console.log(`Pipeline routing: ${passed}/${TEST_CASES.length} passed`);

if (failed > 0) {
  console.error('');
  console.error(`FAIL — ${failed} routing path(s) broken. Fix lib/pipeline_routing.js before running tests or deploying.`);
  console.error('');
  console.error('Broken paths:');
  failures.forEach(({ id, diff }) => {
    console.error(`  • ${id}`);
    diff.forEach((d) => console.error(`    - ${d}`));
  });
  process.exit(1);
} else {
  console.log('All pipeline routing paths verified ✅');
  process.exit(0);
}
