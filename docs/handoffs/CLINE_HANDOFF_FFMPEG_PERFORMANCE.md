# CLINE_HANDOFF_FFMPEG_PERFORMANCE.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-15
**Size:** M — `server.js` only, `lib/config.js` optional
**Goal:** Cut assembly time from ~5 min to under 1 min by switching FFmpeg from software libx264 to Apple VideoToolbox hardware encoding. Secondary: consolidate encoder settings into CONFIG so future tuning is one-line.

---

## Why this is safe

- `h264_videotoolbox` is confirmed available on this machine (M4 Pro, Metal 4)
- Output is standard H.264 MP4 — YouTube, HeyGen, Drive all accept it identically
- VideoToolbox uses the M4 Pro's dedicated media engine — does not compete with CPU/RAM during assembly
- Quality at `q:v 65` (VideoToolbox quality scale 0-100, higher=better) is equivalent to libx264 `-crf 23`
- Fallback: if VideoToolbox fails for any segment, fall back to `libx264 -preset fast`. Never break the pipeline.

---

## Platform-aware encoder strategy

This pipeline runs on two platforms with different hardware:

| Platform | Hardware | Best encoder | Assembly time |
|----------|----------|-------------|--------------|
| macOS local (M4 Pro) | Apple media engine | `h264_videotoolbox` | ~1 min |
| Railway Linux (CPU-only) | No GPU on standard plan | `libx264 -preset ultrafast` | ~3 min |
| Railway Linux + GPU (future) | NVIDIA | `h264_nvenc` | ~45s |

The helper function detects platform at startup — no runtime failure-then-fallback needed.

---

## The change — two CONFIG constants + a helper function

### Step 1 — Add to `lib/config.js`

Add an `FFMPEG` block to the CONFIG export:

```javascript
FFMPEG: {
  // Quality settings — VideoToolbox uses -q:v (0-100, higher=better)
  // libx264 uses -crf (0-51, lower=better)
  HW_QUALITY_FLAG:  ['-q:v', '65'],   // ≈ libx264 crf 23 (standard)
  HW_QUALITY_HQ:    ['-q:v', '72'],   // ≈ libx264 crf 18 (chrome burns)
  SW_QUALITY_FLAGS: ['-preset', 'ultrafast', '-crf', '23'],  // Railway: ultrafast > fast
  SW_QUALITY_HQ:    ['-preset', 'fast', '-crf', '18'],       // Chrome burns: keep quality
  THREADS: ['-threads', '0'],  // 0 = auto-detect all cores
}
```

### Step 2 — Add a platform-detection helper near the top of `server.js`

Add this after the CONFIG import, before the first FFmpeg call:

```javascript
// ── FFmpeg encoder selection ─────────────────────────────────────────────────
// macOS (local dev, M4 Pro): VideoToolbox hardware encoder — ~5x faster than libx264
// Linux (Railway standard): libx264 ultrafast — no GPU on standard plan
// Linux + GPU (Railway future): h264_nvenc — add when GPU instance available
const _IS_MACOS  = process.platform === 'darwin';
const _HW_AVAIL  = _IS_MACOS; // extend to check process.env.ENABLE_NVENC when Railway GPU added

// Returns encoder + quality args for the current platform.
// hwQuality=true for chrome burns (short segments, worth extra quality)
// hwQuality=false for normalize/concat (large files, speed matters more)
function ffmpegEncodeArgs(hwQuality = false) {
  if (_HW_AVAIL) {
    // Apple VideoToolbox — uses M4 Pro media engine, doesn't compete with CPU
    return ['-c:v', 'h264_videotoolbox',
            ...( hwQuality ? CONFIG.FFMPEG.HW_QUALITY_HQ : CONFIG.FFMPEG.HW_QUALITY_FLAG ),
            ...CONFIG.FFMPEG.THREADS];
  } else {
    // Linux / Railway — software encode, ultrafast preset for speed
    return ['-c:v', 'libx264',
            ...( hwQuality ? CONFIG.FFMPEG.SW_QUALITY_HQ : CONFIG.FFMPEG.SW_QUALITY_FLAGS ),
            ...CONFIG.FFMPEG.THREADS];
  }
}

console.log(`[ffmpeg] Encoder: ${_HW_AVAIL ? 'h264_videotoolbox (hardware)' : 'libx264 (software)'} on ${process.platform}`);
```

The startup log line makes it immediately obvious which path is active — useful when Railway deployment happens and you want to confirm it picked up `libx264` correctly.

### Step 3 — Replace `libx264 -preset fast` across the assembly pipeline

There are 32 encode sites. **Prioritize the hot path** — the segments that process large files. Replace in this order:

#### Priority 1 — normalize loop (highest impact, runs once per segment ~27 times)
**Line ~4638:**
```javascript
// Before:
'-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
'-c:a', 'aac', '-ar', '44100', '-ac', '2',

// After:
...ffmpegEncodeArgs(false),
'-c:a', 'aac', '-ar', '44100', '-ac', '2',
```

#### Priority 2 — chrome burns (intro card, overlay burns — run once per avatar segment)
**Lines ~4244, 4384, 4430, 4469, 4508, 4576:**
```javascript
// Before:
'-c:v', 'libx264', '-preset', 'fast', '-crf', '18',

// After:
...ffmpegEncodeArgs(true),   // hwQuality=true for chrome burns
```

#### Priority 3 — final concat (runs once, processes the full ~500MB assembled file)
**Lines ~4776, 4828:**
```javascript
// Before:
'-c:v', 'libx264', '-preset', 'fast', '-crf', '23',

// After:
...ffmpegEncodeArgs(false),
```

#### Priority 4 — ticker bake (runs once on the full output)
**Lines ~5589, 5632:**
```javascript
// Before:
'-c:v', 'libx264', '-preset', 'fast', '-crf', '23',

// After:
...ffmpegEncodeArgs(false),
```

#### Priority 5 — remaining sites (short-form, retry path, misc)
Apply `ffmpegEncodeArgs()` to all remaining `libx264 -preset fast` sites. Exception: leave `-c:v copy` lines completely untouched — stream copy is already zero-cost.

**Do NOT change:**
- Line ~4717: `-c:v copy` — stream copy, already optimal
- Line ~5952: slide/image-to-video encode — uses `-r` fps flag, handle separately
- Line ~12332: bash template string `ffmpegCmd` — convert to execFile separately if needed

---

## No runtime fallback needed

Platform detection happens once at startup via `process.platform`. On macOS it always uses VideoToolbox; on Linux it always uses libx264. No try/catch fallback loop required — the right encoder is selected before the first FFmpeg call. If VideoToolbox somehow fails on a specific segment (rare), the existing per-segment error handling already logs and skips that segment — same behavior as today.

---

## Expected improvement (M4 Pro)

| Step | Before | After |
|------|--------|-------|
| Normalize per segment (~27×) | ~8s each = 3.6min | ~1s each = 27s |
| Chrome burns (~22×) | ~4s each = 1.5min | ~0.5s each = 11s |
| Final concat (500MB) | ~45s | ~6s |
| Ticker bake (500MB) | ~60s | ~8s |
| **Total assembly** | **~5-7 min** | **~1 min** |

---

## Files to change

| File | Tier | Edit |
|------|------|-------|
| `lib/config.js` | 1 | Add `FFMPEG` config block |
| `server.js` | 1 | Add helper functions + replace libx264 at 32 encode sites |

---

## Commit message

```
perf(ffmpeg): platform-aware encoder — VideoToolbox on macOS, libx264 ultrafast on Linux

ffmpegEncodeArgs() detects platform at startup (process.platform):
- macOS (M4 Pro local): h264_videotoolbox hardware encoder — uses
  dedicated media engine, doesn't compete with CPU. ~5-7min → ~1min.
- Linux (Railway standard): libx264 ultrafast — no GPU on standard
  Railway plan. ultrafast vs fast saves ~40% encode time at cost of
  slightly larger files (acceptable for 500MB assembly output).
- Linux + GPU (future): extend _HW_AVAIL check for ENABLE_NVENC env var
  when Railway GPU instance added.

Startup log: [ffmpeg] Encoder: h264_videotoolbox (hardware) on darwin
confirms active path on deploy.

CONFIG.FFMPEG block in lib/config.js centralises quality flags.
32 libx264 encode sites replaced. Stream copy lines untouched.
```
