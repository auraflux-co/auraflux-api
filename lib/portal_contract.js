'use strict';
/**
 * Portal input/output contracts — AuraFlux (CPD-483)
 *
 * Every portal stage has a defined set of inputs it requires from upstream
 * and outputs it promises to produce. validatePortalInput is called at the
 * START of each portal to detect upstream failures early — with a clear,
 * actionable message instead of a cryptic undefined-access 200 lines later.
 *
 * This is the "Strict Manifest Checker" concept from production pipeline
 * best practices: each stage asserts its prerequisites before it starts work.
 *
 * Usage (at the top of each portal run() function):
 *   const { validatePortalInput } = require('../portal_contract');
 *   validatePortalInput('3a', jobSpec);
 *
 * It logs a WARNING (non-fatal) when a required input is missing.
 * Sentry captures a warning-level event so broken upstream stages are visible
 * on the observability dashboard without crashing the portal mid-run.
 *
 * The field paths use dot-notation matching the jobSpec object shape:
 *   'assembledPath'               → jobSpec.assembledPath
 *   'state.tts.audioPath'        → jobSpec.state.tts.audioPath
 */

const fs = require('fs');

// ── Contract definitions ────────────────────────────────────────────────────
// Each entry defines:
//   requires: fields that must be present (any truthy value) before this stage runs
//   produces: what this stage promises to write (documentation only — not enforced here)
//
// Rules:
//   - Only list fields that EVERY job of this type requires.
//   - Extension portals (TTS, HeyGen, Shoppable) have their own addOn guards — skip them here.
//   - Portal 0 (order ingestion) has no upstream requirements.

const CONTRACTS = {
  '0': {
    description: 'Order ingestion + clip planning',
    requires: [],
    produces: ['designSpec.clips', 'designSpec.expectedClipCount'],
  },
  '1': {
    description: 'Script generation (AI commentary or research)',
    requires: ['designSpec.clips'],
    produces: ['state.script'],
  },
  '1b': {
    description: 'TTS narration generation',
    requires: ['state.script'],
    produces: ['state.tts.audioPath'],
  },
  '2': {
    description: 'Video assembly — downloads clips, concats, applies chrome',
    requires: ['designSpec.clips'],
    produces: ['assembledPath'],
  },
  '3a': {
    description: 'Assembly QA — Gemini visual review + FFmpeg defect scan',
    // assembledPath is the one hard requirement — everything else degrades gracefully
    requires: ['assembledPath'],
    produces: ['state.portal3aResult'],
  },
  '3b': {
    description: 'Metadata QA — title, description, tags',
    // Relies on 3a passing upstream; assembledPath still needed for re-review if needed
    requires: ['assembledPath'],
    produces: ['state.portal3bResult'],
  },
  '4': {
    description: 'Publish prep — thumbnail, upload package, drive sync',
    requires: ['assembledPath'],
    produces: ['state.portal4Result'],
  },
  '5': {
    description: 'Publish — YouTube, TikTok, direct delivery',
    requires: ['assembledPath'],
    produces: ['state.portal5Result'],
  },
};

// ── Helper: resolve a dot-notation path on an object ────────────────────────
function _get(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => {
    if (o === null || o === undefined) return undefined;
    return o[k];
  }, obj);
}

// ── File existence check ─────────────────────────────────────────────────────
// If a required field is a string that looks like a local file path,
// also verify the file actually exists on disk.
function _fileExists(val) {
  if (typeof val !== 'string') return true;
  if (!val.startsWith('/')) return true; // not a local path
  try { return fs.existsSync(val); } catch (_) { return false; }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate that all required upstream outputs are present before a portal starts.
 *
 * @param {string|number} stage  - portal stage identifier: '0', '1', '2', '3a', '3b', '4', '5'
 * @param {object}        jobSpec - current job spec object (checked in place, not mutated)
 * @param {object}        [opts]
 * @param {boolean}       [opts.strict=false] - if true, throws on missing inputs
 *
 * @returns {{ ok: boolean, missing: string[], warnings: string[] }}
 */
function validatePortalInput(stage, jobSpec, { strict = false } = {}) {
  const contract = CONTRACTS[String(stage)];
  if (!contract) {
    // Unknown stage — log but don't fail (forward-compat)
    console.warn(`[portal_contract] Unknown stage '${stage}' — no contract defined`);
    return { ok: true, missing: [], warnings: [] };
  }

  const missing = [];
  const fileWarnings = [];

  for (const field of contract.requires) {
    const val = _get(jobSpec, field);
    if (val === undefined || val === null || val === false || val === '') {
      missing.push(field);
    } else if (!_fileExists(val)) {
      fileWarnings.push(`${field} points to missing file: ${val}`);
    }
  }

  const jobId = jobSpec?.jobId || 'unknown';
  const templateId = jobSpec?.templateId || 'unknown';

  if (missing.length > 0) {
    const msg = [
      `[portal_contract] Portal ${stage} (${contract.description})`,
      `  Job: ${jobId}  Template: ${templateId}`,
      `  Missing upstream outputs: ${missing.join(', ')}`,
      `  The stage that was supposed to produce these may have failed or been skipped.`,
    ].join('\n');

    if (strict) {
      throw new Error(msg);
    }
    console.warn(msg);

    // Send to Sentry as a warning-level event with full job context
    _sentryWarn(`Portal ${stage}: missing upstream inputs`, {
      stage: String(stage),
      jobId,
      templateId,
      customerId: jobSpec?.customerId,
      contentType: jobSpec?.contentType,
      missingFields: missing,
    });
  }

  if (fileWarnings.length > 0) {
    const msg = [
      `[portal_contract] Portal ${stage} (${contract.description})`,
      `  Job: ${jobId}`,
      ...fileWarnings.map(w => `  ⚠  ${w}`),
    ].join('\n');
    console.warn(msg);

    _sentryWarn(`Portal ${stage}: required files missing from disk`, {
      stage: String(stage),
      jobId,
      fileWarnings,
    });
  }

  return {
    ok: missing.length === 0 && fileWarnings.length === 0,
    missing,
    warnings: fileWarnings,
  };
}

/**
 * Assert that a portal produced its expected outputs.
 * Call this at the END of a portal (in finally{} or after the result is built)
 * to self-certify that downstream portals will have what they need.
 *
 * Non-fatal — logs a warning and Sentry event. Does not throw.
 */
function validatePortalOutput(stage, jobSpec) {
  const contract = CONTRACTS[String(stage)];
  if (!contract) return;

  const missing = contract.produces.filter((field) => {
    const val = _get(jobSpec, field);
    return val === undefined || val === null || val === false || val === '';
  });

  if (missing.length > 0) {
    const jobId = jobSpec?.jobId || 'unknown';
    const msg = [
      `[portal_contract] Portal ${stage} completed but did NOT produce promised outputs:`,
      `  Job: ${jobId}`,
      `  Missing: ${missing.join(', ')}`,
      `  Downstream portals that depend on these will receive missing-input warnings.`,
    ].join('\n');
    console.warn(msg);

    _sentryWarn(`Portal ${stage}: promised outputs not produced`, {
      stage: String(stage),
      jobId,
      templateId: jobSpec?.templateId,
      missingOutputs: missing,
    });
  }
}

// ── Internal Sentry helper (non-fatal, no hard dependency on @sentry/node) ──
function _sentryWarn(message, context) {
  try {
    const Sentry = require('@sentry/node');
    if (!process.env.SENTRY_DSN) return;
    Sentry.withScope((scope) => {
      scope.setTag('portal', context.stage || 'unknown');
      scope.setTag('check', 'portal_contract');
      scope.setContext('contract_violation', context);
      Sentry.captureMessage(message, 'warning');
    });
  } catch (_) {
    // Sentry not loaded — non-fatal, warning already logged to stdout
  }
}

module.exports = { validatePortalInput, validatePortalOutput, CONTRACTS };
