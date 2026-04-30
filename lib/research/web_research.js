'use strict';
/**
 * lib/research/web_research.js — Web research pre-processor (C1+ only, dwy+)
 *
 * Accepts a topic/query, runs a Gemini call with Google Search grounding,
 * and returns a structured research brief stored in jobSpec.order.inputs.researchBrief
 * for consumption by the portal script-generation step.
 *
 * Feature gate: portal.web_research (min_plan: dwy)
 * Env dep: GEMINI_API_KEY
 * Intercept point: before portal sequence (pre-portal, entry: 'research')
 */

const axios = require('axios');
const { logError, withRetry } = require('../error_logger');
const { isFeatureEnabled } = require('../services/feature_gate');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const RESEARCH_MODEL = process.env.RESEARCH_GEMINI_MODEL || 'gemini-2.0-flash';
const RESEARCH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SOURCES = 5;

/**
 * Run web research for a query and return a structured brief.
 *
 * @param {object} opts
 * @param {string} opts.query        - Topic or research question
 * @param {'standard'|'deep'} opts.depth - Research depth (default: standard)
 * @param {number} opts.maxSources   - Max sources to cite (default: 5, cap: 10)
 * @param {string} opts.planTier     - Customer plan tier for feature gate check
 * @returns {Promise<{skipped: boolean, researchBrief: object|null, reason?: string}>}
 */
async function runResearch({
  query,
  depth = 'standard',
  maxSources = DEFAULT_MAX_SOURCES,
  planTier = 'dwy',
} = {}) {
  if (!isFeatureEnabled('portal.web_research', planTier)) {
    return { skipped: true, reason: 'feature_not_enabled', researchBrief: null };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { skipped: true, reason: 'GEMINI_API_KEY_not_set', researchBrief: null };
  }

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('[web_research] query is required and must be a non-empty string');
  }

  const cappedSources = Math.min(Math.max(1, maxSources), 10);
  const prompt = buildResearchPrompt(query.trim(), depth, cappedSources);

  try {
    const text = await callGeminiWithSearch(prompt, apiKey);
    const researchBrief = parseResearchBrief(text, query.trim());
    console.log(
      `[web_research] ✅ Brief generated for "${query.slice(0, 60)}" — ` +
        `${researchBrief.keyAngles.length} angles, ${researchBrief.sources.length} sources`
    );
    return { skipped: false, researchBrief, model: RESEARCH_MODEL };
  } catch (err) {
    logError('WEB_RESEARCH_FAILED', err, { query: query.slice(0, 100), depth });
    // Fail gracefully — pipeline continues without research context
    return { skipped: true, reason: 'search_failed', error: err.message, researchBrief: null };
  }
}

/**
 * Build the Gemini prompt for structured research output.
 * Exported for unit tests.
 */
function buildResearchPrompt(query, depth, maxSources) {
  const depthInstruction =
    depth === 'deep'
      ? 'Provide comprehensive analysis with multiple perspectives and detailed supporting facts.'
      : 'Focus on the most important angles and key facts. Be concise.';

  return `You are a research assistant. Use your web search capability to research the following topic and return a structured JSON brief.

TOPIC: ${query}
INSTRUCTION: ${depthInstruction}
SOURCES: Cite up to ${maxSources} sources.

Return ONLY a valid JSON object with this exact structure (no markdown fencing):
{
  "topic": "normalized topic title",
  "summary": "2-3 sentence overview of the topic",
  "keyAngles": ["angle or perspective 1", "angle 2", "angle 3"],
  "supportingFacts": ["specific fact 1", "specific fact 2", "specific fact 3"],
  "competitorCoverage": ["how major outlets are covering this topic"],
  "suggestedScriptHooks": ["compelling opening hook 1", "hook 2"],
  "sources": [{ "title": "article title", "url": "https://...", "snippet": "relevant excerpt" }]
}`;
}

/**
 * Call Gemini generateContent with Google Search grounding enabled.
 * Exported for unit tests (can be mocked).
 */
async function callGeminiWithSearch(prompt, apiKey) {
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.2,
    },
  };

  const data = await withRetry(
    async () => {
      const response = await axios.post(
        `${GEMINI_BASE_URL}/v1beta/models/${RESEARCH_MODEL}:generateContent?key=${apiKey}`,
        requestBody,
        { headers: { 'Content-Type': 'application/json' }, timeout: RESEARCH_TIMEOUT_MS }
      );
      return response.data;
    },
    { label: 'WEB_RESEARCH_GEMINI', retries: 2, baseMs: 3000 }
  );

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini returned empty response for research query');
  return text;
}

/**
 * Parse Gemini's response into a validated research brief.
 * Exported for unit tests.
 */
function parseResearchBrief(text, originalQuery) {
  try {
    const clean = text.replace(/^```(?:json)?\n?/im, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(clean);
    return {
      topic: typeof parsed.topic === 'string' ? parsed.topic : originalQuery,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      keyAngles: Array.isArray(parsed.keyAngles) ? parsed.keyAngles.slice(0, 10) : [],
      supportingFacts: Array.isArray(parsed.supportingFacts) ? parsed.supportingFacts.slice(0, 10) : [],
      competitorCoverage: Array.isArray(parsed.competitorCoverage) ? parsed.competitorCoverage.slice(0, 5) : [],
      suggestedScriptHooks: Array.isArray(parsed.suggestedScriptHooks) ? parsed.suggestedScriptHooks.slice(0, 5) : [],
      sources: Array.isArray(parsed.sources)
        ? parsed.sources.slice(0, 10).map((s) => ({
            title: s.title || '',
            url: s.url || '',
            snippet: s.snippet || '',
          }))
        : [],
      generatedAt: new Date().toISOString(),
    };
  } catch (_parseErr) {
    // Non-JSON response — wrap as minimal brief so pipeline can continue
    return {
      topic: originalQuery,
      summary: text.slice(0, 500),
      keyAngles: [],
      supportingFacts: [],
      competitorCoverage: [],
      suggestedScriptHooks: [],
      sources: [],
      generatedAt: new Date().toISOString(),
      rawText: text.slice(0, 2000),
    };
  }
}

module.exports = { runResearch, buildResearchPrompt, callGeminiWithSearch, parseResearchBrief };
