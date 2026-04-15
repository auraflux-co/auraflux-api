# CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md

**Author:** Claude Code (dispatched 2026-04-13 early morning, diagnosed live from smoke test #6 Gate 3 failure)
**For:** Cline (urgent defensive fix + investigation)
**Scope:** Stage direction text like `[3-second pause — hold on source clip]` is leaking from the Gemini script output into HeyGen rendered video. Appears as literal burned-in on-screen text during a 3-second pause/freeze. Causes Gate 3 to flag it as VIDEO FREEZE + AUDIO FAIL. Blocks News long-form from passing Gate 3 entirely. **URGENT — blocks News smoke test #7 success.**
**Ship order:** Single atomic commit for the defensive fix. Follow-up commit possible for the root-cause fix if investigation reveals the leak source.
**Do NOT touch:** NBA, Twitch, short-form code paths. Gemini prompt structure (just add defensive cleaning, don't rewrite Fix 6 content rules). Fix 9 News scraper. Fix 9b HLS downloader (separate handoff).
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Live diagnosis — what Gate 3 saw in smoke test #6

Smoke test #6 (`asm_1776055054525`) produced filename `news_monday_april_13_2026_22_avatar_2_clips__1776055228070.mp4` (2 source clips flowed through — first time News had non-zero clips). Gate 3's LATE sample hard-failed 3 times in a row with this description from Gemini:

**Retry 1 (83/100):**
> *"1. VIDEO FREEZE: FAIL — The video freezes for approximately 3 seconds from 0:15 to 0:18, **as indicated by the static avatar and the on-screen text overlay.**"*

**Retry 2 (83/100):**
> *"1. VIDEO FREEZE: FAIL — The video freezes for approximately 3 seconds from 0:15 to 0:18, **as indicated by the on-screen text '3 second pause, hold on source clip.'**"*

**Key finding:** Gemini's vision model is literally reading the string `"3 second pause, hold on source clip"` off the screen during a 3-second frozen avatar moment with no audio. That string comes from the News Gemini prompt at `server.js:7081, 7091, 7093`:

```
server.js:7081 — [3-second pause — hold on the source clip for 3 seconds after Bobby's reaction, then cut to next story]
server.js:7091 — - Each REACTION scene: EXACTLY 1 sentence (deadpan take, no recap) + [3-second pause — hold on source clip]
server.js:7093 — - After each REACTION scene: Add "[3-second pause — hold on source clip]" before moving to next story
```

The prompt INSTRUCTS Gemini (the script writer) to include `[3-second pause — hold on source clip]` as literal text at the end of every STORY#_REACTION scene. Gemini obeys. That bracket text ends up in the raw script, which downstream code is SUPPOSED to strip via `cleanAvatarText()` at `cwn_production.html:3241` — but apparently that stripping is not happening for the REACTION scene text by the time it reaches HeyGen's render.

---

## What `cleanAvatarText()` is supposed to do

`cwn_production.html:3241`:

```javascript
function cleanAvatarText(raw) {
  return raw
    // Replace [beat] with SSML break tag
    .replace(/\[beat\]/gi, '<break time="1000ms"/>')
    .replace(/\[CLIP PLAYS HERE[^\]]*\]/gi, '')
    .replace(/\[TRANSITION[^\]]*\]/gi, '')
    // IMPORTANT: the [...] strip below must come AFTER the [beat] → <break> replacement
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

**The `\[[^\]]*\]` regex at line 3251 strips ALL bracket-enclosed text.** `[3-second pause — hold on source clip]` should match this pattern and be stripped. The function is correct.

## Where `cleanAvatarText()` is called (and where it might be missing)

Grep results from earlier tonight show `cleanAvatarText` is called at:
- `cwn_production.html:3303` — inside `parseSegments_v1` (legacy, not used)
- `cwn_production.html:3321` — inside `parseSegments_v1` (legacy, not used)
- `cwn_production.html:3442` — inside `parseSegments_v2` (active, flag `USE_PARSE_SEGMENTS_V2 = true`)

**`parseSegments_v2` at `cwn_production.html:3411` is the active parser.** It calls `cleanAvatarText` at ~line 3442. The parsed `result[i].text` for each segment should be clean.

**But the text arriving at HeyGen render still contains the bracket directive somehow.** Three possible leak points:

### Leak Point A — `parseSegments_v2` doesn't clean all scene types

Possibly `parseSegments_v2` has a branch for REACTION-style scenes that bypasses `cleanAvatarText` or applies it to the wrong text variable. **Needs code read at `cwn_production.html:3411+`.**

### Leak Point B — `generateVideo()` receives the raw script, not the parsed segment

At `cwn_production.html:1255`:
```javascript
function generateVideo(script, title, isPortrait, cb) {
  var payload = {
    video_inputs: [{
      character: { /* ... */ },
      voice: { type:'text', input_text:applyPronunciations(script), voice_id:CFG.voiceId, /* ... */ },
      /* ... */
    }],
    /* ... */
  };
  /* ... */
}
```

`generateVideo()` applies `applyPronunciations(script)` to the incoming `script` argument. If the caller passes the RAW script text (from the parsed segment's unclean source) rather than the cleaned `seg.text`, the bracket directive passes through.

Both callers look correct at first glance:
- `cwn_production.html:2282` — `generateVideo(matchSeg.text, ...)` — passes cleaned parsed text
- `cwn_production.html:4060` — `generateVideo(seg.text, ...)` — passes cleaned parsed text

**But `seg.text` is cleaned ONLY if `parseSegments_v2` correctly strips it.** If Leak Point A exists, Leak Point B inherits the bug.

### Leak Point C — HeyGen's captions/subtitles feature sources from somewhere other than input_text

HeyGen has an optional closed-captions / subtitles feature. If it's enabled in the account settings or passed via a different request field, it may be using a DIFFERENT source (like the title field or a captions field) for burned-in subtitles rather than the cleaned `input_text`. **Needs verification against HeyGen's API docs.**

---

## The defensive fix — belt and suspenders

**Ship this first, regardless of root cause.** It closes the leak by running `cleanAvatarText()` one more time inside `generateVideo()` right before the text reaches HeyGen's API:

### File: `cwn_production.html:1261`

**From:**
```javascript
voice: { type:'text', input_text:applyPronunciations(script), voice_id:CFG.voiceId, speed: (function(){
```

**To:**
```javascript
voice: { type:'text', input_text:applyPronunciations(cleanAvatarText(script)), voice_id:CFG.voiceId, speed: (function(){
```

**One character change (wrapping `script` with `cleanAvatarText(...)`).** The `cleanAvatarText()` function is idempotent — stripping brackets from already-clean text has no effect. This is safe to add even if the upstream pipeline is supposed to be cleaning the text.

**Why this is belt-and-suspenders, not a root fix:** if Leak Point A or B exists, the same bug may be silently affecting OTHER rendering paths that don't go through `generateVideo()` (e.g., direct HeyGen API calls from future code, Twitch/NBA paths that parse segments differently). The right long-term fix is to ensure every text-to-HeyGen path calls `cleanAvatarText` once, reliably. The defensive fix ships RIGHT NOW to unblock News smoke test #7 while the root-cause investigation can happen separately.

---

## The root-cause fix — investigation required

After the defensive fix lands and News smoke test #7 passes, investigate where the leak originates.

### Step 1 — Confirm `parseSegments_v2` cleans REACTION scene text

Read `cwn_production.html:3411-3520` (approximate range for `parseSegments_v2`). Find every branch that produces a `result.push({ type:'avatar', ... text: X })` entry. Verify that EVERY `text` value passed is the result of `cleanAvatarText(...)`, not raw section content.

If any branch builds `text` from raw section content without cleaning, that's Leak Point A.

### Step 2 — Confirm `seg.text` arriving at `generateVideo()` is clean

Add a temporary debug log:

```javascript
// In generateVideo() at ~line 1255, add at the top:
if (/\[3-second|\[CLIP PLAYS HERE|\[beat/i.test(script)) {
  console.warn('[generateVideo] ⚠️ Unclean text reached HeyGen input_text:', script.slice(0, 200));
}
```

Run a News smoke test. If the warning fires, the segment text arriving at `generateVideo()` is NOT clean — which means `parseSegments_v2` has a leak. If the warning doesn't fire, the leak is AFTER `generateVideo()` (probably HeyGen captions from somewhere else).

Remove the debug log after confirming.

### Step 3 — Check HeyGen captions settings

In the HeyGen request body at `cwn_production.html:1258-1272`:

```javascript
var payload = {
  video_inputs: [{
    character: { /* ... */ },
    voice: { /* ... */ },
    background: { type:'color', value:CFG.bgColor }
  }],
  dimension: { width:w, height:h },
  title: title || undefined,
  test: false
};
```

Check HeyGen's v2/video/generate API docs for:
- A `captions` or `subtitles` field that may default to true and source from somewhere
- A `text_overlay` or `burned_in_captions` setting
- Whether `test: false` enables any debug overlays that might show text

If HeyGen has a captions feature enabled by default, explicitly disable it by adding `captions: false` or `subtitles: { enabled: false }` (exact field name per HeyGen docs) to the request body. Rob's News videos should only show burned-in text via the Fix 7 newscast chrome, never via HeyGen captions.

### Step 4 — Remove the stage directions from the Gemini prompt entirely

**This is the cleanest long-term solution.** The `[3-second pause — hold on source clip]` instruction at `server.js:7081, 7091, 7093` is a stage direction that should live in the ASSEMBLY layer (via Gap #45's FFmpeg freeze-hold filter), not in the script content.

After the defensive fix ships and the root cause is confirmed, remove those three references from the News Gemini prompt. Gemini will stop writing the stage direction into scripts, which eliminates the leak at the source regardless of which downstream code path was previously stripping (or failing to strip) it.

Replace the three prompt references with instruction text that stays in the prompt but doesn't appear in the output:

```
// server.js:7081 (inside the content structure block) — REMOVE the bracket line entirely

// server.js:7091 — change to:
- Each REACTION scene: EXACTLY 1 sentence (deadpan take, no recap)

// server.js:7093 — change to:
- Between stories, the assembly layer will add a 3-second hold on the source clip before cutting to the next story. Do NOT write stage directions in the script — just end the REACTION scene with a single deadpan sentence.
```

**This root-cause fix can ship as a separate commit AFTER the defensive fix is verified working.** Or bundle with the defensive fix into one commit if time allows.

---

## Retroactive impact — Gap #10 may be the same bug

This diagnosis potentially explains the Gate 3 LATE-sample "outro false positive" we've been seeing since smoke test #3 (Gap #10 in the audit, dispatched as a Wave 0 fix in `CLINE_HANDOFF_WAVE_0_CLEANUP.md`). Every News smoke test since Fix 6 shipped (commit `9a4fcc6`) has shown a LATE-sample `OUTRO: FAIL — unclean cut mid-sentence` deduction. Rob's YouTube Studio QA confirmed the actual outro plays cleanly, so we blamed the 20-second sample window alignment.

**But what if Gate 3's LATE sample was landing at the frozen-stage-direction moment in the LAST story's REACTION scene — which is immediately before the OUTRO — and Gemini was describing THAT as "ends mid-sentence" the whole time?**

Re-reading smoke test #3's Gate 3 why-doc with that hypothesis in mind:

> *"OUTRO: FAIL — The video sample ends abruptly mid-sentence, indicating an unclean cut."*

Consistent with "3 seconds of frozen avatar where the sample happens to end." The "mid-sentence" interpretation is Gemini describing the state at the sample boundary, which coincides with the stage-direction freeze, which coincides with the end of the LAST REACTION scene, which is right before the OUTRO.

**If Gap #51's defensive fix + prompt cleanup auto-resolves Gap #10**, then `CLINE_HANDOFF_WAVE_0_CLEANUP.md`'s Gap #10 entry becomes a no-op. After this handoff ships, re-run News smoke test #7 and check if the LATE sample still shows OUTRO: FAIL. If it's gone, Gap #10 was a symptom of Gap #51 all along.

---

## Immediate verification (before ship)

### Grep checks

```bash
# Stage directions still in the prompt (before root-cause fix ships)
grep -n "3-second pause\|hold on source clip" server.js
# Should have 4-6 hits (prompt text + comment + validation references)

# cleanAvatarText function exists
grep -n "function cleanAvatarText" cwn_production.html
# Should have 1 hit at ~line 3241

# Defensive fix applied to generateVideo
grep -n "cleanAvatarText(script)" cwn_production.html
# Should have a hit at ~line 1261 after the fix

# Current generateVideo input_text construction
grep -n "input_text:applyPronunciations" cwn_production.html
# Should show the new cleanAvatarText(script) wrapper
```

### Syntax check

```bash
# Dashboard is HTML+JS, no server syntax check applies. Load http://localhost:8765/cwn_production.html
# in browser and check the DevTools console for JavaScript errors. None expected.
```

### End-to-end test — News smoke test #7

After the defensive fix ships, Rob runs News smoke test #7. Expected outcomes:

1. **No "on-screen text '3 second pause...'" in Gate 3 Gemini descriptions** — the stage direction is stripped before reaching HeyGen render
2. **LATE sample no longer reports VIDEO FREEZE: FAIL** (assuming the freeze was caused by HeyGen rendering the bracket text)
3. **`clipsExpectedButMissing` still fires** — that's a separate bug (Gap #47 — the aggregate check over-fires). Not resolved by this handoff. Will surface again on smoke test #7 and require a separate fix.
4. **Fix 9b HLS whitelist also needs to ship** (separate handoff `CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`) to get more than 2 of 5 clips flowing through — this handoff alone doesn't fix the low clip count

If smoke test #7 still shows the stage-direction freeze after the defensive fix, one of three things is true:
- `generateVideo()` isn't actually being called with the defensive wrapper (verify the edit landed)
- The leak is in a DIFFERENT code path I haven't identified
- HeyGen captions are sourcing from somewhere other than `input_text` (investigate Step 3 above)

---

## Commit strategy

### Commit 1 — Defensive fix (ship immediately)

```
fix(news): defensive cleanAvatarText in generateVideo() — strips stage direction leaks (Gap #51)

Gate 3 on smoke test #6 caught Gemini writing "[3-second pause — hold on
source clip]" into every News REACTION scene per the prompt instructions at
server.js:7081/7091/7093. The bracket stage direction is supposed to be
stripped by cleanAvatarText() at cwn_production.html:3241 (regex
\[[^\]]*\]/g strips all bracket text) but something in the pipeline is
letting it reach HeyGen's input_text field. HeyGen renders Bobby G with
burned-in on-screen text saying "3 second pause, hold on source clip" and
3 seconds of silence/static avatar — which Gemini's vision model in Gate 3
correctly flags as VIDEO FREEZE + AUDIO FAIL.

Defensive fix: wrap the `script` argument in generateVideo() with
cleanAvatarText() before applyPronunciations() runs. cleanAvatarText() is
idempotent (safe to call twice on already-clean text), so this is belt-
and-suspenders regardless of whether the upstream pipeline was supposed to
have cleaned it.

Changes:
- cwn_production.html:1261 — wrap `script` in cleanAvatarText() inside
  the voice.input_text field of generateVideo()'s HeyGen payload

Root cause investigation: see handoff Step 1-4 for follow-up work to
identify WHY parseSegments_v2 or downstream code didn't strip the
directive in the first place. Separate follow-up commit.

References: LONGFORM_FIX_ROTATION.md News Wave 1, gap audit Gap #51 (new),
smoke test #6 Gate 3 why-doc at output/qa_failures/gate3_assembly_fail_1776055551906.txt
```

### Commit 2 — Root-cause fix (after investigation, optional)

```
fix(news): remove [3-second pause] stage direction from Gemini prompt (Gap #51 root cause)

Eliminates the stage direction at the source. Gemini no longer writes
"[3-second pause — hold on source clip]" into REACTION scene output.
The 3-second hold is handled at the assembly layer (Gap #45 FFmpeg
freeze-hold) not via script content.

Changes:
- server.js:7081 — remove bracket line from content structure template
- server.js:7091 — remove "+ [3-second pause]" suffix from validation
- server.js:7093 — remove "After each REACTION scene..." instruction

Depends on: Gap #51 commit 1 (defensive fix) shipping first as safety net.

References: gap audit Gap #51
```

Per `COMMIT_CHECKLIST.md` for each commit:
1. Atomic staging: `git add cwn_production.html STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push` (commit 1)
2. Atomic staging: `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push` (commit 2, optional)
3. STATUS.md Last Agent Action row per commit
4. LONGFORM_FIX_ROTATION.md — add Gap #51 entry in `✅ Shipped` per commit

---

## Rollback plan

**Defensive fix (commit 1):**
```bash
git revert HEAD && git push
```
Safe — removes only the `cleanAvatarText()` wrapper. Returns to the pre-fix state where stage directions leak through.

**Root-cause fix (commit 2):**
```bash
git revert HEAD && git push
```
Safe — restores the stage direction instructions to the Gemini prompt. Gemini goes back to writing bracket directives into the script, which are then stripped by the commit 1 defensive fix.

**If defensive fix causes unexpected regression on News smoke test #7:**
- Revert commit 1
- Investigate why cleanAvatarText() is incompatible with already-clean text in the specific path used by generateVideo() (shouldn't happen — function is idempotent)

---

## What this fix does NOT solve

1. **`clipsExpectedButMissing` aggregate check over-fires (Gap #47)** — separate new gap, surfaced from smoke test #6. Gate 3's aggregate `clipsExpectedButMissing` logic should only fire when Gemini explicitly reports SOURCE CLIPS: FAIL, not when samples report "acceptable absence during avatar speech." Separate small fix needed.
2. **Fix 9 Al Jazeera HLS clips are still blocked at SSRF whitelist (Fix 9b)** — separate handoff `CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`. Unblocks 3 of 5 News stories from flowing clips through.
3. **Gap #10 LATE-sample outro false positive** — MAY auto-resolve if the stage direction was the real cause. Re-verify after this handoff + smoke test #7. If Gap #10 persists, it's a genuine sample window issue and Wave 0's Gap #10 fix still applies.
4. **Topaz enhancement HTTP 400 errors** — the Gate 3 retry loop tries Topaz before re-scoring. Topaz API is returning 400 for some reason. Unrelated to Gap #51, not blocking News test cases. Separate future fix.

---

## Checklist for Cline

- [ ] `cwn_production.html:1261` — defensive fix applied: `input_text:applyPronunciations(cleanAvatarText(script))`
- [ ] Grep: `cleanAvatarText(script)` appears at line 1261 (defensive fix verified in place)
- [ ] Grep: `function cleanAvatarText` still exists at line 3241 (not accidentally removed)
- [ ] `cleanAvatarText()` function body unchanged (same stripping regex)
- [ ] Dashboard reloads in browser with no JS errors
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated (Gap #51 commit 1 in Shipped)
- [ ] Atomic commit 1 via chained `git add && git commit && git push`
- [ ] Commit 1 hash reported back to Rob

**Optional (after Rob runs News smoke test #7 and the defensive fix is verified working):**

- [ ] Investigate root cause per Steps 1-4 above
- [ ] Ship commit 2 — remove stage directions from the Gemini prompt
- [ ] Verify `parseSegments_v2` cleans all scene types correctly
- [ ] Verify HeyGen captions are not sourcing from a separate field
- [ ] If the stage direction was causing the LATE sample outro false positive, mark Gap #10 as auto-resolved in `CLINE_HANDOFF_WAVE_0_CLEANUP.md`
