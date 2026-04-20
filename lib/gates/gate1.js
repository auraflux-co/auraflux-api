'use strict';
/**
 * lib/gates/gate1.js — Gate 1: Claude Style QA
 *
 * Runs after scaffold is filled by Gemini. Checks STYLE ONLY — structure is system-guaranteed
 * by the scaffold. Gate 1 does NOT check scene count or structure.
 *
 * Three states: canProduce → commit → run
 *
 * Scoring:
 *   Start: 100
 *   Unfilled [DIALOGUE] slot → -100 (hard fail, stop)
 *   Commentary fabrication → -100 (hard fail, stop)
 *   Wrong entity name → -15 each
 *   Voice style violation → -15 per section
 *   Wrong/missing outro → -15
 *   Prohibited language → -10 each
 *
 * Score → action:
 *   ≥90: pass
 *   70-89: sendback (one attempt, then escalate)
 *   <70: hard fail → escalate immediately
 *
 * Output contract:
 * {
 *   gate: 1,
 *   jobId: string,
 *   passed: boolean,
 *   score: number,
 *   outcome: 'pass' | 'sendback' | 'hard_fail' | 'escalate',
 *   fixDirective: object | null,
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const { callClaudeAPI } = require('../qa');
const { logError } = require('../error_logger');
const { getGateThresholds, getVoiceConfig } = require('../customerConfig');
const fs = require('fs');
const path = require('path');

// ─── Constants (defaults — overridden by customerConfig at run time) ─────────

// Default fallbacks match c0.json qaThresholds.gate1
const DEFAULT_PASS_THRESHOLD = 90;
const DEFAULT_SENDBACK_THRESHOLD = 70;

// Default hype words — c0 Customer 0 prohibited words (subset; full list from customerConfig)
const DEFAULT_HYPE_WORDS = [
  'incredible', 'amazing', 'crazy', 'wild', 'insane', 'unbelievable',
  'mind-blowing', 'stunning', 'epic', 'legendary', 'phenomenal', 'extraordinary'
];

// Structural prohibited patterns — these are universal (not customer-specific)
// They check for structural script errors, not content-specific prohibited words.
const PROHIBITED_PATTERNS = [
  { pattern: /\([A-Z][a-z]+-[a-z]+\)/g, label: 'phonetic hint in parentheses' },
  { pattern: /\bsubscribe\b(?!.*\bAppreciate you\b)/i, label: 'mid-script subscribe CTA' },
  { pattern: /\blike (and )?subscribe\b/i, label: 'like-and-subscribe CTA' },
  { pattern: /\bfollow us\b/i, label: 'follow-us CTA' }
];

// Default required outro lines by form type — c0 Customer 0 defaults
// Overridden by customerConfig.voice.outroLine at run time
const DEFAULT_REQUIRED_OUTROS = {
  long: "Goodnight and good luck.",
  short: "Subscribe. Appreciate you.",
  compilation: "Goodnight and good luck."
};

/**
 * Get pass/sendback thresholds for this job from customerConfig.
 * Falls back to c0 defaults if config unavailable.
 */
function getThresholds(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId = jobSpec?.order?.templateId || (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const t = getGateThresholds(customerId, templateId, 'gate1', { pass: DEFAULT_PASS_THRESHOLD, manualReview: DEFAULT_SENDBACK_THRESHOLD });
  return { passThreshold: t.pass || DEFAULT_PASS_THRESHOLD, sendbackThreshold: t.manualReview || DEFAULT_SENDBACK_THRESHOLD };
}

/**
 * Get hype/prohibited words from customerConfig.voice.prohibitedWords.
 * Falls back to DEFAULT_HYPE_WORDS.
 */
function getHypeWords(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId = jobSpec?.order?.templateId || (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const voice = getVoiceConfig(customerId, templateId);
  return (voice.prohibitedWords && voice.prohibitedWords.length > 0) ? voice.prohibitedWords : DEFAULT_HYPE_WORDS;
}

/**
 * Get required outro line for this job from customerConfig.voice.outroLine.
 * Falls back to form-type default.
 */
function getRequiredOutro(jobSpec) {
  const formType = jobSpec?.order?.formType || 'long';
  const customerId = jobSpec?.customerId || 'c0';
  const templateId = jobSpec?.order?.templateId || (formType.includes('short') ? 'short-form' : 'long-form');
  const voice = getVoiceConfig(customerId, templateId);
  if (voice.outroLine) return voice.outroLine;
  return DEFAULT_REQUIRED_OUTROS[formType] || DEFAULT_REQUIRED_OUTROS.long;
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 *
 * PRE-GENERATE mode: checks spec completeness (designSpec.voice, sceneStructure).
 *   Called before any script exists. Should NOT require filledScript at this point.
 * RUN mode: checks filled script is present.
 *   Called when script_gen.js invokes gate1.run().
 *
 * The two modes are distinguished by presence of filledScript in jobSpec.
 * At pre-generate: filledScript is undefined (not yet written) — skip that check.
 * At run time: filledScript exists and must be non-empty.
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!process.env.ANTHROPIC_API_KEY) {
    reasons.push('ANTHROPIC_API_KEY not set — Claude QA unavailable');
  }

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) {
    reasons.push('jobSpec.jobId missing');
  }

  // PRE-GENERATE checks: verify spec has what Gate 1 needs to do its job
  // These fields should be resolved at createJobSpec() time (pre-generate fix).
  if (!jobSpec?.designSpec?.voice?.lockedOutro) {
    reasons.push('designSpec.voice.lockedOutro missing — customerConfig not resolved into spec at pre-generate');
  }
  if (!jobSpec?.designSpec?.sceneStructure?.sceneHeaders?.length) {
    reasons.push('designSpec.sceneStructure.sceneHeaders missing — scaffold not run at pre-generate (items may not have been provided yet)');
  }

  // RUN TIME check: verify filled script is present when actually QA-ing
  // filledScript === undefined means we're at pre-generate — skip this check.
  // filledScript === '' or null at run time is an error.
  const scaffold = jobSpec.filledScript || jobSpec.scaffold;
  if (scaffold !== undefined && scaffold !== null) {
    // filledScript was explicitly set — check it's non-empty
    if (typeof scaffold !== 'string' || scaffold.trim().length === 0) {
      reasons.push('No filled script/scaffold found in jobSpec — Gemini must fill the scaffold first');
    }
  }
  // If scaffold is undefined: we're at pre-generate, skip the check

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ committed: string }}
 */
function commit(jobSpec) {
  const items = jobSpec?.order?.inputs?.items || [];
  const formType = jobSpec?.order?.formType || 'long';
  return {
    committed: `I will verify the filled script matches committed style — voice (flat delivery, no hype words), entity names (display names not handles), commentary accuracy, and outro. I will NOT check scene count or structure. Items: ${items.length}. Form: ${formType}.`
  };
}

// ─── Internal analysis helpers ───────────────────────────────────────────────

/**
 * Parse script into sections by scene header.
 * Returns array of { header, body } objects.
 */
function parseScriptSections(script) {
  const sections = [];
  const headerRegex = /===\s*([A-Z0-9_]+)\s*===/g;
  const parts = script.split(headerRegex);
  // parts: [before_first, header1, body1, header2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({
      header: parts[i],
      body: parts[i + 1] || ''
    });
  }
  return sections;
}

/**
 * Check for unfilled [DIALOGUE] slots.
 * Returns array of headers where slots remain.
 */
function findUnfilledSlots(script) {
  const unfilledHeaders = [];
  const sections = parseScriptSections(script);
  for (const { header, body } of sections) {
    if (body.includes('[DIALOGUE]')) {
      unfilledHeaders.push(header);
    }
  }
  // Also catch raw [DIALOGUE] outside headers
  const headerNames = new Set(unfilledHeaders);
  if (script.includes('[DIALOGUE]') && headerNames.size === 0) {
    unfilledHeaders.push('UNKNOWN_SECTION');
  }
  return unfilledHeaders;
}

/**
 * Find hype word violations in a section body.
 * Returns array of { word, section }.
 * Uses customer-specific prohibited words list from customerConfig.
 */
function findHypeViolations(sections, hypeWords) {
  const words = hypeWords || DEFAULT_HYPE_WORDS;
  const violations = [];
  for (const { header, body } of sections) {
    const lower = body.toLowerCase();
    for (const word of words) {
      if (lower.includes(word)) {
        violations.push({ section: header, violation: `Contains hype word "${word}"`, fix: `Replace "${word}" with flat factual language` });
      }
    }
  }
  return violations;
}

/**
 * Find prohibited language patterns.
 */
function findProhibitedLanguage(script) {
  const found = [];
  for (const { pattern, label } of PROHIBITED_PATTERNS) {
    const matches = script.match(pattern);
    if (matches) {
      found.push({ label, count: matches.length });
    }
  }
  return found;
}

/**
 * Check entity names against committed display names.
 * Returns array of { wrong, correct }.
 */
function findNameErrors(script, jobSpec) {
  const errors = [];
  const items = jobSpec?.order?.inputs?.items || [];

  for (const item of items) {
    const displayName = item.displayName || item.name;
    const handle = item.handle || item.twitchUsername || item.id;

    if (handle && displayName && handle !== displayName) {
      // Check if the handle appears anywhere in dialogue (should use displayName)
      const handleRegex = new RegExp(`\\b${handle}\\b`, 'gi');
      if (handleRegex.test(script)) {
        errors.push({ wrong: handle, correct: displayName });
      }
    }
  }

  return errors;
}

/**
 * Check outro line matches required closing.
 * Required line read from customerConfig.voice.outroLine — universal, not c0-specific.
 */
function checkOutro(script, jobSpec) {
  const required = getRequiredOutro(jobSpec);

  // Find OUTRO section
  const outroMatch = script.match(/===\s*OUTRO\s*===\s*([\s\S]*?)(?:===|$)/);
  if (!outroMatch) {
    return { ok: false, required, found: null };
  }
  const outroBody = outroMatch[1].trim();
  const hasRequired = outroBody.includes(required);
  return { ok: hasRequired, required, found: outroBody.substring(0, 200) };
}

/**
 * Check INTRO scene contains the locked intro text from jobSpec.designSpec.voice.lockedIntro.
 * This is the authoritative source: scaffold wrote it, jobSpec carries it, Gate 1 verifies it.
 * Returns { ok, required, found } — same shape as checkOutro for consistency.
 */
function checkLockedIntro(script, jobSpec) {
  // Read from jobSpec.designSpec.voice.lockedIntro (written by script_gen.js after scaffold)
  const lockedIntro = jobSpec?.designSpec?.voice?.lockedIntro;
  if (!lockedIntro) {
    // No locked intro in job spec — skip check (short-form or config unavailable)
    return { ok: true, required: null, found: null };
  }

  // Find INTRO section
  const introMatch = script.match(/===\s*INTRO\s*===\s*([\s\S]*?)(?:===|$)/);
  if (!introMatch) {
    return { ok: false, required: lockedIntro, found: null };
  }
  const introBody = introMatch[1].trim();
  // Check for a signature phrase from the locked intro (first ~60 chars)
  // Full exact match can fail on minor spacing; use key phrase from start of intro
  const keyPhrase = lockedIntro.substring(0, 60).trim();
  const hasRequired = introBody.includes(keyPhrase);
  return { ok: hasRequired, required: lockedIntro, found: introBody.substring(0, 200) };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * Execute Gate 1 style QA.
 * @param {Object} jobSpec
 * @param {string} filledScript
 * @param {Object} gate0Report
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, filledScript, gate0Report) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  // Use gate0Report.upstreamContext as starting point
  const upstreamContext = {
    reviewedReports: ['gate0'],
    confirmedClean: gate0Report?.upstreamContext?.confirmedClean || [],
    escalatedConcerns: gate0Report?.upstreamContext?.escalatedConcerns || [],
    downstreamHeadsUp: null
  };

  const baseOutput = {
    gate: 1,
    jobId,
    passed: false,
    score: 0,
    outcome: 'hard_fail',
    fixDirective: null,
    upstreamContext,
    completedAt: now()
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 1 not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE1_NOT_READY', new Error(reason), { jobId, gate: 1 });
    return { ...baseOutput, completedAt: now() };
  }

  const script = filledScript || jobSpec.filledScript || jobSpec.scaffold;

  // ── Hard fail: unfilled [DIALOGUE] slots ────────────────────────────────
  const unfilledSlots = findUnfilledSlots(script);
  if (unfilledSlots.length > 0) {
    const reason = `Unfilled [DIALOGUE] slots in sections: ${unfilledSlots.join(', ')}`;
    logError('GATE1_UNFILLED_SLOTS', new Error(reason), { jobId, gate: 1, sections: unfilledSlots });
    return {
      ...baseOutput,
      score: 0,
      outcome: 'hard_fail',
      fixDirective: {
        attempt: 1,
        committed: commit(jobSpec).committed,
        delivered: 'Script contains unfilled [DIALOGUE] slots — Gemini failed to fill scaffold',
        mismatches: unfilledSlots.map(h => ({
          field: h,
          committed: 'Filled dialogue',
          delivered: '[DIALOGUE]',
          fix: `Fill the [DIALOGUE] slot in section ${h} with actual spoken content`
        })),
        nameErrors: [],
        styleViolations: [],
        outroRequired: null
      },
      upstreamContext: { ...upstreamContext, escalatedConcerns: [...upstreamContext.escalatedConcerns, reason] },
      completedAt: now()
    };
  }

  // ── Scoring pass ─────────────────────────────────────────────────────────
  let score = 100;
  const deductions = [];
  const sections = parseScriptSections(script);

  // Load customer-specific thresholds and voice config
  const { passThreshold: PASS_THRESHOLD, sendbackThreshold: SENDBACK_THRESHOLD } = getThresholds(jobSpec);
  const hypeWords = getHypeWords(jobSpec);

  // Check hype word violations (-15 per section)
  const hypeViolations = findHypeViolations(sections, hypeWords);
  for (const v of hypeViolations) {
    score -= 15;
    deductions.push({ points: -15, reason: `Voice style: ${v.violation} in ${v.section}` });
  }

  // Check entity names (-15 each)
  const nameErrors = findNameErrors(script, jobSpec);
  for (const e of nameErrors) {
    score -= 15;
    deductions.push({ points: -15, reason: `Wrong entity name: "${e.wrong}" should be "${e.correct}"` });
  }

  // Check prohibited language (-10 each occurrence)
  const prohibitedFound = findProhibitedLanguage(script);
  for (const p of prohibitedFound) {
    const pts = p.count * 10;
    score -= pts;
    deductions.push({ points: -pts, reason: `Prohibited language: ${p.label} (${p.count}x)` });
  }

  // Check outro (-15 if wrong/missing) — short-form has NO outro scene, skip check entirely
  const isShortForm = (jobSpec?.order?.formType || '').includes('short') ||
    (jobSpec?.order?.templateId || '').includes('short') ||
    (jobSpec?.contentType || '').includes('-short');
  let outroCheck = { ok: true, required: null, found: null }; // short-form: outro is always ok
  if (!isShortForm) {
    outroCheck = checkOutro(script, jobSpec);
    if (!outroCheck.ok) {
      score -= 15;
      deductions.push({ points: -15, reason: `Wrong or missing outro. Required: "${outroCheck.required}"` });
    }
  }

  // Check locked intro (-15 if wrong/missing) — reads from jobSpec.designSpec.voice.lockedIntro
  // Short-form has no locked intro (null in jobSpec → check skipped automatically)
  let introCheck = { ok: true, required: null, found: null };
  if (!isShortForm) {
    introCheck = checkLockedIntro(script, jobSpec);
    if (!introCheck.ok && introCheck.required) {
      score -= 15;
      deductions.push({ points: -15, reason: `Wrong or missing locked intro. Required key phrase: "${introCheck.required?.substring(0, 60)}..."` });
    }
  }

  // ── Commentary accuracy — use Claude for fabrication detection ──────────
  // Only call Claude if score hasn't already bottomed out
  let fabricationFail = false;
  const contentTypeForCheck = jobSpec?.contentType || jobSpec?.order?.contentType || '';
  const isSportsContent = contentTypeForCheck.includes('sports') || contentTypeForCheck.includes('nba');
  // Gate 0 confirmed sources — for NBA we also pass clip analysis descriptions if available
  const clipAnalyses = gate0Report?.clipAnalyses || gate0Report?.confirmedSources || [];
  if (score > 0 && process.env.ANTHROPIC_API_KEY) {
    const confirmedTitles = (gate0Report?.confirmedSources || []).map(s => s.url).join('\n');
    // Fix 10: For sports/NBA, include clip analysis descriptions for accuracy cross-check
    const clipAnalysisContext = isSportsContent && clipAnalyses.length > 0
      ? `\nCLIP ANALYSIS DESCRIPTIONS (what Gemini saw in each clip):\n${clipAnalyses.map((s, i) => `Clip ${i+1}: ${s.analysis || s.description || s.summary || s.url || 'no analysis'}`).join('\n')}`
      : '';

    // Fix 4: For NBA/sports, build authorizedFacts from items[] scores so the
    // fabrication check doesn't flag correct score statements as invented.
    const authorizedFactsLines = [];
    if (isSportsContent) {
      for (const item of (jobSpec?.order?.inputs?.items || [])) {
        if (item.awayScore != null && item.homeScore != null) {
          const margin = Math.abs(parseInt(item.awayScore) - parseInt(item.homeScore));
          const winner = parseInt(item.awayScore) > parseInt(item.homeScore) ? (item.awayAbbr || item.away || 'away team') : (item.homeAbbr || item.home || 'home team');
          const loser  = parseInt(item.awayScore) > parseInt(item.homeScore) ? (item.homeAbbr || item.home || 'home team') : (item.awayAbbr || item.away || 'away team');
          authorizedFactsLines.push(`Game: ${item.away || item.awayAbbr || '?'} ${item.awayScore} — ${item.home || item.homeAbbr || '?'} ${item.homeScore} (margin: ${margin} points, winner: ${winner})`);
        } else if (item.matchup || item.title) {
          authorizedFactsLines.push(`Game: ${item.matchup || item.title}`);
        }
      }
    }
    const authorizedFactsContext = authorizedFactsLines.length > 0
      ? `\nAUTHORIZED FACTS (verified from items[] source data — do NOT flag these as fabrication):\n${authorizedFactsLines.join('\n')}\nAny score, margin, or winner/loser statement consistent with the above is AUTHORIZED. Do not flag it.`
      : '';
    try {
      // Build full QA context from jobSpec — all gate QA agents receive the complete spec
      const lockedIntroText  = jobSpec?.designSpec?.voice?.lockedIntro  || null;
      const lockedOutroText  = jobSpec?.designSpec?.voice?.lockedOutro  || getRequiredOutro(jobSpec);
      const prohibitedWords  = jobSpec?.designSpec?.voice?.prohibitedWords || hypeWords;
      const showName         = jobSpec?.designSpec?.voice?.showName         || jobSpec?.contentType || 'AuraFlux show';
      const sceneHeadersList = (jobSpec?.designSpec?.sceneStructure?.sceneHeaders || []).join(' → ');
      const orderedItems     = (jobSpec?.order?.inputs?.items || [])
        .map((it, i) => `${i+1}. ${it.title || it.displayName || it.name || 'unknown'}`)
        .join(', ');

      const qaPrompt = `You are Gate 1 — the style QA reviewer for the AuraFlux broadcast script pipeline.

YOUR SCOPE IS STYLE AND ACCURACY. Do NOT check:
- Scene count or structure — the scaffold system guarantees these, they are correct by construction
- Clip order or sequence — set by the scaffold, not the writer
- Scene headers in ALL_CAPS with underscores (e.g., ITEM1_INTRO, ITEM2_CLIP, NARRATION, HOOK, OUTRO) — these are system-generated structural markers, not errors. Accept all of them without comment.

YOUR JOB: Check style quality and outright fabricated facts. Read the full script carefully. A slow, accurate review is far better than a fast, wrong one.

CONFIRMED JOB SPEC:
- Show: "${showName}"
- Items ordered: ${orderedItems || '(none available)'}
- Expected scene structure: ${sceneHeadersList || '(not available)'}
- Locked intro (must appear EXACTLY in === INTRO === section): "${lockedIntroText ? lockedIntroText.substring(0, 120) + '...' : '(none — short-form or not set)'}"
- Locked outro (must appear in === OUTRO === section): "${lockedOutroText ? lockedOutroText.substring(0, 120) + '...' : '(none)'}"
- Prohibited words (must NOT appear anywhere): ${(prohibitedWords || []).join(', ') || '(none)'}

CONFIRMED SOURCES:
${confirmedTitles || '(no confirmed source URLs available — use extra caution before flagging fabrication)'}${clipAnalysisContext}${authorizedFactsContext}

Script to review:
${script.substring(0, 8000)}

CHECK IN ORDER:
1. LOCKED INTRO: Does === INTRO === contain the locked intro text exactly (first 60 chars must match)?
2. LOCKED OUTRO: Does === OUTRO === contain the locked outro text?
3. PROHIBITED WORDS: Do any prohibited words appear anywhere in the dialogue?
4. ITEM ACCURACY: Does the commentary match the ordered items? (${orderedItems || 'none'})
5. FABRICATION: Does commentary contain SPECIFIC, VERIFIABLE claims (exact score, exact statistic, exact date, exact quote) that clearly CANNOT be true based on the source context?

IMPORTANT RULES:
- Only flag fabrication if it is a SPECIFIC, VERIFIABLE claim that clearly CANNOT be true.
- Do NOT flag: opinions, commentary, humor, reasonable inferences, general observations.
- A script that says "he played great" is fine. Inventing a "37-point performance" when no score is available is fabrication.
- When in doubt, do NOT flag fabrication. False positives waste credits.
- NEVER flag scene headers or structural markers as errors — these are system-generated.
- lockedIntroCorrect=false only if the intro section is MISSING or the first 60 characters don't match.
- lockedOutroCorrect=false only if the outro section is MISSING or the required closing line is absent.
${isSportsContent ? `\nSPORTS/NBA ACCURACY CHECK (soft deduction only — NOT a hard fail):
- If clip analysis descriptions are available above, cross-check Bobby G's narration against what Gemini described seeing.
- Specific factual claims (quarter numbers, scores, player names in specific plays) that cannot be verified against the clip analysis → flag as "soft_accuracy" with -10 deduction each.
- This is a soft check — accuracy mismatches add to score but do NOT trigger hard_fail unless combined with other failures that drop score below 70.
- Return "softAccuracyIssues" array alongside the main result.` : ''}

Return JSON only:
{
  "lockedIntroCorrect": boolean,
  "lockedOutroCorrect": boolean,
  "prohibitedWordsFound": ["list any found"],
  "fabricationFound": boolean,
  "examples": ["only list claims you are CERTAIN are fabricated, with specific evidence"],
  "sceneStructureCorrect": true,
  "itemAccuracyIssues": ["any commentary that clearly doesn't match item titles/content"],
  "softAccuracyIssues": ["NBA/sports only — specific claims that couldn't be verified against clip analysis, each costs -10"]
}`;

      const result = await callClaudeAPI({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: qaPrompt }]
      });

      const text = result?.content?.[0]?.text || '{}';
      const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.fabricationFound && parsed.examples?.length > 0) {
        fabricationFail = true;
        const reason = `Commentary fabrication detected: ${parsed.examples.slice(0, 3).join('; ')}`;
        logError('GATE1_FABRICATION', new Error(reason), { jobId, gate: 1 });
        return {
          ...baseOutput,
          score: 0,
          outcome: 'hard_fail',
          fixDirective: {
            attempt: 1,
            committed: commit(jobSpec).committed,
            delivered: 'Script contains fabricated facts not supportable from confirmed sources',
            mismatches: [{ field: 'commentary_accuracy', committed: 'Accurate facts only', delivered: reason, fix: 'Remove or correct fabricated claims' }],
            nameErrors: [],
            styleViolations: hypeViolations,
            outroRequired: outroCheck.ok ? null : outroCheck.required
          },
          upstreamContext: { ...upstreamContext, escalatedConcerns: [...upstreamContext.escalatedConcerns, reason] },
          completedAt: now()
        };
      }

      // Deduct for lockedIntro mismatch (-15) — Claude verified what we already checked locally
      if (parsed.lockedIntroCorrect === false) {
        score -= 15;
        deductions.push({ points: -15, reason: 'Locked intro text incorrect or missing (Claude verification)' });
      }

      // Deduct for lockedOutro mismatch (-15) — Claude verified what we already checked locally
      if (parsed.lockedOutroCorrect === false) {
        score -= 15;
        deductions.push({ points: -15, reason: 'Locked outro text incorrect or missing (Claude verification)' });
      }

      // Deduct for prohibited words found by Claude (-10 each)
      if (Array.isArray(parsed.prohibitedWordsFound) && parsed.prohibitedWordsFound.length > 0) {
        for (const word of parsed.prohibitedWordsFound.slice(0, 5)) {
          score -= 10;
          deductions.push({ points: -10, reason: `Prohibited word found by Claude: "${word}"` });
        }
      }

      // Item accuracy issues (-10 each, capped at 3)
      if (Array.isArray(parsed.itemAccuracyIssues) && parsed.itemAccuracyIssues.length > 0) {
        for (const issue of parsed.itemAccuracyIssues.slice(0, 3)) {
          score -= 10;
          deductions.push({ points: -10, reason: `Item accuracy: ${issue}` });
        }
      }

      // NBA soft deduction for clip accuracy mismatches (not a hard fail)
      if (isSportsContent && Array.isArray(parsed.softAccuracyIssues) && parsed.softAccuracyIssues.length > 0) {
        for (const issue of parsed.softAccuracyIssues.slice(0, 3)) { // cap at 3 to avoid over-penalizing
          score -= 10;
          deductions.push({ points: -10, reason: `NBA clip accuracy: ${issue}` });
        }
        if (parsed.softAccuracyIssues.length > 0) {
          logError('GATE1_NBA_ACCURACY_SOFT', new Error(`${parsed.softAccuracyIssues.length} soft accuracy issues`), { jobId, gate: 1, issues: parsed.softAccuracyIssues });
        }
      }
    } catch (err) {
      // Claude API error — log but don't fail gate on API error
      logError('GATE1_CLAUDE_API_ERROR', err, { jobId, gate: 1 });
      deductions.push({ points: 0, reason: 'Fabrication check skipped — Claude API error' });
    }
  }

  // ── Score → action ───────────────────────────────────────────────────────
  score = Math.max(0, score);

  let outcome;
  let fixDirective = null;
  let downstreamHeadsUp = null;

  if (score >= PASS_THRESHOLD) {
    outcome = 'pass';
    downstreamHeadsUp = deductions.length > 0
      ? `Gate 1 passed with minor deductions: ${deductions.map(d => d.reason).join('; ')}`
      : null;
  } else if (score >= SENDBACK_THRESHOLD) {
    outcome = 'sendback';
    fixDirective = {
      attempt: 1,
      committed: commit(jobSpec).committed,
      delivered: `Script scored ${score}/100 — below pass threshold of ${PASS_THRESHOLD}`,
      mismatches: deductions.map(d => ({
        field: 'style',
        committed: 'Style compliant',
        delivered: d.reason,
        fix: d.reason
      })),
      nameErrors,
      styleViolations: hypeViolations,
      outroRequired: outroCheck.ok ? null : outroCheck.required
    };
    logError('GATE1_SENDBACK', new Error(`Score ${score} — sendback`), { jobId, gate: 1, score, deductions });
    // Persist fix directive to gate_fixes table so we can track what needed fixing
    try {
      const { saveGateFix } = require('../db');
      if (typeof saveGateFix === 'function') {
        saveGateFix(jobId, 1, score, null, 'sendback', `Score ${score} — ${deductions.map(d=>d.reason).join('; ')}`);
      }
    } catch(e) { /* non-fatal */ }
  } else {
    outcome = 'hard_fail';
    fixDirective = {
      attempt: 1,
      committed: commit(jobSpec).committed,
      delivered: `Script scored ${score}/100 — hard fail (below ${SENDBACK_THRESHOLD})`,
      mismatches: deductions.map(d => ({
        field: 'style',
        committed: 'Style compliant',
        delivered: d.reason,
        fix: d.reason
      })),
      nameErrors,
      styleViolations: hypeViolations,
      outroRequired: outroCheck.ok ? null : outroCheck.required
    };
    logError('GATE1_HARD_FAIL', new Error(`Score ${score} — hard fail`), { jobId, gate: 1, score, deductions });
    outcome = 'escalate';
  }

  return {
    gate: 1,
    jobId,
    passed: outcome === 'pass',
    score,
    outcome,
    fixDirective,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: outcome === 'pass' ? ['script_style'] : [],
      escalatedConcerns: outcome === 'escalate' ? deductions.map(d => d.reason) : upstreamContext.escalatedConcerns,
      downstreamHeadsUp
    },
    completedAt: now()
  };
}

// ─── prepare ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Pre-load voice rules from customerConfig
    const voice = getVoiceConfig(jobSpec?.customerId || 'c0', jobSpec?.order?.templateId || 'long-form');
    const prohibitedWords = (voice.prohibitedWords && voice.prohibitedWords.length > 0) ? voice.prohibitedWords : DEFAULT_HYPE_WORDS;
    const outroLine = voice.outroLine || DEFAULT_REQUIRED_OUTROS[jobSpec?.order?.formType || 'long'] || DEFAULT_REQUIRED_OUTROS.long;

    // Pre-load qaThresholds
    const { passThreshold } = getThresholds(jobSpec);

    // Read locked intro from jobSpec (written by script_gen.js after scaffold generation)
    const lockedIntro = jobSpec?.designSpec?.voice?.lockedIntro;

    console.log(`[gate1] Ready for job ${jobId} — voice=${jobSpec?.order?.contentType || 'unknown'}, intro='${lockedIntro?.slice(0, 40) || '(none — short-form or not yet set)'}...', outro='${outroLine}', threshold=${passThreshold}`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate1] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare };
