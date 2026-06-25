'use strict';
/**
 * lib/clip_hook_machine.js — Gemini Hook Machine (CPD-1085+ / Shorts framework)
 * Structured candidates: text + formula + psychologyTrigger + visualCue + payoffTease
 */

const axios = require('axios');
const { parseJsonLoose } = require('./gemini_json_parse');
const { buildPlaybookPromptBlock, loadHookPlaybook } = require('./hook_training/playbook');
const { buildChannelVoiceBlock, loadChannelVoice } = require('./hook_training/channel_voice');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const DEFAULT_EXAMPLES_PATH = require('path').join(__dirname, '../config/clip_hook_examples.json');
const fs = require('fs');

const ALLOWED_FORMULAS = [
  'Curiosity Gap',
  'Counter-Intuitive Reversal',
  'Specific Number/Fact',
  'Contrarian',
  'Fortune Teller',
  'Result Preview',
  'Context Lean',
  'Pattern Interrupt',
  'FOMO',
  'Cognitive Dissonance',
];

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

function normalizeCandidate(raw = {}) {
  return {
    text: String(raw.text || raw.hook || '').trim(),
    rank: Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : null,
    tensionScore: Number.isFinite(Number(raw.tensionScore)) ? Number(raw.tensionScore) : null,
    why: String(raw.why || '').trim(),
    formula: String(raw.formula || raw.formulaName || '').trim(),
    psychologyTrigger: String(raw.psychologyTrigger || raw.trigger || raw.formula || '').trim(),
    visualCue: String(raw.visualCue || raw.visual || '').trim(),
    payoffTease: String(raw.payoffTease || raw.payoff || '').trim(),
    selected: !!raw.selected,
    qaScore: Number.isFinite(Number(raw.qaScore)) ? Number(raw.qaScore) : null,
    qaPassed: raw.qaPassed === true,
  };
}

function buildExamplesBlock({ examples = [], patterns = [] } = {}) {
  const voice = loadChannelVoice();
  const merged = [
    ...voice.approvedExamples.map((ex) => ({ hook: ex.hook, why: ex.why || ex.formula })),
    ...examples,
  ];
  const patternLines = patterns.map((p) => `- ${p}`).join('\n');
  const exampleLines = merged
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
  const formulaList = ALLOWED_FORMULAS.join(', ');

  return `${buildChannelVoiceBlock()}

${buildExamplesBlock({ examples, patterns })}

${buildPlaybookPromptBlock(loadHookPlaybook())}

SHORTS HOOK RULES (every candidate MUST obey):
- Length: ${maxW} words maximum (${targetW} words or fewer ideal — readable in under 3 seconds on screen)
- Burned TEXT overlay on the clip — conversational, staccato, mute-first
- Curiosity gap: tease SETUP only — do NOT give away punchline, goal, win, or full joke
- No streamer name, login, or "Name:" prefix
- Do NOT copy or paraphrase the platform clip title
- TV-clean: no profanity, slurs, or sexual terms
- MUST anchor to a concrete noun/action/quote from the observation
- Each of the ${n} candidates MUST use a DIFFERENT formula from: ${formulaList}
- Avoid clichés: Stop scrolling, Hey guys, Pure Chaos, That Escalated Fast, Then the goal

CLIP CONTEXT:
Streamer (context only — never in hook text): ${ctx.streamer || 'unknown'}
Platform title (DO NOT COPY): "${ctx.title || ''}"
Observation (visual + audio beat — seconds 0-3):
${String(observation || '').slice(0, 900)}
${fixHint}
YOUR TASK:
Generate exactly ${n} burned-in on-screen hook options for YouTube Shorts seconds 0-3.

For EACH hook return:
- text: the burned line (${targetW}-${maxW} words)
- formula: one of [${formulaList}]
- psychologyTrigger: same as formula or finer label (curiosity, FOMO, cognitive dissonance, etc.)
- visualCue: one line — what the viewer SEES on screen at 0-3s that the text reinforces (zoom, reaction face, prop, scoreboard, etc.)
- payoffTease: one short phrase — what the viewer gets if they keep watching (NOT the spoiler)
- rank, tensionScore, why

Rank by 3-SECOND RULE: best scroll-stop if viewer only reads text for 3 seconds.

Return ONLY valid JSON (no markdown):
{"hooks":[{"text":"Hook line","formula":"Curiosity Gap","psychologyTrigger":"curiosity","visualCue":"Close on hands ripping shirt","payoffTease":"See why chat exploded","rank":1,"tensionScore":95,"why":"..."}]}

All ${n} hooks must be distinct formulas and distinct text. rank=1 is BEST.`;
}

function parseHookMachineResponse(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) return [];
  const hooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
  return hooks.map(normalizeCandidate).filter((h) => h.text);
}

function candidatesHaveFormulaDiversity(candidates, minDistinct = 3) {
  if (!candidates.length) return false;
  const keys = new Set();
  for (const c of candidates) {
    const key = (c.formula || c.psychologyTrigger || c.text.split(/\s+/)[0] || '').toLowerCase();
    if (key) keys.add(key);
  }
  const need = Math.min(minDistinct, candidates.length);
  return keys.size >= need;
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

function sortHookCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const rankA = Number.isFinite(a.rank) ? a.rank : 99;
    const rankB = Number.isFinite(b.rank) ? b.rank : 99;
    if (rankA !== rankB) return rankA - rankB;
    const tA = Number.isFinite(a.tensionScore) ? a.tensionScore : 0;
    const tB = Number.isFinite(b.tensionScore) ? b.tensionScore : 0;
    if (tB !== tA) return tB - tA;
    if (a.qaPassed && !b.qaPassed) return -1;
    if (b.qaPassed && !a.qaPassed) return 1;
    const qA = Number.isFinite(a.qaScore) ? a.qaScore : 0;
    const qB = Number.isFinite(b.qaScore) ? b.qaScore : 0;
    if (qB !== qA) return qB - qA;
    return localHookScore(b.text) - localHookScore(a.text);
  });
}

async function fetchGeminiHookMachineRaw(prompt) {
  if (!GEMINI_APIKEY) return '';
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.35 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 55000 },
  );
  return (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

async function generateHookCandidates(ctx, observation, { fixDirective = null, count = null, log = null } = {}) {
  const prompt = buildHookMachinePrompt(ctx, observation, { fixDirective, count });
  let raw = await fetchGeminiHookMachineRaw(prompt);
  let parsed = parseHookMachineResponse(raw);

  if (!parsed.length) {
    if (log) log(`  ⚠️ Hook Machine JSON parse failed — retrying (raw: ${raw.slice(0, 72).replace(/\s+/g, ' ')}…)`);
    const retryPrompt = `${prompt}\n\nCRITICAL: Return ONLY minified valid JSON. No markdown fences, no commentary.`;
    raw = await fetchGeminiHookMachineRaw(retryPrompt);
    parsed = parseHookMachineResponse(raw);
  }

  if (parsed.length >= 3 && !candidatesHaveFormulaDiversity(parsed, 3)) {
    if (log) log('  ⚠️ Hook Machine — low formula diversity — retrying with distinct formulas required');
    const diversityPrompt = `${prompt}\n\nCRITICAL: Each hook MUST use a DIFFERENT formula name. Previous batch repeated the same pattern.`;
    raw = await fetchGeminiHookMachineRaw(diversityPrompt);
    const retryParsed = parseHookMachineResponse(raw);
    if (retryParsed.length) parsed = retryParsed;
  }

  return {
    candidates: sortHookCandidates(parsed),
    rawCount: parsed.length,
    parseFailed: parsed.length === 0 && !!raw,
  };
}

function pickFirstUsableCandidate(candidates, isUsable) {
  for (const c of sortHookCandidates(candidates)) {
    if (isUsable(c.text)) return c;
  }
  return null;
}

module.exports = {
  ALLOWED_FORMULAS,
  loadHookExamples,
  loadHookPlaybook,
  loadChannelVoice,
  buildChannelVoiceBlock,
  buildHookMachinePrompt,
  buildExamplesBlock,
  parseHookMachineResponse,
  normalizeCandidate,
  candidatesHaveFormulaDiversity,
  generateHookCandidates,
  sortHookCandidates,
  pickFirstUsableCandidate,
  hookCandidateCount,
  hookMaxWords,
  hookTargetWords,
  hookWordCount,
  localHookScore,
  fetchGeminiHookMachineRaw,
};
