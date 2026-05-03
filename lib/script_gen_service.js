'use strict';
/**
 * script_gen_service.js — C1 API script generation service
 *
 * Generates a filledScript from a C1 job spec (URL-based inputs, no C0 scraping).
 * This is the AuraFlux Copilot pipeline for v1 API jobs — it analyzes the
 * customer's source content with Gemini and generates a ready-to-QA script.
 *
 * Distinct from lib/script_gen.js:handleGenerateFullScript which is C0-only
 * (ClipzWorld News — AJ video pool, news article scraping, per-show templates).
 *
 * Called by developer_api.js before runPortalSequence so Portal 1 has a filledScript.
 */

const { geminiAnalyzeClip, geminiScriptGeneration } = require('./script_gen');

/**
 * Generate a script for a C1 API job.
 *
 * @param {object} jobSpec - fully formed job spec from createJobSpec()
 * @returns {Promise<{ filledScript: string, orderedClipUrls: Array }>}
 */
async function generateJobScript(jobSpec) {
  const contentType = jobSpec.contentType || 'news';
  const topic       = jobSpec.order?.topic || 'Content Update';
  const tone        = jobSpec.order?.tone  || 'professional';
  const formType    = jobSpec.order?.formType || (contentType.includes('-short') ? 'short' : 'long');

  const urls = _extractSourceUrls(jobSpec);

  let analyses;
  let orderedClipUrls;

  if (urls.length) {
    console.log(`[script_gen_service] Generating ${contentType} script: topic="${topic}", tone="${tone}", clips=${urls.length}`);

    // ── Step 1: Analyze each source clip with Gemini ──────────────────────
    analyses = await Promise.all(
      urls.map(async (url, i) => {
        try {
          const analysis = await geminiAnalyzeClip(url, null, contentType, {
            title: topic,
            index: i,
            storyIndex: i,
          });
          return { url, index: i, analysis: analysis || `Video clip ${i + 1} for "${topic}"` };
        } catch (err) {
          console.warn(`[script_gen_service] Gemini analysis failed for clip ${i}: ${err.message}`);
          return { url, index: i, analysis: `Video clip ${i + 1} for "${topic}"` };
        }
      })
    );

    // ── Step 2: Build ordered clip URL list for downstream portals ──────────
    orderedClipUrls = analyses.map((a, i) => ({
      url:              a.url,
      clipUrl:          a.url,
      storyIndex:       i,
      pageUrl:          '',
      clipTimingTargets: [],
      clipTimingFormat: 'none',
    }));
  } else {
    // Topic-only mode: no source clips provided. Generate script from topic
    // directly (WAN / scheduled video gen jobs where clips don't exist yet).
    console.log(`[script_gen_service] Topic-only mode: topic="${topic}", tone="${tone}", contentType=${contentType}`);
    analyses      = [{ url: null, index: 0, analysis: `Topic-driven content about: "${topic}"` }];
    orderedClipUrls = [];
  }

  // ── Step 3: Build script generation prompts ──────────────────────────────
  const analysisBlock = analyses
    .map((a, i) => `CLIP ${i + 1}:\n${a.analysis}`)
    .join('\n\n');

  const clipCount    = Math.max(urls.length, 1);
  const systemPrompt = _buildSystemPrompt({ contentType, tone, formType });
  const userPrompt   = _buildUserPrompt({ topic, tone, contentType, formType, analyses: analysisBlock, clipCount, topicOnly: urls.length === 0 });

  // ── Step 4: Call Gemini to generate the script ───────────────────────────
  const genResult    = await geminiScriptGeneration(userPrompt, systemPrompt, { contentType });
  const filledScript = genResult.script || genResult;

  if (!filledScript || typeof filledScript !== 'string' || filledScript.length < 50) {
    throw new Error('[script_gen_service] Gemini returned empty or unusable script');
  }

  console.log(`[script_gen_service] ✅ Script generated (${filledScript.length} chars)`);
  return { filledScript, orderedClipUrls };
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _extractSourceUrls(jobSpec) {
  // Priority 1: sourceConfig.urls (url_list source type)
  const cfgUrls = (jobSpec.sourceConfig?.urls || []).filter(Boolean);
  if (cfgUrls.length) return cfgUrls;

  // Priority 2: order.inputs.items[*].url
  const itemUrls = (jobSpec.order?.inputs?.items || [])
    .map((item) => item.url || item.videoUrl || item.clipUrl)
    .filter(Boolean);
  if (itemUrls.length) return itemUrls;

  // Priority 3: order.inputs.url (single-URL fetch entry)
  const singleUrl = jobSpec.order?.inputs?.url;
  if (singleUrl) return [singleUrl];

  return [];
}

function _buildSystemPrompt({ contentType, tone, formType }) {
  const isShort = formType === 'short' || contentType.includes('-short');

  return `You are a professional video script writer for ${contentType} content.

TONE: ${tone}
FORMAT: ${isShort ? 'short-form (60-90 seconds)' : 'long-form (2-5 minutes)'}

SCRIPT FORMAT RULES (follow exactly):
1. Use === SECTION_NAME === headers (ALL_CAPS, underscores, no spaces)
2. Write ACTUAL DIALOGUE under each header — never write [DIALOGUE] placeholders
3. Required sections in order:
   - === INTRO === (compelling hook, 1-2 sentences)
   - === STORY1_CLIP === for each source clip (narration matching the clip)
   - === OUTRO === (strong close with call-to-action)
4. Each section should have 1-3 sentences of natural spoken dialogue
5. DO NOT include stage directions, cues, or markdown formatting
6. DO NOT use placeholder text like [DIALOGUE] or [INSERT HERE]

EXAMPLE FORMAT:
=== INTRO ===
Welcome to tonight's update on breaking developments in the tech world.

=== STORY1_CLIP ===
Earlier today, major announcements reshaped the industry landscape in ways no one predicted.

=== OUTRO ===
That wraps our coverage — subscribe for more updates as this story develops.`;
}

function _buildUserPrompt({ topic, tone, contentType, formType, analyses, clipCount, topicOnly }) {
  const isShort = formType === 'short' || contentType.includes('-short');
  const sectionCount = topicOnly ? (isShort ? 2 : 4) : clipCount;
  const sectionNames = Array.from({ length: sectionCount }, (_, i) => `STORY${i + 1}_CLIP`).join(', ');

  if (topicOnly) {
    return `Write a complete ${tone} ${contentType} script about: "${topic}"

No source video clips are available — generate a self-contained script based entirely on the topic.

INSTRUCTIONS:
- Write an INTRO section with a compelling hook about "${topic}"
- Write ${sectionCount} body sections (${sectionNames}) with substantive narration about the topic
- Write an OUTRO with a strong close and call-to-action
- Keep total spoken time ${isShort ? 'under 90 seconds' : '2-4 minutes'}
- Use ${tone} language appropriate for ${contentType} content
- Sound like a polished broadcast narrator

Produce the complete script now using the === SECTION === format described.`;
  }

  return `Write a complete ${tone} ${contentType} script about: "${topic}"

You have ${clipCount} source video clip(s). Here is the Gemini analysis of each clip:

${analyses}

INSTRUCTIONS:
- Write an INTRO section with a compelling hook about "${topic}"
- Write one section for each clip (${sectionNames}) with narration that matches what was analyzed
- Write an OUTRO with a strong close
- Keep total spoken time ${isShort ? 'under 90 seconds' : '2-4 minutes'}
- Use ${tone} language appropriate for ${contentType} content
- Sound like a polished broadcast narrator, not a description of video

Produce the complete script now using the === SECTION === format described.`;
}

module.exports = { generateJobScript };
