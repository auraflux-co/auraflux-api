# Fix Plan: Correct HeyGen Scene Structure

**Date**: 2026-04-07
**Priority**: CRITICAL - Blocks Test 2
**Complexity**: HIGH - Changes core script generation, HeyGen submission, and assembly

---

## Problem Statement

**Current Behavior**: Claude generates scripts with ONE scene per streamer (10 scenes total), cramming intro + 3 clip setups + 3 reactions into one HeyGen request.

**Result**: HeyGen's TTS engine rushes through text, causing:
- Poor enunciation
- Word skipping/jumping
- Unnatural pacing
- Broken lip sync

**Root Cause**: Script generation prompt (server.js:4890-4893) only requests these scene headers:
```
- === COLD OPEN ===
- === JASON ===
- === HASAN ===
...
- === OUTRO ===
```

**Required**: **81 separate scenes** (1-3 sentences each) to keep HeyGen rendering quality high.

---

## Required Scene Structure

### For 10 Streamers × 3 Clips Each:

1. **Episode Intro** - 1 scene
2. **Per Streamer** (×10):
   - `=== [NAME]_INTRO ===` - Streamer introduction
   - `=== [NAME]_CLIP1_SETUP ===` - Clip 1 context + `[CLIP PLAYS HERE]`
   - `=== [NAME]_CLIP1_REACTION ===` - 1-sentence reaction
   - `=== [NAME]_CLIP2_SETUP ===` - Clip 2 context + `[CLIP PLAYS HERE]`
   - `=== [NAME]_CLIP2_REACTION ===` - 1-sentence reaction
   - `=== [NAME]_CLIP3_SETUP ===` - Clip 3 context + `[CLIP PLAYS HERE]`
   - `=== [NAME]_CLIP3_REACTION ===` - 1-sentence reaction

   **= 7 scenes per streamer**

3. **Episode Outro** - 1 scene

**Total**: 1 + (10 × 7) + 1 = **72 scenes**

---

## Changes Required

### Change 1: Update Script Generation Prompt (server.js:4880-4931)

**Location**: `/generate-full-script` endpoint

**Current** (lines 4890-4893):
```javascript
Write the FULL SCRIPT using these === SECTION HEADERS === exactly:
- === COLD OPEN (0:00 - 0:08) ===
${sectionHeaders}  // Just "=== JASON ===", "=== HASAN ===", etc.
- === OUTRO ===
```

**New**:
```javascript
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

=== INTRO ===

${items.map((streamer, idx) => {
  const name = getDisplayName(streamer).toUpperCase();
  return `=== ${name}_INTRO ===
=== ${name}_CLIP1_SETUP ===
=== ${name}_CLIP1_REACTION ===
=== ${name}_CLIP2_SETUP ===
=== ${name}_CLIP2_REACTION ===
=== ${name}_CLIP3_SETUP ===
=== ${name}_CLIP3_REACTION ===`;
}).join('\n\n')}

=== OUTRO ===

CRITICAL - SCENE LENGTH RULES:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words
- INTRO scenes: 2-3 sentences
- SETUP scenes: 2 sentences + [CLIP PLAYS HERE] marker
- REACTION scenes: EXACTLY 1 sentence
- OUTRO scene: 1-2 sentences

STRUCTURE PER SCENE:
[Scene text]
[beat]  // Only if followed by [CLIP PLAYS HERE]
[CLIP PLAYS HERE]  // Only in SETUP scenes
[beat]  // Only if preceded by [CLIP PLAYS HERE]
```

**Also Update** (lines 4900-4920):
Remove the old inline structure examples and replace with clear per-scene instructions.

---

### Change 2: Update HeyGen Submission Code

**Location**: Dashboard `cwn_production.html` → `/send-to-heygen` handler

**Current**: Unknown - need to verify it can handle 72 separate scene submissions

**Required**:
1. Parse script into 72 separate scenes by splitting on `=== SCENE_NAME ===` markers
2. Submit each scene as a separate HeyGen API request
3. Track all 72 video IDs for assembly
4. Handle rate limiting (if HeyGen has API call limits)

**Questions to Answer**:
- Does HeyGen API support batch submissions?
- What's the rate limit?
- Should scenes be submitted in parallel or sequentially?

---

### Change 3: Update Gate 1 QA to Validate Scene Count

**Location**: `geminiScriptQA()` server.js:1443-1621

**Add Check**:
```javascript
// Count scene markers
const sceneMarkers = (script.match(/===\s+[A-Z_]+\s+===/g) || []).length;
const expectedScenes = 1 + (streamers.length * 7) + 1; // INTRO + (streamers × 7) + OUTRO

if (sceneMarkers !== expectedScenes) {
  preCheckDeductions.push({
    points: 25,
    reason: `SCENE COUNT: Found ${sceneMarkers} scenes, expected ${expectedScenes} — CRITICAL`
  });
  adjustedScore = Math.max(0, adjustedScore - 25);
}
```

**Current Issue**: Line 1480 already counts scene markers, but doesn't validate the count matches the required structure.

---

### Change 4: Update Assembly Code

**Current**: Assembly expects segments to arrive in order from HeyGen
**Required**: Verify assembly can handle 72 segments (should already work, just needs testing)

**No code changes needed** - assembly just concatenates whatever segments it receives.

---

## Implementation Steps

### Step 1: Update Script Prompt (30 min)
1. Modify server.js:4890-4931 to generate 72 scene headers
2. Update structure examples to emphasize 1-3 sentence limit per scene
3. Add warning about HeyGen TTS rushing on long scenes

### Step 2: Add Scene Count Validation to Gate 1 (15 min)
1. Add scene count check to `geminiScriptQA()`
2. Deduct 25 points if count doesn't match expected
3. Update QA report to show expected vs actual scene count

### Step 3: Test with Claude Code (10 min)
1. Generate a test script with the new prompt
2. Verify it produces 72 scene markers
3. Verify Gate 1 QA validates scene count correctly

### Step 4: Verify HeyGen Submission Logic (20 min)
1. Read dashboard `/send-to-heygen` code
2. Confirm it splits on scene markers
3. Confirm it submits each scene separately
4. Check for rate limiting handling

### Step 5: Add Detailed QA Deductions (30 min)
1. Update `geminiSegmentQA()` (Gate 2) to show deduction breakdown
2. Update `geminiQACheck()` (Gate 3) to show deduction breakdown
3. Increase `maxOutputTokens` from 800 → 2000 to prevent truncation

---

## Risks

### Risk 1: Claude Refuses to Follow 72-Scene Structure
**Mitigation**: Provide clear examples in prompt, use few-shot learning

### Risk 2: HeyGen Rate Limiting
**Mitigation**: Add exponential backoff, queue submissions if needed

### Risk 3: Assembly Performance with 72 Segments
**Mitigation**: Test assembly with 72 segments, optimize if slow

### Risk 4: Gate 1 QA False Positives
**Mitigation**: Test thoroughly with multiple script generations

---

## Testing Plan

### Test A: Script Generation
1. Call `/generate-full-script` with 10 streamers × 3 clips
2. Verify output contains exactly 72 `=== SCENE ===` markers
3. Verify each scene is 1-3 sentences
4. Verify Gate 1 QA passes with correct scene count

### Test B: HeyGen Submission
1. Use test script from Test A
2. Send to HeyGen via dashboard
3. Verify 72 separate HeyGen requests are made
4. Verify all 72 video IDs are tracked
5. Monitor for rate limiting issues

### Test C: Assembly
1. Wait for all 72 HeyGen videos to complete
2. Trigger assembly
3. Verify all 72 segments concatenate correctly
4. Verify final video has proper pacing (no rushing)
5. Verify clips play at correct times

---

## Rollback Plan

If this breaks the system:

1. **Revert server.js:4880-4931** to old prompt structure
2. **Revert server.js:1550-1570** to old scene count logic
3. **Restart server**
4. **Document what went wrong**

**Backup command**:
```bash
git diff server.js > scene_structure_changes.patch
# If rollback needed:
git checkout server.js
```

---

## Success Criteria

✅ Claude generates scripts with 72 scene markers
✅ Each scene is 1-3 sentences max
✅ Gate 1 QA validates scene count correctly
✅ HeyGen receives 72 separate requests
✅ All 72 HeyGen videos render without rushing
✅ Assembly produces correct final video
✅ Bobby G speaks at natural pace (no word skipping)

---

## Next Steps

**DECISION REQUIRED**:
Should I proceed with implementing these changes, or do you want to review this plan first?

**If proceeding**:
1. I'll start with Step 1 (Update Script Prompt)
2. Then Step 2 (Add Scene Count Validation)
3. Then verify with Test A before moving to HeyGen submission

**Estimated Total Time**: 2 hours for all changes + testing
