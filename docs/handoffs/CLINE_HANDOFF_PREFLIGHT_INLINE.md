# CLINE_HANDOFF_PREFLIGHT_INLINE.md
→ Agent: Cursor

**Author:** Claude Code, 2026-04-14
**Size:** S — `cwn_production.html` only (one function edit)
**Files:** `cwn_production.html` (Tier 1 frontend)
**Depends on:** nothing — standalone

---

## Problem

Every time the operator clicks "Send to HeyGen", a native browser `confirm()` dialog pops up with the full pre-flight report — segment counts, word counts, clip URLs — and blocks until the operator clicks OK. Even when everything is perfectly fine, the operator has to read and dismiss a system popup.

**Location:** `cwn_production.html:4128`
```javascript
if (!confirm(report)) return;
```

This is the line to replace.

---

## The Fix — Inline pre-flight panel, no popup on clean runs

### Behavior after the fix

- **Clean run (no warnings):** No popup, no click required. Pre-flight summary renders inline as a small collapsed status line below the script area (green, auto-dismisses after 3 seconds). Assembly proceeds immediately.
- **Warning run (short segments or missing clip URLs):** An inline yellow warning panel appears with the issues listed. Two buttons: `⚠ Send Anyway` and `✕ Cancel`. Operator must click one — but it's in the page, not a system dialog.
- **Cancel:** User clicked Cancel → just hide the panel, do nothing.

---

## Implementation

### Step 1 — Add the preflight panel HTML

Find the script textarea or the "Send to HeyGen" button area in the HTML. Add this hidden panel immediately after that element (or at the end of the main content area — it will be positioned absolutely):

```html
<!-- Pre-flight inline panel (shown instead of confirm() dialog) -->
<div id="preflight-panel" style="display:none; margin:10px 0; padding:12px 16px; border-radius:6px; font-size:12px; font-family:monospace; line-height:1.6; border:1px solid; max-height:220px; overflow-y:auto;"></div>
```

### Step 2 — Replace the confirm() block in `sendToHeyGen()` (line ~4096–4128)

Replace the entire block that builds `report` and calls `confirm(report)` with the following. Keep everything before it (Gate 2 validation, rawSegments parsing) and everything after it (the actual HeyGen send logic) exactly as-is — only replace the report-building + confirm block.

**Find this block (lines ~4096–4128):**
```javascript
  // Build pre-flight report
  var totalWords = allParsed.reduce(function(a,s){ return a+s.wordCount; }, 0);
  var totalSecs = allParsed.reduce(function(a,s){ return a+s.estSecs; }, 0);
  var shortSegs = allParsed.filter(function(s){ return s.estSecs < 20; });

  var avatarSegs = allParsed.filter(function(s){ return s.type==='avatar'; });
  var clipSegs   = allParsed.filter(function(s){ return s.type==='source_clip'; });
  var missingClipUrls = clipSegs.filter(function(s){ return !s.clipUrl; }).length;

  var report = '=== PRE-FLIGHT CHECK ===\n\n';
  report += 'HeyGen avatar segments: ' + avatarSegs.length + '\n';
  report += 'Source clip slots: ' + clipSegs.length + (missingClipUrls?' (⚠ '+missingClipUrls+' missing URL)':'') + '\n';
  report += 'Est. avatar speech: ' + estDurFmt(totalSecs) + '\n';
  if (shortSegs.length) {
    report += '\n⚠ SHORT AVATAR SEGMENTS (under 20s):\n';
    shortSegs.forEach(function(s){ report += '  • ' + s.label + ' — ' + s.wordCount + ' words (~' + s.estSecs + 's)\n'; });
  }
  if (missingClipUrls) {
    report += '\n⚠ ' + missingClipUrls + ' clip(s) have no source URL — FFmpeg will skip those slots.\n';
    report += '  Clips are fetched from ESPN/Twitch — refresh game picker if missing.\n';
  }
  report += '\nFull sequence (in order):\n';
  allParsed.forEach(function(s, i) {
    if (s.type==='source_clip') {
      report += (i+1) + '. [SOURCE CLIP] ' + s.label + (s.clipUrl?' ✓':' ⚠ NO URL') + '\n';
    } else {
      var flag = s.estSecs < 20 ? ' ⚠' : '';
      report += (i+1) + '. [AVATAR] ' + s.label + ' — ' + s.wordCount + ' words ~' + s.estSecs + 's' + flag + '\n';
    }
  });
  report += '\nSend ' + avatarSegs.length + ' segments to HeyGen?';

  if (!confirm(report)) return;
```

**Replace with:**
```javascript
  // ── Pre-flight check (inline panel — no system confirm() popup) ──────────
  var totalWords = allParsed.reduce(function(a,s){ return a+s.wordCount; }, 0);
  var totalSecs  = allParsed.reduce(function(a,s){ return a+s.estSecs; }, 0);
  var shortSegs  = allParsed.filter(function(s){ return s.type==='avatar' && s.estSecs < 20; });
  var avatarSegs = allParsed.filter(function(s){ return s.type==='avatar'; });
  var clipSegs   = allParsed.filter(function(s){ return s.type==='source_clip'; });
  var missingClipUrls = clipSegs.filter(function(s){ return !s.clipUrl; }).length;

  var warnings = [];
  if (shortSegs.length) {
    shortSegs.forEach(function(s){
      warnings.push('⚠ Short segment: ' + s.label + ' — ' + s.wordCount + ' words (~' + s.estSecs + 's)');
    });
  }
  if (missingClipUrls) {
    warnings.push('⚠ ' + missingClipUrls + ' clip slot(s) have no source URL — FFmpeg will skip those slots');
  }

  var hasWarnings = warnings.length > 0;
  var panel = document.getElementById('preflight-panel');

  if (!hasWarnings) {
    // Clean run — show green status line, proceed immediately without waiting
    if (panel) {
      panel.style.display = 'block';
      panel.style.background = 'rgba(46,204,113,0.08)';
      panel.style.borderColor = 'rgba(46,204,113,0.3)';
      panel.style.color = '#2ecc71';
      panel.innerHTML = '✅ Pre-flight: ' + avatarSegs.length + ' avatar segments, ' + clipSegs.length + ' clips — ' + estDurFmt(totalSecs) + ' est. speech. Sending to HeyGen...';
      setTimeout(function(){ if (panel) panel.style.display = 'none'; }, 3000);
    }
    // Fall through immediately — no user action required
  } else {
    // Warnings present — show inline panel with Send Anyway / Cancel
    if (!panel) return; // safety: if panel element missing, fall through (don't block)

    var warnHtml = '<div style="font-weight:700;margin-bottom:8px;color:#f39c12;">⚠ Pre-flight warnings — review before sending</div>';
    warnHtml += '<div style="margin-bottom:10px;">' + warnings.map(function(w){ return '<div>' + w + '</div>'; }).join('') + '</div>';
    warnHtml += '<div style="color:#aaa;margin-bottom:12px;font-size:11px;">';
    warnHtml += avatarSegs.length + ' avatar segments · ' + clipSegs.length + ' source clips · ~' + estDurFmt(totalSecs) + ' speech</div>';
    warnHtml += '<div style="display:flex;gap:10px;">';
    warnHtml += '<button onclick="preflightProceed()" style="padding:6px 16px;background:#f39c12;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px;">⚠ Send Anyway</button>';
    warnHtml += '<button onclick="preflightCancel()" style="padding:6px 16px;background:transparent;color:#aaa;border:1px solid rgba(255,255,255,0.2);border-radius:4px;cursor:pointer;font-size:12px;">✕ Cancel</button>';
    warnHtml += '</div>';

    panel.style.display = 'block';
    panel.style.background = 'rgba(243,156,18,0.08)';
    panel.style.borderColor = 'rgba(243,156,18,0.4)';
    panel.style.color = '#e0e0e0';
    panel.innerHTML = warnHtml;

    // Store continuation callback — preflightProceed() will call it
    window._preflightContinue = function() {
      panel.style.display = 'none';
      window._preflightContinue = null;
      doSendToHeyGen(allParsed, avatarSegs, clipSegs);
    };
    return; // Wait for operator to click Send Anyway or Cancel
  }

  // ── End pre-flight check ──────────────────────────────────────────────────
```

### Step 3 — Add two tiny helper functions (add near `sendToHeyGen`)

```javascript
function preflightProceed() {
  if (window._preflightContinue) window._preflightContinue();
}
function preflightCancel() {
  var panel = document.getElementById('preflight-panel');
  if (panel) panel.style.display = 'none';
  window._preflightContinue = null;
}
```

### Step 4 — Extract the HeyGen send body into `doSendToHeyGen()`

The code after the old `confirm(report)` line (the actual segment-sending loop, batchJob construction, etc.) currently lives inline in `sendToHeyGen()`. After the refactor, it needs to be callable both from the clean path (falls through directly) and from `preflightProceed()` (called after warning acknowledgment).

Extract everything from `var allSegments = allParsed;` (line ~4130) through the end of `sendToHeyGen()` into a new function:

```javascript
function doSendToHeyGen(allParsed, avatarSegs, clipSegs) {
  var allSegments = allParsed;
  if (!allSegments.length) { alert('No segments found — generate script first.'); return; }
  var avatarOnly = allSegments.filter(function(s){ return s.type==='avatar'; });
  if (!avatarOnly.length) { alert('No avatar segments found to send to HeyGen.'); return; }

  // ... rest of the existing send body verbatim ...
}
```

And at the end of `sendToHeyGen()` for the clean path, replace the inline code with:
```javascript
  doSendToHeyGen(allParsed, avatarSegs, clipSegs);
```

---

## Files to change

| File | Tier | Edit |
|------|------|------|
| `cwn_production.html` | 1 | Replace confirm() block with inline panel; add 2 helpers; extract doSendToHeyGen() |

---

## Verification

1. Generate a News script with all valid segments
2. Click Send to HeyGen — **no system popup appears**, green status line flashes briefly, segments start sending immediately
3. Generate a script with a very short segment (< 20 words)
4. Click Send to HeyGen — **inline yellow warning panel** appears with the short segment listed
5. Click `✕ Cancel` — panel hides, nothing sent
6. Click Send again → `⚠ Send Anyway` → segments start sending

---

## Commit message

```
feat(dashboard): replace preflight confirm() popup with inline panel

Native browser confirm() dialog blocked every HeyGen send with a
system popup requiring OK — even on clean runs with no issues.

New behavior:
- Clean run: green status line flashes inline, send proceeds immediately
  with no user action required
- Warning run (short segments / missing clip URLs): yellow inline panel
  with issue list + "Send Anyway" / "Cancel" buttons — no system dialog

Extracted HeyGen send body into doSendToHeyGen() so it can be called
both from the clean fall-through path and from preflightProceed() after
warning acknowledgment.
```
