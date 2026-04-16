# CLINE HANDOFF — Gate 1 QA Directive Feedback Loop

**Handoff ID:** CLINE_HANDOFF_GATE1_QA_FEEDBACK_LOOP
**Priority:** High — reduces Gate 1 retry waste
**Assigned to:** Cline-A (Claude Sonnet 4.6)
**Files to modify:** `lib/qa.js`, `lib/script_gen.js`
**Estimated effort:** Medium (~80 lines changed across 2 files)
**Status:** Ready for implementation
**Created:** 2026-04-16

---

## Problem

Gate 1 retry feedback is generic coaching text, not surgical directives.

When a script fails Gate 1, `script_gen.js` builds `feedbackMsg` from `scriptQA.deductions` plus a list of keyword-matched suggestions (lines 2032-2078). The result is a blob of encouragement like "SCENE COUNT: You MUST write EXACTLY ONE SCENE PER HEADER..." that repeats the original prompt rules.

Gemini receives this coaching alongside `previousScript` and regenerates — but from a blank-slate mindset, not a targeted correction. Three failure types recur despite retries:

1. **Wrong scene count** — Gemini knows it wrote the wrong number but doesn't know which headers are missing. It guesses.
2. **Fabricated story content** — Gemini knows a story was flagged but doesn't know what the clip actually contains. It invents again.
3. **Wrong display names** — Gemini knows a name was wrong but may not know the correct replacement.

Claude's QA prompt output (`claudeReport`) contains all three diagnoses in detail — but this detail is never parsed into structured form and never fed back to Gemini in a machine-readable way.

Additionally, `MAX_RETRIES = 3` in `script_gen.js` (line 1995) while `autoAction()` in `lib/qa.js` only allows 1 retry for scores <70 (line 1411-1412). The constants are mismatched and `MAX_RETRIES = 3` is dead for the <70 path.

---

## Solution: Gate 1 QA Fix Directive

### Overview

1. Extend `claudeScriptQA()` return value with a `fixDirective` field — a structured object extracted from Claude's QA output.
2. Extend the Claude QA prompt to output a `FIX_DIRECTIVE` JSON block after the score.
3. In `script_gen.js` retry loop, build `feedbackMsg` from `fixDirective` fields instead of regex-matched keyword suggestions.
4. Reduce `MAX_RETRIES` from 3 to 2 (1 targeted retry is worth more than 3 blind ones; aligns with `autoAction()` max-1-retry constraint for <70 scores).

---

## Implementation

### Step 1 — Extend the Claude QA prompt in `lib/qa.js`

**Location:** `lib/qa.js` — the `qaPrompt` string that ends at line 632.

The current prompt ends with:

```
Respond in this exact format:

SCORE: [0-100]
ISSUES:
- [CHECK NAME]: [what's wrong] → [what it should be]
[list all issues, or write "None" if PASS on all checks]
```

Replace that response format block with the following (the new block adds the `FIX_DIRECTIVE` JSON section after `ISSUES`):

```javascript
// BEFORE (lines 626-632):
`Respond in this exact format:

SCORE: [0-100]
ISSUES:
- [CHECK NAME]: [what's wrong] → [what it should be]
[list all issues, or write "None" if PASS on all checks]`

// AFTER:
`Respond in this exact format:

SCORE: [0-100]
ISSUES:
- [CHECK NAME]: [what's wrong] → [what it should be]
[list all issues, or write "None" if PASS on all checks]

FIX_DIRECTIVE:
\`\`\`json
{
  "missingScenes": [],
  "fabricatedContent": [],
  "nameErrors": [],
  "structuralIssues": []
}
\`\`\`

Rules for filling FIX_DIRECTIVE:
- missingScenes: list every scene header that is in the expected set but absent from the script. Example: ["STORY3_REACTION", "STORY4_INTRO", "STORY4_SETUP", "STORY4_SUMMARY", "STORY4_CLIP", "STORY4_REACTION", "STORY5_INTRO"]. Leave empty [] if scene count is correct.
- fabricatedContent: for each scene whose spoken text does not match the clip analysis, write an object: { "scene": "STORY2_INTRO", "problem": "describes a CEO resignation but clip is about a wildfire evacuation", "fix": "rewrite using these facts from the clip: [paste relevant clip analysis text here]" }. Leave empty [] if all content is accurate.
- nameErrors: for each wrong name used, write an object: { "used": "Jaycinco", "correct": "Jay Cinco" }. Leave empty [] if all names are correct.
- structuralIssues: list any structural failures not covered above. Examples: "OUTRO missing — must end with Appreciate you!", "INTRO is 1 sentence — must be 2-3 sentences". Leave empty [] if structure is correct.
- If the script passes all checks, output all four arrays as empty [].
- Output VALID JSON only — no trailing commas, no comments inside the json block.`
```

**Critical:** The `FIX_DIRECTIVE` block must appear even when the script passes. Cline should add this to the prompt regardless of outcome — an empty-arrays response on a passing script is fine. The retry loop in `script_gen.js` only uses `fixDirective` when `scriptQA.outcome === 'fail'`.

---

### Step 2 — Parse `FIX_DIRECTIVE` in `claudeScriptQA()` return value

**Location:** `lib/qa.js` lines 770-780 — the `return` block at the end of `claudeScriptQA()`.

Add a `fixDirective` parser after `claudeReport` is assigned (after line 648, before the score parsing block at line 657). Parse the JSON from `claudeReport`:

```javascript
// Add this block after line 648 (after claudeReport is assigned), before line 657:
let fixDirective = { missingScenes: [], fabricatedContent: [], nameErrors: [], structuralIssues: [] };
try {
  const directiveMatch = claudeReport.match(/FIX_DIRECTIVE:\s*```json\s*([\s\S]*?)```/i);
  if (directiveMatch) {
    const parsed = JSON.parse(directiveMatch[1].trim());
    fixDirective = {
      missingScenes:     Array.isArray(parsed.missingScenes)     ? parsed.missingScenes     : [],
      fabricatedContent: Array.isArray(parsed.fabricatedContent) ? parsed.fabricatedContent : [],
      nameErrors:        Array.isArray(parsed.nameErrors)        ? parsed.nameErrors        : [],
      structuralIssues:  Array.isArray(parsed.structuralIssues)  ? parsed.structuralIssues  : []
    };
  }
} catch(e) {
  // JSON parse failed — fixDirective stays as empty defaults, retry will use fallback coaching
  console.warn(`[qa-gate1] FIX_DIRECTIVE parse failed: ${e.message}`);
}
```

Then add `fixDirective` to the return object at line 771-780:

```javascript
// BEFORE:
return {
  score: adjustedScore,
  report: whyDoc,
  passed,
  outcome,
  outcomeLabel,
  deductions: preCheckDeductions,
  claudeReport,
  tokenUsage
};

// AFTER:
return {
  score: adjustedScore,
  report: whyDoc,
  passed,
  outcome,
  outcomeLabel,
  deductions: preCheckDeductions,
  claudeReport,
  fixDirective,
  tokenUsage
};
```

---

### Step 3 — Reduce `MAX_RETRIES` in `lib/script_gen.js`

**Location:** `lib/script_gen.js` line 1995.

```javascript
// BEFORE:
const MAX_RETRIES = 3;

// AFTER:
const MAX_RETRIES = 2;
```

Rationale: `autoAction()` in `lib/qa.js` already limits the <70 path to 1 retry (lines 1411-1412). `MAX_RETRIES = 3` means the while-loop could run 3 times even though `autoAction()` will return `GATE1_HARD_FAIL` on the second retry. Aligning the constant to 2 makes the loop terminate correctly: attempt 1 (initial) → attempt 2 (1 targeted retry) → done. The 70-89 manual_review path already breaks the loop at line 2162, so reducing MAX_RETRIES does not affect that path.

---

### Step 4 — Replace `feedbackMsg` builder in `lib/script_gen.js`

**Location:** `lib/script_gen.js` lines 2029-2080 — the entire `if (retryAttempt > 1 && scriptQA)` block.

Replace the existing block (lines 2030-2080) with the following:

```javascript
if (retryAttempt > 1 && scriptQA) {
  const fd = scriptQA.fixDirective || {};
  const parts = [];

  // ── 1. Scene count directive ──────────────────────────────────────────
  if (fd.missingScenes && fd.missingScenes.length > 0) {
    const sceneCountFromDeductions = scriptQA.deductions?.find(d => d.reason?.includes('SCENE COUNT'));
    const foundCount  = sceneCountFromDeductions?.reason?.match(/Found (\d+)/)?.[1] || '?';
    const expectCount = sceneCountFromDeductions?.reason?.match(/expected (\d+)/)?.[1] || expectedScenes;
    parts.push(
      `🚨 SCENE COUNT — HARD FAIL\n` +
      `You wrote ${foundCount} scenes. The script MUST contain EXACTLY ${expectCount} scenes.\n` +
      `These scene headers are MISSING from your output — add them:\n` +
      fd.missingScenes.map(s => `  • ${s}`).join('\n') + '\n' +
      `Do NOT rename, combine, or skip any scene. Each header must appear exactly once.`
    );
  }

  // ── 2. Fabricated content directives ─────────────────────────────────
  if (fd.fabricatedContent && fd.fabricatedContent.length > 0) {
    parts.push(
      `🚨 FABRICATED CONTENT — HARD FAIL\n` +
      `The following scenes describe events that are NOT in the clip. Rewrite them using ONLY the facts below:\n` +
      fd.fabricatedContent.map(f =>
        `  SCENE: ${f.scene}\n  PROBLEM: ${f.problem}\n  REQUIRED FIX: ${f.fix}`
      ).join('\n\n')
    );
  }

  // ── 3. Name error directives ──────────────────────────────────────────
  if (fd.nameErrors && fd.nameErrors.length > 0) {
    parts.push(
      `🚨 WRONG DISPLAY NAMES — HARD FAIL\n` +
      `These names were wrong. Replace them everywhere in the script:\n` +
      fd.nameErrors.map(n => `  "${n.used}" → "${n.correct}"`).join('\n')
    );
  }

  // ── 4. Structural issue directives ────────────────────────────────────
  if (fd.structuralIssues && fd.structuralIssues.length > 0) {
    parts.push(
      `🚨 STRUCTURAL ISSUES:\n` +
      fd.structuralIssues.map(s => `  • ${s}`).join('\n')
    );
  }

  // ── 5. Fallback if fixDirective was empty (parse failure or unexpected pass) ──
  if (parts.length === 0) {
    const deductionsList = scriptQA.deductions?.map(d => `- ${d.reason} (-${d.points} points)`).join('\n') || 'See detailed report below';
    parts.push(
      `POINT DEDUCTIONS FROM PREVIOUS ATTEMPT:\n${deductionsList}\n\n` +
      `FULL QA REPORT:\n${scriptQA.claudeReport || scriptQA.report}`
    );
  }

  feedbackMsg = `\n\n⚠️ PREVIOUS ATTEMPT FAILED GATE 1 QA (Score: ${scriptQA.score}/100)\n\n` +
    `These are the EXACT issues that caused the failure. Fix ALL of them before resubmitting:\n\n` +
    parts.join('\n\n') +
    `\n\nGenerate the COMPLETE script with ALL issues above resolved. Do not leave any issue partially fixed.`;

  console.log(`[generate-full-script] 🔄 Gate 1 retry with structured fix directive: ` +
    `${fd.missingScenes?.length || 0} missing scenes, ` +
    `${fd.fabricatedContent?.length || 0} fabricated scenes, ` +
    `${fd.nameErrors?.length || 0} name errors, ` +
    `${fd.structuralIssues?.length || 0} structural issues`);
}
```

---

## Pre-Check: What Already Exists (Do Not Duplicate)

Before editing, note these existing mechanisms that the new code integrates with — do NOT replace them:

- **`wrongSceneCount` pre-check** (`lib/qa.js` lines 692-695) — already deducts 25 points and sets `deductions[]`. The new `fixDirective.missingScenes` is the complement: it tells Gemini WHICH scenes are missing, not just that the count is wrong. Both coexist.
- **`claudeScriptFix()`** (`lib/qa.js` line 783) — handles clip-match-only failures by asking Claude to surgically fix specific scenes. The new directive feedback targets Gemini retries (structural failures). Both coexist — `claudeScriptFix` still runs on the `isClipMatchOnly` path in `script_gen.js` lines 2190-2213.
- **`autoAction()`** constraint — `retryCount === 0` check in `autoAction()` (line 1411) governs whether `regenerate_script` is returned. The retry loop in `script_gen.js` calls `autoAction()` at line 2147 and passes `retryCount: retryAttempt - 1`. This logic is unchanged; only the `feedbackMsg` content changes.
- **Header normalization** (`script_gen.js` lines 2097-2102) — the `===\s+...\s+===` space-to-underscore replacement still runs after every Gemini generation, including retries. Do not remove.

---

## Testing

After implementing, test with a content type that has historically produced scene count failures (News or Twitch with 10 streamers):

1. Trigger `/generate-full-script` for a news or twitch job.
2. On the second attempt (if Gate 1 fails), check the server log for:
   ```
   [generate-full-script] 🔄 Gate 1 retry with structured fix directive: X missing scenes, Y fabricated scenes, ...
   ```
3. If `FIX_DIRECTIVE` parse fails, log should show:
   ```
   [qa-gate1] FIX_DIRECTIVE parse failed: ...
   ```
   and the retry should fall back to the deductions-list coaching (part 5 of the `parts` array above). This is the safe path — no regression.
4. Verify that a passing Gate 1 script still returns `fixDirective` with all-empty arrays (not undefined).

---

## STATUS.md Update Required

When you commit this work, update `STATUS.md → 🤖 Last Agent Action` with:

```
| Cline-A | **feat(gate1): structured fix directive feedback loop** — Extended claudeScriptQA() return to include fixDirective {missingScenes, fabricatedContent, nameErrors, structuralIssues}. Added FIX_DIRECTIVE JSON block to Claude QA prompt. Replaced generic coaching in script_gen.js retry loop with structured directives targeting exact missing scenes, fabricated content, wrong names. Reduced MAX_RETRIES 3→2 to align with autoAction() 1-retry constraint. Fallback to deductions-list coaching if FIX_DIRECTIVE parse fails. | lib/qa.js, lib/script_gen.js, STATUS.md | [commit hash] | [timestamp] |
```

---

## File Lock

Declare a lock in `STATUS.md → 🔒 Active File Locks` before your first edit:

```
| lib/qa.js | Cline-A | CLINE_HANDOFF_GATE1_QA_FEEDBACK_LOOP | [timestamp] |
| lib/script_gen.js | Cline-A | CLINE_HANDOFF_GATE1_QA_FEEDBACK_LOOP | [timestamp] |
```

Remove both rows after commit.

---

## Rollback

If the `FIX_DIRECTIVE` JSON parse produces malformed directives that make Gemini output worse:

1. In `lib/qa.js`: revert the `qaPrompt` response-format block to the original `SCORE / ISSUES` format. Remove the `fixDirective` parser block and remove `fixDirective` from the return object.
2. In `lib/script_gen.js`: revert `MAX_RETRIES` to 3 and restore the original `if (retryAttempt > 1 && scriptQA)` block (lines 2031-2080 in the current codebase — git diff is the source of truth).

The fallback path (part 5 of `parts` array) means zero-regression risk at runtime — if `fixDirective` is empty, the retry behaves identically to the current coaching approach.
