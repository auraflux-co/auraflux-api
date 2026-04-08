# Test 1 Postmortem - Twitch Compilation

**Date**: 2026-04-07
**Job ID**: `test_1_twitch_compilation_1775603796040`
**Output**: 8min 15sec, 188MB
**Gates**: Gate 1: 100/100 ✅ | Gate 2: 80/100 🟡 | Gate 3: Not Evaluated

---

## Issues Found

### 1. **No Source Clips** (CRITICAL)
**Observed**: Video is 8+ minutes of just Bobby G avatar talking - no Twitch clips play
**Expected**: 10 streamer intros each followed by 3 Twitch clips (30 clips total)
**Root Cause**: Assembly payload only included HeyGen avatar segments, no source clip URLs
**Impact**: Video is unwatchable - Bobby G describes clips that never appear

### 2. **No Ticker** (CRITICAL)
**Observed**: No Twitch stock ticker at bottom of video
**Expected**: Scrolling ticker showing streamer stats/viewer counts
**Root Cause**: Unknown - ticker should have been baked in during assembly
**Impact**: Missing key branding element

### 3. **No Streamer Profile Cards** (CRITICAL)
**Observed**: No intro cards with streamer profile pictures
**Expected**: Top-right overlay with streamer face + name for each segment
**Root Cause**: Intro card generation/overlay not triggered
**Impact**: Viewers don't know which streamer is being discussed

### 4. **Bobby G Hand Movements Excessive**
**Observed**: Avatar hands move erratically/unnaturally
**Expected**: Subtle, natural gestures
**Root Cause**: HeyGen avatar gesture settings or Bobby G avatar behavior
**Impact**: Distracting, unprofessional look

### 5. **Lip Sync Off**
**Observed**: Audio doesn't match Bobby G's mouth movements
**Expected**: Perfect lip sync from HeyGen
**Root Cause**: Possibly HeyGen rendering issue OR speak speed (0.85x) causing drift
**Impact**: Uncanny valley effect, unprofessional

### 6. **Bobby G Pacing Too Slow**
**Observed**: Bobby G speaks slowly, rhythm feels off
**Expected**: Natural pacing with clips filling the gaps
**Root Cause**: 0.85x speak speed + missing clips = dead air where clips should be
**Impact**: Video drags, feels sluggish

### 7. **File Size Too Small**
**Observed**: 188MB for 8min 15sec video
**Expected**: ~500MB-1GB with 30 high-quality Twitch clips
**Root Cause**: Only avatar segments (low bitrate) - no source clips (high bitrate)
**Impact**: Confirms no clips were included

---

## Gate 2 QA Failed to Catch Issues

**Gate 2 Score**: 80/100 (Manual Review)
**Why It Passed**: Gemini only reviewed HeyGen avatar segments in isolation
**What It Missed**: Assembly-level issues (missing clips, no ticker, no intro cards)

**Gate 2 Report Truncation**: Gemini's detailed analysis was cut off mid-sentence:
```
=== FIRST SEGMENT ===
1. **LIP SYNC:** [PASS]
   - The avatar
```

This suggests the response was truncated, hiding the actual point deductions.

---

## Why QA Scoring Feels Arbitrary

**Current Problem**: Gate reports show final scores (80/100) but don't explain HOW that number was calculated.

**Example from Gate 2**:
```
Score: 80/100
── POINT DEDUCTIONS ──────────────────────────────
  None
```

This says "80/100" but "None" for deductions - clearly truncated/incomplete.

**What We Need**:
```
STARTING SCORE: 100

DEDUCTIONS:
  -10  Lip sync slightly delayed in JASON segment (minor)
  -5   Hand gestures excessive in HASAN segment
  -5   Audio volume inconsistent in ADAPT segment

FINAL SCORE: 80/100
```

---

## Fixes Required

### Fix 1: Assembly Payload Must Include Source Clips

**Current**: Only HeyGen avatar URLs sent to `/assemble`

**Required**: Interleave avatar segments + source clips:

```json
{
  "segmentData": [
    { "url": "heygen_jason.mp4", "label": "JASON", "type": "avatar" },
    { "url": "twitch_clip_1.mp4", "label": "JASON_CLIP_1", "type": "clip" },
    { "url": "twitch_clip_2.mp4", "label": "JASON_CLIP_2", "type": "clip" },
    { "url": "twitch_clip_3.mp4", "label": "JASON_CLIP_3", "type": "clip" },
    { "url": "heygen_hasan.mp4", "label": "HASAN", "type": "avatar" },
    ...
  ]
}
```

**Where to Fix**: Dashboard `/send-to-heygen` → track both avatar video IDs AND source clip URLs, then pass both to assembly

### Fix 2: Add Detailed Deduction Breakdown to All QA Functions

**Update these functions**:
- `geminiScriptQA()` (Gate 1) - server.js:1443
- `geminiSegmentQA()` (Gate 2) - server.js:1631
- `geminiQACheck()` (Gate 3) - server.js:1048

**Required Output Format**:
```
STARTING SCORE: 100

DEDUCTIONS:
  -15  CLIP COUNT: Found 27 [CLIP PLAYS HERE] markers, expected 30 — CRITICAL
  -10  BEAT PLACEMENT: Missing [beat] after [CLIP PLAYS HERE] in JASON segment
  -5   INTRO LENGTH: HASAN intro is 4 sentences (should be 2-3)

FINAL SCORE: 70/100
```

### Fix 3: Prevent Gemini Response Truncation

**Current**: maxOutputTokens: 800 causes truncation
**Fix**: Increase to 2000+ for Gate 2/3 video QA (needs detailed analysis)

### Fix 4: Ticker Not Baking In

**Investigate**: Why ticker overlay failed during assembly
**Check**: server.js:2801-2900 ticker baking logic

### Fix 5: Profile Cards Not Generated

**Investigate**: Why intro cards weren't overlaid
**Check**: Intro card generation + FFmpeg overlay commands

### Fix 6: HeyGen Avatar Gesture Settings

**Test**: Different HeyGen avatar IDs or gesture intensity settings
**Investigate**: Can we request "minimal gestures" via HeyGen API?

### Fix 7: Lip Sync / Speak Speed

**Test**: Try speak_speed 1.0 instead of 0.85
**Investigate**: Does HeyGen lip sync degrade at 0.85x?

---

## Action Plan

### Immediate (Before Test 2):

1. ✅ **Fix assembly payload** - Include source clips
2. ✅ **Add deduction breakdowns** to all QA reports
3. ✅ **Increase maxOutputTokens** to prevent truncation
4. ✅ **Debug ticker overlay** - Why it didn't bake
5. ✅ **Debug intro cards** - Why they didn't render

### Short-term:

6. **HeyGen speak speed test** - Try 0.9x, 0.95x, 1.0x
7. **Avatar gesture test** - Try different avatars or settings
8. **Gate 3 enhancement** - Check for missing clips/ticker/cards

### Long-term:

9. **Pre-assembly validation** - Verify all clips resolved before assembly starts
10. **Assembly preview** - Generate 30-second preview for manual review before full render

---

## Test 2 Requirements

Before running Test 2, we MUST:

1. Verify source clip URLs are tracked during script generation
2. Verify `/send-to-heygen` stores both avatar IDs and clip URLs
3. Verify `/assemble` receives interleaved avatar + clip segments
4. Verify ticker overlay triggers
5. Verify intro card overlay triggers
6. Verify QA reports show detailed deduction breakdowns

---

## Related Files

- Assembly payload: `/Users/robertgregory/cwn-production/test_assembly_payload.json`
- Gate 2 QA log: `/Users/robertgregory/cwn-production/output/qa_failures/gate2_segments_manual_review_1775603774734.txt`
- Gate 1 QA log: `/Users/robertgregory/cwn-production/output/qa_failures/gate1_script_pass_1775601390742.txt`
- Output video: `/Users/robertgregory/cwn-production/output/test_1_twitch_compilation_1775603796040.mp4`

---

**Next Step**: Implement Fixes 1-5 before Test 2.
