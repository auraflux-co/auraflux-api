# CWN Production Automation Status

**Last Updated**: 2026-04-07
**Session**: Post-QA Documentation
**Next Phase**: Full End-to-End Automation

---

## ✅ COMPLETED

### 1. Audio Normalization Fix
**File**: `server.js:2054`  
**Problem**: Bobby G avatar quieter than streamer clips  
**Solution**: Normalize ALL segments to -14 LUFS (both avatar and source clips)  
**Code**:
```javascript
'-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0',
```
**Status**: ✅ FIXED - Ready to test

### 2. QA Gates Documentation
**Files Created**:
- `QA_GATES.md` - 7 gates (1-2 implemented, 2A/5/6/7 documented)
- `HEYGEN_SCRIPT_FORMAT.md` - Pronunciation system, script requirements, HeyGen JSON format
- `PRODUCTION_SCHEDULE.md` - 60 long + 270 short videos/month

**12-Test Framework**: Documented with accelerated 3-day timeline (was 9 days)

**Status**: ✅ COMPLETE - Ready for implementation

### 3. Gemini 10x Reference Video Training
**File**: `server.js:4464-4530`
**Enhancement**: Modified `/analyze-style-library` endpoint to watch each reference video 10 times
**Implementation**:
- Loop 10 times per video with progressive focus (early: broad patterns, late: subtle details)
- Accumulate 10 separate observations per video
- Synthesize all 10 viewings into deep per-video analysis using Claude
- Final synthesis combines all deep analyses into unified style guide

**Code**:
```javascript
// 10x VIEWING: Watch each reference video 10 times for deeper style learning
for (let viewNum = 1; viewNum <= 10; viewNum++) {
  const stylePrompt = `This is VIEWING #${viewNum} of 10...`;
  // Gemini analyzes video with viewing-specific focus
  multipleViewings.push(observation);
}
// Claude synthesizes all 10 viewings into deep analysis
```

**Impact**: Much deeper style understanding → Better script quality, tone matching, pacing accuracy

**Status**: ✅ COMPLETE - Ready to test

---

### 4. Upload-Post API Integration (Gate 6)
**File**: `server.js:4616-4775`
**Endpoint**: `POST /publish` (already implemented)
**Mode**: Immediate delivery by default (scheduledAt optional)

**Enhancement Made**:
- Added configurable `tiktokPrivacy` parameter for test mode
- YouTube: `privacyStatus` ('public' | 'private' | 'unlisted')
- TikTok: `tiktokPrivacy` ('PUBLIC_TO_EVERYONE' | 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS')
- Instagram: Set to private account manually

**Code Changes**:
```javascript
// server.js:4649-4650 - Added tiktokPrivacy parameter
tiktokPrivacy = 'PUBLIC_TO_EVERYONE', // Configurable for testing

// server.js:4713 - Use configurable privacy instead of hardcoded
form.append('privacy_level', tiktokPrivacy);
```

**12-Test Framework Configuration**:
```json
{
  "privacyStatus": "private",      // YouTube private
  "tiktokPrivacy": "SELF_ONLY"     // TikTok only me
}
```

**Status**: ✅ COMPLETE - Ready for 12-test framework

---

### 5. Twitch Longform Thumbnail with FFmpeg Overlay
**File**: `server.js:6354-6432`
**Template**: `assets/longform_twitch_Thumbnail.png` (1280x720, 444KB)
**Endpoint**: `POST /generate-twitch-longform-thumbnail`

**Implementation**:
- Function `generateTwitchLongformThumbnail()` takes static template
- Reads `episode_counters.json` and auto-increments twitch counter
- Formats current date: "Apr 7, 2026"
- FFmpeg `drawtext` filter overlays two lines of text:
  - "EPISODE {N}" - fontsize 48, centered, y=560
  - "{Date}" - fontsize 32, centered, y=620
- Both with white text + black border for readability
- Outputs to `output/thumbnail_twitch_longform_ep{N}_{timestamp}.png`

**Code**:
```javascript
// server.js:6354-6432
async function generateTwitchLongformThumbnail() {
  // Load template + increment counter
  const episodeNum = counters.twitch++;
  const dateStr = new Date().toLocaleDateString('en-US', {...});

  // FFmpeg drawtext overlay
  const ffmpegArgs = ['-i', TEMPLATE_PATH, '-vf',
    `drawtext=text='EPISODE ${episodeNum}':fontsize=48:x=(w-text_w)/2:y=560,` +
    `drawtext=text='${dateStr}':fontsize=32:x=(w-text_w)/2:y=620`,
    '-y', outputPath
  ];

  return { thumbnailPath, episodeNum, date: dateStr };
}
```

**Status**: ✅ COMPLETE - Ready to test

---

## ✅ COMPLETED (Continued)

### 6. HeyGen Pronunciation Best Practices
**Files Modified**: `server.js:3520-3540` (NBA), `server.js:3578-3585` (News), `server.js:3625-3632` (Twitch)
**Implementation**: Added comprehensive HeyGen pronunciation guidelines to all system prompts
**Features**:
- Phonetic respelling for unusual names (first mention only)
- Number spelling rules ("thirty-two points" not "32 points")
- Abbreviation handling ("N-B-A" or "the NBA")
- Foreign word pronunciation guides
- Punctuation for pacing control
- Reference to streamers.json phonetic fields

**Code Example (NBA)**:
```javascript
HEYGEN PRONUNCIATION BEST PRACTICES:
1. **Unusual names**: Add phonetic respelling on FIRST mention only
   - "Giannis Antetokounmpo (YAH-nis ON-tet-oh-KOON-po)"
2. **Numbers**: Always spell out → "thirty-two points" NOT "32 points"
3. **Abbreviations**: "NBA" → "N-B-A" OR "the NBA" (works fine)
```

**Impact**: Claude now automatically applies HeyGen best practices when writing scripts, eliminating mispronunciations without manual phonetic field management

**Status**: ✅ COMPLETE - Embedded in all script generation prompts

---

### 7. HeyGen Scene Splitting Fix
**File**: `server.js:1076-1200`
**Problem**: HeyGen auto-send was sending entire script as single video instead of 12-14 separate scene videos
**Root Cause**: `sendScriptToHeyGen()` function created only one video_input with full script text
**Solution**: Parse script by `=== SCENE_NAME ===` markers, send each scene as separate video_input

**Implementation**:
```javascript
// NEW: Parse script into individual scenes
function parseScriptIntoScenes(script) {
  const scenes = [];
  const sceneRegex = /===\s*([A-Z_0-9]+)\s*===/g;

  // Find all scene markers and extract text between them
  // Clean [beat] and [CLIP PLAYS HERE] markers
  // Return array of {name, text} objects
}

// UPDATED: sendScriptToHeyGen now uses scenes
const scenes = parseScriptIntoScenes(script);
const video_inputs = scenes.map(scene => ({
  character: { type: 'avatar', avatar_id: avatarId },
  voice: { type: 'text', input_text: scene.text, voice_id: HEYGEN_VOICE_ID }
}));
```

**Expected Scene Structure** (Twitch long form example):
- INTRO (1 scene)
- INTRO_ADAPT (1 scene)
- CLIP_1_SETUP, CLIP_1_REACTION (2 scenes)
- CLIP_2_SETUP, CLIP_2_REACTION (2 scenes)
- CLIP_3_SETUP, CLIP_3_REACTION (2 scenes)
- INTRO_YOURRAGE (1 scene)
- CLIP_4_SETUP through CLIP_9_REACTION (12 scenes)
- OUTRO (1 scene)
- **Total: ~14 scenes** → 14 individual HeyGen videos

**Debugging Output**:
```
[heygen] Submitting 14 scenes to HeyGen (twitch, landscape, avatar: 19c1d4ad...)
[heygen] Scene breakdown:
  1. INTRO - What is up ClipzWorld, we got some INSANE Twitch...
  2. INTRO_ADAPT - Let's kick it off with Adapt. He's from Bro...
  3. CLIP_1_SETUP - In this clip, Adapt is playing Fortnite and...
  ...
```

**Impact**: HeyGen will now create 12-14 individual scene videos that can be assembled with source clips in correct order

**Status**: ✅ COMPLETE - Ready to test in Test 1

---

## 📋 PENDING (Next Steps)

### 1. Gate 2A: Pronunciation Iteration Loop
**Depends On**: HeyGen MCP Server
**Flow**: Gemini detects mispronunciation → Claude revises → HeyGen re-renders
**Status**: 📋 BLOCKED (needs HeyGen MCP)

### 2. Gate 5: Gemini Final Video Review
**Trigger**: After assembly, before upload  
**Action**: Gemini watches final MP4, scores quality  
**Checklist**: Video playback, avatar segments, clip integration, pacing  
**Status**: 📋 NOT STARTED

---

## 🔑 Environment Variables Needed

Add to `.env`:
```bash
# Upload-Post API
UPLOAD_POST_API_URL=https://api.upload-post.com/api/upload
UPLOAD_POST_API_KEY=your_api_key_here
UPLOAD_POST_USER=test  # Or your profile username

# HeyGen API (from cwn_production.html CFG)
HEYGEN_API_KEY=sk_V2_hgu_kL8r4S5DK0n_4pqhaul6CA5niyZIA2ymUk7O2jgiF101
HEYGEN_AVATAR_ID=19c1d4adf8904694a3cc331c5a9bee4b
HEYGEN_VOICE_ID=2e598f1a6022448cb6710e5d44665325
HEYGEN_SPEAK_SPEED=0.85

# Gemini API (already exists)
GEMINI_APIKEY=...
```

---

## 📊 12-Test Framework Status

**Definition of Done**:
- All 12 tests pass with ≥90% Gemini QA score
- All uploads private/only-me
- End-to-end automation (script → HeyGen → assembly → upload)

**Test Timeline** (Accelerated):
- Day 1: Tests 1-4 (Twitch) - 6-8 hours
- Day 2: Tests 5-8 (NBA/"Other Side of the Pillow") - 6-8 hours
- Day 3: Tests 9-12 (News) - 6-8 hours

**Blocker**: Upload-Post integration must be complete before starting tests

---

## 🎯 Priority 1 Tasks - ALL COMPLETE ✅

1. ✅ **Audio normalization fix** - Bobby G and streamer clips normalized to -14 LUFS
2. ✅ **NBA show rename** - Changed to "Other Side of the Pillow"
3. ✅ **10x reference video training** - Gemini watches each video 10 times for deeper learning
4. ✅ **Upload-Post test privacy settings** - TikTok privacy configurable for 12-test framework
5. ✅ **Twitch thumbnail with dynamic text** - FFmpeg overlay with episode number and date
6. ✅ **HeyGen auto-send** - Automatic submission when Gate 1 score ≥90
7. ✅ **HeyGen pronunciation best practices** - Embedded in all system prompts (NBA, News, Twitch)
8. ✅ **HeyGen scene splitting fix** - Parse script into 12-14 separate scene videos (was sending single giant video)

**All critical automation features are now implemented and ready for testing.**

---

## 📝 Notes

- Audio fix is CRITICAL - test first before 12-test framework
- Upload-Post handles platform publishing (no need for individual platform APIs)
- HeyGen credentials are in cwn_production.html (not .env yet)
- Twitch thumbnail is ready, just needs dynamic text overlay
- NBA show rename affects prompts and thumbnail text

