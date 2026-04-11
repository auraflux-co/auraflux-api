# Future 4K Migration Plan (parking doc)

**Author:** Claude Code
**Date:** 2026-04-11
**Status:** 🟡 PARKED — not scheduled, no work in progress. This doc captures the analysis and decision criteria so future agents don't re-litigate it.
**Trigger to revisit:** After 10+ long-form videos have shipped through the fixed pipeline and Rob can judge whether 1080p Bobby G is crisp enough for the "production value" bar.

---

## TL;DR

**Recommendation: stay at 1080p for now.** The new landscape avatar (`842f20b75ce242aea397f5030aa018aa`) renders natively at 3840×2160 inside HeyGen and downscales to CWN's 1920×1080 request — so CWN already benefits from **supersampled 1080p** without any pipeline changes. That captures ~80% of the 4K quality benefit at 0% of the pipeline cost.

**Only revisit 4K if:**
- Bobby G visual quality at 1080p is judged insufficient after 10+ production runs
- YouTube analytics show a meaningful share of viewers on 4K-capable devices (Smart TVs, 4K monitors)
- Competition in the AI-news space is producing 4K content and the quality gap becomes a differentiator
- Short-form platforms (TikTok, Reels) add 4K support (currently they don't)

---

## Background — why this came up

While diagnosing the Apr 10 pillarbox bug, Rob shared a sample of the new Bobby G avatar: `/Users/robertgregory/Downloads/testingo_2160p.mp4`. `ffprobe` shows:

```
codec: h264
width: 3840
height: 2160
frame rate: 25/1
duration: 18.7s
```

This is a 4K (3840×2160) native-landscape avatar. CWN currently targets 1920×1080 output via `dimension: {width: 1920, height: 1080}` in the HeyGen API call, so the 4K native render gets downscaled to 1080p by HeyGen's servers before being returned to CWN. That's the free lunch — HeyGen does good-quality downscaling with proper filters, so CWN receives cleaner 1080p than it would from a native-1080p avatar.

Rob asked whether it was worth moving the whole CWN pipeline to 4K to take full advantage of the new avatar.

---

## The quality reality

**What Rob noticed during the Apr 4-7 era:** Bobby G segments already looked visibly better than the Twitch source clips they were concatenated with. Twitch clips were the "softer" element; Bobby G was the "production value" element. This was an accepted / desirable pattern — the avatar carries the brand, the clips carry the content.

**If the CWN canvas moves to 4K:**
- Bobby G segments become 4K-native (crisper than even the current supersampled 1080p)
- Twitch clips stay 1080p max (Twitch CDN cap) and must either:
  - (a) Be upscaled 2× to fill the 4K canvas — looks soft, worse than keeping the source native
  - (b) Be framed inside the 4K canvas at their native 1080p with background padding — hard to make look intentional without a branded frame
  - (c) Be center-cropped and upscaled with a mild sharpen filter — best compromise, still softer than Bobby G
- NBA highlights similar — ESPN highlights are typically 720p-1080p source
- News article images are typically much lower res and completely unsuitable for 4K

**The quality gap between Bobby G and clips would widen**, not narrow. Whether that's good or bad depends on whether viewers perceive it as "premium avatar" (good) or "jarring quality switch" (bad).

---

## Pipeline impact matrix

| Area | Current (1080p) | 4K target | Cost |
|---|---|---|---|
| **Canvas dimensions** | 1920×1080 | 3840×2160 | Edit `lib/config.js` `LONG_FORM.WIDTH/HEIGHT` |
| **OVERLAY_ZONE** | `{x:1240, y:40, w:640, h:360}` | `{x:2480, y:80, w:1280, h:720}` (2× scale) | Edit `lib/config.js`, edit every FFmpeg `overlay=x=1240:y=40` in `server.js` |
| **LOGO_POS** | `{x:20, y:20, size:120}` | `{x:40, y:40, size:240}` | Edit `lib/config.js`, edit FFmpeg `overlay=20:20` to `overlay=40:40` |
| **Ticker bar** | 1920×64px | 3840×128px | Edit `CONFIG.TICKER.WIDTH/HEIGHT`, update Puppeteer viewport, update ticker HTML CSS, update FFmpeg overlay `y=H-64` to `y=H-128`, bust ticker cache |
| **Intro card PNG** | 720×840 Canvas render | 1440×1680 | Edit `CONFIG.INTRO_CARD.CANVAS_WIDTH/HEIGHT`, update circle radius + font sizes proportionally, verify profile image source is high-res enough |
| **HeyGen API payload** | `dimension: {width: 1920, height: 1080}` | `dimension: {width: 3840, height: 2160}` | One-line edit in `cwn_production.html:1270` |
| **HeyGen render time** | ~10s avg | ~20-30s avg (4× pixels, scales sublinearly but not free) | Each 40-segment job takes 10-15 min longer |
| **HeyGen cost per segment** | ~$0.038 | Likely 2-3× per HeyGen pricing tiers — unconfirmed | **Must verify in HeyGen pricing before committing** |
| **FFmpeg assembly** | Single re-encode at 1080p libx264 crf 18 | Same codec, 4× pixels → 3-4× slower encode | ~5 min assembly → ~15-20 min |
| **Twitch source clips** | 1080p native, full-bleed at 1920×1080 | Must decide: upscale (soft), letterbox (ugly), or frame inside 4K canvas | Design decision, not a code change |
| **NBA clips** | 720p-1080p native | Same dilemma as Twitch | Design decision |
| **News images** | Open Graph scraper returns ~400-800px | Inadequate for 4K, need fallback | New feature required |
| **Disk space per long-form** | ~500 MB | ~2 GB | 4× `output/` storage |
| **Drive upload time** | ~30-60s | ~2-4 min | 4× upload cost |
| **Short-form** | 1080×1920 | **Not changing** — TikTok/IG Reels cap at 1080p | No change |
| **YouTube long-form** | 1080p H.264 | 4K H.264 or H.265 | Only platform that benefits |
| **TikTok / IG Reels** | 1080×1920 | No benefit — platforms downscale on upload | No change |
| **Gate 2 sampling** | 3 segments × ~1.5 MB each = ~4.5 MB (fits Gemini 34 MB limit) | 3 segments × ~6 MB = ~18 MB (still fits) | ✅ OK |
| **Gate 5 full-video QA** | ~500 MB total, exceeds Gemini 34 MB cap — requires chunking | 2 GB total, exceeds even further — chunking strategy must handle this | Gate 5 implementation needs 4K-aware chunking from day one |
| **Metrics tracking** | `StageTimer` records per-stage wall time | Same, but numbers will roughly 4× | No code change |
| **Pre-flight disk check** | `CONFIG.ASSEMBLY.ESTIMATED_SIZE_PER_SEGMENT_MB = 20` | Should be ~80 in 4K mode | Edit config |
| **Gate 3 pacing rules** | 7-second rule unchanged | Unchanged | No code change |
| **Thumbnail generation** | 1280×720 via FFmpeg frame extract | 3840×2160 source → downscale to YouTube-standard 1280×720 for upload | **Actually improves** — sharper thumbnails from higher-res source frames |

---

## The real blocker: HeyGen pricing at 4K

I couldn't find HeyGen's 4K pricing during the earlier web research phase. The standard Studio Avatar rate is ~$0.038/segment at 1080p per CWN's current cost model. 4K may be:

- **Same price** (unlikely — 4× more compute on their side)
- **~2× price** (typical for video APIs moving up one resolution tier)
- **~4× price** (full compute cost passthrough)
- **Pro / Enterprise plan only** — possible HeyGen gates 4K to higher subscription tiers

**Action before any 4K work:** Rob must confirm the actual HeyGen cost with a single test render at `dimension: {width: 3840, height: 2160}`. If it's >$0.10/segment, the monthly cost model in `CLAUDE.md` (~$381/mo at current volume) could balloon to $800-$1500/mo.

---

## Migration path (if we eventually do it)

**Prerequisites:**
1. Verify HeyGen 4K pricing with a test render
2. Verify HeyGen 4K render time isn't prohibitively long per segment
3. Decide on Twitch/NBA clip treatment in 4K canvas (upscale, frame, or letterbox)
4. Decide whether to migrate short-form at the same time (answer is probably NO — short-form stays 1080p because platforms don't support 4K)

**Phase 1 — Config swap (half day)**
- Clone `VISUAL_LAYOUTS.LONG_FORM` to `VISUAL_LAYOUTS.LONG_FORM_4K` with doubled coordinates
- Add a `VISUAL_LAYOUTS_MODE` env var or dashboard toggle to switch between them
- Keep both code paths functional so rollback is trivial

**Phase 2 — FFmpeg filter updates (1 day)**
- Every `overlay=x=N:y=N` string in `server.js` needs to either read from `CONFIG.VISUAL_LAYOUTS[mode].OVERLAY_ZONE` OR have a mode-aware version
- Ticker Puppeteer capture needs to render at 3840×128 instead of 1920×64
- Ticker CSS may need adjustment for larger font sizes to remain readable (64px original font → 128px)
- Logo asset: verify `assets/cwn_logo.png` is high-res enough to scale to 240px without artifacts; if not, regenerate at 400px+ source size

**Phase 3 — Source clip treatment (1-2 days, design-heavy)**
- This is where the work gets ugly. Need to decide:
  - **Option A:** Upscale all source clips to 4K via FFmpeg `scale` filter with lanczos — simplest, softest result
  - **Option B:** Keep source clips at 1080p and center them in the 4K canvas with a branded background frame (gold border, CWN-branded bars, etc.) — most work, cleanest look
  - **Option C:** Use AI upscaling (Topaz Labs API is already in `.env` as `TOPAZLABS_API_KEY`) — potentially best quality, adds cost + latency per clip
- Test all three with a sample Twitch clip, pick the best visual result

**Phase 4 — Intro card re-rendering (half day)**
- Node Canvas intro card generator (`server.js` near the canvas code) needs to render at 2× canvas size, 2× font sizes, 2× circle radius
- Verify profile image sources are high enough res to look good at 4K scale — Twitch profile images are typically 300-600px max, may need fallback
- NBA/News TV card Puppeteer captures need larger viewports

**Phase 5 — Gate 5 chunking strategy (1-2 days)**
- 4K long-form videos will be ~2 GB — far above Gemini's 34 MB upload cap
- Need to either:
  - (a) Split the video into N chunks via FFmpeg segment, upload each to Gemini separately, score each, aggregate
  - (b) Extract key frames at ~1-per-second, send as a batch image upload
  - (c) Use Gemini Files API (if it supports larger uploads)
- This is the biggest unknown because Gate 5 doesn't exist yet at 1080p either

**Phase 6 — Test + rollout (1-2 days)**
- Run all 12 test cases at 4K
- Compare against 1080p baseline for quality delta
- Measure assembly time + cost delta
- Decide whether the delta justifies the cost
- If yes, flip `VISUAL_LAYOUTS_MODE` default to 4K
- If no, revert, keep 1080p

**Total effort: ~1 week of focused work, assuming HeyGen pricing is acceptable.**

---

## Rollback considerations

Because 4K would be additive via a mode flag (not a hard replacement), rollback is just flipping `VISUAL_LAYOUTS_MODE` back to `LONG_FORM`. Keep BOTH code paths working so A/B comparison is easy and reverts are instant.

---

## Decision criteria — when to actually do this

Only do the 4K migration if ALL of these are true:

- [ ] CWN has shipped 10+ clean 1080p long-form videos through the Gate 5 pipeline
- [ ] Rob has judged 1080p Bobby G quality as "good but not great enough for the brand"
- [ ] YouTube analytics show >20% of long-form views on 4K-capable devices OR subscriber count hits a milestone that justifies premium production
- [ ] HeyGen 4K pricing has been verified and is <2× current cost
- [ ] Cline + Claude Code + Aider have bandwidth for a week of work not blocked by other priorities
- [ ] Gate 5 video QA (Gemini) is already working at 1080p — don't stack 4K migration on top of an unfinished Gate 5 implementation

If any of these is false, stay at 1080p.

---

## What CWN should do RIGHT NOW (2026-04-11)

**Nothing 4K-related.** Ship the avatar/overlay/ticker fixes from `CLINE_HANDOFF_AVATAR_AND_TICKER_FIX.md`, run Test 1, evaluate Bobby G visual quality. The new 4K-native avatar rendering to supersampled 1080p will likely look noticeably better than the Apr 4-7 reference because it's the same avatar aesthetic with a higher-quality downscale.

**Revisit this doc in ~2 weeks** after the 12-test suite has run end-to-end at 1080p and production metrics are stable. At that point Rob can make an informed decision about whether 4K is worth pursuing.

---

## Related files

- `lib/config.js:46-62` — `VISUAL_LAYOUTS` constant (where 4K coordinates would be added)
- `cwn_production.html:1270` — HeyGen API payload `dimension` field
- `server.js:3361, 3500, 3650, 4037` — FFmpeg overlay coordinates (must be config-driven in a 4K migration)
- `server.js:4559-4650` — Ticker capture via Puppeteer (needs viewport update for 4K)
- `CLAUDE.md` — Cost model (~$381/mo) — would need updating post-migration
- `QA_GATES.md` — Gate 5 spec (not yet implemented, must be 4K-aware if built after migration)

---

*Parked 2026-04-11 by Claude Code. Do not implement without explicit go-ahead from Rob after the 12-test suite is stable at 1080p.*
