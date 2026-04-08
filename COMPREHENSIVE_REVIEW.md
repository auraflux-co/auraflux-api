# CWN Production System - Comprehensive Review & Action Plan

**Date:** April 6, 2026
**Scope:** Thumbnails, Transcripts, QA Gates, Short Form Workflow, FFmpeg Quality

---

## EXECUTIVE SUMMARY

**What's Working:**
✅ CapCut API server running (port 9001)
✅ Style guides exist for all content types
✅ Intro card generation (video overlays)
✅ Long form assembly pipeline
✅ QA gates framework (4 gates)

**What Needs Work:**
❌ Thumbnail generation (Canva Enterprise required OR implement FFmpeg)
❌ "THE DAILY UPDATE" → "Twitch Soup" rebrand not applied
❌ Short form split-screen workflow not implemented
❌ Transcript beat formatting needs review
❌ QA gate scoring may need adjustment

---

## 1. THUMBNAILS

### Current State

**Video Intro Cards** (server.js:302) ✅ WORKING
- 720x840px PNG overlays burned onto videos
- Streamer profile in gold-ringed circle
- Name + origin + fact text
- Variants: CWN (transparent) and Twitch (purple bg)

**YouTube Thumbnails** (server.js:5734) ❌ BROKEN
- Uses Canva Autofill API (requires Enterprise, you have Pro)
- Template: DAHGB-hGwds (11 streamer circles)
- Text says "THE DAILY UPDATE" (outdated)
- NBA/News thumbnails: NOT IMPLEMENTED

### Your Requirements

**Twitch "Twitch Soup" Thumbnail:**
- Bobby G avatar (center, faded 70% opacity) ← NEW
- 11 streamer circles (prominent, pop) ← exists in Canva template
- "Twitch Soup" branding (not "The Daily Update") ← NEEDS UPDATE
- Date (e.g., "Friday, April 6, 2026")
- Episode number (auto-increment from #1)
- CWN logo (top right)
- CWN + Twitch brand colors

**NBA & News Thumbnails:**
- You'll provide design examples
- Date, episode number, CWN logo
- Platform-specific brand colors

**Short Form Thumbnails** (All Platforms):
- Split screen: Bobby G reaction + news source video frame
- One-line Gemini caption (after watching video)
- Same across YouTube Shorts, TikTok, Instagram Reels

### Recommendation

**IMPLEMENT FFMPEG THUMBNAIL GENERATOR**

With 60 long form thumbnails/month, FFmpeg automation saves 5 hours/month vs manual Canva.

**Implementation Plan:**
1. Create `/generate-thumbnail-ffmpeg` endpoint
2. Use ImageMagick for composite layers:
   - Background (brand colors)
   - Bobby G avatar (center, 70% opacity)
   - 11 streamer circles (from profile images)
   - Text overlays (title, date, episode #)
   - CWN logo (top right)
3. Support 3 variants: `twitch`, `nba`, `news`
4. Auto-increment episode numbers per content type

**Assets Needed From You:**
- [ ] Bobby G avatar PNG (transparent background)
- [ ] CWN brand colors (hex values)
- [ ] Twitch brand colors (hex: #9146FF purple known)
- [ ] NBA brand colors (hex values)
- [ ] NBA/News thumbnail design examples

---

## 2. STYLE GUIDES & TRANSCRIPTS

### Current Style Guides (cwn_style_guides.json)

**Twitch:**
- Voice: Sarcastic, witty, irreverent
- Tone: Mock everything with playful cynicism
- Structure: Punchy hook → rapid-fire → absurd climax
- Avoid: Over-explaining, genuine meanness

**NBA:**
- Voice: Conversational authenticity
- Tone: Respectful enthusiasm + analytical
- Structure: Context first → progressive building → reflection
- Avoid: Over-dramatic reactions, forced excitement

**News:**
- Voice: Deadpan delivery with absurd observations
- Tone: Skeptical outsider, bewildered at contradictions
- Structure: Serious setup (30-40%) → satirical breakdown (60%)
- Avoid: Pure fabrication, explaining references

### Gemini Learning Process

**Current Implementation:** (server.js:3720)
- Style guides loaded from `cwn_style_guides.json`
- Fed to Gemini in system prompt for Gate 1 QA
- Used during script generation

**Improvements Needed:**
1. **Add style guide examples:** Include 2-3 perfect script samples per content type
2. **Feedback loop:** Save Gate 1 failures with annotations for Gemini to learn from
3. **Beat formatting:** Ensure transcripts prevent "glitching through scenes"

### Transcript Beat Formatting

**Current Format:** (Need to review assembly code)
- Transcripts likely use timestamps or segment markers
- Bobby G may glitch if beats don't align with scene changes

**Action Items:**
- [ ] Review transcript format in assembly pipeline
- [ ] Ensure beats sync with HeyGen segment boundaries
- [ ] Add validation: no beats mid-sentence or mid-word
- [ ] Test with 1 NBA, 1 News, 1 Twitch video

**If you have example transcript files, put them in cwn-production/ and I'll review format**

---

## 3. QA GATES REVIEW

### Current QA Gates (server.js)

**Gate 1: Script Quality** (Claude Sonnet 4)
**Location:** server.js:~3800
**Purpose:** Validate script matches style guide
**Scoring:** 0-100 (threshold: 90 for compilations, 85 for shorts)
**Checks:**
- Tone accuracy (deadpan, warmth, sarcasm)
- Pacing & structure
- Comedy timing
- Style guide adherence

**Gate 2: Clip Visual Quality** (Gemini 2.5 Flash)
**Location:** server.js:~2500
**Purpose:** Analyze clip visuals for quality/relevance
**Scoring:** 0-100 per clip
**Checks:**
- Visual clarity
- Relevance to description
- Action/highlight presence
- Technical quality (resolution, artifacts)

**Gate 3: Assembly Validation** (FFmpeg)
**Location:** Assembly pipeline
**Purpose:** Verify video/audio sync, no corruption
**Checks:**
- Duration matches expected
- No audio/video desync
- No encoding errors
- File size reasonable

**Gate 4: Pre-Publish QA** (Gemini 2.5 Flash)
**Location:** Before /publish
**Purpose:** Final quality check before upload
**Scoring:** Pass/Fail
**Checks:**
- Thumbnail appropriate
- Metadata complete
- Video plays correctly
- Platform requirements met

### Recommended Scoring Adjustments

**Gate 1 (Script Quality):**
- Current threshold: 90 (compilations), 85 (shorts)
- **Recommendation:** Keep as-is, monitor failure rate
- **Add:** Specific rubric breakdown (tone 30%, pacing 25%, comedy 25%, style 20%)

**Gate 2 (Clip Visual):**
- Current: Individual clip scoring
- **Recommendation:** Add aggregate score (avg of all clips >= 75)
- **Add:** Auto-retry failed clips with fallback to thumbnail analysis

**Gate 3 (Assembly):**
- Current: Technical validation only
- **Recommendation:** Add content validation (intro card timing, ticker accuracy)

**Gate 4 (Pre-Publish):**
- Current: Pass/fail
- **Recommendation:** Add checklist scoring:
  - Thumbnail quality: 25pts
  - Metadata complete: 25pts
  - Video technical: 25pts
  - Platform compliance: 25pts
  - Pass threshold: >= 90/100

---

## 4. SHORT FORM WORKFLOW

### Current Status: NOT IMPLEMENTED

**Your Requirements:**
- 3 short forms/day (1 NBA, 1 News, 1 Twitch)
- Split screen: Bobby G reaction + news source video
- News source: Al Jazeera (select 1 story/day)
- Gemini watches → provides one-line caption
- Same video → 3 platform-optimized variants (CapCut)
- Publish to YouTube Shorts, TikTok, Instagram Reels

### Implementation Plan

**Phase 1: News Source Acquisition** ❓
**Question:** How do you get Al Jazeera videos?
- Manual download from https://www.aljazeera.com/videos/ ?
- API integration?
- RSS feed scraping?
- **YOU NEED TO CLARIFY THIS**

**Phase 2: Split Screen Assembly**
1. Extract Bobby G reaction clip (how selected?)
2. Get news source video clip
3. CapCut API creates split screen layout:
   ```
   +-------------------+
   | News Source       |  (Left 50%)
   |                   |
   +-------------------+
   | Bobby G Reaction  |  (Right 50%)
   +-------------------+
   ```
4. Add captions/effects via CapCut

**Phase 3: Gemini Caption Generation**
1. Feed assembled video to Gemini 2.5 Flash
2. Prompt: "Watch this video. Provide a one-line caption that hooks viewers in <150 chars."
3. Store caption for metadata

**Phase 4: Platform Optimization** (CapCut API)
1. Base video → 3 variants:
   - YouTube Shorts: YT-optimized captions, effects
   - TikTok: TT trending effects, fast cuts
   - Instagram Reels: IG aesthetic, subtle effects
2. Each variant uses same caption but styled per platform

**Phase 5: Publishing**
- 12pm: Instagram Reels (3 videos)
- 4pm: YouTube Shorts (3 videos)
- 6pm: TikTok (3 videos)

### Action Items

1. **You clarify:**
   - [ ] How are Al Jazeera videos acquired?
   - [ ] How is Bobby G reaction selected? (AI chooses best moment? Pre-recorded reactions?)
   - [ ] What's the Bobby G short form avatar ID? (Different from long form?)

2. **I implement:**
   - [ ] CapCut split-screen workflow
   - [ ] Gemini video analysis → caption generation
   - [ ] Platform-specific optimization logic
   - [ ] Upload-Post integration for 9 daily posts

---

## 5. FFMPEG QUALITY REVIEW

### Current FFmpeg Usage

**Video Assembly:** (server.js assembly pipeline)
- Normalizes clips to 1920x1080 (long form) or 1080x1920 (short form)
- Burns intro cards (top-right overlay)
- Burns ticker (bottom overlay for long form)
- Concatenates segments
- Adds CWN logo overlay

**Current Quality Settings:**
```bash
# Video encoding
-c:v libx264          # H.264 codec
-preset medium        # Balance speed/quality
-crf 23               # Constant rate factor (lower = higher quality)
-pix_fmt yuv420p      # Color space

# Audio encoding
-c:a aac              # AAC codec
-b:a 192k             # Bitrate
-ar 48000             # Sample rate
```

### Quality Assessment

**Video Quality:** ✅ GOOD
- CRF 23 is industry standard (YouTube recommended: 18-23)
- 1920x1080 matches YouTube requirements
- H.264 widely compatible

**Audio Quality:** ✅ GOOD
- 192k AAC is high quality
- 48kHz sample rate is professional standard

**Potential Improvements:**
1. **Use `-crf 20` for higher visual quality** (slightly larger files)
2. **Add `-movflags +faststart`** for faster web streaming
3. **Use `-preset slow`** for better compression (slower encoding)

### Recommended FFmpeg Command Updates

```bash
# Current
ffmpeg -i input.mp4 -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k output.mp4

# Recommended (Higher Quality)
ffmpeg -i input.mp4 -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -ar 48000 output.mp4
```

**Trade-offs:**
- `crf 20`: +15% file size, noticeably better quality
- `preset slow`: 2-3x slower encoding, 5-10% smaller files at same quality
- `+faststart`: Enables progressive download/streaming

---

## BRAND IDENTITY UPDATE: "Twitch Soup"

### Files Needing Updates

**1. server.js**
- Line 5731: `branding: 'PBs5L1XPdkxX4FNn-LBbqf1yz2f6pgXcB', // "CLIPZWORLD NEWS • THE DAILY UPDATE"`
  - Update to: `"CLIPZWORLD NEWS • TWITCH SOUP"`

**2. Script Generation Prompts**
- Search for "The Daily Update" or "Daily Update" in all prompts
- Replace with "Twitch Soup"

**3. Canva Templates**
- Template DAHGB-hGwds: Manually update text in Canva
- Or implement FFmpeg thumbnail with correct branding

**4. Documentation**
- README.md, CLAUDE.md, etc.

**Find & Replace Command:**
```bash
grep -r "Daily Update\|THE DAILY UPDATE" --include="*.js" --include="*.md" .
```

---

## PRIORITY ACTION ITEMS

### IMMEDIATE (This Week)

1. **You provide design assets:**
   - [ ] Bobby G avatar PNG (long form + short form if different)
   - [ ] Brand color hex values (CWN, Twitch, NBA)
   - [ ] NBA/News thumbnail design examples
   - [ ] Clarify Al Jazeera video acquisition method

2. **I implement FFmpeg thumbnail generator:**
   - [ ] Twitch variant with Bobby G center, streamer circles
   - [ ] Update "THE DAILY UPDATE" → "Twitch Soup" everywhere
   - [ ] Add episode number auto-increment
   - [ ] Add date formatting

3. **Test thumbnail generation:**
   - [ ] Generate 1 Twitch thumbnail
   - [ ] Verify design matches requirements
   - [ ] Adjust colors/layout as needed

### SHORT TERM (Next 2 Weeks)

4. **Implement short form workflow:**
   - [ ] CapCut split-screen API integration
   - [ ] Gemini caption generation
   - [ ] Platform-specific optimization
   - [ ] Upload-Post 9 daily posts

5. **Review & improve QA gates:**
   - [ ] Add rubric breakdown to Gate 1
   - [ ] Implement aggregate scoring for Gate 2
   - [ ] Enhanced Gate 4 checklist
   - [ ] Monitor failure rates

6. **Transcript formatting review:**
   - [ ] Analyze beat alignment with HeyGen segments
   - [ ] Test with sample videos
   - [ ] Fix glitching issues if present

### MEDIUM TERM (Next Month)

7. **Gemini learning improvements:**
   - [ ] Add style guide examples to cwn_style_guides.json
   - [ ] Implement feedback loop (save failures)
   - [ ] Provide additional news/NBA reference links if needed

8. **NBA & News thumbnails:**
   - [ ] Design based on your examples
   - [ ] Implement FFmpeg variants
   - [ ] Test and refine

9. **FFmpeg quality enhancements:**
   - [ ] Update to CRF 20, preset slow, +faststart
   - [ ] A/B test quality vs file size
   - [ ] Apply to all content types

---

## FILES REFERENCE

**Thumbnails:**
- server.js:302 - `generateIntroCardPNG()` (video overlays)
- server.js:5734 - `/generate-thumbnail` (YouTube thumbnails)

**Style Guides:**
- `cwn_style_guides.json` - Comprehensive guides for Twitch, NBA, News

**Assembly:**
- server.js:~1400 - `/assembly` endpoint
- server.js:~1600 - FFmpeg video assembly

**QA Gates:**
- server.js:~3800 - Gate 1 (script quality)
- server.js:~2500 - Gate 2 (clip visuals)

**CapCut API:**
- VectCutAPI/capcut_server.py - Running on port 9001
- VectCutAPI/README.md - Full API documentation

**Brand Assets:**
- assets/cwn_logo.png - CWN logo (49KB)
- assets/cwn_banner.png - CWN banner (86KB)

---

## QUESTIONS FOR YOU

1. **Al Jazeera videos:** How do you acquire them? Manual download, API, RSS?
2. **Bobby G reactions:** Pre-recorded library? AI selects best moment?
3. **Short form avatar:** Different from long form avatar?
4. **Brand colors:** Exact hex values for CWN, NBA?
5. **Thumbnail examples:** Can you put NBA/News examples in cwn-production/?

---

**Next Step:** Answer the 5 questions above, provide the design assets listed in IMMEDIATE actions, then I'll implement FFmpeg thumbnail automation and short form workflow.
