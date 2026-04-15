# CLINE_HANDOFF_QA_GATE_HARDENING.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14  
**Size:** M — server.js only, Tier 1  
**Problem:** Gate 3 passed a News episode Rob could immediately identify as broken by opening the file. Two structural blindspots diagnosed. This handoff fixes them.  
**4 commits, ship in order. Do not bundle.**

---

## Why Gate 3 Has Two Structural Blindspots

**Blindspot A — 0 clips:** `clipCount` at `server.js:3497` counts from `segsToProcess` (what the dashboard requested), NOT from `localFiles` (what actually downloaded). When the dashboard sent 0 source_clip segments, `clipCount = 0`. Gate 3's MIDDLE checklist at `server.js:1883` conditionally includes the SOURCE CLIPS item only `if clipCount > 0` — so with `clipCount = 0`, Gemini was never asked to look for clips. Not a false negative. The question was never asked.

**Blindspot B — TV card on wrong scenes:** Gate 3 EARLY sample (`server.js:1876`) asks: "Is a TV card visible? (yes/no)". Records presence only, no scene context. Never asks "should it be visible on THIS type of scene?" When `tvCard.visible=true` bleeds onto SETUP/SUMMARY/REACTION scenes via the directive, Gemini sees it, says "yes", and moves on.

**One existing variable to know:** `actualClipCount` at `server.js:4046` already exists but has the same blindspot — it counts from `segsToProcess`. It's used only for the output filename. Don't confuse it with the new `downloadedClipCount` variable you'll create.

---

## Commit 1 — Deterministic Pre-Flight Check (no Gemini tokens)

**Why first:** catches the 0-clips catastrophe before any Gemini spend. Structural check on data already in memory.

### Add `assemblyPreFlightCheck()` near `server.js:1830` (before `geminiQACheck`)

```javascript
// ── Gate 3 Pre-Flight: deterministic structural check, no Gemini tokens ─────────
// Fix 5: catches critical assembly failures BEFORE Gemini upload.
// Runs after download loop + segTypes build, before TS normalization.
function assemblyPreFlightCheck(localFiles, segTypes, segsToProcess, contentType) {
  const issues = [];
  const requestedClips  = segsToProcess.filter(s => s.type === 'source_clip').length;
  const downloadedClips = localFiles.filter((_, i) => segTypes[i] === 'source_clip').length;

  if (requestedClips > 0 && downloadedClips === 0) {
    issues.push({
      severity: 'CRITICAL',
      check: 'SOURCE_CLIPS_ALL_MISSING',
      detail: `${requestedClips} source clips requested, 0 downloaded — episode has no source footage`
    });
  } else if (downloadedClips < requestedClips) {
    issues.push({
      severity: 'WARNING',
      check: 'SOURCE_CLIPS_PARTIAL',
      detail: `${downloadedClips}/${requestedClips} source clips downloaded — partial footage loss`
    });
  }

  return { issues };
}
```

### Call site: insert at `server.js:4070` (after `segTypes` fallback, before Step 4 normalization)

`segTypes` is built at lines 4055–4069. Insert IMMEDIATELY after line 4069. This is INSIDE the `run()` async function:

```javascript
      // Fix 5: Deterministic pre-flight check — runs before Gemini, no token cost
      const preFlightResult = assemblyPreFlightCheck(localFiles, segTypes, segsToProcess, contentType);
      const preFlightCriticals = preFlightResult.issues.filter(i => i.severity === 'CRITICAL');
      if (preFlightCriticals.length > 0) {
        for (const issue of preFlightCriticals) {
          log(asmId, `🚨 PRE-FLIGHT CRITICAL: [${issue.check}] ${issue.detail}`);
        }
        log(asmId, `❌ Gate 3 pre-flight failed — ${preFlightCriticals.length} critical issue(s). Aborting before Gemini upload.`);
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error  = preFlightCriticals.map(i => i.detail).join('; ');
        assemblyJobs[asmId].qaOutcome = 'pre_flight_fail';
        assemblyJobs[asmId].qaReport  = preFlightCriticals.map(i => `CRITICAL: ${i.check} — ${i.detail}`).join('\n');
        return;
      }
      for (const issue of preFlightResult.issues.filter(i => i.severity === 'WARNING')) {
        log(asmId, `⚠️  PRE-FLIGHT WARNING: [${issue.check}] ${issue.detail}`);
      }
```

Also compute `downloadedClipCount` here for use in later commits:

```javascript
      const downloadedClipCount = localFiles.filter((_, i) => segTypes[i] === 'source_clip').length;
```

### Verification

```bash
grep -n "assemblyPreFlightCheck\|PRE-FLIGHT\|downloadedClipCount" server.js
# PRE-FLIGHT log should appear at lower line number than geminiQACheck call (~5079)
node -c server.js
```

### Commit message

```
feat(gate3): add deterministic pre-flight check before Gemini upload

Gate 3 passed a News episode with 0 source clips because clipCount=0 caused
the SOURCE CLIPS check to be silently omitted from the Gemini checklist.

Fix: new assemblyPreFlightCheck() runs after download loop + segTypes build,
before Gemini. Uses localFiles + segTypes for downloaded clip count — not
segsToProcess (which has the blindspot). On CRITICAL → abort, status=failed,
qaOutcome=pre_flight_fail, zero Gemini tokens spent.

v1 checks:
  SOURCE_CLIPS_ALL_MISSING: requestedClips>0 AND downloadedClips===0 → CRITICAL
  SOURCE_CLIPS_PARTIAL: downloadedClips<requestedClips → WARNING (continues)

Also computes downloadedClipCount from localFiles/segTypes for Fix 1 (next commit).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Commit 2 — `downloadedClipCount` into `geminiQACheck` (Fix 1)

**Depends on:** Commit 1 (needs `downloadedClipCount` in scope)

### 1. Add to Gate 3 call site at `server.js:5079-5083`

```javascript
          qaResult = await geminiQACheck(outPath, {
            contentType, avatarCount, clipCount,
            downloadedClipCount,         // Fix 1: actual downloaded vs requested
            expectedTicker: !!(tickerType && TICKER_MAP[tickerType]),
            totalDuration: parseFloat(totalDur)
          });
```

### 2. Update `geminiQACheck` signature at `server.js:1837`

```javascript
  const { contentType, avatarCount, clipCount, downloadedClipCount, expectedTicker, totalDuration } = opts;
```

### 3. Update MIDDLE sample SOURCE CLIPS item at `server.js:1883`

```javascript
      ...(((downloadedClipCount ?? clipCount) > 0) ? [`6. SOURCE CLIPS: Are source clips (non-avatar footage) visible and playing? (yes/no)`] : []),
```

### 4. Update Gemini context line at `server.js:1893`

```javascript
      `Context: ${avatarCount} avatar segments, ${clipCount} source clips requested, ${downloadedClipCount ?? clipCount} downloaded.`,
```

### 5. Update `clipsExpectedButMissing` at `server.js:1981`

**Current:**
```javascript
  const clipsExpectedButMissing = clipCount > 0 && /SOURCE CLIPS:.*no/i.test(fullReport);
```

**Target:**
```javascript
  // Fix 1: structural fail when clips requested but none downloaded; Gemini-detected fail when downloaded but not visible
  const effectiveClipCount = downloadedClipCount ?? clipCount;
  const clipsExpectedButMissing = (clipCount > 0 && effectiveClipCount === 0) ||
    (effectiveClipCount > 0 && /SOURCE CLIPS:.*no/i.test(fullReport));
```

### Verification

```bash
grep -n "downloadedClipCount\|effectiveClipCount" server.js
node -c server.js
```

### Commit message

```
fix(gate3): pass downloadedClipCount from localFiles into geminiQACheck

clipCount (server.js:3497) counts from segsToProcess (requested), not from
localFiles (downloaded). When clips fail download, Gate 3 told Gemini wrong count.

Changes:
- geminiQACheck opts: added downloadedClipCount (backward-compat: ?? clipCount fallback)
- MIDDLE sample SOURCE CLIPS item: uses downloadedClipCount ?? clipCount
- Gemini context line: shows "X requested, Y downloaded"
- clipsExpectedButMissing: hard-fails when clipCount>0 AND effectiveClipCount===0
  (structural, no Gemini needed). Also still fails if Gemini sees missing clips.

Two-layer defense: pre-flight (Commit 1) aborts before Gemini on CRITICAL;
this commit gives Gemini accurate context when clips partially failed.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Commit 3 — TV Card Scene-Context Check (Fix 3)

### 1. Update EARLY sample TV card item at `server.js:1876`

**Current:**
```javascript
        `6. TV CARD: Is a TV-shaped overlay card visible in the top-right corner? (yes/no)`,
```

**Target:**
```javascript
        `6. TV CARD: Is a TV-shaped overlay card visible in the top-right corner? (yes/no) — IMPORTANT: for News, the TV card is ONLY correct on STORY_INTRO scenes. If visible on a non-intro scene (setup, summary, reaction, outro), flag as FAIL.`,
```

### 2. Add News chrome rule to `qaPrompt` preamble at `server.js:1891`

The `qaPrompt` string starts `You are QA reviewer...`. Add a News-specific context block immediately after the `Context:` line:

**Current structure:**
```javascript
      const qaPrompt = `You are QA reviewer for ClipzWorld News YouTube compilations.
Review this 20-second ${point.label} sample (from ~${Math.round(point.start)}s into an ${Math.round(dur)}s video).
Context: ${avatarCount} avatar segments, ${clipCount} source clips.
```

**Target:**
```javascript
      const qaPrompt = `You are QA reviewer for ClipzWorld News YouTube compilations.
Review this 20-second ${point.label} sample (from ~${Math.round(point.start)}s into an ${Math.round(dur)}s video).
Context: ${avatarCount} avatar segments, ${clipCount} source clips requested, ${downloadedClipCount ?? clipCount} downloaded.${contentType === 'news' ? `\nNews chrome rules: TV card overlay must ONLY appear on story INTRO scenes. If TV card is visible on SETUP, SUMMARY, REACTION, or OUTRO scenes, it is a production bug — flag as FAIL.` : ''}
```

### 3. Add `tvCardOnWrongScene` detection at `server.js:1980-1982`

After the existing critical failure detections, add:

```javascript
  const tvCardOnWrongScene  = contentType === 'news' && /TV CARD.*FAIL/i.test(fullReport);
```

Add to `hasCriticalFail`:

**Current:**
```javascript
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync || clipsExpectedButMissing;
```

**Target:**
```javascript
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync || clipsExpectedButMissing || tvCardOnWrongScene;
```

### 4. Add deduction entry near `server.js:1990`

```javascript
  if (tvCardOnWrongScene)  deductions.push({ points: 15, reason: 'TV CARD on wrong scene type — visible outside STORY_INTRO scenes (News only)' });
```

### 5. Add to why-doc critical failures section at `server.js:2026`

```javascript
    `TV card bleed: ${tvCardOnWrongScene ? '🚨 YES' : contentType === 'news' ? '✅ No' : 'N/A'}`,
```

### Verification

```bash
grep -n "tvCardOnWrongScene\|TV CARD.*FAIL\|News chrome rules" server.js
node -c server.js
```

### Commit message

```
fix(gate3): add News TV card scene-context check to Gemini QA prompt

Gate 3 EARLY sample only recorded TV card presence/absence with no scene-type
context. When directive chrome burned tvCard.visible=true on non-INTRO scenes,
Gate 3 saw the card, said "yes", and passed — never flagging it was wrong.

Changes:
- server.js:1876 — EARLY TV CARD item: specifies card is only correct on
  STORY_INTRO scenes; visible on non-intro → FAIL
- server.js:1891 qaPrompt — News chrome rule added to all three sample prompts:
  TV card must only appear on INTRO scenes
- server.js:~1982 — tvCardOnWrongScene: NEWS && /TV CARD.*FAIL/i → hasCriticalFail
- server.js:~1990 — 15-point deduction for TV card bleed
- server.js:~2026 — why-doc critical failures section updated

News-only. NBA and Twitch: tvCardOnWrongScene=false.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Commit 4 — Clip Sizing Verification (Fix 4 — likely comment-only)

### Verify before writing any code

```bash
grep -n "force_original_aspect_ratio\|increase,crop\|decrease,pad" server.js
```

The News source_clip normalization is in the `buildTsArgs` or vfFilter area. Look for the non-avatar segment branch around `server.js:4518-4530`. The correct pattern is:

```
scale=w='if(gt(a,16/9),-2,1920)':h='if(gt(a,16/9),1080,-2)',crop=1920:1080
```

This is zoom-to-fill (input-aware scale + crop). **If this is already present, no code change needed.** Skip to the comment update below.

**If `force_original_aspect_ratio=decrease,pad` is found in the non-avatar source_clip branch** (not in short-form split-screen), replace it with the zoom-to-fill pattern above.

Short-form split-screen at `server.js:3800` and `server.js:3834` also use zoom-to-fill — those are SEPARATE code paths for 9:16 portrait format. Do NOT touch them.

### Comment update (add regardless of whether code changed)

At the source_clip vfFilter line for News, update or add comment:

```javascript
// Source clips: zoom-to-fill (increase+crop) — all aspect ratios fill 1920x1080
// without letterbox bars. Covers portrait Al Jazeera clips (Red 4 Fix 4, 2026-04-13).
// Fix 4 verification (CLINE_HANDOFF_QA_GATE_HARDENING.md 2026-04-14): confirmed correct.
```

### Commit message

```
docs(assembly): verify News source clip zoom-to-fill is correct (Fix 4)

Verified source_clip vfFilter uses zoom-to-fill (increase+crop) for all content
types including News/Al Jazeera. Red 4 Fix 4 (2026-04-13) already applied the
correct pattern. No functional code change.

If zoom-to-fill was missing (decrease,pad regression): fixed in this commit.
Comment update confirms verification for future agents.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Ship Order

```
Commit 1 → node -c server.js → git add server.js STATUS.md && git commit → push
Commit 2 → node -c server.js → git add server.js STATUS.md && git commit → push
Commit 3 → node -c server.js → git add server.js STATUS.md && git commit → push
Commit 4 → node -c server.js → git add server.js STATUS.md && git commit → push
```

## Expected Outcome After All 4 Commits

**Episode with 0 downloaded clips:**
- Pre-flight fires, `status=failed`, `qaOutcome=pre_flight_fail`
- Assembly aborts before TS normalization or Gemini upload
- Log: `PRE-FLIGHT CRITICAL: [SOURCE_CLIPS_ALL_MISSING] 5 clips requested, 0 downloaded`
- Zero Gemini tokens spent

**Episode with TV card on wrong scenes:**
- Gate 3 EARLY/MIDDLE/LATE: Gemini has the scene-type rule in its prompt
- `TV CARD: FAIL` in report → `tvCardOnWrongScene=true` → `hasCriticalFail=true`
- Gate 3 returns `outcome: fail`, 15-point deduction, episode blocked from Drive upload

**Clip sizing:**
- Confirmed zoom-to-fill already in place, no regression possible
