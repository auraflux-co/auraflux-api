# CWN Production - Missing Features Implementation Spec

**Date**: 2026-04-08
**Status**: Ready for Implementation
**Priority**: P0 - Production Blockers

---

## 1. VectCut API Integration

### Overview
VectCut is a cloud-based video editing API with AI capabilities. Already installed as Claude Code skill.

### Configuration
- **Server Location**: `/Users/robertgregory/cwn-production/VectCutAPI/`
- **Skill Location**: `/Users/robertgregory/.claude/skills/vectcut-skill/`
- **Port**: 9001 (configured in config.json)
- **Server Command**: `python3 capcut_server.py`

### Capabilities Used
- Picture-in-picture (PiP) for short-form split-screen
- Video overlay positioning
- Multi-track editing

### Implementation Tasks
- [ ] Start VectCut server on port 9001
- [ ] Add VECTCUT_API_URL to .env (http://localhost:9001)
- [ ] Create Node.js wrapper functions in server.js
- [ ] Test connection with health check endpoint

---

## 2. NBA Long-Form Cards (INTRO Overlays)

### Current State
- `nba_thumbnail_generator.html` exists - generates 1280×720 thumbnails
- Generates VS matchup cards with team logos, records, scores
- Uses ESPN API for game data

### Required Changes

#### 2.1 Card Generation Endpoint
**New Endpoint**: `POST /nba/generate-intro-card`

**Request**:
```json
{
  "gameId": "401810957",
  "width": 640,
  "height": 360
}
```

**Response**:
```json
{
  "cardPath": "/tmp/nba_card_401810957.png",
  "gameId": "401810957",
  "teams": { "away": "BOS", "home": "LAL" }
}
```

#### 2.2 Integration into Assembly
**Location**: server.js `/assemble` endpoint, NBA long-form section

**Timing**: Generate card at each `GAME#_[TEAMS]_INTRO` scene

**Overlay Position**:
- **Shape**: TV-shaped (16:9 landscape) - 640×360px
- **Position**: Right of Bobby G avatar
- **Placement**: `overlay=W-640-40:H/2-180` (40px from right edge, vertically centered)
- **Duration**: Show during entire INTRO scene (before clip plays)

**FFmpeg Command**:
```bash
ffmpeg -i intro_segment.mp4 -i nba_card.png \
  -filter_complex "[1:v]scale=640:360[card];[0:v][card]overlay=W-640-40:H/2-180[vout]" \
  -map "[vout]" -map 0:a intro_with_card.mp4
```

---

## 3. News Long-Form Cards (INTRO Overlays)

### Overview
Scrape header image from each news article URL, resize for video overlay.

### Implementation

#### 3.1 Article Image Scraper
**New Function**: `scrapeNewsHeaderImage(articleUrl)`

**Logic**:
1. Fetch article HTML
2. Extract image from:
   - Open Graph: `<meta property="og:image">`
   - Twitter Card: `<meta name="twitter:image">`
   - First `<img>` tag in article body
3. Download image to `/tmp/news_img_[hash].jpg`
4. Resize to 640×360 (TV shape, same as NBA)

**Dependencies**: `axios`, `cheerio` (already in package.json)

#### 3.2 Card Generation Endpoint
**New Endpoint**: `POST /news/generate-intro-card`

**Request**:
```json
{
  "articleUrl": "https://reuters.com/article/...",
  "storyIndex": 0,
  "width": 640,
  "height": 360
}
```

**Response**:
```json
{
  "cardPath": "/tmp/news_card_story0.jpg",
  "sourceUrl": "https://...",
  "imageUrl": "https://cdn.reuters.com/image.jpg"
}
```

#### 3.3 Integration into Assembly
**Location**: server.js `/assemble` endpoint, News long-form section

**Timing**: Generate card at each `STORY#_INTRO` scene

**Overlay Position**: Same as NBA (640×360, right of Bobby G)

---

## 4. Short-Form Split-Screen Layout

### Design Spec

#### Layout Structure
```
┌─────────────────────────┐
│                         │
│    SOURCE CLIP (TOP)    │ 50% height
│    Random selection     │
│                         │
├─────────────────────────┤
│                         │
│   BOBBY G AVATAR (BOT)  │ 50% height
│   HeyGen segment        │
│                         │
└─────────────────────────┘
```

**Video Dimensions**: 1080×1920 (9:16 portrait)
- Top half: 1080×960 (source clip, cropped/scaled)
- Bottom half: 1080×960 (Bobby G avatar)

#### Content Flow
1. **Intro Scene**: Bobby G introduces topic (bottom half)
2. **Clip Scene**: Source clip plays (top half), Bobby G visible but silent OR continues talking (PiP style)
3. **Reaction Scene**: Bobby G reacts (bottom half)

### Implementation

#### 4.1 Clip Selection Logic
**For each short-form video**:
- Twitch-short: Random clip from streamer's 3 clips
- NBA-short: Single game highlight clip
- News-short: Article video OR static image from scraped header

#### 4.2 Assembly FFmpeg Command
**Two-stage process**:

**Stage 1**: Prepare source clip (crop to 1080×960, top half)
```bash
ffmpeg -i source_clip.mp4 \
  -vf "scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960" \
  -c:v libx264 -preset fast top_half.mp4
```

**Stage 2**: Stack with Bobby G avatar (bottom 1080×960)
```bash
ffmpeg -i top_half.mp4 -i bobby_segment.mp4 \
  -filter_complex "[0:v][1:v]vstack=inputs=2[vout]" \
  -map "[vout]" -map 0:a -map 1:a \
  -c:v libx264 -c:a aac short_form_final.mp4
```

**Audio Mixing**:
- Option A: Mix both audio tracks (source + Bobby G)
- Option B: Use only source clip audio, Bobby G silent during clip
- **Decision needed from Rob**: Which audio approach?

#### 4.3 New Assembly Section
**Location**: server.js `/assemble` endpoint

**Add short-form handler**:
```javascript
if (format === 'portrait' && (contentType.includes('-short'))) {
  // Short-form split-screen assembly
  // 1. Select random clip from orderedClipUrls
  // 2. Crop/scale to 1080×960
  // 3. Stack with HeyGen segments
  // 4. Apply logo overlay (top-right, smaller for 9:16)
}
```

---

## 5. Logo Overlay Updates

### Current State
- **Long-form**: 120px logo, top-right `W-w-20:20`, 85% opacity ✅
- **Short-form**: NOT YET IMPLEMENTED ❌

### Short-Form Logo Spec
- **Size**: 80px (smaller for 9:16 format)
- **Position**: Top-right, `W-w-15:15`
- **Opacity**: 85%
- **Applied to**: ALL short-form videos (Twitch-short, NBA-short, News-short)

---

## 6. Audio Handling Verification

### Confirmed Rules
1. **NBA Long-Form**: Strip highlight audio, Bobby G voiceover only ✅
2. **Twitch Long-Form**: Preserve clip audio ✅
3. **News Long-Form**: Preserve article video audio (if exists) ✅
4. **All Short-Form**: TBD - need decision on audio mixing approach

### Current Implementation Check
**Location**: server.js:3357-3500 (assembly section)

**Verification needed**:
- [ ] NBA: Confirm `-map 0:a?` strips clip audio correctly
- [ ] Twitch: Confirm clip audio preserved
- [ ] News: Confirm article video audio preserved

---

## 7. Implementation Order

### Phase 1: Setup & Testing
1. ✅ Install VectCut skill to Claude Code
2. Start VectCut API server (port 9001)
3. Test VectCut connection from Node.js
4. Add VECTCUT_API_URL to .env

### Phase 2: Card Generation (Long-Form)
5. Create NBA card endpoint (`/nba/generate-intro-card`)
6. Create News scraper + card endpoint (`/news/generate-intro-card`)
7. Test both endpoints standalone

### Phase 3: Assembly Integration (Long-Form)
8. Integrate NBA cards into assembly at GAME_INTRO scenes
9. Integrate News cards into assembly at STORY_INTRO scenes
10. Verify logo overlay on all long-form outputs

### Phase 4: Short-Form Implementation
11. Implement clip selection logic for short-form
12. Create split-screen assembly logic
13. Add short-form logo overlay (80px)
14. Test all 3 short-form types (Twitch, NBA, News)

### Phase 5: Testing & Validation
15. Run test suite for long-form with cards
16. Run test suite for short-form split-screen
17. Verify audio handling across all formats
18. Final production test (3 long-form videos)

### Phase 6: AI-Generated Burn-In Images (Future Enhancement)
19. Add `design_brief` field to Gemini script output
20. Implement burn-in image generation API integration (Midjourney/Nano Banana Pro)
21. Create image overlay pipeline using VectCut at OVERLAY_ZONE
22. Add image caching system to avoid regenerating existing assets

---

## 8. AI-Generated Burn-In Images (Phase 6 Concept)

### Overview
Automated visual content generation where Gemini suggests contextual images for each scene, and Claude orchestrates their generation and placement.

### Workflow
1. **Gemini's Task**: In script JSON output, add `design_brief` for each scene requiring visual content
   ```javascript
   {
     "sceneType": "GAME1_INTRO",
     "dialogue": "Tonight's matchup: Celtics versus Lakers...",
     "design_brief": "A cinematic, high-detail 3D render of a gold trophy on a dark slate background, dramatic lighting, 4K quality"
   }
   ```

2. **Claude's Task**: During assembly, process `design_brief` fields:
   - Check if image already exists in cache (`/tmp/burn_in_images/[hash].png`)
   - If not, trigger image generation API (Midjourney/Nano Banana Pro)
   - Use VectCut to overlay at `CONFIG.VISUAL_LAYOUTS.OVERLAY_ZONE`

3. **Image Generation APIs** (options):
   - Midjourney API (high quality, slower)
   - Nano Banana Pro (faster, good quality)
   - DALL-E 3 (reliable, moderate speed)

4. **Caching Strategy**:
   - Hash the `design_brief` text
   - Store generated images in `/tmp/burn_in_images/[hash].png`
   - Reuse images across episodes if brief matches

### Implementation Requirements
- Add `BURN_IN_IMAGE_API_KEY` to .env
- Add `BURN_IN_IMAGE_PROVIDER` to .env (midjourney|nanobananapro|dalle3)
- Create `/generate-burn-in-image` endpoint
- Enhance `geminiScriptGeneration()` to include design_brief instructions
- Update Claude QA to validate design_brief presence for relevant scenes

---

## 9. Environment Variables to Add

```bash
# VectCut API
VECTCUT_API_URL=http://localhost:9001

# Short-form logo size
SHORT_FORM_LOGO_SIZE=80

# Audio mixing (for short-form clips)
SHORT_FORM_AUDIO_MIX=both  # Options: both, source_only, avatar_only
```

---

## 9. File Locations

### New Files to Create
- `/nba/generate-intro-card` endpoint in server.js
- `/news/generate-intro-card` endpoint in server.js
- `scrapeNewsHeaderImage()` function in server.js
- Short-form assembly section in `/assemble` endpoint

### Modified Files
- `server.js` - All new endpoints and logic
- `.env` - New environment variables
- `IMPLEMENTATION_SPEC.md` - This document

### Temporary Files
- `/tmp/nba_card_[gameId].png` - NBA intro cards
- `/tmp/news_card_story[N].jpg` - News intro cards
- `/tmp/news_img_[hash].jpg` - Scraped news images
- `/tmp/short_top_[hash].mp4` - Short-form top half clips
- `/tmp/short_stacked_[hash].mp4` - Final stacked short-form

---

## 10. Testing Checklist

### Long-Form Testing
- [ ] NBA card appears at each GAME_INTRO (correct game data)
- [ ] News card appears at each STORY_INTRO (correct article image)
- [ ] Cards positioned correctly (640×360, right of Bobby G)
- [ ] Logo overlay present (120px, top-right)
- [ ] NBA audio stripped (voiceover only)
- [ ] Twitch/News audio preserved

### Short-Form Testing
- [ ] Split-screen layout correct (1080×1920, 50/50)
- [ ] Random clip selected and cropped properly
- [ ] Bobby G avatar in bottom half
- [ ] Audio mixing works as expected
- [ ] Logo overlay present (80px, top-right)
- [ ] All 3 content types work (Twitch, NBA, News)

---

## Status: READY FOR IMPLEMENTATION
**Awaiting**: Green light to proceed with all phases
