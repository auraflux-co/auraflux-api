# CWN Production Schedule & Volume

## Monthly Production Volume

### Long Form (YouTube Only - 16:9)
| Type | Count/Month | Thumbnail Needed |
|------|-------------|------------------|
| NBA | 30 | ✅ Yes |
| Twitch | 15 | ✅ Yes |
| News | 15 | ✅ Yes |
| **TOTAL** | **60** | **60 thumbnails** |

### Short Form (9:16 - Multi-Platform)
| Production | Count/Month | Platforms | Platform-Specific Processing | Max Duration |
|------------|-------------|-----------|------------------------------|--------------|
| **Base videos produced** | 90 (3/day) | - | Raw 9:16 video from assembly | **3 min max** |
| NBA short form | 30 (1/day) | YT Shorts, TikTok, IG Reels | ✅ CapCut → 3 variants | **3 min max** |
| News short form ("flips") | 30 (1/day) | YT Shorts, TikTok, IG Reels | ✅ CapCut → 3 variants | **3 min max** |
| Twitch short form | 30 (1/day) | YT Shorts, TikTok, IG Reels | ✅ CapCut → 3 variants | **3 min max** |
| **CapCut optimized variants** | **270** (90 × 3) | - | Platform-specific effects/captions | - |
| **Total short form posts** | **270/month** | **9/day** | 3 videos × 3 platforms | - |

**Key Workflow (Per Video):**

**NBA Short Form:**
1. Produce 1 NBA base video (9:16)
2. CapCut creates 3 platform-optimized variants:
   - YouTube Shorts variant (YT-specific captions, effects, thumbnail)
   - TikTok variant (TT-specific captions, effects, hooks)
   - Instagram Reels variant (IG-specific captions, effects, style)
3. Publish same NBA video to all 3 platforms (at scheduled times)

**News Short Form ("flips" - inspired by Al Jazeera):**
1. Produce 1 News base video (9:16, max 3 min)
2. CapCut creates 3 platform-optimized variants
3. Publish same News video to all 3 platforms
   - Reference: https://www.aljazeera.com/video/newsfeed/#flips

**Twitch Short Form:**
1. Produce 1 Twitch base video (9:16)
2. CapCut creates 3 platform-optimized variants
3. Publish same Twitch video to all 3 platforms

**Result:** 3 videos/day → 9 posts/day (each video posted to 3 platforms)

**CapCut's Role:** Takes the same base video content and adds platform-specific best practices (captions, effects, thumbnail optimization) for each platform.

---

## Daily Publishing Schedule

### Long Form YouTube Videos (with Thumbnails)

| Day | 2pm | 4pm | 6pm | Daily Total |
|-----|-----|-----|-----|-------------|
| **Every Day** | NBA long form | - | - | 1 |
| **Odd Days (1,3,5...)** | NBA long form | Twitch long form | - | 2 |
| **Even Days (2,4,6...)** | NBA long form | - | News long form | 2 |

**Pattern:**
- **NBA:** 1× daily at 2pm (Mon-Sun) = **7/week = ~30/month**
- **Twitch:** Every other day at 4pm = **3-4/week = ~15/month**
- **News:** Every other day at 6pm = **3-4/week = ~15/month**

**Total long form:** ~8-9 videos/week = **60/month**

---

### Short Form (Same Video → 3 Platforms)

**Production:** 2 short form videos created daily = **60/month**

**Publishing (3 Videos to All Platforms Daily):**

| Platform | Publish Time | Frequency | Videos/Day | Videos/Month |
|----------|--------------|-----------|------------|--------------|
| **YouTube Shorts** | 4pm EST | Daily | 3 (NBA, News, Twitch) | 90 |
| **Instagram Reels** | 12pm EST | Daily | 3 (NBA, News, Twitch) | 90 |
| **TikTok** | 6pm EST | Daily | 3 (NBA, News, Twitch) | 90 |
| **TOTAL POSTS** | - | Daily | **9** | **270** |

**Important:** The SAME 3 short videos produced each day (1 NBA + 1 News + 1 Twitch) are published to all 3 platforms at different times with platform-specific CapCut optimization.

---

## Thumbnail Requirements

### Monthly Thumbnail Volume
- **Long Form:** 60 thumbnails/month (1 per long form video)
- **Short Form:** 0 thumbnails (platforms auto-generate)

**Total:** **60 thumbnails/month** = **2 thumbnails/day average**

### Thumbnail Workflow
With 60 thumbnails/month:

**Manual Canva:**
- 60 thumbnails × 5 min = **5 hours/month**

**FFmpeg Automation:**
- Setup: 1 hour (one-time)
- Monthly: **0 minutes** (fully automated)
- **ROI: Pays for itself in month 1**

**Recommendation:** ✅ **Implement FFmpeg thumbnail automation** (definitely worth it at this volume)

---

## CapCut Integration for Short Form Design

**CapCut's Critical Role:**
- Takes base 9:16 video from assembly
- Creates 3 platform-optimized variants with best practices:
  - **YouTube Shorts:** Captions, effects, thumbnail frame optimized for YT algorithm
  - **TikTok:** Captions, effects, hooks optimized for TT algorithm
  - **Instagram Reels:** Captions, effects, style optimized for IG algorithm

**Short Form Workflow:**
1. Generate script (Claude)
2. Render avatar segments (HeyGen)
3. **Base assembly** → FFmpeg (9:16 raw video)
4. **Platform optimization** → CapCut API (3 variants with platform-specific design)
5. Publish 3 variants via Upload-Post (different times/metadata per platform)

**Result:** 2 base videos/day → 6 optimized publishes/day (2 × 3 platforms)

---

## Upload-Post API Requirements

### Daily Upload-Post Jobs

**Long Form (YouTube only):**
- 1-2 jobs/day (depends on odd/even day)
- Custom thumbnails required
- Metadata: title, description, hashtags, pinned comment

**Short Form (3 platforms):**
- 9 upload jobs/day (3 videos × 3 platforms)
- Each video: NBA, News, Twitch
- CapCut-optimized variant per platform
- Scheduled at different times:
  - 12pm: Instagram Reels (3 posts: NBA, News, Twitch)
  - 4pm: YouTube Shorts (3 posts: NBA, News, Twitch)
  - 6pm: TikTok (3 posts: NBA, News, Twitch)

**Total Upload-Post API Calls:**
- Daily: 10-11 jobs (1-2 long form + 9 short form)
- Monthly: ~300-330 jobs (60 long form + 270 short form)

---

## Production Workflow Summary

### Daily Production Checklist

**Morning (Generate Content):**
1. Generate scripts for 3 short form videos (1 NBA + 1 News + 1 Twitch)
2. Generate script for 1 NBA long form
3. If odd day: Generate Twitch long form script
4. If even day: Generate News long form script

**Midday (Render & Assembly):**
1. Render HeyGen segments for all scripts
2. Assemble 3 short form base videos (FFmpeg → 9:16 MP4)
3. Process 3 short forms through CapCut API → 9 platform-optimized variants
   - 3 for YouTube Shorts
   - 3 for TikTok
   - 3 for Instagram Reels
4. Assemble long form videos (FFmpeg → 16:9 MP4)
5. Generate thumbnails for long form (FFmpeg automation)

**Afternoon (Publish):**
- 12pm: Publish 3 short forms → Instagram Reels (NBA, News, Twitch)
- 2pm: Publish NBA long form → YouTube
- 4pm (odd days): Publish Twitch long form → YouTube
- 4pm (every day): Publish 3 short forms → YouTube Shorts (NBA, News, Twitch)
- 6pm (even days): Publish News long form → YouTube
- 6pm (every day): Publish 3 short forms → TikTok (NBA, News, Twitch)

---

## Verification & Questions

### ✅ What I Understand

1. **60 long form videos/month** (30 NBA + 15 Twitch + 15 News) → Need 60 thumbnails
2. **60 short form videos/month** (2/day) → Reused across YouTube Shorts, TikTok, IG Reels
3. **Same short video** published to 3 platforms at different times with platform-specific metadata
4. **CapCut handles design elements** for short form (text overlays, effects)
5. **Upload-Post schedules** are platform-specific (12pm IG, 4pm YT Shorts, 6pm TikTok)

### ✅ Confirmed Details

**Short Form Content Mix:**
- **3 short forms/day** (1 NBA + 1 News + 1 Twitch)
- **90 base videos/month** (30 NBA + 30 News + 30 Twitch)
- **270 platform posts/month** (90 × 3 platforms)

### ❓ Still Need to Know

1. **CapCut API Status:**
   - Is `VectCutAPI/` production-ready?
   - Or do we need to implement CapCut API integration?
   - Do you have CapCut API credentials?
   - **This is CRITICAL** — 90 videos/month need CapCut processing → 270 variants

2. **Thumbnail Templates (Long Form Only):**
   - NBA long form: Uses what template?
   - Twitch long form: Uses 11-streamer-circle template (DAHGB-hGwds)? ✅
   - News long form: Uses what template?
   - **Are they the same or different templates?**
   - If different, need to implement 3 FFmpeg template variants

---

## Impact on Production Systems

### Thumbnail Generation (FFmpeg Automation)
- **Volume:** 60/month (2/day average)
- **Automation Value:** Saves 5 hours/month
- **Priority:** ✅ HIGH (implement now)

### CapCut Integration
- **Volume:** 90 base short forms/month (3/day) → 270 platform variants
- **Current Status:** CRITICAL - Need to verify if `VectCutAPI/` is production-ready
- **Priority:** ✅ **CRITICAL** — Blocks 90% of short form publishing workflow

### Upload-Post Configuration
- **Volume:** 300-330 API calls/month
- **Scheduling:** 10-11 scheduled publishes/day across 4 platforms
  - YouTube: 1-2 long form + 3 shorts = 4-5/day
  - TikTok: 3 shorts/day
  - Instagram Reels: 3 shorts/day
- **Metadata:** Platform-specific for each upload
- **Priority:** ✅ HIGH (ensure scheduling logic is robust)

---

## Next Steps

**Please confirm:**

1. **CapCut API status:** Is `VectCutAPI/` production-ready? Do you have CapCut credentials?
2. **Thumbnail templates:** Same template for NBA/News/Twitch or different?

**Then I'll implement:**

1. ✅ **FFmpeg thumbnail automation** (60/month = saves 5 hours/month)
2. ✅ **CapCut API integration** (CRITICAL — 90 videos/month → 270 variants)
3. ✅ **Upload-Post scheduling logic** (300+ jobs/month across 4 platforms)

---

## Summary

**Monthly Production:**
- 60 long form videos (30 NBA + 15 Twitch + 15 News) → 60 thumbnails
- 90 short form videos (30 NBA + 30 News + 30 Twitch) → 270 platform posts

**Daily Workload:**
- 1-2 long form videos
- 3 short form videos
- 10-11 scheduled publishes

**Critical Dependencies:**
- ✅ FFmpeg thumbnail automation (high value)
- ⚠️ CapCut API integration (CRITICAL — blocks short form workflow)
- ✅ Upload-Post multi-platform scheduling

Let me know the answers to the 2 questions above and I'll start implementation!
