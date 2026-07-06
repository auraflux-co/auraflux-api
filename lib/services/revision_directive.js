'use strict';
/**
 * lib/services/revision_directive.js — CPD-1231
 *
 * Converts customer/operator natural-language revision feedback into structured
 * assembly directives the pipeline can consume (script regen, chrome/thumbnail flags).
 */

const { logError } = require('../error_logger');

const CATEGORY_PORTAL_HINTS = {
  script:       'portal1',
  narration:    'portal1',
  clips:        'assembly',
  thumbnail:    'thumbnail_ext',
  branding:     'portal3a',
  audio:        'tts_ext',
  publish_meta: 'portal4',
};

/**
 * Heuristic fallback when Gemini is unavailable — still produces a usable directive.
 */
function buildHeuristicDirective({ feedback, categories = [], source = 'customer' }) {
  const text = String(feedback || '').trim();
  const cats = Array.isArray(categories) ? categories.map(String) : [];
  const lower = text.toLowerCase();

  const scriptChanges = [];
  const clipChanges = [];
  const thumbnailChanges = [];
  const brandingChanges = [];
  const audioChanges = [];

  if (cats.includes('script') || cats.includes('narration') ||
      /\b(script|narrat|voiceover|wording|intro|outro|hook)\b/.test(lower)) {
    scriptChanges.push(text);
  }
  if (cats.includes('clips') || /\b(clip|footage|segment|cut|trim)\b/.test(lower)) {
    clipChanges.push(text);
  }
  if (cats.includes('thumbnail') || /\b(thumbnail|cover|title card)\b/.test(lower)) {
    thumbnailChanges.push(text);
  }
  if (cats.includes('branding') || /\b(logo|brand|watermark|lower.?third|chrome)\b/.test(lower)) {
    brandingChanges.push(text);
  }
  if (cats.includes('audio') || /\b(audio|music|volume|sound|mute)\b/.test(lower)) {
    audioChanges.push(text);
  }

  if (!scriptChanges.length && !clipChanges.length && !thumbnailChanges.length &&
      !brandingChanges.length && !audioChanges.length) {
    scriptChanges.push(text);
  }

  const targetPortals = [...new Set(
    cats.map((c) => CATEGORY_PORTAL_HINTS[c]).filter(Boolean),
  )];
  if (!targetPortals.length) {
    if (scriptChanges.length) targetPortals.push('portal1');
    if (clipChanges.length || brandingChanges.length) targetPortals.push('portal3a');
    if (thumbnailChanges.length) targetPortals.push('thumbnail_ext');
  }

  const needsScriptRegen = scriptChanges.length > 0;
  const thumbnailRegen = thumbnailChanges.length > 0;

  return {
    summary:           text.slice(0, 500),
    rawFeedback:       text,
    source,
    categories:        cats,
    targetPortals,
    restartFromPortal: needsScriptRegen ? 'portal1' : (brandingChanges.length ? 'portal3a' : 'assembly'),
    needsScriptRegen,
    thumbnailRegen,
    scriptChanges,
    clipChanges,
    thumbnailChanges,
    brandingChanges,
    audioChanges,
    assemblyNotes:     [clipChanges, brandingChanges, audioChanges].flat().join(' ').trim() || text,
    parsedBy:          'heuristic',
  };
}

/**
 * Use Gemini to structure revision feedback when available.
 */
async function parseRevisionFeedback({ feedback, categories = [], jobSpec = {}, source = 'customer' }) {
  const text = String(feedback || '').trim();
  if (!text) {
    return buildHeuristicDirective({ feedback: '', categories, source });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildHeuristicDirective({ feedback: text, categories, source });
  }

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    });

    const jobContext = {
      contentType: jobSpec.contentType || null,
      title:       jobSpec.order?.title || null,
      brandName:   jobSpec.brandName || null,
    };

    const prompt = `You are a video production revision parser. Convert customer revision feedback into JSON for an automated pipeline.

Job context: ${JSON.stringify(jobContext)}
Categories selected: ${JSON.stringify(categories)}
Feedback: """${text.slice(0, 3500)}"""

Return ONLY valid JSON (no markdown) with this shape:
{
  "summary": "one sentence summary",
  "targetPortals": ["portal1"|"portal3a"|"thumbnail_ext"|"tts_ext"|"assembly"],
  "restartFromPortal": "portal1"|"portal3a"|"assembly",
  "needsScriptRegen": boolean,
  "thumbnailRegen": boolean,
  "scriptChanges": ["specific script fix 1", ...],
  "clipChanges": ["..."],
  "thumbnailChanges": ["..."],
  "brandingChanges": ["..."],
  "audioChanges": ["..."],
  "assemblyNotes": "concise notes for video assembly/chrome step"
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response?.text?.() || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in Gemini response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary:           String(parsed.summary || text.slice(0, 200)),
      rawFeedback:       text,
      source,
      categories:        Array.isArray(categories) ? categories : [],
      targetPortals:     Array.isArray(parsed.targetPortals) ? parsed.targetPortals : ['portal1'],
      restartFromPortal: parsed.restartFromPortal || 'portal1',
      needsScriptRegen:  !!parsed.needsScriptRegen,
      thumbnailRegen:    !!parsed.thumbnailRegen,
      scriptChanges:     Array.isArray(parsed.scriptChanges) ? parsed.scriptChanges : [text],
      clipChanges:       Array.isArray(parsed.clipChanges) ? parsed.clipChanges : [],
      thumbnailChanges:  Array.isArray(parsed.thumbnailChanges) ? parsed.thumbnailChanges : [],
      brandingChanges:   Array.isArray(parsed.brandingChanges) ? parsed.brandingChanges : [],
      audioChanges:      Array.isArray(parsed.audioChanges) ? parsed.audioChanges : [],
      assemblyNotes:     String(parsed.assemblyNotes || text),
      parsedBy:          'gemini',
    };
  } catch (err) {
    logError('[revision_directive] Gemini parse failed — heuristic fallback', err);
    return buildHeuristicDirective({ feedback: text, categories, source });
  }
}

/**
 * Map structured directive → portal1 fixDirective shape + job spec flags.
 */
function buildPortal1FixDirective(directive) {
  const lines = [];
  if (directive.summary) lines.push(directive.summary);
  (directive.scriptChanges || []).forEach((s) => lines.push(String(s)));

  return {
    delivered:         lines.join(' ').slice(0, 2000),
    structuralIssues:  (directive.scriptChanges || []).map(String),
    mismatches:        [
      ...(directive.clipChanges || []).map((c) => ({ fix: String(c), section: 'clips' })),
      ...(directive.thumbnailChanges || []).map((c) => ({ fix: String(c), section: 'thumbnail' })),
      ...(directive.brandingChanges || []).map((c) => ({ fix: String(c), section: 'branding' })),
    ],
    customerRevision:    true,
    revisionSource:      directive.source || 'customer',
    assemblyNotes:       directive.assemblyNotes || '',
  };
}

/**
 * Apply parsed directive onto a job spec before retry dispatch.
 */
function applyRevisionDirectiveToJobSpec(spec, directive) {
  if (!spec.state) spec.state = {};
  spec.order = spec.order || {};

  spec.state.assemblyFixDirective = directive;
  spec.order.revisionContext = directive.summary || directive.rawFeedback;

  if (directive.needsScriptRegen || (directive.scriptChanges || []).length) {
    spec.state.portal1FixDirective = buildPortal1FixDirective(directive);
    spec.state.forceScriptRegen = true;
  }

  if (directive.thumbnailRegen) {
    spec.state.thumbnailRevisionRequested = true;
    spec.addOns = spec.addOns || {};
    spec.addOns.thumbnail = { ...(spec.addOns.thumbnail || {}), active: true, forceRegen: true };
  }

  if ((directive.brandingChanges || []).length) {
    spec.designSpec = spec.designSpec || {};
    spec.designSpec.revisionBrandingNotes = directive.brandingChanges.join('; ');
  }

  if (directive.assemblyNotes) {
    spec.designSpec = spec.designSpec || {};
    spec.designSpec.revisionAssemblyNotes = directive.assemblyNotes;
  }

  return spec;
}

/**
 * Parse feedback and apply to spec in one call.
 */
async function ingestRevisionFeedback(spec, { feedback, categories, source, actorId }) {
  const directive = await parseRevisionFeedback({
    feedback,
    categories,
    jobSpec: spec,
    source,
  });
  directive.requestedBy = actorId;
  directive.requestedAt = new Date().toISOString();
  applyRevisionDirectiveToJobSpec(spec, directive);
  return directive;
}

module.exports = {
  parseRevisionFeedback,
  buildHeuristicDirective,
  buildPortal1FixDirective,
  applyRevisionDirectiveToJobSpec,
  ingestRevisionFeedback,
};
