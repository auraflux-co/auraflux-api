# Multi-Platform Publishing Requirements for CWN Shorts

**Question:** Can the same short video assembly be used for all platforms (YouTube Shorts, TikTok, Instagram Reels)?
**Answer:** ✅ **YES** — with platform-specific metadata and some caveats.

---

## Core Workflow: One Video, Multiple Platforms

### ✅ What's the Same (Universal)

**Single 9:16 MP4 Assembly** works for all short-form platforms:
- Aspect ratio: 9:16 (1080×1920 or 720×1280)
- Format: MP4 (H.264 video, AAC audio)
- Frame rate: 30fps or 60fps
- Duration: 15-60 seconds optimal (all platforms support this range)
- Resolution: 1080p preferred (scales down automatically on platforms)

**Assembly pipeline produces ONE file that works everywhere:**
```
/assemble → output/cwn_short_2026-04-06.mp4 (9:16)
            ↓
            Used for: YouTube Shorts + TikTok + Instagram Reels
```

### ⚠️  What Changes Per Platform (Pre-Publish)

**Metadata requirements differ significantly:**

| Requirement | YouTube Shorts | TikTok | Instagram Reels |
|-------------|----------------|--------|-----------------|
| **Title** | 100 chars max | 90 chars max | No title field |
| **Description** | 5000 chars max | Caption in title field | 2200 chars max |
| **Hashtags** | In description | In caption (title) | In caption |
| **#Shorts tag** | ✅ Required | ❌ N/A | ❌ N/A |
| **Thumbnail** | ✅ Custom upload | ❌ Auto-generated | ❌ Auto-generated |
| **Privacy** | public/unlisted/private | PUBLIC_TO_EVERYONE | public |
| **Category** | Entertainment (24) | N/A | N/A |
| **Made for Kids** | ✅ Must declare | ❌ N/A | ❌ N/A |
| **AI-generated label** | containsSyntheticMedia | is_aigc: true | N/A |
| **Pinned comment** | ✅ Supported | ❌ N/A | ❌ N/A |
| **Max duration** | 60s | 10 minutes | 90s |
| **Min duration** | Any | 3s | Any |

---

## Current Implementation Analysis

### ✅ What's Already Built

**1. Single `/publish` Endpoint Handles All Platforms**

Location: `server.js:4185-4342`

```javascript
POST /publish
Body: {
  driveUrl: "https://drive.google.com/...",
  platforms: ['youtube', 'tiktok', 'instagram'],  // ← Publish to all 3 at once
  title: "...",
  description: "...",
  contentType: "short",  // ← Tells Upload-Post this is 9:16
  privacyStatus: "public",
  thumbnailUrl: "...",   // ← YouTube only
  pinnedComment: "..."   // ← YouTube only
}
```

**2. Platform-Specific Metadata Handling**

```javascript
// YouTube Shorts
if (platforms.includes('youtube')) {
  form.append('youtube_title', title + ' #Shorts');  // Auto-adds #Shorts
  form.append('youtube_description', description);
  form.append('thumbnail_url', thumbnailUrl);        // Custom thumbnail
  form.append('first_comment', pinnedComment);       // Pinned comment
  form.append('containsSyntheticMedia', 'true');     // AI label
  form.append('madeForKids', 'false');
}

// TikTok
if (platforms.includes('tiktok')) {
  form.append('tiktok_title', title.substring(0, 90));  // 90 char limit
  form.append('is_aigc', 'true');                       // AI-generated label
  form.append('post_mode', 'DIRECT_POST');
}

// Instagram Reels
if (platforms.includes('instagram')) {
  form.append('media_type', 'REELS');
  form.append('instagram_title', description);  // Uses description as caption
}
```

**3. Upload-Post API Handles Platform Differences**

Upload-Post Professional ($50/mo) abstracts platform-specific APIs:
- YouTube Data API v3 (OAuth)
- TikTok Content Posting API
- Instagram Graph API (Meta)

Single call to Upload-Post distributes to all platforms simultaneously.

---

## ⚠️  Current Gaps in Multi-Platform Workflow

### Gap 1: `/generate-publish-copy` Only Generates YouTube Metadata

**Status:** 🟡 PARTIAL IMPLEMENTATION

**Current behavior:**
- Endpoint generates: `title`, `description`, `hashtags`, `pinnedComment`
- Optimized for YouTube format (100 char titles, long descriptions)
- TikTok and Instagram have different requirements

**What's missing:**

**TikTok needs:**
- Combined caption (title + hashtags, max 2200 chars but typically 90-150 chars for engagement)
- Different hashtag strategy (#FYP, #ForYou, trending sounds)
- No separate title/description split

**Instagram needs:**
- Caption format (description + hashtags, max 2200 chars)
- Hook in first 125 chars (gets truncated with "...more")
- Instagram-specific hashtags (#Reels, #Explore)

**Recommendation:** Enhance `/generate-publish-copy` to generate platform-specific metadata:

```javascript
POST /generate-publish-copy
Body: {
  contentType: "nba",
  formType: "short",
  script: "...",
  platforms: ['youtube', 'tiktok', 'instagram']  // ← NEW: specify target platforms
}

Response: {
  youtube: {
    title: "Lakers EDGE Warriors! LeBron's Triple-Double! #Shorts",
    description: "Full game recap...",
    hashtags: ["#NBA", "#Lakers", "#Shorts"],
    pinnedComment: "What was your favorite play?"
  },
  tiktok: {
    caption: "LeBron at 41 with a triple-double! 🐐 Lakers edge Warriors 112-108 in OT thriller! #NBA #LeBron #Lakers #Warriors #Basketball #FYP #ForYou"
  },
  instagram: {
    caption: "LeBron at 41 with a triple-double! 🐐 Lakers edge Warriors 112-108 in OT thriller! Watch the full highlights now! #NBA #LeBron #Lakers #Warriors #Basketball #Reels #Explore #InstaSports"
  }
}
```

### Gap 2: Thumbnail Only Generated for YouTube

**Status:** 🟡 DESIGN DECISION NEEDED

**Current behavior:**
- Canva thumbnail auto-generated (when working)
- Only uploaded to YouTube via `thumbnail_url` parameter
- TikTok and Instagram auto-generate from video frames

**Options:**

**Option A: YouTube Only (Current)**
- Pros: TikTok/Instagram auto-thumbnails work well
- Cons: Can't control what frame they choose
- Recommendation: ✅ **Keep this** unless you want custom frame selection

**Option B: Custom Frame Selection for All Platforms**
- Use FFmpeg to extract specific frame as thumbnail
- Upload as first frame of video (platforms sample from first few frames)
- Requires re-encoding video to ensure thumbnail frame is at 0:00:00

```bash
# Extract frame at 15 seconds (current thumbnail extraction point)
ffmpeg -i input.mp4 -ss 15 -frames:v 1 thumbnail.jpg

# Overlay thumbnail at start of video (first 0.1s)
ffmpeg -i input.mp4 -i thumbnail.jpg -filter_complex \
  "[1:v]scale=1080:1920,loop=3:1,setpts=N/FRAME_RATE/TB[thumb]; \
   [0:v][thumb]concat=n=2:v=1[v]" \
  -map "[v]" -map 0:a output.mp4
```

**Option C: Platform-Specific Thumbnail URLs (If APIs Support)**
- Check Upload-Post API docs for TikTok/Instagram thumbnail upload
- Likely not supported (these platforms prefer auto-generation)

### Gap 3: Platform-Specific Assembly Requirements Not Enforced

**Status:** 🟢 WORKING (No Changes Needed)

**All platforms accept the same video specs:**
- 9:16 aspect ratio ✅
- MP4 container ✅
- H.264 video codec ✅
- AAC audio codec ✅
- 30fps or 60fps ✅

**No platform-specific encoding required.** Upload-Post handles any necessary transcoding.

---

## Recommended Workflow: One Assembly, Multi-Platform Publish

### Step 1: Assemble Once (9:16 Short)

```javascript
POST /assemble
Body: {
  asmId: "short_nba_20260406",
  segments: [...],  // HeyGen segments (9:16 avatar)
  contentType: "nba",
  formType: "short",
  clipUrls: [...],  // Source clips (if needed)
  title: "Lakers vs Warriors NBA Short"
}

→ Produces: output/short_nba_20260406.mp4 (9:16, 45 seconds)
```

**No platform-specific assembly.** Same file works for all.

### Step 2: Upload to Google Drive

```javascript
// Automatic after assembly if Gate 3 passes
// OR manual trigger:
POST /upload-to-drive
Body: {
  filename: "short_nba_20260406.mp4",
  title: "Lakers vs Warriors NBA Short"
}

→ Returns: driveUrl
```

### Step 3: Generate Platform-Specific Metadata

**Current (YouTube Only):**
```javascript
POST /generate-publish-copy
Body: {
  contentType: "nba",
  formType: "short",
  script: "..."
}

→ Returns: { title, description, hashtags, pinnedComment }
```

**Recommended Enhancement:**
```javascript
POST /generate-publish-copy
Body: {
  contentType: "nba",
  formType: "short",
  script: "...",
  platforms: ['youtube', 'tiktok', 'instagram']  // ← NEW
}

→ Returns: {
  youtube: { title, description, hashtags, pinnedComment },
  tiktok: { caption },
  instagram: { caption }
}
```

### Step 4A: Publish to All Platforms Simultaneously

```javascript
POST /publish
Body: {
  driveUrl: "https://drive.google.com/uc?export=download&id=...",
  platforms: ['youtube', 'tiktok', 'instagram'],

  // YouTube metadata
  title: "Lakers EDGE Warriors! LeBron's Triple-Double!",
  description: "Full game recap with highlights...",
  tags: ["NBA", "Lakers", "Warriors"],
  thumbnailUrl: "https://canva.com/export/...",
  pinnedComment: "What was your favorite play?",

  // Platform-agnostic
  contentType: "short",
  privacyStatus: "public"
}
```

Upload-Post distributes automatically:
- **YouTube:** Uses `title + #Shorts`, `description`, `tags`, `thumbnailUrl`, `pinnedComment`
- **TikTok:** Uses `title` (truncated to 90 chars), auto-generates thumbnail
- **Instagram:** Uses `description` as caption, auto-generates thumbnail

### Step 4B: Publish to Platforms Separately (If Needed)

```javascript
// YouTube Shorts
POST /publish
Body: {
  driveUrl: "...",
  platforms: ['youtube'],
  title: "Lakers EDGE Warriors! LeBron's Triple-Double!",
  description: "Full recap...",
  thumbnailUrl: "...",
  pinnedComment: "..."
}

// TikTok (different caption)
POST /publish
Body: {
  driveUrl: "...",
  platforms: ['tiktok'],
  title: "LeBron at 41 with a triple-double! 🐐 #NBA #FYP",
  contentType: "short"
}

// Instagram Reels (different caption)
POST /publish
Body: {
  driveUrl: "...",
  platforms: ['instagram'],
  description: "LeBron dominates Warriors! Full highlights 🏀 #NBA #Reels",
  contentType: "short"
}
```

---

## Platform-Specific Best Practices

### YouTube Shorts

**Title Strategy:**
- Max 100 chars (hard limit)
- Auto-append `#Shorts` tag
- Include keywords: player names, teams, hook
- Example: `"Lakers EDGE Warriors in OT! LeBron's 28-8-11 Triple-Double! #Shorts"`

**Description:**
- Full game summary (200-300 words)
- Subscribe CTA
- Credit sources (ESPN, NBA)
- Can be longer than TikTok/Instagram

**Thumbnail:**
- ✅ **Upload custom thumbnail** (required for good CTR)
- 1280×720 (16:9) — YouTube auto-crops for Shorts shelf
- Generated via Canva templates (Option 3 or 4)
- Bright, high contrast, readable text

**Hashtags:**
- 5-8 tags in description
- Always include `#Shorts` (auto-added by code)
- Example: `#NBA #Lakers #Warriors #LeBronJames #Basketball`

**Pinned Comment:**
- ✅ **Use pinned comment** for engagement
- Ask question, prediction, or poll
- Example: `"LeBron at 41! 🐐 Who's your MVP pick? Drop your predictions! 👇"`

### TikTok

**Caption Strategy:**
- Max 2200 chars but optimal is 90-150 chars for engagement
- Hook in first 40 chars (above "...more" fold)
- Include emojis for visual appeal
- Hashtags mixed into caption (not separate)
- Example: `"LeBron at 41 with a triple-double! 🐐 Lakers edge Warriors 112-108 #NBA #LeBron #FYP #ForYou"`

**Hashtags:**
- 4-6 hashtags mixed into caption
- Always include 1-2 trending/generic tags (`#FYP`, `#ForYou`)
- 2-3 niche tags (`#NBA`, `#Lakers`)
- Example: `#NBA #LeBron #Lakers #Warriors #FYP #ForYou`

**Thumbnail:**
- ❌ **No custom upload** (TikTok auto-generates from first frame)
- Ensure first 3 seconds have strong visual hook
- Assembly should start with engaging frame (LeBron's face, dunk, celebration)

**Audio:**
- TikTok prefers trending sounds, but original audio is fine for sports
- AI-generated voice is marked with `is_aigc: true` flag

### Instagram Reels

**Caption Strategy:**
- Max 2200 chars
- Hook in first 125 chars (truncated with "...more")
- Include emojis, line breaks for readability
- Hashtags at end of caption (or in first comment)
- Example:
  ```
  LeBron at 41 with a triple-double! 🐐

  Lakers edge Warriors 112-108 in an OT thriller!
  Watch the full highlights now! 🏀

  #NBA #LeBron #Lakers #Warriors #Basketball #Reels #Explore #InstaSports
  ```

**Hashtags:**
- 10-15 hashtags (Instagram allows up to 30 but 10-15 is optimal)
- Mix of trending (`#Reels`, `#Explore`) and niche (`#NBA`, `#Lakers`)
- Can put hashtags in caption or first comment

**Thumbnail:**
- ❌ **No custom upload** (Instagram auto-generates cover frame)
- User can manually select cover frame from video after upload
- Assembly should ensure first 3-5 seconds have multiple strong frames

**Aspect Ratio:**
- 9:16 preferred (full-screen Reels)
- 4:5 also supported but less immersive

---

## Upload-Post API: What It Tells Us

### Multi-Platform Parameters Supported

**From Upload-Post API docs and current implementation:**

```javascript
// Universal parameters (all platforms)
video: "https://...",           // Drive URL or file upload
user: "clipznashite",           // Account profile
async_upload: "true",           // Background processing
scheduled_date: "ISO-8601",     // Schedule post

// YouTube-specific
youtube_title: "...",
youtube_description: "...",
tags[]: "...",
privacyStatus: "public",
categoryId: "24",
thumbnail_url: "...",           // Custom thumbnail
first_comment: "...",           // Pinned comment
containsSyntheticMedia: "true",
madeForKids: "false",

// TikTok-specific
tiktok_title: "...",            // Max 90 chars (but actually caption, up to 2200)
privacy_level: "PUBLIC_TO_EVERYONE",
post_mode: "DIRECT_POST",
is_aigc: "true",                // AI-generated label
brand_content_toggle: "false",

// Instagram-specific
media_type: "REELS",
instagram_title: "...",         // Actually caption, max 2200 chars

// Threads-specific
threads_title: "...",           // Caption
```

### What Upload-Post Handles Automatically

✅ **Video transcoding** (if needed)
✅ **OAuth authentication** (per platform)
✅ **Platform-specific API calls** (YouTube Data API, TikTok API, Instagram Graph API)
✅ **Error handling & retries**
✅ **Status polling** (via `/publish/status?request_id=...`)

### What You Must Provide

⚠️  **Platform-appropriate metadata** (title lengths, hashtag formats, etc.)
⚠️  **Valid Drive URL** (public access, direct download link)
⚠️  **Correct `contentType`** (`'long'` for 16:9, `'short'` for 9:16)

---

## CapCut API: What It Can Tell Us (If Integrated)

**Note:** CapCut MCP is currently used for advanced assembly (ticker baking, transitions). It can also provide:

### Platform Export Presets

```javascript
// CapCut API can export with platform-optimized settings
POST /capcut/export
Body: {
  platform: "youtube_shorts" | "tiktok" | "instagram_reels",
  video_id: "...",
  quality: "1080p"
}
```

**Platform-specific optimizations:**
- **YouTube Shorts:** H.264, AAC, 30fps, 9:16, max bitrate
- **TikTok:** H.264, AAC, 30fps, 9:16, optimized for mobile
- **Instagram Reels:** H.264, AAC, 30fps, 9:16, color profile adjustments

**Current Implementation:**
We're not using CapCut's platform-specific export presets. We use universal FFmpeg settings that work for all platforms. This is fine because Upload-Post handles any necessary transcoding.

**Recommendation:** ✅ **Keep current approach** — no need to complicate assembly with platform-specific exports when Upload-Post handles it.

---

## Recommendations Summary

### ✅ What Works (Keep As-Is)

1. **Single 9:16 assembly for all short-form platforms** — no platform-specific video encoding needed
2. **Upload-Post `/publish` endpoint** — already handles multi-platform distribution
3. **Platform-specific parameters** — already implemented in server.js
4. **Universal video specs** — H.264/AAC works everywhere

### 🔧 What Needs Enhancement

1. **Enhance `/generate-publish-copy` to generate platform-specific metadata**
   - Add `platforms: []` parameter
   - Return separate metadata objects for YouTube, TikTok, Instagram
   - Different caption strategies per platform
   - See implementation example above

2. **Create `/generate-thumbnail` workflow for YouTube only**
   - Fix Canva endpoint (currently returns no design_url)
   - TikTok and Instagram don't need custom thumbnails (auto-generated works fine)

3. **Update dashboard to show platform-specific publish forms**
   - If publishing to YouTube: show thumbnail upload, pinned comment
   - If publishing to TikTok: show shorter caption field (90-150 chars optimal)
   - If publishing to Instagram: show caption format with line breaks

### 📝 Implementation Priority

**P0 (Required for multi-platform publishing):**
1. Fix `/generate-publish-copy` to support platform-specific metadata
2. Test Upload-Post with all 3 platforms (YouTube, TikTok, Instagram)

**P1 (Nice to have):**
1. Fix Canva thumbnail endpoint for YouTube
2. Dashboard UI improvements for platform-specific fields

**P2 (Future enhancements):**
1. CapCut platform-specific export presets (if transcoding becomes an issue)
2. Platform-specific analytics integration

---

## Example: End-to-End Multi-Platform Workflow

```javascript
// 1. Assemble 9:16 short (ONCE)
POST /assemble → short_nba_20260406.mp4

// 2. Upload to Drive (ONCE)
POST /upload-to-drive → driveUrl

// 3. Generate metadata (platform-specific)
POST /generate-publish-copy
Body: {
  contentType: "nba",
  formType: "short",
  script: "...",
  platforms: ['youtube', 'tiktok', 'instagram']
}
→ Returns platform-specific titles/captions

// 4. Generate thumbnail (YouTube only)
POST /generate-thumbnail
Body: { contentType: "nba", hookLine: "Lakers edge Warriors in OT!" }
→ Returns Canva design URL

// 5. Publish to all platforms (ONE CALL)
POST /publish
Body: {
  driveUrl: "...",
  platforms: ['youtube', 'tiktok', 'instagram'],

  // YouTube fields
  title: "Lakers EDGE Warriors in OT! LeBron's Triple-Double!",
  description: "Full game recap...",
  tags: ["NBA", "Lakers", "Warriors", "LeBronJames"],
  thumbnailUrl: "https://canva.com/...",
  pinnedComment: "What was your favorite play?",

  contentType: "short",
  privacyStatus: "public"
}

→ Upload-Post publishes to all 3 platforms simultaneously
→ Returns: { request_id, results: { youtube: {...}, tiktok: {...}, instagram: {...} } }
```

**Result:** One 9:16 video published to 3 platforms with optimized metadata for each.
