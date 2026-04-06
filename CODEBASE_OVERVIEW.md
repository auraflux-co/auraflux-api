# CWN Production — Complete Codebase Overview

**Last Updated:** April 6, 2026
**Dashboard:** http://localhost:8765/cwn_production.html
**API Server:** http://localhost:3000
**Repository:** https://github.com/clipzworldnews/cwn-production

---

## **CONTENT PIPELINE — 3 Types, 2 Formats, 4 Platforms**

### **Content Types**
1. **Twitch** — 10 streamers × 3 clips each (~20min compilations)
2. **NBA** — Yesterday's games with highlights
3. **News** — Daily news stories with Bobby G commentary

### **Video Formats**
1. **Compilations** (Long-form) — 16:9, YouTube
2. **Shorts/Reels** — 9:16, TikTok/Instagram/YouTube Shorts

### **Distribution Platforms**
1. YouTube (long-form)
2. YouTube Shorts
3. TikTok
4. Instagram Reels

---

## **COMPLETE WORKFLOW — Dashboard → Published**

```
┌─────────────────────────────────────────────────────────────────┐
│ DASHBOARD TASK CREATION                                          │
│ http://localhost:8765/cwn_production.html                        │
│ ├─ Select content type (Twitch/NBA/News)                        │
│ ├─ Select format (compilation/short)                            │
│ ├─ Select streamers (if Twitch)                                 │
│ ├─ Set clips per streamer                                       │
│ └─ Click GENERATE                                               │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: SCRIPT GENERATION                                        │
│ Tools: Gemini (clip analysis) + Claude (script writing)         │
│ ├─ Gemini watches all clips (3 waves, 10 clips each)           │
│ ├─ Gemini provides analysis JSON for each clip                  │
│ ├─ Claude writes Bobby G script using style fingerprint         │
│ └─ Output: Full script with [CLIP PLAYS HERE] markers           │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ GATE 1: SCRIPT QA (Gemini cross-check)                          │
│ ├─ Score: 0-100                                                  │
│ ├─ PASS: ≥90 → auto-proceed to HeyGen                           │
│ ├─ MANUAL: 70-89 → hold for user review in dashboard            │
│ ├─ FAIL: <70 → back to Claude (max 3 retries)                   │
│ └─ Critical checks:                                              │
│    - [CLIP PLAYS HERE] count matches clip count                 │
│    - "Appreciate you!" in outro                                 │
│    - Correct streamer display names                             │
│    - No content mismatch (setup matches clip)                   │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ DASHBOARD REVIEW & EDIT                                          │
│ ├─ Script appears in editor                                     │
│ ├─ User can edit inline                                         │
│ ├─ Pronunciation library auto-applies phonetic fixes            │
│ └─ Click "SEND TO HEYGEN"                                       │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: HEYGEN AVATAR RENDERING                                  │
│ API: https://api.heygen.com/v2/video/generate                   │
│ ├─ Each text segment sent individually to HeyGen                │
│ ├─ Avatar IDs:                                                   │
│ │  - Compilations: 19c1d4adf8904694a3cc331c5a9bee4b (16:9)     │
│ │  - Shorts: ed57439c9c3d4a398f3b247b75714b13 (9:16)          │
│ ├─ Voice: "cw" (2e598f1a6022448cb6710e5d44665325)              │
│ ├─ Speed: 0.85 (base) / 0.95 (reactions)                       │
│ ├─ Cost: ~$0.004/sec (~$4/20min compilation, ~$0.36/short)     │
│ ├─ Dashboard polls status until COMPLETED                       │
│ └─ Downloads to tmp/ directory                                  │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ GATE 2: HEYGEN SEGMENT QA (Gemini samples)                      │
│ ├─ Samples: first/middle/last segment                           │
│ ├─ Score: 0-100                                                  │
│ ├─ PASS: ≥85 → proceed to assembly                              │
│ ├─ MANUAL: 65-84 → hold for user review                         │
│ ├─ FAIL: <65 → re-render failed segments (max 3 retries)        │
│ └─ Checks:                                                       │
│    - Lip sync quality                                           │
│    - Audio presence                                             │
│    - Rendering artifacts                                        │
│    - Motion quality                                             │
│    - Freeze detection                                           │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: ASSEMBLY (FFmpeg + CapCut)                              │
│ Dashboard click: "ASSEMBLE" button                              │
│ ├─ 1. Download all HeyGen segments + source clips               │
│ ├─ 2. Re-resolve Twitch clip URLs (CDN tokens expire)           │
│ ├─ 3. Validate MP4 headers (skip CTYP/expired clips)            │
│ ├─ 4. Normalize to TS:                                          │
│ │    - 1920×1080, 30fps, CFR                                    │
│ │    - Keyframe every 30 frames                                 │
│ │    - AAC audio 44.1kHz                                        │
│ ├─ 5. Generate intro cards (Node Canvas):                       │
│ │    - 720x840px (2x resolution)                                │
│ │    - Profile image (7 patterns × 4 extensions)                │
│ │    - Gold ring, name, origin, fact                            │
│ │    - Lanczos downscale to 360px                               │
│ ├─ 6. Concat demuxer (30+ segments, reliable A/V sync)          │
│ ├─ 7. Bake ticker overlay (60s loop, 80px/sec)                  │
│ ├─ 8. Burn logo bug (top-right, -crf 18, yuv420p)              │
│ ├─ 9. ffprobe validation                                        │
│ └─ Output: ~/cwn-production/output/[filename].mp4               │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ AUTO: GOOGLE DRIVE UPLOAD                                        │
│ ├─ Folder: 1LJKU3DwQY4nwbLXBeNROpHc9o6tZbUyB                    │
│ ├─ Sets public sharing                                          │
│ └─ Local copy: ~/cwn-production/output/                         │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ GATE 3: ASSEMBLY QA (Gemini watches final video)                │
│ ├─ Samples: 3 points (10%, 50%, last 25 seconds)               │
│ ├─ Each sample: 20 seconds                                      │
│ ├─ Score: 0-100                                                  │
│ ├─ PASS: ≥70 AND no critical failures → proceed to pre-publish │
│ ├─ MANUAL: 60-69 AND no critical → hold for review              │
│ ├─ FAIL: <60 OR critical failure → re-assemble (max 3 retries) │
│ ├─ Critical Failures (auto-fail):                               │
│ │  - Video freeze detected                                      │
│ │  - Ticker missing from all 3 samples                          │
│ │  - Outro cut off ("Appreciate you!" missing)                 │
│ │  - A/V desync detected                                        │
│ └─ Reports saved: output/qa_failures/ + Google Drive            │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: PRE-PUBLISH (PLANNED — NOT YET IMPLEMENTED)             │
│ ├─ Generate title (Claude)                                      │
│ ├─ Generate description (Claude)                                │
│ ├─ Generate hashtags (Claude)                                   │
│ ├─ Generate pinned comment (Claude)                             │
│ ├─ Create thumbnail:                                             │
│ │  - Extract frame at 15s (FFmpeg)                              │
│ │  - Auto-fill Canva template (Canva MCP)                       │
│ │  - Templates: Option 3 or 4                                   │
│ │  - A/B testing: video frame vs. Canva design                  │
│ └─ Dashboard "Pre-Publish" tab for review                       │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ GATE 4: PRE-PUBLISH QA (Gemini review)                          │
│ ├─ Checks:                                                       │
│ │  - Title compelling and accurate                              │
│ │  - Description complete with timestamps                       │
│ │  - Hashtags relevant and platform-appropriate                 │
│ │  - Thumbnail high-quality and on-brand                        │
│ │  - Shorts: Bobby G avatar has burned-in captions enabled      │
│ ├─ PASS: All checks → unlock "PUBLISH" button                   │
│ └─ FAIL: Issues found → hold for user correction                │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ STEP 5: PUBLISH & SCHEDULE (Upload-Post API)                    │
│ Platform-specific distribution:                                 │
│ ├─ YouTube (long-form compilations):                            │
│ │  - 16:9 MP4                                                    │
│ │  - Thumbnail upload                                           │
│ │  - Pinned comment                                             │
│ │  - Optimal times: 12pm, 5pm, 8pm EST                          │
│ ├─ YouTube Shorts:                                               │
│ │  - 9:16 MP4                                                    │
│ │  - Optimal times: 7am, 12pm, 7pm EST                          │
│ ├─ TikTok:                                                       │
│ │  - 9:16 MP4                                                    │
│ │  - DIRECT_POST privacy                                        │
│ │  - Optimal times: 7am, 12pm, 7pm EST                          │
│ └─ Instagram Reels:                                              │
│    - 9:16 MP4                                                    │
│    - Optimal times: 9am, 6pm EST                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## **KEY FILES & ARCHITECTURE**

```
~/cwn-production/
├── server.js                  # Main Node.js API (port 3000)
├── cwn_production.html        # Dashboard UI (port 8765)
├── streamers.json             # 10-streamer roster + intro card data
├── cwn_style_guides.json      # Bobby G voice fingerprint (taught from reference videos)
├── .env                       # API keys (gitignored)
├── package.json               # Dependencies
├── README.md                  # Quick reference
├── CWN_Production_Manual.html # Full manual (slightly outdated)
├── output/                    # Final MP4s + thumbnails
│   └── qa_failures/           # QA reports (local only)
├── tmp/                       # Working files (auto-cleaned)
│   ├── asm_*_*.ts             # Normalized segments
│   ├── asm_*_*.mp4            # HeyGen avatar videos
│   └── ticker_*.mp4           # Cached ticker overlays
└── assets/
    └── streamers/             # Local profile images (12 files)
        ├── jasontheween.png
        ├── hasanabi.jpeg
        ├── stableronaldo (no extension)
        └── ...
```

---

## **API STACK**

| Service | Purpose | Cost | Status |
|---------|---------|------|--------|
| **HeyGen** | Avatar video generation | $0.004/sec | ✅ Active |
| **Claude (Anthropic)** | Script writing, orchestration | ~$0.05/script | ✅ Active |
| **Gemini 2.5 Flash** | Clip analysis, QA gates | ~$0.014/clip | ✅ Active |
| **Twitch Helix API** | Clip fetching, GQL resolution | Free | ✅ Active |
| **FFmpeg** | Assembly, normalization, overlays | Free | ✅ Active |
| **Google Drive API** | Video storage | Free | ✅ Active |
| **Upload-Post API** | Multi-platform publishing | $99/mo | 🟡 Planned |
| **Canva (via MCP)** | Thumbnail generation | Free tier | 🟡 Planned |
| **CapCut MCP** | Advanced assembly, thumbnails | Free | 🟡 Planned |

---

## **OPTIMIZATION OPPORTUNITIES**

### **1. HeyGen Cost Reduction (70%+ of budget)**
- **Current:** ~$0.004/sec = ~$4.50 per 20min compilation
- **Opportunity:** Shorter scripts = lower cost
- **Action:** Tighten reactions to 1 sentence, reduce bridge setups

### **2. Parallel Processing**
- **Current:** Sequential HeyGen segment rendering
- **Opportunity:** HeyGen API accepts batch requests
- **Action:** Send all segments in one API call instead of looping

### **3. Clip Re-Resolution**
- **Current:** Re-resolves Twitch CDN URLs at assembly time (tokens expire)
- **Issue:** Sometimes clips expire entirely (Maya had 0 clips)
- **Action:** Increase backup pool to 5 clips per streamer, retry expired clips

### **4. Gate 2 Sampling**
- **Current:** Samples 3 segments (first/middle/last)
- **Issue:** May miss issues in other 39 segments
- **Action:** Random sampling of 5-7 segments instead of predictable 3

### **5. Local Profile Images**
- **Current:** 7 filename patterns × 4 extensions = 28 file checks per streamer
- **Issue:** Inefficient, could slow down card generation
- **Action:** Standardize to single pattern (e.g., `{twitchUsername}.png`) and batch convert all images

### **6. Ticker Cache**
- **Current:** 60s ticker loop cached to tmp/ticker_*.mp4
- **Opportunity:** Ticker rarely changes, can be permanent asset
- **Action:** Move to assets/ folder, only regenerate on data update

### **7. QA Report Storage**
- **Current:** Saved to both local disk and Google Drive
- **Issue:** Duplicate storage, Drive folder cluttered
- **Action:** Local only, Drive upload optional on user request

### **8. Assembly Retry Logic**
- **Current:** Max 3 retries on Gate 3 failure
- **Issue:** If all 3 fail, job is abandoned (wasted HeyGen cost)
- **Action:** Manual intervention option in dashboard before abandoning

### **9. Pronunciation Library**
- **Current:** Stored in localStorage (browser-only)
- **Issue:** Lost if browser cache cleared
- **Action:** Move to server-side JSON file, auto-sync

### **10. Intro Card Font Sizing**
- **Recent Fix:** Reduced starting font from 52px → 44px
- **Opportunity:** Pre-calculate optimal font size per fact length
- **Action:** Map fact character count to font size (avoid trial-and-error loop)

---

## **DEPLOYMENT ROADMAP — Local → Railway**

### **Phase 1: Local Development (CURRENT)**
✅ Dashboard: http://localhost:8765
✅ API: http://localhost:3000
✅ All 3 terminals running manually

### **Phase 2: Stable Codebase (NEXT)**
- ✅ All 4 gates passing reliably
- ✅ All 3 content types working (Twitch ✅, NBA 🟡, News 🟡)
- ✅ Pre-publish + thumbnails implemented
- ✅ Upload-Post integration tested

### **Phase 3: Railway Deployment**
**Server Hosting:**
- Deploy server.js to Railway ($25/mo)
- Environment variables via Railway dashboard
- Auto-restart on crashes
- Persistent disk for tmp/ and output/

**Dashboard Options:**
1. Static host (Vercel/Netlify free tier)
2. Same Railway instance (serve static files from server.js)

**Challenges:**
- FFmpeg on Railway (needs buildpack)
- CapCut MCP (VectCutAPI Python server)
- Google Drive OAuth (refresh token management)

---

## **PROPOSED PUBLISHING SCHEDULE**

| Day | Time | Platform | Content | Format |
|-----|------|----------|---------|--------|
| **Mon-Sun** | 12pm EST | YouTube | Twitch Compilation | Long |
| **Mon/Wed/Fri** | 7pm EST | YouTube | NBA Highlights | Long |
| **Tue/Thu** | 5pm EST | YouTube | News Compilation | Long |
| **Daily** | 7am EST | TikTok + IG + YT Shorts | Daily Update | Short |
| **Daily** | 12pm EST | TikTok + IG + YT Shorts | Trending Topic | Short |
| **Daily** | 7pm EST | TikTok + IG + YT Shorts | Late Night | Short |

**Total Weekly Production:**
- 7 Twitch compilations (daily)
- 3 NBA compilations (Mon/Wed/Fri)
- 2 News compilations (Tue/Thu)
- 21 shorts (3/day × 7 days)
- **Total:** 33 videos/week ≈ 140 videos/month

**Estimated Monthly Cost:**
- 12 long-form × 4 weeks = 48 compilations @ $4 = $192
- 21 shorts × 4 weeks = 84 shorts @ $0.36 = $30
- Upload-Post = $99
- Gemini + Claude = $40
- **Total:** ~$361/month

---

## **CRITICAL FIXES COMPLETED (Last Session)**

1. ✅ **twitchUsername fallback** — generateIntroCardPNG now tries streamerData.twitchUsername first
2. ✅ **Gate 3 LATE sample** — Changed from 85% to last 25 seconds (always catches outro)
3. ✅ **Fact text font** — Reduced start from 52px → 44px, min 14px (better fit, less shrinking)
4. ✅ **Profile image lookup** — 7 patterns × 4 extensions (.png, .jpeg, .jpg, no ext)
5. ✅ **FFmpeg quality** — Added -crf 18, -pix_fmt yuv420p, lanczos scaling
6. ✅ **Intro cards 2x rendering** — 720x840 canvas, downscaled with lanczos for sharpness
7. ✅ **Gate 3 scoring** — Min score 70 if no FAILs, logs raw Gemini response

---

## **NEXT STEPS**

### **Immediate (This Week)**
1. **Test complete Twitch workflow** — Generate → HeyGen → Assemble → Publish
2. **Verify all local profile images** — Standardize filenames
3. **Implement pre-publish tab** — Title/description/thumbnail generation
4. **Upload-Post integration** — Test YouTube/TikTok/Instagram publish

### **Short Term (2-4 Weeks)**
1. **NBA compilation first run**
2. **News compilation first run**
3. **Canva thumbnail templates** — Options 3 & 4
4. **CapCut MCP integration** — Advanced assembly

### **Long Term (1-3 Months)**
1. **Railway deployment** — Automated overnight runs
2. **Roster expansion** — ExtraEmily, YourRage
3. **YouTube chapter auto-gen** — From transcript
4. **A/B thumbnail testing** — Track which performs better

---

## **HOW TO MONITOR FROM CLAUDE CODE**

Since I can't automatically monitor, here's how to give me visibility:

```bash
# Start server with logging
cd ~/cwn-production
node server.js > server.log 2>&1 &

# Then periodically ask me to check:
claude "tail -50 ~/cwn-production/server.log"
claude "Check if assembly job [asmId] completed"
claude "Show me any errors in the last 100 lines of logs"
```

**Or use nodemon for auto-restart:**
```bash
nodemon server.js  # Auto-restarts on file changes
```

---

**END OF OVERVIEW**
