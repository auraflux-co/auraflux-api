# CLINE_HANDOFF_NEWS_LONGFORM_FIXES.md

**Author:** Claude Code (dispatched 2026-04-12)
**For:** Cline (implementation)
**Scope:** News long-form — 4 targeted fixes to get a clean end-to-end run
**Ship order:** Fix 1 first (unblocks everything else), then 2, 3, 4 in order
**Do NOT touch:** NBA anything, Twitch anything, short-form anything
**Commit strategy:** One commit per fix (4 commits total). Each commit must leave the server in a working state.

---

## Context — what's broken and why

Last night's two News long-form runs both produced `22_avatar_0_clips` output files — the assembly received **zero source clip URLs**. Both auto-proceeded through Gate 3 (93/100 and 83/100) despite being structurally broken because Gate 3 doesn't check for missing clips or missing TV card.

Evidence files (do not delete — Rob may want to re-examine):
- `output/news_sunday_april_12_2026_22_avatar_0_clips__1775968382988.mp4`
- `output/news_sunday_april_12_2026_22_avatar_0_clips__1775973340051.mp4`
- `output/qa_failures/gate3_assembly_pass_1775968564381.txt`
- `output/qa_failures/gate3_assembly_pass_1775973522181.txt`
- `output/qa_failures/gate2_segments_manual_review_1775973331944.txt`

---

## Fix 1 — Wire News clip URLs into `orderedClipUrls` (ROOT CAUSE)

**File:** `server.js`
**Why this is Fix 1:** Without clip URLs flowing through, fixes 2–4 are irrelevant. The `22_avatar_0_clips` filename is the smoking gun — `clipIdx` in the heygen-poller was 0 because `card.orderedClipUrls` was an empty array.

### Root cause (confirmed by code audit)

In `generate-full-script` (line 6172), `orderedClipUrls` is declared as an empty array:
```javascript
let orderedClipUrls = []; // populated by twitch block — returned alongside script
```

It is **only populated in the Twitch block** (lines 6271–6284):
```javascript
orderedClipUrls = analysisClips.map(c => ({
  url:         c.assemblyUrl || c.videoUrl || c.mp4UrlDash || c.url || '',
  ...
}));
```

The **News block** (lines 6460–6480) runs `geminiAnalyzeClip()` on each story's `item.videoUrl` for analysis, but **never builds `orderedClipUrls`**. So when the response is sent at line 7112 (`orderedClipUrls,`), it's always `[]` for News.

The heygen-poller at line 219 reads `card.orderedClipUrls || []` — gets `[]` — so `clipIdx` stays 0 — so no source clips are inserted into `segmentData` — so assembly gets `22_avatar_0_clips`.

### The fix

After the News analysis block (after line ~6480, before the `// ── Step 2: Build the full Claude prompt` comment), add:

```javascript
// Build orderedClipUrls for News — one entry per story, using the video URL
// that Gemini analyzed (same URL used for assembly — news clips don't expire like Twitch CDN)
if (type === 'news') {
  orderedClipUrls = items.map((item, i) => ({
    url:      item.videoUrl || item.clipUrl || '',
    clipUrl:  item.videoUrl || item.clipUrl || '',
    pageUrl:  item.link || item.url || '',
    label:    `STORY${i + 1}_CLIP`,
    streamer: `story_${i + 1}`,
    title:    item.title || `Story ${i + 1}`
  })).filter(c => c.url); // only include stories that have a real video URL
  console.log(`[generate-full-script] Built News orderedClipUrls: ${orderedClipUrls.length}/${items.length} stories have clip URLs`);
}
```

**Why `.filter(c => c.url)`:** Some news stories may only have a thumbnail (no video). We only insert clips for stories that have a real video URL. Stories without video URLs will still have their avatar segments (INTRO, SETUP, CLIP_REACTION, REACTION) but no source clip inserted — that's acceptable and matches the current behavior for Twitch streamers with 0 valid clips.

**Important:** The heygen-poller inserts a source clip after every `SETUP` scene (line 232: `if (/SETUP/i.test(avatarSeg.sceneName) && clipIdx < orderedClipUrls.length)`). For News, the SETUP scenes are named `STORY1_SETUP`, `STORY2_SETUP`, etc. — the `/SETUP/i` regex already matches these. No change needed in the poller.

### Verification

After this fix, run a News long-form. The output filename should contain `N_clips` where N > 0. Check the assembly log for:
```
[heygen-poller:...] Built segmentData: X segments (Y avatar + Z source_clips)
```
Z should equal the number of stories that had video URLs.

---

## Fix 2 — Wire News TV card into assembly (intro card burn)

**File:** `server.js`
**Lines:** ~3802–3875 (the `else if (isIntro && contentType === 'news')` block)

### Root cause

The News intro card burn block at line 3802 exists and calls `generateNewscastOverlay()`, but it depends on `seg?.cardData` being populated:

```javascript
const cardData = seg?.cardData || {};
```

The `cardData` field is **never set** on News segments. The `segmentData` array built by the heygen-poller (lines 221–244) only sets `url`, `label`, and `type` on each segment — no `cardData`. So `cardData` is always `{}`, `allNewsIntros` is always `[]` (because the filter at line 3812 requires `s.cardData`), and the overlay renders with empty/default data.

Additionally, the `isIntro` regex at line 3707:
```javascript
const isIntro = (/\(INTRO\)/i.test(label) || /[_ ]INTRO$/i.test(label)) && !/cold.open/i.test(label) && !/^INTRO$/i.test(label);
```

News scene labels are `STORY1_INTRO`, `STORY2_INTRO`, etc. The regex `/[_ ]INTRO$/i` matches `_INTRO` at end of string — **this works correctly**. The `isIntro` detection is fine.

The problem is purely `cardData` being empty.

### The fix — two parts

**Part A: Populate `cardData` on News segments in the heygen-poller**

In the heygen-poller's segment-building loop (around line 221), after the `segmentData.push({ url, label, type: 'avatar' })` call, add cardData for News INTRO segments:

```javascript
// For News INTRO segments, attach story cardData so assembly can render the TV card
if (contentType === 'news' && /STORY(\d+)_INTRO/i.test(avatarSeg.sceneName)) {
  const storyMatch = avatarSeg.sceneName.match(/STORY(\d+)_INTRO/i);
  const storyIdx = storyMatch ? parseInt(storyMatch[1]) - 1 : -1;
  const storyItem = (card.newsItems || [])[storyIdx];
  if (storyItem) {
    segmentData[segmentData.length - 1].cardData = {
      title:    storyItem.title || `Story ${storyIdx + 1}`,
      category: storyItem.category || storyItem.source || 'WORLD NEWS',
      storyId:  `story_${storyIdx + 1}`,
      imageUrl: storyItem.thumbnailUrl || storyItem.imageUrl || null,
      source:   storyItem.source || ''
    };
  }
}
```

**Part B: Persist `newsItems` on the job card**

The heygen-poller reads `card.newsItems` above, but the job card currently only saves `streamers` for Twitch (line 7152):
```javascript
streamers: type === 'twitch' ? items.map(...) : [],
```

Add `newsItems` to the job card save at line ~7142:

```javascript
const jobCard = {
  jobId,
  contentType: type,
  date: dateStr,
  script,
  wordCount,
  estSecs,
  orderedClipUrls,
  heygen: heygenResult,
  gate1Score: scriptQA.score,
  streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s.streamer || s })) : [],
  newsItems: type === 'news' ? items.map(s => ({   // ← ADD THIS
    title:        s.title || '',
    source:       s.source || '',
    category:     s.category || 'WORLD NEWS',
    thumbnailUrl: s.thumbnailUrl || s.imageUrl || '',
    videoUrl:     s.videoUrl || s.clipUrl || '',
    link:         s.link || s.url || ''
  })) : [],
  clipsPerStreamer: req.body.clipsPerStreamer || 2
};
```

**Part C: Fix the `allNewsIntros` filter in the assembly burn block**

The current filter at line 3812 requires `s.cardData` to be truthy:
```javascript
return lbl.match(/\(INTRO\)/i) && s.cardData;
```

After Part A, `cardData` will be populated. But also update the regex to match News label format (`STORY1_INTRO` not `STORY1 (INTRO)`):

```javascript
const allNewsIntros = segsToProcess.filter(s => {
  const lbl = s.label || '';
  return (/STORY\d+_INTRO/i.test(lbl) || /\(INTRO\)/i.test(lbl)) && s.cardData;
});
```

### Verification

After this fix, run a News long-form. Check the assembly log for:
```
📰 NEWS newscast overlay burned [1/N]: Story headline here
📰 NEWS newscast overlay burned [2/N]: Story headline here
```
One line per story INTRO segment.

---

## Fix 3 — Add clip-presence and TV-card checks to Gate 3

**File:** `server.js`
**Function:** `geminiQACheck()` at line 1541
**Why:** Gate 3 currently checks lip sync, ticker, freeze, transitions, audio, avatar visibility, outro. It does NOT check whether source clips played or whether the TV card appeared. A 0-clip, 0-card video can score 93/100 and auto-proceed. This is the defensive fix that prevents regression.

### The fix

**Part A: Pass `clipCount` and `contentType` into the Gate 3 checklist**

`clipCount` is already passed into `geminiQACheck()` via `opts` (line 1542). `contentType` is also already in `opts`. Use them to add conditional checklist items.

In the `checklist` arrays (lines 1575–1592), add to the **MIDDLE** sample checklist:

```javascript
// Add clip-presence check if we expect source clips
...(clipCount > 0 ? [`${checklist.length + 1}. SOURCE CLIPS: Do you see any non-avatar footage (news clips, game highlights, or Twitch clips) playing in this section? (yes/no)`] : []),
```

And add to the **EARLY** sample checklist (for TV card — it appears during INTRO segments which are early in the video):

```javascript
// Add TV card check for long-form content
...(contentType && contentType !== 'short' ? [`${checklist.length + 1}. TV CARD: Is there a rectangular card with a gold border visible in the top-right area of the frame? (yes/no/not_applicable — answer not_applicable if this sample is during a source clip)`] : []),
```

**Part B: Add critical failure detection for missing clips**

After line 1683 (the `avDeSync` detection), add:

```javascript
// Missing source clips — critical if we expected clips but none played
const clipsExpectedButMissing = clipCount > 0 && /SOURCE CLIPS:.*no/i.test(fullReport);
```

And add it to the `hasCriticalFail` check at line 1684:
```javascript
const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync || clipsExpectedButMissing;
```

And add to the deductions list (after line 1691):
```javascript
if (clipsExpectedButMissing) deductions.push({ points: 25, reason: 'SOURCE CLIPS missing — expected clips did not play in assembled video' });
```

And add to the why-doc critical failures section (after line 1726):
```javascript
`Clips missing:  ${clipsExpectedButMissing ? '🚨 YES' : '✅ No'}`,
```

**Note on TV card:** Do NOT make missing TV card a hard-fail critical failure — the card is cosmetic and its absence shouldn't block a video from publishing. Add it to the checklist so Gemini reports on it, but don't wire it into `hasCriticalFail`. Rob can decide on a per-run basis.

### Verification

After this fix, run a News long-form with 0 clips (to test the guard). Gate 3 should return `fail` with `clipsExpectedButMissing: true` in the deductions. The video should NOT auto-proceed to Upload-Post.

---

## Fix 4 — Fix the all-avatar xfade freeze (News-specific concat path)

**File:** `server.js`
**Lines:** ~4086 (the `tsFiles.length > 30 || clipCount > 0` branch)

### Root cause

The freeze at ~205s in both overnight News runs is caused by the xfade branch being used for all-avatar News jobs. The condition at line 4086:

```javascript
} else if (tsFiles.length > 30 || clipCount > 0) {
  // use concat demuxer
```

A News long-form with 5 stories has: 1 INTRO + 5×4 scenes + 1 OUTRO = 22 avatar segments. That's **22 TS files** — below the `> 30` threshold. And `clipCount === 0` (before Fix 1 lands). So it falls through to the **xfade branch**, which has the known broken offset math when segment counts are uneven.

After Fix 1 lands, `clipCount > 0` will route News jobs to the concat demuxer automatically. But until Fix 1 is confirmed working in production, we should also add a segment-count floor for News:

```javascript
} else if (tsFiles.length > 30 || clipCount > 0 || (contentType === 'news' && tsFiles.length > 10)) {
  // Large job OR any source clips present OR News with >10 segments — use concat demuxer
```

**Why `> 10` for News:** A 5-story News show has 22 segments. Even a 3-story show has 14. The xfade branch is only safe for very short jobs (≤10 segments). This threshold ensures all realistic News long-form jobs use the reliable concat path.

**Long-term:** Once Fix 1 is confirmed working (News always has `clipCount > 0`), this `contentType === 'news'` guard becomes redundant but harmless. Leave it in as a safety net.

### Verification

After this fix, run a News long-form. The assembly log should show:
```
ℹ️  22 segments (5 source clips) — using concat demuxer (reliable A/V sync)
```
The freeze at ~205s should not recur.

---

## Commit strategy

```
Fix 1: feat(news): build orderedClipUrls for News in generate-full-script
Fix 2: feat(news): wire cardData + newsItems so News TV card burns in assembly
Fix 3: feat(gate3): add source-clip presence check + TV card check to Gate 3 QA
Fix 4: fix(assembly): force concat demuxer for News long-form (prevents xfade freeze)
```

Each commit must:
1. Update `STATUS.md` → `🤖 Last Agent Action` table
2. Not break Twitch or NBA assembly paths
3. Leave server in a working state (nodemon will auto-restart)

---

## Files changed

| File | Fixes |
|------|-------|
| `server.js` | All 4 fixes |
| `STATUS.md` | Last Agent Action table (4 rows, one per commit) |

No other files need to change.

---

## Testing checklist

After all 4 fixes are committed:

- [ ] Run a News long-form (3–5 stories) from the dashboard
- [ ] Confirm output filename contains `N_clips` (not `0_clips`)
- [ ] Confirm assembly log shows `📰 NEWS newscast overlay burned` for each story
- [ ] Confirm Gate 3 checklist includes SOURCE CLIPS and TV CARD items in the why-doc
- [ ] Confirm no freeze at ~205s in the assembled video
- [ ] Confirm Gate 3 would have caught the 0-clips case (check the new deduction logic)

---

## Rollback plan

If any fix causes a regression on Twitch:
- Fix 1: `orderedClipUrls` for News is additive — Twitch block is unchanged. No rollback risk.
- Fix 2: `newsItems` on job card is additive. `cardData` on segments is News-only. No rollback risk.
- Fix 3: Gate 3 checklist additions are conditional on `clipCount > 0`. Twitch jobs with clips already pass this check. No rollback risk.
- Fix 4: The `contentType === 'news'` guard is News-only. Twitch path unchanged. No rollback risk.

If server fails to start after any commit: `git revert HEAD` and push.

---

## Why this works (teaching section)

**Fix 1** is the root cause. The comment on line 6172 says "populated by twitch block" — that was the original design when only Twitch had source clips. News and NBA were added later but the `orderedClipUrls` build step was never added for them. The fix is a 10-line addition in the News analysis block.

**Fix 2** is the wiring fix. The News intro card burn code already exists and works — it just has no data to render because `cardData` was never attached to segments. The fix is: (a) save story metadata on the job card, (b) attach it to segments in the poller, (c) update the filter regex to match News label format.

**Fix 3** is the defensive gate fix. Gate 3 is the last automated check before a video ships to Upload-Post. Adding clip-presence detection means a structurally broken video (0 clips when clips were expected) can never auto-proceed again. This protects NBA and Twitch too.

**Fix 4** is the freeze fix. The xfade branch has known broken offset math for mixed-duration segments (documented in the code comment at line 4086). News jobs with 22 segments were falling through to xfade because they were below the `> 30` threshold and had `clipCount === 0`. The fix adds a News-specific floor so all realistic News jobs use the reliable concat demuxer.
