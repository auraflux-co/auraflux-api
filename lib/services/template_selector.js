'use strict';
/**
 * lib/services/template_selector.js — CPD-948
 *
 * Gemini-driven autonomous template selection.
 * Called in worker.js after runForJob() and before generateJobScript().
 *
 * Decision order:
 *   1. Brand-level preferred template (hard override)
 *   2. Gemini Flash inference from content context
 *   3. Content-type derived heuristic fallback
 *
 * Mutates jobSpec in-place:
 *   jobSpec.templateId                       — resolved template key
 *   jobSpec.state.templateSelection          — { templateId, reason, source, selectedAt }
 */

const VALID_TEMPLATES = ['short-form', 'long-form'];

const CT_DEFAULTS = {
  clips:          'short-form',
  news:           'long-form',
  sports:         'long-form',
  show_commentary:'long-form',
  custom:         'short-form',
};

/**
 * Select the best production template for this job.
 * Writes jobSpec.templateId and jobSpec.state.templateSelection.
 *
 * @param {object} jobSpec  — mutated in-place
 * @returns {Promise<string>}  — resolved templateId
 */
async function selectTemplateForJob(jobSpec) {
  if (!jobSpec) return 'short-form';

  if (!jobSpec.state) jobSpec.state = {};
  const jobId = jobSpec.jobId || 'unknown';

  // ── 1. Brand-level override ───────────────────────────────────────────────
  const brandTemplate = jobSpec.brandConfig?.preferredTemplate
    || jobSpec.designSpec?.templateId
    || null;

  if (brandTemplate && VALID_TEMPLATES.includes(brandTemplate)) {
    _persist(jobSpec, brandTemplate, 'brand_override', `Brand config specifies ${brandTemplate}`);
    console.log(`[template_selector] ${jobId}: brand override → ${brandTemplate}`);
    return brandTemplate;
  }

  // If templateId already set by caller, honour it
  if (jobSpec.templateId && VALID_TEMPLATES.includes(jobSpec.templateId)) {
    _persist(jobSpec, jobSpec.templateId, 'caller_set', 'templateId already set in job spec');
    return jobSpec.templateId;
  }

  // ── 2. Gemini Flash inference ─────────────────────────────────────────────
  try {
    const templateId = await _selectWithGemini(jobSpec, jobId);
    if (templateId) return templateId;
  } catch (err) {
    console.warn(`[template_selector] ${jobId}: Gemini failed (${err.message}) — using heuristic`);
  }

  // ── 3. Content-type heuristic fallback ────────────────────────────────────
  const contentType = (jobSpec.contentType || '').toLowerCase();
  const fallback    = CT_DEFAULTS[contentType] || 'short-form';
  _persist(jobSpec, fallback, 'ct_heuristic', `content type "${contentType}" maps to ${fallback}`);
  console.log(`[template_selector] ${jobId}: heuristic → ${fallback}`);
  return fallback;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _selectWithGemini(jobSpec, jobId) {
  const { callGemini } = require('./gemini');

  const contentType  = jobSpec.contentType || 'clips';
  const format       = jobSpec.format       || '';
  const clipManifest = jobSpec.state?.clipManifest;
  const clipCount    = clipManifest?.clips?.length ?? (jobSpec.orderedClipUrls?.length ?? 0);
  const totalDurS    = (jobSpec.orderedClipUrls || [])
    .reduce((sum, c) => sum + (c.duration || 30), 0);
  const platform     = (jobSpec.platforms || jobSpec.order?.publish?.platforms || ['youtube'])[0];
  const brandName    = jobSpec.brandConfig?.name || jobSpec.designSpec?.showTitle || '';

  const prompt = `You are a video production supervisor selecting a production template for a short-form content platform.

AVAILABLE TEMPLATES:
- short-form: Vertical 9:16 reel, ≤3 minutes, optimized for TikTok/Instagram/YouTube Shorts. Best for clips, gaming highlights, single punchy moments.
- long-form: Horizontal 16:9 broadcast, 5–30 minutes, optimized for YouTube long-form. Best for multi-segment compilations, VODs, news/sports recaps.

JOB DETAILS:
- Content type: ${contentType}
- Format hint: ${format || 'none'}
- Clip count: ${clipCount}
- Total assembled duration estimate: ${Math.round(totalDurS)}s
- Platform target: ${platform}
- Brand: ${brandName || 'unknown'}

Select the best template. Respond ONLY with valid JSON:
{ "templateId": "short-form" | "long-form", "reason": "<1 sentence>" }`;

  const raw    = await callGemini(prompt, { maxOutputTokens: 200, temperature: 0.1 });
  const clean  = raw.replace(/```[a-z]*\n?/gi, '').trim();
  const parsed = JSON.parse(clean);

  if (!parsed?.templateId || !VALID_TEMPLATES.includes(parsed.templateId)) return null;

  _persist(jobSpec, parsed.templateId, 'gemini', parsed.reason || '');
  console.log(`[template_selector] ${jobId}: Gemini → ${parsed.templateId} (${parsed.reason})`);
  return parsed.templateId;
}

function _persist(jobSpec, templateId, source, reason) {
  jobSpec.templateId = templateId;
  jobSpec.state.templateSelection = {
    templateId,
    source,
    reason,
    selectedAt: new Date().toISOString(),
  };
}

module.exports = { selectTemplateForJob };
