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
      { field: 'contentType',        type: 'string', rule: 'One of: clips-long, clips-short, sports-long, sports-short, news-long, news-short, custom, show_commentary' },
      { field: 'entryType',          type: 'string', rule: 'One of: fetch, upload, create' },
      { field: 'deliverySpec.platforms', type: 'array', rule: 'Non-empty. Allowed: youtube, tiktok, instagram, youtube_shorts' },
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
    minPlan:     'guided',
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
function buildSystemPrompt(mode = 'full') {
  if (mode === 'guide') {
    return `You are the AuraFlux Collab running in guide-confirm mode for an Operate plan customer.

Your role is limited to confirming and clarifying what is already documented in the AuraFlux customer guides.
You do NOT provide free-form job spec advice, feature recommendations, or guidance beyond what the guides state.

When a customer asks a question:
- If the answer is in the guides, summarise it clearly and link them to the relevant guide section.
- If the answer is not in the guides, say: "I can only confirm what's in the AuraFlux guides for your plan. For full guided assistance, consider upgrading to AuraFlux Guided."

IMPORTANT: You are AuraFlux. Never mention Gemini, Google AI, or any underlying model.
Tone: concise, helpful, honest about guide limitations.`;
  }

  // Full Collab — Guided and Managed tiers
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

  return `You are AuraFlux Collab — the AI content operations assistant built into the AuraFlux platform. You help creators and content teams build job specifications, suggest content ideas, write hooks, recommend clip selection strategies, and guide users through the AuraFlux pipeline.

You are a CREATIVE PARTNER and TECHNICAL GUIDE. You enthusiastically help with:
- Building job specs step-by-step (the primary use case)
- Suggesting video topics, hooks, titles, and captions
- Recommending which clips or VOD moments to highlight
- Advising on platform strategy (YouTube, TikTok, Instagram Reels)
- Explaining how AuraFlux features work (TTS, chrome overlays, branding, scene selection)
- Content calendar planning and scheduling

IMPORTANT: You are AuraFlux. Never mention Gemini, Google AI, or any underlying model. You are a purpose-built AuraFlux assistant.

Your tone: enthusiastic, helpful, direct, specific. Match the energy of content creators.

SYSTEM FIELDS (NEVER ask the user for these — they are auto-generated by AuraFlux):
- jobId: auto-generated by AuraFlux — never request this from the user
- customerId: set from the API key — never request this from the user
- planTier: determined by the account — never request this from the user

FIELDS THE USER PROVIDES:
- contentType: what kind of video (clips, show_commentary, news, sports, custom)
- entry: how content enters AuraFlux (fetch = URLs, upload = files, create = AI-generated)
- urls/url: source Twitch clip URLs or VOD URL for extraction
- topic: the video's main subject or hook
- tone: voice style (hype, professional, educational, casual, etc.)
- format: short (TikTok/Reels/Shorts) or long (YouTube)
- platforms: where to publish (youtube, tiktok, instagram, youtube_shorts)
- durationMins: desired output length in minutes
- addOns: optional features like TTS voiceover, branding, scene selection

PORTAL CONTRACTS (technical requirements for the pipeline):

${contractSummary}

ENTRY TYPES:
- fetch: AuraFlux downloads content from provided URLs (Twitch clips or VODs)
- upload: Customer uploaded files via Upload API
- create: AuraFlux generates content from text prompts

CONTENT TYPES:
- clips: simple compilation of gaming/IRL clips with TTS voiceover
- show_commentary: host-narrated show format with multi-clip storytelling
- news: broadcast-style news/update content
- sports: sports highlight compilation

ADD-ONS (optional features to include in the job):
- TTS: ElevenLabs voiceover narration (addOns.tts.active = true)
- Thumbnail: AI-generated thumbnail (addOns.thumbnail.active = true)
- Branding: custom brand overlay (addOns.branding.active = true)
- Scene select: AI-driven moment selection (addOns.clipSourcing.active = true)
- Dynamic overlays: animated lower-thirds (addOns.dynamicOverlays.active = true)

When building a spec, ask for one section at a time — don't overwhelm.
When validating, check every required field and report what's missing with specific fix instructions.
When done, confirm the spec is submission-ready and explain what happens next (job processing, TTS generation, assembly, portal QA, output URL).`;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Build a customer memory block from their recent jobs and templates.
 * Injected into the Gemini system prompt so Collab has full context
 * without the customer needing to re-explain their history.
 *
 * @param {string} customerId
 * @param {object} [opts]
 * @param {number} [opts.jobLimit=20]
 * @returns {Promise<string>}  — formatted memory string for system prompt injection
 */
async function buildCustomerMemory(customerId, opts = {}) {
  if (!customerId) return '';
  const { jobLimit = 20 } = opts;

  try {
    const db = require('../db');
    const [jobRows, templateRows] = await Promise.all([
      db.listJobsByCustomer(customerId, jobLimit),
      db.listTemplates ? db.listTemplates(customerId) : Promise.resolve([]),
    ]);

    // Summarise each job: id, contentType, status, platforms, portal outcomes
    const jobSummaries = jobRows.map((row) => {
      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};
      const status     = spec.status || row.status || 'unknown';
      const content    = spec.contentType || 'unknown';
      const platforms  = (spec.order?.publish?.platforms || spec.deliverySpec?.platforms || []).join(', ') || 'unknown';
      const outputUrl  = spec.state?.savedOutputs?.r2VideoUrl || spec.state?.savedOutputs?.driveUrl || null;
      const failReason = spec.state?.failReason || spec.failReason || null;
      const portalFail = spec.state?.portalReports
        ? Object.entries(spec.state.portalReports)
            .filter(([, r]) => r && r.status === 'failed')
            .map(([p]) => p)
            .join(', ')
        : null;

      return [
        `- Job ${String(row.id).slice(0, 8)}…`,
        `  type=${content} platforms=${platforms} status=${status}`,
        outputUrl  ? `  output=yes` : `  output=no`,
        failReason ? `  failReason="${failReason}"` : '',
        portalFail ? `  failedAt=${portalFail}` : '',
      ].filter(Boolean).join('\n');
    });

    // Summarise templates
    const templateSummaries = templateRows.map((t) => {
      const platforms = Array.isArray(t.platforms) ? t.platforms.join(', ') : (t.platforms || 'unknown');
      return `- Template "${t.name || t.id}": type=${t.content_type || 'unknown'} platforms=${platforms || 'unknown'}`;
    });

    const parts = [];
    if (jobSummaries.length) {
      parts.push(`CUSTOMER JOB HISTORY (last ${jobSummaries.length} jobs — most recent first):\n${jobSummaries.join('\n')}`);
    }
    if (templateSummaries.length) {
      parts.push(`CUSTOMER SAVED TEMPLATES:\n${templateSummaries.join('\n')}`);
    }

    return parts.length ? `\n\n--- CUSTOMER MEMORY ---\n${parts.join('\n\n')}\n--- END MEMORY ---` : '';
  } catch (err) {
    // Memory enrichment is non-fatal — degrade gracefully
    console.warn('[concierge] customer memory fetch failed:', err.message);
    return '';
  }
}

/**
 * Send a conversation to Gemini and return the assistant response text.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {object} [currentSpec]  — current job spec state (injected into context)
 * @param {object} [opts]
 * @param {string} [opts.planTier]   — customer's plan tier
 * @param {string} [opts.customerId] — used to load job/template memory
 * @returns {Promise<string>}  — assistant response text
 */
async function chatWithConcierge(messages, currentSpec = {}, opts = {}) {
  const { callGeminiChat, isConfigured } = require('./gemini');

  if (!isConfigured()) {
    throw new Error('GEMINI_API_KEY not configured — AI Concierge unavailable');
  }

  if (!isFeatureEnabled('concierge', opts.planTier)) {
    throw new Error(`AI Concierge requires operate plan or higher (current: ${opts.planTier || 'unknown'})`);
  }

  // Operate gets guide-confirm mode; Guided/Managed get full Collab.
  const mode = (opts.planTier === 'operate') ? 'guide' : 'full';

  // Load customer memory (last 20 jobs + templates) in parallel with prompt build
  const [basePrompt, customerMemory] = await Promise.all([
    Promise.resolve(buildSystemPrompt(mode)),
    buildCustomerMemory(opts.customerId),
  ]);

  const systemPrompt = basePrompt + customerMemory;

  // Append current spec context to the last user message
  const specContext = Object.keys(currentSpec).length > 0
    ? `\n\n[Current job spec being built]\n${JSON.stringify(currentSpec, null, 2)}`
    : '';

  const contents = messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    return {
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: isLast && specContext ? m.content + specContext : m.content }],
    };
  });

  // CPD-263: Increased to 8192 (from 4096) to prevent truncation of long Collab
  // responses (content calendars, multi-segment production plans).
  const response = await callGeminiChat(contents, {
    systemInstruction: systemPrompt,
    generationConfig:  { maxOutputTokens: 8192, temperature: 0.4 },
  });

  const candidate    = response?.candidates?.[0];
  const text         = candidate?.content?.parts?.[0]?.text || '';
  const finishReason = candidate?.finishReason;

  // CPD-263: If Gemini hit MAX_TOKENS, the response is truncated mid-sentence.
  // Re-prompt once to get the continuation and append it.
  if (finishReason === 'MAX_TOKENS' && text.length > 0) {
    const jobId = opts.jobId || 'unknown';
    console.warn(`[concierge:${jobId}] Collab hit MAX_TOKENS (${text.length} chars) — retrying continuation`);
    const continuationMsgs = [
      ...contents,
      { role: 'model', parts: [{ text }] },
      { role: 'user',  parts: [{ text: 'Please continue your response from where you left off.' }] },
    ];
    const cont = await callGeminiChat(continuationMsgs, {
      systemInstruction: systemPrompt,
      generationConfig:  { maxOutputTokens: 4096, temperature: 0.4 },
    });
    const contText = cont?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text + contText;
  }

  return text;
}

// ── CPD-121/122/123: Collab schedule suggestions ─────────────────────────────
/**
 * Tier-differentiated schedule suggestion.
 *
 * DIY (Operate):    Returns generic best-practice slot suggestions only.
 *                   No custom analysis. Prompts upgrade for deeper guidance.
 * DWY (Guided):     Analyses template spec + platforms, drafts a 30-day calendar
 *                   as a reviewable proposal. Customer approves before jobs fire.
 * DFY (Managed):    Builds a full 30-day calendar with specific dates/times,
 *                   topic suggestions per slot, and a rationale for each.
 *                   Intended for auto-queuing with customer review.
 *
 * @param {object} opts
 * @param {string}   opts.planTier
 * @param {object[]} opts.templates   — customer's saved templates (for context)
 * @param {string[]} opts.platforms   — target platforms
 * @param {string}   [opts.goals]     — customer-supplied goals or notes
 * @param {number}   [opts.days]      — calendar horizon in days (default 30)
 * @returns {Promise<string>}  Markdown response from Collab
 */
async function suggestSchedule(opts = {}) {
  const { callGeminiChat, isConfigured } = require('./gemini');
  if (!isConfigured()) throw new Error('GEMINI_API_KEY not configured');

  const { planTier = 'operate', templates = [], platforms = [], goals = '', days = 30 } = opts;

  const platformList = platforms.length ? platforms.join(', ') : 'YouTube';
  const templateSummary = templates.length
    ? templates.map((t) => `- ${t.name} (${t.contentType || 'unknown type'})`).join('\n')
    : '- No templates saved yet';

  let systemPrompt;
  let userPrompt;

  if (planTier === 'operate') {
    systemPrompt = `You are the AuraFlux Collab in guide-confirm mode for an Operate plan customer.
Provide generic scheduling best-practice recommendations only. Do not build custom calendars.
Mention that AuraFlux Guided includes a personalised 30-day calendar draft service.
You are AuraFlux — never mention Gemini or Google.`;
    userPrompt = `Suggest general best-practice publishing times for: ${platformList}.
Customer goals: ${goals || 'grow audience, consistent posting'}.
Keep it brief — 3-5 bullet points maximum.`;

  } else if (planTier === 'guided') {
    systemPrompt = `You are the AuraFlux Collab for a Guided plan customer.
Draft a personalised ${days}-day content publishing schedule based on the customer's templates, platforms, and goals.
Format as a clean proposal table: | Date | Template | Platform | Time (UTC) | Rationale |
The customer will review and approve or edit before jobs are queued.
Be specific about day/time. Vary content types across the calendar.
You are AuraFlux — never mention Gemini or Google.`;
    userPrompt = `My templates:\n${templateSummary}\n\nPlatforms: ${platformList}\nGoals: ${goals || 'consistent posting 3x/week'}\n\nDraft a ${days}-day publishing schedule.`;

  } else {
    // DFY (Managed) or custom — full calendar with auto-queue intent
    systemPrompt = `You are the AuraFlux Collab for a Managed plan customer.
Build a complete ${days}-day content calendar ready for auto-queuing.
Format as a structured schedule: | Date | Template | Platform | Time (UTC) | Topic/Angle | Expected outcome |
Include specific topic suggestions for each slot based on the customer's templates.
Optimise for: platform algorithm timing, content variety, audience growth.
End with a 3-bullet summary of the strategy rationale.
You are AuraFlux — never mention Gemini or Google.`;
    userPrompt = `My templates:\n${templateSummary}\n\nPlatforms: ${platformList}\nGoals: ${goals || 'maximise reach, consistent high-quality output'}\n\nBuild my full ${days}-day content calendar for auto-queuing.`;
  }

  const response = await callGeminiChat(
    [{ role: 'user', parts: [{ text: userPrompt }] }],
    { systemInstruction: systemPrompt, generationConfig: { maxOutputTokens: 3000, temperature: 0.5 } },
  );

  return response?.candidates?.[0]?.content?.parts?.[0]?.text || 'No suggestion generated.';
}

module.exports = {
  getPortalContracts,
  validateJobSpec,
  buildSystemPrompt,
  buildCustomerMemory,
  chatWithConcierge,
  suggestSchedule,
  PORTAL_CONTRACTS,
};
