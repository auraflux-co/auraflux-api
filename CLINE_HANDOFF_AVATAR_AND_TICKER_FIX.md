# Cline Handoff: Avatar Swap + Overlay Flip + Ticker Fix

**Author:** Claude Code
**Date:** 2026-04-11
**Status:** Ready to ship — atomic commit bundling 3 fixes and 1 spec update
**Priority:** BLOCKS 12-test suite — no test case can pass until these land
**Effort estimate:** 30-60 min coding + 1 test run to verify

---

## TL;DR — what and why

The broken Apr 10 videos have **three confirmed bugs** discovered during diagnosis. This handoff bundles all three fixes into a single atomic commit, plus related doc updates so future agents don't get confused about the layout. Full diagnostic trail in `CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md` (commit-in-parallel — see below).

### Primary fix — new landscape-native avatar replaces the pillarboxed one

Rob identified that the current avatar renders as portrait-pillarboxed (white bars on sides) because HeyGen Avatar V photo avatars glitch when rendered into a landscape 16:9 canvas. Rob has picked a **new landscape-native avatar** that renders full-bleed:

- **New avatar_id:** `842f20b75ce242aea397f5030aa018aa`
- **Native resolution:** 3840×2160 (4K) — HeyGen will downscale to 1920×1080 cleanly
- **Composition:** Bobby G on the RIGHT side of frame, facing viewer's LEFT. Neon world-map background, microphone + lamp + laptop on the LEFT. Bookshelf and coffee mug on the RIGHT.
- **Frame rate:** Sample render is 25 fps — HeyGen community says the API standard is 30 fps, so we're assuming the sample was an editor export and production API will return 30 fps. **First test run will `ffprobe` to verify.**
- **Reference sample:** `/Users/robertgregory/Downloads/testingo_2160p.mp4` (external, not in repo)

### Secondary fix — flip OVERLAY_ZONE from TOP-LEFT to TOP-RIGHT

Because the new Bobby G faces LEFT, the TV card must move to his facing side = viewer's RIGHT so he appears to look at it. This is actually a **revert to the original spec** — Aider's chat history shows `OVERLAY_ZONE: {x: 1240, y: 40, w: 640, h: 360}` was the original coordinate before commit `787f81f` flipped it on Apr 9 to match the old avatar.

**New OVERLAY_ZONE:** `{x: 1240, y: 40, w: 640, h: 360}` — math: `1920 - 640 - 40 = 1240`

### Tertiary fix — ticker path regression from commit `b31533f`

Commit `b31533f` (2026-04-09) reorganized repo root into folders, moving `cwn_twitch_ticker.html` / `cwn_combined_ticker.html` / `sports_ticker.html` into `tools/` — but did NOT update `TICKER_MAP` in `server.js:4586-4590`. Result: Python static server returns 404 with default "Error response" HTML title, Puppeteer screenshots it, FFmpeg bakes "Error response" text across every frame of the broken Apr 10 videos.

### Spec update — all three content types use consistent TV design at top-right

Rob confirmed: "tv design for nba and news and twitch — all consistent should be in specs". The overlay zone is the SAME position (`{x: 1240, y: 40, w: 640, h: 360}`) and the SAME gold-border style for Twitch intro cards, NBA game cards, and News story cards. No per-content-type divergence.

---

## Code changes (exact diffs)

### Change #1 — Avatar ID swap (2 files)

**`cwn_production.html:1084`:**
```diff
- avatarId: '19c1d4adf8904694a3cc331c5a9bee4b',
+ avatarId: '842f20b75ce242aea397f5030aa018aa',
```

**`cwn_production.html:858`** (Settings UI default):
```diff
- <div class="field"><label>AVATAR ID — COMPILATIONS</label><input id="cfg-avatar-id" value="19c1d4adf8904694a3cc331c5a9bee4b" placeholder="HeyGen avatar ID for NBA/News/Twitch compilations"></div>
+ <div class="field"><label>AVATAR ID — COMPILATIONS</label><input id="cfg-avatar-id" value="842f20b75ce242aea397f5030aa018aa" placeholder="HeyGen avatar ID for NBA/News/Twitch compilations"></div>
```

**`.env`:**
```diff
- HEYGEN_AVATAR_ID=1a5d4e9130d2467fa01d9e1580aff829
+ HEYGEN_AVATAR_ID=842f20b75ce242aea397f5030aa018aa
```

**Rob must also manually clear the dashboard localStorage override** (I cannot do this from server side):
1. Open http://localhost:8765/cwn_production.html in browser
2. DevTools → Application → Local Storage → `http://localhost:8765`
3. Find the `cwn_config` key (or whichever stores `avatarId`)
4. Either delete the key, or edit the JSON value to set `"avatarId": "842f20b75ce242aea397f5030aa018aa"`
5. Refresh the page — the new default will load

**Why both files + .env + localStorage:** The frontend reads from `CFG.avatarId` which is populated from localStorage if present, falling back to the hardcoded default in `cwn_production.html:1084`. The Settings UI input at line 858 is the "reset to default" value. The `.env` `HEYGEN_AVATAR_ID` is not actually read by the frontend (see diagnosis doc) but keeping it in sync prevents future-agent confusion. All four must match.

### Change #2 — Flip OVERLAY_ZONE from top-left to top-right

**`lib/config.js:51`:**
```diff
-      OVERLAY_ZONE: { x: 40, y: 40, w: 640, h: 360 },     // "TV Shape" Top Left (facing Bobby G)
+      OVERLAY_ZONE: { x: 1240, y: 40, w: 640, h: 360 },   // "TV Shape" Top Right (facing Bobby G, who faces viewer's left)
```

**`server.js:3500`** (Twitch intro card burn):
```diff
-                  "-filter_complex", `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=40:y=40:enable='lte(t,${introDur})'[out]`,
+                  "-filter_complex", `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=1240:y=40:enable='lte(t,${introDur})'[out]`,
```

**`server.js:3506`** (log message — currently lies about position):
```diff
-                console.log(`[intro-card] Canvas PNG ready for ${name}, overlaying top-right (2x render, scaled to 360px w/ lanczos)`);
+                console.log(`[intro-card] Canvas PNG ready for ${name}, overlaying top-right at x=1240,y=40 (2x render, scaled to 360px w/ lanczos)`);
```

**`server.js:3650`** (NBA/News intro card burn):
```diff
-                '-filter_complex', `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=40:y=40:enable='lte(t,${introDur})'[out]`,
+                '-filter_complex', `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=1240:y=40:enable='lte(t,${introDur})'[out]`,
```

**`server.js:242`** (VectCutClient comment):
```diff
-   * Position: TV-shaped card (640×360) at OVERLAY_ZONE (top-left, facing Bobby G)
+   * Position: TV-shaped card (640×360) at OVERLAY_ZONE (top-right, facing Bobby G who faces viewer's left)
```

### Change #3 — Logo position conflict resolution (move logo to top-LEFT)

**Why this is needed:** The new OVERLAY_ZONE at `x=1240-1880, y=40-400` would overlap with the current logo at `x=1780, y=20-140` + 120px wide. The logo would land INSIDE the TV card.

**Solution:** Move logo to top-LEFT. This mirrors the design cleanly — most news broadcasts put logo opposite the story card.

**`lib/config.js:52`:**
```diff
-      LOGO_POS: { x: 1780, y: 20, size: 120 }
+      LOGO_POS: { x: 20, y: 20, size: 120 }
```

**`server.js:4037`** (logo FFmpeg overlay):
```diff
-              '[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=W-w-20:20[vout]',
+              '[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=20:20[vout]',
```

**`server.js:4032`** (log comment):
```diff
-            // Overlay logo top-right: x=W-w-20, y=20, 120px wide, 85% opacity
+            // Overlay logo top-left: x=20, y=20, 120px wide, 85% opacity
```

**Short-form logo NOT affected.** Short-form is 9:16 portrait with bottom-half Bobby G — the 80px logo stays at `W-w-15:15` (top-right) because the short-form layout is different. Only long-form flips.

### Change #4 — Ticker path fix

**`server.js:4586-4590`:**
```diff
  const TICKER_MAP = {
-   nba:    'sports_ticker.html',       // sports_ticker.html in Downloads
-   news:   'cwn_combined_ticker.html', // cwn_combined_ticker.html in Downloads
-   twitch: 'cwn_twitch_ticker.html'    // cwn_twitch_ticker.html in Downloads
+   nba:    'tools/sports_ticker.html',       // moved to tools/ in commit b31533f
+   news:   'tools/cwn_combined_ticker.html', // moved to tools/ in commit b31533f
+   twitch: 'tools/cwn_twitch_ticker.html'    // moved to tools/ in commit b31533f
  };
```

### Change #5 — Cached ticker cleanup (shell commands, not code)

Before testing, delete the cached broken ticker so `captureTicker()` regenerates from the correct paths:

```bash
rm -f tmp/ticker_*.mp4
rm -rf tmp/ticker_frames_nba tmp/ticker_frames_news tmp/ticker_frames_twitch
```

### Change #6 — Cline's in-progress intro regex fix (already uncommitted)

You have an uncommitted diff in `server.js` that:
1. Hoists `outPath`/`outFile`/`totalDur` to outer scope (Gate 3 scoping fix)
2. Expands intro label regex from `/\(INTRO\)/i` to also match `/[_ ]INTRO$/i` format

**Ship these in the same commit.** Both are needed for the long-form pipeline to work end-to-end.

---

## Documentation updates (must land in same commit)

Per `COMMIT_CHECKLIST.md` rule #0, update every doc that references the changed positions:

### STATUS.md

**Line 29** — update the old Cline commit to reflect it's been reverted:
```diff
- | Cline | Fix TV card overlay position: OVERLAY_ZONE + 2 hardcoded FFmpeg overlays → x=40 (top-left, facing Bobby G) | `server.js` | `787f81f` | 2026-04-09 7:37 PM ET |
+ | Cline | Fix TV card overlay position: OVERLAY_ZONE + 2 hardcoded FFmpeg overlays → x=40 (top-left, facing Bobby G) — **SUPERSEDED by new Cline commit that reverts to x=1240 top-right after avatar swap on 2026-04-11** | `server.js` | `787f81f` | 2026-04-09 7:37 PM ET |
```

**Line 84** — flip the claim:
```diff
- - **TV card position:** All 3 overlay positions (OVERLAY_ZONE + 2 FFmpeg burns) → `x=40` top-left, facing Bobby G ✅
+ - **TV card position:** All 3 overlay positions (OVERLAY_ZONE + 2 FFmpeg burns) → `x=1240` top-right, facing Bobby G (who faces viewer's left after avatar swap 2026-04-11) ✅
```

**Lines 168-169** — long-form logo flipped to top-left:
```diff
- - **Long-form Logo:** 120px at `W-w-20:20` (top-right, 20px margins)
+ - **Long-form Logo:** 120px at `20:20` (top-LEFT, 20px margins) — flipped 2026-04-11 because TV card moved to top-right
  - **Short-form Logo:** 80px at `W-w-15:15` (top-right, 15px margins)
```

**Add new Last Agent Action row** for this commit.

### CLAUDE.md

**Lines 472-473** — update logo gotcha:
```diff
- 9. **Logo overlay now on ALL long-form videos** — 120px CWN logo, top-right at `W-w-20:20`, 85% opacity (see `server.js:3359-3383`)
+ 9. **Logo overlay on ALL long-form videos** — 120px CWN logo, top-LEFT at `20:20`, 85% opacity. Flipped from top-right to top-left on 2026-04-11 to make room for the TV card overlay which moved to top-right after the avatar swap (see `server.js:4037` and `CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md`).
  10. **Short-form videos need 80px logo** — smaller size for 9:16 format, top-right at `W-w-15:15`
```

### CLINE_HANDOFF_NBA_INTRO_CARD.md

**Lines 12-20** — flip the LAYOUT CHANGE section:
```diff
  ## CRITICAL LAYOUT CHANGE

  **All long-form videos (News, NBA, Twitch) now use the same layout:**
- - **Video card positioned LEFT of Bobby G** (not right)
+ - **Video card positioned RIGHT of Bobby G** — specifically at `x=1240, y=40, w=640, h=360` (top-right)
  - TV-shaped card (640×360 aspect ratio)
  - Content-specific display in the TV:
    - **News**: Article image from story
    - **NBA**: Game thumbnail + PPG leaders + W/L records
    - **Twitch**: Streamer profile pics (existing text moves underneath)

- This creates **visual consistency across all 3 content types** — TV on left facing Bobby G.
+ This creates **visual consistency across all 3 content types** — TV on right, facing Bobby G (who faces viewer's left in the new avatar).
```

**Line 135** — update layout ref:
```diff
- - Card displayed at `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` (left of Bobby G)
+ - Card displayed at `VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE` (right of Bobby G, top-right of frame)
```

**Line 142**:
```diff
- 4. During video assembly, overlay intro card LEFT of Bobby G at intro timing
+ 4. During video assembly, overlay intro card TOP-RIGHT of frame at intro timing (Bobby G faces that direction)
```

### CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md

This is currently untracked. Two choices:

**Option A (recommended):** Commit it alongside this handoff, but add a "CORRECTIONS" section at the top noting that:
1. My initial assumption that Bobby G should be full-bleed matching the reference was partially wrong — the reference Apr 4-7 videos ALSO had Bobby G roughly full-bleed, but the locked spec in `lib/config.js` has an OVERLAY_ZONE that should burn a TV card on top of the avatar composition, not coexist in pillarbox negative space
2. My recommendation to investigate `CFG.avatarId` localStorage override was correct but unnecessary — Rob chose a new avatar instead, bypassing the need to debug the old one
3. The HeyGen Avatar V pillarbox glitch is real (confirmed by Rob's community research) and the fix is to use a landscape-native avatar (this handoff)

**Option B:** Discard it since this handoff supersedes it. Downside: loses the full diagnostic trail for future debugging.

**Claude Code recommends Option A** — corrections take 30 seconds, the historical record is valuable.

### VISUAL_DESIGN_SPEC.md

**This doc is for SHORT-FORM only** (1080×1920). **Do NOT update** — the short-form layout isn't changing. Leave it alone.

### docs/Creative Requirements and Direction.txt

**Do NOT update** — this is a historical source-of-truth doc, not a current spec. Aider's chat history already shows the original `TOP_RIGHT {x: 1240, y: 40}` spec which matches where we're landing now.

### CLINE_HANDOFF_CLIP_MISMATCH_*.md (archived)

Already moved to `docs/archive/` in a previous commit. No changes needed.

---

## Test plan (after commit lands)

### Step 1 — Clean state

```bash
# Delete cached broken ticker
rm -f tmp/ticker_*.mp4
rm -rf tmp/ticker_frames_*

# Verify nodemon is running and picked up the changes
# (check terminal running "nodemon server.js" for restart message)
```

**Rob's manual step:** Clear localStorage override in browser DevTools (see Change #1 above).

### Step 2 — Minimal smoke test (1 scene, ~30 seconds total)

1. Open dashboard at http://localhost:8765/cwn_production.html
2. Generate a Twitch script with **1 streamer × 1 clip** (use Jason or another known-good streamer)
3. Click **SEND TO HEYGEN** — wait for the ~3 segments to render (cold open + streamer intro + clip setup + reaction + outro ≈ 5 scenes × 8-12s each)
4. Once all segments are green, click **⚙ ASSEMBLE**
5. Wait for assembly to finish (~2 min for a minimal case)

### Step 3 — Verify the output

```bash
# Find the most recent output MP4
LATEST=$(ls -t output/*.mp4 | head -1)
echo "Testing: $LATEST"

# Verify container specs
ffprobe -v error -show_entries stream=width,height,codec_name,r_frame_rate -of csv "$LATEST"
# Expected: video,h264,30/1,1920,1080
# ⚠️ If frame rate is 25/1, HeyGen is returning 25fps avatar segments — flag to Rob,
#    decide between frame duplication (Option A) or canvas fps drop (Option B)

# Extract a frame at t=2s (cold open scene, Bobby G visible)
mkdir -p tmp/verify
ffmpeg -y -ss 2 -i "$LATEST" -frames:v 1 -q:v 2 -update 1 tmp/verify/frame_cold_open.jpg 2>/dev/null

# Extract a frame at t=15s (streamer intro scene, intro card should be visible top-right)
ffmpeg -y -ss 15 -i "$LATEST" -frames:v 1 -q:v 2 -update 1 tmp/verify/frame_intro.jpg 2>/dev/null
```

### Step 4 — Visual check on extracted frames

Ask Claude Code (or Rob) to inspect `tmp/verify/frame_cold_open.jpg` and `tmp/verify/frame_intro.jpg` for:

**✅ PASS criteria:**
- [ ] No white pillarbox bars on sides — Bobby G fills the full 1920×1080 frame
- [ ] Ticker at bottom shows **real scrolling content** (stock prices, headlines, NOT "Error response")
- [ ] CWN gold logo visible **top-LEFT** at 20,20 (flipped from old top-right)
- [ ] In the streamer intro frame: streamer intro card visible **top-RIGHT** at ~x=1240, y=40 (640×360 card with gold border)
- [ ] Bobby G's face visible, not obscured by any overlay

**❌ FAIL modes:**
- Pillarbox still present → HeyGen is still using a portrait avatar. Check localStorage was actually cleared. Check the HeyGen video_id via `GET /jobs` and confirm which avatar was used.
- "Error response" still in ticker → cached files not deleted, or TICKER_MAP edit didn't take effect (nodemon restart?)
- Intro card on wrong side or missing → check `lte(t,${introDur})` enable condition, verify PNG was actually generated, check `intro_burned.mp4` in tmp/
- Logo on wrong side → `server.js:4037` edit didn't take effect, nodemon restart?
- Frame rate = 25 fps → HeyGen returning 25fps even though docs say 30. STOP. Flag to Rob. See Option A/B/C in conversation history.

### Step 5 — Full Test 1

If smoke test passes, run **Test 1 from `test/test_suite_12cases.json`** (Twitch Long-form A, 5 streamers × 3 clips = 37 scenes).

Pass criteria: Gate 1 ≥70, Gate 2 ≥65, Gate 3 ≥70, assembled MP4 visually clean, Drive upload succeeds, private publish to YouTube succeeds.

---

## Rollback plan

If the test fails catastrophically:

```bash
git revert HEAD           # reverts all 4 fixes atomically
# nodemon auto-restarts
# Rob re-sets localStorage to OLD avatarId (or whichever was working)
```

**Partial rollback options:**
- Ticker broken after fix → revert just `server.js:4586-4590` lines
- Overlay position wrong → revert just `lib/config.js:51` + `server.js:3500, 3650` lines
- Avatar wrong → revert just `cwn_production.html:1084, 858` + `.env`

---

## Atomic staging reminder

Per `COMMIT_CHECKLIST.md` "Atomic Staging" rule (added after the 2026-04-10 concurrent-commit incident):

**Use a single Bash tool call that chains everything:**

```bash
git status --short && \
git add \
  cwn_production.html \
  lib/config.js \
  server.js \
  .env \
  STATUS.md \
  CLAUDE.md \
  CLINE_HANDOFF_NBA_INTRO_CARD.md \
  CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md \
  CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md \
&& git commit -m "$(cat <<'EOF'
fix: avatar swap + overlay top-right + ticker path fix (unblocks 12-test suite)

Primary: Swap HeyGen avatar to 842f20b75ce242aea397f5030aa018aa — a landscape-
native 4K avatar. Fixes the Apr 10 pillarbox bug where the previous avatar
(HeyGen Avatar V photo avatar) rendered as portrait pillarboxed into the 16:9
canvas with white bars baked in. Verified via ffprobe of raw HeyGen segments.

Secondary: Flip OVERLAY_ZONE from {x:40, y:40} top-left to {x:1240, y:40}
top-right because the new avatar has Bobby G on the right facing viewer's
left. TV card must be on his facing side so he appears to look at it. This
reverts commit 787f81f's top-left flip, which was correct for the old avatar
but wrong for the new one. Aider's chat history shows top-right was the
original spec.

Tertiary: Fix TICKER_MAP paths in server.js:4586-4590. Commit b31533f
(2026-04-09) moved ticker HTMLs to tools/ but didn't update TICKER_MAP,
causing Puppeteer to screenshot the Python 404 "Error response" page and
bake it across every frame of the Apr 10 renders.

Also:
- Move long-form logo from top-right (W-w-20:20) to top-left (20:20) to
  avoid collision with the now-top-right OVERLAY_ZONE
- Update STATUS.md, CLAUDE.md, CLINE_HANDOFF_NBA_INTRO_CARD.md to reflect
  the flipped positions
- Commit CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md (Claude Code's full
  diagnostic trail) with corrections note at top
- Bundles Cline's in-progress intro regex fix (/\(INTRO\)/ → /[_ ]INTRO$/)
  and outPath/outFile/totalDur scoping fix

Rob manual step: clear localStorage CFG.avatarId override in dashboard
DevTools after commit lands (see CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md
Step 1 of test plan).

Test plan: minimal 1-scene smoke test → visual check for full-bleed avatar,
working ticker, top-left logo, top-right intro card → full Test 1 if smoke
passes.

Rollback: git revert HEAD reverts all 4 fixes atomically.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

## Questions for Rob (answer before shipping)

1. **Move logo to top-LEFT** as I've specified above? Or keep it top-right and shrink the overlay zone? My strong recommendation is top-left because it mirrors the design (logo opposite the TV card, like most news broadcasts).

2. **Commit the diagnosis doc** (`CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md`) alongside this handoff with a corrections note, or discard it? My recommendation: commit with corrections.

3. **Test with Jason** (has reliable clip data) or a different streamer for the smoke test? Your call.

4. **If frame rate comes back as 25 fps** in Step 3 ffprobe check, do we: (A) accept it and let FFmpeg auto-convert 25→30 via frame duplication, (B) drop CWN canvas to 25 fps, or (C) add minterpolate motion estimation? My recommendation: (A).

---

*Handoff written 2026-04-11 by Claude Code. Cline owns all server.js / html edits. Claude Code will not touch those files.*
