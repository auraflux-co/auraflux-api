# Cline Handoff: Fix Gemini Clip Analysis Truncation (Task #14)

**Author:** Claude Code
**Date:** 2026-04-11
**Status:** 🟡 SMALL SURGICAL FIX — ~30 min Cline work, single atomic commit
**Priority:** Medium — unblocks Gate 1 auto-pass on smoke tests (currently forces FORCE ADVANCE workaround)
**Related:** Task #14 in STATUS.md task list, `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` (Phase 2 handoff — this fix is required before that handoff can ship cleanly)

---

## TL;DR

`geminiAnalyzeClip()` at `server.js:5622-5759` calls Gemini 2.5 Flash with `maxOutputTokens: 500` (line 5745). That cap is too small for the structured 4-section analysis prompt (line 5625-5632) to complete. Gemini returns `finishReason: MAX_TOKENS` and a truncated response — typically just the header of section 1 ("`Here's an analysis of the Twitch clip: 1. **Visually happening:**`") with no body content.

The truncated response propagates to `claudeScriptQA()` at Gate 1, which then correctly flags "CLIP MATCH: cannot verify accuracy due to incomplete clip descriptions" and deducts 15 points. Gate 1 scores 85/100, below the 90 auto-pass threshold, and hard-fails after 3 retries (all identical because the truncation is deterministic).

**Rob has been working around this by clicking FORCE ADVANCE on every smoke test.** This handoff fixes it properly so Gate 1 can auto-pass.

Two-part fix:

1. **Raise `maxOutputTokens` from 500 → 1500** for the video analysis call at `server.js:5745`
2. **Add `finishReason: MAX_TOKENS` detection** so future truncation bugs are flagged explicitly in logs instead of silently returning partial content

Plus a smaller companion fix for the thumbnail fallback at `server.js:5772` (raise from 200 → 500).

---

## Part 1 — Root cause analysis

### The bug

`server.js:5622` function `geminiAnalyzeClip(videoUrl, thumbnailUrl, contentType, metadata)`:

```javascript
const videoPrompts = {
  twitch: `This is a Twitch clip by streamer "${metadata.streamer || 'unknown'}". Game/category: ${metadata.game || 'unknown'}. Clip title: "${metadata.title || ''}".
Analyze the FULL video with audio:
1. What is visually happening — describe the specific key moment
2. What does the streamer say verbally — quote any notable lines exactly
3. What emotion or reaction is visible
4. What makes this clip notable or shareable
Be specific, factual, 4-6 sentences. No hype language.`,
  // nba and news similarly structured
};
```

The prompt asks Gemini for **4 sections × 4-6 sentences each** = roughly 20-24 sentences total, structured as numbered markdown. Realistic output at ~15-20 tokens per sentence × 20 sentences = 300-400 tokens of content alone, PLUS:

- Section headers ("`1. **Visually happening:**`" etc.) ≈ 20-30 tokens
- Markdown formatting overhead ≈ 20-40 tokens
- Optional intro sentence ("Here's an analysis of the Twitch clip:") ≈ 10-15 tokens

Realistic total: **500-700 tokens minimum**. The current `maxOutputTokens: 500` cap cuts Gemini off BEFORE it has room to produce the body of section 1, which is why the truncated output looks like `Here's an analysis of the Twitch clip: 1. **Visually happening:**` and nothing else.

### Evidence from the 2026-04-11 01:22 Gate 1 failure

See `output/qa_failures/gate1_script_fail_1775886258810.txt`:

```
**9. CLIP MATCH:** The clip descriptions are incomplete - both show
"Here's an analysis of the Twitch clip: 1. **Visually happening:**"
with no actual content. Cannot verify if setups match clips. FAIL
```

Both clips have IDENTICAL truncated output at identical byte positions. This is a deterministic token-limit hit, not a random API hiccup.

### Why the bug was invisible for so long

The downstream receiver, `claudeScriptQA()`, correctly identifies "incomplete clip descriptions" and deducts points. But it doesn't diagnose WHY they're incomplete. The bug looks like a Gate 1 quality issue ("CLIP MATCH deduction") when it's really a silent upstream truncation in Gemini's response handling.

Also, the `geminiScriptGeneration()` function (a DIFFERENT function at `server.js:1706-1786`) already has proper `finishReason === 'MAX_TOKENS'` detection (see line 1776-1778). But `geminiAnalyzeClip()` was written without that guard, so truncation fails silently.

---

## Part 2 — The fix

### Change #1 — Raise video analysis token limit

**File:** `server.js`
**Line:** 5745

```diff
-          generationConfig: { maxOutputTokens: 500, temperature: 0.2 }
+          generationConfig: { maxOutputTokens: 1500, temperature: 0.2 }
```

**Rationale:** 1500 tokens gives Gemini ~3× headroom over the expected output size (500-700 tokens typical). Gemini 2.5 Flash supports up to 65,536 output tokens, so 1500 is nowhere near the model's limit. Cost increase is negligible (Gemini pricing is per-million-tokens; raising from 500 → 1500 per call × ~60 clips/month = ~60,000 extra tokens/month ≈ $0.02/month additional cost).

### Change #2 — Add finishReason detection + length sanity check

**File:** `server.js`
**Lines:** 5750-5752 (current)

Current code:
```javascript
const analysis = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
console.log(`[gemini-video] ✓ Video analysis complete (${analysis.length} chars)`);
return analysis;
```

Replace with:
```javascript
const candidate = genResp.data?.candidates?.[0];
const finishReason = candidate?.finishReason;
const analysis = (candidate?.content?.parts || []).map(p => p.text||'').join('').trim();

if (finishReason === 'MAX_TOKENS') {
  console.error(`[gemini-video] ⚠️ TRUNCATED (finishReason=MAX_TOKENS, maxOutputTokens=1500) — got ${analysis.length} chars, Gate 1 CLIP MATCH may fail. Consider raising the limit if this repeats.`);
} else if (analysis.length < 100) {
  console.warn(`[gemini-video] ⚠️ Analysis suspiciously short (${analysis.length} chars, finishReason=${finishReason}) — Gate 1 may flag as incomplete.`);
} else {
  console.log(`[gemini-video] ✓ Video analysis complete (${analysis.length} chars, finishReason=${finishReason})`);
}

return analysis;
```

**Rationale:** Matches the pattern already used in `geminiScriptGeneration()` at line 1776-1778. Makes future truncation bugs visible in server logs immediately instead of silently propagating downstream. Does NOT throw — the function still returns whatever content Gemini produced, so the caller can decide whether to use it. Logging-only change.

### Change #3 — Raise thumbnail fallback token limit

**File:** `server.js`
**Line:** 5772

```diff
-        generationConfig: { maxOutputTokens: 200, temperature: 0.2 } },
+        generationConfig: { maxOutputTokens: 500, temperature: 0.2 } },
```

**Rationale:** The thumbnail fallback path (`thumbPrompts`) asks for "2-3 sentences, factual" which is smaller than video analysis, but 200 tokens is STILL too tight for structured output with markdown. 500 tokens gives ~2.5× headroom for 2-3 sentences. This path is only used when the full video analysis fails, so it's less critical, but same bug class and worth fixing in the same commit.

### Change #4 (optional) — Mirror the finishReason check for the thumbnail path

**File:** `server.js`
**Line:** 5775

Current:
```javascript
return (gResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
```

Replace with:
```javascript
const tCandidate = gResp.data?.candidates?.[0];
const tFinishReason = tCandidate?.finishReason;
const tAnalysis = (tCandidate?.content?.parts || []).map(p => p.text||'').join('').trim();
if (tFinishReason === 'MAX_TOKENS') {
  console.warn(`[gemini-thumb] ⚠️ Thumbnail analysis TRUNCATED (maxOutputTokens=500) — got ${tAnalysis.length} chars`);
}
return tAnalysis;
```

Same pattern as Change #2, applied to the fallback path. Optional but consistent.

---

## Part 3 — Test plan

### Test 1 — Before fix (verify bug reproduces)

On main branch WITHOUT this fix:
1. Run the Jason 2-clip smoke test per `OVERNIGHT_STATUS.md` Morning Checklist
2. Check `output/qa_failures/gate1_script_fail_*.txt` for the most recent failure
3. Grep for "CLIP MATCH" — should show "cannot verify accuracy due to incomplete clip descriptions"
4. Score should be 85/100

### Test 2 — After fix (verify bug is fixed)

Apply the 4 changes above, commit, nodemon auto-restarts, then:
1. Wipe stale job state: `echo '{}' > data/jobs.json`
2. Clear browser localStorage
3. Run the Jason 2-clip smoke test again
4. Watch `logs/` output during Gate 1 — should NOT see "TRUNCATED" warning from the new detection logic
5. Gate 1 should now score ≥90 and auto-pass (no FORCE ADVANCE needed)
6. Check `output/qa_failures/gate1_script_pass_*.txt` for the passing report
7. Grep for "CLIP MATCH" in the new report — should show a complete multi-sentence analysis of each clip

### Test 3 — Verify the console warning fires on deliberate truncation

To prove the detection logic works, temporarily set `maxOutputTokens: 100` (artificially tight), run one clip analysis, confirm the `[gemini-video] ⚠️ TRUNCATED` warning appears in the server terminal. Then revert to 1500 and ship.

**Optional:** do Test 3 in a throwaway commit and revert; don't ship it.

### Test 4 — NBA and News content types

The same `geminiAnalyzeClip()` function is used for all 3 content types (twitch/nba/news). After the fix:
1. Run a 1-game NBA smoke test (manually trigger via dashboard NBA card)
2. Run a 1-story news smoke test
3. Verify Gate 1 passes cleanly for both (≥90) without needing FORCE ADVANCE
4. If NBA or news score <90, the fix may need further tuning for those prompts — they have different section structures in `videoPrompts.nba` and `videoPrompts.news`

---

## Part 4 — Rollback plan

If the fix causes unexpected issues (unlikely since it's additive to token capacity):

**Full rollback:**
```bash
git revert HEAD
```

Removes all 4 changes atomically.

**Partial rollback:**
- If Gemini starts producing over-long responses that break downstream parsing: lower `maxOutputTokens` back to 800 (still more than 500, less than 1500)
- If logs get noisy with warnings: remove the Change #2 console output but keep the token limit bump

**Nuclear rollback via feature flag:**
Not applicable — no feature flag needed, this is a pure parameter tuning. The change is small enough that `git revert` is the cleanest rollback path.

---

## Part 5 — Why this works (teaching section)

### Why 1500 and not 2000 or 5000

- **500 is the current (broken) value** — clearly too low
- **1500 is ~3× current** — gives 3× headroom for structured 4-section analysis without being wasteful
- **2000+** would work but is overkill — the 4-6 sentences per section is a PROMPT constraint, so Gemini won't naturally use more
- **65536** (Gemini's max) is absurd overkill — tokens you don't use don't cost money, but it sends a "here's unlimited" signal that could cause Gemini to pad responses

1500 hits the sweet spot: enough to never truncate, not so much that Gemini wanders off.

### Why finishReason detection matters

Silent truncation is the worst kind of bug because it masquerades as "normal" output. The Gate 1 CLIP MATCH deduction was blaming Claude's QA for a problem that originated upstream in Gemini. With explicit `finishReason` logging, future truncation bugs will be visible in server logs the instant they happen, not after days of debugging Gate 1 behavior.

This is principle 8 of the Gated Pipeline architecture (`GATED_PIPELINE_ARCHITECTURE.md`) applied to ONE specific function: "diagnostics must identify specific causes."

### Why fix this as a separate commit from the Gate 1 diagnostic upgrade

`CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` (Phase 2 of the gated pipeline) includes a bigger upgrade that adds `GEMINI_ANALYSIS_TRUNCATED` as a specific failure mode in the clip availability report. That handoff depends on this fix being in place — otherwise the new diagnostic would be reporting "truncated" as a cause but without a corresponding fix, and users would see the diagnostic but the underlying bug would persist.

**Ship this fix first, then the Gate 1 diagnostic upgrade builds on top of it.** Order matters.

### Why this isn't a Gemini API problem

Gemini 2.5 Flash is working exactly as documented. We asked for 500 tokens, we got up to 500 tokens, finishReason reports MAX_TOKENS when the cap is hit. This is our prompt + our token limit being mis-matched. Gemini isn't at fault.

### Relationship to Task #14 tracking

STATUS.md Task #14 currently says: "Gate 1 CLIP MATCH fails when Gemini clip analysis is truncated." This handoff is the fix for exactly that task. When shipped, mark Task #14 as completed with a reference to the commit hash.

---

## Part 6 — What NOT to touch

- **DO NOT** modify `claudeScriptQA()` — the Gate 1 QA function is downstream and is correctly detecting the truncation. The fix is upstream in `geminiAnalyzeClip()`.
- **DO NOT** change the video prompts in `videoPrompts` — the prompt structure is fine. The issue is the token budget, not the request.
- **DO NOT** touch `geminiScriptGeneration()` at line 1706 — it already has correct finishReason handling for the SCRIPT generation path. Different function, different bug class.
- **DO NOT** bump `temperature` — temperature controls creativity, not length. Leave at 0.2.
- **DO NOT** add retry logic for truncation — if Gemini truncates at 1500 tokens, adding retries won't help (same result). The fix is the token cap, not the retry behavior.
- **DO NOT** refactor `geminiAnalyzeClip()` function structure — scope discipline. Only change the 2 lines at 5745 and 5772, plus the 3 lines around 5750-5752.

---

## Part 7 — Commit message template

```
fix(gemini): raise clip analysis maxOutputTokens 500→1500 + add finishReason detection

Fixes Task #14: Gate 1 CLIP MATCH fails when Gemini clip analysis is truncated.

Root cause: geminiAnalyzeClip() at server.js:5745 calls Gemini 2.5 Flash with
maxOutputTokens=500, which is too small for the structured 4-section analysis
prompt (lines 5625-5632). Gemini returns finishReason=MAX_TOKENS with a
truncated response — typically just the header of section 1 with no body.
Downstream claudeScriptQA correctly flags "CLIP MATCH: cannot verify accuracy"
and deducts 15 points, scoring 85/100 and hard-failing after 3 retries.

Evidence: output/qa_failures/gate1_script_fail_1775886258810.txt shows both
clips with identical truncated output at "Here's an analysis of the Twitch
clip: 1. **Visually happening:**" — deterministic token-limit hit.

Changes:
- server.js:5745 — maxOutputTokens 500 → 1500 (3× headroom over expected output)
- server.js:5750-5752 — add finishReason detection with explicit TRUNCATED
  warning when Gemini hits the cap; short-length sanity check; mirrors
  existing pattern in geminiScriptGeneration() at line 1776-1778
- server.js:5772 — thumbnail fallback path maxOutputTokens 200 → 500
- server.js:5775 — optional mirror of finishReason check for thumbnail path

Cost impact: negligible (~$0.02/month additional Gemini spend from ~60,000
extra tokens/month across ~60 long-form videos).

Unblocks: Gate 1 auto-pass on smoke tests (currently requires FORCE ADVANCE
workaround). Required prerequisite for CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md
Phase 2 which adds GEMINI_ANALYSIS_TRUNCATED as a specific failure mode cause.

Test plan: re-run Jason 2-clip smoke test, Gate 1 should score ≥90 without
needing FORCE ADVANCE. Also verify no TRUNCATED warnings appear in server
logs for Twitch, NBA, and News content types.

Rollback: git revert HEAD.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Part 8 — Checklist for Cline

Before committing:

- [ ] `server.js:5745` changed from `500` to `1500`
- [ ] `server.js:5772` changed from `200` to `500`
- [ ] `server.js:5750-5752` replaced with the 3-block if/else if/else detection
- [ ] `server.js:5775` optionally mirrored for thumbnail path (skip if you want to keep the commit minimal)
- [ ] Run `node --check server.js` — no syntax errors
- [ ] STATUS.md Last Agent Action row added (pre-commit hook will block without it)
- [ ] Task #14 in task list can be marked completed (reference this handoff's commit hash in the update)
- [ ] Commit message follows the template in Part 7
- [ ] Atomic commit via single `git add server.js STATUS.md && git commit -m "..." && git push` Bash call
- [ ] After push, verify nodemon restarted (watch the nodemon terminal for the restart message)
- [ ] Run Test 1 (from Part 3) on the next smoke test to verify the fix works

---

## Part 9 — When this ships

Immediately unblocks:
- **Gate 1 auto-pass on smoke tests** — no more FORCE ADVANCE workaround for Rob
- **Test 1 of the 12-test suite** — can now pass Gate 1 cleanly (had to be force-advanced before)
- **All future production runs** — Gemini clip analyses will be complete instead of truncated

Unblocks when combined with earlier handoffs:
- **Phase 2 of the gated pipeline** (`CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md`) — that handoff depends on this fix being in place; otherwise the new GEMINI_ANALYSIS_TRUNCATED failure mode would report an issue that has no resolution path

Doesn't block but would benefit:
- **Gate 4 (assembly QA)** — Gate 4's Gemini calls will use similar structured prompts; having finishReason detection as a pattern means Gate 4 can copy this exact logic when it's built

---

*Small, surgical, ~30 minute fix. Ship in a single atomic commit. No architectural risk, no feature flags needed, clean rollback via `git revert`. — Claude Code*
