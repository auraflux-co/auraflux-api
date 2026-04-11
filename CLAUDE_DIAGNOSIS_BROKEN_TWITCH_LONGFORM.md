# Diagnosis: Broken Twitch Long-Form (Friday April 10)

**Author:** Claude Code
**Date:** 2026-04-10 ~11:15 PM ET
**MP4 inspected:** `output/twitch_friday_april_10_2026_42_avatar_16_clips__1775875676700.mp4`
**Job ID:** `script_twitch_1775866928172`
**Status:** 🔍 Diagnosis-only, no code changes written. Cline owns `server.js` edits.

---

## ⚠️ CORRECTIONS — added 2026-04-11 after further investigation

After writing this doc, additional investigation and a conversation with Rob revealed:

1. **The "avatar should be full-bleed" assumption in this doc was correct-ish, but incomplete.** Apr 4-7 reference videos showed Bobby G rendered full-bleed 1920×1080 (confirmed by ffprobe + frame extraction across 5 reference MP4s). That matches the "full-bleed" expectation. BUT `lib/config.js:51` has always defined an `OVERLAY_ZONE` that's supposed to burn a TV card on top of the avatar composition — the reference videos just didn't have that card rendering due to the separate intro regex bug Cline has been fixing. So "full-bleed avatar" + "TV card burned on top" are both true simultaneously — they're not mutually exclusive as this doc initially implied.

2. **The investigation steps I recommended (check localStorage, test with a fresh avatar) were partially bypassed.** Rob picked a new landscape-native avatar (`842f20b75ce242aea397f5030aa018aa`, 4K native) rather than debugging the old one. This shortcuts the root-cause analysis but ships the fix faster.

3. **The HeyGen Avatar V pillarbox glitch is real and community-confirmed.** Rob's HeyGen community research corroborated that "white borders on HeyGen landscape videos often occur when the selected avatar... does not perfectly match the 16:9 aspect ratio" — which matches the diagnosis here. The fix is a landscape-native avatar, not a code change.

4. **OVERLAY_ZONE moves from top-left to top-right in the new spec.** This doc's earlier reference to Cline's commit `787f81f` (which flipped overlays to top-left `x=40`) is now being REVERTED because the new avatar has Bobby G facing viewer's left, so the TV card must be on viewer's right for him to face it. The original Aider-era spec was `{x: 1240, y: 40}` top-right, which is what we're returning to. Logo moves from top-right to top-left to avoid collision with the now-top-right overlay.

5. **The "there are no source clips in the reference video" observation was partially misleading.** I sampled 19 frames across 5 reference videos from Apr 4-7 and found source clips in Apr 4 and Apr 5 (streamers on basketball courts, Twitch Creator Dashboards, etc.) — but the Apr 7 `test_1_twitch_compilation_*` reference Rob initially pointed at DID appear clip-less across my samples. That one specific reference may have been an avatar-only test render, not a representative production sample.

**Authoritative fix plan as of 2026-04-11:** see `CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md` for the exact diffs Cline will implement. This diagnosis doc is preserved as the historical record of the root-cause investigation.

**Future 4K consideration:** see `FUTURE_4K_MIGRATION_PLAN.md` for analysis of whether to eventually migrate the CWN canvas from 1080p to 4K. Current recommendation: stay at 1080p, benefit from HeyGen's native 4K avatar downsampling to supersampled 1080p. Revisit after 10+ production runs.

---

## TL;DR

The broken MP4 has **three independent bugs**, in order of severity:

1. 🔴 **HeyGen is rendering Bobby G as a portrait figure pillarboxed into a 1920×1080 canvas with white bars baked in.** This is a **HeyGen-side rendering issue**, not a CWN assembly bug. The white borders you see on the final MP4 are already present in the raw HeyGen segment download. The `45f8980` zoom-to-fill crop fix addresses source clips only and does nothing for the avatar segments.
2. 🔴 **The ticker shows literal "Error response" text baked across the entire video.** The three ticker HTML files (`cwn_twitch_ticker.html`, `cwn_combined_ticker.html`, `sports_ticker.html`) are located in `tools/` but `TICKER_MAP` at `server.js:4586-4590` looks for them at repo root. The 404 from the static server renders Python's default error page, Puppeteer screenshots it, and "Error response" gets baked into every frame.
3. 🟡 **Intro cards never rendered** for any of the 8 streamers. The intro-detection regex in `server.js:3447` only matched `"JASON (INTRO)"` format, but scenes are labeled `"JASON_INTRO"` (underscore format from the `93aa22f` normalization fix). **Cline is already fixing this** in the current uncommitted `server.js` diff.

---

## Evidence

### Frame-by-frame inspection

Five frames extracted from the broken MP4 at t = 2s, 60s, 180s, 400s, 825s (saved under `tmp/diagnosis/frame_*.jpg` — not committed to repo):

| Timestamp | Content | Layout | Intro card | Ticker |
|---|---|---|---|---|
| 2s | Avatar (cold open) | Portrait 610×1080 in 1920×1080 canvas, white pillarbox each side | — | ❌ "Error response" |
| 60s | Avatar (streamer intro scene) | Portrait pillarboxed | ❌ **Not visible** | ❌ "Error response" |
| 180s | Source clip (Twitch) | Full 16:9 ✅ | — | ❌ "Error response" |
| 400s | Source clip (Twitch) | Full 16:9 ✅ | — | ❌ "Error response" |
| 825s | Avatar (outro) | Portrait pillarboxed | — | ❌ "Error response" |

**Source clips render correctly** (full 16:9). The problem is isolated to avatar segments and the ticker overlay.

### HeyGen raw segment verification

Queried `GET https://api.heygen.com/v1/video_status.get?video_id=49f59bf8056649d0ab61d56b8b09d62d` (the INTRO scene). Downloaded the raw HeyGen output and ran `ffprobe`:

```json
{ "streams": [{ "codec_name": "h264", "width": 1920, "height": 1080 }, { "codec_name": "aac" }] }
```

**The HeyGen segment is nominally 1920×1080**, BUT when you extract a frame, Bobby G is rendered as a portrait figure (~610px wide) centered in the 1920×1080 canvas with **white pixel padding baked into the image**. Frame saved at `tmp/diagnosis/heygen_intro_frame.jpg`.

**Conclusion:** HeyGen is generating the pillarbox itself. CWN assembly is innocent here.

### Avatar ID investigation

Dashboard config:
- `cwn_production.html:1084` — `CFG.avatarId = '19c1d4adf8904694a3cc331c5a9bee4b'` (hardcoded default)
- Settings UI `cfg-avatar-id` input field also defaults to the same value

`.env`:
- `HEYGEN_AVATAR_ID=1a5d4e9130d2467fa01d9e1580aff829` (a DIFFERENT avatar ID)
- `HEYGEN_AVATAR_SHORT_ID=ed57439c9c3d4a398f3b247b75714b13`

**Note:** The frontend does NOT read `.env` — it uses `CFG.avatarId` from localStorage/defaults. So the `.env` HEYGEN_AVATAR_ID is never actually used by the dashboard when sending to HeyGen. Either:

- (a) The Settings UI was changed in localStorage to a portrait avatar ID without updating the hardcoded default, OR
- (b) The avatar `19c1d4adf8904694a3cc331c5a9bee4b` on HeyGen's side has been replaced/updated such that it now renders as a portrait (Avatar V update?), OR
- (c) HeyGen's newer avatars ignore the `dimension` field in the v2 API payload and use the avatar's native aspect ratio

**I cannot determine which of (a)/(b)/(c) is true without either checking the live dashboard localStorage OR calling HeyGen with a known-good landscape avatar to compare.**

The HeyGen v2 `/avatars` list endpoint returned 1281 avatars, but none of the three IDs (env, CFG default, CFG short) matched — these are likely **Instant Avatars** or Avatar IV/V uploads living in a different API namespace. Worth checking `/v2/photo_avatar/list` or HeyGen's web console directly.

### Isolated scene-label check

Job card `data/jobs.json` shows scenes labeled:
```
"INTRO", "JASON_INTRO", "JASON_CLIP1_SETUP", "JASON_CLIP1_REACTION",
"HASAN_INTRO", "HASAN_CLIP1_SETUP", ... "EXTRAEMILY_INTRO", ...
```

Cline's in-progress `server.js` diff fixes this at line 3447 — expanding the intro regex from `/\(INTRO\)/i` to also match `/[_ ]INTRO$/i`. This will cause intro cards to render on the next assembly run.

### Ticker file paths

`server.js:4586-4590`:
```js
const TICKER_MAP = {
  nba:    'sports_ticker.html',       // sports_ticker.html in Downloads
  news:   'cwn_combined_ticker.html', // cwn_combined_ticker.html in Downloads
  twitch: 'cwn_twitch_ticker.html'    // cwn_twitch_ticker.html in Downloads
};
```

Used to build URL: `http://localhost:8765/${tickerFile}` (server.js:4620)

Actual file locations:
```
tools/cwn_twitch_ticker.html
tools/cwn_combined_ticker.html
tools/sports_ticker.html
tools/cwn_news_ticker.html          ← also exists, not in TICKER_MAP
tools/market_ticker.html            ← also exists, not in TICKER_MAP
tools/clipzworld_ticker_auto.html   ← also exists, not in TICKER_MAP
```

The Python `http.server` running on port 8765 serves from repo root. When it tries to GET `cwn_twitch_ticker.html`, it returns HTTP 404 with Python's default error page:

```
<head><title>Error response</title></head>
<body>...
```

Puppeteer screenshots that page, ffmpeg stitches the screenshots into `tmp/ticker_twitch.mp4`, and assembly overlays the broken ticker at `y=H-64` for the whole video duration.

**Cached broken result:** `tmp/ticker_twitch.mp4` (1-hour TTL per `TICKER_CACHE_TTL`). Should be deleted before next assembly so the cache doesn't serve the broken version again.

---

## Fix plan (proposed, awaiting Cline/Rob approval)

### Fix #1 — HeyGen avatar pillarbox (primary issue)

**Owner:** Rob + Cline (needs investigation first, not a pure code fix)

Three possible paths to investigate in order:

1. **Check dashboard localStorage for `CFG.avatarId` override.** Open DevTools → Application → Local Storage → `http://localhost:8765` → look for `cwn_config` or similar key. If it has a portrait avatar ID, the fix is to reset it to a known-good landscape avatar. Zero code changes needed.

2. **Test with a fresh avatar ID.** Open HeyGen web console → create or identify a confirmed 16:9 landscape avatar → copy its ID into the dashboard Settings UI → send a minimal test script (1 scene, 5 seconds) → download the raw HeyGen result → verify it's truly landscape without pillarbox. If yes, update `cwn_production.html:1084` hardcoded default AND the `.env` `HEYGEN_AVATAR_ID` to match.

3. **If all HeyGen avatars now render with pillarbox** (Avatar V behavior change), then CWN assembly needs a new step: **zoom-to-fill crop the avatar segments** the same way source clips are cropped by `45f8980`. This would add an FFmpeg filter: `scale=-1:1080:flags=lanczos,crop=1920:1080` or similar — scale up to fill the height, then crop the centered region to 1920 wide. Downside: Bobby G's head may get cropped; needs visual verification.

**Recommended test order:** (1) → (2) → (3). Stop at whichever one fixes it.

### Fix #2 — Ticker file paths

**Owner:** Cline (single file, trivial)

Change `server.js:4586-4590`:

```js
const TICKER_MAP = {
  nba:    'tools/sports_ticker.html',
  news:   'tools/cwn_combined_ticker.html',
  twitch: 'tools/cwn_twitch_ticker.html'
};
```

Also delete the cached broken ticker before next assembly:

```bash
rm -f tmp/ticker_twitch.mp4 tmp/ticker_nba.mp4 tmp/ticker_news.mp4
rm -rf tmp/ticker_frames_twitch tmp/ticker_frames_nba tmp/ticker_frames_news
```

**Optional:** verify the three HTML files in `tools/` actually render correctly by visiting each in a browser at `http://localhost:8765/tools/cwn_twitch_ticker.html` etc. If any of them throw JS errors or fail to load market data, that's a separate bug to flag.

### Fix #3 — Intro card regex

**Owner:** Cline (already in progress, uncommitted)

Cline's current `server.js` diff already handles this. Ship it.

### Fix #4 — Variable scoping for outPath/outFile/totalDur

**Owner:** Cline (already in progress, uncommitted)

Cline's current `server.js` diff already handles this. Ship it.

---

## Test cases blocked by these bugs

From `test/test_suite_12cases.json`, the following cases will fail visual QA until Fix #1 and Fix #2 land:

**Long-form (all 6 will have pillarbox + broken ticker):**
- Test 1 — Twitch Long-form A (Jason/Hasan/Adapt/Ron/Lacy)
- Test 2 — Twitch Long-form B (Marlon/Cinna/Yonna/Jay Cinco/Emily)
- Test 3 — NBA Long-form A
- Test 4 — NBA Long-form B
- Test 5 — News Long-form A
- Test 6 — News Long-form B

**Short-form (all 6 likely unaffected by #1 since portrait avatar is the correct ID for shorts, and #2 is skipped for shorts per server.js:3934 `!isShort`):**
- Test 7–12 — Short-form cases should be usable as-is, worth spot-checking one of each content type

**Recommendation:** after fixes land, re-run Test 1 first (smallest Twitch case, 5 streamers × 3 clips, ~37 scenes). If it passes Gate 3 and the MP4 looks clean, run Tests 2–6 in parallel.

---

## Gate 3 (Gemini assembly QA) was not triggered

Important: the broken MP4 **was assembled and saved to disk**, which means Gate 3 (Gemini Assembly QA) either:
- (a) Ran and incorrectly passed a video with pillarboxed avatar + broken ticker (meaning Gate 3 needs prompt improvement)
- (b) Didn't run at all because of the scoping bug (totalDur undefined → exception in Gate 3 invocation)
- (c) Ran, failed, but the failure wasn't surfaced to the UI loudly enough

Option (b) is likely given Cline's in-progress scoping fix. After the scoping fix lands, Gate 3 should start triggering properly on long-form assemblies. **Gate 3 also needs to be trained to catch pillarboxed avatars as a failure signal** — currently it may not have "white bars on sides of avatar" in its failure criteria. Recommend adding that to the Gate 3 prompt after the primary fixes land.

See `CLAUDE.md` → QA Gates section and `server.js` Gate 3 prompt for the relevant code paths.

---

## Files touched during this diagnosis

**Read (no edits):**
- `output/twitch_friday_april_10_2026_42_avatar_16_clips__1775875676700.mp4`
- `data/jobs.json`
- `server.js` (specific ranges: 3192-4175, 4559-4660)
- `cwn_production.html` (ranges around 1080-1270, 2245-2256, 3387-3460)
- `test/test_suite_12cases.json`
- `VISUAL_DESIGN_SPEC.md` (short-form only, turns out)
- `.env` (HEYGEN_* keys)

**Wrote (docs-only, untracked):**
- `CLAUDE_DIAGNOSIS_BROKEN_TWITCH_LONGFORM.md` (this file)

**Extracted to tmp/ (not committed, will auto-clean in 24h):**
- `tmp/diagnosis/frame_intro_2s.jpg`
- `tmp/diagnosis/frame_clip1_60s.jpg`
- `tmp/diagnosis/frame_clip3_180s.jpg`
- `tmp/diagnosis/frame_mid_400s.jpg`
- `tmp/diagnosis/frame_outro_825s.jpg`
- `tmp/diagnosis/heygen_intro.mp4` (raw HeyGen segment download)
- `tmp/diagnosis/heygen_intro_frame.jpg` (raw HeyGen frame)

**Did NOT touch:**
- `server.js` (Cline actively editing)
- `cwn_production.html` (Cline's territory)
- Any production data

---

## Open questions for Rob

1. **Is the avatar pillarbox a known HeyGen Avatar V behavior, or did something change recently?** If you've seen a clean landscape Bobby G render in the last week, the avatar ID recently broke. If you haven't seen a clean render since Avatar V upgrade, this is structural.
2. **Do you want me to run the Fix #1 investigation steps (localStorage check, fresh avatar test)** or coordinate with Cline to do them?
3. **After fixes land, do you want me to build the 12-test automation harness** (STATUS.md Tech Debt #4) so we can run all 12 cases end-to-end without manual dashboard clicking, or is that a separate ask?
4. **Should Gate 3 be taught to fail on "pillarboxed avatar" explicitly**, or is that over-engineering since Fix #1 should eliminate the condition entirely?

---

*End of diagnosis.*
