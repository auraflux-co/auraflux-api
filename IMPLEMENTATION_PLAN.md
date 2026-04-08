# CWN Complete Implementation Plan

**Date:** April 6, 2026
**Status:** Ready to implement with all information gathered

---

## ✅ ALL CRITICAL INFO GATHERED

### Brand Colors
- **CWN:** Navy #22304b, Gold #c7af4f
- **NBA:** Metallic Blue #17408B, British Red #C9082A, White #FFFFFF
- **Twitch:** Purple #9146FF (confirmed)

### HeyGen Avatar IDs (server.js:5372)
```javascript
landscape: {
  avatarId: '19c1d4adf8904694a3cc331c5a9bee4b',  // Long form 16:9
  dimensions: '1920x1080',
  useFor: 'YouTube long form compilations'
},
portrait: {
  avatarId: 'ed57439c9c3d4a398f3b247b75714b13',  // Short form 9:16
  dimensions: '1080x1920',
  useFor: 'TikTok, Instagram Reels, YouTube Shorts'
},
voiceId: '2e598f1a6022448cb6710e5d44665325',
baseSpeed: 0.85,
reactionSpeed: 0.95
```

### Assets Located
- ✅ `assets/bobbyg_short_form.png` (4.0MB - transparent PNG)
- ✅ `assets/cwn_logo.png` (49KB)
- ✅ `assets/cwn_banner.png` (86KB)
- ✅ `assets/Screenshot 2026-04-02 at 8.20.02 PM.png` (706KB - thumbnail example)
- ✅ `assets/Screenshot 2026-04-05 at 1.23.52 PM.png` (36KB - thumbnail example)

### News Source Acquisition (Found in cwn_production.html)
**Method:** RSS feed via RSS2JSON API

```javascript
// Al Jazeera RSS Feed
feedUrl = 'https://api.rss2json.com/v1/api.json?rss_url=' +
          encodeURIComponent('https://www.aljazeera.com/xml/rss/all.xml');

// Dashboard loads stories, user selects one
// Story object: { title, description, source, link, thumbnailUrl }
```

**Location in dashboard:** cwn_production.html:2437-2444, 3218-3236

### Style Guides (cwn_style_guides.json) ✅ CONFIRMED
- **Twitch:** Sarcastic, witty, Norm MacDonald deadpan
- **NBA:** Conversational, respectful enthusiasm, analytical
- **News:** Deadpan absurdity, skeptical outsider

### Dashboard Features (cwn_production.html)
- "Save reference library" button
- "Teach Gemini one-time" button
- Pronunciations section (HeyGen concern)
- Streamer language library (Gemini learns vocab + bits)

---

## NBA COMPILATION CLARIFICATION

**What it is:**
- Compilation of ALL yesterday's NBA games
- Bobby G narrates highlights
- **Audio stripped from original source video**
- Bobby G voiceover mixed OVER the clip video (no game audio)

**Code location:** server.js:1809-1845 (assembly pipeline)

```javascript
// For NBA compilations: mix avatar audio OVER the source clip video
// Mix the avatar's audio track over the clip's video track
voiceoverFiles[i] = null; // remove avatar (audio used, video dropped)
```

---

## SHORT FORM WORKFLOW CLARIFICATION

**Content Selection:**
- One Al Jazeera story selected per day (from RSS feed)
- User selects story in dashboard
- Dashboard already has this functionality (line 4661-4769)

**Caption & Reaction:**
- One line for caption (Gemini generates after watching)
- One line for voice reaction (Bobby G reaction audio)
- Same style guides apply

**Split Screen Layout:**
```
+-------------------+
| News Source Video |  (50% width)
| (Al Jazeera clip) |
+-------------------+
| Bobby G Reaction  |  (50% width)
| (HeyGen avatar)   |
+-------------------+
```

---

## IMPLEMENTATION PHASES

### PHASE 1: FFmpeg Thumbnail Generator (Priority 1)

**What to build:**
1. `/generate-thumbnail-ffmpeg` endpoint
2. Three variants: `twitch`, `nba`, `news`
3. Auto-increment episode numbers

**Twitch "Twitch Soup" Thumbnail:**
```
Layer 1: Background (Twitch purple #9146FF gradient)
Layer 2: Bobby G avatar (center, 70% opacity, from bobbyg_short_form.png)
Layer 3: 11 streamer circles (from profile images, prominent)
Layer 4: Text overlays:
  - "Twitch Soup" (top, CWN gold #c7af4f)
  - Date (e.g., "Friday, April 6, 2026")
  - Episode # (e.g., "Episode 42")
Layer 5: CWN logo (top right, assets/cwn_logo.png)
```

**NBA Thumbnail:**
```
Layer 1: Background (NBA colors: Blue #17408B, Red #C9082A gradient)
Layer 2: Bobby G avatar (center or as per example screenshots)
Layer 3: Text overlays:
  - Title (e.g., "NBA Highlights")
  - Date
  - Episode #
Layer 4: CWN logo (top right)
```

**News Thumbnail:**
```
Layer 1: Background (CWN Navy #22304b)
Layer 2: Bobby G avatar
Layer 3: Text overlays:
  - Title (e.g., "World News")
  - Date
  - Episode #
Layer 4: CWN logo (top right)
```

**Episode Number Logic:**
```javascript
// Store episode counters in file: episode_counters.json
{
  "twitch": 1,
  "nba": 1,
  "news": 1
}

// Increment on each thumbnail generation
// Reset never (continuous count)
```

**Implementation:**
```javascript
app.post('/generate-thumbnail-ffmpeg', async (req, res) => {
  const { contentType, date, streamers } = req.body;
  // contentType: 'twitch' | 'nba' | 'news'

  // 1. Load episode counter
  const episodeNum = getNextEpisodeNumber(contentType);

  // 2. Generate thumbnail using ImageMagick composite
  const thumbnailPath = await generateThumbnailFFmpeg({
    contentType,
    date,
    episodeNum,
    streamers, // Only for Twitch
    bobbyGAvatar: 'assets/bobbyg_short_form.png',
    logo: 'assets/cwn_logo.png'
  });

  // 3. Return path
  res.json({ ok: true, thumbnailPath, episodeNum });
});
```

---

### PHASE 2: Short Form Split-Screen Workflow (Priority 2)

**Step 1: News Story Selection** ✅ ALREADY EXISTS
- Dashboard loads Al Jazeera RSS (cwn_production.html:4661)
- User selects story
- Story includes: title, description, link, thumbnailUrl

**Step 2: Video Acquisition** ❌ NEEDS IMPLEMENTATION
**Question:** How to get actual video file from Al Jazeera story?
- Option A: Manual download from Al Jazeera website
- Option B: Scrape video URL from story page
- Option C: Use thumbnailUrl as static image + pan/zoom effect

**Recommendation:** Start with Option C (static image + Ken Burns effect)

**Step 3: Bobby G Reaction Generation**
```javascript
// Generate short form script (one-line reaction)
const reactionScript = await generateShortFormReaction({
  storyTitle: story.title,
  storyDescription: story.description,
  contentType: 'news' // or 'nba', 'twitch'
});

// HeyGen render (portrait avatar)
const bobbyGClip = await renderHeyGenSegment({
  text: reactionScript,
  avatarId: 'ed57439c9c3d4a398f3b247b75714b13', // Portrait
  voiceId: '2e598f1a6022448cb6710e5d44665325',
  speed: 0.95 // Reaction speed
});
```

**Step 4: Split-Screen Assembly (CapCut API)**
```javascript
// Create draft
await capcut.createDraft({ width: 1080, height: 1920 });

// Add news source video (left 50%)
await capcut.addVideo({
  videoPath: newsSourceVideo,
  x: 0,
  y: 0,
  width: 540,  // 50% of 1080
  height: 1920
});

// Add Bobby G reaction (right 50%)
await capcut.addVideo({
  videoPath: bobbyGClip,
  x: 540,  // Right half
  y: 0,
  width: 540,
  height: 1920
});

// Add captions (generated by Gemini after watching)
const caption = await geminiGenerateCaption(assembledVideo);
await capcut.addText({
  text: caption,
  position: 'bottom',
  style: 'bold',
  fontSize: 48
});

// Save draft
const finalVideo = await capcut.saveDraft();
```

**Step 5: Platform Optimization (CapCut API)**
```javascript
// Base video → 3 platform variants
for (const platform of ['youtube', 'tiktok', 'instagram']) {
  const optimized = await capcut.optimizeForPlatform({
    baseVideo: finalVideo,
    platform: platform,
    effects: getPlatformEffects(platform),
    captions: getPlatformCaptionStyle(platform)
  });

  // Store for publishing
  platformVideos[platform] = optimized;
}
```

**Step 6: Gemini Caption Generation**
```javascript
// After assembly, Gemini watches and generates caption
const caption = await gemini.analyze({
  videoPath: finalVideo,
  prompt: `Watch this short form video. Generate a one-line caption (<150 chars) that:
  - Hooks viewers immediately
  - Matches the ${contentType} style guide tone
  - Works for ${platform} algorithm

  Style: ${styleGuides[contentType]}`
});

// Returns: "When the news is too wild even for Bobby G 😳"
```

---

### PHASE 3: Update "THE DAILY UPDATE" → "Twitch Soup" (Priority 3)

**Files to update:**
1. server.js:5731 (thumbnail text)
2. All script prompts mentioning "Daily Update"
3. Documentation files

**Find & Replace:**
```bash
grep -r "Daily Update\|THE DAILY UPDATE" --include="*.js" --include="*.html" . | wc -l
# Then update each occurrence
```

---

### PHASE 4: Pronunciations & HeyGen Best Practices (Priority 4)

**Current Issue:** Pronunciations concern for HeyGen

**Solution:** SSML (Speech Synthesis Markup Language)

**Implementation:**
```javascript
// In script generation, add pronunciation hints
const script = `
  The NBA game between the <phoneme alphabet="ipa" ph="ˈleɪkərz">Lakers</phoneme>
  and Warriors was intense.
`;

// Or use HeyGen's pronunciation dictionary
const pronunciationDict = {
  "LeBron": "luh-BRAWN",
  "Giannis": "YAH-niss",
  "Jokić": "YO-kitch"
};
```

**Where to store:** `cwn_pronunciations.json`

**Integration:** Feed to HeyGen API in text field

---

### PHASE 5: Transcript Beat Formatting Review (Priority 5)

**Current Concern:** Bobby G may "glitch through scenes"

**Root Cause:** Beats not aligned with HeyGen segment boundaries

**Solution:**
1. Ensure beats occur at natural pauses
2. Validate beat timing matches video cuts
3. Add buffer zones around scene transitions

**Implementation:**
```javascript
// In assembly pipeline, validate beat timing
function validateBeats(transcript, segmentBoundaries) {
  for (const beat of transcript.beats) {
    const nearestBoundary = findNearestBoundary(beat.timestamp, segmentBoundaries);
    if (Math.abs(beat.timestamp - nearestBoundary) < 0.5) {
      // Too close to boundary - may cause glitch
      beat.timestamp = nearestBoundary + 0.5; // Add buffer
    }
  }
}
```

---

## COMPLETE PROCESS REVIEW

### Long Form (NBA/News/Twitch)

**NBA Long Form Process:**
1. Dashboard: Load yesterday's NBA games (NBA API)
2. User selects games to include
3. `/generate-full-script` → Claude generates script
4. Gate 1: Claude validates script quality (90+ score)
5. Gate 2: Gemini analyzes game footage visuals
6. HeyGen renders Bobby G segments (avatar: 19c1d4adf8904694a3cc331c5a9bee4b)
7. Assembly: Mix Bobby G audio OVER game footage (strip game audio)
8. Burn intro cards, ticker, CWN logo
9. Gate 3: FFmpeg validates assembly
10. `/generate-thumbnail-ffmpeg` → NBA thumbnail (episode #)
11. `/generate-publish-copy` → Metadata (title, description, hashtags)
12. Gate 4: Final QA check
13. `/publish` → Upload-Post to YouTube (2pm daily)

**News Long Form Process:**
1. Dashboard: Load Al Jazeera RSS feed
2. User selects stories (5-8 stories typical)
3. `/generate-full-script` → Claude generates script
4. Gate 1: Claude validates script (90+ score)
5. Gate 2: Gemini analyzes story images/thumbnails
6. HeyGen renders Bobby G segments (landscape avatar)
7. Assembly: Bobby G only (no external clips)
8. Burn intro cards (if stories have associated people), ticker, logo
9. Gate 3: FFmpeg validation
10. `/generate-thumbnail-ffmpeg` → News thumbnail (episode #)
11. Metadata generation
12. Gate 4: Final QA
13. Publish to YouTube (6pm every other day)

**Twitch Long Form Process:**
1. Dashboard: Load Twitch clips (via Twitch GQL)
2. User selects streamers + clips
3. `/generate-full-script` → Claude generates script (Norm MacDonald deadpan)
4. Gate 1: Claude validates
5. Gate 2: Gemini analyzes clip visuals
6. HeyGen renders Bobby G segments
7. Assembly: Intercut Bobby G with clips, burn streamer intro cards
8. Gate 3: FFmpeg validation
9. `/generate-thumbnail-ffmpeg` → Twitch Soup thumbnail (11 streamer circles, episode #)
10. Metadata generation
11. Gate 4: Final QA
12. Publish to YouTube (4pm every other day)

### Short Form (NBA/News/Twitch)

**Process:**
1. Dashboard: Load source (NBA highlights, Al Jazeera story, Twitch clip)
2. User selects ONE item
3. Generate one-line reaction script (Claude)
4. HeyGen renders Bobby G reaction (avatar: ed57439c9c3d4a398f3b247b75714b13)
5. Acquire news source video/image
6. CapCut: Split-screen assembly (source left, Bobby G right)
7. Gemini watches → generates one-line caption
8. CapCut: Create 3 platform variants (YT Shorts, TikTok, IG Reels)
9. Publish to 3 platforms:
   - 12pm: Instagram Reels
   - 4pm: YouTube Shorts
   - 6pm: TikTok

---

## NEXT STEPS (In Order)

### YOU DO:
1. [ ] Review `assets/Screenshot 2026-04-02 at 8.20.02 PM.png` - confirm this is NBA/News thumbnail example
2. [ ] Review `assets/Screenshot 2026-04-05 at 1.23.52 PM.png` - confirm thumbnail example
3. [ ] Clarify: How to get Al Jazeera VIDEO files (not just RSS metadata)?

### I DO:
1. [ ] Implement FFmpeg thumbnail generator (3 variants)
2. [ ] Add episode number auto-increment
3. [ ] Update "THE DAILY UPDATE" → "Twitch Soup"
4. [ ] Implement short form split-screen workflow
5. [ ] Review and fix transcript beat formatting
6. [ ] Add pronunciations support

### WE TEST:
1. [ ] Generate 1 Twitch thumbnail → verify design
2. [ ] Generate 1 NBA thumbnail → verify design
3. [ ] Generate 1 News thumbnail → verify design
4. [ ] Produce 1 short form split-screen video → verify quality
5. [ ] End-to-end test: 1 full long form video with thumbnail

---

## QUESTIONS REMAINING

1. **Al Jazeera Video Acquisition:**
   - RSS gives metadata (title, description, link, thumbnailUrl)
   - How do you get the actual VIDEO file?
   - Options:
     a. Manual download from aljazeera.com?
     b. Scrape video URL from story page?
     c. Use static thumbnail + Ken Burns effect?

2. **Bobby G Long Form Avatar:**
   - Do you want Bobby G in long form thumbnails too?
   - Or only for Twitch (faded center)?
   - For NBA/News: Different design?

3. **Thumbnail Examples:**
   - Are the Screenshots in /assets the NBA/News thumbnail styles you want?
   - Should I base designs on those?

**Answer these 3 questions and I'll start Phase 1 implementation immediately!**
