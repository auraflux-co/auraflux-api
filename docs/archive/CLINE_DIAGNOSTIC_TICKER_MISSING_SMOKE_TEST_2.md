# Cline Diagnostic: Ticker Missing in 2nd Smoke Test

**Author:** Claude Code
**Date:** 2026-04-11 ~11:45 AM ET
**Status:** ✅ **SUPERSEDED** — Cline independently diagnosed and fixed this while I was writing the doc. Fix shipped in Cline's pending commit at 2:10 PM ET (STATUS.md row 71). The race-condition analysis below was correct; Cline's fix matches my recommended Option A (`await captureTicker()` before assembly POST). This doc is preserved as a historical record of the race-condition reasoning, useful if the bug ever recurs.
**For task:** #19 (Diagnose 2nd smoke test missing ticker)
**Related fix:** `7016d6b` (Cline's original ticker pre-warm in `startHeyGenPoller()`) + the follow-up fix in the 2:10 PM commit that converted fire-and-forget `captureTicker().then(...)` to `await captureTicker(contentType)` before `axios.post('/assemble')`

---

## TL;DR

2nd smoke test produced a clean 68MB MP4 with every fix from overnight working (full-bleed avatar, logo top-left, correct dimensions, no video freeze, AV sync healthy) EXCEPT the ticker is missing at the bottom. The ticker file exists on disk and is well-formed. Most likely cause: race condition between `captureTicker()` pre-warm firing async-non-blocking in `startHeyGenPoller()` and the subsequent assembly ticker check.

---

## Evidence

### The output MP4 is healthy, just missing the ticker

File: `output/script_twitch_1775920714320_1775920965775.mp4`

```json
{
  "streams": [
    { "codec_name": "h264", "width": 1920, "height": 1080, "duration": "149.533333" },
    { "codec_name": "aac", "duration": "149.585011" }
  ],
  "format": { "duration": "149.585011", "size": 68_MB }
}
```

- ✅ 1920×1080 dimensions correct
- ✅ AV sync healthy (149.53s video vs 149.59s audio — 60ms, well within tolerance)
- ✅ H.264 + AAC codecs correct
- ✅ File size reasonable for 150s of content

### The ticker MP4 exists and is correct

File: `tmp/ticker_twitch.mp4`

```json
{
  "streams": [{ "codec_name": "h264", "width": 1920, "height": 64, "r_frame_rate": "15/1", "duration": "60.000000" }],
  "format": { "duration": "60.000000", "size": 1_069_899 }
}
```

- ✅ 1920×64 dimensions match `CONFIG.TICKER.WIDTH/HEIGHT`
- ✅ 15 fps matches `CONFIG.TICKER.FPS`
- ✅ 60 seconds matches `CONFIG.TICKER.DURATION_SECONDS`
- ✅ File is well-formed H.264
- ✅ `mtime`: 11:23 AM ET (~1 minute before the 2nd smoke test assembly finished)

### Frame extraction confirms ticker visually absent

Extracted frames at t=2s and t=75s. Both show:
- Full-bleed Bobby G avatar ✅
- CWN gold logo top-left ✅
- Neon world map background ✅
- Clean desk surface across the bottom 64px **where the ticker should be burned** ❌

No "Error response" text (the old Puppeteer 404 artifact from the Apr 10 bug is gone — that's fixed separately via the `tools/` path fix in `0d13fb0`). The bottom is simply empty desk.

---

## The prime suspect: async pre-warm race condition

Cline's fix in `7016d6b` added a `captureTicker(contentType)` pre-warm call in `startHeyGenPoller()` before `axios.post('/assemble')` fires. Per the commit description, this pre-warm is **async, non-blocking**.

### The race

```
Timeline (approximate):
  t=0.0s:  startHeyGenPoller() detects all segments complete
  t=0.0s:  fires captureTicker('twitch') async — Puppeteer spawns, page loads,
           screenshot loop begins (takes ~15-30s real time for 60s of ticker frames)
  t=0.1s:  fires axios.post('/assemble') immediately (non-blocking)
  t=0.1s:  /assemble endpoint begins running: downloads segments, normalizes
  t=~30s:  /assemble reaches Step 6 "Ticker bake" (server.js:3932+)
  t=~30s:  captureTicker('twitch') called again from inside /assemble
  t=~30s:  TICKER_CACHE['twitch'] check — DEPENDS ON WHETHER PRE-WARM IS DONE
  ?      : if pre-warm Puppeteer finished → cache hit → bake ticker ✅
  ?      : if pre-warm Puppeteer still writing → cache miss → return null → skip bake ❌
```

The `tmp/ticker_twitch.mp4` file has `mtime=11:23`. The assembly output has `mtime=11:24`. So Puppeteer MAY have finished writing the file AFTER the assembly ticker-bake step already decided "no cache, skip ticker."

### Why the cache check would fail even though the file is "done"

Looking at `captureTicker()` at `server.js:4595-4607`:

```javascript
if (TICKER_CACHE[contentType]) {
  const cached = TICKER_CACHE[contentType];
  const age = Date.now() - cached.cachedAt;
  if (age < TICKER_CACHE_TTL && fs.existsSync(cached.path)) {
    console.log(`[ticker] Using cached ${contentType} ticker (age: ${Math.round(age/1000/60)}m)`);
    return cached.path;
  }
}
```

**The cache check is based on the in-memory `TICKER_CACHE[contentType]` object**, NOT on filesystem existence of `tmp/ticker_twitch.mp4`. The in-memory object only gets populated at the END of `captureTicker()` after Puppeteer + FFmpeg finish.

**This means:**
- Pre-warm fires → Puppeteer starts rendering frames → FFmpeg encodes → writes file → sets `TICKER_CACHE['twitch']`
- All of that takes 15-30 seconds
- Meanwhile, assembly starts and runs for ~30-60 seconds before reaching the ticker bake step
- **If assembly reaches the ticker bake BEFORE pre-warm sets `TICKER_CACHE['twitch']` in memory**, the cache lookup returns nothing
- `captureTicker()` then STARTS ANOTHER Puppeteer capture (from scratch, takes another 15-30s)
- But by then, the OTHER (pre-warm) Puppeteer may ALSO still be running
- Race condition between two concurrent Puppeteer captures

### The observed state matches this theory

- ✅ `tmp/ticker_twitch.mp4` exists and is well-formed (pre-warm eventually completed)
- ✅ In-memory `TICKER_CACHE['twitch']` may have been set — but AFTER assembly's ticker check fired
- ✅ Assembly output has no ticker overlay (cache miss during the critical moment)

---

## Recommended fixes (for Cline to evaluate)

### Option A — Block pre-warm before assembly fires (simplest)

In `cwn_production.html` where `startHeyGenPoller()` fires `/assemble`:

```diff
- captureTicker(contentType); // async, non-blocking
+ await captureTicker(contentType); // block until ticker ready
  axios.post('/assemble', ...);
```

**Pros:** Guaranteed cache warm. Simplest possible fix.
**Cons:** Adds ~15-30s wait time before assembly starts. Assembly takes 5-15 minutes total, so this is <5% overhead.
**My recommendation.**

### Option B — Move pre-warm INTO `/assemble` as an await

Remove the pre-warm from `startHeyGenPoller()`. In `/assemble` at the Step 6 ticker bake block (server.js:3932+), ensure `captureTicker()` is awaited synchronously before the FFmpeg overlay command fires.

Looking at the current code, `captureTicker` IS called via `await` in the `/assemble` path (line ~3940: `const tickerPath = await captureTicker(tickerType);`). So the issue isn't that `/assemble` skips the await — the issue is that two instances of Puppeteer may be fighting each other.

**Pros:** No dashboard-side change, pure server-side fix.
**Cons:** Doesn't address the concurrent-Puppeteer-instances race — if pre-warm is still running when assembly calls `captureTicker()`, the second call still triggers a fresh Puppeteer launch because the in-memory cache isn't set yet.

### Option C — Add a Promise-based lock to TICKER_CACHE

Introduce `TICKER_CACHE_PROMISES[contentType]`. First call sets a pending Promise in the lock, subsequent concurrent calls `await` the same Promise instead of starting a new Puppeteer capture.

```javascript
const TICKER_CACHE_PROMISES = {};

async function captureTicker(contentType) {
  // Check completed cache first
  if (TICKER_CACHE[contentType] && fs.existsSync(TICKER_CACHE[contentType].path)) {
    return TICKER_CACHE[contentType].path;
  }
  // Check in-flight pre-warm
  if (TICKER_CACHE_PROMISES[contentType]) {
    return await TICKER_CACHE_PROMISES[contentType];
  }
  // Start new capture, store promise in lock
  TICKER_CACHE_PROMISES[contentType] = (async () => {
    // ... existing Puppeteer + FFmpeg capture logic ...
    TICKER_CACHE[contentType] = { path: outPath, cachedAt: Date.now() };
    return outPath;
  })();
  try {
    return await TICKER_CACHE_PROMISES[contentType];
  } finally {
    delete TICKER_CACHE_PROMISES[contentType];
  }
}
```

**Pros:** Eliminates the race entirely. Concurrent callers share one Puppeteer capture. Most correct fix.
**Cons:** More code change than Option A. Not much more, though — maybe 15 lines.

### My recommendation

**Option A is the cheapest fix** (1 line: add `await`). Ship it first. If Rob observes the ticker consistently working after that, we're done.

**Option C is the correct fix** architecturally. Worth upgrading to once the pipeline is stable. Could be a follow-up commit later this week.

**Option B is a band-aid** that doesn't address the root race condition.

---

## Also worth checking — is there a different ticker issue?

Before Cline commits to the race-condition theory, worth verifying:

1. **Check the 2nd smoke test's assembly log** — search for `[ticker]` messages. If the log shows "Ticker overlay failed" or "Ticker step failed: ..." with an error, the root cause might be a DIFFERENT bug (e.g., FFmpeg overlay filter error, ticker file permission issue, etc.).

2. **Check if the 2nd smoke test was started BEFORE the 1st Cline commit of the morning** (specifically `7016d6b` at some time ET). If the smoke test ran before `7016d6b` landed, it used the OLD (pre-fix) code path and the missing ticker is explained by the original bug that `7016d6b` was fixing. **Solution: re-run the smoke test with the current code.**

3. **Check `git log --oneline` against the output file's mtime** — if the file was assembled AFTER `7016d6b` was in place, then the race condition theory stands. If BEFORE, the smoke test ran on stale code.

`tmp/ticker_twitch.mp4` mtime is 11:23. Check when `7016d6b` was committed:

```bash
git show -s --format=%ci 7016d6b
```

If that timestamp is BEFORE 11:23, the fix was live during the smoke test — race condition theory stands. If AFTER 11:23, stale code — re-run smoke test and the ticker should appear.

---

## What NOT to touch (my scope discipline)

- NOT editing `server.js` or `cwn_production.html` — Cline's territory
- NOT committing any code fix
- NOT running another smoke test unilaterally — Rob drives testing
- NOT writing a full handoff doc for this — diagnostic only, Cline owns the fix

If Cline wants the race-condition fix turned into a proper handoff doc with Option A/B/C comparison, commit message template, and test plan, I can escalate this to a full handoff. Otherwise it stays diagnostic-only.

---

## Standing by

When Cline lands the fix and Rob runs the 3rd smoke test, paste me the output MP4 path and I'll extract frames to verify the ticker is visible at the bottom 64px. That's the acceptance test.
