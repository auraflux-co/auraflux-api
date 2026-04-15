# Branch Notes — cline-c/gate1-clip-diagnostic

**Agent:** Cline-C (Claude Sonnet 4.6)
**Branch:** `cline-c/gate1-clip-diagnostic`
**Date opened:** 2026-04-15
**Status:** 🟡 READY — 1 task, lib/qa.js only

---

## CRITICAL — Shell rule

**Every grep/find/rg/ls must end with `|| true`. No exceptions.**

---

## Context

Gate 1 clip availability report only shows totals (e.g. "Actual: 9 clips").
When a streamer drops, you can't tell which one or why — Rob has to manually
cross-reference the script. Fix: add per-streamer breakdown to the report.

The report is in `lib/qa.js` in the `generateClipAvailabilityReport()` function.

---

## TASK — Add per-streamer clip breakdown to Gate 1 report

**Find the function:**
```bash
grep -n "generateClipAvailabilityReport\|CLIP AVAILABILITY" lib/qa.js || true
```

**Find the items/streamer loop:**
```bash
grep -n "streamerOrder\|targetPerStreamer\|actualTotal" lib/qa.js || true
```

**What to add — after the existing Target/Actual/Shortfall lines:**

Build a per-streamer breakdown from `items` array:
```javascript
// Per-streamer breakdown
if (items && items.length > 0) {
  report.push('Per-streamer:');
  for (const item of items) {
    const name = item.displayName || item.streamer || item.name || 'Unknown';
    const clipCount = (item.clips && item.clips.length) || 0;
    const status = clipCount >= targetPerStreamer ? '✅' : clipCount > 0 ? '⚠️' : '❌';
    report.push(`  ${status} ${name}: ${clipCount}/${targetPerStreamer} clips`);
  }
}
```

Also add a "dropped streamers" line at the end if any have 0 clips:
```javascript
const dropped = items ? items.filter(it => !(it.clips && it.clips.length > 0)) : [];
if (dropped.length > 0) {
  report.push(`\nDropped (0 clips): ${dropped.map(d => d.displayName || d.streamer || d.name).join(', ')}`);
}
```

**One commit:** `fix(gate1): add per-streamer clip breakdown to availability report`

---

## Verification

```bash
node -c lib/qa.js || true
grep -n "Per-streamer\|Dropped" lib/qa.js || true
```

Gate 1 report should now show:
```
── CLIP AVAILABILITY REPORT ──────────────────────
Target: 20 clips (10 streamers × 2 clips each)
Actual: 18 clips
Shortfall: 2 clips

Per-streamer:
  ✅ Jason: 2/2 clips
  ✅ Hasan: 2/2 clips
  ❌ Ron: 0/2 clips
  ...

Dropped (0 clips): Ron
```

---

## Log

| Time | Entry |
|------|-------|
| 2026-04-15 EOD | Branch opened. Change is in lib/qa.js generateClipAvailabilityReport(). |
