'use strict';
// lib/job_spec.js — Job Spec schema, CRUD, and customer config loader.
// The Job Spec is the single document every pipeline stage reads.
// Created once at job start, never reconstructed from transient state.

const fs = require('fs');
const path = require('path');

const CUSTOMERS_DIR = path.join(__dirname, '..', 'config', 'customers');

// ── Customer Config ───────────────────────────────────────────────────────────

/**
 * Load and return a customer config by customerId.
 * Resolves ${VAR_NAME} placeholders from process.env.
 * Throws if the config file is missing or invalid.
 */
function loadCustomerConfig(customerId) {
  let filePath = path.join(CUSTOMERS_DIR, `${customerId}.json`);

  if (!fs.existsSync(filePath)) {
    const defaultPath = path.join(CUSTOMERS_DIR, 'c1_default.json');
    if (fs.existsSync(defaultPath)) {
      console.log(
        `[job_spec] No customer config for "${customerId}" — using c1_default`
      );
      filePath = defaultPath;
    } else {
      throw new Error(
        `[job_spec] No customer config found for customerId="${customerId}" at ${filePath}`
      );
    }
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
      console.warn(
        `[job_spec] Warning: env var "${varName}" not set for customer "${customerId}" — using empty string`
      );
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
    throw new Error(
      `[job_spec] Template "${templateId}" not found in customer config for "${customerConfig.customerId}"`
    );
  }

  const d = template.designDefaults;
  const chromeSkin =
    d.chrome && d.chrome.skins && d.chrome.skins[contentType] ? d.chrome.skins[contentType] : {};

  // Derive expected clip count from scene formula
  // e.g. "1 + (items * 4) + 1" with maxItems → clips = maxItems (one per item)
  const maxItems = (template.maxItems && template.maxItems[contentType]) || 1;
  const sceneFormula = (template.sceneFormulas && template.sceneFormulas[contentType]) || '';
  // clips = number of [CLIP PLAYS HERE] markers = number of items (1 per item for news/sports, varies for clips)
  const clipsPerItem = contentType === 'clips' ? 3 : 1; // clips-long has 3 clips per streamer
  const expectedClipCount = maxItems * clipsPerItem;

  // Avatar + voice config
  const avatarId =
    process.env[templateId === 'short-form' ? 'HEYGEN_AVATAR_SHORT_ID' : 'HEYGEN_AVATAR_ID'] ||
    d.avatarId ||
    null;
  const voiceId = process.env.HEYGEN_VOICE_ID || d.voiceId || null;
  const speakSpeed = parseFloat(process.env.HEYGEN_SPEAK_SPEED || '') || d.speakSpeed || 0.85;

  return {
    templateId,
    chrome: {
      templateFile: (d.chrome && d.chrome.templateFile) || null,
      skin: contentType || null,
      accentColor: chromeSkin.accentColor || null,
      accentColor2: chromeSkin.accentColor2 || null,
      logoPosition: (d.chrome && d.chrome.logoPosition) || null,
      logoSize: (d.chrome && d.chrome.logoSize) || null,
      layout: (d.chrome && d.chrome.layout) || null,
      splitTop: (d.chrome && d.chrome.splitTop) || null,
      splitBottom: (d.chrome && d.chrome.splitBottom) || null,
      captionStyle: (d.chrome && d.chrome.captionStyle) || null,
      // Explicit element presence — gates read these instead of inferring from content type name.
      // Customer config is the single source of truth. Default is FALSE (opt-in) — chrome only
      // fires when the customer's template explicitly declares it. C1/Operate API jobs have no
      // chrome overlays on assembled clips, so they must not inherit a true default here.
      hasTopBar: d.chrome && d.chrome.hasTopBar !== undefined ? d.chrome.hasTopBar : false,
      hasFlag: d.chrome && d.chrome.hasFlag !== undefined ? d.chrome.hasFlag : false,
      hasSidebar: d.chrome && d.chrome.hasSidebar !== undefined ? d.chrome.hasSidebar : false,
      hasTicker: d.chrome && d.chrome.hasTicker !== undefined ? d.chrome.hasTicker : false,
      hasLogo: d.chrome && d.chrome.hasLogo !== undefined ? d.chrome.hasLogo : false,
    },
    audio: {
      mixMode: (d.audio && d.audio.mixMode) || 'both',
      avatarTrack: (d.audio && d.audio.avatarTrack) !== undefined ? d.audio.avatarTrack : true,
      sourceTrack: (d.audio && d.audio.sourceTrack) !== undefined ? d.audio.sourceTrack : true,
    },
    resolution: d.resolution || { width: 1920, height: 1080 },
    fps: (template.ffmpeg && template.ffmpeg.fps) || 30,
    avatarId,
    voiceId,
    speakSpeed,
    expectedClipCount,
    maxItems,
    qaThresholds: template.qaThresholds || {},
    voice: template.voice || {},
    ffmpeg: {
      codec: (template.ffmpeg && template.ffmpeg.codec) || 'libx264',
      codecFallback: (template.ffmpeg && template.ffmpeg.codecFallback) || 'libx264',
      audioCodec: (template.ffmpeg && template.ffmpeg.audioCodec) || 'aac',
      audioBitrate: (template.ffmpeg && template.ffmpeg.audioBitrate) || '192k',
      dissolveSeconds: (template.ffmpeg && template.ffmpeg.dissolveSeconds) || null,
    },
    // Per-content-type assembly settings — replaces hardcoded contentType branches in assembly.js
    // Read by assembly using: designSpec.assembly[baseContentType]?.sourceCropFilter etc.
    assembly: template.assemblyConfig || {},
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
    // Try exact content type first (e.g. "nba-short" gets its own platform list, not the long-form one)
    // Fall back to base type when exact type has no publish config
    let publishCfg = null;
    try {
      publishCfg = getPublishConfig(contentType);
    } catch (_) {
      /* unknown exact type */
    }
    if (!publishCfg?.platforms?.length) {
      const baseType = (contentType || '').replace(/-short$/, '');
      try {
        publishCfg = getPublishConfig(baseType);
      } catch (_) {
        /* unknown base type */
      }
    }
    platformsFromContentType = publishCfg && publishCfg.platforms ? publishCfg.platforms : [];
  } catch (e) {
    // configLoader may not know this contentType — silently skip
  }

  let platforms = d.platforms || platformsFromContentType;
  try {
    const { readAutoPublishPlatformsEnv } = require('./auto_publish_env');
    const fromEnv = readAutoPublishPlatformsEnv();
    if (fromEnv !== null) platforms = fromEnv;
  } catch (_e) {
    /* non-fatal */
  }

  return {
    platforms,
    visibility: d.visibility || 'private',
    driveFolderId: d.driveFolderId || null,
    uploadPostProfile: d.uploadPostProfile || null,
    categoryId: (d.categoryIds && d.categoryIds[contentType]) || null,
    scheduledAt: scheduledAt || null,
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
 *   sourceType   string    — 'url_list' | 'site_scrape' | 'repo' | 'upload' | 'job_renders' | 'wan_gen' | 'runpod_gen' | 'none'
 *   sourceConfig object    — { urls, siteTarget, repoId, uploadSessionId, renderJobId }
 *   title        string    — job title
 *   scheduledAt  string    — ISO-8601 scheduled publish time
 *   stageMap     object    — override default stage map (partial allowed)
 *   expectedSynth boolean — lab/synthetic job: persist so gates 3a/3b/4 skip broadcast Gemini policy (see assembly)
 */
// ── Portal map builders ───────────────────────────────────────────────────────

/**
 * Build the portal activation map for a job spec.
 *
 * Portal definitions:
 *   0  — Source QA (ffprobe): always active
 *   1  — Script QA (Gemini): skip if customer provides own script (sourceType='upload' with own_script flag)
 *   1b — Video Reviewer (Gemini): active when source clips are videos to review
 *   2  — Render Quality (ffprobe): always active (when avatar provider is present)
 *   3a — Assembly QA (Gemini 3-sample): always active post-assembly
 *   3b — Commitment Verification (Claude): always active post-assembly
 *   4  — Broadcast Ready (Gemini full video): always active, authorizes Portal 5
 *   5  — Upload Confirmation (Upload-Post): active when upload provider configured
 *
 * Portal 3 (HeyGen Avatar) is an extension — see buildExtensionsMap().
 *
 * @param {{ providers: object, sourceType: string, stageMap: object, expectedSynth: boolean }}
 * @returns {Object} portal map
 */
function buildPortalMap({ providers, sourceType, stageMap, expectedSynth, contentType }) {
  // stageMap.X.active === false explicitly disables the stage regardless of provider config
  const hasAvatarProvider   = !!(providers.avatar   || stageMap?.avatar?.provider)   && stageMap?.avatar?.active   !== false;
  const hasUploadProvider   = !!(providers.upload   || stageMap?.upload?.provider)   && stageMap?.upload?.active   !== false;
  const hasScriptProvider   = !!(providers.script   || stageMap?.script?.provider)   && stageMap?.script?.active   !== false;
  const hasAssemblyProvider = !!(providers.assembly || stageMap?.assembly?.provider) && stageMap?.assembly?.active !== false;

  // show_commentary forces all portals active regardless of provider config (CPD-75)
  const isCommentary = contentType === 'show_commentary';

  const portal1Active = isCommentary || hasScriptProvider;
  const portal1bActive = isCommentary || !!(providers.videoReviewer);
  const portal2Active = isCommentary || hasAvatarProvider || (stageMap?.avatar?.active === true);
  const portal3Active = isCommentary || hasAssemblyProvider;
  const portal4Active = isCommentary || (hasAssemblyProvider && !expectedSynth);
  const portal5Active = isCommentary || hasUploadProvider;

  return {
    portal0: {
      key: 'portal0',
      label: 'Source QA',
      active: true,
      skippable: false,
      provider: 'ffprobe',
      reason: null,
    },
    portal1: {
      key: 'portal1',
      label: 'Script QA',
      active: portal1Active,
      skippable: true,
      provider: portal1Active ? (providers.script || 'gemini') : null,
      reason: portal1Active ? null : 'No script provider configured — portal skipped',
    },
    portal1b: {
      key: 'portal1b',
      label: 'Video Reviewer',
      active: portal1bActive,
      skippable: true,
      provider: portal1bActive ? 'gemini' : null,
      reason: portal1bActive ? null : 'No video reviewer provider — portal skipped',
    },
    portal2: {
      key: 'portal2',
      label: 'Render Quality',
      active: portal2Active,
      skippable: true,
      provider: portal2Active ? 'ffprobe' : null,
      reason: portal2Active ? null : 'No avatar/render provider — portal skipped',
    },
    portal3a: {
      key: 'portal3a',
      label: 'Assembly QA',
      active: portal3Active,
      skippable: false,
      provider: portal3Active ? 'gemini' : null,
      reason: portal3Active ? null : 'No assembly provider — portal skipped',
    },
    portal3b: {
      key: 'portal3b',
      label: 'Commitment Verification',
      active: portal3Active,
      skippable: false,
      provider: portal3Active ? 'internal' : null,
      reason: portal3Active ? null : 'No assembly provider — portal 3b skipped',
    },
    portal4: {
      key: 'portal4',
      label: 'Broadcast Ready',
      active: portal4Active,
      skippable: false,
      provider: portal4Active ? 'gemini' : null,
      reason: expectedSynth && !isCommentary
        ? 'expectedSynth/lab job — broadcast QA skipped'
        : portal4Active
          ? null
          : 'No assembly provider — portal 4 skipped',
    },
    portal5: {
      key: 'portal5',
      label: 'Upload Confirmation',
      active: portal5Active,
      skippable: true,
      provider: portal5Active ? (providers.upload || 'upload_post') : null,
      reason: portal5Active ? null : 'No upload provider configured — portal skipped',
    },
  };
}

/**
 * Build the extensions map — add-ons ordered explicitly by the job spec.
 * Extensions are NOT active by default; they must be ordered in the job spec.
 *
 * @param {object} providers — from customer config template
 * @returns {object} extensions map with heygen_ext and shoppable_ext
 */
function buildExtensionsMap(providers) {
  return {
    heygen_ext: {
      key: 'heygen_ext',
      label: 'HeyGen Avatar (Extension)',
      ordered: false, // set to true by caller when job spec includes avatar_type=heygen
      provider: providers.avatar === 'heygen' ? 'heygen' : null,
      reason: 'Extension: only active when explicitly ordered by job spec',
    },
    tts_ext: {
      key: 'tts_ext',
      label: 'ElevenLabs TTS / VO (Extension)',
      ordered: false, // set to true when addOns.tts.active === true
      provider: 'elevenlabs',
      reason: 'Extension: only active when explicitly ordered by job spec',
    },
    thumbnail_ext: {
      key: 'thumbnail_ext',
      label: 'Thumbnail Approval Stage (Extension)',
      ordered: false, // set to true when addOns.thumbnailApproval.active === true
      provider: null,
      reason: 'Extension: fires after Portal 4 to generate candidate thumbnails for customer approval',
    },
    shoppable_ext: {
      key: 'shoppable_ext',
      label: 'Shoppable Video (Extension)',
      ordered: false,
      provider: null,
      reason: 'Extension: only active when explicitly ordered by job spec',
    },
  };
}

/**
 * Return the ordered list of active portals for a job spec.
 * Portals are returned in execution order: 0, 1, 1b, 2, 3a, 3b, 4, 5.
 * Inactive portals are excluded.
 *
 * @param {object} jobSpec — a job spec created by createJobSpec()
 * @returns {string[]} ordered list of active portal keys, e.g. ['portal0','portal1','portal2',...]
 */
function resolveActivePortals(jobSpec) {
  const portals = jobSpec?.portals;
  if (!portals) return [];

  const ORDER = ['portal0', 'portal1', 'portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'];
  return ORDER.filter((key) => portals[key]?.active === true);
}

/**
 * Return the ordered list of active extensions for a job spec.
 * Only returns extensions that have been explicitly ordered (ordered: true).
 *
 * @param {object} jobSpec
 * @returns {string[]} ordered list of active extension keys
 */
function resolveActiveExtensions(jobSpec) {
  const extensions = jobSpec?.extensions;
  if (!extensions) return [];
  return Object.keys(extensions).filter((key) => extensions[key]?.ordered === true);
}

function createJobSpec(params) {
  const {
    customerId,
    brandId = null,    // CPD-328: UUID of the brand this job belongs to
    templateId,
    contentType,
    createdBy = 'api',
    sourceType = 'none',
    sourceConfig = {},
    title = null,
    scheduledAt = null,
    stageMap = {},
    expectedSynth = false,
    addOns = {},
    planTier = null,   // 'operate' | 'guided' | 'managed' | 'custom' — baked in at job creation
    durationMins = null, // CPD-115: customer-specified output duration in minutes
  } = params;

  if (!customerId) throw new Error('[job_spec] createJobSpec: customerId is required');
  if (!contentType) throw new Error('[job_spec] createJobSpec: contentType is required');

  const customerConfig = loadCustomerConfig(customerId);

  // Auto-detect templateId from contentType if not provided or wrong
  // contentTypes ending in -short always use 'short-form' template
  const resolvedTemplateId = contentType.includes('-short')
    ? 'short-form'
    : templateId && customerConfig.templates[templateId]
      ? templateId
      : 'long-form';

  // Normalize contentType — strip -short suffix for template lookup (template keys are 'news','clips','sports')
  const baseContentType = contentType.replace(/-short$/, '');

  const template = customerConfig.templates[resolvedTemplateId];
  if (!template) {
    throw new Error(
      `[job_spec] Template "${resolvedTemplateId}" not found for customer "${customerId}"`
    );
  }

  // Semantic job ID — readable at a glance in DB, logs, BullMQ, New Relic
  // Format: {customerId}_{COMPACT|EXTRACT}_{DIRECT|FETCH|GEN}_{contentType}_{timestamp}
  // COMPACT = shorts → long-form assembly | EXTRACT = long-form → shorts
  // DIRECT = customer provides files | FETCH = scrape/URL | GEN = generative AI
  const jobTypeCode = resolvedTemplateId === 'short-form' ? 'EXTRACT' : 'COMPACT';
  const inputMethodCode = (() => {
    if (sourceType === 'upload' || sourceType === 'job_renders' || sourceType === 'none')
      return 'DIRECT';
    if (sourceType === 'site_scrape' || sourceType === 'url_list' || sourceType === 'repo')
      return 'FETCH';
    if (sourceType === 'runway_gen' || sourceType === 'higgsfield_gen') return 'GEN';
    if (sourceType === 'wan_gen' || sourceType === 'runpod_gen') return 'GEN';
    if (sourceType === 'research_query') return 'FETCH';
    return 'DIRECT';
  })();
  const jobId = `${customerId}_${jobTypeCode}_${inputMethodCode}_${contentType}_${Date.now()}`;
  const now = new Date().toISOString();
  const providers = template.providers || {};

  // Build default stageMap from customer config providers
  const defaultStageMap = {
    fetch: { active: !!providers.fetch, provider: providers.fetch || null, approvalMode: 'auto' },
    script: {
      active: !!providers.script,
      provider: providers.script || null,
      approvalMode: 'auto',
    },
    scaffold: { active: true, provider: 'internal', approvalMode: 'auto' },
    avatar: {
      active: !!providers.avatar,
      provider: providers.avatar || null,
      approvalMode: 'auto',
    },
    assembly: {
      active: !!providers.assembly,
      provider: providers.assembly || null,
      approvalMode: 'auto',
    },
    upload: {
      active: !!providers.upload,
      provider: providers.upload || null,
      approvalMode: 'auto',
    },
  };

  // Merge caller-supplied stageMap overrides (partial)
  const mergedStageMap = {};
  for (const stage of Object.keys(defaultStageMap)) {
    mergedStageMap[stage] = Object.assign({}, defaultStageMap[stage], stageMap[stage] || {});
  }

  const designSpec = buildDesignSpec(customerConfig, resolvedTemplateId, baseContentType);
  const deliverySpec = buildDeliverySpec(customerConfig, baseContentType, scheduledAt);

  // Determine aspect ratio + resolution from designSpec
  // Short-form is always 9:16 portrait regardless of resolution defaults
  const formFactor = resolvedTemplateId === 'short-form' ? 'short' : 'long';
  const res = designSpec.resolution;
  const aspectRatio =
    formFactor === 'short' ? '9:16' : res.width === 1080 && res.height === 1920 ? '9:16' : '16:9';

  const selfHealMax = parseInt(process.env.AUTOMATION_SELF_HEAL_MAX || '2', 10);

  // Bake plan tier + feature flags into the job spec at creation time.
  // Feature flags are a snapshot — they reflect what the plan + current env allows.
  // Downstream services (thumbnail_stage, portal workers, etc.) read from here —
  // no additional DB lookups needed.
  const resolvedPlanTier = planTier || customerConfig.planTier || 'operate';
  let featureFlags = {};
  let isFeatureEnabledFn = () => true; // fallback: no gate in test / non-migrated envs
  try {
    const { buildFeatureFlags, isFeatureEnabled: _ife } = require('./services/feature_gate');
    featureFlags = buildFeatureFlags(resolvedPlanTier);
    isFeatureEnabledFn = _ife;
  } catch (_e) { /* non-fatal */ }

  // Plan-gate content types and source types before any work is done.
  if (baseContentType === 'show_commentary' && !isFeatureEnabledFn('content.show_commentary', resolvedPlanTier)) {
    throw new Error(`[job_spec] Content type 'show_commentary' requires plan dwy or higher (current: ${resolvedPlanTier})`);
  }
  if (baseContentType === 'custom' && !isFeatureEnabledFn('content.custom', resolvedPlanTier)) {
    throw new Error(`[job_spec] Content type 'custom' requires plan dwy or higher (current: ${resolvedPlanTier})`);
  }
  if (sourceType === 'wan_gen') {
    const genType = sourceConfig?.genType;
    const requiredFeature = genType === 'image' ? 'video.wan_i2v' : 'video.wan_t2v';
    if (!isFeatureEnabledFn(requiredFeature, resolvedPlanTier)) {
      throw new Error(`[job_spec] AI video generation (${genType || 'text'}) requires plan ${genType === 'image' ? 'managed' : 'guided'} or higher (current: ${resolvedPlanTier})`);
    }
  }

  // CPD-115: Calculate credit cost from features + duration
  let creditCost = 10; // minimum (XS base)
  try {
    const { calculateCreditCost, deriveFeatures } = require('./services/credit_calculator');
    const resolvedDuration = durationMins || (resolvedTemplateId === 'short-form' ? 1 : 3);
    const { aiFeature, addOns: flatAddOns } = deriveFeatures({
      addOns,
      sourceType,
      contentType,
      planTier: resolvedPlanTier,
    });
    const { credits } = calculateCreditCost({ durationMins: resolvedDuration, aiFeature, addOns: flatAddOns, planTier: resolvedPlanTier });
    creditCost = credits;
  } catch (_e) { /* non-fatal — falls back to base 10 */ }

  const jobSpec = {
    jobId,
    customerId,
    brandId: brandId || null,  // CPD-328: brand context for multi-brand accounts
    showId: customerConfig.showId || null,
    templateId: resolvedTemplateId,
    contentType,
    baseContentType,
    createdAt: now,
    createdBy,
    scriptJobId: params.scriptJobId || null,
    expectedSynth: !!expectedSynth,

    // Plan context — baked in at creation, used by all downstream services for feature gating
    planTier:     resolvedPlanTier,
    featureFlags, // { 'thumbnail.imagen': true, 'tts.elevenlabs': false, ... }

    // CPD-115: Credit cost baked in at creation — consumeCredits reads this, not a flat lookup
    durationMins: durationMins || (resolvedTemplateId === 'short-form' ? 1 : 3),
    creditCost,   // total credits to deduct on job completion / refund on hard failure

    order: {
      inputs: {
        sourceType,
        sourceConfig: {
          urls: sourceConfig.urls || null,
          siteTarget: sourceConfig.siteTarget || null,
          repoId: sourceConfig.repoId || null,
          uploadSessionId: sourceConfig.uploadSessionId || null,
          renderJobId: sourceConfig.renderJobId || null,
          // WAN gen fields (sourceType='wan_gen') — must be preserved or _runWanPreGeneration finds no prompt
          prompt: sourceConfig.prompt || null,
          genType: sourceConfig.genType || null,
          imageId: sourceConfig.imageId || null,
          width: sourceConfig.width || null,
          height: sourceConfig.height || null,
          numFrames: sourceConfig.numFrames || null,
          seed: sourceConfig.seed || null,
        },
        items: (sourceType === 'url_list' && Array.isArray(sourceConfig.urls) && sourceConfig.urls.length > 0)
          ? sourceConfig.urls.map((url, i) => ({ id: `url_${i}`, url }))
          : [],
        itemCount: (sourceType === 'url_list' && Array.isArray(sourceConfig.urls))
          ? sourceConfig.urls.length
          : 0,
      },
      output: {
        formFactor,
        aspectRatio,
        resolution: res,
        estimatedDurationSeconds: null,
      },
      meta: {
        title,
        scheduledAt,
      },
    },

    stageMap: mergedStageMap,

    // portals — spec-driven portal map (CPD-65).
    // Each key maps to { active, skippable, provider, reason }.
    // active=false means the portal is skipped for this job.
    // skippable=true means the job spec may legitimately skip this portal.
    // reason explains why a portal is inactive (for observability).
    //
    // Portals always run (not skippable): 0, 2, 3a, 3b, 4, 5
    // Portals conditionally active: 1 (script gen — skip if customer owns the script),
    //   1b (video reviewer), 3 (HeyGen avatar — add-on only, skip if no avatar provider)
    // Extensions (ordered explicitly by job spec): heygen_ext, shoppable_ext
    portals: buildPortalMap({ providers, sourceType, stageMap: mergedStageMap, expectedSynth, contentType }),

    // commentary config — pre-populated for show_commentary content type (CPD-75)
    commentaryConfig: (() => {
      if (contentType !== 'show_commentary') return null;
      const PRESETS = require('./presets/definitions');
      return PRESETS.preset_show_commentary?.commentaryConfig || {
        scriptTemplate: {
          format: 'multi_topic',
          topicCount: 5,
          paragraphsPerTopic: 3,
          toneProfile: 'analytical_conversational',
        },
        assembly: { mode: 'commentary', overlayMode: 'broll_full', transitions: 'cut' },
      };
    })(),

    // extensions — add-ons activated by the job spec (not always-on portals).
    // addOns param (e.g. { heygen: { active, avatarId, voiceId } }) overrides ordered flag. (CPD-68)
    extensions: (() => {
      const ext = buildExtensionsMap(providers);
      if (addOns?.heygen?.active === true) {
        ext.heygen_ext.ordered = true;
        if (addOns.heygen.avatarId) ext.heygen_ext.avatarId = addOns.heygen.avatarId;
        if (addOns.heygen.voiceId) ext.heygen_ext.voiceId = addOns.heygen.voiceId;
      }
      if (addOns?.tts?.active === true) {
        ext.tts_ext.ordered = true;
        if (addOns.tts.voiceId) ext.tts_ext.voiceId = addOns.tts.voiceId;
      }
      if (addOns?.thumbnailApproval?.active === true) {
        ext.thumbnail_ext.ordered = true;
      }
      if (addOns?.shoppable?.active === true) {
        ext.shoppable_ext.ordered = true;
      }
      return ext;
    })(),

    // addOns — human-readable summary of active add-ons (mirrors extensions for API consumers)
    addOns: {
      heygen: {
        active: !!(addOns?.heygen?.active === true),
        avatarId: addOns?.heygen?.avatarId || null,
        voiceId: addOns?.heygen?.voiceId || null,
      },
      tts: {
        active: !!(addOns?.tts?.active === true),
        provider: 'elevenlabs',
        voiceId: addOns?.tts?.voiceId || null,
      },
      thumbnailApproval: {
        active: !!(addOns?.thumbnailApproval?.active === true),
      },
      shoppable: {
        active: !!(addOns?.shoppable?.active === true),
      },
      // CPD-173: visual production flags — wired into assembly/chrome pipeline
      branding: {
        active: !!(addOns?.branding?.active === true),
      },
      imageBurn: {
        active: !!(addOns?.imageBurn?.active === true),
      },
      dynamicOverlays: {
        active: !!(addOns?.dynamicOverlays?.active === true),
      },
    },

    designSpec,
    deliverySpec,

    commitments: {
      fetch: blankCommitment(),
      script: blankCommitment(),
      scaffold: blankCommitment(),
      avatar: blankCommitment(),
      assembly: blankCommitment(),
      upload: blankCommitment(),
    },

    state: {
      currentGate: null,
      currentStage: 'fetch',
      status: 'pending',
      gateResults: {
        gate0: null,
        gate1: null,
        gate2: null,
        gate3a: null,
        gate3b: null,
        gate4: null,
        gate5: null,
      },
      savedOutputs: {
        scaffold: null,
        filledScript: null,
        transcriptBlocks: null,
        segmentPaths: null,
        assembledPath: null,
        driveUrl: null,
        publishCopy: null,
      },
      failedAt: null,
      failedGate: null,
      rootCause: null,
      restartGate: null,
      automation: {
        selfHealMaxAttempts: Number.isFinite(selfHealMax) && selfHealMax > 0 ? selfHealMax : 2,
        selfHealAttempts: 0,
        lastSelfHealAt: null,
        lastSelfHealKind: null,
        escalationAttempts: 0,
        lastEscalationAt: null,
        agentEscalated: false,
        agentEscalatedAt: null,
        agentEscalationReason: null,
        qaCycle: { byGate: {} },
      },
    },
  };

  // ── PRE-GENERATE: Resolve scaffold immediately — sceneStructure known before generation ──
  // Items may be provided at createJobSpec time (e.g. from dashboard pre-fill).
  // If items are present, we scaffold now so canProduce() gates have full context.
  // If items are absent (empty order), scaffold happens later in script_gen.js (backward compat).
  const preItems = params.items || [];
  if (preItems.length > 0) {
    try {
      const { generateScaffold } = require('./scaffold');
      const scaffoldJobSpec = {
        ...jobSpec,
        order: {
          ...jobSpec.order,
          contentType,
          formType: formFactor,
          inputs: {
            ...jobSpec.order.inputs,
            items: preItems.map((item, i) => ({
              id: String(i),
              name: item.displayName || item.streamer || item.name || `ITEM${i + 1}`,
              title: item.title || item.displayName || item.name || String(i),
              teams: item.away && item.home ? `${item.away}_VS_${item.home}` : item.title || '',
              url: item.videoUrl || item.clipUrl || item.url || '',
            })),
          },
        },
      };
      const scaffoldResult = generateScaffold(scaffoldJobSpec);
      if (scaffoldResult) {
        jobSpec.designSpec.sceneStructure = {
          sceneHeaders: scaffoldResult.sceneHeaders || [],
          expectedSceneCount: scaffoldResult.expectedSceneCount || 0,
          expectedClipCount: scaffoldResult.expectedClipCount || 0,
          templateId: scaffoldResult.templateId || resolvedTemplateId,
          scaffold: scaffoldResult.scaffold, // full scaffold text with [DIALOGUE] slots
          generatedAt: now,
        };
        // Also set top-level expectedClipCount for gate compat
        jobSpec.designSpec.expectedClipCount = scaffoldResult.expectedClipCount;
        // Store items in sceneStructure for downstream gate context
        jobSpec.designSpec.sceneStructure.items = preItems.map((item, i) => ({
          sceneId: `ITEM${i + 1}`,
          label: item.displayName || item.streamer || item.name || item.title || `Item ${i + 1}`,
          category: item.category || baseContentType.toUpperCase(),
          data: {
            displayName: item.displayName || item.name || item.title || `Item ${i + 1}`,
            url: item.url || item.pageUrl || item.videoUrl || item.clipUrl || '',
            fact: item.fact || item.origin || item.description || '',
            imageUrl: item.imageUrl || item.thumbnailUrl || item.profileImage || '',
            matchup: item.teams || item.title || '',
            twitchUsername: item.username || item.streamer || item.twitchUsername || '',
          },
        }));
        console.log(
          `[job_spec] Scaffold pre-generated at job creation: ${scaffoldResult.expectedSceneCount} scenes, ${scaffoldResult.expectedClipCount} clips`
        );
      }
    } catch (e) {
      // Non-fatal — scaffold will be generated in script_gen.js (backward compat)
      console.warn('[job_spec] Scaffold pre-generation failed (non-fatal):', e.message);
    }
  }

  // ── PRE-GENERATE: Resolve voice + chrome from customerConfig into designSpec ──
  // Done here so gate canProduce() and QA prompts have lockedIntro, lockedOutro,
  // prohibitedWords, showName, categoryLabel at pre-generate time — not just at script-gen time.
  try {
    let voiceBaseType = baseContentType;
    if (['twitch', 'clips', 'streamer'].some((t) => voiceBaseType.includes(t)))
      voiceBaseType = 'clips';
    if (['nba', 'sports', 'basketball'].some((t) => voiceBaseType.includes(t)))
      voiceBaseType = 'sports';
    if (['news', 'world', 'global'].some((t) => voiceBaseType.includes(t))) voiceBaseType = 'news';

    const chromeCfg = customerConfig?.templates?.[resolvedTemplateId]?.designDefaults?.chrome || {};
    const voiceCfg = customerConfig?.templates?.[resolvedTemplateId]?.voice || {};
    const overrides = chromeCfg?.contentTypeOverrides?.[voiceBaseType] || {};

    jobSpec.designSpec.voice = {
      lockedIntro: chromeCfg?.lockedIntro?.[voiceBaseType] || overrides.lockedIntro || null,
      lockedOutro: chromeCfg?.lockedOutro || voiceCfg.outroLine || null,
      showName: chromeCfg?.showName?.[voiceBaseType] || overrides.showName || null,
      categoryLabel: chromeCfg?.categoryLabel?.[voiceBaseType] || null,
      prohibitedWords: voiceCfg.prohibitedWords || [],
      style: voiceCfg.style || null,
      speakerName: voiceCfg.speakerName || 'Host',
    };

    // Also write into chrome for backward compat (some gates read from chrome not voice)
    jobSpec.designSpec.chrome = jobSpec.designSpec.chrome || {};
    jobSpec.designSpec.chrome.showName = jobSpec.designSpec.voice.showName;
    jobSpec.designSpec.chrome.categoryLabel = jobSpec.designSpec.voice.categoryLabel;
    jobSpec.designSpec.chrome.caption = chromeCfg?.caption || null;

    // If voice fields are still null, try the customerConfig module (it uses a different path)
    // This is because c0.json uses designDefaults.voice (not templates[id].voice)
    if (!jobSpec.designSpec.voice.lockedOutro || !jobSpec.designSpec.voice.showName) {
      try {
        const { loadCustomerConfig: loadCC } = require('./customerConfig');
        const ccLong = loadCC(customerId, resolvedTemplateId);
        if (!jobSpec.designSpec.voice.lockedIntro) {
          jobSpec.designSpec.voice.lockedIntro =
            ccLong?.designDefaults?.voice?.lockedIntro?.[voiceBaseType] || null;
        }
        if (!jobSpec.designSpec.voice.lockedOutro) {
          jobSpec.designSpec.voice.lockedOutro = ccLong?.designDefaults?.voice?.lockedOutro || null;
        }
        if (!jobSpec.designSpec.voice.showName) {
          jobSpec.designSpec.voice.showName =
            ccLong?.designDefaults?.voice?.showName?.[voiceBaseType] || null;
        }
        if (!jobSpec.designSpec.voice.categoryLabel) {
          jobSpec.designSpec.voice.categoryLabel =
            ccLong?.designDefaults?.voice?.categoryLabel?.[voiceBaseType] || null;
        }
        // Sync back to chrome
        jobSpec.designSpec.chrome.showName = jobSpec.designSpec.voice.showName;
        jobSpec.designSpec.chrome.categoryLabel = jobSpec.designSpec.voice.categoryLabel;
      } catch (e2) {
        // Non-fatal fallback
      }
    }

    // Freeze resolved FFmpeg chrome config at job creation time so runtime reloads or
    // customer config edits cannot drift visuals mid-pipeline.
    try {
      const { resolveChromeCfg, fingerprintResolvedChromeCfg } = require('./chrome_overlay_ffmpeg');
      const chromeContentType = voiceBaseType; // already normalized to news|clips|sports
      const resolvedChromeCfg = resolveChromeCfg(customerConfig, chromeContentType);
      jobSpec.designSpec.chrome.resolvedCfg = resolvedChromeCfg;
      jobSpec.designSpec.chrome.resolvedHash = fingerprintResolvedChromeCfg(resolvedChromeCfg);
      jobSpec.designSpec.chrome.resolvedContentType = chromeContentType;
      jobSpec.designSpec.chrome.resolvedLockedAt = now;
      console.log(
        `[job_spec] Frozen chrome cfg at create time (${chromeContentType}) hash=${jobSpec.designSpec.chrome.resolvedHash}`
      );
    } catch (freezeErr) {
      console.warn(
        `[job_spec] Could not freeze resolved chrome config (non-fatal): ${freezeErr.message}`
      );
    }

    console.log(
      `[job_spec] Voice/chrome resolved at job creation for ${voiceBaseType}: showName="${jobSpec.designSpec.voice.showName}", lockedOutro="${(jobSpec.designSpec.voice.lockedOutro || '').slice(0, 40)}..."`
    );
  } catch (e) {
    console.warn('[job_spec] Chrome/voice config resolution failed (non-fatal):', e.message);
  }

  // Persist to DB
  const { updateJobSpec: dbUpdateJobSpec, saveJob: dbSaveJob } = require('./db');
  dbSaveJob(jobId, {
    contentType,
    formType: formFactor,
    status: 'pending',
    stage: 'fetch',
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
  const { getJobBySpec, getGateResults, resolveCanonicalJobId } = require('./db');
  const spec = getJobBySpec(jobId);
  if (!spec) return null;
  const canonicalJobId = resolveCanonicalJobId(jobId);
  const fromSql = getGateResults(jobId);
  spec.state = spec.state || {};
  spec.state.gateResults = { ...(spec.state.gateResults || {}), ...fromSql };
  spec.canonicalJobId = canonicalJobId;
  spec.observability = {
    canonicalJobId,
    jobRunTimeline: 'logs/job_run_timeline.jsonl',
    pipelineEventsLog: 'logs/pipeline_events.jsonl',
    rooStatusSnapshot: 'logs/roo_status.json',
    nrHint:
      'Custom pipeline events (nr_pipeline) include jobId; canonicalJobId is attached after spine link.',
    multiProcessNote:
      'Standalone bin/heygen-poller.js appends heygen:* rows to job_run_timeline via pipelineBus.appendJobTimelineEvent when this DB resolves the same job id (CWN_DB_PATH).',
    timelineEnv: 'JOB_TIMELINE_MAX_BYTES, JOB_TIMELINE_STRING_MAX, JOB_TIMELINE_ARRAY_MAX',
  };
  return spec;
}

// ── Update Job Spec ───────────────────────────────────────────────────────────

/**
 * Apply a partial patch to an existing Job Spec and save to DB.
 * patch is deeply merged into the current spec.
 * Returns the updated jobSpec.
 */
function updateJobSpec(jobId, patch) {
  let current = getJobSpec(jobId);
  if (!current) {
    const { seedJobSpecFromScript } = require('./db');
    const { persistedJobs: _pj } = require('./job_card');
    const _card = _pj[jobId];
    if (!_card) throw new Error(`[job_spec] updateJobSpec: jobId "${jobId}" not found`);
    seedJobSpecFromScript(jobId, { jobId, customerId: _card.customerId || 'c0', templateId: null }).catch(() => {});
    current = getJobSpec(jobId);
    if (!current)
      throw new Error(`[job_spec] updateJobSpec: could not materialize job_spec for "${jobId}"`);
  }

  const updated = deepMerge(current, patch);

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(jobId, updated);

  return updated;
}

/**
 * Persist expectedSynth on the canonical job row (survives process restarts / re-read getJobSpec).
 * No-op if jobId missing or row not found.
 */
function persistExpectedSynthFlag(jobId, expectedSynth) {
  if (!jobId) return;
  try {
    updateJobSpec(jobId, { expectedSynth: !!expectedSynth });
  } catch (e) {
    console.warn(`[job_spec] persistExpectedSynthFlag(${jobId}): ${e.message}`);
  }
}

/**
 * Persist monitoring escalation round count (survives restart; caps kills after 2 rounds).
 */
function persistEscalationAttempts(jobId, count) {
  if (!jobId || !Number.isFinite(count) || count < 0) return;
  try {
    const current = getJobSpec(jobId);
    if (!current) return;
    const prev = (current.state && current.state.automation) || {};
    updateJobSpec(jobId, {
      state: {
        automation: {
          ...prev,
          escalationAttempts: count,
          lastEscalationAt: new Date().toISOString(),
        },
      },
    });
  } catch (e) {
    console.warn(`[job_spec] persistEscalationAttempts(${jobId}): ${e.message}`);
  }
}

/**
 * Record a successful automatic recovery step (e.g. Gate 3b chrome re-burn).
 * Merges into state.automation; safe for older specs without automation block.
 */
function recordAutomationSelfHeal(jobId, kind) {
  if (!jobId || !kind) return;
  try {
    const current = getJobSpec(jobId);
    if (!current) return;
    const prev = (current.state && current.state.automation) || {};
    const max =
      prev.selfHealMaxAttempts != null
        ? prev.selfHealMaxAttempts
        : parseInt(process.env.AUTOMATION_SELF_HEAL_MAX || '2', 10) || 2;
    const next = {
      ...prev,
      selfHealMaxAttempts: max,
      selfHealAttempts: (prev.selfHealAttempts || 0) + 1,
      lastSelfHealAt: new Date().toISOString(),
      lastSelfHealKind: String(kind).slice(0, 120),
      agentEscalated: !!prev.agentEscalated,
      agentEscalatedAt: prev.agentEscalatedAt || null,
      agentEscalationReason: prev.agentEscalationReason || null,
    };
    updateJobSpec(jobId, { state: { automation: next } });
  } catch (e) {
    console.warn(`[job_spec] recordAutomationSelfHeal(${jobId}): ${e.message}`);
  }
}

/**
 * Last-resort hook: mark job spec for human/AI agent triage and emit pipeline + why ledger.
 * Idempotent while agentEscalated remains true.
 */
function requestAgentInterventionLastResort(jobId, reason) {
  if (!jobId) return;
  try {
    const current = getJobSpec(jobId);
    if (!current) return;
    const prev = (current.state && current.state.automation) || {};
    if (prev.agentEscalated) return;
    const r = reason == null || reason === '' ? 'unspecified' : String(reason);
    const automation = {
      ...prev,
      agentEscalated: true,
      agentEscalatedAt: new Date().toISOString(),
      agentEscalationReason: r.slice(0, 2000),
    };
    updateJobSpec(jobId, { state: { automation } });
    try {
      const pipelineBus = require('./pipeline_events');
      pipelineBus.emit('automation:agent_escalation', {
        jobId,
        reason: automation.agentEscalationReason,
      });
    } catch (_e) {
      /* non-fatal */
    }
    try {
      const whyLedger = require('./why_ledger');
      whyLedger.recordWhyLedger({
        jobId,
        gate: null,
        kind: 'pipeline_escalation',
        passed: false,
        outcome: 'agent_last_resort',
        reasons: [r.slice(0, 500)],
        interventionType: whyLedger.INTERVENTION.AGENT_OR_MANUAL,
        interventionOutcome: 'queued',
        source: 'lib/job_spec:requestAgentInterventionLastResort',
      });
    } catch (_e) {
      /* non-fatal */
    }
  } catch (e) {
    console.warn(`[job_spec] requestAgentInterventionLastResort(${jobId}): ${e.message}`);
  }
}

// ── Save Gate Result ──────────────────────────────────────────────────────────

/**
 * Write a gate result into state.gateResults[gate] and persist to DB.
 * Also inserts into the gate_results table.
 * gate: 'gate0' | 'gate1' | 'gate2' | 'gate3a' | 'gate3b' | 'gate4' | 'gate5'
 */
function saveGateResult(jobId, gate, result) {
  const {
    saveGateResult: dbSaveGateResult,
    seedJobSpecFromScript,
    resolveCanonicalJobId,
    getPrimaryJobSpecRowId,
    syncJobCardScriptGateSnapshot,
  } = require('./db');
  dbSaveGateResult(jobId, gate, result);

  const canonical = resolveCanonicalJobId(jobId);
  const persistRowId = getPrimaryJobSpecRowId(canonical);

  // Update the jobSpec in DB (always the row that actually holds job_spec JSON)
  let current = getJobSpec(jobId);
  if (!current) {
    const { persistedJobs: _pj2 } = require('./job_card');
    const _card2 = _pj2[jobId];
    if (_card2) {
      const { seedJobSpecFromScript: _seed } = require('./db');
      _seed(jobId, { jobId, customerId: _card2.customerId || 'c0', templateId: null }).catch(() => {});
      current = getJobSpec(jobId);
    }
  }
  if (!current) {
    console.warn(
      `[job_spec] saveGateResult: jobId "${jobId}" not in DB — gate result saved to gate_results table only`
    );
    try {
      syncJobCardScriptGateSnapshot(canonical.startsWith('script_') ? canonical : jobId);
    } catch (_e) {
      /* non-fatal */
    }
    return;
  }

  current.state.gateResults = current.state.gateResults || {};
  current.state.gateResults[gate] = result;
  current.state.currentGate = parseInt(gate.replace(/[^0-9]/g, '')) || null;
  current.canonicalJobId = canonical;

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(persistRowId, current);
  try {
    if (canonical.startsWith('script_')) syncJobCardScriptGateSnapshot(canonical);
  } catch (_e) {
    /* non-fatal */
  }
}

// ── Save Output ───────────────────────────────────────────────────────────────

/**
 * Write a value into state.savedOutputs[key] and persist to DB.
 * key: 'scaffold' | 'filledScript' | 'transcriptBlocks' | 'segmentPaths' | 'assembledPath' | 'driveUrl' | 'publishCopy'
 */
function saveOutput(jobId, key, value) {
  let current = getJobSpec(jobId);
  if (!current) {
    const { seedJobSpecFromScript } = require('./db');
    const { persistedJobs: _pj3 } = require('./job_card');
    const _card3 = _pj3[jobId];
    if (_card3) {
      seedJobSpecFromScript(jobId, {
        jobId,
        customerId: _card3.customerId || 'c0',
        templateId: null,
      }).catch(() => {});
      current = getJobSpec(jobId);
    }
  }
  if (!current) throw new Error(`[job_spec] saveOutput: jobId "${jobId}" not found`);

  current.state.savedOutputs[key] = value;

  const { updateJobSpec: dbUpdateJobSpec, syncJobCardScriptGateSnapshot } = require('./db');
  dbUpdateJobSpec(jobId, current);
  if (typeof jobId === 'string' && jobId.startsWith('script_')) {
    try {
      syncJobCardScriptGateSnapshot(jobId);
    } catch (_e) {
      /* non-fatal */
    }
  }
}

/**
 * Persist the latest script after each Gate 1 attempt (pass or fail) plus a short
 * rolling snapshot history for forensics (max 5).
 */
function appendGate1ScriptAttempt(jobId, { attempt, script }) {
  if (!jobId || typeof script !== 'string' || !script.trim()) return;
  let current = getJobSpec(jobId);
  if (!current) return;
  current.state = current.state || {};
  current.state.savedOutputs = current.state.savedOutputs || {};
  current.state.savedOutputs.filledScript = script;
  const snaps = Array.isArray(current.state.savedOutputs.gate1ScriptSnapshots)
    ? current.state.savedOutputs.gate1ScriptSnapshots
    : [];
  snaps.push({
    attempt: attempt || 1,
    at: new Date().toISOString(),
    scriptLen: script.length,
    excerpt: script.length > 12000 ? `${script.slice(0, 12000)}\n…[truncated]` : script,
  });
  current.state.savedOutputs.gate1ScriptSnapshots = snaps.slice(-5);
  const { updateJobSpec, syncJobCardScriptGateSnapshot } = require('./db');
  updateJobSpec(jobId, current);
  try {
    syncJobCardScriptGateSnapshot(jobId);
  } catch (_e) {
    /* non-fatal */
  }
}

// ── Fail Job ──────────────────────────────────────────────────────────────────

/**
 * Mark a job as failed in the DB with full context.
 */
function failJob(jobId, gate, rootCause, restartGate) {
  let current = getJobSpec(jobId);
  if (!current) {
    const { seedJobSpecFromScript } = require('./db');
    const { persistedJobs: _pjFail } = require('./job_card');
    const _cardFail = _pjFail[jobId];
    if (_cardFail) {
      seedJobSpecFromScript(jobId, { jobId, customerId: _cardFail.customerId || 'c0', templateId: null }).catch(() => {});
      current = getJobSpec(jobId);
    }
  }
  if (!current) {
    console.error(`[job_spec] failJob: jobId "${jobId}" not found`);
    return;
  }

  current.state.status = 'failed';
  current.state.failedAt = new Date().toISOString();
  current.state.failedGate = gate || null;
  current.state.rootCause = rootCause || null;
  current.state.restartGate = restartGate !== undefined ? restartGate : null;

  const { updateJobSpec: dbUpdateJobSpec } = require('./db');
  dbUpdateJobSpec(jobId, current);

  console.log(`[job_spec] Job ${jobId} marked failed at gate=${gate}: ${rootCause}`);

  // CPD-115: Auto-refund credits on hard failure (self-heal attempts exhausted, system-side failure).
  // Customer-initiated reruns are new job submissions — no refund needed here.
  const automation = current.state?.automation || {};
  const isHardFailure = automation.selfHealAttempts >= automation.selfHealMaxAttempts;
  if (isHardFailure && current.creditCost && current.customerId) {
    try {
      const { refundCredits } = require('./services/credits');
      refundCredits(current.customerId, jobId, current.creditCost)
        .then(r => {
          if (r.ok) console.log(`[job_spec] Auto-refunded ${current.creditCost} credits for hard-failed job ${jobId}`);
          else console.warn(`[job_spec] Credit refund skipped for ${jobId}: ${r.reason}`);
        })
        .catch(e => console.warn(`[job_spec] Credit refund error for ${jobId}: ${e.message}`));
    } catch (_e) { /* non-fatal */ }
  }
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

// ── Job Spine: link semantic c0_* job ID to script_* job ID ─────────────────
/**
 * Write the script job ID (script_*) back to the semantic job's (c0_*) script_job_id column.
 * Allows Roo gate owners to find gate results for a semantic job by joining on script_job_id.
 * Non-fatal: logs on failure, never throws.
 *
 * @param {string} semanticJobId - The c0_COMPACT_DIRECT_* ID created at dashboard generate time
 * @param {string} scriptJobId   - The script_* ID created during script generation
 */
function linkScriptJob(semanticJobId, scriptJobId) {
  try {
    const { getPool } = require('./db');
    getPool()
      .query('UPDATE jobs SET script_job_id = $1, updated_at = $2 WHERE id = $3', [
        scriptJobId,
        Date.now(),
        semanticJobId,
      ])
      .then(({ rowCount }) => {
        if (!rowCount) {
          console.warn(`[job_spec] linkScriptJob: no jobs row updated for semantic id ${semanticJobId}`);
          return;
        }
        console.log(`[job_spec] Linked ${semanticJobId} → script_job_id: ${scriptJobId}`);
      })
      .catch((e) => console.error('[job_spec] linkScriptJob DB error:', e.message));
    try {
      const pipelineBus = require('./pipeline_events');
      pipelineBus.emit('job:spine_linked', {
        jobId: scriptJobId,
        semanticJobId,
        scriptJobId,
      });
    } catch (_e) {
      /* non-fatal */
    }
    try {
      const cur = getJobSpec(semanticJobId);
      if (cur && cur.scriptJobId !== scriptJobId) {
        updateJobSpec(semanticJobId, { scriptJobId });
      }
    } catch (e) {
      console.warn(
        `[job_spec] linkScriptJob: could not persist scriptJobId on job_spec JSON: ${e.message}`
      );
    }
    try {
      const { markScriptSemanticLinked } = require('./monitoring');
      markScriptSemanticLinked(scriptJobId);
    } catch (_e) {
      /* monitoring may load after job_spec in some tests */
    }
  } catch (e) {
    const { logError } = require('./error_logger');
    logError('JOB_SPINE_LINK_FAIL', e, { semanticJobId, scriptJobId });
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  loadCustomerConfig,
  buildDesignSpec,
  buildDeliverySpec,
  createJobSpec,
  getJobSpec,
  updateJobSpec,
  persistExpectedSynthFlag,
  persistEscalationAttempts,
  recordAutomationSelfHeal,
  requestAgentInterventionLastResort,
  saveGateResult,
  saveOutput,
  appendGate1ScriptAttempt,
  failJob,
  linkScriptJob,
  // Spec-driven portal routing helpers (CPD-65)
  resolveActivePortals,
  resolveActiveExtensions,
};
