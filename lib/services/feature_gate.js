'use strict';
/**
 * lib/services/feature_gate.js — Plan-based feature gating
 *
 * ALL platform features are wired in the codebase. This service controls
 * which features are active at runtime based on the customer's plan tier
 * and the job spec. Environment variables are for infrastructure credentials,
 * not feature activation.
 *
 * Rule: a feature is enabled when:
 *   1. The customer's plan tier >= the feature's min_plan, AND
 *   2. The required credentials are present (env var check — infrastructure only)
 *
 * Usage:
 *   const { isFeatureEnabled, getEnabledFeatures } = require('./feature_gate');
 *   if (isFeatureEnabled('thumbnail.imagen', jobSpec.planTier)) { ... }
 *   const features = getEnabledFeatures('dwy');
 *
 * Plan tier hierarchy (lowest → highest):
 *   diy < dwy < dfy < custom
 */

// ─── Plan tier ordering ──────────────────────────────────────────────────────

const TIER_RANK = { diy: 1, dwy: 2, dfy: 3, custom: 99 };

function tierRank(tier) {
  return TIER_RANK[tier?.toLowerCase()] || 0;
}

// ─── Feature definitions ─────────────────────────────────────────────────────
//
// Each entry: { min_plan, label, requires_env?, description }
//   min_plan     — lowest plan tier that unlocks this feature
//   label        — human-readable name (shown in plan comparison UI)
//   requires_env — env var(s) that must also be set (infrastructure credential check)
//   description  — what the feature does

const FEATURE_PLANS = {
  // ── Thumbnail generation paths ─────────────────────────────────────────────
  'thumbnail.frame': {
    min_plan:    'diy',
    label:       'Thumbnail frame candidates',
    description: 'FFmpeg extracts 5 candidate frames from assembled video',
  },
  'thumbnail.designed': {
    min_plan:    'diy',
    label:       'Branded thumbnail template',
    description: 'Puppeteer-rendered HTML template with brand config',
  },
  'thumbnail.vectcut': {
    min_plan:    'diy',
    label:       'VectCut CapCut composition',
    requires_env: ['VECTCUT_API_URL'],
    description: 'CapCut-styled frame + hook text overlay via VectCut API',
  },
  'thumbnail.imagen': {
    min_plan:    'dfy',
    label:       'Imagen 3 AI-generated thumbnail',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Fully AI-generated thumbnail from hook text via Gemini Imagen 3',
  },
  'thumbnail.gemini_ranking': {
    min_plan:    'diy',
    label:       'Gemini creative ranking',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini acts as creative director — ranks all candidates with rationale',
  },

  // ── Audio / voice ──────────────────────────────────────────────────────────
  'tts.elevenlabs': {
    min_plan:    'diy',
    label:       'ElevenLabs TTS voiceover',
    requires_env: ['ELEVENLABS_API_KEY'],
    description: 'Standalone voice-over audio generation via ElevenLabs',
  },

  // ── Avatar video ───────────────────────────────────────────────────────────
  'avatar.heygen': {
    min_plan:    'dfy',
    label:       'HeyGen avatar video',
    requires_env: ['HEYGEN_API_KEY'],
    description: 'AI avatar video rendering via HeyGen',
  },

  // ── AI Concierge / Copilot ─────────────────────────────────────────────────
  'concierge': {
    min_plan:    'diy',
    label:       'AuraFlux Copilot (job assistant)',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered job spec guide and pre-flight validator',
  },

  // ── Support (CPD-115) ──────────────────────────────────────────────────────
  // DIY gets AI chat for first 30 days only (enforced at route level).
  // DWY/DFY get full support: AI chat + SMS escalation permanently.
  'support.ai_chat': {
    min_plan:    'dwy',
    label:       'AI support chat',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered support agent — diagnose, resolve, guide, escalate',
  },
  'support.escalation': {
    min_plan:    'dwy',
    label:       'Support SMS/email escalation',
    requires_env: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER'],
    description: 'SMS escalation via Twilio + email to robert@auraflux.co',
  },

  // ── Clip sourcing ──────────────────────────────────────────────────────────
  'clip.sourcing': {
    min_plan:    'diy',
    label:       'Show clip sourcing module',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini-powered footage analysis to suggest fair-use clip candidates for commentary jobs',
  },

  // ── Content types ──────────────────────────────────────────────────────────
  'content.show_commentary': {
    min_plan:    'diy',
    label:       'Narrative Clip Content type',
    description: 'Narrative voiceover commentary over show/entertainment clips (ElevenLabs TTS)',
  },
  'content.custom': {
    min_plan:    'diy',
    label:       'Custom content type',
    description: 'Fully custom job spec without preset constraints',
  },

  // ── Scheduling ─────────────────────────────────────────────────────────────
  'scheduling': {
    min_plan:    'diy',
    label:       'Content scheduling',
    description: 'Schedule publish with platform best-practice time recommendations',
  },

  // ── Portal upgrades ────────────────────────────────────────────────────────
  'portal.full_video_qa': {
    min_plan:    'diy',
    label:       'Portal 4: Full-video QA',
    requires_env: ['GEMINI_API_KEY'],
    description: 'Gemini broadcast-ready full-video review (Portal 4)',
  },
  'portal.web_research': {
    min_plan:    'diy',
    label:       'Web research pre-processor',
    description: 'Topic/keyword → research brief before Gemini script generation',
  },

  // ── Developer API ──────────────────────────────────────────────────────────
  'api.developer_access': {
    min_plan:    'diy',
    label:       'Developer API',
    description: 'Programmatic access via /v1/ endpoints with API key auth (Operate+)',
  },

  // ── Credits / billing ─────────────────────────────────────────────────────
  'credits.packs': {
    min_plan:    'diy',
    label:       'Credit pack purchases',
    description: 'One-time credit pack purchases via Stripe Checkout',
  },
  'credits.overage': {
    min_plan:    'diy',
    label:       'Overage credits',
    description: 'Automatic overage billing when included credits exhausted',
  },

  // ── Video generation ───────────────────────────────────────────────────────
  'video.wan_t2v': {
    min_plan:    'diy',
    label:       'WAN T2V video generation',
    requires_env: ['RUNPOD_API_KEY'],
    description: 'Text-to-video generation via WAN 2.2 on RunPod ComfyUI',
  },
  'video.wan_i2v': {
    min_plan:    'dfy',
    label:       'WAN I2V image-to-video',
    requires_env: ['RUNPOD_API_KEY'],
    description: 'Image-to-video generation via WAN 2.2 on RunPod ComfyUI',
  },

  // ── Publishing ─────────────────────────────────────────────────────────────
  'publish.direct_youtube': {
    min_plan:    'diy',
    label:       'Direct YouTube upload',
    description: 'YouTube Data API v3 direct upload (CPD-33)',
  },
  'publish.direct_tiktok': {
    min_plan:    'dfy',
    label:       'Direct TikTok/Instagram posting',
    description: 'TikTok Content Posting + Instagram Graph API direct (CPD-34)',
  },
};

// ─── Core gate functions ─────────────────────────────────────────────────────

/**
 * Check whether a feature is enabled for a given plan tier.
 *
 * @param {string} featureKey  — key from FEATURE_PLANS
 * @param {string} planTier    — 'diy' | 'dwy' | 'dfy' | 'custom' | null
 * @returns {boolean}
 */
function isFeatureEnabled(featureKey, planTier) {
  const feature = FEATURE_PLANS[featureKey];
  if (!feature) return false;

  // Plan tier check
  if (tierRank(planTier) < tierRank(feature.min_plan)) return false;

  // Infrastructure credential check (env vars must be set)
  if (feature.requires_env) {
    for (const envVar of feature.requires_env) {
      if (!process.env[envVar]) return false;
    }
  }

  return true;
}

/**
 * Return all features enabled for a given plan tier
 * (that also have their required env vars set).
 *
 * @param {string} planTier
 * @returns {string[]}  array of feature keys
 */
function getEnabledFeatures(planTier) {
  return Object.keys(FEATURE_PLANS).filter((key) => isFeatureEnabled(key, planTier));
}

/**
 * Return the full feature list with enabled/disabled status for a plan.
 * Used by the plan comparison UI and the AI Concierge.
 *
 * @param {string} planTier
 * @returns {Array<{ key, label, description, enabled, min_plan }>}
 */
function getPlanFeatureMatrix(planTier) {
  return Object.entries(FEATURE_PLANS).map(([key, def]) => ({
    key,
    label:        def.label,
    description:  def.description,
    min_plan:     def.min_plan,
    enabled:      isFeatureEnabled(key, planTier),
    requires_env: def.requires_env || [],
  }));
}

/**
 * Return a flat object of { featureKey: boolean } for a plan tier.
 * Useful for baking feature availability into a job spec at creation time.
 *
 * @param {string} planTier
 * @returns {Object}  e.g. { 'thumbnail.imagen': false, 'thumbnail.vectcut': true, ... }
 */
function buildFeatureFlags(planTier) {
  const flags = {};
  for (const key of Object.keys(FEATURE_PLANS)) {
    flags[key] = isFeatureEnabled(key, planTier);
  }
  return flags;
}

module.exports = {
  FEATURE_PLANS,
  TIER_RANK,
  isFeatureEnabled,
  getEnabledFeatures,
  getPlanFeatureMatrix,
  buildFeatureFlags,
};
