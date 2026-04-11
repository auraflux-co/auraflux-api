# CLINE HANDOFF: Twitch Clip Mismatch Bug — Fix V2

**Priority:** URGENT — Gate 1 still failing after c918cad fix
**Agent:** Cline (Implementation Lead)
**File:** `server.js`
**Previous attempt:** Commit c918cad (analysesByStreamer map) — didn't solve the issue
**New failure:** `/Users/robertgregory/cwn-production/output/qa_failures/gate1_script_fail_1775841912491.txt`

---

## Problem Statement (Updated)

Gate 1 still failing at 85/100 after c918cad fix:
- Jason's clips are swapped within Jason's segment (VRChat described as clip 2, street encounter as clip 1)
- "Several setups don't match clip content (Hasan clips, Adapt clips, Ron clips, etc.)"

**Root Cause (Deeper than previous diagnosis):**

Commit c918cad fixed the **cross-streamer mismatch** (analyses mapped to correct streamer), but it didn't fix the **items.clips mismatch**. The issue:

1. `items[].clips` contains the ORIGINAL clips from dashboard (lines 5530-5542)
2. `analysisClips` is built by filtering/reordering `allClips` (lines 5597-5621)
3. `analysesByStreamer` map contains analyses for `analysisClips`
4. **BUT** `items[].clips` still points to the original clips, NOT the clips in `analysisClips`
5. When Gemini script generator uses `items[0].clips[0].title`, it references a DIFFERENT clip than what was analyzed

**Example:**
- Dashboard sends Jason with clips: [VRChat, Street Encounter]
- GQL resolution fails for VRChat, uses backup clip [Driving]
- `analysisClips` = [Driving, Street Encounter]
- `analysesByStreamer['jasontheween']` = [analysis for Driving, analysis for Street Encounter]
- **BUT** `items[0].clips` = [{title: "VRChat"}, {title: "Street Encounter"}]
- Gemini writes setup for "VRChat" using analysis of "Driving" → MISMATCH

---

## The Fix

**Location:** `server.js` lines 5722-5724 (right after building analysesByStreamer)

**Current code (c918cad):**
```javascript
console.log('[clip-mapping] streamerOrder:', streamerOrder);
console.log('[clip-mapping] items order:', items.map(i => i.streamer));
analyses = items.map(item => analysesByStreamer[item.streamer] || []);
```

**Replace with:**
```javascript
// Build clipsByStreamer map to match analysisClips order
const clipsByStreamer = {};
let clipIdx = 0;
streamerOrder.forEach(streamer => {
  const streamerClips = allClips.filter(c => c.streamer === streamer);
  const target = (streamerClips[0] && streamerClips[0].targetClipsPerStreamer)
    ? streamerClips[0].targetClipsPerStreamer
    : Math.ceil(streamerClips.length / 2);
  const count = Math.min(target, streamerClips.length);

  // Slice analysisClips (not allClips) to get the actual analyzed clips
  clipsByStreamer[streamer] = analysisClips.slice(clipIdx, clipIdx + count);
  clipIdx += count;
});

// Update items[].clips to match the clips that were actually analyzed
items.forEach(item => {
  const analyzedClips = clipsByStreamer[item.streamer] || [];
  item.clips = analyzedClips.map(c => ({
    url: c.pageUrl,
    mp4Url: c.videoUrl,
    assemblyUrl: c.assemblyUrl,
    thumbnailUrl: c.thumbnailUrl,
    title: c.title,
    game: c.game,
    streamer: c.streamer,
    isBackup: c.isBackup || false
  }));
});

console.log('[clip-mapping] Updated items[].clips to match analysisClips order');
console.log('[clip-mapping] streamerOrder:', streamerOrder);
console.log('[clip-mapping] items order:', items.map(i => i.streamer));

// Now map analyses (this part stays the same)
analyses = items.map(item => analysesByStreamer[item.streamer] || []);
```

**Why this works:**
1. `clipsByStreamer` is built from `analysisClips` (the clips that were ACTUALLY analyzed)
2. `items[].clips` is updated to match the analyzed clips
3. When Gemini uses `items[0].clips[0].title`, it now references the SAME clip that was analyzed
4. Analyses are still mapped by streamer name (c918cad fix preserved)

---

## Gate 1 Clip Availability Report (New Requirement)

**User Request:** Gate 1 QA should include a report showing why we couldn't grab 2 clips for each of 12 streamers (24 total).

**Add to Gate 1 output (`server.js` lines 1651-1698):**

After the existing Gate 1 QA completes, add a new section:

```javascript
// Generate clip availability report for user visibility
function generateClipAvailabilityReport(items, allClips, streamerOrder, analysisClips) {
  const report = [];
  report.push('\n── CLIP AVAILABILITY REPORT ──────────────────────');

  const targetPerStreamer = 2;
  const expectedStreamers = 12;
  const expectedTotal = expectedStreamers * targetPerStreamer;

  const actualTotal = analysisClips.length;
  const shortfall = expectedTotal - actualTotal;

  report.push(`Target: ${expectedTotal} clips (${expectedStreamers} streamers × ${targetPerStreamer} clips each)`);
  report.push(`Actual: ${actualTotal} clips`);
  if (shortfall > 0) {
    report.push(`Shortfall: ${shortfall} clips\n`);
  } else {
    report.push(`Status: ✅ Target met\n`);
  }

  // Per-streamer breakdown
  streamerOrder.forEach(streamer => {
    const streamerClips = allClips.filter(c => c.streamer === streamer);
    const analyzedClips = analysisClips.filter(c => c.streamer === streamer);
    const requested = targetPerStreamer;
    const obtained = analyzedClips.length;

    const good = streamerClips.filter(c => c.videoUrl && c.videoUrl.includes('sig='));
    const bad = streamerClips.filter(c => !c.videoUrl || !c.videoUrl.includes('sig='));

    let reason = '';
    if (obtained >= requested) {
      reason = '✅ Target met';
    } else if (good.length < requested) {
      const expired = requested - good.length;
      reason = `⚠️ ${expired} clips expired/deleted, used ${bad.length} backups`;
    } else if (streamerClips.length < requested) {
      reason = `⚠️ Only ${streamerClips.length} clips available (need ${requested})`;
    } else {
      reason = '⚠️ Unknown issue — check logs';
    }

    report.push(`${streamer}: ${obtained}/${requested} clips — ${reason}`);
  });

  // Check for streamers in roster but not in this episode
  const rosterStreamers = Object.keys(STREAMER_DISPLAY_NAMES);
  const missingStreamers = rosterStreamers.filter(s => !streamerOrder.includes(s));
  if (missingStreamers.length > 0) {
    report.push(`\nStreamers not in this episode: ${missingStreamers.join(', ')}`);
  }

  report.push('──────────────────────────────────────────────────\n');
  return report.join('\n');
}
```

**Call this function in Gate 1 output:**

Find where Gate 1 writes to `gate1_script_fail_*.txt` or `gate1_script_pass_*.txt` and append the report:

```javascript
// After writing Gate 1 score/issues, add clip availability report
const clipReport = generateClipAvailabilityReport(items, allClips, streamerOrder, analysisClips);
fs.appendFileSync(gate1OutputPath, clipReport);
```

**Expected output format:**
```
── CLIP AVAILABILITY REPORT ──────────────────────
Target: 24 clips (12 streamers × 2 clips each)
Actual: 18 clips
Shortfall: 6 clips

jasontheween: 2/2 clips — ✅ Target met
hasanabi: 2/2 clips — ✅ Target met
adapt: 2/2 clips — ✅ Target met
stableronaldo: 2/2 clips — ✅ Target met
lacy: 2/2 clips — ✅ Target met
marlon: 2/2 clips — ✅ Target met
cinna: 2/2 clips — ✅ Target met
yonnajay: 2/2 clips — ✅ Target met
jaycinco: 2/2 clips — ✅ Target met
maya: 0/2 clips — ⚠️ 2 clips expired/deleted, used 0 backups
extraemily: 0/2 clips — ⚠️ Only 0 clips available (need 2)
yourragegaming: 0/2 clips — ⚠️ 2 clips expired/deleted, used 0 backups

Streamers not in this episode: (none - all 12 roster members present)
──────────────────────────────────────────────────
```

---

## Implementation Steps

1. **Read server.js lines 5700-5730** to understand current context
2. **Replace lines 5722-5724** with the new clipsByStreamer + items.clips update logic
3. **Add generateClipAvailabilityReport() function** (suggest placing near Gate 1 QA function around line 1650)
4. **Call the report function** in Gate 1 output (both pass and fail paths)
5. **Pass required variables** (items, allClips, streamerOrder, analysisClips) to Gate 1 — may need to add these to function signature
6. **Add logging** to confirm items.clips update:
   ```javascript
   console.log('[clip-mapping] Updated items[].clips to match analysisClips');
   items.forEach(item => {
     console.log(`  ${item.streamer}: ${item.clips.length} clips - ${item.clips.map(c => c.title.slice(0,30)).join(', ')}`);
   });
   ```
7. **Test the fix:**
   - Restart server: `lsof -ti:3000 | xargs kill -9 && sleep 2 && node server.js`
   - Trigger a Twitch script generation from dashboard
   - Check console logs show items.clips updated
   - Verify Gate 1 passes with 90+ score (no clip mismatch errors)
   - Verify Gate 1 output includes clip availability report

---

## Validation

**Success criteria:**
1. Console logs show `Updated items[].clips to match analysisClips`
2. Gate 1 QA passes with 90+ score
3. No "CLIP MATCH" errors in Gate 1 output
4. Script setups correctly describe their corresponding clips (Jason's setups = Jason's analyzed clips)
5. Gate 1 output includes clip availability report showing per-streamer breakdown
6. User can see why some streamers had fewer than 2 clips

**Test with:**
```bash
# In dashboard: Create new Twitch job with 9+ streamers
# Watch console output for [clip-mapping] logs
# Check Gate 1 output in output/qa_failures/ (should be empty if passing)
# OR output/qa_passes/ if passing
# Verify clip availability report is present in output file
```

---

## Commit Message Template

```
fix: resolve items.clips mismatch in Twitch clip analysis + add Gate 1 clip availability report

Root cause: items[].clips still pointed to original dashboard clips, not the
clips in analysisClips that were actually analyzed. Gemini was writing setups
for clip A using analysis of clip B.

Changes:
- server.js:5722 - Build clipsByStreamer map from analysisClips
- server.js:5723 - Update items[].clips to match analyzed clips
- server.js:1650 - Add generateClipAvailabilityReport() function
- server.js:1690 - Call report in Gate 1 output (pass + fail paths)
- Added logging to show items.clips update per streamer

Gate 1 now includes clip availability report showing:
- Per-streamer clip count (obtained vs. requested)
- Reason for shortfall (expired, deleted, not enough available)
- Streamers missing from episode

Fixes: gate1_script_fail_1775841912491.txt (85/100 - clip mismatch after c918cad)
Validates: items.clips now matches analysisClips order

Supersedes: c918cad (partial fix - only mapped analyses, didn't update items.clips)

References: CLINE_HANDOFF_CLIP_MISMATCH_FIX_V2.md
```

---

## Additional Context

- **Affected endpoint:** POST /generate-full-script (line 5505)
- **Gate 1 QA function:** lines 1651-1698
- **Previous fix (c918cad):** Correctly mapped analyses by streamer name, but didn't update items.clips
- **Why c918cad failed:** Analyses matched streamers, but items.clips still pointed to wrong clips
- **Related files:** None (fix is isolated to server.js)
- **Rollback plan:** Revert commit if Gate 1 still fails
- **Risk level:** MEDIUM - Fix changes items.clips structure, could affect downstream code that reads items.clips

---

**Ready for implementation. Please update STATUS.md after completing the fix.**
