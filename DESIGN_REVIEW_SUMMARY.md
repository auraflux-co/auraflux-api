# CWN Design & Thumbnail System - Action Plan

## CRITICAL ISSUE: Canva API Limitation

**Problem:** Your Canva Pro account cannot use the Autofill API (Enterprise only).  
**Current Status:** /generate-thumbnail endpoint won't work without Enterprise.  
**Options:**
1. **Upgrade to Canva Enterprise** ($$$)
2. **Implement FFmpeg thumbnail generation** (local, automated, free)
3. **Manual Canva workflow** (5 min per thumbnail, 60/month)

**Recommendation:** **Implement FFmpeg thumbnail automation** (best ROI for 60/month volume)

---

## Thumbnail Requirements Summary

### Twitch Long Form ("Twitch Soup")
- [ ] Bobby G avatar (center, faded/70% opacity)
- [x] 11 streamer circles (prominent) - EXISTS
- [ ] Update "THE DAILY UPDATE" → "Twitch Soup"
- [ ] Add date text
- [ ] Add episode number (auto-increment from 1)
- [ ] CWN logo (top right)  
- [ ] CWN + Twitch brand colors

**File:** server.js:5734 (currently uses Canva, needs FFmpeg rewrite)

### NBA & News Long Form
- [ ] Completely new - user will provide design examples
- [ ] Date, episode number, CWN logo
- [ ] Platform-specific brand colors

### Short Form (All Content Types)
- [ ] Split screen: Bobby G reaction + news source video frame
- [ ] One-line Gemini caption
- [ ] Same design across YouTube Shorts, TikTok, IG Reels

---

## Assets Found

✅ **CWN Logo:** `assets/cwn_logo.png` (49KB)  
✅ **CWN Banner:** `assets/cwn_banner.png` (86KB)  
❓ **Bobby G Avatars:** Need to find long form vs short form versions  
❓ **Brand Colors:** Need hex values for CWN, Twitch, NBA

---

## Next Actions (In Priority Order)

1. **You provide:**
   - [ ] NBA/News thumbnail design examples (put in cwn-production/)
   - [ ] CWN brand colors (hex values)
   - [ ] Twitch brand colors (hex values)
   - [ ] NBA brand colors (hex values)
   - [ ] Bobby G avatar files (long form + short form)

2. **I implement:**
   - [ ] FFmpeg thumbnail generator (Twitch, NBA, News variants)
   - [ ] Episode number auto-increment logic
   - [ ] Update "THE DAILY UPDATE" → "Twitch Soup" in all code
   - [ ] Short form split-screen workflow with CapCut API

3. **Then test:**
   - [ ] Generate 1 Twitch thumbnail
   - [ ] Generate 1 NBA thumbnail
   - [ ] Generate 1 News thumbnail
   - [ ] Generate 1 short form split-screen

---

## Other Items From Your Brief

**Transcripts & Style Guides:** (See separate section below)  
**QA Gates Review:** (See separate section below)  
**Short Form Workflow:** (See separate section below)  
**FFmpeg Quality:** (See separate section below)

