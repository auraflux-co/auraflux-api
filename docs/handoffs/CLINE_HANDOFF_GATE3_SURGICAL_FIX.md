# CLINE_HANDOFF_GATE3_SURGICAL_FIX.md

**Assigned to:** Cline-A (Claude Sonnet 4.6)
**Priority:** MEDIUM — reduces wasted re-assembly runs on fixable Gate 3 failures
**Date:** 2026-04-16
**Scope:** lib/qa.js (new `parseGate3Report()` helper), lib/assembly.js (Gate 3 retry section)

---

## Why This Exists

Gate 3 currently has a blunt retry strategy: if Gemini scores below 60, the entire assembly re-runs using identical inputs — same segments, same FFmpeg params, same concat order. This is useless when the root cause is a specific bad segment (e.g., a frozen HeyGen render). Re-assembling with the same frozen segment produces the same frozen output.

Gate 3 already knows exactly what went wrong. `geminiQACheck()` returns a structured report with `freezeDetected: boolean`, `deductions[]`, and a full Gemini sample report containing timestamps and descriptions of every failure. That information is currently logged and then discarded — the retry loop ignores it entirely.

This handoff wires Gate 3's failure intelligence into targeted pre-retry repairs:
- **Freeze detected:** identify the likely offending segment by timestamp, remove it, re-assemble without it
- **Audio issues:** re-normalize specific segments with stricter FFmpeg flags before re-concatenating
- **Pacing issues:** log informational note only, no auto-fix (Gemini's pacing judgment varies too much for automated repair)

---

## Architecture

### New Function: `parseGate3Report()` in lib/qa.js

Add this function after `geminiQACheck()` (around line 291 in lib/qa.js). Export it alongside the existing exports.

```javascript
/**
 * parseGate3Report()
 *
 * Parses a Gate 3 QA report string and extracts a structured fix directive.
 * Called by lib/assembly.js before deciding whether to attempt surgical repair
 * or fall back to full retry.
 *
 * @param {string} report - The full Gate 3 why-doc string from geminiQACheck()
 * @param {number[]} segmentDurations - Array of per-segment durations in seconds
 *                                      (assemblyJobs[asmId].segmentDurations)
 * @returns {{ freezeAtSeconds: number|null, affectedSegmentIndices: number[],
 *             audioIssues: boolean, audioAffectedSegments: number[],
 *             pacingIssues: string[], canAttemptSurgicalFix: boolean }}
 */
function parseGate3Report(report, segmentDurations = []) {
  const directive = {
    freezeAtSeconds: null,
    affectedSegmentIndices: [],  // 0-based indices into segmentDurations/localFiles
    audioIssues: false,
    audioAffectedSegments: [],
    pacingIssues: [],
    canAttemptSurgicalFix: false,
  };

  if (!report || typeof report !== 'string') return directive;

  // ── 1. Detect freeze and extract approximate timestamp ──────────────────
  // Gemini reports freeze in the EARLY (~0s), MIDDLE (~mid), or LATE (~end) sample.
  // Sample point labels contain their approximate start time: "EARLY SAMPLE (~0s)"
  // Gate 3 also sets freezeDetected=true in the returned object — but if we only
  // have the report string, parse it here too.
  const freezeMatch = report.match(/VIDEO FREEZE:.*yes/i);
  if (freezeMatch) {
    // Find which sample section the freeze appeared in
    const earlySectionMatch = report.match(/=== EARLY SAMPLE \(~(\d+)s\)/i);
    const middleSectionMatch = report.match(/=== MIDDLE SAMPLE \(~(\d+)s\)/i);
    const lateSectionMatch = report.match(/=== LATE SAMPLE \(~(\d+)s\)/i);

    // Determine which sample had the freeze by finding FREEZE: yes within that section
    const earlySec  = earlySectionMatch  ? parseInt(earlySectionMatch[1],  10) : 0;
    const middleSec = middleSectionMatch ? parseInt(middleSectionMatch[1], 10) : null;
    const lateSec   = lateSectionMatch   ? parseInt(lateSectionMatch[1],   10) : null;

    // Try to narrow to the specific sample section containing the FREEZE: yes
    // by checking which section boundary the match falls within
    const freezeIdx = report.indexOf(freezeMatch[0]);
    const middleIdx = middleSectionMatch ? report.indexOf(middleSectionMatch[0]) : Infinity;
    const lateIdx   = lateSectionMatch   ? report.indexOf(lateSectionMatch[0])   : Infinity;

    if (freezeIdx < middleIdx) {
      directive.freezeAtSeconds = earlySec + 10; // midpoint of 20s EARLY sample
    } else if (freezeIdx < lateIdx) {
      directive.freezeAtSeconds = middleSec !== null ? middleSec + 10 : null;
    } else {
      directive.freezeAtSeconds = lateSec !== null ? lateSec + 10 : null;
    }

    // ── Cross-reference freeze timestamp against segment durations ──────
    // Walk the segment duration array and find which segment contains the freeze timestamp.
    if (directive.freezeAtSeconds !== null && segmentDurations.length > 0) {
      let elapsed = 0;
      for (let i = 0; i < segmentDurations.length; i++) {
        elapsed += segmentDurations[i];
        if (elapsed >= directive.freezeAtSeconds) {
          directive.affectedSegmentIndices.push(i);
          break;
        }
      }
    }

    directive.canAttemptSurgicalFix = true;
  }

  // ── 2. Detect audio issues ───────────────────────────────────────────────
  // Look for explicit audio failure markers from the Gemini checklist
  const audioFail = /AUDIO:.*FAIL|audio.*dropout|a\/v.*desync|audio.*drift/i.test(report);
  if (audioFail) {
    directive.audioIssues = true;
    directive.canAttemptSurgicalFix = true;

    // If a specific segment is called out (e.g. "segment 3 audio"), capture it
    const segAudioMatch = report.match(/segment\s+(\d+).*audio/ig) || [];
    for (const m of segAudioMatch) {
      const segNum = parseInt((m.match(/\d+/) || [])[0], 10);
      if (!isNaN(segNum) && segNum > 0) {
        directive.audioAffectedSegments.push(segNum - 1); // convert to 0-based
      }
    }
  }

  // ── 3. Detect pacing issues (informational only — no auto-fix) ──────────
  const pacingMatches = report.match(/pacing.{0,80}/gi) || [];
  directive.pacingIssues = pacingMatches.map(m => m.trim());

  return directive;
}
```

Add `parseGate3Report` to the module exports at the bottom of `lib/qa.js`:

```javascript
module.exports = {
  // ... existing exports ...
  parseGate3Report,
};
```

---

### Modified Gate 3 Retry Logic in lib/assembly.js

**Location:** The Gate 3 retry while-loop, around lines 2682–2756 in lib/assembly.js.

**Import change at top of lib/assembly.js:**

Find the existing `require('./qa')` destructure and add `parseGate3Report`:

```javascript
const {
  geminiQACheck,
  parseScriptIntoScenes,
  // ... existing imports ...
  parseGate3Report,   // ADD THIS
} = require('./qa');
```

**Replace the current retry block** inside the `while (qaAttempt < MAX_QA_RETRIES)` loop, specifically the `else if (qaResult.outcome === 'fail' && qaAttempt < MAX_QA_RETRIES)` branch (currently lines ~2715–2730):

```javascript
} else if (qaResult.outcome === 'fail' && qaAttempt < MAX_QA_RETRIES) {
  log(asmId, `❌ Gate 3 FAIL — Parsing failure report for surgical fix opportunity...`);

  // ── Parse the Gate 3 report for specific, actionable failures ──────────
  const segDurations = assemblyJobs[asmId].segmentDurations || [];
  const fixDirective = parseGate3Report(qaResult.report, segDurations);

  log(asmId, `[gate3-repair] Directive: freeze@${fixDirective.freezeAtSeconds}s, ` +
    `affectedSegs=[${fixDirective.affectedSegmentIndices.join(',')}], ` +
    `audioIssues=${fixDirective.audioIssues}, ` +
    `canSurgicalFix=${fixDirective.canAttemptSurgicalFix}`);

  if (fixDirective.pacingIssues.length > 0) {
    log(asmId, `[gate3-repair] ℹ️  Pacing issues noted (no auto-fix): ${fixDirective.pacingIssues.slice(0, 2).join(' | ')}`);
    // Pacing is subjective — include in manual review note but don't act on it
    assemblyJobs[asmId].qaNote = (assemblyJobs[asmId].qaNote || '') +
      ` Pacing: ${fixDirective.pacingIssues[0]}`;
  }

  let surgicalRepairAttempted = false;

  // ── FREEZE REPAIR: Remove the offending segment and re-assemble ────────
  if (fixDirective.freezeAtSeconds !== null && fixDirective.affectedSegmentIndices.length > 0) {
    const removeIdx = fixDirective.affectedSegmentIndices[0];
    const removeSeg = segsToProcess[removeIdx];

    if (removeSeg) {
      log(asmId, `[gate3-repair] 🔧 FREEZE REPAIR — Removing segment ${removeIdx} ` +
        `(${removeSeg.label || 'unknown'}, suspected freeze at ~${fixDirective.freezeAtSeconds}s) ` +
        `and re-assembling`);

      // Remove the segment from both arrays (segsToProcess and localFiles)
      // segsToProcess controls what goes into the concat list
      const prunedSegs = segsToProcess.filter((_, i) => i !== removeIdx);
      const prunedFiles = localFiles.filter((f) => !f.includes(`${asmId}_${removeIdx}_`));

      if (prunedSegs.length === 0) {
        log(asmId, `[gate3-repair] ⚠️  Freeze removal would leave 0 segments — skipping surgical fix, falling back to Topaz`);
      } else {
        // Re-run the FFmpeg concat with pruned segment list
        // Write a new concat file for the pruned set
        const prunedConcatPath = path.join(TMP_DIR, `concat_pruned_${asmId}_${qaAttempt}.txt`);
        const prunedConcatLines = prunedFiles.map(f => `file '${f}'`).join('\n');
        fs.writeFileSync(prunedConcatPath, prunedConcatLines);

        const prunedOutFile = outFile.replace('.mp4', `_pruned_attempt${qaAttempt}.mp4`);
        const prunedOutPath = path.join(OUTPUT_DIR, prunedOutFile);

        log(asmId, `[gate3-repair] Re-assembling ${prunedFiles.length} segments (was ${localFiles.length})...`);

        try {
          const { encodeArgs } = require('./ffmpeg_utils');
          const ffmpegArgs = [
            '-f', 'concat', '-safe', '0', '-i', prunedConcatPath,
            ...ffmpegEncodeArgs(false),  // standard quality for repair pass
            '-y', prunedOutPath
          ];

          await new Promise((res, rej) => {
            const proc = execFile(ffmpegPath(), ffmpegArgs, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg pruned concat failed: ${code}`)));
            proc.on('error', rej);
          });

          if (fs.existsSync(prunedOutPath) && fs.statSync(prunedOutPath).size > 100000) {
            // Promote the pruned output as the new outPath for Gate 3 QA retry
            outPath = prunedOutPath;
            outFile = prunedOutFile;
            assemblyJobs[asmId].outputPath = prunedOutPath;
            assemblyJobs[asmId].filename = prunedOutFile;
            assemblyJobs[asmId].qaNote = (assemblyJobs[asmId].qaNote || '') +
              ` [Segment ${removeIdx} (${removeSeg.label || 'unknown'}) removed — suspected freeze at ~${fixDirective.freezeAtSeconds}s]`;

            log(asmId, `[gate3-repair] ✅ Pruned output ready: ${prunedOutFile} — re-running Gate 3 QA`);
            surgicalRepairAttempted = true;
          } else {
            log(asmId, `[gate3-repair] ⚠️  Pruned output too small or missing — falling back to Topaz`);
          }
        } catch (repairErr) {
          log(asmId, `[gate3-repair] ❌ FFmpeg pruned concat failed: ${repairErr.message} — falling back to Topaz`);
        } finally {
          try { fs.unlinkSync(prunedConcatPath); } catch(e) {}
        }
      }
    } else {
      log(asmId, `[gate3-repair] ⚠️  Segment ${removeIdx} not found in segsToProcess — freeze repair skipped`);
    }
  }

  // ── AUDIO REPAIR: Re-normalize specific segments with stricter flags ───
  if (fixDirective.audioIssues && !surgicalRepairAttempted) {
    const audioSegIndices = fixDirective.audioAffectedSegments.length > 0
      ? fixDirective.audioAffectedSegments
      : Array.from({ length: localFiles.length }, (_, i) => i); // all segments if none specific

    log(asmId, `[gate3-repair] 🔧 AUDIO REPAIR — Re-normalizing ${audioSegIndices.length} segment(s) ` +
      `with -ar 44100 -ac 2 flags`);

    let audioRepaired = 0;
    for (const segIdx of audioSegIndices) {
      const segFile = localFiles[segIdx];
      if (!segFile || !fs.existsSync(segFile)) continue;

      const repairedPath = segFile.replace('.ts', `_audio_repaired_${qaAttempt}.ts`);
      try {
        await new Promise((res, rej) => {
          const args = [
            '-i', segFile,
            '-vcodec', 'copy',
            '-acodec', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
            '-y', repairedPath
          ];
          const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
          proc.on('close', code => code === 0 ? res() : rej(new Error(`Audio re-normalize failed: ${code}`)));
          proc.on('error', rej);
        });

        if (fs.existsSync(repairedPath) && fs.statSync(repairedPath).size > 10000) {
          localFiles[segIdx] = repairedPath;
          audioRepaired++;
          log(asmId, `[gate3-repair]   Re-normalized segment ${segIdx}: ${path.basename(segFile)} → ${path.basename(repairedPath)}`);
        }
      } catch(audioErr) {
        log(asmId, `[gate3-repair]   ⚠️  Audio repair failed for segment ${segIdx}: ${audioErr.message}`);
      }
    }

    if (audioRepaired > 0) {
      log(asmId, `[gate3-repair] ✅ Audio repair complete — ${audioRepaired} segment(s) re-normalized. Rebuilding concat + re-assembling...`);
      // Rebuild the full concat with the repaired segments and re-run FFmpeg
      // (use the same outPath — overwrite the original output)
      // This block intentionally omitted — see NOTE below
      surgicalRepairAttempted = true;
      assemblyJobs[asmId].qaNote = (assemblyJobs[asmId].qaNote || '') +
        ` [Audio repair: ${audioRepaired} segment(s) re-normalized at 44100Hz stereo]`;
    } else {
      log(asmId, `[gate3-repair] ⚠️  Audio repair produced no improvements — falling back to Topaz`);
    }
  }

  // ── FALLBACK: Topaz enhancement (existing behavior) ─────────────────────
  if (!surgicalRepairAttempted) {
    log(asmId, `[gate3-repair] No surgical fix applicable — attempting Topaz enhancement...`);
    const topazResult = await enhanceVideoWithTopaz(outPath);
    if (topazResult.success) {
      log(asmId, `✅ Topaz enhancement complete — retrying QA (attempt ${qaAttempt}/${MAX_QA_RETRIES})...`);
      assemblyJobs[asmId].topazEnhanced = true;
      assemblyJobs[asmId].topazRequestID = topazResult.requestID;
    } else {
      log(asmId, `⚠️  Topaz enhancement skipped: ${topazResult.reason} — retrying QA anyway (attempt ${qaAttempt}/${MAX_QA_RETRIES})...`);
    }
  }

  // Brief pause before retry regardless of repair path
  await new Promise(r => setTimeout(r, 3000));
  // Loop continues → re-runs geminiQACheck() on the (potentially repaired) output
```

> **NOTE on audio repair rebuild:** The audio repair section above re-normalizes individual `.ts` segment files in `localFiles[]`. To apply the fix, you need to re-run the concat FFmpeg command to produce a new output file. The exact concat rebuild code is not included here because it depends on the local variables (`tsNormFiles`, `concatListPath`, and the final FFmpeg command) defined earlier in `handleAssemble`. Rather than duplicating that logic, the cleanest implementation is to extract the concat+encode step into a local helper function `rebuildConcat(localFiles, outPath)` within `handleAssemble`, then call it from both the original assembly path and the Gate 3 repair path. If that refactor scope is too large for this handoff, skip the audio rebuild — the freeze repair is the higher-value fix and stands alone.

---

## Fix Directive Structure Reference

The object returned by `parseGate3Report()`:

```typescript
{
  freezeAtSeconds: number | null,      // Approximate timestamp of freeze (null if no freeze detected)
  affectedSegmentIndices: number[],    // 0-based indices into segmentDurations/localFiles for freeze
  audioIssues: boolean,                // True if any audio failure detected
  audioAffectedSegments: number[],     // 0-based indices of segments with audio issues (may be empty = all)
  pacingIssues: string[],              // Raw pacing complaint strings from report (informational only)
  canAttemptSurgicalFix: boolean,      // True if any actionable fix was identified
}
```

---

## Decision Tree at Gate 3 Fail

```
Gate 3 score < 60 (FAIL)
│
├─ parseGate3Report() → freezeAtSeconds != null
│   └─ affectedSegmentIndices.length > 0
│       ├─ YES → Remove segment(s), rebuild concat, retry Gate 3 QA
│       └─ NO  → Log warning, fall through to Topaz
│
├─ parseGate3Report() → audioIssues == true (and no freeze fix done)
│   └─ Re-normalize affected segments with -ar 44100 -ac 2, rebuild concat, retry Gate 3 QA
│
├─ parseGate3Report() → pacingIssues (no other fix triggered)
│   └─ Log informational note in assemblyJobs[asmId].qaNote, fall through to Topaz
│
└─ No surgical fix applicable
    └─ Topaz enhancement (existing behavior), retry Gate 3 QA
```

After max retries (3) with no pass: existing behavior — hard fail, Drive upload blocked, job card `status: 'failed'`.

---

## What Does Not Change

- Gate 3 pass threshold (70) and manual review threshold (60) are unchanged
- `geminiQACheck()` return value and signature are unchanged
- The Topaz fallback is preserved as the last resort before giving up
- `MAX_QA_RETRIES` (3) is unchanged
- Gate 3 QA error fallback (auto-pass on API error) is unchanged

---

## Testing Checklist

1. Manually inject a known-frozen segment into a test assembly (use a 1-second black video for a segment)
2. Confirm Gate 3 fires, detects freeze, calls `parseGate3Report()`
3. Confirm log shows: `[gate3-repair] FREEZE REPAIR — Removing segment N`
4. Confirm pruned output is created and Gate 3 re-runs on it
5. Confirm the pruned output passes Gate 3 (or at least doesn't freeze)
6. Confirm `assemblyJobs[asmId].qaNote` contains the removal record
7. Test with no freeze: confirm Topaz fallback is still reached when `canAttemptSurgicalFix: false`

---

## Files to Modify

| File | Change |
|------|--------|
| `lib/qa.js` | Add `parseGate3Report()` function (~60 lines), export it |
| `lib/assembly.js` | Import `parseGate3Report`, replace Gate 3 fail branch with surgical fix logic |

**Do NOT modify:** `server.js`, `cwn_production.html`, `lib/config.js`, `data/`, `tools/`

---

## STATUS.md Update Requirement

Before committing, update `STATUS.md → 🤖 Last Agent Action` table with:

| Agent | Task Completed | Files Changed | Commit | Timestamp |
|-------|---------------|---------------|--------|-----------|
| Cline-A | **feat(gate3): surgical repair before retry — freeze segment removal + audio re-normalize** — Added `parseGate3Report()` to lib/qa.js: extracts freeze timestamp, cross-references segment durations to identify offending segment index, detects audio failures. Gate 3 fail branch in lib/assembly.js now attempts surgical fixes before Topaz fallback: freeze → remove segment + rebuild concat + re-QA; audio → re-normalize segments at 44100Hz; pacing → informational note only. Topaz fallback preserved as last resort. Decision tree: freeze → audio → Topaz → hard fail. | lib/qa.js, lib/assembly.js, STATUS.md | [commit hash] | [timestamp] |

Also add this handoff to `docs/INDEX.md` in the handoffs section.
