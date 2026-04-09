# CWN Visual Design Spec — Short-Form Infrastructure
**Version**: 1.0  
**Date**: 2026-04-09  
**Owner**: Cline (Implementation) / Rob (Creative Approval)  
**Status**: ✅ LOCKED — Phase 2 implementation reference

---

## 1. Short-Form Canvas

| Property | Value |
|----------|-------|
| Resolution | 1080 × 1920 (9:16 portrait) |
| Frame rate | 30 fps |
| Target duration | 45–90 seconds |
| Output format | MP4 (H.264, AAC) |
| Color space | yuv420p |

---

## 2. Split-Screen Layout

```
┌─────────────────────────────┐  ← y=0
│                             │
│   SOURCE CLIP (1080×960)    │  ← Top 50%
│   Scaled + center-cropped   │
│   No audio                  │
│                             │
├─────────────────────────────┤  ← y=960
│                             │
│   BOBBY G AVATAR (1080×960) │  ← Bottom 50%
│   HeyGen short-form avatar  │
│   Audio: avatar voice only  │
│                             │
└─────────────────────────────┘  ← y=1920
```

### Zone Definitions (CONFIG.VISUAL_LAYOUTS.SHORT_FORM)
| Zone | x | y | w | h |
|------|---|---|---|---|
| CLIP_ZONE (top) | 0 | 0 | 1080 | 960 |
| AVATAR_ZONE (bottom) | 0 | 960 | 1080 | 960 |
| BURN_IN_ZONE (center divider) | 540 | 960 | — | — |
| LOGO_POS (top-right) | 985 | 15 | — | 80px |

---

## 3. Logo Bug

| Property | Value |
|----------|-------|
| Asset | `assets/cwn_logo.png` |
| Size | 80px wide (height auto) |
| Position | Top-right: `x = W - w - 15`, `y = 15` |
| Opacity | 85% (`format=auto` in FFmpeg overlay) |
| Placement | Applied AFTER vertical stack, before output |

---

## 4. Audio Rules

| Layer | Audio |
|-------|-------|
| Top half (source clip) | **Muted** (`-an`) |
| Bottom half (avatar) | **Full volume** (avatar voice) |
| Output | Avatar audio only |

---

## 5. Portrait Thumbnail

| Property | Value |
|----------|-------|
| Resolution | 1080 × 1920 |
| Source | Assembled short-form MP4 |
| Frame selection | Highest-motion frame (ffprobe scene score) |
| Fallback | Frame at 30% of total duration |
| Tagline overlay | `"BECAUSE THE LIGHT WAS ON"` |
| Tagline font | Bebas Neue, 72px, white, centered |
| Tagline position | y = 1680 (bottom 12.5%) |
| Episode overlay | `EP {N}` — top-left, 36px, gold (#c7af4f) |
| Output filename | `thumbnail_short_{type}_ep{N}_{timestamp}.png` |
| Output dir | `./output/` |

---

## 6. TikTok / Reels Safety Zones

### TikTok Safe Zone
```
┌─────────────────────────────┐
│  ✅ SAFE CONTENT AREA       │
│                             │
│                             │
│                             │
│                             │
│                             │
│                             │
│                    ┌────────┤ ← x=880, y=1520
│                    │ ❌ UI  │   200×400px
│                    │ ZONE  │   (like/share/comment)
└────────────────────┴────────┘
```

| Platform | Avoid Zone | x | y | w | h |
|----------|-----------|---|---|---|---|
| TikTok | Like/Share/Comment buttons | 880 | 1520 | 200 | 400 |
| Instagram Reels | Caption area | 0 | 1770 | 1080 | 150 |

### Validation Rule
- Bobby G avatar face is in AVATAR_ZONE (y=960–1920)
- Avatar face center estimated at: `x=540, y=1200` (center of bottom half)
- TikTok overlap check: face at (540, 1200) does NOT overlap (880–1080, 1520–1920) ✅ SAFE
- Reels overlap check: face at (540, 1200) does NOT overlap (0–1080, 1770–1920) ✅ SAFE
- Log warning if any avatar content detected in UI zones

---

## 7. CapCut Integration Flow

```
Dashboard "SEND TO CAPCUT" button
    ↓
POST /capcut/init  { jobId, format: 'portrait' }
    ↓ returns draftId
POST /capcut/add-segment (avatar segments, in order)
POST /capcut/add-segment (source clips, in order)
    ↓
POST /capcut/ticker  { jobId, tickerText }
POST /capcut/logo    { jobId }
    ↓
POST /capcut/finalize  { jobId }
    ↓ returns draftUrl
Open CapCut → File → Open Project → Export
```

### CapCut Server
- URL: `http://localhost:9001` (env: `CAPCUT_URL`)
- Python server: `VectCutAPI/capcut_server.py`
- Start: `cd VectCutAPI && python capcut_server.py`

---

## 8. Intro/Outro Behavior (Short-Form)

| Segment | Duration | Content |
|---------|----------|---------|
| Cold open | 5–8s | "ClipzWorld News. [beat] [Content type]. [beat] Let's go." |
| Main content | 30–60s | Avatar reaction + source clip (split-screen) |
| Outro | 5–8s | "Subscribe. ClipzWorld News. Good night." |

**No transition effects** between segments in short-form — hard cuts only.  
**No ticker** in short-form — too small to read on mobile.

---

## 9. Divider Line (Optional Enhancement)

A 2px gold (#c7af4f) horizontal line at y=960 (the split point) can be added via FFmpeg `drawbox`:
```
drawbox=x=0:y=958:w=1080:h=4:color=#c7af4f:t=fill
```
This is **optional** — Rob approves before enabling.

---

## 10. File Naming Convention

| Type | Pattern |
|------|---------|
| Short-form video | `{type}_short_{timestamp}.mp4` |
| Portrait thumbnail | `thumbnail_short_{type}_ep{N}_{timestamp}.png` |
| CapCut draft | Managed by VectCutAPI internally |
