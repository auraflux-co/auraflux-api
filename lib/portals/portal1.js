'use strict';
/**
 * lib/portals/portal1.js — Portal 1: Gemini style / fabrication QA
 *
 * Runs after scaffold is filled by Gemini. Checks style/factual quality AND
 * verifies script structure against jobSpec scene contract so Portal 2 receives
 * valid scene sequencing.
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
 *   portal: 1,
 *   jobId: string,
 *   passed: boolean,
 *   score: number,
 *   outcome: 'pass' | 'sendback' | 'hard_fail' | 'escalate',
 *   fixDirective: object | null,
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const axios = require('axios');
const { logError } = require('../error_logger');
const { getPortalThresholds, getVoiceConfig } = require('../customerConfig');
const { captureAIMemoryTrace } = require('../ai_memory_trace');
const fs = require('fs');
const path = require('path');

// ─── Constants (defaults — overridden by customerConfig at run time) ─────────

// Default fallbacks match c0.json qaThresholds.gate1
const DEFAULT_PASS_THRESHOLD = 90;
const DEFAULT_SENDBACK_THRESHOLD = 55;

/** Model for Portal 1 JSON style QA (override with GEMINI_GATE1_MODEL). */
function gate1GeminiModel() {
  return (
    process.env.GEMINI_GATE1_MODEL ||
    process.env.GEMINI_SCRIPT_MODEL ||
    process.env.GEMINI_MODEL ||
    'gemini-2.5-flash'
  );
}

async function callGate1GeminiStyleQa(qaPrompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const model = gate1GeminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const contents = [{ role: 'user', parts: [{ text: qaPrompt }] }];
  const lastErr = [];
  for (const useJsonMime of [true, false]) {
    try {
      const genResp = await axios.post(
        url,
        {
          contents,
          generationConfig: useJsonMime
            ? { maxOutputTokens: 2048, temperature: 0.2, responseMimeType: 'application/json' }
            : { maxOutputTokens: 2048, temperature: 0.2 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      );
      const parts = genResp.data?.candidates?.[0]?.content?.parts || [];
      return parts
        .map((p) => p.text || '')
        .join('')
        .trim();
    } catch (e) {
      lastErr.push(e);
      if (!useJsonMime) throw e;
    }
  }
  throw lastErr[0] || new Error('Portal 1 Gemini call failed');
}

// Default hype words — c0 Customer 0 prohibited words (subset; full list from customerConfig)
const DEFAULT_HYPE_WORDS = [
  'incredible',
  'amazing',
  'crazy',
  'wild',
  'insane',
  'unbelievable',
  'mind-blowing',
  'stunning',
  'epic',
  'legendary',
  'phenomenal',
  'extraordinary',
];

// Structural prohibited patterns — these are universal (not customer-specific)
// They check for structural script errors, not content-specific prohibited words.
const PROHIBITED_PATTERNS = [
  { pattern: /\([A-Z][a-z]+-[a-z]+\)/g, label: 'phonetic hint in parentheses' },
  { pattern: /\bsubscribe\b(?!.*\bAppreciate you\b)/i, label: 'mid-script subscribe CTA' },
  { pattern: /\blike (and )?subscribe\b/i, label: 'like-and-subscribe CTA' },
  { pattern: /\bfollow us\b/i, label: 'follow-us CTA' },
];

// Default required outro lines by form type — c0 Customer 0 defaults
// Overridden by customerConfig.voice.outroLine at run time
const DEFAULT_REQUIRED_OUTROS = {
  long: 'Goodnight and good luck.',
  short: 'Subscribe. Appreciate you.',
  compilation: 'Goodnight and good luck.',
};

/**
 * Get pass/sendback thresholds for this job from customerConfig.
 * Falls back to c0 defaults if config unavailable.
 */
function getThresholds(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId =
    jobSpec?.order?.templateId ||
    (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const t = getPortalThresholds(customerId, templateId, 'gate1', {
    pass: DEFAULT_PASS_THRESHOLD,
    manualReview: DEFAULT_SENDBACK_THRESHOLD,
  });
  return {
    passThreshold: t.pass || DEFAULT_PASS_THRESHOLD,
    sendbackThreshold: t.manualReview || DEFAULT_SENDBACK_THRESHOLD,
  };
}

/**
 * Get hype/prohibited words from customerConfig.voice.prohibitedWords.
 * Falls back to DEFAULT_HYPE_WORDS.
 */
function getHypeWords(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId =
    jobSpec?.order?.templateId ||
    (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const voice = getVoiceConfig(customerId, templateId);
  return voice.prohibitedWords && voice.prohibitedWords.length > 0
    ? voice.prohibitedWords
    : DEFAULT_HYPE_WORDS;
}

/**
 * Get required outro line for this job from customerConfig.voice.outroLine.
 * Falls back to form-type default.
 */
function getRequiredOutro(jobSpec) {
  const formType = jobSpec?.order?.formType || 'long';
  const customerId = jobSpec?.customerId || 'c0';
  const templateId =
    jobSpec?.order?.templateId || (formType.includes('short') ? 'short-form' : 'long-form');
  const voice = getVoiceConfig(customerId, templateId);
  if (voice.outroLine) return voice.outroLine;
  return DEFAULT_REQUIRED_OUTROS[formType] || DEFAULT_REQUIRED_OUTROS.long;
}

/**
 * Parse Portal 1 QA JSON — models sometimes wrap JSON in fences, add a preamble,
 * or append prose after the closing brace. Never throw; returns null on total failure.
 */
function tryParseGate1QaJson(rawText) {
  if (rawText == null || typeof rawText !== 'string') return null;
  let s = String(rawText).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  while (s.startsWith('```')) {
    s = s
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
  const candidates = [];
  candidates.push(s);
  const i0 = s.indexOf('{');
  const i1 = s.lastIndexOf('}');
  if (i0 !== -1 && i1 > i0) candidates.push(s.slice(i0, i1 + 1));
  for (const cand of candidates) {
    const t = cand.trim();
    if (!t) continue;
    try {
      return JSON.parse(t);
    } catch (_e) {
      /* try next */
    }
  }
  return null;
}

const GATE1_QA_JSON_FALLBACK = {
  lockedIntroCorrect: null,
  lockedOutroCorrect: null,
  prohibitedWordsFound: [],
  fabricationFound: false,
  examples: [],
  sceneStructureCorrect: true,
  itemAccuracyIssues: [],
  softAccuracyIssues: [],
  clipMismatches: [],
};

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

  if (!process.env.GEMINI_API_KEY) {
    reasons.push('GEMINI_API_KEY not set — Portal 1 (Gemini) script QA unavailable');
  }

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) {
    reasons.push('jobSpec.jobId missing');
  }

  // PRE-GENERATE checks: verify spec has what Portal 1 needs to do its job.
  // lockedOutro is required for C0 avatar-based workflows (Bobby G sign-off line).
  // C1+ non-avatar jobs (API-submitted with url_list / upload sources) use a different
  // sign-off mechanism. Avatar workflow = HeyGen ordered OR speakerName set in voice config.
  const hasAvatarWorkflow = !!(
    jobSpec?.designSpec?.voice?.speakerName ||
    jobSpec?.addOns?.heygen?.active
  );
  if (hasAvatarWorkflow && !jobSpec?.designSpec?.voice?.lockedOutro) {
    reasons.push(
      'designSpec.voice.lockedOutro missing — customerConfig not resolved into spec at pre-generate'
    );
  }
  if (!jobSpec?.designSpec?.sceneStructure?.sceneHeaders?.length) {
    // Only block if this is an avatar/scaffold-based job. For C1+ upload/link jobs,
    // sceneHeaders are generated at run-time from source URLs — not required at canProduce.
    if (hasAvatarWorkflow) {
      reasons.push(
        'designSpec.sceneStructure.sceneHeaders missing — scaffold not run at pre-generate (items may not have been provided yet)'
      );
    }
  }

  // RUN TIME check: verify filled script is present when actually QA-ing
  // filledScript === undefined means we're at pre-generate — skip this check.
  // filledScript === '' or null at run time is an error.
  const scaffold = jobSpec.filledScript || jobSpec.scaffold;
  if (scaffold !== undefined && scaffold !== null) {
    // filledScript was explicitly set — check it's non-empty
    if (typeof scaffold !== 'string' || scaffold.trim().length === 0) {
      reasons.push(
        'No filled script/scaffold found in jobSpec — Gemini must fill the scaffold first'
      );
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
  const sceneHeaders = expectedSceneHeaders(jobSpec);
  const expectedClipCount =
    Number(
      jobSpec?.designSpec?.sceneStructure?.expectedClipCount ??
        jobSpec?.designSpec?.expectedClipCount ??
        0
    ) || 0;
  return {
    committed: `I will verify the filled script matches committed style and structure from jobSpec — voice (flat delivery, no hype words), entity names (display names not handles), commentary accuracy, locked intro/outro, exact scene header contract (${sceneHeaders.length} headers), and expected clip slots (${expectedClipCount}). Items: ${items.length}. Form: ${formType}.`,
  };
}

// ─── Internal analysis helpers ───────────────────────────────────────────────

/**
 * Parse script into sections by scene header.
 * Returns array of { header, body } objects.
 */
function parseScriptSections(script) {
  const sections = [];
  if (typeof script !== 'string' || script.trim().length === 0) return sections;

  // Only treat full-line scene markers as headers.
  // This ignores scaffold guidance examples like "(=== HEADER ===)".
  const headerRegex = /^===\s*([A-Z0-9_]+)\s*===\s*$/gm;
  const matches = [];
  let m;
  while ((m = headerRegex.exec(script)) !== null) {
    matches.push({ header: m[1], start: m.index, end: headerRegex.lastIndex });
  }

  for (let i = 0; i < matches.length; i++) {
    const curr = matches[i];
    const next = matches[i + 1];
    const bodyStart = curr.end;
    const bodyEnd = next ? next.start : script.length;
    sections.push({
      header: curr.header,
      body: script.slice(bodyStart, bodyEnd) || '',
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

function expectedSceneHeaders(jobSpec) {
  return (jobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
    .map((h) => String(h || '').trim())
    .filter(Boolean);
}

function validateStructureAgainstJobSpec(script, jobSpec) {
  const issues = [];
  const sections = parseScriptSections(script);
  const foundHeaders = sections.map((s) => String(s.header || '').trim()).filter(Boolean);
  const expectedHeadersList = expectedSceneHeaders(jobSpec);
  const expectedClipCount =
    Number(
      jobSpec?.designSpec?.sceneStructure?.expectedClipCount ??
        jobSpec?.designSpec?.expectedClipCount ??
        0
    ) || 0;
  const contentType = String(
    jobSpec?.contentType || jobSpec?.order?.contentType || ''
  ).toLowerCase();
  const isNews = contentType.includes('news');

  const hasExactHeaderOrder =
    expectedHeadersList.length > 0 &&
    foundHeaders.length === expectedHeadersList.length &&
    expectedHeadersList.every((h, idx) => foundHeaders[idx] === h);

  if (expectedHeadersList.length > 0 && !hasExactHeaderOrder) {
    const missing = expectedHeadersList.filter((h) => !foundHeaders.includes(h));
    const extra = foundHeaders.filter((h) => !expectedHeadersList.includes(h));
    issues.push(
      `Scene headers drift from jobSpec contract (expected ${expectedHeadersList.length}, found ${foundHeaders.length}).` +
        `${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}` +
        `${extra.length ? ` Extra: ${extra.join(', ')}.` : ''}`
    );
  }

  if (expectedClipCount > 0) {
    const clipMarkers = sections.reduce(
      (acc, s) => acc + (s.body.match(/\[CLIP PLAYS HERE\]/g) || []).length,
      0
    );
    const sourceClipTypes = sections.reduce(
      (acc, s) => acc + (s.body.match(/^type:\s*source_clip\s*$/gim) || []).length,
      0
    );
    // News may appear in either legacy [CLIP PLAYS HERE] scaffold form or source_clip form.
    const actualClipSignals = isNews ? Math.max(sourceClipTypes, clipMarkers) : clipMarkers;
    if (actualClipSignals !== expectedClipCount) {
      issues.push(
        `Clip-slot count mismatch for ${contentType || 'content'}: expected ${expectedClipCount}, found ${actualClipSignals}`
      );
    }
  }

  return {
    issues,
    foundHeaders,
    expectedHeaders: expectedHeadersList,
    expectedClipCount,
  };
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
        violations.push({
          section: header,
          violation: `Contains hype word "${word}"`,
          fix: `Replace "${word}" with flat factual language`,
        });
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
 * This is the authoritative source: scaffold wrote it, jobSpec carries it, Portal 1 verifies it.
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

/**
 * Extract ground-truth confirmed entities from jobSpec for deterministic QA scanning.
 * Works for ALL content types — NBA (player names), Twitch (display names), News (titles/sources).
 * Returns data structures used by both buildGate1StyleQaPrompt and the run() deterministic scan.
 */
function buildConfirmedEntities(jobSpec) {
  const contentTypeForCheck = jobSpec?.contentType || jobSpec?.order?.contentType || '';
  const isSportsContent =
    contentTypeForCheck.includes('sports') || contentTypeForCheck.includes('nba');
  const isTwitch = contentTypeForCheck.includes('twitch');
  const isNews = contentTypeForCheck.includes('news');

  const authorizedFactsLines = [];
  const confirmedRosterByGame = [];
  const confirmedEntityNames = new Set();
  const requiredDisplayNames = [];
  const confirmedArticleTitles = [];

  for (const item of jobSpec?.order?.inputs?.items || []) {
    if (isSportsContent) {
      if (item.awayScore != null && item.homeScore != null) {
        const margin = Math.abs(parseInt(item.awayScore, 10) - parseInt(item.homeScore, 10));
        const winner =
          parseInt(item.awayScore, 10) > parseInt(item.homeScore, 10)
            ? item.awayAbbr || item.away || 'away team'
            : item.homeAbbr || item.home || 'home team';
        authorizedFactsLines.push(
          `Game: ${item.away || item.awayAbbr || '?'} ${item.awayScore} — ${item.home || item.homeAbbr || '?'} ${item.homeScore} (margin: ${margin} points, winner: ${winner})`
        );
      } else if (item.matchup || item.title) {
        authorizedFactsLines.push(`Game: ${item.matchup || item.title}`);
      }
      if (item.playerContext && typeof item.playerContext === 'object') {
        const allNames = Object.values(item.playerContext).flat();
        if (allNames.length > 0) {
          authorizedFactsLines.push(
            `Confirmed active players — ${item.away || '?'} vs ${item.home || '?'}: ${allNames.join(', ')}`
          );
          confirmedRosterByGame.push({
            away: item.away || item.awayAbbr || '?',
            home: item.home || item.homeAbbr || '?',
            players: new Set(allNames.map((n) => n.toLowerCase())),
          });
          allNames.forEach((n) => confirmedEntityNames.add(n.toLowerCase()));
        }
      }
    } else if (isTwitch) {
      const displayName = item.displayName || item.name;
      const handle = item.handle || item.twitchUsername || item.streamer;
      if (displayName) {
        authorizedFactsLines.push(
          `Streamer: "${displayName}" (use this exact name — NOT handle "${handle || displayName}")`
        );
        confirmedEntityNames.add(displayName.toLowerCase());
        if (handle && handle !== displayName) {
          requiredDisplayNames.push({ wrong: handle, correct: displayName });
        }
      }
      if (item.game) authorizedFactsLines.push(`Game being played: ${item.game}`);
      const clips = item.clips || (item.title ? [item] : []);
      for (const clip of clips) {
        if (clip.title) authorizedFactsLines.push(`Clip title (confirmed): "${clip.title}"`);
      }
    } else if (isNews) {
      if (item.title) {
        const titleWords = item.title
          .split(/\s+/)
          .filter((w) => w.length > 4)
          .slice(0, 5);
        confirmedArticleTitles.push({
          title: item.title,
          source: item.source || 'unknown',
          keywords: titleWords,
        });
        authorizedFactsLines.push(
          `Story: "${item.title}" (source: ${item.source || 'Al Jazeera'})`
        );
        if (item.desc) {
          authorizedFactsLines.push(`Context: ${item.desc.slice(0, 120).replace(/\n/g, ' ')}`);
        }
      }
    }
  }

  const hasConfirmedRoster = confirmedRosterByGame.length > 0;
  const allConfirmedPlayers = hasConfirmedRoster
    ? new Set(confirmedRosterByGame.flatMap((g) => [...g.players]))
    : null;

  return {
    contentTypeForCheck,
    isSportsContent,
    isTwitch,
    isNews,
    authorizedFactsLines,
    confirmedRosterByGame,
    confirmedEntityNames,
    requiredDisplayNames,
    confirmedArticleTitles,
    hasConfirmedRoster,
    allConfirmedPlayers,
  };
}

/**
 * Build the exact user prompt sent to Gemini for Portal 1 style/fabrication QA (offline replay + tracing).
 * Does not call the API.
 */
function buildGate1StyleQaPrompt(jobSpec, script, gate0Report, opts = {}) {
  const videoGroundingClear = !!opts.videoGroundingClear;
  const {
    contentTypeForCheck,
    isSportsContent,
    authorizedFactsLines,
    confirmedRosterByGame,
    hasConfirmedRoster,
    allConfirmedPlayers,
  } = buildConfirmedEntities(jobSpec);
  const clipAnalyses = gate0Report?.clipAnalyses || gate0Report?.confirmedSources || [];
  const confirmedTitles = (gate0Report?.confirmedSources || []).map((s) => s.url).join('\n');
  const clipAnalysisContext =
    isSportsContent && clipAnalyses.length > 0
      ? `\nCLIP ANALYSIS DESCRIPTIONS (what Gemini saw in each clip):\n${clipAnalyses.map((s, i) => `Clip ${i + 1}: ${s.analysis || s.description || s.summary || s.url || 'no analysis'}`).join('\n')}`
      : '';

  const authorizedFactsContext =
    authorizedFactsLines.length > 0
      ? `\nAUTHORIZED FACTS (verified from source data — do NOT flag these as fabrication):\n${authorizedFactsLines.join('\n')}\nStatements consistent with the above are AUTHORIZED. Do not flag them.`
      : '';

  const hypeWords = getHypeWords(jobSpec);
  const lockedIntroText = jobSpec?.designSpec?.voice?.lockedIntro || null;
  const lockedOutroText = jobSpec?.designSpec?.voice?.lockedOutro || getRequiredOutro(jobSpec);
  const prohibitedWords = jobSpec?.designSpec?.voice?.prohibitedWords || hypeWords;
  const showName = jobSpec?.designSpec?.voice?.showName || jobSpec?.contentType || 'AuraFlux show';
  const sceneHeadersList = (jobSpec?.designSpec?.sceneStructure?.sceneHeaders || []).join(' → ');
  const orderedItems = (jobSpec?.order?.inputs?.items || [])
    .map((it, i) => `${i + 1}. ${it.title || it.displayName || it.name || 'unknown'}`)
    .join(', ');

  const qaPrompt = `You are Portal 1 — the style QA reviewer (Gemini) for the AuraFlux broadcast script pipeline.
${
  videoGroundingClear
    ? `
VIDEO GROUNDING (IMPORTANT):
A separate Gemini model already watched the SAME source clip attached to this job and reported **no fabrication**
of verifiable on-court facts in the script relative to that video.
- Do **NOT** set fabricationFound=true for play-by-play, scores, or player actions that could plausibly match the clip.
- You may still set fabricationFound=true only for claims that are **impossible** given AUTHORIZED FACTS / items[]
  below (e.g. wrong teams entirely), not for normal narration nuance.
`
    : ''
}

YOUR SCOPE IS STYLE AND ACCURACY. Do NOT check:
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
${String(script || '').substring(0, 8000)}

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
${
  isSportsContent
    ? `\nSPORTS/NBA ACCURACY — HARD GROUNDING:
- Only player names, team affiliations, jersey numbers, and play-by-play facts that appear in CLIP ANALYSIS DESCRIPTIONS above or in AUTHORIZED FACTS may be stated as fact.
- Do NOT invent roster membership (e.g. a player on a team not evidenced above). If the clip analysis does not name a player or team for a moment, any specific name in the script for that moment is fabrication unless covered by AUTHORIZED FACTS.
- Specific scores/quarters/clocks must match AUTHORIZED FACTS or clip analysis; otherwise flag fabrication or soft_accuracy.

${
  hasConfirmedRoster
    ? `ROSTER HARD FAIL — CONFIRMED ESPN DATA AVAILABLE:
The AUTHORIZED FACTS above include the confirmed active players from the ESPN boxscore for each game.
If the script names ANY player who does NOT appear in the "Confirmed active players" list above:
- Set rosterViolations to an array of { playerName, scriptContext } objects (one per violation)
- This is a HARD FAIL — it means Gemini used a traded or wrong player based on stale training data
- Each roster violation must be listed — do NOT omit any
- Return rosterViolations even if fabricationFound is false`
    : `SPORTS/NBA ACCURACY CHECK (soft deduction only — NO confirmed roster available):
- Specific factual claims (quarter numbers, scores, player names in specific plays) that cannot be verified against the clip analysis → flag as "soft_accuracy" with -10 deduction each.
- This is a soft check — accuracy mismatches add to score but do NOT trigger hard_fail unless combined with other failures that drop score below 70.
- Return "softAccuracyIssues" array alongside the main result.`
}`
    : ''
}
${
  contentTypeForCheck.includes('twitch')
    ? `\nTWITCH ACCURACY — ENTITY GROUNDING:
- The AUTHORIZED FACTS above list the confirmed streamer display names and games.
- If the script uses a Twitch handle (lowercase username) instead of the streamer's display name → flag as an entityNameError (wrong entity name).
- If the script names a game not in AUTHORIZED FACTS → flag as fabrication.
- If a streamer's clip title is listed in AUTHORIZED FACTS and the script describes completely different content → flag as fabrication.
- Set "entityNameErrors" in your response to list each wrong-name instance: { wrong, correct }.`
    : ''
}
${
  jobSpec.contentType === 'show_commentary'
    ? `\nSHOW COMMENTARY — STRUCTURE QA (CPD-75):
- Expect ${jobSpec.commentaryConfig?.scriptTemplate?.topicCount ?? 5} topics, each with ${jobSpec.commentaryConfig?.scriptTemplate?.paragraphsPerTopic ?? 3} paragraphs.
- Count the topic headings or scene blocks. If fewer than expected, set structureViolation=true with details.
- Each paragraph within a topic should be a complete analytical sentence, not a one-liner. Flag if fewer than 2 sentences per paragraph.
- Fair-use citation markers (e.g. [clip_N], [src: ...]) must appear in the transcript section to attribute B-roll.
- Set "commentaryStructureIssues" in your response for any structural failures.
- Tone should be analytical and conversational — flag heavily promotional or hype language.
- Return "commentaryTopicCount": number and "commentaryParagraphsOk": boolean in your response.`
    : contentTypeForCheck.includes('news')
    ? `\nNEWS ACCURACY — SOURCE AND TOPIC GROUNDING:
- The AUTHORIZED FACTS above list the confirmed article titles and their sources.
- If the script attributes a story to a news organization NOT listed in AUTHORIZED FACTS → flag as SOURCE_FABRICATION.
- If the script describes events or facts that directly contradict the confirmed article titles → flag as fabrication with specific evidence.
- Do NOT flag general background context — only flag claims that contradict or invent specific facts not supported by the confirmed articles above.
- Set "sourceViolations" in your response to list any wrong source attribution.`
    : ''
}

Return JSON only:
{
  "lockedIntroCorrect": boolean,
  "lockedOutroCorrect": boolean,
  "prohibitedWordsFound": ["list any found"],
  "fabricationFound": boolean,
  "examples": ["only list claims you are CERTAIN are fabricated, with specific evidence"],
  "sceneStructureCorrect": true,
  "itemAccuracyIssues": ["any commentary that clearly doesn't match item titles/content"],
  "softAccuracyIssues": ["sports only — specific claims that couldn't be verified against clip analysis, each costs -10"],
  "clipMismatches": [
    {
      "clipIndex": 1,
      "sceneHeader": "ITEM1_CLIP",
      "scriptClaim": "brief quote of what the script says about this clip",
      "clipActual": "what the CLIP ANALYSIS DESCRIPTIONS actually show for that clip",
      "severity": "hard|soft"
    }
  ],
  "rosterViolations": [{"playerName": "...", "scriptContext": "brief quote from script where the wrong player appears"}],
  "entityNameErrors": [{"wrong": "handle/wrong_name", "correct": "display_name"}],
  "sourceViolations": ["news only — wrong source attribution e.g. attributed to CNN when source is Al Jazeera"]
}

Rules for clipMismatches:
- Only populate when the script makes a specific claim about what is SHOWN in a clip that contradicts the CLIP ANALYSIS DESCRIPTIONS above.
- clipIndex matches the "Clip N" number from the CLIP ANALYSIS DESCRIPTIONS section (1-based).
- Leave clipMismatches as [] if there are no clip-level contradictions.
- Do NOT populate for fabrication of facts not shown in clips (use examples instead).`;

  return {
    qaPrompt,
    meta: {
      isSportsContent,
      orderedItemCount: (jobSpec?.order?.inputs?.items || []).length,
      sceneHeaderCount: (jobSpec?.designSpec?.sceneStructure?.sceneHeaders || []).length,
      authorizedFactsCount: authorizedFactsLines.length,
      clipAnalysisLineCount: clipAnalyses.length,
    },
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * Execute Portal 1 style QA.
 * @param {Object} jobSpec
 * @param {string} filledScript
 * @param {Object} gate0Report
 * @returns {Promise<Object>} GateOutput
 */
/**
 * Build a clip-level diagnostic array for the fix directive.
 * Matches mismatch.clipMismatch objects from deductions against the gate0 clip analysis
 * text so the downstream fixer has the actual clip content to work from.
 *
 * @param {Array} deductions - scored deductions from the run, each may have .clipMismatch
 * @param {Array} clipAnalyses - gate0Report.clipAnalyses or confirmedSources
 * @returns {Array} enriched clip diagnostic entries
 */
function buildClipDiagnostic(deductions, clipAnalyses) {
  const mismatches = deductions
    .filter((d) => d.clipMismatch)
    .map((d) => d.clipMismatch);
  if (mismatches.length === 0) return [];

  return mismatches.map((m) => {
    const idx = (m.clipIndex || 1) - 1; // 0-based
    const clipData = Array.isArray(clipAnalyses) ? clipAnalyses[idx] : null;
    const clipAnalysisText =
      clipData?.analysis || clipData?.description || clipData?.summary || clipData?.url || null;
    return {
      clipIndex: m.clipIndex,
      sceneHeader: m.sceneHeader || null,
      scriptClaim: m.scriptClaim || null,
      clipActual: m.clipActual || clipAnalysisText || null,
      severity: m.severity || 'soft',
      fix: `Rewrite ${m.sceneHeader || `clip ${m.clipIndex} scene`} to match what Gemini actually saw: "${(clipAnalysisText || m.clipActual || '').substring(0, 200)}"`,
    };
  });
}

async function run(jobSpec, filledScript, gate0Report) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  // clip analysis lookup (used in fix directive builder)
  const gate0ClipAnalyses = gate0Report?.clipAnalyses || gate0Report?.confirmedSources || [];

  // Use gate0Report.upstreamContext as starting point
  const upstreamContext = {
    reviewedReports: ['gate0'],
    confirmedClean: gate0Report?.upstreamContext?.confirmedClean || [],
    escalatedConcerns: gate0Report?.upstreamContext?.escalatedConcerns || [],
    downstreamHeadsUp: null,
  };

  const baseOutput = {
    portal: 1,
    jobId,
    passed: false,
    score: 0,
    outcome: 'hard_fail',
    fixDirective: null,
    upstreamContext,
    completedAt: now(),
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Portal 1 not ready: ${readiness.reasons.join('; ')}`;
    logError('PORTAL1_NOT_READY', new Error(reason), { jobId, portal: 1 });
    return { ...baseOutput, failReason: reason, outcome: 'hard_fail', completedAt: now() };
  }

  const script = filledScript || jobSpec.filledScript || jobSpec.scaffold || null;

  // Hard fail: no script available for QA — generation step must run before Portal 1
  if (!script) {
    const reason = 'Portal 1: no script available — generation step must complete before QA';
    logError('PORTAL1_NO_SCRIPT', new Error(reason), { jobId, portal: 1 });
    return { ...baseOutput, failReason: reason, outcome: 'hard_fail', completedAt: now() };
  }

  let videoGroundingClear = false;

  // ── Hard fail: unfilled [DIALOGUE] slots ────────────────────────────────
  const unfilledSlots = findUnfilledSlots(script);
  if (unfilledSlots.length > 0) {
    const reason = `Unfilled [DIALOGUE] slots in sections: ${unfilledSlots.join(', ')}`;
    logError('PORTAL1_UNFILLED_SLOTS', new Error(reason), {
      jobId,
      portal: 1,
      sections: unfilledSlots,
    });
    return {
      ...baseOutput,
      score: 0,
      outcome: 'hard_fail',
      fixDirective: {
        attempt: 1,
        committed: commit(jobSpec).committed,
        delivered: 'Script contains unfilled [DIALOGUE] slots — Gemini failed to fill scaffold',
        mismatches: unfilledSlots.map((h) => ({
          field: h,
          committed: 'Filled dialogue',
          delivered: '[DIALOGUE]',
          fix: `Fill the [DIALOGUE] slot in section ${h} with actual spoken content`,
        })),
        nameErrors: [],
        styleViolations: [],
        outroRequired: null,
      },
      upstreamContext: {
        ...upstreamContext,
        escalatedConcerns: [...upstreamContext.escalatedConcerns, reason],
      },
      completedAt: now(),
    };
  }

  // ── Hard fail: structure must match jobSpec contract to avoid Portal 2 drift ─
  const structureCheck = validateStructureAgainstJobSpec(script, jobSpec);
  if (structureCheck.issues.length > 0) {
    const reason = structureCheck.issues.join('; ');
    logError('PORTAL1_STRUCTURE_MISMATCH', new Error(reason), {
      jobId,
      portal: 1,
      expectedHeaders: structureCheck.expectedHeaders,
      foundHeaders: structureCheck.foundHeaders,
      expectedClipCount: structureCheck.expectedClipCount,
    });
    return {
      ...baseOutput,
      score: 0,
      outcome: 'hard_fail',
      fixDirective: {
        attempt: 1,
        committed: commit(jobSpec).committed,
        delivered: 'Script structure drifted from jobSpec scene contract',
        mismatches: structureCheck.issues.map((issue) => ({
          field: 'scene_structure',
          committed: `Headers=${structureCheck.expectedHeaders.join(' -> ')}; clips=${structureCheck.expectedClipCount}`,
          delivered: issue,
          fix: 'Regenerate script using exact scaffold headers and clip-slot rules from jobSpec',
        })),
        nameErrors: [],
        styleViolations: [],
        outroRequired: null,
      },
      upstreamContext: {
        ...upstreamContext,
        escalatedConcerns: [...upstreamContext.escalatedConcerns, reason],
      },
      completedAt: now(),
    };
  }

  // ── Portal 1b: Gemini watches the source video (independent of script writer) ─
  try {
    const { reviewScriptAgainstVideo } = require('./portal1_video_reviewer');
    const vReview = await reviewScriptAgainstVideo({ jobSpec, script, gate0Report });
    if (!vReview.skipped && vReview.fabricationFound) {
      const ex = (vReview.examples || []).filter(Boolean);
      const reason = ex.length
        ? `Video QA: ${ex.slice(0, 3).join('; ')}`
        : 'Video QA: fabrication flagged relative to source video';
      logError('PORTAL1_VIDEO_FABRICATION', new Error(reason), { jobId, gate: '1b' });
      return {
        ...baseOutput,
        score: 0,
        outcome: 'hard_fail',
        fixDirective: {
          attempt: 1,
          committed: commit(jobSpec).committed,
          delivered:
            'Script contains claims contradicted by the source video (Gemini video reviewer)',
          mismatches: [
            {
              field: 'commentary_accuracy',
              committed: 'Must match verified video + authorized facts',
              delivered: reason,
              fix: 'Remove or correct claims that are not supported by the clip',
            },
          ],
          nameErrors: [],
          styleViolations: [],
          outroRequired: null,
        },
        upstreamContext: {
          ...upstreamContext,
          escalatedConcerns: [...upstreamContext.escalatedConcerns, reason],
          downstreamHeadsUp: vReview.observedSummary
            ? `Video reviewer summary: ${vReview.observedSummary}`
            : null,
        },
        completedAt: now(),
      };
    }
    if (!vReview.skipped && !vReview.error && vReview.fabricationFound === false) {
      videoGroundingClear = true;
    }
  } catch (vErr) {
    logError('PORTAL1_VIDEO_REVIEWER_ERR', vErr, { jobId, gate: '1b' });
  }

  // ── Scoring pass ─────────────────────────────────────────────────────────
  let score = 100;
  const deductions = [];
  const sections = parseScriptSections(script);

  // Load customer-specific thresholds and voice config
  const { passThreshold: PASS_THRESHOLD, sendbackThreshold: SENDBACK_THRESHOLD } =
    getThresholds(jobSpec);

  // Build confirmed ground-truth entities for deterministic checks (ALL content types)
  const {
    contentTypeForCheck: cTypeCheck,
    isSportsContent: isSports,
    allConfirmedPlayers,
    requiredDisplayNames,
    confirmedArticleTitles,
  } = buildConfirmedEntities(jobSpec);

  // ── Deterministic entity check (no LLM) — runs for ALL content types ─────────
  // When confirmed source data provides known entity names, scan the script text directly.
  // NBA: player names from ESPN boxscore
  // Twitch: display names (must not use raw handle/username)
  // News: source attribution must not swap between news orgs
  // This catches hallucinations and wrong-name errors regardless of what Gemini says.
  const deterministicRosterViolations = [];

  // ── NBA: confirmed player roster scan ──
  if (isSports && allConfirmedPlayers && allConfirmedPlayers.size > 0 && script) {
    const namePattern = /\b([A-Z][a-z]{1,12})\s+([A-Z][a-z]{1,12})\b/g;
    const scriptMatches = [...script.matchAll(namePattern)];
    for (const match of scriptMatches) {
      const fullName = `${match[1]} ${match[2]}`;
      const lowerName = fullName.toLowerCase();
      if (!allConfirmedPlayers.has(lowerName)) {
        const skip =
          /bobby\s+g|appreciate\s+you|side\s+of|super\s+bowl|east\s+conf|west\s+conf|all\s+star|game\s+\d|quarter\s+\d/i.test(
            fullName
          );
        if (!skip) {
          const occurrences = (
            script.match(new RegExp(fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []
          ).length;
          if (occurrences >= 2) {
            deterministicRosterViolations.push({
              playerName: fullName,
              occurrences,
              source: 'deterministic_scan',
            });
          }
        }
      }
    }
    if (deterministicRosterViolations.length > 0) {
      const violationSummary = deterministicRosterViolations
        .map((v) => `"${v.playerName}" (${v.occurrences}x)`)
        .join(', ');
      score -= 100;
      deductions.push({
        points: -100,
        reason: `ROSTER_VIOLATION (deterministic): Player names not in ESPN boxscore — ${violationSummary}. These players are not on the teams playing. Fix: replace with confirmed players from playerContext or describe generically.`,
      });
      logError(
        'PORTAL1_ROSTER_VIOLATION_DETERMINISTIC',
        new Error(`Deterministic scan: ${deterministicRosterViolations.length} wrong players`),
        {
          jobId,
          portal: 1,
          violations: deterministicRosterViolations,
          confirmedPlayerCount: allConfirmedPlayers.size,
        }
      );
    }
  }

  // ── Twitch: wrong handle/display-name scan (upgrade to hard fail if repeated) ──
  if (cTypeCheck.includes('twitch') && requiredDisplayNames.length > 0 && script) {
    for (const { wrong, correct } of requiredDisplayNames) {
      const handleOccurrences = (
        script.match(new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) ||
        []
      ).length;
      if (handleOccurrences >= 2) {
        score -= 50;
        deductions.push({
          points: -50,
          reason: `ENTITY_VIOLATION (deterministic): Twitch handle "${wrong}" used ${handleOccurrences}x in script — must use display name "${correct}". Customer sees the handle, not the brand name.`,
        });
        logError(
          'PORTAL1_TWITCH_HANDLE_VIOLATION',
          new Error(`Handle "${wrong}" instead of display name "${correct}"`),
          { jobId, portal: 1, wrong, correct, occurrences: handleOccurrences }
        );
      }
    }
  }

  // ── News: source attribution scan — script must not swap news orgs ──────────
  if (cTypeCheck.includes('news') && confirmedArticleTitles.length > 0 && script) {
    const confirmedSources = new Set(
      confirmedArticleTitles.map((a) => (a.source || '').toLowerCase()).filter(Boolean)
    );
    const knownNewsOrgs = [
      'al jazeera',
      'bbc',
      'cnn',
      'reuters',
      'ap news',
      'npr',
      'fox news',
      'nbc news',
      'abc news',
      'cbs news',
      'the guardian',
    ];
    for (const org of knownNewsOrgs) {
      if (
        !confirmedSources.has(org) &&
        new RegExp(`\\b${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(script)
      ) {
        score -= 30;
        deductions.push({
          points: -30,
          reason: `SOURCE_VIOLATION: Script attributes content to "${org}" but confirmed sources are: ${[...confirmedSources].join(', ') || 'unknown'}. Do not fabricate source attribution.`,
        });
        logError('PORTAL1_NEWS_SOURCE_VIOLATION', new Error(`Wrong source org "${org}"`), {
          jobId,
          portal: 1,
          wrongOrg: org,
          confirmedSources: [...confirmedSources],
        });
      }
    }
    let topicCoveredCount = 0;
    for (const article of confirmedArticleTitles) {
      const kw = article.keywords || [];
      const covered = kw.some((word) =>
        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(script)
      );
      if (covered) topicCoveredCount++;
    }
    const uncoveredArticles = confirmedArticleTitles.length - topicCoveredCount;
    if (uncoveredArticles > 0 && confirmedArticleTitles.length >= 2) {
      // Only penalize if more than half the articles have zero keywords in script (likely off-topic hallucination)
      if (uncoveredArticles > Math.floor(confirmedArticleTitles.length / 2)) {
        score -= 25;
        deductions.push({
          points: -25,
          reason: `TOPIC_DRIFT: Script does not mention keywords from ${uncoveredArticles}/${confirmedArticleTitles.length} confirmed articles. Possible hallucination or wrong-article content.`,
        });
        logError(
          'PORTAL1_NEWS_TOPIC_DRIFT',
          new Error(`${uncoveredArticles} articles have zero keyword coverage in script`),
          { jobId, portal: 1, uncoveredArticles, totalArticles: confirmedArticleTitles.length }
        );
      }
    }
  }
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
    deductions.push({
      points: -15,
      reason: `Wrong entity name: "${e.wrong}" should be "${e.correct}"`,
    });
  }

  // Check prohibited language (-10 each occurrence)
  const prohibitedFound = findProhibitedLanguage(script);
  for (const p of prohibitedFound) {
    const pts = p.count * 10;
    score -= pts;
    deductions.push({ points: -pts, reason: `Prohibited language: ${p.label} (${p.count}x)` });
  }

  // Check outro (-15 if wrong/missing) — short-form has NO outro scene, skip check entirely
  const isShortForm =
    (jobSpec?.order?.formType || '').includes('short') ||
    (jobSpec?.order?.templateId || '').includes('short') ||
    (jobSpec?.contentType || '').includes('-short');
  let outroCheck = { ok: true, required: null, found: null }; // short-form: outro is always ok
  if (!isShortForm) {
    outroCheck = checkOutro(script, jobSpec);
    if (!outroCheck.ok) {
      score -= 15;
      deductions.push({
        points: -15,
        reason: `Wrong or missing outro. Required: "${outroCheck.required}"`,
      });
    }
  }

  // Check locked intro (-15 if wrong/missing) — reads from jobSpec.designSpec.voice.lockedIntro
  // Short-form has no locked intro (null in jobSpec → check skipped automatically)
  let introCheck = { ok: true, required: null, found: null };
  if (!isShortForm) {
    introCheck = checkLockedIntro(script, jobSpec);
    if (!introCheck.ok && introCheck.required) {
      score -= 15;
      deductions.push({
        points: -15,
        reason: `Wrong or missing locked intro. Required key phrase: "${introCheck.required?.substring(0, 60)}..."`,
      });
    }
  }

  // ── Commentary accuracy — Gemini JSON pass (style + fabrication signals) ─
  // Only call if score hasn't already bottomed out
  let fabricationFail = false;
  if (score > 0 && process.env.GEMINI_API_KEY) {
    const { qaPrompt, meta: gate1PromptMeta } = buildGate1StyleQaPrompt(
      jobSpec,
      script,
      gate0Report,
      {
        videoGroundingClear,
      }
    );
    const g1Model = gate1GeminiModel();
    try {
      captureAIMemoryTrace({
        provider: 'gemini',
        model: g1Model,
        portal: 'portal1',
        jobId,
        stage: 'gate1_style_qa',
        prompt: qaPrompt,
        inputs: {
          script,
          orderedItemCount: gate1PromptMeta.orderedItemCount,
          sceneHeaderCount: gate1PromptMeta.sceneHeaderCount,
          authorizedFactsCount: gate1PromptMeta.authorizedFactsCount,
          clipAnalysisLineCount: gate1PromptMeta.clipAnalysisLineCount,
        },
        metadata: {
          contentType: jobSpec?.contentType || null,
          customerId: jobSpec?.customerId || null,
          source: 'lib/portals/portal1.run',
        },
      });

      const text = await callGate1GeminiStyleQa(qaPrompt);

      let parsed = tryParseGate1QaJson(text);
      if (!parsed) {
        logError(
          'PORTAL1_JSON_PARSE_FAIL',
          new Error('Portal 1 Gemini response was not valid JSON after repair attempts'),
          {
            jobId,
            portal: 1,
            head: text.slice(0, 240),
            tail: text.slice(-120),
          }
        );
        try {
          const { recordWhyLedger, FAILURE_CLASS, INTERVENTION } = require('../why_ledger');
          recordWhyLedger({
            jobId,
            portal: 'portal1',
            kind: 'gate_input_defect',
            passed: false,
            score: null,
            outcome: 'gate1_json_recovered',
            contentType: jobSpec?.contentType || jobSpec?.order?.contentType,
            customerId: jobSpec?.customerId,
            failureClass: FAILURE_CLASS.PRODUCTION_DEFECT,
            interventionType: INTERVENTION.AUTO_SCRIPT,
            reasons: [
              'Portal 1 (Gemini) returned non-JSON; neutral JSON fallback applied before scoring',
            ],
            evidenceDigest: { head: text.slice(0, 200), tail: text.slice(-100) },
            contractDigest: { showName: jobSpec?.designSpec?.voice?.showName || null },
            source: 'lib/portals/portal1.js:tryParsePortal1QaJson',
          });
        } catch (_e) {
          /* non-fatal */
        }
        parsed = { ...GATE1_QA_JSON_FALLBACK };
      }

      if (parsed.fabricationFound && parsed.examples?.length > 0 && !videoGroundingClear) {
        fabricationFail = true;
        const reason = `Commentary fabrication detected: ${parsed.examples.slice(0, 3).join('; ')}`;
        logError('PORTAL1_FABRICATION', new Error(reason), { jobId, portal: 1 });
        return {
          ...baseOutput,
          score: 0,
          outcome: 'hard_fail',
          fixDirective: {
            attempt: 1,
            committed: commit(jobSpec).committed,
            delivered: 'Script contains fabricated facts not supportable from confirmed sources',
            mismatches: [
              {
                field: 'commentary_accuracy',
                committed: 'Accurate facts only',
                delivered: reason,
                fix: 'Remove or correct fabricated claims',
              },
            ],
            nameErrors: [],
            styleViolations: hypeViolations,
            outroRequired: outroCheck.ok ? null : outroCheck.required,
          },
          upstreamContext: {
            ...upstreamContext,
            escalatedConcerns: [...upstreamContext.escalatedConcerns, reason],
          },
          completedAt: now(),
        };
      }

      // Deduct for lockedIntro mismatch (-15) — model cross-check vs local rules
      if (parsed.lockedIntroCorrect === false) {
        score -= 15;
        deductions.push({
          points: -15,
          reason: 'Locked intro text incorrect or missing (Portal 1 model verification)',
        });
      }

      // Deduct for lockedOutro mismatch (-15)
      if (parsed.lockedOutroCorrect === false) {
        score -= 15;
        deductions.push({
          points: -15,
          reason: 'Locked outro text incorrect or missing (Portal 1 model verification)',
        });
      }

      // Deduct for prohibited words found by Portal 1 model (-10 each)
      if (Array.isArray(parsed.prohibitedWordsFound) && parsed.prohibitedWordsFound.length > 0) {
        for (const word of parsed.prohibitedWordsFound.slice(0, 5)) {
          score -= 10;
          deductions.push({ points: -10, reason: `Prohibited word (Portal 1): "${word}"` });
        }
      }

      // Item accuracy issues (-10 each, capped at 3)
      if (Array.isArray(parsed.itemAccuracyIssues) && parsed.itemAccuracyIssues.length > 0) {
        for (const issue of parsed.itemAccuracyIssues.slice(0, 3)) {
          score -= 10;
          deductions.push({ points: -10, reason: `Item accuracy: ${issue}` });
        }
      }

      // Soft deduction for clip accuracy mismatches (capped at 3 to avoid over-penalizing)
      if (
        isSports &&
        Array.isArray(parsed.softAccuracyIssues) &&
        parsed.softAccuracyIssues.length > 0
      ) {
        for (const issue of parsed.softAccuracyIssues.slice(0, 3)) {
          score -= 10;
          deductions.push({ points: -10, reason: `Sports clip accuracy: ${issue}` });
        }
        logError(
          'PORTAL1_SPORTS_ACCURACY_SOFT',
          new Error(`${parsed.softAccuracyIssues.length} soft accuracy issues`),
          { jobId, portal: 1, issues: parsed.softAccuracyIssues }
        );
      }

      // Structured clip mismatches (any content type) — -15 per hard mismatch, -10 per soft
      const clipMismatches = Array.isArray(parsed.clipMismatches) ? parsed.clipMismatches : [];
      if (clipMismatches.length > 0) {
        for (const m of clipMismatches.slice(0, 3)) {
          const pts = m.severity === 'hard' ? -15 : -10;
          score += pts;
          deductions.push({
            points: pts,
            reason: `Clip ${m.clipIndex} mismatch (${m.sceneHeader || 'scene'}): script says "${(m.scriptClaim || '').substring(0, 80)}" but clip shows "${(m.clipActual || '').substring(0, 80)}"`,
            clipMismatch: m,
          });
        }
        logError(
          'PORTAL1_CLIP_MISMATCH',
          new Error(`${clipMismatches.length} clip→script mismatch(es)`),
          { jobId, portal: 1, mismatches: clipMismatches }
        );
      }

      // HARD FAIL: roster violations when confirmed ESPN data is available
      if (
        isSports &&
        Array.isArray(parsed.rosterViolations) &&
        parsed.rosterViolations.length > 0
      ) {
        const violationList = parsed.rosterViolations
          .map((v) => `"${v.playerName}" (${v.scriptContext || 'no context'})`)
          .join('; ');
        score -= 100; // hard fail
        deductions.push({
          points: -100,
          reason: `ROSTER_VIOLATION: Players not in ESPN boxscore — ${violationList}. Fix: replace with confirmed players or describe generically.`,
        });
        logError(
          'PORTAL1_ROSTER_VIOLATION',
          new Error(`${parsed.rosterViolations.length} roster violations`),
          { jobId, portal: 1, violations: parsed.rosterViolations }
        );
      }

      // Twitch: entity name errors from Gemini cross-check (-30 each — display name is brand identity)
      if (
        cTypeCheck.includes('twitch') &&
        Array.isArray(parsed.entityNameErrors) &&
        parsed.entityNameErrors.length > 0
      ) {
        for (const e of parsed.entityNameErrors.slice(0, 5)) {
          score -= 30;
          deductions.push({
            points: -30,
            reason: `ENTITY_VIOLATION (Gemini): Script uses "${e.wrong}" instead of confirmed display name "${e.correct}".`,
          });
        }
        logError(
          'PORTAL1_TWITCH_ENTITY_VIOLATION',
          new Error(`${parsed.entityNameErrors.length} entity name violations`),
          { jobId, portal: 1, violations: parsed.entityNameErrors }
        );
      }

      // News: source attribution violations from Gemini cross-check (-40 each — wrong source is a factual error)
      if (
        cTypeCheck.includes('news') &&
        Array.isArray(parsed.sourceViolations) &&
        parsed.sourceViolations.length > 0
      ) {
        for (const v of parsed.sourceViolations.slice(0, 3)) {
          score -= 40;
          deductions.push({ points: -40, reason: `SOURCE_VIOLATION (Gemini): ${v}` });
        }
        logError(
          'PORTAL1_NEWS_SOURCE_VIOLATION_GEMINI',
          new Error(`${parsed.sourceViolations.length} source violations`),
          { jobId, portal: 1, violations: parsed.sourceViolations }
        );
      }
    } catch (err) {
      logError('PORTAL1_GEMINI_API_ERROR', err, { jobId, portal: 1, model: g1Model });
      deductions.push({ points: 0, reason: 'Fabrication check skipped — Gemini Portal 1 API error' });
    }
  }

  // ── Score → action ───────────────────────────────────────────────────────
  score = Math.max(0, score);

  let outcome;
  let fixDirective = null;
  let downstreamHeadsUp = null;

  if (score >= PASS_THRESHOLD) {
    outcome = 'pass';
    downstreamHeadsUp =
      deductions.length > 0
        ? `Portal 1 passed with minor deductions: ${deductions.map((d) => d.reason).join('; ')}`
        : null;
  } else if (score >= SENDBACK_THRESHOLD) {
    outcome = 'sendback';
    const clipDiagnostic = buildClipDiagnostic(deductions, gate0ClipAnalyses);
    fixDirective = {
      attempt: 1,
      committed: commit(jobSpec).committed,
      delivered: `Script scored ${score}/100 — below pass threshold of ${PASS_THRESHOLD}`,
      mismatches: deductions.map((d) => ({
        field: d.clipMismatch ? 'clip_accuracy' : 'style',
        committed: d.clipMismatch ? `Clip ${d.clipMismatch.clipIndex} must match what Gemini saw` : 'Style compliant',
        delivered: d.reason,
        fix: d.reason,
      })),
      clipDiagnostic: clipDiagnostic.length > 0 ? clipDiagnostic : undefined,
      nameErrors,
      styleViolations: hypeViolations,
      outroRequired: outroCheck.ok ? null : outroCheck.required,
    };
    logError('PORTAL1_SENDBACK', new Error(`Score ${score} — sendback`), {
      jobId,
      portal: 1,
      score,
      deductions,
    });
    // Persist fix directive to gate_fixes table (fire-and-forget, non-fatal)
    try {
      const { saveGateFix } = require('../db');
      if (typeof saveGateFix === 'function') {
        saveGateFix(
          jobId,
          1,
          score,
          null,
          'sendback',
          `Score ${score} — ${deductions.map((d) => d.reason).join('; ')}`
        ).catch(() => {});
      }
    } catch (e) {
      /* non-fatal */
    }
  } else {
    // NBA/sports scripts can get over-penalized by stylistic deductions while still being
    // factually recoverable. Keep them in sendback flow unless fabrication was proven.
    const hasRosterViolation = deductions.some((d) => d.reason.includes('ROSTER_VIOLATION'));
    if (isSportsContent && !fabricationFail && !hasRosterViolation) {
      outcome = 'sendback';
      const clipDiagnosticSports = buildClipDiagnostic(deductions, gate0ClipAnalyses);
      fixDirective = {
        attempt: 1,
        committed: commit(jobSpec).committed,
        delivered: `Sports script scored ${score}/100 — below sendback threshold, but recoverable (non-fabrication)`,
        mismatches: deductions.map((d) => ({
          field: d.clipMismatch ? 'clip_accuracy' : 'style',
          committed: d.clipMismatch ? `Clip ${d.clipMismatch.clipIndex} must match what Gemini saw` : 'Style compliant',
          delivered: d.reason,
          fix: d.reason,
        })),
        clipDiagnostic: clipDiagnosticSports.length > 0 ? clipDiagnosticSports : undefined,
        nameErrors,
        styleViolations: hypeViolations,
        outroRequired: outroCheck.ok ? null : outroCheck.required,
      };
      logError('PORTAL1_SPORTS_SENDBACK', new Error(`Score ${score} — sports sendback`), {
        jobId,
        portal: 1,
        score,
        deductions,
      });
    } else {
      outcome = 'hard_fail';
      // Build a targeted fix directive — if roster violations found, name exactly what to replace
      const rosterViolationDeductions = deductions.filter((d) =>
        d.reason.includes('ROSTER_VIOLATION')
      );
      const rosterFixInstructions =
        rosterViolationDeductions.length > 0 && allConfirmedPlayers
          ? `ROSTER FIX REQUIRED — REWRITE ALL CLIP SCENES:\n` +
            rosterViolationDeductions.map((d) => d.reason).join('\n') +
            '\n' +
            `Confirmed players for these games:\n` +
            confirmedRosterByGame
              .map(
                (g) =>
                  `  ${g.away} vs ${g.home}: ${[...g.players]
                    .map((n) =>
                      n
                        .split(' ')
                        .map((w) => w[0].toUpperCase() + w.slice(1))
                        .join(' ')
                    )
                    .join(', ')}`
              )
              .join('\n') +
            '\n' +
            `For each CLIP scene: replace every wrong player name with a confirmed player from the list above, or describe the action generically (e.g. "Thunder guard" instead of wrong name).`
          : null;
      fixDirective = {
        attempt: 1,
        committed: commit(jobSpec).committed,
        delivered: `Script scored ${score}/100 — hard fail (below ${SENDBACK_THRESHOLD})`,
        structuralIssues: rosterFixInstructions ? [rosterFixInstructions] : [],
        mismatches: deductions.map((d) => ({
          field: d.reason.includes('ROSTER_VIOLATION') ? 'roster_accuracy' : 'style',
          committed: d.reason.includes('ROSTER_VIOLATION')
            ? 'Only confirmed ESPN players in script'
            : 'Style compliant',
          delivered: d.reason,
          fix: d.reason,
        })),
        nameErrors,
        styleViolations: hypeViolations,
        outroRequired: outroCheck.ok ? null : outroCheck.required,
      };
      logError('PORTAL1_HARD_FAIL', new Error(`Score ${score} — hard fail`), {
        jobId,
        portal: 1,
        score,
        deductions,
        rosterViolations: rosterViolationDeductions.length,
      });
      outcome = 'escalate';
    }
  }

  return {
    portal: 1,
    jobId,
    passed: outcome === 'pass',
    score,
    outcome,
    fixDirective,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: outcome === 'pass' ? ['script_style'] : [],
      escalatedConcerns:
        outcome === 'escalate'
          ? deductions.map((d) => d.reason)
          : upstreamContext.escalatedConcerns,
      downstreamHeadsUp,
    },
    completedAt: now(),
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
    const voice = getVoiceConfig(
      jobSpec?.customerId || 'c0',
      jobSpec?.order?.templateId || 'long-form'
    );
    const prohibitedWords =
      voice.prohibitedWords && voice.prohibitedWords.length > 0
        ? voice.prohibitedWords
        : DEFAULT_HYPE_WORDS;
    const outroLine =
      voice.outroLine ||
      DEFAULT_REQUIRED_OUTROS[jobSpec?.order?.formType || 'long'] ||
      DEFAULT_REQUIRED_OUTROS.long;

    // Pre-load qaThresholds
    const { passThreshold } = getThresholds(jobSpec);

    // Read locked intro from jobSpec (written by script_gen.js after scaffold generation)
    const lockedIntro = jobSpec?.designSpec?.voice?.lockedIntro;

    console.log(
      `[gate1] Ready for job ${jobId} — voice=${jobSpec?.order?.contentType || 'unknown'}, intro='${lockedIntro?.slice(0, 40) || '(none — short-form or not yet set)'}...', outro='${outroLine}', threshold=${passThreshold}`
    );
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate1] prepare() warning: ${e.message}`);
  }
}

module.exports = {
  canProduce,
  commit,
  run,
  prepare,
  buildGate1StyleQaPrompt,
  // Test/diagnostic hooks for scaffold-contract audits.
  __test_parseScriptSections: parseScriptSections,
  __test_expectedSceneHeaders: expectedSceneHeaders,
  __test_validateStructureAgainstJobSpec: validateStructureAgainstJobSpec,
  __test_buildClipDiagnostic: buildClipDiagnostic,
};
