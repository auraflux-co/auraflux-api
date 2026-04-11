# Cline Handoff: Gate 2 — Segment Structure QA + parseSegments_v2

**Author:** Claude Code
**Date:** 2026-04-11
**Status:** 🚨 CRITICAL — blocks all smoke testing until shipped
**Priority:** Phase 1 of the Gated Self-Healing Pipeline (see `GATED_PIPELINE_ARCHITECTURE.md`)
**Estimated effort:** 4-6 hours Cline work, single atomic commit

---

## Why this handoff exists

For the past several days, smoke tests have been producing videos with wrong scene ordering, duplicated labels, zombie 1-second segments, and missing clip content. Each test reveals the same family of bugs. The root cause is in `parseSegments()` (`cwn_production.html:3186-3298`), which over-splits CLIP_SETUP sections into 3 sub-segments when Gemini writes scripts with SEPARATE CLIP_REACTION headers.

This handoff does three things:

1. **Diagnoses the root cause** of the `parseSegments` bug in detail so future agents understand it
2. **Provides a complete `parseSegments_v2()` implementation** that Cline can copy-paste with minor adaptation
3. **Adds Gate 2 as a pure-code validator** that catches segment structure bugs automatically going forward — first concrete implementation of the Gated Pipeline architecture

By the end of this handoff, the pipeline will have its first self-healing gate, and the current smoke test ordering bug will be fixed AND protected against regression forever.

**Read `GATED_PIPELINE_ARCHITECTURE.md` first before implementing this.** This handoff assumes you understand the 9 principles and the Gate Output Contract.

---

## Part 1 — Root cause analysis of the `parseSegments` bug

### What Gemini produces

Gemini writes Twitch compilation scripts in "Style B" — each scene has its own `=== HEADER ===` marker:

```
=== INTRO ===
Hello everyone! You are tuning into Twitch Soup...

=== JASON_INTRO ===
First up tonight, we have Jason...
[beat]
Follow Jason. Link in description.
[beat]

=== JASON_CLIP1_SETUP ===
Here we see his cat-eared avatar in a maid outfit...
[beat]
[CLIP PLAYS HERE]
[beat]

=== JASON_CLIP1_REACTION ===
That happened.

=== JASON_CLIP2_SETUP ===
Next we see Jason in a VR social game...
[beat]
[CLIP PLAYS HERE]
[beat]

=== JASON_CLIP2_REACTION ===
He made friends.

=== OUTRO ===
Well everybody, that does it for another edition...
Appreciate you!
```

**Expected segment count:** 1 (INTRO) + 1 (JASON_INTRO) + 2 × (1 SETUP + 1 CLIP + 1 REACTION) + 1 (OUTRO) = **9 segments**, of which 2 are `source_clip` and 7 are `avatar`.

### What `parseSegments_v1` actually produces

The v1 parser splits on `=== HEADER ===` first (producing 7 rawSections), then for EACH section that contains `[CLIP PLAYS HERE]`, splits AGAIN on the clip marker and creates 3 sub-segments from that single section:
- avatar fragment for the text BEFORE the clip marker
- the source_clip itself
- avatar fragment for the text AFTER the clip marker

**But in Style B scripts**, the text AFTER the `[CLIP PLAYS HERE]` marker is just `[beat]` with maybe an empty line — because Gemini wrote the reaction in a SEPARATE `=== JASON_CLIP1_REACTION ===` scene, not inline after the clip.

Result: v1 produces this 11-segment array for a 7-header script:

| # | Label | Source | Problem |
|---|---|---|---|
| 0 | INTRO | Real | OK |
| 1 | JASON_INTRO | Real | OK |
| 2 | JASON_CLIP1_SETUP (INTRO) | Real | **Weird "(INTRO)" suffix added by v1** |
| 3 | JASON_CLIP1_SETUP (CLIP 1) | Real | Source clip (OK) |
| 4 | JASON_CLIP1_SETUP (REACTION 1) | **Zombie fragment** | Empty-ish text from after the clip marker |
| 5 | JASON_CLIP1_REACTION | Real | **Duplicate — real reaction** |
| 6 | JASON_CLIP2_SETUP (INTRO) | Real | Weird suffix again |
| 7 | JASON_CLIP2_SETUP (CLIP 2) | Real | Source clip (OK) |
| 8 | JASON_CLIP2_SETUP (REACTION 1) | **Zombie fragment** | Empty text |
| 9 | JASON_CLIP2_REACTION | Real | **Duplicate** |
| 10 | OUTRO | Real | OK |

The zombie fragments (indices 4 and 8) are either:
- **Short text (~1-5 words)** → filtered out by the `wc >= 5` gate inside v1, leaving a hole in the array
- **Medium text (~5-15 words)** → KEPT as a real segment, creating a visible duplicate

And **the "(INTRO)" / "(REACTION 1)" label suffixes cause the downstream filename rendering to produce bizarre filenames** like `asm_<id>_2_jason_clip1_setup_intro_.mp4` (notice the trailing underscore from the "(INTRO)" → "intro_" conversion), making the intermediate files confusing and the concat behavior unpredictable.

### Evidence from the 2026-04-11 01:30 smoke test

```
asm_1775885391051_0_intro.mp4                                8s   (JASON_INTRO fragment)
asm_1775885391051_1_jason_intro.mp4                         16s   (real JASON_INTRO)
asm_1775885391051_1_jason_intro_intro_burned.mp4            16s   (duplicate of above, with intro card burn)
asm_1775885391051_2_jason_clip1_setup_intro_.mp4            16s   ← "(INTRO)" suffix bug
asm_1775885391051_3_jason_clip1_setup_clip_1_.mp4           26s   (real Twitch clip)
asm_1775885391051_4_jason_clip1_reaction.mp4                 1s   ← 1 second = zombie fragment kept
asm_1775885391051_5_outro.mp4                               11s
```

**That 1-second reaction file is NOT the real JASON_CLIP1_REACTION scene.** It's the zombie fragment from splitting the setup section. The real reaction got... lost, skipped, or filtered out somewhere in the process. Hence "scenes out of order" and "black screen at reaction."

This was a 1-clip smoke test. At 2+ clips, the bug is still present but less visible because there are more segments to mask the issue. **v1 has been producing wrong output in every single smoke test since it shipped.** The reason it "mostly worked" for 2+ clips is luck, not correctness.

### Why this has been a "days-long struggle"

Because the bug is statistical. At N=2 clips, maybe 3 out of 4 runs produce viewable output because the zombie fragments happen to be short enough to filter out. At N=3, maybe 1 out of 4 runs has a visible issue. You'd blame the bug on "Gemini being inconsistent" or "HeyGen rendering differently" or "some FFmpeg filter issue" — when the actual cause was always the same: v1 is splitting sections it shouldn't split.

The bug is invisible until someone (Rob) runs a 1-streamer 1-clip smoke test, where the statistical masking breaks down and the bug is maximally exposed. That's what happened in this session.

---

## Part 2 — The fix: `parseSegments_v2()`

### Design principle

**One `=== HEADER ===` section = exactly one avatar segment (plus one source_clip if the section contains `[CLIP PLAYS HERE]`).** Never split a section into multiple sub-segments. Trust Gemini's scene structure.

If Gemini writes a SETUP section with a clip marker followed by more text, treat the entire section's text (minus the `[CLIP PLAYS HERE]` marker line itself) as the setup's avatar script. Extra text after the clip marker is part of the setup, not a zombie reaction.

The REACTION content lives in its own `=== CLIP1_REACTION ===` section. v2 trusts this.

### The code

Here is the complete `parseSegments_v2()` function. Drop it into `cwn_production.html` near the existing `parseSegments`.

```javascript
// ─────────────────────────────────────────────────────────────────────
// parseSegments_v2 — single segment per === HEADER === section
// ─────────────────────────────────────────────────────────────────────
//
// Fixes the "scenes out of order" bug by NEVER splitting a section into
// sub-segments. Each === HEADER === produces exactly one avatar segment
// (and one source_clip if the section contains [CLIP PLAYS HERE]).
//
// Key differences from v1:
// - Labels match Gemini's headers exactly (no "(INTRO)" / "(REACTION 1)" suffixes)
// - Text before AND after [CLIP PLAYS HERE] in a single section is combined
//   into one avatar segment — no zombie fragments
// - Global clipInsertIdx counter assigns clips in order across all sections
// - Deterministic output: N streamers × M clips → exactly
//   1 + N × (1 + M × 2) + 1 segments for Twitch (matches QA_GATES expected)
//
// Returns: array of { type, label, text, wordCount, estSecs, truncated,
//                     clipUrl?, pageUrl?, clipDuration?, status? }
//
function parseSegments_v2(script) {
  var clean = script.replace(/\/\/[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim();
  var lines = clean.split('\n');
  var rawSections = [];
  var cur = { label: '', lines: [] };

  // Phase 1: Split script into raw sections by === HEADER === markers
  lines.forEach(function(line) {
    var m = line.match(/===\s*(.+?)\s*===/);
    if (m) {
      if (cur.label || cur.lines.length) rawSections.push(cur);
      cur = { label: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  });
  if (cur.label || cur.lines.length) rawSections.push(cur);

  // Phase 2: Process each section as a single logical unit
  var result = [];
  var orderedUrls = (window.CURRENT_META && window.CURRENT_META.orderedClipUrls) || [];
  var mp4Map = (window.CURRENT_META && window.CURRENT_META.clipMp4Urls) || {};
  var clipInsertIdx = 0;  // Global counter for clip position

  rawSections.forEach(function(sec) {
    if (!sec.label) return;

    var fullText = sec.lines.join('\n');
    var hasClipMarker = /\[CLIP PLAYS HERE[^\]]*\]/i.test(fullText);

    // Extract avatar text: remove [CLIP PLAYS HERE] marker line, keep everything else
    // (including [beat] markers — HeyGen converts them to pauses)
    var avatarText = cleanAvatarText(
      fullText.replace(/\[CLIP PLAYS HERE[^\]]*\]/gi, '').trim()
    );

    // Emit the avatar segment for this section
    // (unless the text is empty or extremely short — in that case, skip and log)
    if (avatarText) {
      var wc = avatarText.split(/\s+/).filter(Boolean).length;
      if (wc >= 3) {
        // 3-word minimum (down from 5 in v1) because outro/short reactions can be "Appreciate you!" = 2 words
        // Gate 2 will catch truly broken segments with stricter checks
        result.push({
          type: 'avatar',
          label: sec.label,
          text: avatarText,
          wordCount: wc,
          estSecs: Math.round((wc / 130) * 60),
          truncated: false
        });
      } else {
        console.warn('[parseSegments_v2] Skipping ' + sec.label + ' — only ' + wc + ' words, too short');
      }
    }

    // If this section contains a clip marker, emit the source_clip AFTER the avatar segment
    if (hasClipMarker) {
      var clipUrl = '';
      var clipDuration = null;
      var pageUrl = '';

      if (orderedUrls[clipInsertIdx]) {
        clipUrl = orderedUrls[clipInsertIdx].url || '';
        clipDuration = orderedUrls[clipInsertIdx].duration || null;
        pageUrl = orderedUrls[clipInsertIdx].pageUrl || '';
      } else {
        console.warn('[parseSegments_v2] No clip URL for clipInsertIdx=' + clipInsertIdx +
                     ' (section: ' + sec.label + ')');
      }

      // Resolve MP4 URL if we have a mapping
      if (clipUrl && mp4Map[clipUrl]) {
        clipUrl = mp4Map[clipUrl];
      }

      result.push({
        type: 'source_clip',
        label: sec.label + ' (CLIP ' + (clipInsertIdx + 1) + ')',
        clipUrl: clipUrl,
        pageUrl: pageUrl,
        clipDuration: clipDuration,
        status: 'ready'
      });

      clipInsertIdx++;
    }
  });

  // Phase 3: Enforce HeyGen char limit on avatar segments
  result.forEach(function(seg) {
    if (seg.type !== 'avatar') return;
    if (seg.text && seg.text.length > HEYGEN_CHAR_LIMIT) {
      seg.text = seg.text.slice(0, HEYGEN_CHAR_LIMIT);
      seg.truncated = true;
    }
  });

  console.log('[parseSegments_v2] Produced ' + result.length + ' segments (' +
              result.filter(function(s){return s.type==='avatar'}).length + ' avatar + ' +
              result.filter(function(s){return s.type==='source_clip'}).length + ' source_clip)');

  return result;
}
```

### A/B switch pattern

Do NOT delete `parseSegments_v1` yet. Add a config flag at the top of the file:

```javascript
// Feature flag: true = use v2 (fixed), false = use v1 (legacy, buggy)
// Flip to false only if v2 causes unexpected regressions in production
var USE_PARSE_SEGMENTS_V2 = true;
```

Then wrap the callers:

```javascript
function parseSegments(script) {
  if (USE_PARSE_SEGMENTS_V2) {
    return parseSegments_v2(script);
  } else {
    return parseSegments_v1(script);
  }
}
```

Rename the current `parseSegments(script)` at line 3186 to `parseSegments_v1(script)`. Add the new wrapper above.

This gives us:
- Default behavior: v2 (fixed)
- Emergency rollback: flip `USE_PARSE_SEGMENTS_V2` to false (no code revert needed)
- Both versions live in the codebase for easy diffing and learning
- Delete v1 after 10 successful production runs with v2 (will be tracked as Phase 8 in architecture doc)

---

## Part 3 — Gate 2: Segment Structure Validator

This is the first concrete implementation of the Gated Pipeline architecture. It's pure code (no Gemini), fast, and deterministic. It catches the `parseSegments` bug class automatically.

### Where Gate 2 runs

**Client-side only for Phase 1.** Gate 2 runs in `cwn_production.html` immediately after `parseSegments()` produces the segment array, BEFORE the dashboard sends segments to HeyGen. Rationale:
- Zero server round-trip cost for the check
- Catches bugs before HeyGen credits are spent
- Easy to wire into the existing `generateVideo()` flow

A server-side mirror of Gate 2 can be added later in Phase 3 for defense-in-depth, but Phase 1 is client-only.

### The code

Add this function to `cwn_production.html`, near `parseSegments_v2()`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// Gate 2 — Segment Structure QA (pure code)
// ─────────────────────────────────────────────────────────────────────
//
// Validates the output of parseSegments() against the expected structure
// for the given content type and config. Returns a Gate Output Contract
// JSON object describing any issues found, proposed fix strategies, and
// rollback/escalation guidance.
//
// This is the FIRST gate of the Gated Self-Healing Pipeline architecture.
// See GATED_PIPELINE_ARCHITECTURE.md for the full spec.
//
// Arguments:
//   segments        — array from parseSegments()
//   config          — { contentType, streamers, clipsPerStreamer }
//   attemptNumber   — 1 for first attempt, increments on retry
//   attemptHistory  — [] initially; populated on retry with prior attempts
//
// Returns: Gate Output Contract JSON (see architecture doc)
//
function gate2_validateSegmentStructure(segments, config, attemptNumber, attemptHistory) {
  var issues = [];
  var fixStrategies = [];
  var jobId = (window._currentJobId) || ('job_' + Date.now());
  var timestamp = new Date().toISOString();

  // ── Calculate expected structure ──────────────────────────────────
  var N = (config.streamers || []).length;
  var M = config.clipsPerStreamer || 2;
  var expectedSegmentCount, expectedClipCount, expectedPattern;

  if (config.contentType === 'twitch') {
    // Twitch: 1 INTRO + N × (1 STREAMER_INTRO + M × (1 SETUP + 1 CLIP + 1 REACTION)) + 1 OUTRO
    expectedSegmentCount = 1 + N * (1 + M * 3) + 1;
    expectedClipCount = N * M;
    expectedPattern = buildTwitchExpectedPattern(config.streamers, M);
  } else if (config.contentType === 'nba' || config.contentType === 'news') {
    // NBA/News: 1 INTRO + N × (1 SETUP + 1 CLIP + 1 REACTION) + 1 OUTRO
    expectedSegmentCount = 1 + N * 3 + 1;
    expectedClipCount = N;
    expectedPattern = buildNbaNewsExpectedPattern(config.streamers, config.contentType);
  } else if ((config.contentType || '').indexOf('-short') > -1) {
    // Short-form: simpler structure
    expectedSegmentCount = 1 + N * 2 + 1;
    expectedClipCount = N;
    expectedPattern = null; // short-form skip pattern check for now
  }

  var actualAvatarCount = segments.filter(function(s) { return s.type === 'avatar'; }).length;
  var actualClipCount = segments.filter(function(s) { return s.type === 'source_clip'; }).length;

  // ── Check 1: Segment count matches expected ──────────────────────
  if (segments.length !== expectedSegmentCount) {
    issues.push({
      severity: 'critical',
      kind: 'segment_count_mismatch',
      issue: 'Expected ' + expectedSegmentCount + ' segments, got ' + segments.length,
      evidence: 'Config: ' + N + ' streamers × ' + M + ' clips = ' + expectedSegmentCount + ' expected. Got: ' + actualAvatarCount + ' avatar + ' + actualClipCount + ' source_clip = ' + segments.length + ' total.',
      impact: 'Pipeline will produce a video with wrong number of segments — either missing scenes or duplicate/zombie fragments.'
    });
  }

  // ── Check 2: Source clip count matches expected ──────────────────
  if (actualClipCount !== expectedClipCount) {
    issues.push({
      severity: 'critical',
      kind: 'clip_count_mismatch',
      issue: 'Expected ' + expectedClipCount + ' source clips, got ' + actualClipCount,
      evidence: 'Script generated ' + actualClipCount + ' [CLIP PLAYS HERE] insertions, but config expects ' + expectedClipCount + ' (N=' + N + ' × M=' + M + ').',
      impact: 'Some Twitch clips will be missing from the final video OR the script contains extra clip markers that have no matching URL.'
    });
  }

  // ── Check 3: No duplicate labels ─────────────────────────────────
  var labelCounts = {};
  segments.forEach(function(s) {
    labelCounts[s.label] = (labelCounts[s.label] || 0) + 1;
  });
  var duplicates = Object.keys(labelCounts).filter(function(l) { return labelCounts[l] > 1; });
  if (duplicates.length > 0) {
    issues.push({
      severity: 'critical',
      kind: 'duplicate_labels',
      issue: 'Duplicate segment labels detected: ' + duplicates.join(', '),
      evidence: duplicates.map(function(l) { return l + ' (×' + labelCounts[l] + ')'; }).join('; '),
      impact: 'FFmpeg intermediate filenames will collide or be ambiguous; scene ordering becomes unreliable.'
    });
  }

  // ── Check 4: No empty/too-short avatar segments ──────────────────
  segments.forEach(function(s, i) {
    if (s.type !== 'avatar') return;
    var wc = (s.text || '').trim().split(/\s+/).filter(Boolean).length;
    if (wc < 3) {
      issues.push({
        severity: 'critical',
        kind: 'empty_avatar_segment',
        issue: 'Segment ' + i + ' (' + s.label + ') has only ' + wc + ' words',
        evidence: 'Text: "' + (s.text || '(empty)') + '"',
        impact: 'HeyGen will render a near-empty avatar clip (~1-2 seconds), breaking video pacing.'
      });
    }
  });

  // ── Check 5: Every source_clip has a URL ─────────────────────────
  segments.forEach(function(s, i) {
    if (s.type !== 'source_clip') return;
    if (!s.clipUrl) {
      issues.push({
        severity: 'critical',
        kind: 'missing_clip_url',
        issue: 'Source clip at index ' + i + ' (' + s.label + ') has no clipUrl',
        evidence: 'CURRENT_META.orderedClipUrls may not have been populated before parseSegments ran, OR the clipInsertIdx overflowed the orderedClipUrls array.',
        impact: 'FFmpeg will fail to download this clip and the segment will be skipped, causing scene count mismatch.'
      });
    }
  });

  // ── Check 6: Segment order matches expected pattern ──────────────
  if (expectedPattern) {
    var actualPattern = segments.map(function(s) {
      return s.type === 'source_clip' ? '<CLIP>' : s.label;
    });
    for (var i = 0; i < Math.min(expectedPattern.length, actualPattern.length); i++) {
      if (expectedPattern[i] !== actualPattern[i]) {
        issues.push({
          severity: 'critical',
          kind: 'segment_order_mismatch',
          issue: 'Position ' + i + ': expected "' + expectedPattern[i] + '", got "' + actualPattern[i] + '"',
          evidence: 'Expected sequence: [' + expectedPattern.join(', ') + ']. Actual sequence: [' + actualPattern.join(', ') + ']',
          impact: 'Scenes will play in wrong order, breaking the script narrative.'
        });
        break; // One order mismatch is enough to fail — no need to list every position
      }
    }
  }

  // ── Determine outcome and fix strategies ─────────────────────────
  var passed = issues.length === 0;
  var score = Math.max(0, 100 - issues.length * 20);
  var outcome, rollbackTo;

  if (passed) {
    outcome = 'pass';
    rollbackTo = null;
  } else {
    // Determine the best fix strategy based on the issues found
    var hasStructuralIssue = issues.some(function(issue) {
      return issue.kind === 'segment_count_mismatch' ||
             issue.kind === 'duplicate_labels' ||
             issue.kind === 'empty_avatar_segment' ||
             issue.kind === 'segment_order_mismatch';
    });

    var hasClipIssue = issues.some(function(issue) {
      return issue.kind === 'clip_count_mismatch' || issue.kind === 'missing_clip_url';
    });

    if (hasStructuralIssue) {
      // Strategy 1: Re-parse with v2 (if v1 was used by mistake)
      fixStrategies.push({
        id: 'reparse_with_v2',
        description: 'Re-run parseSegments with parseSegments_v2 explicitly (in case v1 was used by legacy code path)',
        confidence: 0.6,
        action: {
          type: 'fix_in_place',
          function: 'parseSegments_v2',
          args: { script: 'current_script' }
        },
        estimatedDuration: '1s',
        reasoning: 'If the segments came from parseSegments_v1, re-parsing with v2 should produce the correct structure. Low-cost first try.'
      });

      // Strategy 2: Rollback to Gate 1 — re-request script from Gemini
      fixStrategies.push({
        id: 'rollback_to_gate1_regenerate',
        description: 'Rollback to Gate 1 and regenerate the script from Gemini with reinforced structure constraints',
        confidence: 0.8,
        action: {
          type: 'rollback',
          targetGate: 'gate1',
          params: {
            reason: 'segment_structure_invalid',
            issues: issues.map(function(i) { return i.kind; })
          }
        },
        estimatedDuration: '60s',
        reasoning: 'If re-parsing with v2 does not resolve, the script itself may have unusual structure (e.g., missing headers). Regenerating from Gemini should produce a correctly-structured script.'
      });

      outcome = 'fail_fix_in_place'; // Try v2 re-parse first
      rollbackTo = 'gate1';
    } else if (hasClipIssue) {
      // Clip URL missing — try re-resolving clips
      fixStrategies.push({
        id: 'reresolve_clip_urls',
        description: 'Re-resolve Twitch clip URLs via CURRENT_META.orderedClipUrls (may have been not populated yet)',
        confidence: 0.7,
        action: {
          type: 'fix_in_place',
          function: 'resolveTwitchClipUrls',
          args: { clips: 'orderedClipUrls' }
        },
        estimatedDuration: '10s',
        reasoning: 'If clip URLs are missing, the CURRENT_META.orderedClipUrls array may have been empty when parseSegments ran. Re-resolving should populate it.'
      });

      outcome = 'fail_fix_in_place';
      rollbackTo = null;
    }
  }

  // ── Build Gate Output Contract ───────────────────────────────────
  return {
    gateName: 'gate2_segment_structure',
    jobId: jobId,
    timestamp: timestamp,
    attemptNumber: attemptNumber || 1,
    passed: passed,
    score: score,
    outcome: outcome,
    diagnosis: issues,
    fixStrategies: fixStrategies,
    rollbackTo: rollbackTo,
    escalationCriteria: 'If parseSegments_v2 re-parse fails AND regenerate from Gate 1 produces the same issues, escalate to Rob with the full segment array and script. Rob should inspect manually and either fix the script OR flag a structural bug in Gemini prompts.',
    learningNote: issues.length > 0 ?
      'Detected ' + issues.length + ' structural issues at Gate 2. Most common: ' + (issues[0] && issues[0].kind) + '. ' +
      'If this pattern repeats across multiple jobs, consider tightening Gemini prompts or deleting parseSegments_v1 entirely.'
      : null,
    attemptHistory: attemptHistory || []
  };
}

// ─── Helper: build expected Twitch pattern ───────────────────────────
function buildTwitchExpectedPattern(streamers, clipsPerStreamer) {
  var pattern = ['INTRO'];
  (streamers || []).forEach(function(s) {
    var sName = (typeof s === 'string' ? s : (s.twitchUsername || s.username || s.displayName || '')).toUpperCase().replace(/\s+/g, '_');
    pattern.push(sName + '_INTRO');
    for (var c = 1; c <= clipsPerStreamer; c++) {
      pattern.push(sName + '_CLIP' + c + '_SETUP');
      pattern.push('<CLIP>');
      pattern.push(sName + '_CLIP' + c + '_REACTION');
    }
  });
  pattern.push('OUTRO');
  return pattern;
}

// ─── Helper: build expected NBA/News pattern ────────────────────────
function buildNbaNewsExpectedPattern(items, contentType) {
  var pattern = ['INTRO'];
  (items || []).forEach(function(item, i) {
    var prefix = (contentType === 'nba' ? 'GAME' : 'STORY') + (i + 1);
    pattern.push(prefix + '_SETUP');
    pattern.push('<CLIP>');
    pattern.push(prefix + '_REACTION');
  });
  pattern.push('OUTRO');
  return pattern;
}

// ─── Helper: log to gate_fixes.jsonl ────────────────────────────────
function logGateFix(gateOutput, strategyTriedId, strategyResult) {
  var logEntry = {
    timestamp: new Date().toISOString(),
    jobId: gateOutput.jobId,
    gate: gateOutput.gateName,
    attemptNumber: gateOutput.attemptNumber,
    strategyTriedId: strategyTriedId,
    strategyResult: strategyResult,
    priorDiagnosis: gateOutput.diagnosis.map(function(d) { return d.kind; }),
    priorScore: gateOutput.score,
    learningNote: gateOutput.learningNote
  };
  var xhr = new XMLHttpRequest();
  xhr.open('POST', CFG.ffmpegUrl + '/gate-fix-log', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify(logEntry));
}
```

### Where to call Gate 2

In `generateVideo()` or wherever `parseSegments()` is called right before sending to HeyGen, add:

```javascript
var segments = parseSegments(script);

// Run Gate 2 validation
var gate2Result = gate2_validateSegmentStructure(segments, {
  contentType: CURRENT_TYPE,
  streamers: (CURRENT_META && CURRENT_META.streamers) || [],
  clipsPerStreamer: parseInt((g('twitch-clips-per-main') && g('twitch-clips-per-main').value) || '2')
}, 1, []);

if (!gate2Result.passed) {
  // Display the gate output to Rob and try fix strategies
  handleGate2Failure(segments, gate2Result, script);
  return; // Don't proceed to HeyGen until Gate 2 passes
}

// Gate 2 passed, proceed to HeyGen
displayGate2Pass(gate2Result);
// ... existing HeyGen send logic
```

### The fix loop (`handleGate2Failure`)

This is the dialogue loop that implements Principle 9:

```javascript
function handleGate2Failure(segments, gateOutput, script) {
  console.warn('[gate2] FAIL:', gateOutput);
  cwn_log('❌ Gate 2 failed with ' + gateOutput.diagnosis.length + ' issues. Trying fix strategies...', false);

  // Display structured failure to Rob in dashboard
  displayGate2FailureUI(gateOutput);

  // Try each fix strategy in confidence order
  var strategies = (gateOutput.fixStrategies || []).slice().sort(function(a, b) {
    return (b.confidence || 0) - (a.confidence || 0);
  });

  if (strategies.length === 0) {
    escalateToRob(gateOutput, 'No fix strategies available');
    return;
  }

  var topStrategy = strategies[0];
  cwn_log('🔧 Gate 2 attempting fix: ' + topStrategy.id + ' (confidence ' + topStrategy.confidence + ')', false);

  // Execute the strategy
  executeGate2FixStrategy(topStrategy, segments, script, function(newSegments, err) {
    if (err) {
      cwn_log('❌ Strategy ' + topStrategy.id + ' failed: ' + err.message, true);
      logGateFix(gateOutput, topStrategy.id, 'fail');
      // Try the next strategy or escalate
      tryNextStrategy(segments, gateOutput, script, strategies.slice(1));
      return;
    }

    // Re-run Gate 2 with the new segments and updated attempt history
    var newHistory = (gateOutput.attemptHistory || []).concat([{
      attemptNumber: gateOutput.attemptNumber,
      strategyTried: topStrategy.id,
      resultOutcome: 'retry_pending',
      timestampTried: gateOutput.timestamp
    }]);

    var newGateOutput = gate2_validateSegmentStructure(newSegments, {
      contentType: CURRENT_TYPE,
      streamers: (CURRENT_META && CURRENT_META.streamers) || [],
      clipsPerStreamer: parseInt((g('twitch-clips-per-main') && g('twitch-clips-per-main').value) || '2')
    }, (gateOutput.attemptNumber || 1) + 1, newHistory);

    if (newGateOutput.passed) {
      cwn_log('✅ Gate 2 PASS after fix: ' + topStrategy.id, false);
      logGateFix(newGateOutput, topStrategy.id, 'pass');
      // Proceed to HeyGen with the fixed segments
      proceedToHeyGen(newSegments);
    } else {
      cwn_log('⚠️ Gate 2 still failing after ' + topStrategy.id + ', trying next strategy', true);
      logGateFix(newGateOutput, topStrategy.id, 'fail');
      // Loop: re-run with the NEW diagnosis (may suggest new strategies)
      handleGate2Failure(newSegments, newGateOutput, script);
    }
  });
}

function executeGate2FixStrategy(strategy, segments, script, callback) {
  if (strategy.action.type === 'fix_in_place') {
    if (strategy.action.function === 'parseSegments_v2') {
      var newSegments = parseSegments_v2(script);
      callback(newSegments, null);
      return;
    }
    if (strategy.action.function === 'resolveTwitchClipUrls') {
      // Re-resolve clip URLs via existing dashboard function
      // (existing dashboard code already has this)
      resolveTwitchClipUrls(window.CURRENT_META.orderedClipUrls || [], function() {
        var newSegments = parseSegments(script);
        callback(newSegments, null);
      });
      return;
    }
  } else if (strategy.action.type === 'rollback') {
    if (strategy.action.targetGate === 'gate1') {
      // Regenerate script from Gemini — call the existing Twitch generate flow
      cwn_log('↩ Rolling back to Gate 1 (regenerating script)...', false);
      regenScript(); // Existing function that re-calls the appropriate generate*()
      callback(null, new Error('Rollback in progress — pipeline will re-run from Gate 1'));
      return;
    }
  }
  callback(null, new Error('Unknown strategy action: ' + strategy.action.type));
}

function tryNextStrategy(segments, gateOutput, script, remaining) {
  if (remaining.length === 0) {
    escalateToRob(gateOutput, 'All fix strategies exhausted');
    return;
  }
  var newOutput = Object.assign({}, gateOutput, { fixStrategies: remaining });
  handleGate2Failure(segments, newOutput, script);
}

function escalateToRob(gateOutput, reason) {
  cwn_log('🚨 ESCALATING to Rob: ' + reason, true);
  displayGate2EscalationUI(gateOutput, reason);
  // Mark the job as escalated in the dashboard
}
```

### Dashboard UI for Gate 2 failure display

Add a new panel to show Gate 2 failure details. This replaces the current "silent failure" behavior where bugs land in the MP4 without any indication something was wrong.

```javascript
function displayGate2FailureUI(gateOutput) {
  var panel = document.createElement('div');
  panel.className = 'gate2-failure-panel';
  panel.innerHTML =
    '<h3 style="color:#e74c3c;">Gate 2: Segment Structure FAIL (score ' + gateOutput.score + '/100)</h3>' +
    '<div class="diagnosis">' +
      gateOutput.diagnosis.map(function(issue) {
        return '<div class="issue-' + issue.severity + '">' +
          '<strong>' + issue.kind + ':</strong> ' + issue.issue + '<br>' +
          '<small>' + issue.evidence + '</small><br>' +
          '<em>Impact:</em> ' + issue.impact +
          '</div>';
      }).join('') +
    '</div>' +
    '<div class="fix-strategies">' +
      '<h4>Attempted fix strategies:</h4>' +
      gateOutput.fixStrategies.map(function(s) {
        return '<div>• ' + s.description + ' (confidence ' + s.confidence + ')</div>';
      }).join('') +
    '</div>';

  // Insert into the dashboard near the script editor
  var target = document.getElementById('gate2-panel-container') || document.querySelector('.script-editor');
  if (target) target.appendChild(panel);
}

function displayGate2Pass(gateOutput) {
  cwn_log('✅ Gate 2 PASS (' + gateOutput.score + '/100) — ' + /* segment counts */, false);
}

function displayGate2EscalationUI(gateOutput, reason) {
  // Similar to failure UI but with bold "ESCALATED" badge and "Manual Override" button
  // User can click "Manual Override" to force-advance past Gate 2
}
```

---

## Part 4 — Server-side support (`/gate-fix-log` endpoint)

Add a tiny server endpoint to receive Gate 2 fix logs and persist them to `logs/gate_fixes.jsonl`. This is the foundation of the learning record system.

In `server.js`, add near the existing utility endpoints (around line 894 where `GET /jobs` lives):

```javascript
// POST /gate-fix-log — append a Gate fix attempt to logs/gate_fixes.jsonl
// Called by gates when they finish an attempt (pass or fail).
// Part of the Gated Self-Healing Pipeline (see GATED_PIPELINE_ARCHITECTURE.md).
app.post('/gate-fix-log', (req, res) => {
  try {
    const logEntry = req.body || {};
    if (!logEntry.gate || !logEntry.jobId) {
      return res.status(400).json({ ok: false, error: 'Missing gate or jobId' });
    }
    const logPath = path.join(__dirname, 'logs', 'gate_fixes.jsonl');
    const line = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(logPath, line);
    res.json({ ok: true });
  } catch (e) {
    console.error('[gate-fix-log] Failed to append:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

Make sure `logs/` directory exists (it already does per prior commits). Add `logs/gate_fixes.jsonl` to gitignore if you want it scoped to local runtime state.

---

## Part 5 — Test plan

### Test 1 — Unit test for parseSegments_v2

Create a simple smoke test that exercises `parseSegments_v2` with a hand-written 7-scene 2-clip Jason script and verifies it produces exactly 9 segments.

```javascript
// In browser console or a test page:
var testScript = `=== INTRO ===
Hello everyone! You are tuning into Twitch Soup brought to you by ClipzWorld News.
=== JASON_INTRO ===
First up tonight, we have Jason.
[beat]
Follow Jason. Link in description.
[beat]
=== JASON_CLIP1_SETUP ===
Here we see his cat-eared avatar in a maid outfit.
[beat]
[CLIP PLAYS HERE]
[beat]
=== JASON_CLIP1_REACTION ===
That happened.
=== JASON_CLIP2_SETUP ===
Next we see Jason in a VR social game.
[beat]
[CLIP PLAYS HERE]
[beat]
=== JASON_CLIP2_REACTION ===
He made friends.
=== OUTRO ===
Appreciate you!`;

// Mock CURRENT_META with placeholder clip URLs
window.CURRENT_META = {
  orderedClipUrls: [
    { url: 'http://test.mp4/clip1', pageUrl: '', duration: 30 },
    { url: 'http://test.mp4/clip2', pageUrl: '', duration: 25 }
  ],
  clipMp4Urls: {}
};

var result = parseSegments_v2(testScript);
console.log('Segments:', result.length);  // should be exactly 9
console.log('Labels:', result.map(function(s) { return s.label; }));
// Expected labels:
//   INTRO
//   JASON_INTRO
//   JASON_CLIP1_SETUP
//   JASON_CLIP1_SETUP (CLIP 1)
//   JASON_CLIP1_REACTION
//   JASON_CLIP2_SETUP
//   JASON_CLIP2_SETUP (CLIP 2)
//   JASON_CLIP2_REACTION
//   OUTRO
```

### Test 2 — Gate 2 catches the v1 bug

Run Gate 2 on the output of `parseSegments_v1` with the same test script. Expected: Gate 2 FAILS with `segment_count_mismatch` (11 vs 9) and `duplicate_labels` (JASON_CLIP1_SETUP appears twice).

### Test 3 — End-to-end smoke test

Run the Jason 2-clip smoke test through the full dashboard:
1. Wipe `data/jobs.json` and browser localStorage
2. Clear dashboard queue
3. Generate Twitch with Jason only, 2 clips
4. Wait for Gate 1 (may still fail due to the separate clip-analysis truncation bug — use FORCE ADVANCE if it does)
5. **Confirm Gate 2 runs and passes** — dashboard should show "Gate 2 PASS (100/100)" in logs
6. Send to HeyGen — should produce exactly 7 avatar segments + 2 source clips = 9 files
7. Assemble — should produce a clean MP4 with scenes in correct order
8. Verify visually: INTRO → JASON_INTRO → SETUP1 → CLIP1 → REACTION1 → SETUP2 → CLIP2 → REACTION2 → OUTRO

### Test 4 — Verify learning log is written

After Test 3, check `logs/gate_fixes.jsonl` exists and contains one entry:
```bash
tail -1 logs/gate_fixes.jsonl
```
Should show a JSON object with `gate: "gate2_segment_structure"`, `strategyResult: "pass"` (or similar).

---

## Part 6 — Why this works (teaching section)

This is the "teaching content" required by Principle 7. Future agents reading this handoff should understand not just WHAT to do but WHY.

### Why pure code at Gate 2 instead of Gemini

Gate 2's checks are all deterministic — counting segments, comparing strings, checking for duplicates. A human could do them with a spreadsheet. Adding Gemini here would be slower, more expensive, and less reliable. Gates should use AI judgment only when the decision requires reasoning about subjective quality (does the avatar look right? is the pacing good?). Segment structure is objective.

### Why the global clipInsertIdx counter

The v1 bug partially stemmed from trying to track clip positions per-section. The v2 approach uses a global counter: the Nth `[CLIP PLAYS HERE]` in the script gets mapped to the Nth entry in `CURRENT_META.orderedClipUrls`, regardless of which section it appears in. This is simpler, deterministic, and matches how the clips were originally resolved (all flattened into one ordered list).

### Why we don't delete parseSegments_v1 immediately

A/B switch pattern gives us a 1-line rollback path if v2 causes unexpected regressions. Once v2 has been used for 10+ successful production runs, we can delete v1. This is defensive coding during high-risk changes — the cost of keeping v1 around briefly (a few hundred lines of dead code) is trivial compared to the cost of being unable to roll back quickly if something breaks.

### Why Gate 2 runs client-side in Phase 1

Server-side validation is more secure (trusts the server), but:
- Client-side is faster (no round-trip)
- Client-side can reuse existing `CURRENT_META` without re-fetching
- Client-side can directly call `parseSegments_v2` as a fix strategy
- Gate 2 failures don't need to hit the server at all — the dashboard can recover locally

A server-side mirror will be added in Phase 3 as defense-in-depth. For Phase 1, client-side is sufficient.

### Why we log successful passes too (not just failures)

Principle 7 says "every fix is documented." But we ALSO log successful passes because:
- Understanding which gates consistently pass helps prioritize which to improve
- Pass-log data tells us how often retry loops converge vs escalate
- Future agents can see "Gate 2 passed 47/48 times over the last week" and know it's stable

### How this extends to Gates 3, 4, 5

The same pattern repeats for every gate:
1. Gate output follows the contract (diagnosis + fix strategies + outcome)
2. A gate-specific fix loop handles retries
3. Every attempt logs to `gate_fixes.jsonl`
4. Escalation on strategy exhaustion OR AI-judged unfixability

Gate 4 (assembly QA) will be the first gate to use Gemini as the backend. Its fix strategies will include things like "rebake ticker," "re-burn logo," and "rollback to Gate 2." The pattern in this handoff — Gate Output Contract, fix loop, learning log — becomes the template for all future gates.

---

## Part 7 — Rollback plan

If Gate 2 or `parseSegments_v2` causes unexpected production issues:

**Immediate rollback (no commit revert needed):**
- Set `USE_PARSE_SEGMENTS_V2 = false` in `cwn_production.html`
- Dashboard reverts to v1 behavior (the bug returns but the pipeline still runs)

**Full rollback (commit revert):**
- `git revert HEAD` — reverts the entire handoff atomically
- Gate 2 disappears, parseSegments_v2 is removed
- Pipeline returns to pre-handoff state

**Partial rollback:**
- Keep parseSegments_v2 (it's strictly an improvement) but disable Gate 2 validation:
  - Comment out the `gate2_validateSegmentStructure(...)` call
  - Pipeline uses v2 parsing but skips the validation check
  - Useful if Gate 2 has bugs but v2 is working fine

---

## Part 8 — Commit message template

When Cline commits this handoff's implementation, use a message like:

```
feat(gate2): segment structure QA + parseSegments_v2 (Gated Pipeline Phase 1)

Fixes the "scenes out of order" bug that's been blocking smoke tests for
days. Root cause: parseSegments_v1 over-splits CLIP_SETUP sections into
3 sub-segments when Gemini writes Style-B scripts (separate REACTION
headers), producing zombie empty fragments and duplicated labels.

Implementation:
- cwn_production.html: new parseSegments_v2() single-segment-per-section
  parser. Feature flag USE_PARSE_SEGMENTS_V2=true default, flip to false
  for emergency rollback without git revert.
- cwn_production.html: new gate2_validateSegmentStructure() pure-code
  validator. Runs after parseSegments, returns Gate Output Contract JSON.
- cwn_production.html: new handleGate2Failure() fix loop. Tries
  parseSegments_v2 re-parse, then rollback to Gate 1 regenerate.
- server.js: new POST /gate-fix-log endpoint appends to
  logs/gate_fixes.jsonl (learning record foundation).
- Updates STATUS.md, CLAUDE.md with Gate 2 details.

This is the first concrete implementation of the Gated Self-Healing
Pipeline architecture. See GATED_PIPELINE_ARCHITECTURE.md for the full
spec. Principle 9 (QA is a collaborator, not a judge) is exercised:
Gate 2 returns specific diagnoses + ranked fix strategies instead of
just pass/fail.

Test plan:
- Unit test: parseSegments_v2 on 7-scene 2-clip Jason script → 9 segments
- Unit test: Gate 2 catches parseSegments_v1 output → FAIL with duplicate
  labels + count mismatch
- E2E: Jason 2-clip smoke test → Gate 2 PASS → HeyGen → Assembly →
  verify scenes in correct order

Rollback: set USE_PARSE_SEGMENTS_V2=false (1-line flip, no git revert)
OR git revert HEAD (full rollback).

Unblocks: 12-test suite run, Phase 2 (Gate 1 diagnostic upgrade),
Phases 3-8 of the Gated Pipeline rollout.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Part 9 — What NOT to touch

- **DO NOT** delete `parseSegments_v1`. It stays as a fallback.
- **DO NOT** modify the server-side `/assemble` endpoint flow. Gate 2 is client-side only in Phase 1.
- **DO NOT** change how `orderedClipUrls` or `clipMp4Urls` get populated. Gate 2 is read-only on these.
- **DO NOT** remove the existing `MAX_RETRIES = 3` pattern in Gate 1. That's a Phase 3 change.
- **DO NOT** touch Gate 3 (HeyGen segment QA). That's a later phase.
- **DO NOT** attempt to implement Gate 4 or Gate 5 in this commit. This is Phase 1 ONLY.

Scope discipline is critical. This handoff does one thing: ships the first gate with parseSegments_v2. Resist the urge to fix other bugs along the way.

---

## Part 9.5 — Post-smoke-test verification (CONSISTENT TV-rectangle intro cards across all 3 content types)

**UPDATED 2026-04-11:** Rob reversed the previous Twitch-circle-vs-NBA-TV-rectangle spec. All 3 content types (Twitch, NBA, News) now use the **SAME TV-rectangle design** for brand consistency.

After the Gate 2 smoke test passes and produces a clean MP4, Cline should verify:

1. **Extract a frame** at the JASON_INTRO timestamp (around t=12-16s based on segment durations)
2. **Verify the intro card visible in the top-right `OVERLAY_ZONE`** (x=1240, y=40, 640×360) shows whatever design the current code renders
3. **Expected outcome:** the card may still be the LEGACY 720×840 circle design (720×840 canvas rendering a circular profile in a gold ring with text below) because the Twitch migration to TV-rectangle is a SEPARATE handoff (`CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md`).
4. **If the card is still the legacy circle design, that's OK for Phase 1** — Gate 2 is about segment structure, not intro card design. Flag the circle design as "still pending TV migration" in your commit notes and move on.

The legacy circle design lives in `generateIntroCardPNG()` at `server.js:500-670`. NBA and News use separate rendering paths that already produce 640×360 TV-rectangle output. The TV migration handoff will update Twitch to match.

**Do NOT attempt to migrate Twitch to TV design as part of this Gate 2 handoff.** Scope discipline. Ship Gate 2 only. The TV migration is a separate handoff with its own spec.

---

## Questions for Cline during implementation

If you get stuck:

1. **"Where exactly should `handleGate2Failure` be called from?"**
   Look for where the existing dashboard calls `parseSegments()` (should be near `generateVideo()` or in the job-creation flow around line 2246 or `sendToHeyGen` around line 3389). Wrap the call so Gate 2 runs BEFORE the HeyGen send kicks off.

2. **"What do I do about the Gate 1 clip-analysis truncation bug that's still unfixed?"**
   Not this handoff's problem. If Gate 1 keeps failing due to that bug, use FORCE ADVANCE to push past it. A separate handoff will fix the Gemini `maxOutputTokens` issue.

3. **"The fix loop can recurse infinitely — is that OK?"**
   Yes, per Principle 5 (no arbitrary retry limits). The loop terminates when (a) Gate 2 passes, (b) all strategies are exhausted, or (c) the stall detection kicks in (not implemented in Phase 1 — add to Phase 7). For now, Gate 2 failures should escalate after ~3 strategies anyway because `fixStrategies` only has 2-3 entries.

4. **"Should I write tests?"**
   Yes, write at minimum a browser-console test for `parseSegments_v2` (see Test 1 in Part 5). Full test infrastructure can come later. Just verify by hand that v2 produces 9 segments for the test script before shipping.

5. **"What if the existing dashboard has side effects I'm breaking?"**
   Run the existing 1-clip smoke test BEFORE shipping (to confirm the bug still reproduces), then ship Gate 2, then re-run the smoke test. Compare the segment counts and labels. If v2 produces 9 and v1 produces 11, you've fixed it.

---

## Summary checklist for Cline

Before committing:

- [ ] `parseSegments_v1` is preserved as-is (renamed from `parseSegments`)
- [ ] `parseSegments_v2` is added and produces correct output on test script
- [ ] `parseSegments()` wrapper uses `USE_PARSE_SEGMENTS_V2` flag
- [ ] `gate2_validateSegmentStructure()` is added and returns Gate Output Contract
- [ ] `buildTwitchExpectedPattern()`, `buildNbaNewsExpectedPattern()` helpers added
- [ ] `handleGate2Failure()` fix loop added
- [ ] `executeGate2FixStrategy()` supports `fix_in_place` and `rollback` action types
- [ ] Gate 2 is wired into the Twitch generate flow (called after parseSegments, before HeyGen send)
- [ ] `POST /gate-fix-log` endpoint added to server.js
- [ ] `logs/gate_fixes.jsonl` is writable (verify the dir exists)
- [ ] Dashboard UI shows Gate 2 pass/fail panels
- [ ] STATUS.md has a Last Agent Action row for this commit
- [ ] CLAUDE.md has a pointer to `GATED_PIPELINE_ARCHITECTURE.md` in the Session Start section
- [ ] Manual test: parseSegments_v2 with 7-scene test script produces 9 segments
- [ ] Manual test: Gate 2 catches parseSegments_v1 output with structured errors
- [ ] E2E test: Jason 2-clip smoke test passes Gate 2 and produces a clean MP4

---

*This handoff is the first concrete implementation of the Gated Self-Healing Pipeline. Ship it carefully, test it thoroughly, and document anything you learn that isn't in this doc back into the architecture doc or a new gate_fix learning entry. Future agents will thank you.*
