'use strict';
/**
 * lib/clip_hook_machine.js — Gemini Hook Machine (CPD-1085+)
 * Few-shot examples + 5 candidates + self-rank by 3-second scroll-stop rule.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const DEFAULT_EXAMPLES_PATH = path.join(__dirname, '../config/clip_hook_examples.json');

function hookCandidateCount() {
  const n = Number(process.env.CLIP_HOOK_CANDIDATE_COUNT || 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(3, Math.min(8, Math.floor(n)));
}

function hookMaxWords() {
  const n = Number(process.env.CLIP_HOOK_MAX_WORDS || 12);
  if (!Number.isFinite(n)) return 12;
  return Math.max(5, Math.min(14, Math.floor(n)));
}

function hookTargetWords() {
  const n = Number(process.env.CLIP_HOOK_TARGET_WORDS || 7);
  if (!Number.isFinite(n)) return 7;
  return Math.max(4, Math.min(hookMaxWords(), Math.floor(n)));
}

function loadHookExamples(examplesPath = process.env.CLIP_HOOK_EXAMPLES_PATH || DEFAULT_EXAMPLES_PATH) {
  try {
    const raw = fs.readFileSync(examplesPath, 'utf8');
    const parsed = JSON.parse(raw);
    const examples = Array.isArray(parsed.examples) ? parsed.examples : [];
    const patterns = Array.isArray(parsed.patterns) ? parsed.patterns : [];
    return { examples, patterns };
  } catch (_) {
    return {
      examples: [
        { hook: 'Wrong Shirt Gift', why: 'Specific beat; curiosity gap' },
        { hook: 'Miami Food Meltdown', why: 'Place + disaster tease' },
      ],
      patterns: ['Curiosity gap — no punchline spoil', '≤7 words ideal'],
    };
  }
}

function hookWordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function buildExamplesBlock({ examples = [], patterns = [] } = {}) {
  const patternLines = patterns.map((p) => `- ${p}`).join('\n');
  const exampleLines = examples
    .slice(0, 10)
    .map((ex, i) => `${i + 1}. "${ex.hook}" — ${ex.why || 'strong scroll-stop'}`)
    .join('\n');
  return `PATTERN RULES (learn from these):
${patternLines || '- Curiosity gap, pattern interrupt, ≤7 words ideal'}

TOP-PERFORMING HOOKS IN THIS NICHE (match this energy, not these exact words):
${exampleLines || '1. "Wrong Shirt Gift" — specific embarrassment beat'}`;
}

function buildHookMachinePrompt(ctx, observation, { fixDirective = null, count = null } = {}) {
  const n = count || hookCandidateCount();
  const maxW = hookMaxWords();
  const targetW = hookTargetWords();
  const { examples, patterns } = loadHookExamples();
  const fixHint = fixDirective
    ? `\nPREVIOUS ATTEMPT REJECTED — fix: ${fixDirective}\n`
    : '';

  return `Act as a viral short-form video editor for a Twitch reaction compilation YouTube channel.

${buildExamplesBlock({ examples, patterns })}

STREAMER HOOK RULES (every option MUST obey):
- Length: ${maxW} words maximum (${targetW} words or fewer is ideal — spoken in under 3 seconds on screen)
- Tone: high energy, urgent, contrarian — pattern interrupt or shocking tease
- Curiosity gap: do NOT give away the clip punchline, outcome, or full joke in the hook
- Focus: tease the SETUP or emotional beat — viewer must watch the clip to see what happens
- No streamer name, login, or "Name:" prefix
- Do NOT copy or paraphrase the platform clip title
- TV-clean: no profanity, slurs, or sexual terms

CLIP CONTEXT:
Streamer (context only — never in hook text): ${ctx.streamer || 'unknown'}
Platform title (DO NOT COPY): "${ctx.title || ''}"
Observation (visual + audio beat):
${String(observation || '').slice(0, 900)}
${fixHint}
YOUR TASK:
Generate exactly ${n} burned-in on-screen hook options for the first 2 seconds of this clip.

Then rank them by the 3-SECOND RULE: which single line creates the most tension and scroll-stop power if a viewer only reads it for 3 seconds?

Return ONLY valid JSON (no markdown):
{
  "hooks": [
    {"text": "Hook line here", "rank": 1, "tensionScore": 95, "why": "One sentence why it stops the scroll"},
    {"text": "Second option", "rank": 2, "tensionScore": 88, "why": "..."}
  ]
}

rank=1 is BEST. tensionScore 0-100. All ${n} hooks must be distinct.`;
}

function parseHookMachineResponse(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed;
  try {
    parsed = JSON.parse(m[0]);
  } catch (_) {
    return [];
  }
  const hooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
  return hooks
    .map((h) => ({
      text: String(h.text || h.hook || '').trim(),
      rank: Number(h.rank),
      tensionScore: Number(h.tensionScore),
      why: String(h.why || '').trim(),
    }))
    .filter((h) => h.text);
}

function localHookScore(text, { targetWords = hookTargetWords(), maxWords = hookMaxWords() } = {}) {
  const words = hookWordCount(text);
  if (words < 2) return 0;
  let score = 50;
  if (words <= targetWords) score += 25;
  else if (words <= maxWords) score += 10;
  else score -= 30;
  if (words > maxWords) score -= 40;
  if (/\?$/.test(text.trim())) score += 5;
  if (/!/.test(text)) score += 3;
  return Math.max(0, Math.min(100, score));
}

/**
 * Sort candidates: Gemini rank first, then tensionScore, then local word-count score.
 */
function sortHookCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const rankA = Number.isFinite(a.rank) ? a.rank : 99;
    const rankB = Number.isFinite(b.rank) ? b.rank : 99;
    if (rankA !== rankB) return rankA - rankB;
    const tA = Number.isFinite(a.tensionScore) ? a.tensionScore : 0;
    const tB = Number.isFinite(b.tensionScore) ? b.tensionScore : 0;
    if (tB !== tA) return tB - tA;
    return localHookScore(b.text) - localHookScore(a.text);
  });
}

async function callGeminiHookMachine(prompt) {
  if (!GEMINI_APIKEY) return [];
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1200, temperature: 0.35 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 35000 },
  );
  const raw = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return parseHookMachineResponse(raw);
}

/**
 * Generate + rank hook candidates via Gemini Hook Machine.
 * @returns {Promise<{ candidates: Array, rawCount: number }>}
 */
async function generateHookCandidates(ctx, observation, { fixDirective = null, count = null } = {}) {
  const prompt = buildHookMachinePrompt(ctx, observation, { fixDirective, count });
  const parsed = await callGeminiHookMachine(prompt);
  return {
    candidates: sortHookCandidates(parsed),
    rawCount: parsed.length,
  };
}

/**
 * Pick first candidate passing local filter fn (e.g. isJunkHook).
 */
function pickFirstUsableCandidate(candidates, isUsable) {
  for (const c of sortHookCandidates(candidates)) {
    if (isUsable(c.text)) return c;
  }
  return null;
}

module.exports = {
  loadHookExamples,
  buildHookMachinePrompt,
  buildExamplesBlock,
  parseHookMachineResponse,
  generateHookCandidates,
  sortHookCandidates,
  pickFirstUsableCandidate,
  hookCandidateCount,
  hookMaxWords,
  hookTargetWords,
  hookWordCount,
  localHookScore,
};
