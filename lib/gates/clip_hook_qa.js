'use strict';
/**
 * lib/gates/clip_hook_qa.js — Claude QA for burned clip-comp hooks (1–2 lines per clip).
 * Independent reviewer: Gemini observes/writes; Claude approves before burn.
 */

const { callClaudeAPI } = require('../qa');
const { isVagueCompHook, isObservationComplete } = require('../clip_comp_hooks');
const { buildPlaybookQaChecklist, buildPlaybookPromptBlock, loadHookPlaybook } = require('../hook_training/playbook');

const PASS_THRESHOLD = Number(process.env.CLIP_HOOK_QA_PASS_SCORE || 85);
const MODEL = process.env.CLIP_HOOK_CLAUDE_MODEL || 'claude-sonnet-4-6';

function clipHookClaudeQaEnabled() {
  return process.env.CLIP_HOOK_CLAUDE_QA !== '0' && !!process.env.ANTHROPIC_API_KEY;
}

function parseQaJson(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

function buildClipHookQaPrompt({ observation, hook, platformTitle, streamer }) {
  return `You QA ONE burned-in on-screen hook for a Twitch clip YouTube Short.
This is NOT a full script — only 1 line (2 lines max if absolutely necessary).

OBSERVATION (Gemini watched the clip — visual + audio):
${String(observation || '').slice(0, 900)}

PROPOSED HOOK (burned on video):
${String(hook || '').trim()}

Platform clip title (must NOT be copied): "${platformTitle || ''}"
Streamer (must NOT appear in hook text): ${streamer || 'unknown'}

Checklist — fail if ANY apply:
1. Hook does not match the combined visual+audio beat in the observation
2. Hook is only a verbatim quote when the visual action is the real beat
3. Hook copies or paraphrases the platform clip title
4. Hook includes streamer name, login, or "Name:" prefix
5. Not TV-clean — profanity, slurs, sexual terms (YouTube Shorts / ad-safe)
6. Generic compilation filler ("Wildest Moments", "You Won't Believe", "Chat Goes Wild", "Pure Chaos", "Intense Face", "Sudden Roar" without a concrete noun)
7. Spoils the punchline — hook gives away the full joke or outcome (must be curiosity gap only)
8. Too long for 3-second read — over ${Number(process.env.CLIP_HOOK_MAX_WORDS || 12)} words or >72 chars total
9. Too vague — could describe any clip; must anchor to a concrete object, action, or quoted detail from the observation
10. More than 2 lines on screen
${buildPlaybookQaChecklist(loadHookPlaybook())}

HOOK MASTER REFERENCE (score against this):
${buildPlaybookPromptBlock(loadHookPlaybook(), { maxChars: 1400 })}

Score 0–100. passed=true only if score >= ${PASS_THRESHOLD} and zero blocking violations.

Return ONLY JSON:
{"passed":true,"score":92,"violations":[],"fixDirective":null}

fixDirective when failed: one short sentence telling Gemini how to rewrite the hook (not a full script note).`;
}

/**
 * @returns {Promise<{ passed: boolean, score: number, outcome: string, violations: string[], fixDirective: string|null, skipped?: boolean }>}
 */
async function claudeClipHookQA({
  observation,
  hook,
  platformTitle = '',
  streamer = '',
  clipIndex = 0,
} = {}) {
  if (!clipHookClaudeQaEnabled()) {
    return {
      passed: true,
      score: 100,
      outcome: 'pass',
      violations: [],
      fixDirective: null,
      skipped: true,
    };
  }

  if (!hook || !String(hook).trim()) {
    return {
      passed: false,
      score: 0,
      outcome: 'hard_fail',
      violations: ['empty hook'],
      fixDirective: 'Write a specific 3–8 word moment hook from the observation.',
    };
  }

  if (!isObservationComplete(observation)) {
    return {
      passed: false,
      score: 35,
      outcome: 'hard_fail',
      violations: ['observation incomplete or truncated'],
      fixDirective: 'Observation must be complete before hook QA — rewatch clip for full visual+audio beat.',
    };
  }

  if (isVagueCompHook(hook, observation)) {
    return {
      passed: false,
      score: 45,
      outcome: 'hard_fail',
      violations: ['hook too vague — mood-only template, not anchored to observation'],
      fixDirective: 'Use a concrete object, action, or quoted detail from the observation. No generic chaos/intense/roar filler.',
    };
  }

  try {
    const resp = await callClaudeAPI({
      model: MODEL,
      max_tokens: 512,
      temperature: 0.1,
      messages: [{ role: 'user', content: buildClipHookQaPrompt({ observation, hook, platformTitle, streamer }) }],
    });
    const raw = (resp.content || []).map((p) => p.text || '').join('').trim();
    const parsed = parseQaJson(raw);
    if (!parsed) {
      return {
        passed: true,
        score: 70,
        outcome: 'pass',
        violations: ['claude_parse_fallback'],
        fixDirective: null,
        skipped: false,
      };
    }

    const score = Number(parsed.score);
    const violations = Array.isArray(parsed.violations)
      ? parsed.violations.map((v) => String(v)).filter(Boolean)
      : [];
    const passed = parsed.passed === true
      && (Number.isFinite(score) ? score >= PASS_THRESHOLD : violations.length === 0);

    return {
      passed,
      score: Number.isFinite(score) ? score : (passed ? PASS_THRESHOLD : 40),
      outcome: passed ? 'pass' : (score >= 55 ? 'sendback' : 'hard_fail'),
      violations,
      fixDirective: passed ? null : (parsed.fixDirective ? String(parsed.fixDirective).slice(0, 280) : null),
      skipped: false,
      clipIndex,
    };
  } catch (err) {
    return {
      passed: true,
      score: 70,
      outcome: 'pass',
      violations: [`claude_error:${err.message}`],
      fixDirective: null,
      skipped: true,
    };
  }
}

module.exports = {
  claudeClipHookQA,
  clipHookClaudeQaEnabled,
  buildClipHookQaPrompt,
  PASS_THRESHOLD,
};
