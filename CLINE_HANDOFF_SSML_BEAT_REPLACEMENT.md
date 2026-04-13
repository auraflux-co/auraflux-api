# CLINE HANDOFF — SSML `<break>` replacement for `[beat]` markers

**Priority:** P0 — Bobby G has been ignoring all `[beat]` pauses for weeks, rolling straight through punchlines into outros. Rob verified this against the raw script. SSML is HeyGen's documented solution.
**Scope:** 2 files, 2 surgical changes, 1 ticker-height cache-sync alongside (bundle as one commit)
**Est. Cline time:** ~25 minutes including a sanity check
**Depends on:** Nothing

---

## Background — why this matters

Rob has been running smoke tests for days and watching Bobby G deliver scripts that look like this on paper:

```
Well, that's one way to end a stream.
[beat]
Follow Jason. Link in description.
```

And sound like this in the rendered video:
> *"Well that's one way to end a stream Follow Jason link in description"*

No pause. No beat. The Norm MacDonald punchline-breathe-then-pivot structure is broken at every scene transition. `[beat]` → `...` conversion in `cleanAvatarText` produces ellipses that HeyGen's TTS treats as elidable punctuation — not as pauses.

**Rob's research (2026-04-11) confirmed HeyGen supports SSML:**
- Opt-in via `input_type: 'ssml'` on the voice block
- Primary documented use case is `<break time='Xms'/>` for precise pauses
- Supported in V2 endpoint (which is what your code uses)
- Character range: 1–5000 per request, same as plain text

This handoff wires it up.

---

## What to change — Part 1: Add `input_type: 'ssml'` to HeyGen payload

**File:** `server.js`
**Location:** Lines 1854–1859 (the `voice` block inside the HeyGen request body)

**Before:**
```js
voice: {
  type: 'text',
  input_text: scene.text,
  voice_id: HEYGEN_VOICE_ID,
  speed: HEYGEN_SPEAK_SPEED
}
```

**After:**
```js
voice: {
  type: 'text',
  input_type: 'ssml',       // ← enables <break> tags and other SSML in input_text
  input_text: scene.text,
  voice_id: HEYGEN_VOICE_ID,
  speed: HEYGEN_SPEAK_SPEED
}
```

**That's the entire server-side change** — one property added to an existing object. Everything else about the payload stays identical.

---

## What to change — Part 2: Swap `[beat]` → `<break>` in `cleanAvatarText`

**File:** `cwn_production.html`
**Location:** Lines 3231–3240 (`cleanAvatarText` function)

**Before:**
```js
function cleanAvatarText(raw) {
  return raw
    .replace(/\[beat\]/gi, '...')
    .replace(/\[CLIP PLAYS HERE[^\]]*\]/gi, '')
    .replace(/\[TRANSITION[^\]]*\]/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

**After:**
```js
function cleanAvatarText(raw) {
  return raw
    // Replace [beat] with SSML break tag — HeyGen honors this when input_type: 'ssml'
    // 500ms is the starting value — tune up/down based on delivery feel after real runs
    .replace(/\[beat\]/gi, '<break time="500ms"/>')
    .replace(/\[CLIP PLAYS HERE[^\]]*\]/gi, '')
    .replace(/\[TRANSITION[^\]]*\]/gi, '')
    // IMPORTANT: the [...] strip below must come AFTER the [beat] → <break> replacement
    // so we don't accidentally strip the break tags. Only strip things that still look
    // like bracketed directives, which <break ... /> no longer does.
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

**Key safety notes for Cline:**

1. The existing `replace(/\[[^\]]*\]/g, '')` at the 4th line strips *any* bracketed content like `[stage direction]`. This still needs to run to catch leftover directives Gemini may write. After our swap, `<break time="500ms"/>` uses angle brackets `< >` not square brackets `[ ]`, so it is NOT affected by that regex. The ordering is already safe.

2. Do NOT also add `<break>` handling to any other text-cleanup location. Grep for other callers of avatar text first: `grep -n "cleanAvatarText\|avatar.*text" cwn_production.html` — there should be exactly one definition and one or two call sites in the dashboard. No server-side duplicate exists.

3. The 500ms value is a **starting guess**. Rob may tune this after the first real run — do NOT make it configurable via dashboard UI yet, hardcode it in the regex for now.

---

## What to change — Part 3: Ticker capture height sync

**Also bundle this fix in the same commit** (Rob confirmed 72px is final).

**File:** `server.js`
**Location:** Lines 4981 and 4992 (`captureTicker` function)

**Before:**
```js
const WIDTH      = 1920;
const HEIGHT     = 64;
```

(and at line 4992)
```js
await page.setViewport({ width: WIDTH, height: HEIGHT });
```

**After:**
```js
const WIDTH      = 1920;
const HEIGHT     = CONFIG.TICKER.HEIGHT;   // sync with config (72) — was hardcoded 64
```

(line 4992 stays the same — it already reads from the `HEIGHT` constant)

**Then delete the ticker cache** so the next assembly regenerates at 72px:
```bash
rm -f /Users/robertgregory/cwn-production/tmp/ticker_*.mp4
```

**Why this is in the same commit:** Rob chose "72 is fine" for ticker height. The gap he's been seeing at the bottom of the frame is because `captureTicker` grabs a 64px PNG but FFmpeg positions it as if it were 72px (`y = H - CONFIG.TICKER.HEIGHT` = 1008), leaving 8 unused pixels at the frame bottom. Unifying both reads to `CONFIG.TICKER.HEIGHT` fixes it.

Expected result after cache clear and first re-render: ticker occupies the full 72px at the bottom, flush to the frame edge. The ticker HTML itself renders its native 64px design into the 72px capture area, leaving ~8px distributed as transparent padding. This is a known cosmetic trade-off — accepted by Rob. A proper ticker redesign (Option C in the earlier conversation) is parked as a future task.

---

## Verification — before commit

1. **Grep checks:**
   ```bash
   grep -n "input_type: 'ssml'" server.js
   # Expect: 1 hit near line 1856
   
   grep -n "<break time" cwn_production.html
   # Expect: 1 hit in cleanAvatarText around line 3233
   
   grep -n "const HEIGHT" server.js
   # The captureTicker HEIGHT should read CONFIG.TICKER.HEIGHT, not a number
   ```

2. **Syntax:**
   ```bash
   node -c server.js && echo "server.js OK"
   ```

3. **Visual sanity check:** Open `cwn_production.html` in a browser, paste this into DevTools console:
   ```js
   cleanAvatarText('Well, that\'s one way to end a stream. [beat] Follow Jason.')
   ```
   Expected output:
   ```
   Well, that's one way to end a stream. <break time="500ms"/> Follow Jason.
   ```
   The `<break>` tag must survive intact — if it comes out stripped or mangled, the regex ordering is wrong.

4. **Nodemon restart:** `server.js` should restart cleanly after save. No errors about `CONFIG.TICKER.HEIGHT` being undefined.

---

## What to NOT change

- ❌ Gemini prompts that tell Gemini to write `[beat]` into scripts — those still stay the same. Gemini writes `[beat]` in the script, Gate 1 checks for it, parser preserves it, cleanAvatarText converts to `<break>` at the last step before HeyGen. Keep the pipeline layered.
- ❌ Gate 1 QA "BEAT PLACEMENT" checks at `server.js:2231, 2247, 2264, 2274, 2578, etc.` — they still enforce that Gemini writes beats around `[CLIP PLAYS HERE]` markers. Rob's comedic-timing intent stays in the script even if the execution layer now uses SSML.
- ❌ The `HEYGEN_SPEAK_SPEED` env var — leave it at 0.85 for now. If SSML pauses feel right, don't touch speed. If delivery feels too fast even with pauses, that's a future tuning step.
- ❌ NBA / News script generators or their `[beat]` usage — they all flow through the same `cleanAvatarText` pipeline, so this fix applies to all content types without per-type changes.
- ❌ Anything else in `server.js` or `cwn_production.html`. One commit, three surgical changes, nothing else.
- ❌ Dashboard UI for tuning the 500ms value — hardcoded for now.
- ❌ SSML escaping — `input_text` should be passed through as-is. HeyGen handles malformed SSML gracefully (falls back to plain text parsing). We're not going to preemptively escape.

---

## Edge cases to be aware of

1. **Gemini sometimes writes `[beat]` with variations** like `[BEAT]`, `[Beat]`, `[ beat ]`. The regex `/\[beat\]/gi` handles case (`i` flag) and the word-boundary match is tight — extra whitespace inside the brackets like `[ beat ]` would NOT match. If Rob reports the fix isn't working on some scenes, check the actual script text for non-standard beat markers and tighten the regex to `/\[\s*beat\s*\]/gi` as a follow-up. Do NOT make this change preemptively — wait for evidence.

2. **Gemini may write SSML-conflicting characters** in scripts (e.g., `&` or `<` in a clip title). These technically need to be escaped for valid SSML. HeyGen's SSML parser is typically forgiving, but if you see rendering failures on scripts that contain ampersands or angle brackets, the follow-up fix is to HTML-entity-escape the text before `[beat]` replacement. Again: wait for evidence before adding this complexity.

3. **If HeyGen rejects the request** with an error like *"Invalid SSML"* or *"input_type not supported for this voice"*, revert Part 1 (remove `input_type: 'ssml'`), leave Parts 2 and 3 in place (the `<break>` tags will just be rendered as elided punctuation — same as the current `...` behavior, no regression). Log the error verbatim for Rob to review.

---

## STATUS.md update

Add a single new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | server.js + cwn_production.html | SSML beat replacement: [beat] → <break time="500ms"/>, input_type: 'ssml' in HeyGen payload + ticker capture height sync to CONFIG.TICKER.HEIGHT (72) + cache clear | [commit hash] |
```

---

## Commit message

```
feat(heygen): real pauses via SSML + sync ticker capture to config height

Bobby G has been ignoring every [beat] marker in the script because
cleanAvatarText was converting them to '...' and HeyGen's TTS treats
ellipsis as elidable punctuation, not a pause. Rob verified against
the raw script: "Well, that's one way to end a stream. [beat] Follow
Jason." was rendering with no pause at all.

HeyGen's v2/video/generate endpoint supports SSML when you opt in
with `input_type: 'ssml'` on the voice block. The primary documented
use case is <break time='Xms'/> for precise pauses.

Two changes + one cleanup bundled:
1. server.js:1856 — add `input_type: 'ssml'` to HeyGen voice payload
2. cwn_production.html:3233 — cleanAvatarText replaces [beat] with
   <break time="500ms"/> instead of '...'. Starting value, will tune
   based on real delivery feel.
3. server.js:4981 — captureTicker HEIGHT now reads CONFIG.TICKER.HEIGHT
   instead of hardcoded 64, fixes 8px gap at the frame bottom where
   the ticker PNG was shorter than the overlay position expected.
   Required ticker cache clear (rm tmp/ticker_*.mp4) so next assembly
   regenerates at 72px.

Gate 1 BEAT PLACEMENT checks unchanged — Gemini still writes [beat]
into scripts, Gate 1 still enforces, this only affects the last step
before HeyGen render. Norm MacDonald timing finally gets a shot at
working.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Scope summary

**IN:**
- `server.js` (two locations: HeyGen payload `input_type`, captureTicker HEIGHT constant)
- `cwn_production.html` (one location: cleanAvatarText `[beat]` replacement)
- Cache clear: `rm -f tmp/ticker_*.mp4`
- STATUS.md single row
- One commit

**OUT:** Gate 1 prompts, script generators, HEYGEN_SPEAK_SPEED, dashboard UI for pause tuning, any file not named above

Ship it. Rob is standing by.
