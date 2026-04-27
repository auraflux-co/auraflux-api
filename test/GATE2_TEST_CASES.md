# Gate 2 Test Cases — parseSegments_v2 & Segment Structure Validator

**Purpose:** Concrete test cases for `parseSegments_v2()` and `gate2_validateSegmentStructure()` that Cline can use to verify the Phase 1 implementation before shipping.
**Author:** Claude Code
**Date:** 2026-04-11
**Related:** `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md`, `GATED_PIPELINE_ARCHITECTURE.md`

---

## How to use this file

When implementing Phase 1, for each test case below:

1. Set up `CURRENT_META.orderedClipUrls` with the specified placeholder URLs
2. Run `parseSegments_v2(script)` with the specified test script
3. Compare the output array against "Expected segments"
4. Run `gate2_validateSegmentStructure(result, config, 1, [])`
5. Compare the gate output against "Expected Gate 2 output"

Pass criteria: Every test case produces the expected output within 1 character of difference (whitespace tolerances OK).

**Quickest manual verification:** open DevTools console on the dashboard, load `cwn_production.html`, and paste each test case script into the test runner I'll describe at the bottom of this file.

---

## Test Case 1 — Happy path: 1 streamer × 2 clips (Style B script)

**Setup:**

```javascript
window.CURRENT_META = {
  streamers: ['jasontheween'],
  orderedClipUrls: [
    {
      url: 'http://test.mp4/clip1',
      pageUrl: 'https://twitch.tv/jasontheween/clip/A',
      duration: 30,
    },
    {
      url: 'http://test.mp4/clip2',
      pageUrl: 'https://twitch.tv/jasontheween/clip/B',
      duration: 25,
    },
  ],
  clipMp4Urls: {},
};
```

**Test script:**

```
=== INTRO ===
Hello everyone! You are tuning into Twitch Soup brought to you by ClipzWorld News. Where we appreciate our favorite streamers on Twitch. I am your host Bobby G. Let's get to it.

=== JASON_INTRO ===
First up tonight, we have Jason, who often finds himself in unique virtual situations. He always manages to make things interesting in his streams.
[beat]
Follow Jason. Link in description.
[beat]

=== JASON_CLIP1_SETUP ===
Here we see his cat-eared avatar in a maid outfit, holding a large skewer. He's really leaning into the role.
[beat]
[CLIP PLAYS HERE]
[beat]

=== JASON_CLIP1_REACTION ===
That is certainly a choice of virtual attire.

=== JASON_CLIP2_SETUP ===
Speaking of interesting choices, Jason often dives into VR social games. You never know what kind of interactions he will have.
[beat]
[CLIP PLAYS HERE]
[beat]

=== JASON_CLIP2_REACTION ===
He certainly made some friends in there.

=== OUTRO ===
Well everybody, that does it for another edition of Twitch Soup. Don't forget to like, comment, share and subscribe.
[beat]
Appreciate you!
```

**Expected segments (exactly 9):**

| #   | type        | label                      | clipUrl / text preview                   |
| --- | ----------- | -------------------------- | ---------------------------------------- |
| 0   | avatar      | INTRO                      | "Hello everyone! You are tuning into..." |
| 1   | avatar      | JASON_INTRO                | "First up tonight, we have Jason..."     |
| 2   | avatar      | JASON_CLIP1_SETUP          | "Here we see his cat-eared avatar..."    |
| 3   | source_clip | JASON_CLIP1_SETUP (CLIP 1) | `http://test.mp4/clip1`                  |
| 4   | avatar      | JASON_CLIP1_REACTION       | "That is certainly a choice..."          |
| 5   | avatar      | JASON_CLIP2_SETUP          | "Speaking of interesting choices..."     |
| 6   | source_clip | JASON_CLIP2_SETUP (CLIP 2) | `http://test.mp4/clip2`                  |
| 7   | avatar      | JASON_CLIP2_REACTION       | "He certainly made some friends..."      |
| 8   | avatar      | OUTRO                      | "Well everybody, that does it..."        |

**Expected Gate 2 output:**

```json
{
  "gateName": "gate2_segment_structure",
  "passed": true,
  "score": 100,
  "outcome": "pass",
  "diagnosis": [],
  "fixStrategies": [],
  "rollbackTo": null
}
```

**Critical checks:**

- `segments.length === 9`
- `segments.filter(s => s.type === 'avatar').length === 7`
- `segments.filter(s => s.type === 'source_clip').length === 2`
- NO segment has the label `JASON_CLIP1_SETUP (INTRO)` or `(REACTION 1)` (those are v1 artifacts)
- `segments[3].clipUrl === 'http://test.mp4/clip1'` (first clip maps to first orderedClipUrls entry)
- `segments[6].clipUrl === 'http://test.mp4/clip2'`

---

## Test Case 2 — Edge case: 1 streamer × 1 clip (the currently-failing smoke test)

This is THE test case that was producing "scenes out of order" for days. Must pass cleanly after Gate 2 ships.

**Setup:**

```javascript
window.CURRENT_META = {
  streamers: ['jasontheween'],
  orderedClipUrls: [
    {
      url: 'http://test.mp4/clip1',
      pageUrl: 'https://twitch.tv/jasontheween/clip/A',
      duration: 30,
    },
  ],
  clipMp4Urls: {},
};
```

**Test script:**

```
=== INTRO ===
Hello everyone! Tuning into Twitch Soup. I am your host Bobby G.

=== JASON_INTRO ===
First up tonight, Jason. He makes virtual choices.
[beat]
Follow Jason.
[beat]

=== JASON_CLIP1_SETUP ===
Here we see Jason in a VR setting.
[beat]
[CLIP PLAYS HERE]
[beat]

=== JASON_CLIP1_REACTION ===
That happened.

=== OUTRO ===
Well everyone, that does it.
[beat]
Appreciate you!
```

**Expected segments (exactly 5):**

| #   | type        | label                                      |
| --- | ----------- | ------------------------------------------ |
| 0   | avatar      | INTRO                                      |
| 1   | avatar      | JASON_INTRO                                |
| 2   | avatar      | JASON_CLIP1_SETUP                          |
| 3   | source_clip | JASON_CLIP1_SETUP (CLIP 1)                 |
| 4   | avatar      | JASON_CLIP1_REACTION                       |
| —   | —           | (OUTRO should be here too, making 6 total) |

**Correction:** 5 scenes in this script produce **6 segments** (5 avatar + 1 source_clip). Let me recount:

INTRO (1) + JASON_INTRO (1) + JASON_CLIP1_SETUP (1 avatar + 1 source_clip = 2) + JASON_CLIP1_REACTION (1) + OUTRO (1) = **6 segments** (5 avatar + 1 source_clip).

**Expected Gate 2 output:** `passed: true, score: 100`

**Critical check for this test:** this is the case that v1 was producing 11 segments for (with 1-second zombie fragments and duplicate labels). v2 must produce exactly 6.

---

## Test Case 3 — Catches v1 output (Gate 2 rejects bad input)

This tests that Gate 2 correctly identifies the parseSegments_v1 bug pattern and proposes rollback.

**Setup:** same as Test Case 2.

**How to run:**

```javascript
// Temporarily call v1 to get the buggy output
var v1Segments = parseSegments_v1(testScriptFromTestCase2);
// v1 should produce ~7-8 segments with zombie fragments and suffixed labels

// Run Gate 2 on the buggy v1 output
var gate2Result = gate2_validateSegmentStructure(
  v1Segments,
  {
    contentType: 'twitch',
    streamers: ['jasontheween'],
    clipsPerStreamer: 1,
  },
  1,
  []
);

console.log(gate2Result);
```

**Expected Gate 2 output:**

```json
{
  "passed": false,
  "score": <60,
  "outcome": "fail_fix_in_place",
  "diagnosis": [
    {
      "severity": "critical",
      "kind": "segment_count_mismatch",
      "issue": "Expected 6 segments, got 7" (or similar)
    },
    {
      "severity": "critical",
      "kind": "duplicate_labels",
      "issue": "Duplicate segment labels detected: JASON_CLIP1_SETUP (INTRO) and/or similar"
    }
  ],
  "fixStrategies": [
    {
      "id": "reparse_with_v2",
      "confidence": 0.6
    },
    {
      "id": "rollback_to_gate1_regenerate",
      "confidence": 0.8
    }
  ],
  "rollbackTo": "gate1"
}
```

**Critical check:** Gate 2 must report AT LEAST ONE of `segment_count_mismatch` or `duplicate_labels` or `empty_avatar_segment` when fed v1 output. Otherwise the validator has holes.

---

## Test Case 4 — 5 streamers × 3 clips (full production case)

Tests scalability. This is the structure of Test 1 in `test/test_suite_12cases.json`.

**Setup:**

```javascript
window.CURRENT_META = {
  streamers: ['jasontheween', 'hasanabi', 'adapt', 'stableronaldo', 'lacy'],
  orderedClipUrls: [
    // 15 placeholder URLs (5 streamers × 3 clips)
    { url: 'http://test.mp4/clip1', pageUrl: '', duration: 30 },
    { url: 'http://test.mp4/clip2', pageUrl: '', duration: 30 },
    { url: 'http://test.mp4/clip3', pageUrl: '', duration: 30 },
    // ... (generate 15 total)
  ],
};
```

**Expected segment count:**

```
1 (INTRO) + 5 × (1 + 3 × 3) + 1 (OUTRO) = 1 + 5 × 10 + 1 = 52 segments
```

Of those: `5 × (1 + 3 × 2) + 2 = 37` avatar + `5 × 3 = 15` source_clip = **52 total**.

Wait, let me recount the Twitch pattern:

- 1 INTRO (avatar)
- Per streamer: 1 STREAMER_INTRO (avatar) + 3 × (1 SETUP avatar + 1 CLIP source + 1 REACTION avatar) = 1 + 9 = 10 segments
- 1 OUTRO (avatar)
- Total per test: 1 + 5 × 10 + 1 = **52 segments**
- Avatar count: 1 + 5 × (1 + 3 × 2) + 1 = 1 + 35 + 1 = **37 avatar**
- Clip count: 5 × 3 = **15 source_clip**
- Sanity check: 37 + 15 = 52 ✅

**Expected Gate 2 pattern check:** the buildTwitchExpectedPattern helper should produce an array of 52 labels in correct order. Gate 2 verifies position-by-position.

---

## Test Case 5 — NBA long-form (5 games)

**Setup:**

```javascript
window.CURRENT_META = {
  contentType: 'nba',
  games: [
    { home: 'Lakers', away: 'Celtics', score: '112-108' },
    { home: 'Warriors', away: 'Nets', score: '125-118' },
    { home: 'Heat', away: 'Bucks', score: '103-99' },
    { home: 'Suns', away: 'Mavericks', score: '118-115' },
    { home: 'Nuggets', away: 'Clippers', score: '122-110' },
  ],
  orderedClipUrls: [
    /* 5 placeholder URLs */
  ],
};
```

**Expected segment count:**

```
1 (INTRO) + 5 × (1 SETUP + 1 CLIP + 1 REACTION) + 1 (OUTRO) = 1 + 15 + 1 = 17 segments
```

- 12 avatar (1 INTRO + 5 SETUP + 5 REACTION + 1 OUTRO)
- 5 source_clip

**Note:** NBA doesn't have a separate GAME_INTRO scene between INTRO and the first SETUP. Some older code may have assumed it does — this test case catches that.

---

## Test Case 6 — News long-form (5 stories)

Same structure as NBA Test Case 5 — 1 INTRO + 5 × (SETUP + CLIP + REACTION) + 1 OUTRO = 17 segments.

Verify `buildNbaNewsExpectedPattern(items, 'news')` produces the correct pattern with STORY1_SETUP, STORY2_SETUP, etc. (not GAME1_SETUP).

---

## Test Case 7 — Empty streamer (edge case)

**Setup:** streamers array with one streamer who returned zero clips.

**Expected:** Gate 2 should detect `clip_count_mismatch` (expected 2, got 0) OR a `missing_clip_url` issue per clip segment. Either is valid.

**Fix strategy:** Gate 2 proposes rolling back to Gate 1 with "regenerate with fewer streamers" OR "retry clip resolution".

---

## Test Case 8 — Oversized script (OUTRO > HEYGEN_CHAR_LIMIT)

**Setup:** script with an OUTRO that's 2500 characters (exceeds HEYGEN_CHAR_LIMIT of 1400).

**Expected:** parseSegments_v2 truncates the OUTRO to 1400 chars and sets `truncated: true`. Gate 2 should PASS (truncation is acceptable, not a structural issue). The truncated: true flag is for Gate 1's awareness.

---

## Test Case 9 — Script with NO clip markers (pure avatar)

**Setup:** A news-short script with 3 stories but NO `[CLIP PLAYS HERE]` markers (just avatar narration).

**Expected:**

- parseSegments_v2 produces N avatar segments with 0 source_clips
- Gate 2 checks that `clipCount === 0` matches expected (which should be 0 for this content type if configured correctly)

**Edge case:** if the config says `clipsPerStreamer=1` but the script has no clip markers, Gate 2 should flag `clip_count_mismatch`.

---

## Test Case 10 — Script with MALFORMED header (missing ===)

**Setup:** script where one scene header is `== INTRO ==` (2 equals instead of 3).

**Expected:**

- parseSegments_v2 fails to recognize the malformed header as a section boundary
- Result: one section containing both the malformed-header line AND the intended content of the next section
- Gate 2 should detect either `segment_count_mismatch` OR `segment_order_mismatch` (depending on which check fires first)

**Fix strategy:** rollback to Gate 1 (regenerate script from Gemini with explicit header format constraint).

---

## Test Runner (paste into DevTools console)

Once parseSegments_v2 and gate2_validateSegmentStructure are implemented, paste this into the browser DevTools Console on `cwn_production.html` to run all 10 test cases:

```javascript
function runGate2Tests() {
  var results = [];

  // Test Case 1 — 1 streamer × 2 clips happy path
  var tc1Script = `=== INTRO ===
Hello everyone! You are tuning into Twitch Soup brought to you by ClipzWorld News.
=== JASON_INTRO ===
First up tonight, we have Jason, who often finds himself in unique virtual situations.
[beat]
Follow Jason.
[beat]
=== JASON_CLIP1_SETUP ===
Here we see his cat-eared avatar in a maid outfit.
[beat]
[CLIP PLAYS HERE]
[beat]
=== JASON_CLIP1_REACTION ===
That is certainly a choice.
=== JASON_CLIP2_SETUP ===
Speaking of interesting choices, VR social games.
[beat]
[CLIP PLAYS HERE]
[beat]
=== JASON_CLIP2_REACTION ===
He made friends.
=== OUTRO ===
Well everybody. Appreciate you!`;

  window.CURRENT_META = {
    streamers: [{ twitchUsername: 'jasontheween', displayName: 'Jason' }],
    orderedClipUrls: [
      { url: 'http://test.mp4/clip1', pageUrl: '', duration: 30 },
      { url: 'http://test.mp4/clip2', pageUrl: '', duration: 25 },
    ],
    clipMp4Urls: {},
  };

  var tc1Result = parseSegments_v2(tc1Script);
  var tc1Pass =
    tc1Result.length === 9 &&
    tc1Result.filter(function (s) {
      return s.type === 'avatar';
    }).length === 7 &&
    tc1Result.filter(function (s) {
      return s.type === 'source_clip';
    }).length === 2;
  results.push({ name: 'TC1: 1×2 happy path', pass: tc1Pass, segments: tc1Result.length });

  var tc1Gate = gate2_validateSegmentStructure(
    tc1Result,
    {
      contentType: 'twitch',
      streamers: [{ twitchUsername: 'jasontheween' }],
      clipsPerStreamer: 2,
    },
    1,
    []
  );
  results.push({
    name: 'TC1: Gate 2 PASS',
    pass: tc1Gate.passed === true,
    outcome: tc1Gate.outcome,
  });

  // Test Case 2 — 1×1 (the stuck smoke test case)
  var tc2Script = tc1Script.replace(
    /=== JASON_CLIP2_SETUP ===[\s\S]*?=== JASON_CLIP2_REACTION ===\nHe made friends\.\n/,
    ''
  );
  window.CURRENT_META.orderedClipUrls = [
    { url: 'http://test.mp4/clip1', pageUrl: '', duration: 30 },
  ];
  var tc2Result = parseSegments_v2(tc2Script);
  var tc2Pass = tc2Result.length === 6;
  results.push({ name: 'TC2: 1×1 edge case', pass: tc2Pass, segments: tc2Result.length });

  // Print results
  console.table(results);
  var passCount = results.filter(function (r) {
    return r.pass;
  }).length;
  console.log('Passed: ' + passCount + ' / ' + results.length);
  return results;
}

// Run:
runGate2Tests();
```

---

## Success criteria for Phase 1 ship

Cline's Gate 2 implementation ships when:

- [ ] Test Case 1 produces exactly 9 segments
- [ ] Test Case 2 produces exactly 6 segments (the former 11-segment zombie bug is gone)
- [ ] Test Case 3 catches parseSegments_v1 output with at least one critical issue
- [ ] Test Cases 5 and 6 (NBA and News) produce 17 segments each
- [ ] Test Case 7 detects clip shortage
- [ ] Test Case 10 detects malformed headers
- [ ] Browser-console test runner passes all test cases
- [ ] E2E smoke test: Jason 2-clip dashboard flow produces 9 segments in correct order with clean assembly

---

_This file is spec, not executable code. Cline can run these tests manually via the browser console or turn them into a formal test suite using jest/mocha if desired. The minimum bar is manual verification before commit._
