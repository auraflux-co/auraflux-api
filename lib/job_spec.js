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
 * Falls back to c1_default.json when no per-customer file exists (matches customerConfig.js).
 */
function loadCustomerConfig(customerId) {
  const filePath = path.join(CUSTOMERS_DIR, `${customerId}.json`);
  const fallbackPath = path.join(CUSTOMERS_DIR, 'c1_default.json');
  const absPath = fs.existsSync(filePath) ? filePath : fallbackPath;

  if (!fs.existsSync(absPath)) {
    throw new Error(`[job_spec] No customer config found for customerId="${customerId}" and no c1_default fallback`);
  }

  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
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
      // Explicit element presence — gates read these instead of inferring from content type name.
      // Customer config (e.g. c0.json) is the single source of truth for what chrome is in scope.
      hasTopBar:  d.chrome && d.chrome.hasTopBar  !== undefined ? d.chrome.hasTopBar  : true,
      hasFlag:    d.chrome && d.chrome.hasFlag    !== undefined ? d.chrome.hasFlag    : true,
      hasSidebar: d.chrome && d.chrome.hasSidebar !== undefined ? d.chrome.hasSidebar : true,
      hasTicker:  d.chrome && d.chrome.hasTicker  !== undefined ? d.chrome.hasTicker  : true,
      hasLogo:    d.chrome && d.chrome.hasLogo    !== undefined ? d.chrome.hasLogo    : true,
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
    // Try exact content type first (e.g. "nba-short" gets its own platform list, not the long-form one)
    // Fall back to base type when exact type has no publish config
    let publishCfg = null;
    try { publishCfg = getPublishConfig(contentType); } catch (_) { /* unknown exact type */ }
    if (!publishCfg?.platforms?.length) {
      const baseType = (contentType || '').replace(/-short$/, '');
      try { publishCfg = getPublishConfig(baseType); } catch (_) { /* unknown base type */ }
    }
    platformsFromContentType = (publishCfg && publishCfg.platforms) ? publishCfg.platforms : [];
  } catch (e) {
    // configLoader may not know this contentType — silently skip
  }

  let platforms = d.platforms || platformsFromContentType;
  try {
    const { readAutoPublishPlatformsEnv } = require('./auto_publish_env');
    const fromEnv = readAutoPublishPlatformsEnv();
    if (fromEnv !== null) platforms = fromEnv;
  } catch (_e) { /* non-fatal */ }

  return {
    platforms,
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
 *   expectedSynth boolean — lab/synthetic job: persist so gates 3a/3b/4 skip broadcast Gemini policy (see assembly)
 */

/** Map dashboard/API item → jobSpec.order.inputs.items row (wire, Twitch, Reddit desk). */
function normalizeOrderInputItem(item, i) {
  const nbaName = (item.away && item.home) ? `${item.away} vs ${item.home}` : null;
  const isReddit = !!(item.postId || item.redditPostId || item.redditSource || item.source === 'reddit');
  return {
    id:              String(i),
    name:            item.displayName || item.streamer || item.name || nbaName || `ITEM${i + 1}`,
    displayName:     item.displayName || item.name || item.streamer || nbaName || `Item ${i + 1}`,
    title:           item.title || item.displayName || item.name || nbaName || String(i),
    teams:           item.away && item.home ? `${item.away}_VS_${item.home}` : (item.title || ''),
    url:             item.videoUrl || item.clipUrl || item.url || item.link || '',
    pageUrl:         item.link || item.pageUrl || '',
    postId:          item.postId || item.redditPostId || null,
    redditSource:    isReddit,
    subreddit:       item.subreddit || null,
    redditPermalink: item.redditPermalink || item.permalink || null,
    source:          item.source || null,
    handle:          item.username || item.streamer || item.twitchUsername || '',
    twitchUsername:  item.username || item.streamer || item.twitchUsername || '',
    imageUrl:        item.imageUrl || item.thumbnailUrl || item.profileImage || '',
    fact:            item.fact || item.origin || item.description || item.desc || '',
    category:        item.category || null,
  };
}

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
    expectedSynth = false,
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

  const selfHealMax = parseInt(process.env.AUTOMATION_SELF_HEAL_MAX || '2', 10);
  const jobSpec = {
    jobId,
    customerId,
    brandId:   params.brandId   || null,
    brandName: params.brandName || null,
    showId:         customerConfig.showId  || null,
    templateId:     resolvedTemplateId,     // always resolved — short-form for -short content types
    contentType,                            // original contentType (e.g. 'news-short') preserved
    baseContentType,                        // stripped (e.g. 'news') for template/config lookups
    createdAt:      now,
    createdBy,
    scriptJobId:    params.scriptJobId || null,  // cross-reference to script_gen job card ID
    expectedSynth:  !!expectedSynth,

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
        transcriptBlocks: null,
        segmentPaths:  null,
        assembledPath: null,
        driveUrl:      null,
        publishCopy:   null,
      },
      failedAt:    null,
      failedGate:  null,
      rootCause:   null,
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
        qaCycle: { byGate: {} }
      }
    },
  };

  // ── PRE-GENERATE: Resolve scaffold immediately — sceneStructure known before generation ──
  // Items may be provided at createJobSpec time (e.g. from dashboard pre-fill).
  // If items are present, we scaffold now so canProduce() gates have full context.
  // If items are absent (empty order), scaffold happens later in script_gen.js (backward compat).
  const preItems = params.items || [];
  if (preItems.length > 0) {
    const mappedItems = preItems.map(normalizeOrderInputItem);
    jobSpec.order.inputs.items = mappedItems;
    jobSpec.order.inputs.itemCount = mappedItems.length;
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
            items: mappedItems,
          }
        }
      };
      const scaffoldResult = generateScaffold(scaffoldJobSpec);
      if (scaffoldResult) {
        jobSpec.designSpec.sceneStructure = {
          sceneHeaders:       scaffoldResult.sceneHeaders || [],
          expectedSceneCount: scaffoldResult.expectedSceneCount || 0,
          expectedClipCount:  scaffoldResult.expectedClipCount || 0,
          templateId:         scaffoldResult.templateId || resolvedTemplateId,
          scaffold:           scaffoldResult.scaffold,  // full scaffold text with [DIALOGUE] slots
          generatedAt:        now
        };
        // Also set top-level expectedClipCount for gate compat
        jobSpec.designSpec.expectedClipCount = scaffoldResult.expectedClipCount;
        // Store items in sceneStructure for downstream gate context
        jobSpec.designSpec.sceneStructure.items = preItems.map((item, i) => {
          // NBA items carry away/home team names — derive a human-readable label from them.
          const nbaMatchupLabel = (item.away && item.home) ? `${item.away} vs ${item.home}` : null;
          const label = item.displayName || item.streamer || item.name || item.title || nbaMatchupLabel || `Item ${i + 1}`;
          return {
            sceneId:  `ITEM${i + 1}`,
            label,
            category: item.category || (nbaMatchupLabel ? 'NBA GAME' : baseContentType.toUpperCase()),
            data: {
              displayName:    item.displayName || item.name || item.title || nbaMatchupLabel || `Item ${i + 1}`,
              url:            item.url || item.pageUrl || item.videoUrl || item.clipUrl || '',
              fact:           item.fact || item.origin || item.description || '',
              imageUrl:       item.imageUrl || item.heroImageUrl || item.thumbnailUrl || item.profileImage || '',
              matchup:        item.teams || nbaMatchupLabel || item.title || '',
              twitchUsername: item.username || item.streamer || item.twitchUsername || '',
              away:           item.away || '', home: item.home || '',
              awayAbbr:       item.awayAbbr || '', homeAbbr: item.homeAbbr || '',
              awayScore:      item.awayScore || null, homeScore: item.homeScore || null
            }
          };
        });
        console.log(`[job_spec] Scaffold pre-generated at job creation: ${scaffoldResult.expectedSceneCount} scenes, ${scaffoldResult.expectedClipCount} clips`);
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
    if (['twitch', 'clips', 'streamer'].some(t => voiceBaseType.includes(t))) voiceBaseType = 'clips';
    if (['nba', 'sports', 'basketball'].some(t => voiceBaseType.includes(t))) voiceBaseType = 'sports';
    if (['news', 'world', 'global'].some(t => voiceBaseType.includes(t))) voiceBaseType = 'news';

    const chromeCfg  = customerConfig?.templates?.[resolvedTemplateId]?.designDefaults?.chrome || {};
    const voiceCfg   = customerConfig?.templates?.[resolvedTemplateId]?.voice || {};
    const overrides  = chromeCfg?.contentTypeOverrides?.[voiceBaseType] || {};

    jobSpec.designSpec.voice = {
      lockedIntro:    chromeCfg?.lockedIntro?.[voiceBaseType] || overrides.lockedIntro || null,
      lockedOutro:    chromeCfg?.lockedOutro  || voiceCfg.outroLine || null,
      showName:       chromeCfg?.showName?.[voiceBaseType] || overrides.showName || null,
      categoryLabel:  chromeCfg?.categoryLabel?.[voiceBaseType] || null,
      prohibitedWords: voiceCfg.prohibitedWords || [],
      style:          voiceCfg.style || null,
      speakerName:    voiceCfg.speakerName || 'Bobby G'
    };

    // Also write into chrome for backward compat (some gates read from chrome not voice)
    jobSpec.designSpec.chrome = jobSpec.designSpec.chrome || {};
    jobSpec.designSpec.chrome.showName      = jobSpec.designSpec.voice.showName;
    jobSpec.designSpec.chrome.categoryLabel = jobSpec.designSpec.voice.categoryLabel;
    jobSpec.designSpec.chrome.caption       = chromeCfg?.caption || null;

    // If voice fields are still null, try the customerConfig module (it uses a different path)
    // This is because c0.json uses designDefaults.voice (not templates[id].voice)
    if (!jobSpec.designSpec.voice.lockedOutro || !jobSpec.designSpec.voice.showName) {
      try {
        const { loadCustomerConfig: loadCC } = require('./customerConfig');
        const ccLong = loadCC(customerId, resolvedTemplateId);
        if (!jobSpec.designSpec.voice.lockedIntro) {
          jobSpec.designSpec.voice.lockedIntro = ccLong?.designDefaults?.voice?.lockedIntro?.[voiceBaseType] || null;
        }
        if (!jobSpec.designSpec.voice.lockedOutro) {
          jobSpec.designSpec.voice.lockedOutro = ccLong?.designDefaults?.voice?.lockedOutro || null;
        }
        if (!jobSpec.designSpec.voice.showName) {
          jobSpec.designSpec.voice.showName = ccLong?.designDefaults?.voice?.showName?.[voiceBaseType] || null;
        }
        if (!jobSpec.designSpec.voice.categoryLabel) {
          jobSpec.designSpec.voice.categoryLabel = ccLong?.designDefaults?.voice?.categoryLabel?.[voiceBaseType] || null;
        }
        // Sync back to chrome
        jobSpec.designSpec.chrome.showName      = jobSpec.designSpec.voice.showName;
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
      console.log(`[job_spec] Frozen chrome cfg at create time (${chromeContentType}) hash=${jobSpec.designSpec.chrome.resolvedHash}`);
    } catch (freezeErr) {
      console.warn(`[job_spec] Could not freeze resolved chrome config (non-fatal): ${freezeErr.message}`);
    }

    console.log(`[job_spec] Voice/chrome resolved at job creation for ${voiceBaseType}: showName="${jobSpec.designSpec.voice.showName}", lockedOutro="${(jobSpec.designSpec.voice.lockedOutro || '').slice(0,40)}..."`);
  } catch (e) {
    console.warn('[job_spec] Chrome/voice config resolution failed (non-fatal):', e.message);
  }

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
    nrHint: 'Custom pipeline events (nr_pipeline) include jobId; canonicalJobId is attached after spine link.',
    multiProcessNote:
      'Standalone bin/heygen-poller.js appends heygen:* rows to job_run_timeline via pipelineBus.appendJobTimelineEvent when this DB resolves the same job id (CWN_DB_PATH).',
    timelineEnv: 'JOB_TIMELINE_MAX_BYTES, JOB_TIMELINE_STRING_MAX, JOB_TIMELINE_ARRAY_MAX'
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
    const { seedJobSpecFromScript, getDb } = require('./db');
    const row = getDb().prepare('SELECT id, customer_id FROM jobs WHERE id = ?').get(jobId);
    if (!row) throw new Error(`[job_spec] updateJobSpec: jobId "${jobId}" not found`);
    seedJobSpecFromScript(jobId, { jobId, customerId: row.customer_id || 'c0', templateId: null });
    current = getJobSpec(jobId);
    if (!current) throw new Error(`[job_spec] updateJobSpec: could not materialize job_spec for "${jobId}"`);
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
          lastEscalationAt: new Date().toISOString()
        }
      }
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
    const max = prev.selfHealMaxAttempts != null ? prev.selfHealMaxAttempts
      : (parseInt(process.env.AUTOMATION_SELF_HEAL_MAX || '2', 10) || 2);
    const next = {
      ...prev,
      selfHealMaxAttempts: max,
      selfHealAttempts: (prev.selfHealAttempts || 0) + 1,
      lastSelfHealAt: new Date().toISOString(),
      lastSelfHealKind: String(kind).slice(0, 120),
      agentEscalated: !!prev.agentEscalated,
      agentEscalatedAt: prev.agentEscalatedAt || null,
      agentEscalationReason: prev.agentEscalationReason || null
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
    const r = (reason == null || reason === '') ? 'unspecified' : String(reason);
    const automation = {
      ...prev,
      agentEscalated: true,
      agentEscalatedAt: new Date().toISOString(),
      agentEscalationReason: r.slice(0, 2000)
    };
    updateJobSpec(jobId, { state: { automation } });
    try {
      const pipelineBus = require('./pipeline_events');
      pipelineBus.emit('automation:agent_escalation', { jobId, reason: automation.agentEscalationReason });
    } catch (_e) { /* non-fatal */ }
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
        source: 'lib/job_spec:requestAgentInterventionLastResort'
      });
    } catch (_e) { /* non-fatal */ }
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
    getDb,
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
    const row = getDb().prepare('SELECT id, customer_id FROM jobs WHERE id = ?').get(jobId);
    if (row) {
      seedJobSpecFromScript(jobId, { jobId, customerId: row.customer_id || 'c0', templateId: null });
      current = getJobSpec(jobId);
    }
  }
  if (!current) {
    console.warn(`[job_spec] saveGateResult: jobId "${jobId}" not in DB — gate result saved to gate_results table only`);
    try {
      syncJobCardScriptGateSnapshot(canonical.startsWith('script_') ? canonical : jobId);
    } catch (_e) { /* non-fatal */ }
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
  } catch (_e) { /* non-fatal */ }
}

// ── Save Output ───────────────────────────────────────────────────────────────

/**
 * Write a value into state.savedOutputs[key] and persist to DB.
 * key: 'scaffold' | 'filledScript' | 'transcriptBlocks' | 'segmentPaths' | 'assembledPath' | 'driveUrl' | 'publishCopy'
 */
function saveOutput(jobId, key, value) {
  let current = getJobSpec(jobId);
  if (!current) {
    const { seedJobSpecFromScript, getDb } = require('./db');
    const row = getDb().prepare('SELECT id, customer_id FROM jobs WHERE id = ?').get(jobId);
    if (row) {
      seedJobSpecFromScript(jobId, { jobId, customerId: row.customer_id || 'c0', templateId: null });
      current = getJobSpec(jobId);
    }
  }
  if (!current) throw new Error(`[job_spec] saveOutput: jobId "${jobId}" not found`);

  current.state.savedOutputs[key] = value;

  const { updateJobSpec: dbUpdateJobSpec, syncJobCardScriptGateSnapshot } = require('./db');
  dbUpdateJobSpec(jobId, current);

  // CPD-982: write the key through to LINKED spec rows. A card (script_*) and
  // its semantic row (c0_*) can BOTH carry job_spec JSON, and readers use
  // either id — without this, assembly saved publishCopy under the card id
  // while Gate 5 read the semantic row and saw null ("YouTube: title is
  // required" hard fail on clips-only comps).
  try {
    const { getDb } = require('./db');
    const db = getDb();
    const linked = new Set();
    const row = db.prepare('SELECT script_job_id FROM jobs WHERE id = ?').get(jobId);
    if (row?.script_job_id) linked.add(row.script_job_id);
    for (const r of db.prepare('SELECT id FROM jobs WHERE script_job_id = ?').all(jobId)) linked.add(r.id);
    linked.delete(jobId);
    for (const lid of linked) {
      const lrow = db.prepare('SELECT job_spec FROM jobs WHERE id = ?').get(lid);
      if (!lrow?.job_spec) continue;
      try {
        const lspec = JSON.parse(lrow.job_spec);
        lspec.state = lspec.state || {};
        lspec.state.savedOutputs = lspec.state.savedOutputs || {};
        lspec.state.savedOutputs[key] = value;
        dbUpdateJobSpec(lid, lspec);
      } catch (_e) { /* malformed linked spec — skip */ }
    }
  } catch (_e) { /* write-through is best-effort */ }
  if (typeof jobId === 'string' && jobId.startsWith('script_')) {
    try {
      syncJobCardScriptGateSnapshot(jobId);
    } catch (_e) { /* non-fatal */ }
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
    excerpt: script.length > 12000 ? `${script.slice(0, 12000)}\n…[truncated]` : script
  });
  current.state.savedOutputs.gate1ScriptSnapshots = snaps.slice(-5);
  const { updateJobSpec, syncJobCardScriptGateSnapshot } = require('./db');
  updateJobSpec(jobId, current);
  try {
    syncJobCardScriptGateSnapshot(jobId);
  } catch (_e) { /* non-fatal */ }
}

// ── Fail Job ──────────────────────────────────────────────────────────────────

/**
 * Mark a job as failed in the DB with full context.
 */
function failJob(jobId, gate, rootCause, restartGate) {
  let current = getJobSpec(jobId);
  if (!current) {
    const { seedJobSpecFromScript, getDb } = require('./db');
    const row = getDb().prepare('SELECT id FROM jobs WHERE id = ?').get(jobId);
    if (row) {
      seedJobSpecFromScript(jobId, { jobId, customerId: 'c0', templateId: null });
      current = getJobSpec(jobId);
    }
  }
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
    const { getDb } = require('./db');
    const db = getDb();
    const r = db.prepare('UPDATE jobs SET script_job_id = ? WHERE id = ?').run(scriptJobId, semanticJobId);
    if (!r.changes) {
      console.warn(`[job_spec] linkScriptJob: no jobs row updated for semantic id ${semanticJobId}`);
      return;
    }
    console.log(`[job_spec] Linked ${semanticJobId} → script_job_id: ${scriptJobId}`);
    try {
      const pipelineBus = require('./pipeline_events');
      pipelineBus.emit('job:spine_linked', {
        jobId: scriptJobId,
        semanticJobId,
        scriptJobId,
      });
    } catch (_e) { /* non-fatal */ }
    try {
      const cur = getJobSpec(semanticJobId);
      if (cur && cur.scriptJobId !== scriptJobId) {
        updateJobSpec(semanticJobId, { scriptJobId });
      }
    } catch (e) {
      console.warn(`[job_spec] linkScriptJob: could not persist scriptJobId on job_spec JSON: ${e.message}`);
    }
    try {
      const { markScriptSemanticLinked } = require('./monitoring');
      markScriptSemanticLinked(scriptJobId);
    } catch (_e) { /* monitoring may load after job_spec in some tests */ }
  } catch(e) {
    const { logError } = require('./error_logger');
    logError('JOB_SPINE_LINK_FAIL', e, { semanticJobId, scriptJobId });
  }
}

// ── Portal activation (CPD-1037 / CPD-1043) ───────────────────────────────────

const PORTAL_ORDER = ['portal0', 'portal1', 'portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'];

const TEMPLATE_NAME_TO_PATH_KEY = {
  'TikTok Clutch':     'tiktok_clutch',
  'YouTube Deep Dive': 'youtube_deep_dive',
  'IRL Story Time':    'irl_story_time',
  'Montage Hype Reel': 'montage_hype_reel',
  'Reaction Cut':      'reaction_cut',
  'Quick Guide':       'quick_guide',
};

function _normalizeBaseContentType(jobSpec) {
  const ct = jobSpec?.contentType || jobSpec?.baseContentType || 'clips';
  return String(ct).replace(/-short$/, '').replace(/-long$/, '');
}

function _scriptStageActive(jobSpec) {
  if (jobSpec?.stageMap?.script?.active === false) return false;
  if (jobSpec?.portals?.portal1?.active === false) return false;
  return true;
}

function _avatarStageActive(jobSpec) {
  if (jobSpec?.stageMap?.avatar?.active === false) return false;
  return !!(jobSpec?.addOns?.heygen?.active || jobSpec?.stageMap?.avatar?.active === true);
}

/** Build/update jobSpec.portals — mutates jobSpec in place. */
function buildPortalsMap(jobSpec = {}) {
  const { KNOWN_CLEAN_PATHS } = require('./pipeline_routing');
  const baseCt = _normalizeBaseContentType(jobSpec);
  const isClips = baseCt === 'clips' || jobSpec.contentType === 'clips';
  const scriptActive = _scriptStageActive(jobSpec);
  const avatarActive = _avatarStageActive(jobSpec);
  const isTopicOnly = !!jobSpec.isTopicOnly;
  const staging = jobSpec.staging === true;

  let expected = null;
  const pathKey = TEMPLATE_NAME_TO_PATH_KEY[jobSpec.templateName] || jobSpec.fromTemplateId || null;
  if (pathKey && KNOWN_CLEAN_PATHS[pathKey]?.expectedPortals) {
    expected = KNOWN_CLEAN_PATHS[pathKey].expectedPortals;
  }

  let defaults;
  if (expected) {
    defaults = {};
    for (const key of PORTAL_ORDER) {
      defaults[key] = expected[key] === true;
    }
  } else {
    defaults = {
      portal0:  true,
      portal1:  scriptActive && !isClips,
      portal1b: false,
      portal2:  avatarActive,
      portal3a: true,
      portal3b: true,
      portal4:  !isClips && scriptActive,
      portal5:  !staging,
    };
  }

  if (isClips || !scriptActive) {
    defaults.portal1 = false;
    defaults.portal2 = false;
    // CPD-1046: clip comps still need portal4 pixel QA before publish (portal3a samples only).
    if (isClips) defaults.portal4 = true;
    else defaults.portal4 = false;
  }
  if (staging) defaults.portal5 = false;

  const portals = {};
  for (const key of PORTAL_ORDER) {
    const existing = jobSpec.portals?.[key];
    if (existing && typeof existing.active === 'boolean') {
      portals[key] = { ...existing };
      continue;
    }
    const active = defaults[key] !== false;
    portals[key] = {
      active,
      reason: active ? null : (staging && key === 'portal5'
        ? 'staging_mode — skipped for review before publish'
        : isTopicOnly ? 'topic_only — no source video'
        : !scriptActive && (key === 'portal1' || key === 'portal4') ? 'script stage inactive'
        : isClips && key === 'portal4' && !active ? 'clip compilation — portal4 inactive (override)'
        : null),
    };
  }

  if (isTopicOnly) {
    for (const key of ['portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5']) {
      portals[key] = { active: false, reason: 'topic_only — no source video or design spec' };
    }
  }
  if (staging) {
    portals.portal5 = { active: false, reason: 'staging_mode — skipped for review before publish' };
  }

  jobSpec.portals = portals;
  return portals;
}

function resolveActivePortals(jobSpec = {}) {
  buildPortalsMap(jobSpec);
  return PORTAL_ORDER.filter((key) => jobSpec.portals[key]?.active === true);
}

function resolveActiveExtensions(jobSpec = {}) {
  const ordered = [];
  const addOns = jobSpec.addOns || {};
  const ext = jobSpec.extensions || {};

  if (addOns.heygen?.active || ext.heygen_ext?.ordered) ordered.push('heygen_ext');
  if (addOns.tts?.active || ext.tts_ext?.ordered) ordered.push('tts_ext');
  if (addOns.shoppable?.active || ext.shoppable_ext?.ordered) ordered.push('shoppable_ext');
  if (addOns.thumbnail?.active || ext.thumbnail_ext?.ordered) ordered.push('thumbnail_ext');
  if (ext.gpt4o_qa_ext?.ordered) ordered.push('gpt4o_qa_ext');
  if (ext.twelvelabs_qa_ext?.ordered) ordered.push('twelvelabs_qa_ext');

  jobSpec.extensions = ext;
  for (const key of ordered) {
    jobSpec.extensions[key] = { ...(jobSpec.extensions[key] || {}), ordered: true };
  }
  return ordered;
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
  buildPortalsMap,
  resolveActivePortals,
  resolveActiveExtensions,
  PORTAL_ORDER,
};
