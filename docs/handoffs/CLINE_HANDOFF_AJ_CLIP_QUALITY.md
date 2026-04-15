# CLINE HANDOFF — Al Jazeera Clip Quality (Re-encode Constraints)

**Priority:** MEDIUM — video works but quality looks inconsistent vs Twitch clips  
**Agent:** Cline-A (backend pipeline, `server.js`)  
**Estimated scope:** ~10-line change in the News clip TS encoding args  
**Branch:** main

---

## Problem

Al Jazeera / Brightcove clips look noticeably worse than Twitch clips in the assembled video. The Twitch clips have always looked fine. The News clips look soft or over-processed.

Rob also noted an FFmpeg warning about "too large for frame" — this comes from the Brightcove HLS manifests being served at unusual resolutions (some Al Jazeera clips are 1280×720 at very high bitrate, some are portrait 1080×1920, some are 4K downsampled). The current re-encode at `server.js:4654-4665` uses default libx264 settings which may not handle these cases well.

---

## Root Cause

The Brightcove/Al Jazeera HLS streams have:
1. **Variable input resolutions** — 720p, 1080p, 4K, portrait clips all in the same feed
2. **High input bitrates** — Brightcove CDN streams can be 8–12 Mbps for 1080p
3. **Unusual container formats** — some are fragmented MP4 (fMP4) inside HLS, not plain TS
4. **Pixel format mismatches** — some use yuv420p10le (10-bit) which causes warnings

The current encoding args:
```javascript
...ffmpegEncodeArgs(false),   // resolves to: -c:v libx264 -crf 23 -preset medium  (or VideoToolbox)
```

This is correct for Twitch clips. But for high-bitrate Brightcove fMP4 streams, the default CRF 23 on an already-high-quality source produces large intermediate TS files and occasionally the "encoded frame too large" warning from x264.

---

## Fix — Explicit Re-encode Parameters for News Source Clips

**Location:** `server.js:4654-4665` — the `buildTsArgs()` async function

Find the `baseArgs` array:

```javascript
const baseArgs = [
  '-vf', vfFilter,
  '-pix_fmt', 'yuv420p',
  ...ffmpegEncodeArgs(false),
  '-g', '30',
  '-keyint_min', '30',
  '-sc_threshold', '0',
  '-c:a', 'aac', '-ar', '44100', '-ac', '2',
  '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0',
  '-bsf:v', 'h264_mp4toannexb',
  '-f', 'mpegts', '-y', tsPath
];
```

**Change:** When `contentType === 'news' && !isAvatarSeg`, override the encode args to force a constrained bitrate instead of `ffmpegEncodeArgs(false)`. This prevents "too large" warnings and keeps file sizes manageable:

```javascript
// News source clips use constrained bitrate instead of default CRF
// Brightcove HLS input can be very high bitrate — cap to 4 Mbps for TS segments
const newsClipEncodeArgs = (contentType === 'news' && !isAvatarSeg)
  ? ['-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-maxrate', '4M', '-bufsize', '8M']
  : ffmpegEncodeArgs(false);

const baseArgs = [
  '-vf', vfFilter,
  '-pix_fmt', 'yuv420p',
  ...newsClipEncodeArgs,           // ← use constrained args for News clips
  '-g', '30,
  '-keyint_min', '30',
  '-sc_threshold', '0',
  '-c:a', 'aac', '-ar', '44100', '-ac', '2',
  '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0',
  '-bsf:v', 'h264_mp4toannexb',
  '-f', 'mpegts', '-y', tsPath
];
```

**Why `libx264` explicitly:** VideoToolbox (`ffmpegEncodeArgs(false)` on macOS) occasionally has issues encoding fMP4 sources with non-standard pixel formats. libx264 is more tolerant of unusual input containers. The `-maxrate 4M -bufsize 8M` pair enforces VBV buffering to prevent "encoded frame too large" from x264.

**Why `fast` preset:** The `5s + 25s cap` on News clips means short encode times. `fast` vs `medium` saves ~30% encode time with negligible quality difference at CRF 23.

---

## Note: This Does NOT Affect Twitch or NBA

The guard `contentType === 'news' && !isAvatarSeg` ensures Twitch and NBA clips still use `ffmpegEncodeArgs(false)` (VideoToolbox on macOS for speed). Only News source clips use the constrained x264 path.

---

## Testing

After the change, run a News assembly with Al Jazeera clips and confirm:
1. No "encoded frame too large" warnings in FFmpeg output
2. Clip quality looks comparable to Twitch clips
3. Assembly time is similar (fast preset + 25s cap = should be comparable)

---

## Commit Message

```
fix(news): constrain AJ clip encode to libx264 + maxrate 4M

Brightcove HLS streams can be very high bitrate / unusual formats.
VideoToolbox on fMP4 sources produces "encoded frame too large" warnings.
News source clips now force libx264 + 4M maxrate for consistent quality.
```
