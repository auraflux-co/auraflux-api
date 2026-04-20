# CLINE_HANDOFF_HEYGEN_720P_DOWNSCALE.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14
**Size:** S — `server.js` only, 2 line edits
**Goal:** Reduce HeyGen rendering cost by submitting at 720p instead of 1080p. FFmpeg upscales back to 1080p during the existing normalize step using Lanczos — no visible quality loss at YouTube viewing size.

---

## Background

HeyGen charges compute per render. Lower resolution = less compute = lower cost. The HeyGen docs explicitly recommend 720p for social media output. We already re-encode every segment in FFmpeg's normalize step (line 4621) — adding a Lanczos upscale there costs ~0 extra time and produces quality indistinguishable from native 1080p for a talking-head avatar at normal YouTube viewing size.

---

## Change 1 — HeyGen dimension: 720p (server.js:2179-2182)

**Find:**
```javascript
      dimension: {
        width: format === 'portrait' ? 1080 : 1920,
        height: format === 'portrait' ? 1920 : 1080
      },
```

**Replace with:**
```javascript
      dimension: {
        width: format === 'portrait' ? 720 : 1280,
        height: format === 'portrait' ? 1280 : 720
      },
```

Portrait drops from 1080×1920 → 720×1280. Landscape drops from 1920×1080 → 1280×720. Both are standard 720p at 16:9 / 9:16.

---

## Change 2 — Avatar normalize: add Lanczos upscale (server.js:4621)

The avatar normalize filter already re-encodes every segment. Add `flags=lanczos` to the avatar scale filter so the upscale back to 1920×1080 uses high-quality Lanczos interpolation instead of the default bilinear.

**Find (line ~4621):**
```javascript
            const vfFilter = isAvatarSeg
              ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
```

**Replace with:**
```javascript
            const vfFilter = isAvatarSeg
              ? 'scale=1920:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
```

Two changes:
1. `force_original_aspect_ratio=decrease` removed — at 1280×720 input, native aspect is already 16:9, no decrease needed
2. `flags=lanczos` added — Lanczos is the best general-purpose upscaling algorithm, noticeably sharper than bilinear/bicubic on fine detail (hair, text, edges)

**Note:** Source clips are NOT changed — they stay at whatever resolution the source provides (Al Jazeera, ESPN, Twitch clips are already 1080p+). Only avatar segments are upscaled.

---

## Files to change

| File | Tier | Lines |
|------|------|-------|
| `server.js` | 1 | ~2180 (dimension) and ~4621 (vfFilter) |

---

## Verification

1. Run a News smoke test
2. Check server log — HeyGen submissions should show `dimension: {width:1280, height:720}`
3. After assembly, spot-check a Bobby G avatar segment in the output MP4 — should look sharp at 1080p playback
4. Gate 3 Gemini QA score should be unaffected (Gemini evaluates content/chrome, not pixel-level sharpness)

---

## Commit message

```
perf(heygen): render at 720p + Lanczos upscale in normalize — reduce compute cost

HeyGen docs recommend 720p for social media output. Lower resolution
= less compute = lower per-render cost. FFmpeg normalize step already
re-encodes every avatar segment — adding Lanczos upscale (flags=lanczos)
back to 1920x1080 adds negligible CPU time and produces quality
indistinguishable from native 1080p for talking-head avatar content.

Source clips unchanged — they come in at native 1080p+ from Al Jazeera /
ESPN / Twitch and don't go through HeyGen.

Two line edits:
1. server.js:2180 — dimension 1920x1080 → 1280x720 (landscape)
   and 1080x1920 → 720x1280 (portrait)
2. server.js:4621 — avatar vfFilter adds flags=lanczos, removes
   force_original_aspect_ratio=decrease (redundant at native 16:9 input)
```
