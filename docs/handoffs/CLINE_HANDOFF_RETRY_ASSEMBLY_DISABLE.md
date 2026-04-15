# CLINE_HANDOFF_RETRY_ASSEMBLY_DISABLE.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14 (post-smoke-test-11 review)
**Size:** S — server.js only (1 edit, ~5 lines)
**Priority:** Ship alongside or immediately after `CLINE_HANDOFF_RED4_CHROME_BUGS.md`
**Problem:** The retry assembly endpoint produces a video with no chrome overlays — no TV card, no lower-third flag, no story sidebar. Must be disabled until properly rewritten to include the Puppeteer chrome pipeline.

---

## What Happened

Rob triggered "RETRY ASSEMBLY" from the dashboard. The output was unchromed:
- No TV card (top-right)
- No lower-third flag
- No story sidebar
- Al Jazeera watermark visible on every source clip (not masked)

Note: The 88-minute video Rob observed was likely from the earlier triple-fire race condition (3 assembly jobs ran simultaneously, pulled in segments from all 3 asmIds). The retry endpoint itself would produce correct-length video — just without chrome.

## Root Cause — Structural: retry skips the chrome pipeline

The retry endpoint at `server.js:5501` does:
1. Find `tmp/asm_{asmId}_*.mp4` files
2. FFmpeg concat → re-encode
3. Bake ticker overlay
4. Run Gate 3

It does NOT:
- Load the directive sidecar from `data/directives/{jobId}.json`
- Call `burnSceneChromeFromDirective()` per scene
- Call `generateNewscastOverlay()` for flag + sidebar
- Apply the Al Jazeera watermark mask (`drawbox` at x=1780,y=960)

The per-segment chrome burn happens during the main assembly's normalize loop (`server.js:~4230-4520`), where each segment gets Puppeteer-rendered overlays applied before the final concat. The retry jumped straight to concat of the pre-normalized (but unchromed) files.

**The correct design:** Retry should re-enter the main assembly flow at the normalize+chrome step — not at the raw concat step.

---

## The Fix — Disable retry, redirect operators to fresh assembly

### Change — Replace retry handler body with 501 (server.js:5505)

Keep the function signature. Replace the entire async handler body with:

```javascript
app.post('/assemble/:asmId/retry', (req, res) => {
  // DISABLED 2026-04-14: retry path skips Puppeteer chrome pipeline.
  // TV card / lower-third flag / story sidebar all absent from output.
  // Fresh assembly from dashboard is the safe path — HeyGen segments are
  // cached in tmp/ and re-used automatically (no HeyGen re-spend).
  // Re-enable when retry is rewritten to enter main assembly at chrome step.
  return res.status(501).json({
    error: 'retry_disabled',
    message: 'Retry assembly is temporarily disabled. Use the main ASSEMBLE button — existing HeyGen segments are cached in tmp/ and will be re-used without re-burning HeyGen credits.',
  });
});
```

Leave the entire old implementation below as commented-out code for the rewrite sprint. Add `/* DISABLED 2026-04-14 - see CLINE_HANDOFF_RETRY_ASSEMBLY_DISABLE.md` before and `*/` after the old body.

---

## Also update the dashboard button (cwn_production.html)

Find `retryAssembly` function. Replace body with:

```javascript
function retryAssembly(jobId) {
  alert('Retry assembly is temporarily disabled.\n\nClick ASSEMBLE instead — existing HeyGen segments are already cached and will be re-used automatically. No HeyGen credits will be spent.');
}
```

---

## Files to change

| File | Tier | Edit |
|------|------|------|
| `server.js` | 1 | Replace retry handler body with 501, comment out old impl |
| `cwn_production.html` | 1 | Replace retryAssembly() body with alert |

## Commit message

```
fix(assembly): disable broken retry endpoint — chrome pipeline missing from retry path

/assemble/:asmId/retry produced unchromed output in smoke test 11.
TV card, lower-third flag, story sidebar, and Al Jazeera watermark
mask all absent because retry jumped straight to raw FFmpeg concat,
bypassing the Puppeteer chrome pipeline in the main normalize loop.

Disabled with 501 + alert on dashboard button. Fresh assembly is the
safe retry path — HeyGen segments cached in tmp/ are re-used
automatically (no HeyGen re-spend required).

Follow-up sprint: rewrite retry to enter main assembly at the
normalize+chrome step rather than the post-chrome concat step.
```

---

## Why fresh assembly does not re-spend HeyGen credits

**HeyGen credits are charged when you submit a video for rendering** — i.e., when the dashboard sends segments to HeyGen API and waits for `COMPLETED`. Downloading an already-rendered video from HeyGen's CDN (what the assembly download loop does) does not charge credits.

On a fresh ASSEMBLE press for the same job, the assembly re-downloads the already-rendered HeyGen segments from the stored `video_id` CDN URLs. HeyGen CDN links stay alive for days. No new render jobs are submitted, no credits are charged. The only cost is bandwidth (negligible) and time (~30s to re-download all segments).

So: fresh ASSEMBLE = re-run downloads + FFmpeg + Puppeteer chrome = correct output, zero HeyGen spend.

The separate retry endpoint was trying to save download time — a minor optimization that introduced the structural chrome-missing bug. Not worth the tradeoff.
