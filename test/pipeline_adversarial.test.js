/**
 * Pipeline Adversarial Tests
 *
 * Simulates real failure scenarios observed in production jobs.
 * Each test encodes an actual failure mode — the inputs reflect what happened,
 * and the assertion catches what the system did (or should have done).
 *
 * No external services: no Gemini, HeyGen, or FFmpeg calls.
 *
 * Run with: node test/pipeline_adversarial.test.js
 *
 * ── OBSERVED FAILURES (logs/errors.jsonl 2026-04-17) ──────────────────────
 *
 * F1  GATE3_QA_ERROR_FALLBACK — "downloadedClipCount is not defined"
 *     Gate 3 threw a ReferenceError, catch block auto-passed at 70/100,
 *     video uploaded to Drive with no real QA. Happened 8× in one session.
 *
 * F2  NBA 0-clip Gate 3 100/100 pass
 *     filename: "nba_..._10_avatar_0_cli_0clips_...mp4"
 *     contractExpectedClips was 0 (NBA expected no clips?), Gemini watched
 *     avatar-only and gave 100/100. Video was content-empty.
 *
 * F3  Gate 2 freeze-frame segment passed as MANUAL REVIEW
 *     Middle segment had VIDEO FREEZE (score 20). First=100, last=95.
 *     Avg = 72 → threshold 85 = MANUAL not hard fail.
 *     Job still proceeded after manual approval with a broken segment.
 *
 * F4  Gate 3 contract: expectedClips=5, downloadedClipCount passed as
 *     undefined (because variable declared inside an inner block).
 *     Contract check: `undefined || 0 = 0` → treated as 0 delivered → hard fail.
 *     But the catch-block auto-pass fired BEFORE contract ran → no fail at all.
 *
 * F5  contractExpectedClips defaults to 0 when /assemble payload missing it.
 *     If dashboard sends assemblyPayload without expectedClips (older job cards),
 *     the contract never fires — Gate 3 becomes a no-op catch on 0-clip videos.
 *
 * F6  Gate 2 avg score masked a freeze-frame segment.
 *     One freeze (score 20) averaged with two clean segments (100, 95) = 72.
 *     A single freeze-frame segment should hard-fail Gate 2 regardless of avg.
 *
 * F7  "TS normalize failed on segment N: TS convert failed: 255" → crash at 45%
 *     Assembly crashed mid-run because FFmpeg exit code 255 (Docker container
 *     couldn't write to the output path). No retry — job dead at 45%.
 *
 * F8  parseScriptIntoScenes drops scenes whose names contain spaces (before fix).
 *     Gemini wrote "=== JAY CINCO_INTRO ===" → sceneRegex `[A-Za-z_0-9]+`
 *     stopped at the space → only captured "JAY" → wrong name → scene dropped.
 *     Confirmed by scene count: 60 before fix, 85 after.
 */

'use strict';

const assert = require('assert');
const { parseScriptIntoScenes } = require('../lib/qa');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replicate the Gate 3 contract check from lib/qa.js:71-81.
 * Returns { violated, score, outcome } — mirrors the real return shape.
 */
function runContractCheck({ expectedClips, downloadedClipCount, clipCount }) {
  const _contractExpected  = expectedClips || 0;
  const _contractDelivered = downloadedClipCount || clipCount || 0;
  const violated = _contractExpected > 0 && _contractDelivered === 0;
  return violated
    ? { violated: true,  score: 0,   outcome: 'fail' }
    : { violated: false, score: null, outcome: null   };
}

/**
 * Replicate the Gate 3 error-fallback from lib/assembly.js:2800-2812.
 * If qaErr is thrown and retries exhausted, returns auto-pass at 70.
 */
function runGate3WithErrorFallback(qaFn, MAX_QA_RETRIES = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_QA_RETRIES; attempt++) {
    try {
      return qaFn();
    } catch (e) {
      lastErr = e;
    }
  }
  // Matches assembly.js:2806 — auto-pass fallback
  return { score: 70, outcome: 'pass', passed: true, report: `QA check errored: ${lastErr.message} (auto-passed)` };
}

/**
 * Replicate Gate 2 average-score calculation from lib/qa.js:geminiSegmentQA.
 * Returns { score, outcome }.
 */
function computeGate2Result(scores, PASS_THRESHOLD = 85, MANUAL_THRESHOLD = 65) {
  if (!scores || scores.length === 0) {
    return { score: 0, outcome: 'fail', outcomeLabel: '❌ HARD FAIL — no segments' };
  }
  const avg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
  const outcome = avg >= PASS_THRESHOLD  ? 'pass'
                : avg >= MANUAL_THRESHOLD ? 'manual_review'
                : 'fail';
  return { score: avg, outcome };
}

// ── F1: Gate 3 error-fallback auto-pass ──────────────────────────────────────

test('F1 — Gate 3 error fallback: ReferenceError auto-passes at 70/100', () => {
  // Simulates "downloadedClipCount is not defined" crashing Gate 3 3×
  // Catch block must auto-pass, not rethrow or hard-fail.
  const result = runGate3WithErrorFallback(() => {
    // Simulate the real error: variable used before it was in scope
    const val = (() => { throw new ReferenceError('downloadedClipCount is not defined'); })();
    return { score: val, outcome: 'pass' };
  });

  assert.strictEqual(result.outcome, 'pass',  'Fallback should be outcome=pass');
  assert.strictEqual(result.score,   70,       'Fallback score should be exactly 70');
  assert(result.report.includes('auto-passed'), 'Report should mention auto-passed');
});

test('F1b — Gate 3 error fallback: passes even after exactly MAX_QA_RETRIES failures', () => {
  let callCount = 0;
  const result = runGate3WithErrorFallback(() => {
    callCount++;
    throw new Error('gemini upload failed');
  }, 3);

  assert.strictEqual(callCount, 3, 'Should have attempted exactly 3 times');
  assert.strictEqual(result.outcome, 'pass');
  assert.strictEqual(result.score, 70);
});

// ── F2: NBA 0-clip Gate 3 bypassed because contractExpectedClips was 0 ──────

test('F2 — NBA 0-clip bypass: contractExpectedClips=0 means no contract check fires', () => {
  // This is what happened: NBA job card had expectedClips=0 (not persisted correctly),
  // so Gate 3 contract check never triggered even though 0 clips were in the video.
  const result = runContractCheck({ expectedClips: 0, downloadedClipCount: 0 });

  assert.strictEqual(result.violated, false,
    'Contract should NOT fire when expectedClips=0 — but this lets 0-clip NBA videos through');

  // Confirm: if it HAD been set correctly (e.g. NBA with 3 games = 3 clips),
  // the contract WOULD have caught it.
  const corrected = runContractCheck({ expectedClips: 3, downloadedClipCount: 0 });
  assert.strictEqual(corrected.violated, true,
    'Contract MUST fire when expectedClips=3 and 0 clips delivered');
});

test('F2b — NBA: missing expectedClips field in payload defaults to 0 (silent bypass)', () => {
  // In assembly.js:873, destructuring uses `expectedClips: contractExpectedClips = 0`
  // If the dashboard sends a payload without expectedClips, it silently defaults to 0.
  const payload = {
    segments: ['seg1.mp4'], contentType: 'nba', jobId: 'script_nba_123'
    // expectedClips intentionally missing — older job card
  };

  const contractExpectedClips = payload.expectedClips ?? 0; // mirrors assembly.js:873
  assert.strictEqual(contractExpectedClips, 0,
    'Missing expectedClips in payload defaults to 0 — Gate 3 contract is silently disabled');
});

// ── F3: Gate 2 freeze-frame masked by average ─────────────────────────────────

test('F3 — Gate 2: freeze-frame middle segment (score 20) masked by avg → manual_review not hard fail', () => {
  // Exact scores from gate2_segments_manual_review_1776412854484.txt
  const segmentScores = [100, 20, 95]; // first=100 (corrected), middle=20 (freeze), last=95

  const result = computeGate2Result(segmentScores);

  assert.strictEqual(result.score, 72,           'Avg of [100,20,95] should be 72');
  assert.strictEqual(result.outcome, 'manual_review', 'Should be manual_review, not hard fail');

  // The problem: a 100% freeze-frame segment did NOT trigger a hard fail.
  // Current system uses average — a single VIDEO FREEZE at 20 is diluted.
  // A score of 20 for VIDEO FREEZE should arguably hard-fail Gate 2 alone.
  const FREEZE_HARD_FAIL_THRESHOLD = 50; // if any single segment scores below this, hard fail
  const hasFreezeFail = segmentScores.some(s => s < FREEZE_HARD_FAIL_THRESHOLD);
  assert.strictEqual(hasFreezeFail, true,
    'At least one segment scored below 50 — individual freeze detection is needed');
});

test('F3b — Gate 2: all-clean segments correctly auto-pass', () => {
  const result = computeGate2Result([100, 95, 98]);
  assert.strictEqual(result.outcome, 'pass');
  assert(result.score >= 85);
});

test('F3c — Gate 2: all-broken segments correctly hard-fail', () => {
  const result = computeGate2Result([20, 30, 25]);
  assert.strictEqual(result.outcome, 'fail');
  assert(result.score < 65);
});

// ── F4: Contract check blind spot when downloadedClipCount is undefined ──────

test('F4 — Contract check: undefined downloadedClipCount coerces to 0 via || chain', () => {
  // In lib/qa.js:72: `const _contractDelivered = downloadedClipCount || clipCount || 0`
  // If assembly crashes before setting downloadedClipCount, the variable might be
  // passed as undefined to geminiQACheck. undefined || 0 = 0 → contract fires.
  let downloadedClipCount; // declared but never assigned — simulates scope bug

  const _contractExpected  = 5;
  const _contractDelivered = downloadedClipCount || 0; // mirrors qa.js:72

  assert.strictEqual(_contractDelivered, 0,
    'undefined coerces to 0 via || — contract check sees 0 delivered');

  // This means: if expectedClips=5 and downloadedClipCount is undefined,
  // the contract correctly hard-fails (good behavior, but only if Gate 3 runs at all).
  const violated = _contractExpected > 0 && _contractDelivered === 0;
  assert.strictEqual(violated, true,
    'Contract should catch undefined downloadedClipCount as 0-clip delivery');
});

test('F4b — Contract blind spot: when Gate 3 errors first, contract never runs', () => {
  // The real failure chain: Gate 3 errors ("downloadedClipCount is not defined"),
  // catch block auto-passes, contract assertion never gets to execute.
  // We simulate this ordering: error fires, auto-pass fires, contract is skipped.

  let contractChecked = false;

  const result = runGate3WithErrorFallback(() => {
    // This throws before contract check runs — simulates the production bug
    throw new ReferenceError('downloadedClipCount is not defined');
    // Contract logic below is unreachable
    contractChecked = true; // eslint-disable-line no-unreachable
  });

  assert.strictEqual(contractChecked, false,
    'Contract assertion never ran — error fallback fired first');
  assert.strictEqual(result.outcome, 'pass',
    'Auto-pass fired despite 0-clip delivery — this is the production failure mode');
});

// ── F5: expectedClips not on job card for older jobs ─────────────────────────

test('F5 — Job card missing expectedClips: contract disabled for legacy jobs', () => {
  // Simulates a job card that was persisted before expectedClips was added.
  // When assembly reads it and sends to /assemble, the payload lacks the field.
  const legacyJobCard = {
    jobId: 'script_twitch_old_123',
    stage: 'all_sent',
    heygen: { videoJobs: [] },
    contentType: 'twitch',
    // expectedClips is absent — written before the contract field was added
  };

  const contractExpectedClips = legacyJobCard.expectedClips ?? 0;
  const contractCheck = runContractCheck({ expectedClips: contractExpectedClips, downloadedClipCount: 0 });

  assert.strictEqual(contractExpectedClips, 0, 'Legacy card has no expectedClips — defaults to 0');
  assert.strictEqual(contractCheck.violated, false,
    'Legacy job silently bypasses Gate 3 contract — clips field was never written to card');
});

// ── F6: Single freeze-frame should hard-fail Gate 2 (design gap) ─────────────

test('F6 — Gate 2 design gap: min-score check catches what avg hides', () => {
  // Current code uses avg. This test defines what a min-score guard would catch.
  // If added to geminiSegmentQA, a single freeze (score ≤ 30) would hard-fail Gate 2.
  const scores = [100, 20, 95]; // real scores from production freeze-frame job

  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length); // 72
  const minScore = Math.min(...scores); // 20

  const FREEZE_THRESHOLD = 30; // if any segment is at or below this, it's a freeze

  const wouldPassByAvg = avg >= 65; // above manual_review threshold
  const wouldCatchByMin = minScore <= FREEZE_THRESHOLD;

  assert.strictEqual(wouldPassByAvg,   true,  'Avg (72) clears manual_review threshold — job proceeds');
  assert.strictEqual(wouldCatchByMin,  true,  'Min-score check (20) would catch the freeze-frame');

  // Confirms: the current avg-based Gate 2 cannot catch a single freeze-frame segment
  // when the other segments are clean. A min-score guard would catch it.
});

// ── F7: parseScriptIntoScenes: space in header name truncates scene name ─────

test('F7 — parseScriptIntoScenes: space in header makes scene completely invisible (pre-fix behavior)', () => {
  // Before commit 93aa22f, Gemini sometimes wrote "=== JAY CINCO_INTRO ==="
  // sceneRegex `[A-Za-z_0-9]+` requires a name with NO spaces.
  // A header with a space produces ZERO regex matches — the entire scene vanishes.
  // This caused scene counts like 60 instead of 72 — silent drop, no error.

  const rawScript = `=== JAY CINCO_INTRO ===\nLet's talk about Jay. [beat]\n\n=== JAY CINCO_CLIP ===\n[CLIP PLAYS HERE]`;

  // The parser regex (lib/qa.js:478) — unchanged, we feed it the raw (un-normalized) script
  const oldRegex = /===\s*([A-Za-z_0-9]+)\s*===/g;
  const names = [];
  let m;
  while ((m = oldRegex.exec(rawScript)) !== null) names.push(m[1]);

  // Pre-fix: spaces in header = 0 matches. Both scenes are invisible to the parser.
  assert.strictEqual(names.length, 0,
    'Pre-fix: space in header produces NO regex match — scene is completely invisible');

  // Consequence: parseScriptIntoScenes returns an empty array for this script
  const scenes = parseScriptIntoScenes(rawScript);
  assert.strictEqual(scenes.length, 0,
    'parseScriptIntoScenes returns empty — Jay Cinco\'s scenes are silently dropped');
});

test('F7b — parseScriptIntoScenes: post-fix normalization prevents name truncation', () => {
  // Post-fix (commit 93aa22f): output-level normalization converts spaces to underscores
  // before parseScriptIntoScenes runs. Test that normalized script parses correctly.
  const geminiOutput = `=== JAY CINCO_INTRO ===\nLet's talk about Jay. [beat]\n\n=== JAY CINCO_CLIP ===\n[CLIP PLAYS HERE]`;

  // Apply the normalization from server.js:6519-6528
  const normalized = geminiOutput.replace(/===\s+([^=]+?)\s+===/g, (match, name) => {
    const n = name.trim().replace(/\s+/g, '_');
    return `=== ${n} ===`;
  });

  const scenes = parseScriptIntoScenes(normalized);
  const names = scenes.map(s => s.name);

  assert(names.includes('JAY_CINCO_INTRO'), `Expected JAY_CINCO_INTRO, got: ${names}`);
  assert(names.includes('JAY_CINCO_CLIP'),  `Expected JAY_CINCO_CLIP, got: ${names}`);

  const clipScene = scenes.find(s => s.name === 'JAY_CINCO_CLIP');
  assert(clipScene, 'JAY_CINCO_CLIP scene must exist');
  assert.strictEqual(clipScene.type, 'source_clip');
});

// ── F8: Gate 3 contract: downloadedClipCount=0 but contractExpectedClips via ||chain ──

test('F8 — Contract: clipCount fallback used when downloadedClipCount is 0', () => {
  // From lib/qa.js:72: `downloadedClipCount || clipCount || 0`
  // If downloadedClipCount=0 (0 clips downloaded) but clipCount=5 (requested),
  // the || chain uses clipCount=5 as delivered — contract does NOT fire.
  // This is a silent bypass: 0 clips actually in the video, but contract sees 5.
  const downloadedClipCount = 0; // real: nothing downloaded
  const clipCount = 5;           // requested count (not delivered)

  const _contractDelivered = downloadedClipCount || clipCount || 0;
  assert.strictEqual(_contractDelivered, 5,
    'clipCount fallback masks 0-clip delivery — contract never fires');

  const violated = 5 > 0 && _contractDelivered === 0;
  assert.strictEqual(violated, false,
    'Contract does NOT fire — 5 clips appear delivered even though 0 were downloaded');

  // The fix: use downloadedClipCount directly, not clipCount as fallback.
  // clipCount = "requested", downloadedClipCount = "actually in the file" — different things.
  const properCheck = downloadedClipCount === 0 && 5 > 0;
  assert.strictEqual(properCheck, true,
    'Proper check: downloadedClipCount=0 with expectedClips=5 is a contract violation');
});

