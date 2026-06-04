'use strict';
/**
 * lib/services/feature_input_schema.js — CPD-QA: Feature Input Parity
 *
 * Single source of truth for what each feature/enhancement requires as input —
 * used by:
 *   - POST /v1/jobs  (developer_api.js)  — validates incoming payloads
 *   - POST /jobs     (jobs_c1.js)        — validates dashboard payloads
 *   - GET  /v1/feature-inputs            — exposes schema to API developers
 *   - Dashboard wizard (via API response) — drives form field rendering
 *
 * Every entry in FEATURE_INPUTS defines:
 *   id          — unique feature key (matches addOns key and processing_manifest feature name)
 *   label       — human-readable name (same as dashboard UI label)
 *   description — what the feature does to the video
 *   apiField    — where the resolved value ends up on the jobSpec (spec.captions, spec.colorGrade, …)
 *   payloadPath — where to send it in the API request body
 *   inputs[]    — the fields the customer must/can provide
 *
 * When validating a request, call validateFeatureInputs(addOns) — it returns
 * { valid: boolean, errors: string[], warnings: string[] }.
 */

// ─── Input field type constants ───────────────────────────────────────────────
const T = {
  SELECT:  'select',
  BOOLEAN: 'boolean',
  TEXT:    'text',
  NUMBER:  'number',
};

// ─── Feature input definitions ────────────────────────────────────────────────

const FEATURE_INPUTS = [

  // ── Captions ────────────────────────────────────────────────────────────────
  {
    id:          'captions',
    label:       'Burnt-in captions',
    description: 'Word-level animated captions burnt into the video — no subtitle file needed.',
    apiField:    'spec.captions',
    payloadPath: 'addOns.captions',
    inputs: [
      {
        id:       'active',
        label:    'Enable captions',
        type:     T.BOOLEAN,
        required: true,
        default:  false,
      },
      {
        id:       'style',
        label:    'Caption style',
        type:     T.SELECT,
        required: false,
        default:  'animated',
        options: [
          { id: 'animated', label: 'Animated — word-by-word pop-in' },
          { id: 'clean',    label: 'Clean — static white text' },
          { id: 'minimal',  label: 'Minimal — small lower-third' },
          { id: 'burnin',   label: 'Burn-in — permanent SRT overlay' },
        ],
        hint: 'Defaults to animated if not specified.',
      },
    ],
    // Example payload:
    examplePayload: { captions: { active: true, style: 'animated' } },
  },

  // ── Color grade ─────────────────────────────────────────────────────────────
  {
    id:          'colorGrade',
    label:       'Color grade',
    description: 'Apply a cinematic color grade to the output video.',
    apiField:    'spec.colorGrade',
    payloadPath: 'addOns.colorGrade',
    inputs: [
      {
        id:       'active',
        label:    'Enable color grade',
        type:     T.BOOLEAN,
        required: true,
        default:  false,
      },
      {
        id:       'preset',
        label:    'Color preset',
        type:     T.SELECT,
        required: true,
        default:  'vivid',
        options: [
          { id: 'vivid',   label: 'Vivid — boosted saturation and contrast' },
          { id: 'warm',    label: 'Warm — golden tones, slight brightness' },
          { id: 'cool',    label: 'Cool — blue-shifted, clean' },
          { id: 'moody',   label: 'Moody — desaturated, high contrast' },
          { id: 'crisp',   label: 'Crisp — sharp and bright' },
          { id: 'clean',   label: 'Clean — flat, colour-accurate' },
          { id: 'neutral', label: 'Neutral — minimal correction only' },
          { id: 'neut',    label: 'Neutral (alias)' },
        ],
        hint: 'Required when active is true.',
      },
    ],
    examplePayload: { colorGrade: { active: true, preset: 'vivid' } },
  },

  // ── Visual effects ─────────────────────────────────────────────────────────
  {
    id:          'effects',
    label:       'Visual effects',
    description: 'Zoom punch, scene transitions, and motion graphics applied during post-processing.',
    apiField:    'spec.effects',
    payloadPath: 'addOns.effects',
    inputs: [
      {
        id:       'zoom',
        label:    'Zoom punch',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Slow Ken Burns zoom applied to clip segments.',
      },
      {
        id:       'transitions',
        label:    'Scene transitions',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Smooth crossfade blends between every clip cut.',
      },
      {
        id:       'slowmo',
        label:    'Slow motion',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Applies 50% slow motion to the assembled video.',
      },
      {
        id:       'vignette',
        label:    'Vignette',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Subtle dark vignette around the frame edges.',
      },
    ],
    examplePayload: { effects: { zoom: true, transitions: true } },
  },

  // ── Audio processing ────────────────────────────────────────────────────────
  {
    id:          'audio',
    label:       'Audio processing',
    description: 'Loudness normalisation, music ducking, and noise removal.',
    apiField:    'spec.audioOpts',
    payloadPath: 'addOns.audio',
    inputs: [
      {
        id:       'loudnorm',
        label:    'Volume balance',
        type:     T.BOOLEAN,
        required: false,
        default:  true,
        hint:     'EBU R128 loudness normalisation to −16 LUFS. Recommended for all jobs.',
      },
      {
        id:       'duck',
        label:    'Music ducking',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Automatically dips background music under speech.',
      },
      {
        id:       'denoise',
        label:    'Noise removal',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Reduces background noise and hiss from the audio.',
      },
    ],
    examplePayload: { audio: { loudnorm: true, duck: false } },
  },

  // ── Branding ────────────────────────────────────────────────────────────────
  {
    id:          'branding',
    label:       'Branding overlay',
    description: 'Apply your brand logo, colour skin, and chrome overlay to the video.',
    apiField:    'spec.addOns.branding',
    payloadPath: 'addOns.branding',
    inputs: [
      {
        id:       'active',
        label:    'Enable branding',
        type:     T.BOOLEAN,
        required: true,
        default:  true,
      },
      {
        id:       'brandId',
        label:    'Brand ID',
        type:     T.TEXT,
        required: false,
        default:  null,
        hint:     'Your brand configuration ID. Defaults to your account default brand if omitted.',
      },
    ],
    examplePayload: { branding: { active: true } },
  },

  // ── Layout ──────────────────────────────────────────────────────────────────
  {
    id:          'layout',
    label:       'Output layout',
    description: 'Reformat the video for portrait (TikTok/Reels/Shorts) or square (Instagram Feed).',
    apiField:    'spec.effects.layout',
    payloadPath: 'addOns.layout',
    inputs: [
      {
        id:       'portrait',
        label:    'Portrait 9:16 reframe',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Automatically applied when platforms includes tiktok, instagram_reels, or youtube_shorts.',
      },
      {
        id:       'square',
        label:    'Square 1:1 crop',
        type:     T.BOOLEAN,
        required: false,
        default:  false,
        hint:     'Automatically applied when platforms includes instagram_feed.',
      },
    ],
    examplePayload: { layout: { portrait: true } },
  },

  // ── TTS / Voiceover ─────────────────────────────────────────────────────────
  {
    id:          'tts',
    label:       'Voiceover (TTS)',
    description: 'AI voiceover narrates the generated script using ElevenLabs.',
    apiField:    'spec.addOns.tts',
    payloadPath: 'addOns.tts',
    inputs: [
      {
        id:       'active',
        label:    'Enable voiceover',
        type:     T.BOOLEAN,
        required: true,
        default:  false,
      },
      {
        id:       'provider',
        label:    'Voice provider',
        type:     T.SELECT,
        required: false,
        default:  'elevenlabs',
        options: [
          { id: 'elevenlabs', label: 'ElevenLabs — high-quality AI voice' },
        ],
      },
      {
        id:       'voiceId',
        label:    'Voice ID',
        type:     T.TEXT,
        required: false,
        default:  null,
        hint:     'ElevenLabs voice ID. Defaults to your account default voice if omitted.',
      },
    ],
    examplePayload: { tts: { active: true, provider: 'elevenlabs' } },
  },

  // ── HeyGen avatar ───────────────────────────────────────────────────────────
  {
    id:          'heygen',
    label:       'HeyGen avatar (managed tier only)',
    description: 'Render a talking-head AI avatar using HeyGen — managed tier feature.',
    apiField:    'spec.addOns.heygen',
    payloadPath: 'addOns.heygen',
    planRequired: 'managed',
    inputs: [
      {
        id:       'active',
        label:    'Enable avatar',
        type:     T.BOOLEAN,
        required: true,
        default:  false,
      },
      {
        id:       'avatarId',
        label:    'Avatar ID',
        type:     T.TEXT,
        required: false,
        default:  null,
        hint:     'HeyGen avatar ID. Defaults to your account default avatar if omitted.',
      },
    ],
    examplePayload: { heygen: { active: true } },
  },
];

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate the addOns / feature inputs in an incoming API request body.
 *
 * @param {object} addOns  — req.body.addOns (or the full body for backwards compat)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateFeatureInputs(addOns) {
  const errors   = [];
  const warnings = [];
  if (!addOns || typeof addOns !== 'object') return { valid: true, errors, warnings };

  for (const feature of FEATURE_INPUTS) {
    const featureCfg = addOns[feature.id];
    if (!featureCfg || typeof featureCfg !== 'object') continue;

    for (const input of feature.inputs) {
      const val = featureCfg[input.id];
      const isActive = featureCfg.active !== false; // default to active if not explicitly false

      if (input.required && isActive && val === undefined) {
        // For boolean fields that default to false, missing is fine
        if (input.type !== T.BOOLEAN) {
          errors.push(`${feature.id}.${input.id} is required when ${feature.id} is active`);
        }
      }

      if (val !== undefined && input.options) {
        const validIds = input.options.map((o) => o.id);
        if (!validIds.includes(val)) {
          errors.push(`${feature.id}.${input.id} must be one of: ${validIds.join(', ')} (got "${val}")`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Return a copy of the schema suitable for the GET /v1/feature-inputs API response.
 * Strips internal fields (apiField) and adds a link to documentation.
 */
function getPublicSchema() {
  return FEATURE_INPUTS.map((f) => ({
    id:           f.id,
    label:        f.label,
    description:  f.description,
    payloadPath:  f.payloadPath,
    planRequired: f.planRequired || 'operate',
    inputs:       f.inputs,
    example:      f.examplePayload,
  }));
}

/**
 * Given a set of addOns from an API request, extract the canonical feature config
 * objects that should be written to the jobSpec.
 * Returns { captions, colorGrade, effects, audioOpts, branding, layout, tts, heygen }
 * with only the features that were actually provided.
 */
function extractFeatureConfig(addOns) {
  if (!addOns || typeof addOns !== 'object') return {};
  const result = {};

  if (addOns.captions   && typeof addOns.captions   === 'object') result.captions   = addOns.captions;
  if (addOns.colorGrade && typeof addOns.colorGrade === 'object') result.colorGrade = addOns.colorGrade;
  if (addOns.effects    && typeof addOns.effects    === 'object') result.effects    = addOns.effects;
  if (addOns.audio      && typeof addOns.audio      === 'object') result.audioOpts  = addOns.audio;
  if (addOns.branding   && typeof addOns.branding   === 'object') result.branding   = addOns.branding;
  if (addOns.layout     && typeof addOns.layout     === 'object') result.layout     = addOns.layout;
  if (addOns.tts        && typeof addOns.tts        === 'object') result.tts        = addOns.tts;
  if (addOns.heygen     && typeof addOns.heygen     === 'object') result.heygen     = addOns.heygen;

  return result;
}

module.exports = {
  FEATURE_INPUTS,
  validateFeatureInputs,
  getPublicSchema,
  extractFeatureConfig,
};
