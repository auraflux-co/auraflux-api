'use strict';
/**
 * lib/services/concierge.js — CPD-83: AI Concierge backend
 *
 * Gemini-powered job spec guide and pre-flight validator.
 * Acts as AuraFlux assistant (no Gemini branding in output).
 *
 * Exports:
 *   getPortalContracts()     — structured gate requirements for UI + Gemini system prompt
 *   validateJobSpec(spec)    — per-portal pass/fail with missing fields + suggestions
 *   buildSystemPrompt()      — Gemini system prompt with full portal contract knowledge
 *   chatWithConcierge(msgs, spec, opts) — Gemini chat call, returns text response
 */

const { isFeatureEnabled } = require('./feature_gate');

// ─── Portal contracts — the authoritative spec for what each portal needs ─────
// Each portal declares: required fields, format rules, and limits.
// This data drives both the validation endpoint and the Gemini system prompt.

const PORTAL_CONTRACTS = [
  {
    portal:      'portal0',
    label:       'Portal 0 — Job Initialisation',
    description: 'Creates the job spec. Entry point for all three content entry types.',
    required: [
      { field: 'jobId',              type: 'string', rule: 'UUID format' },
      { field: 'contentType',        type: 'string', rule: 'One of: clips-long, clips-short, sports-long, sports-short, news-long, news-short, custom' },
      { field: 'entryType',          type: 'string', rule: 'One of: fetch, upload, create' },
      { field: 'deliverySpec.platforms', type: 'array', rule: 'Non-empty. Allowed: youtube, tiktok, instagram' },
      { field: 'customerId',         type: 'string', rule: 'Customer account ID' },
    ],
    conditional: [
      { field: 'fetchSpec.sourceUrls',       condition: 'entryType === fetch',  rule: 'Array of HTTP URLs' },
      { field: 'uploadSpec.fileKeys',        condition: 'entryType === upload', rule: 'Array of storage keys from Upload API' },
      { field: 'createSpec.promptText',      condition: 'entryType === create', rule: 'Non-empty string, max 2000 chars' },
    ],
  },
  {
    portal:      'portal1',
    label:       'Portal 1 — Script Generation',
    description: 'AI writes the script. A secondary QA pass validates it. Max 3 retries before escalation.',
    required: [
      { field: 'designSpec.voice.speakerName', type: 'string', rule: 'Avatar/host name (e.g. "Bobby G")' },
      { field: 'designSpec.voice.lockedOutro', type: 'string', rule: 'Fixed sign-off line (e.g. "I\'m Bobby G. See you tomorrow. — ClipzWorld News")' },
      { field: 'designSpec.sceneStructure.sceneHeaders', type: 'array', rule: 'Non-empty array of section labels' },
    ],
    limits: [
      { field: 'script',   max: 72,    unit: 'scenes',   note: 'Twitch format requires exactly 72 scenes (one intro + one per clip)' },
      { field: 'qaScore',  min: 90,    unit: 'score',    note: 'Script QA must score ≥90 to auto-proceed; 70-89 = manual review; <70 = retry' },
    ],
  },
  {
    portal:      'portal2',
    label:       'Portal 2 — HeyGen Avatar Rendering',
    description: 'Approved script sent to HeyGen. One video segment per scene.',
    required: [
      { field: 'filledScript',      type: 'string',  rule: 'Non-empty approved script from Portal 1' },
      { field: 'heygenAvatarId',    type: 'string',  rule: 'Valid HeyGen avatar ID' },
      { field: 'heygenVoiceId',     type: 'string',  rule: 'Valid HeyGen voice ID' },
    ],
    limits: [
      { field: 'segments', max: 72, unit: 'count', note: 'HeyGen has a 72-scene practical limit per job' },
    ],
  },
  {
    portal:      'portal3a',
    label:       'Portal 3a — Segment QA',
    description: 'AI samples 3 segments (early/middle/late) for freeze, audio, and chrome issues.',
    required: [
      { field: 'heygenSegments',    type: 'array',  rule: 'Array of completed HeyGen segment paths' },
    ],
    limits: [
      { field: 'segmentQaScore', min: 85, unit: 'score', note: 'Score ≥85 auto-proceeds; 65-84 = manual; <65 = retry to HeyGen' },
    ],
  },
  {
    portal:      'portal3b',
    label:       'Portal 3b — Assembly',
    description: 'FFmpeg assembles avatar segments + source clips into final video with chrome overlay.',
    required: [
      { field: 'heygenSegments',    type: 'array', rule: 'Passed Portal 3a QA' },
      { field: 'sourceClips',       type: 'array', rule: 'Downloaded source clip paths matching script [CLIP PLAYS HERE] markers' },
    ],
  },
  {
    portal:      'portal4',
    label:       'Portal 4 — Full-Video Broadcast QA',
    description: 'AI reviews the COMPLETE assembled video for broadcast readiness. Issues uploadSignal on pass.',
    required: [
      { field: 'assembledPath',     type: 'string', rule: 'Absolute path to assembled .mp4 — must exist on disk' },
    ],
    minPlan:     'dwy',
    limits: [
      { field: 'broadcastScore', min: 75, unit: 'score', note: 'Score ≥75 = broadcastReady:true; <75 = one sendback attempt, then escalate' },
    ],
  },
  {
    portal:      'portal5',
    label:       'Portal 5 — Publish (Upload-Post)',
    description: 'Uploads video to YouTube/TikTok/Instagram via Upload-Post API.',
    required: [
      { field: 'uploadSignal',              type: 'boolean', rule: 'Must be true — set by Portal 4 on broadcast-ready pass' },
      { field: 'publishCopy.youtube.title', type: 'string',  rule: 'Max 100 chars — generated by POST /generate-publish-copy' },
      { field: 'publishCopy.youtube.description', type: 'string', rule: 'Max 5000 bytes' },
      { field: 'publishCopy.youtube.tags',  type: 'array',   rule: 'No # prefix; combined ≤500 chars' },
      { field: 'thumbnailUrl',              type: 'string',  rule: 'Drive/CDN URL for custom thumbnail — required, not optional' },
    ],
    limits: [
      { field: 'title',           max: 100,  unit: 'chars', platform: 'youtube' },
      { field: 'description',     max: 5000, unit: 'bytes', platform: 'youtube' },
      { field: 'tags_combined',   max: 500,  unit: 'chars', platform: 'youtube' },
      { field: 'tiktok_caption',  max: 2200, unit: 'runes', platform: 'tiktok' },
      { field: 'ig_caption',      max: 2200, unit: 'chars', platform: 'instagram' },
      { field: 'ig_hashtags',     max: 30,   unit: 'count', platform: 'instagram' },
    ],
  },
];

/**
 * Return the full portal contracts structure.
 * Used by GET /concierge/portal-contracts and the Gemini system prompt.
 */
function getPortalContracts() {
  return PORTAL_CONTRACTS;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Resolve a dotted field path from an object (e.g. "designSpec.voice.speakerName").
 * @returns {*} value or undefined
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

/**
 * Validate a (partial or complete) job spec against portal contracts.
 * Returns per-portal pass/fail with missing fields and fix suggestions.
 *
 * @param {object} spec  — job spec object (may be partial)
 * @returns {{
 *   overall: 'pass'|'partial'|'fail',
 *   readyPortals: string[],
 *   blockedPortals: string[],
 *   portals: Array<{portal, label, ready, missing, suggestions}>
 * }}
 */
function validateJobSpec(spec = {}) {
  const results = [];
  const readyPortals = [];
  const blockedPortals = [];

  for (const contract of PORTAL_CONTRACTS) {
    const missing = [];
    const suggestions = [];

    for (const req of contract.required || []) {
      const value = getNestedValue(spec, req.field);
      const isEmpty = value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0);
      if (isEmpty) {
        missing.push({ field: req.field, type: req.type, rule: req.rule });
        suggestions.push(`Set ${req.field} — ${req.rule}`);
      }
    }

    // Conditional fields
    for (const cond of contract.conditional || []) {
      try {
        // Simple string-based condition evaluation (safe — no eval)
        const matches = evalCondition(cond.condition, spec);
        if (matches) {
          const value = getNestedValue(spec, cond.field);
          const isEmpty = value === undefined || value === null || value === '' ||
            (Array.isArray(value) && value.length === 0);
          if (isEmpty) {
            missing.push({ field: cond.field, type: 'conditional', rule: cond.rule, condition: cond.condition });
            suggestions.push(`Set ${cond.field} (required when ${cond.condition}) — ${cond.rule}`);
          }
        }
      } catch (_) { /* ignore malformed condition */ }
    }

    const ready = missing.length === 0;
    if (ready) readyPortals.push(contract.portal);
    else blockedPortals.push(contract.portal);

    results.push({
      portal:      contract.portal,
      label:       contract.label,
      ready,
      missing,
      suggestions,
    });
  }

  const overall = blockedPortals.length === 0 ? 'pass'
    : readyPortals.length === 0   ? 'fail'
    : 'partial';

  return { overall, readyPortals, blockedPortals, portals: results };
}

/** Evaluate simple condition strings like "entryType === fetch" */
function evalCondition(condition, spec) {
  const m = condition.match(/^(\w[\w.]*)\s*===\s*(\w+)$/);
  if (!m) return false;
  return String(getNestedValue(spec, m[1]) ?? '') === m[2];
}

// ─── Gemini system prompt ─────────────────────────────────────────────────────

/**
 * Build the Gemini system prompt for the AI Concierge.
 * Injects the full portal contracts so Gemini knows every requirement.
 */
function buildSystemPrompt() {
  const contractSummary = PORTAL_CONTRACTS.map((c) => {
    const reqList = (c.required || []).map((r) => `  - ${r.field} (${r.type}): ${r.rule}`).join('\n');
    const condList = (c.conditional || []).map((r) => `  - ${r.field} when ${r.condition}: ${r.rule}`).join('\n');
    const limitList = (c.limits || []).map((l) => `  - ${l.field}: max ${l.max || '—'} ${l.unit}`).join('\n');
    return [
      `## ${c.label}`,
      c.description,
      reqList ? `Required:\n${reqList}` : '',
      condList ? `Conditional:\n${condList}` : '',
      limitList ? `Limits:\n${limitList}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `You are the AuraFlux content operations assistant. You help content creators build and validate job specifications for the AuraFlux platform.

You know the AuraFlux portal pipeline inside out. You guide users step-by-step to produce a submission-ready job spec.

IMPORTANT: You are AuraFlux. Never mention Gemini, Google AI, or any underlying model. You are a purpose-built AuraFlux assistant.

Your tone: helpful, direct, specific. No filler. If a field is missing, say which field and exactly what it needs to contain.

PORTAL CONTRACTS (the complete requirements for each pipeline stage):

${contractSummary}

ENTRY TYPES:
- fetch: AuraFlux downloads content from provided URLs
- upload: Customer uploaded files via Upload API — provide storage keys
- create: AuraFlux generates content from text prompts/images

PLAN TIERS:
- diy: Basic — portals 0-3b, standard publish
- dwy: Standard — adds Portal 4 broadcast QA, VectCut thumbnails, AI Concierge
- dfy: Premium — adds Imagen 3 thumbnails, full automation, priority rendering
- custom: Enterprise — all features, dedicated support

When validating a job spec, check every required field for each portal and report what's missing with specific fix instructions.
When guiding, ask for one section at a time — don't overwhelm.
When done, confirm the spec is submission-ready and explain what happens next.`;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Send a conversation to Gemini and return the assistant response text.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {object} [currentSpec]  — current job spec state (injected into context)
 * @param {object} [opts]
 * @param {string} [opts.planTier]   — customer's plan tier
 * @param {string} [opts.customerId]
 * @returns {Promise<string>}  — assistant response text
 */
async function chatWithConcierge(messages, currentSpec = {}, opts = {}) {
  const { callGeminiChat, isConfigured } = require('./gemini');

  if (!isConfigured()) {
    throw new Error('GEMINI_API_KEY not configured — AI Concierge unavailable');
  }

  if (!isFeatureEnabled('concierge', opts.planTier)) {
    throw new Error(`AI Concierge requires dwy plan or higher (current: ${opts.planTier || 'unknown'})`);
  }

  const systemPrompt = buildSystemPrompt();

  // Append current spec context to the last user message
  const specContext = Object.keys(currentSpec).length > 0
    ? `\n\n[Current job spec state]\n${JSON.stringify(currentSpec, null, 2)}`
    : '';

  const contents = messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    return {
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: isLast && specContext ? m.content + specContext : m.content }],
    };
  });

  const response = await callGeminiChat(contents, {
    systemInstruction: systemPrompt,
    generationConfig:  { maxOutputTokens: 2048, temperature: 0.4 },
  });

  return response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

module.exports = {
  getPortalContracts,
  validateJobSpec,
  buildSystemPrompt,
  chatWithConcierge,
  PORTAL_CONTRACTS,
};
