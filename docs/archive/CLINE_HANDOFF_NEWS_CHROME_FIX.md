# CLINE HANDOFF: News Chrome Fixes (Post-Smoke-12)

**Agent:** Cline-A  
**Priority:** HIGH — blocks clean News output  
**Status:** READY — all root causes diagnosed, exact fix locations identified

---

## Issue 1: "AL JAZEERA" appearing in NOW COVERING box + sidebar story labels

### What's broken
The NOW COVERING segment tag (`.seg-name`) and sidebar story category labels (`.story-item-cat`) show the news outlet name ("AL JAZEERA", "BBC", etc.) instead of "WORLD NEWS" for half the episode — wherever directive stories come from Al Jazeera sources.

### Root cause
**File:** `lib/chromeDirectives.js`

**Line 139** — sidebar story category uses `s.source` (news outlet name) as the category:
```javascript
// CURRENT (WRONG):
category: s.source || 'WORLD NEWS',
```

**Line 155** — `activeCategory` passed to generateNewscastOverlay uses `directive.flag.source` (outlet name) as category:
```javascript
// CURRENT (WRONG):
activeCategory: directive.flag?.source || 'WORLD NEWS'
```

### Fix
```javascript
// Line 139 — REPLACE:
category: s.source || 'WORLD NEWS',
// WITH:
category: 'WORLD NEWS',

// Line 155 — REPLACE:
activeCategory: directive.flag?.source || 'WORLD NEWS'
// WITH:
activeCategory: 'WORLD NEWS'
```

The news outlet source (Al Jazeera, BBC, etc.) should NEVER appear as a category label anywhere in the chrome. "WORLD NEWS" is the correct and permanent label for all news stories. The outlet name is only used internally for scraping/attribution — it is not a display label.

**Also check server.js line 4361:**
```javascript
// CURRENT:
const activeCategory = (cardData.category && cardData.category !== cardData.source)
  ? cardData.category : 'WORLD NEWS';
// This logic is correct BUT only runs when USE_DIRECTIVE_CHROME=false (legacy path).
// The directive path (lib/chromeDirectives.js) is the active path for News.
```

---

## Issue 2: Story sidebar cards appear too light / not visible

### What's broken
Story sidebar cards appear washed out / not dark enough against the video background in the assembled output.

### Root cause
`backdrop-filter: blur(8px)` on `.story-item` (line 284 of `tools/clipzworld_newscast.html`) does not work in the PNG overlay pipeline. The overlay is a flat PNG composited over the video — backdrop-filter needs live video pixels to blur, which the PNG doesn't have. In some Puppeteer/Chromium versions this causes the element to render with reduced opacity instead of blurring, making cards appear lighter than intended.

### Fix
In `tools/clipzworld_newscast.html`, find `.story-item` CSS block and:
1. Remove `backdrop-filter: blur(8px)` 
2. Increase background opacity to compensate:

```css
/* CURRENT */
.story-item {
  background: rgba(13,20,36,0.92);
  border-left: 4px solid var(--gold);
  border-radius: 0 4px 4px 0;
  padding: 14px 16px;
  backdrop-filter: blur(8px);
  min-height: 90px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* FIX */
.story-item {
  background: rgba(13,20,36,0.97);
  border-left: 4px solid var(--gold);
  border-radius: 0 4px 4px 0;
  padding: 14px 16px;
  min-height: 90px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
```

If cards still appear light after removing backdrop-filter, make background fully opaque: `background: rgb(13,20,36);`

---

## Issue 3: Video seek corruption in QuickTime / VLC

### What's broken
Fast-forwarding in QuickTime or VLC corrupts the playback sequence. Sometimes the video won't play at all after seeking.

### Important note
This is a **local playback artifact only**. YouTube re-encodes all uploaded videos on ingest, so this will NOT affect published output. The video plays correctly start-to-finish.

### Root cause
The final concat MP4 doesn't have the `moov` atom at the start of the file (`faststart`). When seeking, QuickTime/VLC has to parse the full file to find the index, and with TS-derived streams this can corrupt the seek position.

### Fix
**File:** `server.js` — find the final FFmpeg concat command (the one that produces `outPath`, ~line 5040-5080). Add `-movflags +faststart` to its output arguments:

```javascript
// Add to the final concat ffmpeg args array, before the output path:
'-movflags', '+faststart',
```

Search for: `outPath` combined with `ffmpeg` + `concat` in the same args array to find the right call.

---

## Issue 4: Thumbnail is a raw video frame, not the designed thumbnail

### What's broken
The thumbnail uploaded to Drive (and YouTube) is a frame extracted at 15 seconds into the video (Bobby G mid-sentence, random delivery frame). YouTube already generates these automatically — uploading a random frame as a custom thumbnail adds no value.

### What was planned
A designed thumbnail using Canva with Bobby G + episode hook text. This was discussed in earlier sessions and is covered by two pending handoffs:
- `docs/handoffs/CLINE_HANDOFF_AUTO_PUBLISH_THUMB_AND_COMMENT.md`
- `docs/handoffs/CLINE_HANDOFF_THUMBNAIL_WIRE.md`

### Current code
`server.js:5112-5121` — extracts `_thumb.jpg` at 15s, uploads it to Drive alongside the video.

### Fix (short-term, until Canva wire ships)
Stop uploading the frame thumbnail to Drive — it provides no value over YouTube's auto-generated thumbnail. Comment out or remove the `thumbDriveUrl` upload block (~lines 5242-5262 in server.js). Keep the local `_thumb.jpg` extraction so the dashboard preview still works.

The Canva-generated thumbnail handoffs are the long-term solution. This short-term fix just stops uploading a bad thumbnail to YouTube.

---

## Priority Order

1. **Issue 1 (AL JAZEERA labels)** — 2-line fix in `lib/chromeDirectives.js`, ship immediately
2. **Issue 2 (dark story cards)** — CSS change in `tools/clipzworld_newscast.html`  
3. **Issue 3 (seek corruption)** — one flag in `server.js` final concat
4. **Issue 4 (thumbnail)** — stop uploading frame thumb to Drive (Canva handoffs are the real fix)

---

## Test After Fix

Run a fresh News assembly (5 stories, mixed sources). Verify:
1. `.seg-name` / NOW COVERING shows "WORLD NEWS" for ALL stories throughout the entire episode — never a news outlet name
2. Sidebar story-item-cat shows "WORLD NEWS" for all non-active stories
3. Story card backgrounds are clearly dark/visible against bright video backgrounds
4. Seek to any point in QuickTime — playback should not corrupt
5. Drive upload does NOT include a random-frame thumbnail (or Canva thumbnail is there instead)
