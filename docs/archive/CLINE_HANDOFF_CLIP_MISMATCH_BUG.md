# CLINE HANDOFF: Twitch Clip Mismatch Bug Fix

**Priority:** HIGH - Gate 1 failures blocking production
**Agent:** Cline (Implementation Lead)
**File:** `server.js`
**Bug Report:** `/Users/robertgregory/cwn-production/output/qa_failures/gate1_script_fail_1775837971725.txt`

---

## Problem Statement

Gate 1 QA is failing with 85/100 score due to clip mismatches:
- Jason's setups describe "driving and VRChat" but clips show HasanAbi content
- Hasan's setups describe "his commentary" but clips show Adapt content
- Pattern continues across all streamers (systematic mismatch)

**Root Cause:** Order mismatch between clip analysis and streamer assignment in `server.js` lines 5708-5714.

---

## Bug Analysis

### The Data Flow

1. **Clips are organized by streamerOrder** (lines 5577-5621):
   ```javascript
   // Build streamerOrder array from allClips
   const streamerOrder = [];
   allClips.forEach(c => {
     if (!resolvedByStreamer[c.streamer]) {
       resolvedByStreamer[c.streamer] = [];
       streamerOrder.push(c.streamer);
     }
   });

   // Clips are added to analysisClips in streamerOrder sequence
   streamerOrder.forEach(streamer => {
     const streamerClips = allClips.filter(c => c.streamer === streamer);
     // ... pick clips ...
     picked.forEach(c => analysisClips.push(c));
   });
   ```

2. **Gemini analyzes clips in analysisClips order** (lines 5684-5706):
   ```javascript
   const flatAnalyses = [];
   for (let wi = 0; wi < waves.length; wi++) {
     const waveResults = await Promise.all(
       waves[wi].map(c => geminiAnalyzeClip(c.videoUrl, ...))
     );
     flatAnalyses.push(...waveResults);
   }
   ```
   **Result:** `flatAnalyses` is in `streamerOrder` sequence

3. **Analyses are mapped back to items array** (lines 5708-5714):
   ```javascript
   let flatIdx = 0;
   analyses = items.map(item => {
     const clips = item.clips && item.clips.length ? item.clips : [{}];
     const streamerAnalyses = flatAnalyses.slice(flatIdx, flatIdx + clips.length);
     flatIdx += clips.length;
     return streamerAnalyses;
   });
   ```
   **BUG:** If `items` array order ≠ `streamerOrder` order, analyses get assigned to wrong streamers!

### Example of the Bug

**If:**
- `items = [{streamer: 'jasontheween'}, {streamer: 'hasanabi'}, {streamer: 'adapt'}]`
- `streamerOrder = ['hasanabi', 'jasontheween', 'adapt']` (different order!)

**Then:**
- `flatAnalyses[0-1]` = Hasan's clip analyses (analyzed first in streamerOrder)
- `flatAnalyses[2-3]` = Jason's clip analyses (analyzed second in streamerOrder)
- `flatAnalyses[4-5]` = Adapt's clip analyses

**But mapping does:**
- `analyses[0]` (Jason in items) = `flatAnalyses[0-1]` (Hasan's analyses) ❌
- `analyses[1]` (Hasan in items) = `flatAnalyses[2-3]` (Jason's analyses) ❌
- `analyses[2]` (Adapt in items) = `flatAnalyses[4-5]` (Adapt's analyses) ✅

---

## The Fix

### Option 1: Sort items to match streamerOrder (RECOMMENDED)

**Location:** `server.js` line 5708 (right before the mapping)

**Add this code:**
```javascript
// BEFORE the buggy mapping (line 5708)
// Sort items to match streamerOrder to ensure analyses align correctly
const streamerToIndex = new Map(streamerOrder.map((s, i) => [s, i]));
items.sort((a, b) => {
  const aIdx = streamerToIndex.get(a.streamer) ?? 999;
  const bIdx = streamerToIndex.get(b.streamer) ?? 999;
  return aIdx - bIdx;
});
console.log('[clip-mapping] Sorted items to match streamerOrder:', items.map(i => i.streamer));

// NOW the existing mapping code (lines 5708-5714)
let flatIdx = 0;
analyses = items.map(item => {
  const clips = item.clips && item.clips.length ? item.clips : [{}];
  const streamerAnalyses = flatAnalyses.slice(flatIdx, flatIdx + clips.length);
  flatIdx += clips.length;
  return streamerAnalyses;
});
```

### Option 2: Build analyses map using streamer keys (SAFER)

**Replace lines 5708-5714 with:**
```javascript
// Build analyses indexed by streamer name instead of array order
const analysesByStreamer = {};
let flatIdx = 0;
streamerOrder.forEach(streamer => {
  const streamerClips = allClips.filter(c => c.streamer === streamer);
  const target = streamerClips[0]?.targetClipsPerStreamer ?? 2;
  const count = Math.min(target, streamerClips.length);
  analysesByStreamer[streamer] = flatAnalyses.slice(flatIdx, flatIdx + count);
  flatIdx += count;
});

// Map back to items using streamer key lookup
analyses = items.map(item => analysesByStreamer[item.streamer] || []);
console.log('[clip-mapping] Mapped analyses by streamer key:', Object.keys(analysesByStreamer));
```

---

## Implementation Steps

1. **Read server.js lines 5700-5720** to understand current context
2. **Choose fix approach** (Option 1 is simpler, Option 2 is more defensive)
3. **Add the fix** at line 5708
4. **Add logging** to confirm order matching:
   ```javascript
   console.log('[clip-mapping] streamerOrder:', streamerOrder);
   console.log('[clip-mapping] items order:', items.map(i => i.streamer));
   ```
5. **Test the fix:**
   - Restart server: `lsof -ti:3000 | xargs kill -9 && sleep 2 && node server.js`
   - Trigger a Twitch script generation from dashboard
   - Check console logs show matching order
   - Verify Gate 1 passes with 90+ score (no clip mismatch errors)

---

## Validation

**Success criteria:**
1. Console logs show `streamerOrder` and `items order` match after sorting
2. Gate 1 QA passes with 90+ score
3. No "CLIP MATCH" errors in Gate 1 output
4. Script setups correctly describe their corresponding clips (Jason's setups = Jason's clips)

**Test with:**
```bash
# In dashboard: Create new Twitch job with 3+ streamers
# Watch console output for [clip-mapping] logs
# Check Gate 1 output in output/qa_failures/ (should be empty if passing)
```

---

## Commit Message Template

```
fix: resolve Twitch clip mismatch in Gate 1 QA (server.js:5708)

Clips were being assigned to wrong streamers due to order mismatch between
analysisClips (sorted by streamerOrder) and items array (unsorted).

Changes:
- server.js:5708 - Sort items to match streamerOrder before analysis mapping
- Added logging to verify order alignment

Fixes: gate1_script_fail_1775837971725.txt (85/100 - clip mismatch)
Validates: Twitch clips now correctly match their streamers

References: CLINE_HANDOFF_CLIP_MISMATCH_BUG.md
```

---

## Additional Context

- **Affected endpoint:** POST /generate-full-script (line 5505)
- **Gate 1 QA function:** lines 1651-1698
- **Related files:** None (fix is isolated to server.js)
- **Rollback plan:** Revert commit if Gate 1 still fails
- **Risk level:** LOW - Fix only affects order, doesn't change logic

---

**Ready for implementation. Please update STATUS.md after completing the fix.**
