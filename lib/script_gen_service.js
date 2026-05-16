'use strict';
/**
 * script_gen_service.js — C1 API script generation service
 *
 * Generates a filledScript from a C1 job spec (URL-based inputs, no C0 scraping).
 * This is the AuraFlux Collab pipeline for v1 API jobs — it analyzes the
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
    // CPD-233: Extract per-clip metadata from job spec items so the Gemini analysis
    // prompt has a meaningful clip title/streamer instead of just the job topic.
    const sourceItems = (
      jobSpec.sourceConfig?.urls?.length
        ? jobSpec.sourceConfig.urls.map((u) => ({ url: u }))
        : jobSpec.order?.inputs?.items || []
    );
    analyses = await Promise.all(
      urls.map(async (url, i) => {
        try {
          const item = sourceItems[i] || {};
          const analysis = await geminiAnalyzeClip(url, null, contentType, {
            title: item.clipTitle || item.title || topic,
            streamer: item.streamer || jobSpec.order?.streamer || '',
            game: item.game || item.gameName || '',
            pageUrl: item.pageUrl || '',
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

  // CPD-246: inject verified clip descriptions (from Twitch popular-clip titles) so Gemini
  // cannot hallucinate content that isn't visible in the extracted clips.
  const groundingBlock = Array.isArray(jobSpec.extractedClipDescriptions) && jobSpec.extractedClipDescriptions.length
    ? `\nVERIFIED CLIP CONTENT (TWITCH VIEWER DATA — DO NOT CONTRADICT THESE FACTS):\n${jobSpec.extractedClipDescriptions.join('\n')}\n`
    : null;

  const clipCount    = Math.max(urls.length, 1);
  const systemPrompt = _buildSystemPrompt({ contentType, tone, formType, clipCount });
  const userPrompt   = _buildUserPrompt({ topic, tone, contentType, formType, analyses: analysisBlock,
    clipCount, topicOnly: urls.length === 0, groundingBlock });

  // ── Step 4: Call Gemini to generate the script ───────────────────────────
  // Pass form-qualified content type so geminiScriptGeneration uses the correct
  // token budget: 'clips-short' → 4k tokens (fast), 'clips' → 16k tokens (slow).
  const geminiContentType = formType === 'short' ? `${contentType}-short` : contentType;
  const genResult    = await geminiScriptGeneration(userPrompt, systemPrompt, { contentType: geminiContentType });
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

function _buildSystemPrompt({ contentType, tone, formType, clipCount = 1 }) {
  const isShort = formType === 'short' || contentType.includes('-short');
  const isCommentary = contentType === 'show_commentary' || contentType.includes('commentary');
  const isSingleClipEnhance = clipCount === 1 && !isCommentary;

  const transitionNote = isCommentary
    ? `
7. For show_commentary with multiple clips: include a === TRANSITION_N === section between
   each STORY_CLIP pair. Transition narration bridges from one clip to the next
   (e.g. "Coming up next...", "That leads us to..."). This keeps the narrator
   audible throughout the full assembled video, not just over the first clip.`
    : '';

  // CPD-216: For single-clip ENHANCE jobs, script must be faithful to the clip analysis.
  // Hallucinating events ("hilarious twist", "incredible comeback") not visible in the clip
  // is a quality failure — the viewer hears about things they cannot see.
  const fidelityNote = isSingleClipEnhance
    ? `
7. CLIP FIDELITY (critical for ENHANCE jobs): This is a single-clip enhancement.
   The script MUST describe only what is visible in the clip analysis provided.
   DO NOT add events, reactions, outcomes, or emotions that are not mentioned in the analysis.
   Energetic commentary is welcome; fictional embellishment is not.
   If the analysis shows a clutch moment, describe that moment. Do not invent a "twist" or
   "comeback" unless the analysis explicitly mentions one.`
    : '';

  return `You are a professional video script writer for ${contentType} content.

TONE: ${tone}
FORMAT: ${isShort ? 'short-form (60-90 seconds)' : 'long-form (2-5 minutes)'}

SCRIPT FORMAT RULES (follow exactly):
1. Use === SECTION_NAME === headers (ALL_CAPS, underscores, no spaces)
2. Write ACTUAL DIALOGUE under each header — never write [DIALOGUE] placeholders
3. Required sections in order:
   - === INTRO === (compelling hook, 1-2 sentences)
   - === STORY1_CLIP === for each source clip (narration matching the clip)
   - For show_commentary multi-clip: === TRANSITION_1 === between STORY1 and STORY2, etc.
   - === OUTRO === (strong close with call-to-action)
4. Each section should have 1-3 sentences of natural spoken dialogue
5. DO NOT include stage directions, cues, or markdown formatting
6. DO NOT use placeholder text like [DIALOGUE] or [INSERT HERE]${transitionNote}${fidelityNote}

EXAMPLE FORMAT:
=== INTRO ===
Welcome to tonight's update on breaking developments in the tech world.

=== STORY1_CLIP ===
Earlier today, major announcements reshaped the industry landscape in ways no one predicted.

=== OUTRO ===
That wraps our coverage — subscribe for more updates as this story develops.`;
}

function _buildUserPrompt({ topic, tone, contentType, formType, analyses, clipCount, topicOnly, groundingBlock }) {
  const isShort = formType === 'short' || contentType.includes('-short');
  const isCommentary = contentType === 'show_commentary' || contentType.includes('commentary');
  const sectionCount = topicOnly ? (isShort ? 2 : 4) : clipCount;

  // For show_commentary multi-clip: interleave TRANSITION_N sections between STORY sections
  // so the script bridges all clips and the TTS audio spans the full assembled video.
  let sectionNames;
  if (isCommentary && sectionCount > 1) {
    const parts = [];
    for (let i = 1; i <= sectionCount; i++) {
      parts.push(`STORY${i}_CLIP`);
      if (i < sectionCount) parts.push(`TRANSITION_${i}`);
    }
    sectionNames = parts.join(', ');
  } else {
    sectionNames = Array.from({ length: sectionCount }, (_, i) => `STORY${i + 1}_CLIP`).join(', ');
  }

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

  const transitionInstruction = (isCommentary && clipCount > 1)
    ? `- Include TRANSITION_N sections between each STORY_CLIP pair. Each transition must bridge\n  from the previous clip to the next one (1-2 sentences, e.g. "Next up...", "From there...").\n  This ensures narration continues throughout the full video, not just the first clip.`
    : '';

  const groundingSection = groundingBlock
    ? `\nGROUNDING DATA — FACTS VERIFIED BY TWITCH VIEWER ENGAGEMENT:\n${groundingBlock}\nCRITICAL: Your narration MUST be consistent with the above verified clip data.\nDO NOT invent physics glitches, game moments, or events not supported by the analysis or grounding data.\n`
    : '';

  return `Write a complete ${tone} ${contentType} script about: "${topic}"

You have ${clipCount} source video clip(s). Here is the Gemini analysis of each clip:

${analyses}
${groundingSection}
INSTRUCTIONS:
- Write an INTRO section with a compelling hook about "${topic}"
- Write one section for each clip (${sectionNames}) with narration that matches what was analyzed
${transitionInstruction}
- Write an OUTRO with a strong close
- Keep total spoken time ${isShort ? 'under 90 seconds' : '2-4 minutes'}
- Use ${tone} language appropriate for ${contentType} content
- Sound like a polished broadcast narrator, not a description of video
- STRICTLY: Only reference events and moments that appear in the Gemini analysis or grounding data above

Produce the complete script now using the === SECTION === format described.`;
}

module.exports = { generateJobScript };
