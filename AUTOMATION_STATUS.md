# CWN Production Automation Status

**Last Updated**: 2026-04-08
**Session**: Multi-Agent Parallel Track (Cline + Aider + Claude Code)
**Next Phase**: 12-Test Framework Execution

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
**Status**: ✅ FIXED

---

### 2. QA Gates Documentation
**Files Created**:
- `QA_GATES.md` - 7 gates (1-2 implemented, 2A/5/6/7 documented)
- `HEYGEN_SCRIPT_FORMAT.md` - Pronunciation system, script requirements, HeyGen JSON format
- `PRODUCTION_SCHEDULE.md` - 60 long + 270 short videos/month

**12-Test Framework**: Documented with accelerated 3-day timeline (was 9 days)

**Status**: ✅ COMPLETE

---

### 3. Gemini 10x Reference Video Training
**File**: `server.js:4464-4530`
**Enhancement**: Modified `/analyze-style-library` endpoint to watch each reference video 10 times
**Implementation**:
- Loop 10 times per video with progressive focus (early: broad patterns, late: subtle details)
- Accumulate 10 separate observations per video
- Synthesize all 10 viewings into deep per-video analysis using Claude
- Final synthesis combines all deep analyses into unified style guide

**Status**: ✅ COMPLETE

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

**Status**: ✅ COMPLETE

---

### 5. Twitch Longform Thumbnail with FFmpeg Overlay
**File**: `server.js:6354-6432`
**Template**: `assets/twitchsoup_thumbnail.jpeg` (1280x720)
**Endpoint**: `POST /generate-twitch-longform-thumbnail`

**Implementation**:
- Canvas-based rendering with streamer profile circles in a ring
- Auto-increments twitch episode counter from `episode_counters.json`
- Formats current date: "Apr 7, 2026"
- Overlays episode number (top-right) and date (top-left)
- Outputs to `output/thumbnail_twitch_longform_ep{N}_{timestamp}.png`

**Status**: ✅ COMPLETE

---

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

**Status**: ✅ COMPLETE

---

### 7. HeyGen Scene Splitting Fix
**File**: `server.js:1076-1200`
**Problem**: HeyGen auto-send was sending entire script as single video instead of 12-14 separate scene videos
**Solution**: Parse script by `=== SCENE_NAME ===` markers, send each scene as separate video_input

**Status**: ✅ COMPLETE

---

### 8. Wire Publish Button in Dashboard
**File**: `cwn_production.html` — `pubGenerateSocialCopy()` function
**Problem**: Was calling `api.anthropic.com` directly from browser (insecure, exposed API key)
**Solution**: Now calls `CFG.ffmpegUrl + '/generate-publish-copy'` (server-side, secure)

**New behavior**:
- Sends: `{ contentType, formType, script, date, streamers, platforms: ['youtube', 'tiktok', 'instagram'] }`
- Maps response: `resp.platforms.youtube` → ytTitle/ytDesc/ytComment, `resp.platforms.tiktok.caption` → tiktokCaption, `resp.platforms.instagram.caption/altText` → igCaption/igAlt
- Falls back to flat response format for backward compat

**Status**: ✅ COMPLETE

---

### 9. Gate 5: Gemini Final Video Review
**File**: `server.js` — added before `/errors` endpoint
**Endpoint**: `POST /gate5-review`
**Trigger**: After assembly, before upload

**Implementation**:
- `runGate5Review()` function uploads assembled MP4 to Gemini Files API
- Waits for Gemini to process the video
- Scores on 4 dimensions (100 pts total):
  - Visual Quality: 30 pts (no black screens, artifacts, avatar correct)
  - Audio Quality: 30 pts (clear, balanced, no dropouts)
  - Clip Integration: 30 pts (clips at correct timestamps, smooth transitions)
  - Pacing: 10 pts (natural flow)
- Pass threshold: ≥85 pts
- Returns structured JSON with breakdown, deductions, and summary
- Cleans up Gemini file after review
- Gracefully skips if no `GEMINI_API_KEY`

**Body**: `{ videoPath, expectedDuration, contentType, formType, jobId }`
**Returns**: `{ ok, score, passed, outcome, outcomeLabel, breakdown, deductions, report, jobId }`

**Status**: ✅ COMPLETE

---

### 10. Requesty API Configuration (Aider)
**File**: `.aider.conf.yml`
**Configuration**:
```yaml
openai-api-base: https://router.requesty.ai/v1
openai-api-key: rqsty-sk-...
model: openai/coding/gemini-2.5-pro
show-model-warnings: false
```
**Status**: ✅ COMPLETE

---

### 11. claude.json Performance Fix
**File**: `~/.claude.json`
**Problem**: 229KB file causing CLI freezes (201KB `cachedChangelog` blob)
**Solution**: Cleared `cachedChangelog`, `cachedGrowthBookFeatures`, `cachedStatsigGates`, `cachedDynamicConfigs`
**Result**: 229KB → 5.7KB (97% reduction)

**Status**: ✅ COMPLETE

---

### 12. settings.local.json Cleanup
**File**: `.claude/settings.local.json`
**Problem**: 4 stale permission entries (duplicate node, stale npx/echo/aider commands)
**Solution**: Removed stale entries, 35 → 31 clean permissions

**Status**: ✅ COMPLETE

---

## 📋 PENDING (Next Steps)

### 1. Gate 2A: Pronunciation Iteration Loop
**Owner**: Aider
**Depends On**: HeyGen MCP Server
**Flow**: Gemini detects mispronunciation → Claude revises → HeyGen re-renders
**Status**: 📋 BLOCKED (needs HeyGen MCP)

### 2. Phonetic Auto-Injection
**Owner**: Aider
**Task**: Read `streamers.json` phonetic entries, auto-inject into HeyGen `input_text` on first mention
**Status**: 📋 NOT STARTED

### 3. Gate 6 Automation
**Owner**: Claude Code
**Task**: Auto-trigger publish after Gate 3 passes (currently manual)
**Status**: 📋 NOT STARTED

### 4. Split-Job + FFmpeg Stitch
**Owner**: Aider
**Task**: For production loads >5 items, split into parallel jobs and stitch
**Status**: 📋 NOT STARTED

### 5. End-to-End 12-Test Suite Validation
**Owner**: Claude Code
**Task**: Run all 12 test cases, validate QA gates, confirm private uploads
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
GEMINI_API_KEY=...
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

## 🎯 QA Gate Implementation Status

| Gate | Name | Status | Notes |
|------|------|--------|-------|
| Gate 1 | Script QA (Claude reviews Gemini's script) | ✅ Implemented | `claudeScriptQA()` in server.js |
| Gate 2 | HeyGen Segment QA (Gemini samples 3 segments) | ✅ Implemented | `geminiSegmentQA()` in server.js |
| Gate 2A | Pronunciation Iteration Loop | ❌ Not Implemented | Needs HeyGen MCP |
| Gate 3 | Assembly QA (Gemini reviews assembled video) | ✅ Implemented | `geminiQACheck()` in server.js |
| Gate 4 | Gemini Visual Audit (manual) | 🟡 Manual | Dashboard review |
| Gate 5 | Gemini Final Video Review | ✅ Implemented | `POST /gate5-review` — `runGate5Review()` |
| Gate 6 | Final MP4 Delivery + Upload Prep | 🟡 Partial | MP4 saved, metadata manual |
| Gate 7 | Logic Audit (automated checks) | 🟡 Partial | Some checks in assembly flow |

---

## 📝 Notes

- Audio fix is CRITICAL - test first before 12-test framework
- Upload-Post handles platform publishing (no need for individual platform APIs)
- HeyGen credentials are in cwn_production.html (not .env yet)
- Gate 5 (`/gate5-review`) accepts `videoPath` (local path to assembled MP4)
- Gate 5 uploads full video to Gemini Files API — large files (>100MB) may take 30-60s to upload
- Gate 5 auto-cleans Gemini file after review to avoid storage costs
