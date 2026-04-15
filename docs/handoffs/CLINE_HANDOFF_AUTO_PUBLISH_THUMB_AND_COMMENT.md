# CLINE HANDOFF — Auto-publish: thumbnail + pinned comment + chapters in description

**Priority:** P1 — closes THREE gaps in the end-to-end autonomous YouTube publish pipeline Rob spotted on the smoke test output
**Scope:** `server.js` only, ~70 lines across 4 locations
**Est. Cline time:** ~40 minutes including dry-run
**Depends on:** Nothing (independent — ships as part of tonight's paired dispatch)

---

## The three gaps

Rob ran an end-to-end smoke test that published 3 videos to YouTube (private). Title + description landed. **Three items missing:**

1. **No custom thumbnail** — YouTube auto-generated a random frame. Assembly already extracts `{filename}_thumb.jpg` at the 15-second mark (`server.js:4462-4476`), but autonomous Gate 6 never uploads it to Drive and never passes it to `/publish`.

2. **No pinned first comment** — Rob has fixed canonical templates per content type (below). The autonomous path needs to **ignore whatever Claude generates for `pinnedComment`** and always use the hardcoded template keyed by `contentType`.

3. **No chapter timestamps in description** — The dashboard has a working `generateYouTubeChapters()` at `cwn_production.html:2540-2598` that produces *"0:00 Intro / 0:23 Jason / ... / 9:15 Outro"* using real probed segment durations. It's a manual copy-paste workflow. The server has all the data it needs (`req.body.segments[]` with labels, `assemblyJobs[asmId].segmentDurations[]` with real ffprobe durations) but never builds chapters for the autonomous flow. **Rob confirmed:** Upload-Post API can't set YouTube chapters directly, but YouTube auto-detects them from the description if they're present with `0:00` as the first entry. **Append chapters to the description before calling `/publish`.**

YouTube cards and end screens are **permanently manual** per Rob — Upload-Post API doesn't support them.

---

## Canonical pinned comment templates

```js
const PINNED_COMMENT_TEMPLATES = {
  twitch: "What was your favorite streamer clip? Let me know below! 👇 If you enjoyed this, consider subscribing for more Twitch Soup episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  nba:    "What was your favorite game highlight? Let me know below! 👇 If you enjoyed this, consider subscribing for more Other Side of the Pillow episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  news:   "What was your favorite news story? Let me know below! 👇 If you enjoyed this, consider subscribing for more Because the Light Was On episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1"
};
```

Rob approved typo fix (`highligh` → `highlight`) and the News template wording (`game highligh` → `news story`).

---

## What to change — Part 1: hardcoded pinned comment templates

**File:** `server.js`
**Location:** near the top-level constants, right after `STREAMER_DISPLAY_NAMES` at line 4839 (or adjacent to it — keep the two related constants together)

### 1a. Add the PINNED_COMMENT_TEMPLATES constant

Insert right after the closing `}` of `STREAMER_DISPLAY_NAMES` (line 4839) and before `function getDisplayName` (line 4841):

```js
// ── Pinned first-comment templates (fixed per content type) ──────
// Used by autonomous Gate 6 publish to set the YouTube first comment.
// Rob's canonical wording — do NOT let Claude freestyle these.
const PINNED_COMMENT_TEMPLATES = {
  twitch: "What was your favorite streamer clip? Let me know below! 👇 If you enjoyed this, consider subscribing for more Twitch Soup episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  nba:    "What was your favorite game highlight? Let me know below! 👇 If you enjoyed this, consider subscribing for more Other Side of the Pillow episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  news:   "What was your favorite news story? Let me know below! 👇 If you enjoyed this, consider subscribing for more Because the Light Was On episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1"
};
```

### 1b. Use the template in the autonomous publish call

Find the variable extraction block at `server.js:4617-4624`:
```js
// Extract YouTube metadata (primary platform)
const ytMeta = publishCopy.platforms?.youtube || publishCopy;
const title       = ytMeta.title       || jobTitle || outFile;
const description = ytMeta.description || '';
const tags        = ytMeta.hashtags     || [];

assemblyJobs[asmId].publishCopy = publishCopy;
log(asmId, `  📋 Title: ${title}`);
```

Add the pinned comment lookup right after `const tags`:
```js
// Extract YouTube metadata (primary platform)
const ytMeta = publishCopy.platforms?.youtube || publishCopy;
const title       = ytMeta.title       || jobTitle || outFile;
const description = ytMeta.description || '';
const tags        = ytMeta.hashtags     || [];

// Pinned comment: use hardcoded template by content type (ignore Claude's freestyle)
// contentType may be 'twitch', 'nba', 'news', or a short-form variant like 'twitch-short'
const baseContentType = (contentType || '').replace('-short', '').toLowerCase();
const pinnedComment = PINNED_COMMENT_TEMPLATES[baseContentType] || '';

assemblyJobs[asmId].publishCopy = publishCopy;
log(asmId, `  📋 Title: ${title}`);
if (pinnedComment) log(asmId, `  💬 Pinned comment: ${pinnedComment.slice(0, 60)}...`);
```

**Note:** we normalize `twitch-short` → `twitch` so short-form content also gets the pinned comment even though it's less common.

### 1c. Pass pinnedComment into the /publish call

Find the publish payload at `server.js:4630-4642` (see Part 2 + Part 3 below for the other fields added in the same payload):

```js
const publishResp = await axios.post(
  `http://localhost:${process.env.PORT || 3000}/publish`,
  {
    driveUrl,
    platforms,
    title,
    description,  // ← will be replaced with description + chapters in Part 3
    tags,
    contentType: (contentType && contentType.includes('-short')) ? 'short' : 'long',
    async: true
  },
  { timeout: 120000 }
);
```

Add `pinnedComment` to the payload (only when non-empty — use `undefined` not `''`):
```js
pinnedComment: pinnedComment || undefined,
```

---

## What to change — Part 2: thumbnail Drive upload

**File:** `server.js`
**Location:** after the main MP4 Drive upload at line 4579-4588

### 2a. Upload the thumbnail frame to Drive

Find the block around `server.js:4579-4588`:
```js
const driveUrl = await uploadToDrive(outPath, outFile, jobTitle || outFile);
if (driveUrl) {
  assemblyJobs[asmId].driveUrl = driveUrl;
  // ...
  log(asmId, `\n>> PASTE THIS IN CLAUDE CHAT TO IMPORT TO CANVA:`);
  log(asmId, `   ${driveUrl}`);
  assemblyJobs[asmId].driveUrl = driveUrl;
```

Right after the second `assemblyJobs[asmId].driveUrl = driveUrl;` (line 4588), insert the thumbnail upload block:
```js
assemblyJobs[asmId].driveUrl = driveUrl;

// Upload extracted thumbnail frame to Drive so Upload-Post can hand YouTube
// a real custom thumbnail instead of a random auto-generated frame.
if (assemblyJobs[asmId].thumbFrame && fs.existsSync(assemblyJobs[asmId].thumbFrame)) {
  try {
    const thumbDriveUrl = await uploadToDrive(
      assemblyJobs[asmId].thumbFrame,
      assemblyJobs[asmId].thumbFilename,
      `Thumbnail — ${jobTitle || outFile}`
    );
    if (thumbDriveUrl) {
      assemblyJobs[asmId].thumbDriveUrl = thumbDriveUrl;
      log(asmId, `  🖼  Thumbnail uploaded to Drive: ${thumbDriveUrl}`);
    } else {
      log(asmId, `  ⚠️  Thumbnail Drive upload returned null — YouTube will auto-generate`);
    }
  } catch(thumbErr) {
    log(asmId, `  ⚠️  Thumbnail Drive upload failed: ${thumbErr.message} — YouTube will auto-generate`);
  }
}
```

**Important:** goes INSIDE the `if (driveUrl) { ... }` block. Thumbnail upload failure is non-fatal — log warning and continue. Main video is required; thumbnail is best-effort.

### 2b. Pass thumbnailUrl into the /publish call

Add to the same payload edited in Part 1c and Part 3c:
```js
thumbnailUrl: assemblyJobs[asmId].thumbDriveUrl || undefined,
```

---

## What to change — Part 3: chapter timestamps in description

**File:** `server.js`
**Location:** add a helper function near line 2540 area (alongside other assembly helpers) OR inline right before the `/generate-publish-copy` call at line 4600. Inline is fine since it's only called once.

### 3a. Build chapters from segments + probed durations

Right before `log(asmId, \`  📝 Gate 6a: Generating publish copy...\`);` at `server.js:4600`, insert the chapter-build block. Segments come from `req.body.segments` (same shape as `seg.label`, `seg.type` at line 3310), durations from `assemblyJobs[asmId].segmentDurations`.

```js
// Build YouTube chapters from segments + probed durations
// Mirrors cwn_production.html generateYouTubeChapters() logic
// First chapter MUST start at 0:00 for YouTube to auto-detect as chapters
function buildYouTubeChapters(segments, segmentDurations) {
  if (!Array.isArray(segments) || segments.length === 0) return '';

  let currentSec = 0;
  const chapters = [];
  let lastStreamerName = '';

  segments.forEach((seg, i) => {
    const label = (seg.label || '').toUpperCase();
    const isClip     = seg.type === 'source_clip';
    const isColdOpen = label.indexOf('COLD OPEN') > -1;
    const isIntro    = label.indexOf('INTRO') > -1 && !isColdOpen;
    const isOutro    = label.indexOf('OUTRO') > -1;

    // Chapter boundary: cold open, each streamer/story/game INTRO, outro
    if (isColdOpen || isIntro || isOutro) {
      const mm = Math.floor(currentSec / 60);
      const ss = Math.floor(currentSec % 60);
      const ts = `${mm}:${ss < 10 ? '0' : ''}${ss}`;

      let chapterTitle = null;
      if (isColdOpen) {
        chapterTitle = '0:00 Intro';
      } else if (isOutro) {
        chapterTitle = `${ts} Outro`;
      } else {
        // Extract name from label e.g. "JASON (INTRO)" → "Jason"
        const nameMatch = label.match(/^(.+?)\s*\(INTRO\)/);
        let streamerName = nameMatch ? nameMatch[1].trim() : label.replace('(INTRO)', '').trim();
        streamerName = streamerName.charAt(0) + streamerName.slice(1).toLowerCase();
        // Multi-word names e.g. JAY CINCO → Jay Cinco
        streamerName = streamerName.replace(/\s+([a-z])/g, (m, l) => ' ' + l.toUpperCase());
        if (streamerName && streamerName !== lastStreamerName) {
          chapterTitle = `${ts} ${streamerName}`;
          lastStreamerName = streamerName;
        }
      }

      if (chapterTitle && chapters.indexOf(chapterTitle) === -1) {
        chapters.push(chapterTitle);
      }
    }

    // Advance time using real probed duration, fallback to word-count estimate
    let dur = (segmentDurations && segmentDurations[i]) || seg.duration || seg.clipDuration || null;
    if (!dur) {
      if (isClip) {
        dur = 45; // fallback clip estimate
      } else {
        const wc = seg.wordCount || (seg.text ? seg.text.split(/\s+/).filter(Boolean).length : 15);
        dur = (wc / 130) * 60;
      }
    }
    currentSec += dur;
  });

  return chapters.join('\n');
}

// Build chapters for this assembly (or empty string if data missing)
const chapterText = buildYouTubeChapters(req.body.segments || [], assemblyJobs[asmId].segmentDurations);
if (chapterText) {
  log(asmId, `  📑 Chapters built (${chapterText.split('\n').length} markers)`);
} else {
  log(asmId, `  ⚠️  No chapters built — segments or durations missing`);
}
```

### 3b. Append chapters to description before /publish

Right after line 4620 (`const description = ytMeta.description || '';`) — or rather after Part 1b's edits which come first — you now have `description` and `chapterText`. Build the final description:

```js
// After Part 1b edits, add this block just before the publish payload:
const descriptionWithChapters = chapterText
  ? `${description}\n\n⏱ CHAPTERS\n${chapterText}`
  : description;

log(asmId, `  📋 Description length: ${descriptionWithChapters.length} chars${chapterText ? ' (includes chapters)' : ''}`);
```

### 3c. Pass descriptionWithChapters into the /publish call

In the publish payload, **replace** `description,` with `description: descriptionWithChapters,`:

```js
const publishResp = await axios.post(
  `http://localhost:${process.env.PORT || 3000}/publish`,
  {
    driveUrl,
    platforms,
    title,
    description: descriptionWithChapters,
    tags,
    pinnedComment: pinnedComment || undefined,
    thumbnailUrl: assemblyJobs[asmId].thumbDriveUrl || undefined,
    contentType: (contentType && contentType.includes('-short')) ? 'short' : 'long',
    async: true
  },
  { timeout: 120000 }
);
```

**Short-form note:** chapters on Shorts are not used by YouTube, but appending them to the description is harmless. If short-form, the cold-open + outro chapters will be the only entries, which is fine — YouTube will just ignore them for Shorts. No special-case needed.

---

## Final combined publish payload

After all three parts, the autonomous `/publish` call at `server.js:4630-4642` should look like:

```js
const publishResp = await axios.post(
  `http://localhost:${process.env.PORT || 3000}/publish`,
  {
    driveUrl,
    platforms,
    title,
    description: descriptionWithChapters,
    tags,
    pinnedComment: pinnedComment || undefined,
    thumbnailUrl: assemblyJobs[asmId].thumbDriveUrl || undefined,
    contentType: (contentType && contentType.includes('-short')) ? 'short' : 'long',
    async: true
  },
  { timeout: 120000 }
);
```

---

## What you MUST NOT change

- ❌ `cwn_production.html` — dashboard publish paths already work, this fix is server-only
- ❌ `/publish` endpoint itself at `server.js:7280+` — already accepts all three fields correctly (`privacyStatus`, `thumbnail_url`, `first_comment`, `youtube_description`)
- ❌ `/generate-publish-copy` endpoint at `server.js:7633+` — still runs and returns title/description/tags. We just OVERRIDE `pinnedComment` with the hardcoded template and APPEND chapters to the description
- ❌ The thumbnail extraction logic at `server.js:4462-4476` — already works, do not touch
- ❌ The `uploadToDrive` helper itself
- ❌ Dashboard-side `generateYouTubeChapters()` at `cwn_production.html:2540` — leave unchanged. The manual copy-paste workflow still works for any job Rob publishes from the dashboard manually
- ❌ YouTube cards or end screens — permanently manual per Rob, Upload-Post API doesn't support them
- ❌ Any bundling with the paired TV-card + 12-streamer dispatch — **this ships as the THIRD commit of tonight's dispatch, in its own commit**

---

## Verification

1. **Grep check:** `grep -n "PINNED_COMMENT_TEMPLATES" server.js` — should show definition + lookup (2 hits)
2. **Grep check:** `grep -n "thumbDriveUrl" server.js` — should show 3 hits (upload, storage, payload)
3. **Grep check:** `grep -n "buildYouTubeChapters\|chapterText\|descriptionWithChapters" server.js` — should show the helper + call + usage
4. **Syntax:** `node -c server.js` — must return 0
5. **Nodemon restart:** server should start cleanly
6. **Log check on next autonomous 12-streamer run:**
   - `🖼  Thumbnail uploaded to Drive: https://drive.google.com/...`
   - `💬 Pinned comment: What was your favorite streamer clip?...`
   - `📑 Chapters built (N markers)`
   - `📋 Description length: XXX chars (includes chapters)`
7. **YouTube verification (Rob's job, not Cline's):** next autonomous publish should land with:
   - Custom thumbnail visible (the extracted frame)
   - Pinned first comment under the video
   - Description ends with `⏱ CHAPTERS\n0:00 Intro\n...\nN:NN Outro`
   - YouTube auto-detects the chapters and shows the progress-bar segmentation

---

## STATUS.md update

Add a new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | server.js | Auto-publish: hardcoded pinned comment templates + thumbnail Drive upload + server-side chapter builder appended to description | [commit hash] |
```

---

## Commit message

```
fix(auto-publish): thumbnail + pinned comment + chapters in description

Rob's smoke tests published cleanly to YouTube (private) but were missing
three items. All three now land automatically:

1. Pinned first comment: hardcoded PINNED_COMMENT_TEMPLATES map keyed by
   content type (twitch/nba/news). Rob's canonical wording — ignores
   whatever Claude generates for pinnedComment via /generate-publish-copy.

2. Custom thumbnail: after main MP4 Drive upload, also upload the
   extracted 15s thumbnail frame (server.js:4462) to Drive, store the
   public URL as assemblyJobs[asmId].thumbDriveUrl, forward to /publish
   as thumbnailUrl. Non-fatal on failure — YouTube falls back to
   auto-generated frame.

3. Chapter timestamps: new buildYouTubeChapters() helper mirrors the
   dashboard's generateYouTubeChapters(). Uses segments + probed
   durations already available inside /assemble. Appended to the
   description before the /publish call. First chapter always 0:00
   so YouTube auto-detects them from the description.

YouTube cards and end screens remain permanently manual — Upload-Post
API does not support them.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to main.

---

## Scope summary

**IN:** `server.js` only, one commit, ~70 lines across 4 locations (PINNED_COMMENT_TEMPLATES constant, thumbnail upload block, chapter helper + build, combined payload)
**OUT:** dashboard edits, `/publish` endpoint changes, `/generate-publish-copy` changes, bundled commits, cards/end screens

Ships as commit #3 of tonight's paired dispatch (after TV card y=352, after 12-streamer drop visibility).
