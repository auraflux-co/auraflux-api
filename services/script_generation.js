/**
 * Script Generation Service
 * 
 * Handles all script generation logic including:
 * - Gemini script generation with style guides
 * - Claude script QA (Gate 1)
 * - Retry logic with feedback
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Generate script using Gemini with style guide integration
 * @param {string} userPrompt - The generation prompt
 * @param {string} systemPrompt - System instructions
 * @param {Object} options - Generation options
 * @returns {Promise<{ script: string, tokenUsage: Object }>}
 */
async function geminiScriptGeneration(userPrompt, systemPrompt, options = {}) {
  const { previousScript = null, feedbackMsg = '', contentType = 'twitch' } = options;
  const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_APIKEY) throw new Error('GEMINI_APIKEY not configured');

  // Load style guide for this content type
  const STYLE_GUIDE_PATH = path.join(__dirname, '../cwn_style_guides.json');
  let styleGuide = '';
  try {
    const styleGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
    const styleType = contentType.replace('-short', '');
    styleGuide = styleGuides[styleType] || '';
    if (styleGuide) {
      console.log(`[geminiScriptGeneration] Loaded ${styleType} style guide (${styleGuide.length} chars)`);
    }
  } catch(e) {
    console.warn(`[geminiScriptGeneration] Could not load style guide: ${e.message}`);
  }

  // Combine system + user prompts + style guide
  let fullPrompt = `SYSTEM INSTRUCTIONS:
${systemPrompt}`;

  if (styleGuide) {
    fullPrompt += `

STYLE GUIDE (follow this writing style and tone):
${styleGuide}`;
  }

  fullPrompt += `

USER TASK:
${userPrompt}`;

  // If retrying with feedback, append it
  if (previousScript && feedbackMsg) {
    fullPrompt += `

PREVIOUS ATTEMPT (HAD ISSUES):
${previousScript}

FEEDBACK FROM QA REVIEWER:
${feedbackMsg}

Please generate a COMPLETE REVISED script that fixes all the issues listed above.`;
  }

  // Scale maxOutputTokens based on content type
  const isShort = contentType.includes('-short');
  const isTwitch = contentType === 'twitch' || contentType === 'twitch-short';
  let maxOutputTokens;
  if (isShort) {
    maxOutputTokens = 2000;
  } else if (isTwitch) {
    maxOutputTokens = 32000;
  } else {
    maxOutputTokens = 16000;
  }

  try {
    const genResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.7,
          topP: 0.95,
          topK: 40
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );

    const candidate = genResp.data?.candidates?.[0];
    const finishReason = candidate?.finishReason;

    if (finishReason === 'MAX_TOKENS') {
      console.error(`[geminiScriptGeneration] ⚠️ Gemini output TRUNCATED (finishReason=MAX_TOKENS, maxOutputTokens=${maxOutputTokens})`);
      throw new Error(`Gemini output truncated at token limit (${maxOutputTokens} tokens) — script is incomplete`);
    }

    const script = (candidate?.content?.parts || [])
      .map(p => p.text||'')
      .join('')
      .trim();

    if (!script || script.length < 100) {
      throw new Error('Gemini returned empty or too-short script');
    }

    console.log(`[geminiScriptGeneration] ✅ Script complete (finishReason=${finishReason}, length=${script.length} chars)`);
    return { script, tokenUsage: { input: 0, output: 0 } };
  } catch(e) {
    console.error('[geminiScriptGeneration] API call failed:', e.message);
    throw new Error(`Gemini script generation failed: ${e.message}`);
  }
}

/**
 * Claude QA review of Gemini-generated script (Gate 1)
 * @param {string} script - The script to review
 * @param {Array} clipAnalyses - Gemini's clip analyses
 * @param {Object} options - QA options
 * @returns {Promise<Object>} QA results with score, outcome, deductions
 */
async function claudeScriptQA(script, clipAnalyses, options = {}) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 3,
    jobId = 'unknown',
    expectedScenes = 0
  } = options;

  if (!client) return { score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (skipped — no key)', deductions: [] };

  const PASS_THRESHOLD = 90;
  const MANUAL_THRESHOLD = 70;

  // Count markers in script
  const clipMarkers = (script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  const expectedClips = contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length;
  const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1;
  const missingAppreciateYou = !/appreciate you/i.test(script);
  const sceneMarkers = (script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
  const wrongSceneCount = expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build QA prompt (simplified for service layer)
  const qaPrompt = `You are a QA reviewer for ClipzWorld News. Review this ${contentType} script.

Expected: ${expectedClips} [CLIP PLAYS HERE] markers, ${expectedScenes} scenes
Found: ${clipMarkers} markers, ${sceneMarkers} scenes

Check for:
1. Correct scene count
2. Correct clip marker count
3. "Appreciate you!" in outro
4. No placeholder brackets
5. Proper structure

Respond with:
SCORE: [0-100]
ISSUES:
- [list issues or "None"]`;

  let claudeReport = '';
  let tokenUsage = { input: 0, output: 0 };

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0.1,
      messages: [{ role: 'user', content: qaPrompt }]
    });

    claudeReport = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    tokenUsage.input = response.usage?.input_tokens || 0;
    tokenUsage.output = response.usage?.output_tokens || 0;
  } catch(e) {
    claudeReport = `Claude QA call failed: ${e.message}`;
  }

  // Parse score
  const scoreMatch = claudeReport.match(/SCORE:\s*(\d+)/i);
  let parsedScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
  parsedScore = Math.max(0, Math.min(100, parsedScore));

  // Apply hard penalties
  const preCheckDeductions = [];
  let adjustedScore = parsedScore;

  if (wrongSceneCount) {
    preCheckDeductions.push({ points: 25, reason: `SCENE COUNT: Found ${sceneMarkers} scenes, expected ${expectedScenes}` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (wrongClipCount) {
    preCheckDeductions.push({ points: 25, reason: `CLIP COUNT: Found ${clipMarkers} markers, expected ${expectedClips}` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (missingAppreciateYou) {
    preCheckDeductions.push({ points: 15, reason: `OUTRO: "Appreciate you!" missing` });
    adjustedScore = Math.max(0, adjustedScore - 15);
  }

  const hasCriticalFail = wrongSceneCount || wrongClipCount || missingAppreciateYou || adjustedScore < 60;
  let outcome, passed;
  if (hasCriticalFail || adjustedScore < MANUAL_THRESHOLD) {
    outcome = 'fail'; passed = false;
  } else if (adjustedScore >= PASS_THRESHOLD) {
    outcome = 'pass'; passed = true;
  } else {
    outcome = 'manual_review'; passed = false;
  }

  const outcomeLabel = outcome === 'pass' ? '✅ PASS' : outcome === 'manual_review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL';

  return {
    score: adjustedScore,
    passed,
    outcome,
    outcomeLabel,
    deductions: preCheckDeductions,
    claudeReport,
    tokenUsage,
    report: `Gate 1 QA: ${outcomeLabel} (${adjustedScore}/100)\n${claudeReport}`
  };
}

module.exports = {
  geminiScriptGeneration,
  claudeScriptQA
};
