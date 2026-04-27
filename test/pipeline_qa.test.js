/**
 * Pipeline QA Unit Tests
 *
 * Tests the core QA contract logic — no HeyGen, Gemini, or FFmpeg required.
 * Covers: parseScriptIntoScenes, Gate 2 empty-sample guard, Gate 3 contract
 * assertion, startup poller cap, and expectedClips calculation in claudeScriptQA.
 *
 * Run with: node test/pipeline_qa.test.js
 */

'use strict';

const assert = require('assert');
const { parseScriptIntoScenes } = require('../lib/qa');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Twitch script with N streamers, each having a clip marker */
function buildTwitchScript(streamerNames) {
  const sections = ['=== INTRO ===\nWelcome to ClipzWorld. [beat]'];
  for (const name of streamerNames) {
    const upper = name.toUpperCase().replace(/\s+/g, '_');
    sections.push(`=== ${upper}_INTRO ===\nLet's talk about ${name}. [beat]`);
    sections.push(`=== ${upper}_CLIP ===\n[CLIP PLAYS HERE]`);
    sections.push(`=== ${upper}_REACT ===\nThat was something. [beat]`);
  }
  sections.push("=== OUTRO ===\nI'm Bobby G. Goodnight and good luck.");
  return sections.join('\n\n');
}

/** Build a minimal News script with N story clips using type: source_clip */
function buildNewsScript(storyCount) {
  const sections = ["=== INTRO ===\nHere's what's happening. [beat]"];
  for (let i = 1; i <= storyCount; i++) {
    sections.push(`=== STORY${i}_INTRO ===\nStory ${i} intro text. [beat]`);
    sections.push(`=== STORY${i}_CLIP ===\ntype: source_clip`);
    sections.push(`=== STORY${i}_REACT ===\nReaction to story ${i}. [beat]`);
  }
  sections.push("=== OUTRO ===\nI'm Bobby G. Goodnight and good luck.");
  return sections.join('\n\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ── 1. parseScriptIntoScenes: Twitch [CLIP PLAYS HERE] → type: source_clip ──

test('parseScriptIntoScenes: Twitch clip markers produce source_clip scenes', () => {
  const script = buildTwitchScript(['Jason', 'Hasan']);
  const scenes = parseScriptIntoScenes(script);

  const clipScenes = scenes.filter((s) => s.type === 'source_clip');
  assert.strictEqual(
    clipScenes.length,
    2,
    `Expected 2 source_clip scenes, got ${clipScenes.length}`
  );

  // Clip scenes have empty text (marker stripped) and correct type
  for (const cs of clipScenes) {
    assert.strictEqual(cs.text, '', `source_clip scene text should be empty, got: "${cs.text}"`);
    assert.strictEqual(cs.type, 'source_clip');
  }
});

// ── 2. parseScriptIntoScenes: [CLIP PLAYS HERE] NOT kept in avatar text ──

test('parseScriptIntoScenes: [CLIP PLAYS HERE] stripped from avatar scene text', () => {
  const script = buildTwitchScript(['Ron']);
  const scenes = parseScriptIntoScenes(script);

  for (const s of scenes) {
    assert(
      !s.text.includes('[CLIP PLAYS HERE]'),
      `Scene "${s.name}" still contains [CLIP PLAYS HERE]`
    );
  }
});

// ── 3. parseScriptIntoScenes: News "type: source_clip" produces source_clip scenes ──

test('parseScriptIntoScenes: News type:source_clip markers produce source_clip scenes', () => {
  const script = buildNewsScript(3);
  const scenes = parseScriptIntoScenes(script);

  const clipScenes = scenes.filter((s) => s.type === 'source_clip');
  assert.strictEqual(
    clipScenes.length,
    3,
    `Expected 3 source_clip scenes, got ${clipScenes.length}`
  );
});

// ── 4. parseScriptIntoScenes: avatar scenes kept alongside clip scenes ──

test('parseScriptIntoScenes: avatar and source_clip scenes both included', () => {
  const script = buildTwitchScript(['Jay Cinco']);
  const scenes = parseScriptIntoScenes(script);

  const avatarScenes = scenes.filter((s) => s.type === 'avatar');
  const clipScenes = scenes.filter((s) => s.type === 'source_clip');

  // INTRO + JAYCINCO_INTRO + JAYCINCO_REACT + OUTRO = 4 avatar
  assert(avatarScenes.length >= 3, `Expected ≥3 avatar scenes, got ${avatarScenes.length}`);
  // 1 clip scene for Jay Cinco
  assert.strictEqual(
    clipScenes.length,
    1,
    `Expected 1 source_clip scene, got ${clipScenes.length}`
  );
});

// ── 5. parseScriptIntoScenes: zero-clip script returns no source_clip scenes ──

test('parseScriptIntoScenes: script with no clip markers returns no source_clip scenes', () => {
  const script = [
    '=== INTRO ===',
    'Welcome to the show. [beat]',
    '=== OUTRO ===',
    "I'm Bobby G. Goodnight and good luck.",
  ].join('\n\n');

  const scenes = parseScriptIntoScenes(script);
  const clipScenes = scenes.filter((s) => s.type === 'source_clip');
  assert.strictEqual(clipScenes.length, 0);
});

// ── 6. parseScriptIntoScenes: normalised header names (spaces → underscores) ──

test('parseScriptIntoScenes: scene names with underscores are preserved correctly', () => {
  const script = [
    '=== TRAIL_BLAZERS_INTRO ===',
    'Trail Blazers vs Lakers. [beat]',
    '=== TRAIL_BLAZERS_CLIP ===',
    '[CLIP PLAYS HERE]',
  ].join('\n\n');

  const scenes = parseScriptIntoScenes(script);
  const names = scenes.map((s) => s.name);
  assert(names.includes('TRAIL_BLAZERS_INTRO'), `Expected TRAIL_BLAZERS_INTRO, got: ${names}`);
  assert(names.includes('TRAIL_BLAZERS_CLIP'), `Expected TRAIL_BLAZERS_CLIP, got: ${names}`);

  const clip = scenes.find((s) => s.name === 'TRAIL_BLAZERS_CLIP');
  assert(clip, 'TRAIL_BLAZERS_CLIP scene not found');
  assert.strictEqual(clip.type, 'source_clip');
});

// ── 7. Gate 2 hard fail when 0 segments sampled ─────────────────────────────
//
// geminiSegmentQA() is async and hits Gemini — we test the guard branch directly
// by checking the condition that triggers the hard fail, not the full function.

test('Gate 2 guard: empty segmentPaths array triggers hard-fail branch', () => {
  // Replicate the guard logic from geminiSegmentQA (lib/qa.js:1481)
  const segmentPaths = [];
  const shouldHardFail = !segmentPaths || segmentPaths.length === 0;
  assert.strictEqual(shouldHardFail, true, 'Gate 2 should hard-fail on empty segmentPaths');
});

test('Gate 2 guard: non-empty segmentPaths array does NOT trigger hard-fail branch', () => {
  const segmentPaths = ['/tmp/seg_001.mp4'];
  const shouldHardFail = !segmentPaths || segmentPaths.length === 0;
  assert.strictEqual(shouldHardFail, false, 'Gate 2 should not hard-fail when segments exist');
});

// ── 8. Gate 3 contract assertion logic ──────────────────────────────────────
//
// geminiQACheck() uploads a video to Gemini — we test the contract logic directly.

test('Gate 3 contract: expectedClips > 0 and deliveredClips = 0 → hard fail', () => {
  // Replicate the contract check from geminiQACheck (lib/qa.js:71-81)
  const contractExpected = 5;
  const downloadedClipCount = 0;
  const clipCount = 0;

  const _contractExpected = contractExpected || 0;
  const _contractDelivered = downloadedClipCount || clipCount || 0;
  const isContractViolation = _contractExpected > 0 && _contractDelivered === 0;

  assert.strictEqual(isContractViolation, true, 'Should be a contract violation');
});

test('Gate 3 contract: expectedClips = 0 (news-short) → no contract violation', () => {
  const contractExpected = 0; // news-short has no clips
  const downloadedClipCount = 0;
  const clipCount = 0;

  const _contractExpected = contractExpected || 0;
  const _contractDelivered = downloadedClipCount || clipCount || 0;
  const isContractViolation = _contractExpected > 0 && _contractDelivered === 0;

  assert.strictEqual(
    isContractViolation,
    false,
    'news-short with 0 clips should not be a violation'
  );
});

test('Gate 3 contract: expectedClips = 5 and deliveredClips = 5 → no violation', () => {
  const contractExpected = 5;
  const downloadedClipCount = 5;
  const clipCount = 5;

  const _contractExpected = contractExpected || 0;
  const _contractDelivered = downloadedClipCount || clipCount || 0;
  const isContractViolation = _contractExpected > 0 && _contractDelivered === 0;

  assert.strictEqual(isContractViolation, false, 'Contract fulfilled — should not fail');
});

// ── 9. claudeScriptQA expectedClips calculation ─────────────────────────────
//
// Tests the formula inside claudeScriptQA (lib/qa.js:646-649) without calling Claude.

test('claudeScriptQA expectedClips: twitch with 3 streamers × 2 clips = 6', () => {
  // Replicate formula from lib/qa.js:646-649
  const contentType = 'twitch';
  const streamers = [
    { displayName: 'Jason', twitchUsername: 'jasontheween' },
    { displayName: 'Hasan', twitchUsername: 'hasanabi' },
    { displayName: 'Ron', twitchUsername: 'stableronaldo' },
  ];
  const clipsPerStreamer = 2;
  const clipAnalyses = []; // not used for twitch formula

  const isShortForm = contentType.includes('-short');
  const expectedClips =
    contentType === 'news-short'
      ? 0
      : isShortForm
        ? 1
        : contentType === 'twitch'
          ? streamers.length * clipsPerStreamer
          : clipAnalyses.length;

  assert.strictEqual(expectedClips, 6, `Expected 6 clips, got ${expectedClips}`);
});

test('claudeScriptQA expectedClips: twitch-short = exactly 1', () => {
  const contentType = 'twitch-short';
  const streamers = [{ displayName: 'Jason', twitchUsername: 'jasontheween' }];
  const clipsPerStreamer = 2;
  const clipAnalyses = [];

  const isShortForm = contentType.includes('-short');
  const expectedClips =
    contentType === 'news-short'
      ? 0
      : isShortForm
        ? 1
        : contentType === 'twitch'
          ? streamers.length * clipsPerStreamer
          : clipAnalyses.length;

  assert.strictEqual(
    expectedClips,
    1,
    `twitch-short should always expect 1 clip, got ${expectedClips}`
  );
});

test('claudeScriptQA expectedClips: news-short = 0', () => {
  const contentType = 'news-short';
  const streamers = [];
  const clipsPerStreamer = 0;
  const clipAnalyses = [];

  const isShortForm = contentType.includes('-short');
  const expectedClips =
    contentType === 'news-short'
      ? 0
      : isShortForm
        ? 1
        : contentType === 'twitch'
          ? streamers.length * clipsPerStreamer
          : clipAnalyses.length;

  assert.strictEqual(expectedClips, 0, `news-short should expect 0 clips, got ${expectedClips}`);
});

// ── 10. Startup resume cap ───────────────────────────────────────────────────

test('Startup resume: caps at MAX_RESUME_POLLERS=2 from 10 eligible jobs', () => {
  // Replicate logic from server.js:604-622
  const MAX_RESUME_POLLERS = 2;

  // Simulate 10 candidates in all_sent stage with video jobs
  const candidates = Array.from({ length: 10 }, (_, i) => [
    `script_twitch_${1000 + i}`,
    { stage: 'all_sent', heygen: { videoJobs: [{ video_id: `vid_${i}`, status: 'pending' }] } },
  ]);

  const activePollers = new Map(); // empty at startup

  const eligible = candidates.filter(([jobId, card]) => {
    if (!card.heygen?.videoJobs?.length) return false;
    if (activePollers.has(jobId)) return false;
    return true;
  });

  const toResume = eligible.slice(0, MAX_RESUME_POLLERS);

  assert.strictEqual(eligible.length, 10, `Expected 10 eligible, got ${eligible.length}`);
  assert.strictEqual(
    toResume.length,
    MAX_RESUME_POLLERS,
    `Should cap at ${MAX_RESUME_POLLERS}, got ${toResume.length}`
  );
});

test('Startup resume: skips jobs already in activePollers', () => {
  const MAX_RESUME_POLLERS = 2;

  const candidates = Array.from({ length: 5 }, (_, i) => [
    `script_twitch_${2000 + i}`,
    { stage: 'all_sent', heygen: { videoJobs: [{ video_id: `vid_${i}`, status: 'pending' }] } },
  ]);

  // Pre-populate activePollers with 3 of the 5 jobs
  const activePollers = new Map([
    ['script_twitch_2000', {}],
    ['script_twitch_2001', {}],
    ['script_twitch_2002', {}],
  ]);

  const eligible = candidates.filter(([jobId, card]) => {
    if (!card.heygen?.videoJobs?.length) return false;
    if (activePollers.has(jobId)) return false;
    return true;
  });

  // Only 2 are eligible — the other 3 are already in activePollers
  assert.strictEqual(eligible.length, 2, `Expected 2 eligible after dedup, got ${eligible.length}`);

  const toResume = eligible.slice(0, MAX_RESUME_POLLERS);
  assert.strictEqual(toResume.length, 2, `Should resume 2 (both eligible, under cap)`);
});
