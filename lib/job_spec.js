'use strict';
// lib/job_spec.js — Job Spec schema, CRUD, and customer config loader.
// The Job Spec is the single document every pipeline stage reads.
// Created once at job start, never reconstructed from transient state.

const fs   = require('fs');
const path = require('path');

const CUSTOMERS_DIR = path.join(__dirname, '..', 'config', 'customers');

// ── Customer Config ───────────────────────────────────────────────────────────

/**
 * Load and return a customer config by customerId.
 * Resolves ${VAR_NAME} placeholders from process.env.
 * Throws if the config file is missing or invalid.
 */
function loadCustomerConfig(customerId) {
  const filePath = path.join(CUSTOMERS_DIR, `${customerId}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`[job_spec] No customer config found for customerId="${customerId}" at ${filePath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`[job_spec] Failed to read customer config for "${customerId}": ${e.message}`);
  }

  // Resolve ${VAR_NAME} env var placeholders
  const resolved = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      console.warn(`[job_spec] Warning: env var "${varName}" not set for customer "${customerId}" — using empty string`);
      return '';
    }
    return value;
  });

  try {
    return JSON.parse(resolved);
  } catch (e) {
    throw new Error(`[job_spec] Failed to parse customer config for "${customerId}": ${e.message}`);
  }
}

// ── Design Spec Builder ───────────────────────────────────────────────────────

/**
 * Build a complete designSpec from customer config, templateId, and contentType.
 * Returns the designSpec object suitable for embedding in a Job Spec.
 */
function buildDesignSpec(customerConfig, templateId, contentType) {
  const template = customerConfig.templates[templateId];
  if (!template) {
    throw new Error(`[job_spec] Template "${templateId}" not found in customer config for "${customerConfig.customerId}"`);
  }

  const d = template.designDefaults;
  const chromeSkin = (d.chrome && d.chrome.skins && d.chrome.skins[contentType])
    ? d.chrome.skins[contentType]
    : {};

  // Derive expected clip count from scene formula
  // e.g. "1 + (items * 4) + 1" with maxItems → clips = maxItems (one per item)
  const maxItems = (template.maxItems && template.maxItems[contentType]) || 1;
  const sceneFormula = (template.sceneFormulas && template.sceneFormulas[contentType]) || '';
  // clips = number of [CLIP PLAYS HERE] markers = number of items (1 per item for news/sports, varies for clips)
  const clipsPerItem = contentType === 'clips' ? 3 : 1; // clips-long has 3 clips per streamer
  const expectedClipCount = maxItems * clipsPerItem;

  // Avatar + voice config
  const avatarId   = process.env[templateId === 'short-form' ? 'HEYGEN_AVATAR_SHORT_ID' : 'HEYGEN_AVATAR_ID'] || d.avatarId || null;
  const voiceId    = process.env.HEYGEN_VOICE_ID || d.voiceId || null;
  const speakSpeed = parseFloat(process.env.HEYGEN_SPEAK_SPEED || '') || d.speakSpeed || 0.85;

  return {
    templateId,
    chrome: {
      templateFile:  (d.chrome && d.chrome.templateFile)  || null,
      skin:          contentType || null,
      accentColor:   chromeSkin.accentColor  || null,
      accentColor2:  chromeSkin.accentColor2 || null,
      logoPosition:  (d.chrome && d.chrome.logoPosition)  || null,
      logoSize:      (d.chrome && d.chrome.logoSize)       || null,
      layout:        (d.chrome && d.chrome.layout)         || null,
      splitTop:      (d.chrome && d.chrome.splitTop)       || null,
      splitBottom:   (d.chrome && d.chrome.splitBottom)    || null,
      captionStyle:  (d.chrome && d.chrome.captionStyle)   || null,
    },
    audio: {
      mixMode:     (d.audio && d.audio.mixMode)     || 'both',
      avatarTrack: (d.audio && d.audio.avatarTrack) !== undefined ? d.audio.avatarTrack : true,
      sourceTrack: (d.audio && d.audio.sourceTrack) !== undefined ? d.audio.sourceTrack : true,
    },
    resolution:         d.resolution || { width: 1920, height: 1080 },
    fps:                (template.ffmpeg && template.ffmpeg.fps) || 30,
    avatarId,
    voiceId,
    speakSpeed,
    expectedClipCount,
    maxItems,
    qaThresholds:       template.qaThresholds || {},
    voice:              template.voice || {},
    ffmpeg: {
      codec:          (template.ffmpeg && template.ffmpeg.codec)          || 'libx264',
      codecFallback:  (template.ffmpeg && template.ffmpeg.codecFallback)  || 'libx264',
      audioCodec:     (template.ffmpeg && template.ffmpeg.audioCodec)     || 'aac',
      audioBitrate:   (template.ffmpeg && template.ffmpeg.audioBitrate)   || '192k',
      dissolveSeconds:(template.ffmpeg && template.ffmpeg.dissolveSeconds) || null,
    },
    // Per-content-type assembly settings — replaces hardcoded contentType branches in assembly.js
    // Read by assembly using: designSpec.assembly[baseContentType]?.sourceCropFilter etc.
    assembly: template.assemblyConfig || {}
  };
}

// ── Delivery Spec Builder ─────────────────────────────────────────────────────

/**
 * Build a deliverySpec from customer config and contentType.
 */
function buildDeliverySpec(customerConfig, contentType, scheduledAt) {
  const d = customerConfig.delivery || {};

  // Fall back to contentTypes.json publish config when customerConfig.delivery.platforms is empty.
  // c0.json has no top-level delivery.platforms block — platforms live in
  // contentTypes.json → contentTypes[baseType].publish.platforms instead.
  let platformsFromContentType = [];
  try {
    const { getPublishConfig } = require('./configLoader');
    const baseType = (contentType || '').replace(/-short$/, '');
    const publishCfg = getPublishConfig(baseType);
    platformsFromContentType = (publishCfg && publishCfg.platforms) ? publishCfg.platforms : [];
  } catch (e) {
    // configLoader may not know this contentType — silently skip
  }

  return {
    platforms:         d.platforms          || platformsFromContentType,
    visibility:        d.visibility         || 'private',
    driveFolderId:     d.driveFolderId      || null,
    uploadPostProfile: d.uploadPostProfile  || null,
    categoryId:        (d.categoryIds && d.categoryIds[contentType]) || null,
    scheduledAt:       scheduledAt          || null,
  };
}

// ── Blank Commitment ──────────────────────────────────────────────────────────

function blankCommitment() {
  return { status: 'pending', summary: null, issuedAt: null };
}

// ── Create Job Spec ───────────────────────────────────────────────────────────

/**
 * Create a new Job Spec from params + customer config. Saves to DB. Returns the jobSpec.
 *
 * Required params:
 *   customerId   string    — e.g. 'c0'
 *   templateId   string    — 'long-form' | 'short-form'
 *   contentType  string    — e.g. 'news', 'clips', 'sports'
 *
 * Optional params:
 *   createdBy    string    — 'dashboard' | 'api' | 'agent'  (default: 'api')
 *   sourceType   string    — 'url_list' | 'site_scrape' | 'repo' | 'upload' | 'job_renders' | 'none'
 *   sourceConfig object    — { urls, siteTarget, repoId, uploadSessionId, renderJobId }
 *   title        string    — job title
 *   scheduledAt  string    — ISO-8601 scheduled publish time
 *   stageMap     object    — override default stage map (partial allowed)
 */
function createJobSpec(params) {
  const {
    customerId,
    templateId,
    contentType,
    createdBy   = 'api',
    sourceType  = 'none',
    sourceConfig = {},
    title       = null,
    scheduledAt = null,
    stageMap    = {},
  } = params;

  if (!customerId)  throw new Error('[job_spec] createJobSpec: customerId is required');
  if (!contentType) throw new Error('[job_spec] createJobSpec: contentType is required');

  const customerConfig = loadCustomerConfig(customerId);

  // Auto-detect templateId from contentType if not provided or wrong
  // contentTypes ending in -short always use 'short-form' template
  const resolvedTemplateId = contentType.includes('-short') ? 'short-form'
    : (templateId && customerConfig.templates[templateId] ? templateId : 'long-form');

  // Normalize contentType — strip -short suffix for template lookup (template keys are 'news','clips','sports')
  const baseContentType = contentType.replace(/-short$/, '');

  const template = customerConfig.templates[resolvedTemplateId];
  if (!template) {
    throw new Error(`[job_spec] Template "${resolvedTemplateId}" not found for customer "${customerId}"`);
  }

  // Semantic job ID — readable at a glance in DB, logs, BullMQ, New Relic
  // Format: {customerId}_{COMPACT|EXTRACT}_{DIRECT|FETCH|GEN}_{contentType}_{timestamp}
  // COMPACT = shorts → long-form assembly | EXTRACT = long-form → shorts
  // DIRECT = customer provides files | FETCH = scrape/URL | GEN = generative AI
  const jobTypeCode = resolvedTemplateId === 'short-form' ? 'EXTRACT' : 'COMPACT';
  const inputMethodCode = (() => {
    if (sourceType === 'upload' || sourceType === 'job_renders' || sourceType === 'none') return 'DIRECT';
    if (sourceType === 'site_scrape' || sourceType === 'url_list' || sourceType === 'repo') return 'FETCH';
    if (sourceType === 'runway_gen' || sourceType === 'higgsfield_gen') return 'GEN';
    return 'DIRECT';
  })();
  const jobId = `${customerId}_${jobTypeCode}_${inputMethodCode}_${contentType}_${Date.now()}`;
  const now      = new Date().toISOString();
  const providers = template.providers || {};

  // Build default stageMap from customer config providers
  const defaultStageMap = {
    fetch:    { active: !!providers.fetch,    provider: providers.fetch    || null, approvalMode: 'auto' },
    script:   { active: !!providers.script,   provider: providers.script   || null, approvalMode: 'auto' },
    scaffold: { active: true,                 provider: 'internal',                 approvalMode: 'auto' },
    avatar:   { active: !!providers.avatar,   provider: providers.avatar   || null, approvalMode: 'auto' },
    assembly: { active: !!providers.assembly, provider: providers.assembly || null, approvalMode: 'auto' },
    upload:   { active: !!providers.upload,   provider: providers.upload   || null, approvalMode: 'auto' },
  };

  // Merge caller-supplied stageMap overrides (partial)
  const mergedStageMap = {};
  for (const stage of Object.keys(defaultStageMap)) {
    mergedStageMap[stage] = Object.assign({}, defaultStageMap[stage], stageMap[stage] || {});
  }

  const designSpec   = buildDesignSpec(customerConfig, resolvedTemplateId, baseContentType);
  const deliverySpec = buildDeliverySpec(customerConfig, baseContentType, scheduledAt);

  // Determine aspect ratio + resolution from designSpec
  // Short-form is always 9:16 portrait regardless of resolution defaults
  const formFactor  = (resolvedTemplateId === 'short-form') ? 'short' : 'long';
  const res = designSpec.resolution;
  const aspectRatio = formFactor === 'short' ? '9:16'
    : (res.width === 1080 && res.height === 1920) ? '9:16' : '16:9';

  const jobSpec = {
    jobId,
    customerId,
    showId:         customerConfig.showId  || null,
    templateId:     resolvedTemplateId,     // always resolved — short-form for -short content types
    contentType,                            // original contentType (e.g. 'news-short') preserved
    baseContentType,                        // stripped (e.g. 'news') for template/config lookups
    createdAt:      now,
    createdBy,
    scriptJobId:    params.scriptJobId || null,  // cross-reference to script_gen job card ID

    order: {
      inputs: {
        sourceType,
        sourceConfig: {
          urls:            sourceConfig.urls            || null,
          siteTarget:      sourceConfig.siteTarget      || null,
          repoId:          sourceConfig.repoId          || null,
          uploadSessionId: sourceConfig.uploadSessionId || null,
          renderJobId:     sourceConfig.renderJobId     || null,
        },
        items:     [],
        itemCount: 0,
      },
      output: {
        formFactor,
        aspectRatio,
        resolution:              res,
        estimatedDurationSeconds: null,
      },
      meta: {
        title,
        scheduledAt,
      },
    },

    stageMap: mergedStageMap,
    designSpec,
    deliverySpec,

    commitments: {
      fetch:    blankCommitment(),
      script:   blankCommitment(),
      scaffold: blankCommitment(),
      avatar:   blankCommitment(),
      assembly: blankCommitment(),
      upload:   blankCommitment(),
    },

    state: {
      currentGate:  null,
      currentStage: 'fetch',
      status:       'pending',
      gateResults: {
        gate0:  null,
        gate1:  null,
        gate2:  null,
        gate3a: null,
        gate3b: null,
        gate4:  null,
        gate5:  null,
      },
      savedOutputs: {
        scaffold:      null,
        filledScript:  null,
        segmentPaths:  null,
        assembledPath: null,
        driveUrl:      null,
        publishCopy:   null,
      },
      failedAt:    null,
      failedGate:  null,
      rootCause:   null,
      restartGate: null,
    },
  };

  // Persist to DB
  const { updateJobSpec: dbUpdateJobSpec, saveJob: dbSaveJob } = require('./db');
  dbSaveJob(jobId, {
    contentType,
    formType:  formFactor,
    status:    'pending',
    stage:     'fetch',
    createdAt: now,
  });
  dbUpdateJobSpec(jobId, jobSpec);

  console.log(`[job_spec] Created jobId=${jobId}`);
  return jobSpec;
}

// ── Get Job Spec ──────────────────────────────────────────────────────────────

/**
 * Read a Job Spec from the DB by jobId.
 * Returns the parsed jobSpec or null if not found.
 */
function getJobSpec(jobId) {
  const { getJobBySpec } = require('./db');
  return getJobBySpec(jobId);
}

// ── Update Job Spec ───────────────────────────────────────────────────────────

/**
 * Apply a partial patch to an existing Job Spec and save to DB.
 * patch is deeply merged into the current spec.
 * Returns the updated jobSpec.
 */
function updateJobSpec(jobId, patch) {
  const current = getJobSpec(jobId);
  if (!current) throw new Error(`[job_spec] updateJobSpec: jobId "${jobId}" not found`);

  const updated = deepMerge(current, patch);

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(jobId, updated);

  return updated;
}

// ── Save Gate Result ──────────────────────────────────────────────────────────

/**
 * Write a gate result into state.gateResults[gate] and persist to DB.
 * Also inserts into the gate_results table.
 * gate: 'gate0' | 'gate1' | 'gate2' | 'gate3a' | 'gate3b' | 'gate4' | 'gate5'
 */
function saveGateResult(jobId, gate, result) {
  const { saveGateResult: dbSaveGateResult } = require('./db');
  dbSaveGateResult(jobId, gate, result);

  // Update the jobSpec in DB
  const current = getJobSpec(jobId);
  if (!current) {
    console.warn(`[job_spec] saveGateResult: jobId "${jobId}" not in DB — gate result saved to gate_results table only`);
    return;
  }

  current.state.gateResults[gate] = result;
  current.state.currentGate = parseInt(gate.replace(/[^0-9]/g, '')) || null;

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(jobId, current);
}

// ── Save Output ───────────────────────────────────────────────────────────────

/**
 * Write a value into state.savedOutputs[key] and persist to DB.
 * key: 'scaffold' | 'filledScript' | 'segmentPaths' | 'assembledPath' | 'driveUrl' | 'publishCopy'
 */
function saveOutput(jobId, key, value) {
  const current = getJobSpec(jobId);
  if (!current) throw new Error(`[job_spec] saveOutput: jobId "${jobId}" not found`);

  current.state.savedOutputs[key] = value;

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(jobId, current);
}

// ── Fail Job ──────────────────────────────────────────────────────────────────

/**
 * Mark a job as failed in the DB with full context.
 */
function failJob(jobId, gate, rootCause, restartGate) {
  const current = getJobSpec(jobId);
  if (!current) {
    console.error(`[job_spec] failJob: jobId "${jobId}" not found in DB`);
    return;
  }

  current.state.status      = 'failed';
  current.state.failedAt    = new Date().toISOString();
  current.state.failedGate  = gate      || null;
  current.state.rootCause   = rootCause || null;
  current.state.restartGate = restartGate !== undefined ? restartGate : null;

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(jobId, current);

  console.log(`[job_spec] Job ${jobId} marked failed at gate=${gate}: ${rootCause}`);
}

// ── Deep Merge Helper ─────────────────────────────────────────────────────────

function deepMerge(target, source) {
  if (source === null || source === undefined) return target;
  if (typeof source !== 'object' || Array.isArray(source)) return source;

  const result = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    if (
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  loadCustomerConfig,
  buildDesignSpec,
  buildDeliverySpec,
  createJobSpec,
  getJobSpec,
  updateJobSpec,
  saveGateResult,
  saveOutput,
  failJob,
};
