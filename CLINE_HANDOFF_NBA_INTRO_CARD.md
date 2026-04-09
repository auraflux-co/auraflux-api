# NBA Intro Card Generator — Handoff to Cline

**Date:** 2026-04-09
**From:** Claude Code
**Status:** Ready to build
**Priority:** Phase 5 Creative Layer

---

## CRITICAL LAYOUT CHANGE

**All long-form videos (News, NBA, Twitch) now use the same layout:**
- **Video card positioned LEFT of Bobby G** (not right)
- TV-shaped card (640×360 aspect ratio)
- Content-specific display in the TV:
  - **News**: Article image from story
  - **NBA**: Game thumbnail + PPG leaders + W/L records
  - **Twitch**: Streamer profile pics (existing text moves underneath)

This creates **visual consistency across all 3 content types** — TV on left facing Bobby G.

---

## What You're Building

**Endpoint:** `/nba/generate-intro-card` (POST)
**Purpose:** Generate a 640×360 TV-shaped intro card for each NBA game in long-form videos
**Method:** Resize existing `nba_thumbnail_generator.html` output

### Input (JSON POST body)
```json
{
  "gameId": "401584893",
  "outputPath": "output/nba_intro_card_401584893.png"
}
```

### Output
- PNG image at specified `outputPath`
- Dimensions: 640×360 pixels (TV aspect ratio)
- Contains:
  - Game thumbnail from ESPN API (teams, logos, scores)
  - PPG leaders for both teams (pulled from SEASON_LEADERS object)
  - Player profile pictures (from ESPN API)
  - Team W/L records under logos

---

## Technical Implementation

### Step 1: Review Existing Code
File: `/Users/robertgregory/cwn-production/templates/nba_thumbnail_generator.html`

**Key sections to understand:**
- **Lines 154-185**: `SEASON_LEADERS` object (hardcoded PPG/RPG/APG + ESPN player IDs for all 30 teams)
- **Lines 200-400**: ESPN API integration pattern
  - API: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={gameId}`
  - Team colors pulled dynamically
  - Player headshots from ESPN
- **Background image**: `assets/nba_long_form thumbnail.jpg`
- **Current output**: 1280×720 (needs to be 640×360)

### Step 1.5: FFmpeg Video Card Conversion (Optional)

If you need to convert the PNG intro card to an MP4 video for CapCut integration:

**Basic command:**
```bash
ffmpeg -loop 1 -i input.png -vf "scale=640:360,format=yuv420p" -t 10 -c:v libx264 output.mp4
```

**With letterboxing (prevents stretching):**
```bash
ffmpeg -loop 1 -i input.png -vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2" -t 10 -c:v libx264 -r 30 output.mp4
```

**Parameters:**
- `-loop 1`: Loops the single image
- `-vf "scale=640:360,format=yuv420p"`: Resizes to 640×360 and ensures player compatibility
- `-t 10`: Video duration (10 seconds)
- `-c:v libx264`: H.264 encoding
- `-r 30`: Frame rate (30fps)
- `force_original_aspect_ratio=decrease,pad=...`: Letterbox instead of stretch

**For CapCut/MJPEG (if needed):**
```bash
ffmpeg -loop 1 -i input.png -vf "scale=640:360" -c:v mjpeg -q:v 2 -t 10 output.avi
```

**Note:** Start with PNG output for the endpoint. Add video conversion later if CapCut integration requires MP4/AVI format.

### Step 2: Create New Endpoint in server.js

**Location:** Add after existing NBA thumbnail endpoint (around line 9242 or 9575)

**Pseudocode:**
```javascript
app.post('/nba/generate-intro-card', async (req, res) => {
  const { gameId, outputPath } = req.body;

  // Validate inputs
  if (!gameId || !outputPath) {
    return res.status(400).json({ error: 'Missing gameId or outputPath' });
  }

  // Launch Puppeteer with nba_thumbnail_generator.html
  // Pass gameId to page via URL params: ?gameId=401584893
  // Wait for ESPN API data to load
  // Set viewport to 640×360 (TV aspect ratio)
  // Take screenshot
  // Save to outputPath

  res.json({ success: true, path: outputPath });
});
```

### Step 3: Modify HTML Template Dimensions

**Options:**
1. **Option A (Recommended)**: Create new `nba_intro_card.html` by copying `nba_thumbnail_generator.html` and changing dimensions to 640×360
2. **Option B**: Add URL param support to existing template (`?width=640&height=360`)

If you choose Option A:
- Copy `templates/nba_thumbnail_generator.html` → `templates/nba_intro_card.html`
- Change viewport: `<meta name="viewport" content="width=640">` (line 5)
- Change body dimensions: `width: 640px; height: 360px;` (CSS)
- Adjust font sizes proportionally (reduce by ~50%)
- Keep all ESPN API logic unchanged

### Step 4: Integration Points

**Where this gets called:**
- During NBA long-form video assembly (in `/assemble` endpoint)
- For each game in the script, generate intro card before HeyGen send
- Card displayed at `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` (left of Bobby G)

**Example flow:**
```
1. User generates NBA long-form script with 3 games
2. For each game, call /nba/generate-intro-card with gameId
3. Store intro card PNG in output/
4. During video assembly, overlay intro card LEFT of Bobby G at intro timing
5. Same pattern as News (article image) and Twitch (profile pics)
```

---

## Key Files to Reference

| File | Why You Need It |
|------|-----------------|
| `templates/nba_thumbnail_generator.html` | Base template with all ESPN API logic |
| `server.js` lines 9242-9400 | Existing NBA thumbnail endpoint pattern |
| `tools/clipzworld_newscast.html` lines 275-286 | Story list resizing example (360px width for space) |
| `data/streamers.json` | Not needed for NBA, but shows data structure pattern |
| `VISUAL_DESIGN_SPEC.md` | Layout zones reference |

---

## Brand Standards to Follow

- **CWN Gold:** `#c7af4f`
- **Border style:** `5px solid` + `0 4px 15px rgba(0,0,0,0.5)` shadow at 50% opacity
- **Text shadow:** `0 2px 12px rgba(0,0,0,0.8)` for all text overlays
- **Background:** Same as existing NBA template (`assets/nba_long_form thumbnail.jpg`)

---

## Testing Checklist

After building `/nba/generate-intro-card`:

- [ ] Endpoint responds to POST with valid gameId
- [ ] Output image is exactly 640×360 pixels
- [ ] ESPN API data loads correctly (teams, scores, player headshots)
- [ ] PPG leaders display correctly from SEASON_LEADERS object
- [ ] Team W/L records appear under logos
- [ ] Image quality is clear at TV aspect ratio
- [ ] Font sizes are readable at smaller resolution
- [ ] Test with multiple gameIds to ensure dynamic data works

**Test gameId:** `401584893` (example from existing code)

---

## Questions?

If you encounter issues:
1. Check `templates/nba_thumbnail_generator.html` for ESPN API patterns
2. Verify SEASON_LEADERS object has data for both teams in the game
3. Ensure Puppeteer viewport matches HTML canvas size (640×360)
4. Test screenshot timing — ESPN API may need `waitForSelector()` before capture

---

## What Claude Code Completed

✅ Newscast overlay branding updates (`tools/clipzworld_newscast.html`):
- Changed "CLIPZWORLD" → "ClipzWorld News"
- Changed "WORLD NEWS & SPORTS" → "EPISODE 1" (dynamic)
- Replaced time with date display (MARCH 30, 2026 format)
- Resized story list from 420px → 360px to make room for video card
- Added documentation comments about video card LEFT positioning
- Bottom ticker: "CZW NEWS" → "BREAKING NEWS"

✅ Story tracking system:
- `setActiveStory(storyId)` function for dynamic "ON AIR" indicator
- URL param support: `?activeStory=2`
- postMessage API for OBS integration

✅ 5-second pause logic:
- Added to Gemini script generation (server.js lines 6267-6281)
- Applies to news long-form after every Bobby G reaction

---

**Ready to build when you are. Let me know if you need clarification on any part.**
