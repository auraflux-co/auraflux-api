# CLINE HANDOFF — HeyGen pause unlock: 1000ms break + dynamic_duration

**Priority:** P0 — before Rob runs the 12-streamer real test, we need to make sure our SSML `<break>` tags from `ba87ec5` actually land. Two documented best practices that likely determine whether SSML pauses survive the render.
**Scope:** 2 files, 2 surgical edits, 1 commit
**Est. Cline time:** ~15 minutes including verification
**Depends on:** Nothing — independent of any in-flight work

---

## Context

Commit `ba87ec5` shipped SSML `<break time="500ms"/>` for `[beat]` markers + `input_type: 'ssml'`. Rob has since pulled 5 different HeyGen best-practices guides. Two specific items from that research directly affect whether the shipped SSML actually produces audible pauses:

1. **The documented break duration is `1s` (1000ms), not 500ms.** Multiple sources confirm 1-second as the recommended starting value. 500ms was my conservative guess when I wrote the original handoff; it should be 1000ms.

2. **HeyGen's `dynamic_duration: true` parameter auto-adjusts video length** to match actual audio duration including SSML breaks. **Without this parameter, HeyGen may auto-trim silence to hit a preset duration** — meaning our `<break>` tags from `ba87ec5` could currently be rendering as no-ops. This parameter is the difference between "SSML pauses work" and "SSML pauses get swallowed."

Neither change is speculative — both are from HeyGen's own documentation (Rob verified). Neither introduces new dependencies or architectural changes.

**This commit is the minimum change needed so that the 12-streamer test fairly evaluates whether SSML pauses work on Rob's voice/avatar combo.** Without it, we could run the test and get misleading "pauses don't work" data when the real issue is just duration trimming.

---

## What to change — Edit 1: Bump break duration

**File:** `cwn_production.html`
**Line:** 3233 (inside `cleanAvatarText`)

### Before
```js
.replace(/\[beat\]/gi, '<break time="500ms"/>')
```

### After
```js
.replace(/\[beat\]/gi, '<break time="1000ms"/>')
```

**One character difference** (5 → 10). Do NOT change anything else in the function. The existing bracket-strip regex at line 3237 (`replace(/\[[^\]]*\]/g, '')`) is already safe because `<break>` uses angle brackets, not square brackets.

**Why 1000ms:** Rob's research across 4 HeyGen best-practice guides all cite `<break time='1s'/>` as the documented starting value. 500ms was my arbitrary conservative pick; 1000ms aligns with the docs. If delivery feels too long after real testing, easy to tune back down.

---

## What to change — Edit 2: Add dynamic_duration

**File:** `server.js`
**Line:** 1846–1866 (the `requestBody` object for HeyGen's `v2/video/generate`)

### Before
```js
const requestBody = {
  title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
  video_inputs: [{
    character: {
      type: 'avatar',
      avatar_id: avatarId,
      avatar_style: 'normal'
    },
    voice: {
      type: 'text',
      input_type: 'ssml',
      input_text: scene.text,
      voice_id: HEYGEN_VOICE_ID,
      speed: HEYGEN_SPEAK_SPEED
    }
  }],
  dimension: {
    width: format === 'portrait' ? 1080 : 1920,
    height: format === 'portrait' ? 1920 : 1080
  },
  test: false
};
```

### After — add ONE line: `dynamic_duration: true,`

```js
const requestBody = {
  title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
  video_inputs: [{
    character: {
      type: 'avatar',
      avatar_id: avatarId,
      avatar_style: 'normal'
    },
    voice: {
      type: 'text',
      input_type: 'ssml',
      input_text: scene.text,
      voice_id: HEYGEN_VOICE_ID,
      speed: HEYGEN_SPEAK_SPEED
    }
  }],
  dimension: {
    width: format === 'portrait' ? 1080 : 1920,
    height: format === 'portrait' ? 1920 : 1080
  },
  dynamic_duration: true,   // ← NEW — auto-adjust video length to match audio including SSML breaks
  test: false
};
```

**Placement:** as a sibling of `dimension`, directly above `test: false`. Comment stays inline for clarity.

**Why:** documented in Rob's research pass 4. Without it, HeyGen may auto-trim silence to hit a target duration, swallowing SSML `<break>` pauses.

---

## Risk and rollback

**Risk level: LOW.**

**Edit 1** is a tuning change — one character difference. Near-zero risk. If 1000ms feels too long after testing, trivial single-character rollback.

**Edit 2** adds a documented field to the HeyGen request. Three possible outcomes:
- ✅ **HeyGen honors the field** → SSML pauses work for the first time → win
- ⚪ **HeyGen silently ignores the field** → no change from current behavior → no harm, no help
- ❌ **HeyGen returns 400 "unknown field"** → `/assemble` Gate 6 fails → Cline removes the one line and pushes a second commit

**Cline's rollback path if HeyGen rejects:**
```bash
# If Rob's next test shows HeyGen 400 errors mentioning dynamic_duration:
# Edit server.js, remove the single line `dynamic_duration: true,`
# Commit with message: "revert: remove dynamic_duration — HeyGen V2 rejected unknown field"
# Push. Keep edit 1 (the 500ms→1000ms bump) — that one has zero risk.
```

Document this possibility in STATUS.md so Rob knows to watch for it during the 12-streamer run.

---

## What you MUST NOT change

- ❌ `input_type: 'ssml'` — already shipped in `ba87ec5`, keep as-is
- ❌ `HEYGEN_SPEAK_SPEED` / `.env` — 0.85 is in the documented 0.8–1.2 safe range, do not touch
- ❌ Avatar IDs — do not touch
- ❌ Voice IDs — do not touch
- ❌ `cleanAvatarText`'s other regexes — only the `[beat]` replacement line
- ❌ Any NBA/News/Shorts-specific code paths — this fix applies to all content types automatically via the shared HeyGen submission function
- ❌ `generateScenes` / `parseSegments_v2` — not touched by this commit
- ❌ Gate 1 QA "BEAT PLACEMENT" checks — Gemini still writes `[beat]`, nothing about that pipeline changes
- ❌ `emotion` parameter — deliberately NOT in this commit, needs a probe script first (Rob will handle separately)
- ❌ `engine: 'starfish'` parameter — may require V3 endpoint, architectural uncertainty
- ❌ Avatar 4 / Avatar 5 migration — separate manual investigation
- ❌ Phonetic name spelling — script-level change, separate task
- ❌ Any other file — stay surgical

---

## Verification

1. **Grep checks:**
   ```bash
   grep -n 'break time="1000ms"' cwn_production.html
   # Expect: 1 hit around line 3233

   grep -n 'dynamic_duration' server.js
   # Expect: 1 hit in the requestBody object around line 1865

   grep -n 'break time="500ms"' cwn_production.html
   # Expect: 0 hits (we replaced it)
   ```

2. **Syntax:**
   ```bash
   node -c server.js && echo "server.js OK"
   ```

3. **DevTools sanity check** (optional but recommended):
   Open `cwn_production.html` in Chrome, paste in console:
   ```js
   cleanAvatarText('Okay. [beat] That happened.')
   ```
   Expected output:
   ```
   Okay. <break time="1000ms"/> That happened.
   ```
   The `<break>` tag with `time="1000ms"` must survive intact.

4. **Nodemon restart:** server should restart cleanly after save. No errors on startup.

---

## STATUS.md update

Add ONE new Last Agent Action row:
```
| 2026-04-11 [TIME] ET | Cline | server.js + cwn_production.html | HeyGen pause unlock: <break> 500ms → 1000ms (documented value) + dynamic_duration: true on V2 request — aligns SSML with HeyGen best practices so pauses actually survive render | [commit hash] |
```

**Also add a "watch during next run" note** below the table or in the known-risks section:
```
⚠️  2026-04-11 evening — watch Rob's 12-streamer test for HeyGen 400 errors mentioning `dynamic_duration`. If rejected, rollback is one line in server.js. Fallback: keep the 1000ms break bump, remove dynamic_duration, re-commit.
```

---

## Commit message

```
fix(heygen): align SSML with best practices — 1000ms break + dynamic_duration

Rob pulled 5 HeyGen best-practices guides tonight. Two items directly
affect whether our SSML <break> tags from ba87ec5 actually produce
audible pauses:

1. Break duration: HeyGen docs cite <break time="1s"/> as the recommended
   starting value. We shipped 500ms as a conservative guess. Bump to
   1000ms to match documented best practice.

2. dynamic_duration: true — documented HeyGen V2 parameter that auto-
   adjusts video length to match actual audio including SSML breaks.
   Without it, HeyGen may auto-trim silence to hit a preset duration,
   which would explain why our shipped <break> tags appear to do nothing.
   This is the minimum change needed to fairly test whether SSML pauses
   work on this voice/avatar combo.

Two surgical edits:
- cwn_production.html:3233 — <break time="500ms"/> → <break time="1000ms"/>
- server.js:~1865 — add `dynamic_duration: true` to v2/video/generate requestBody

If HeyGen rejects dynamic_duration as an unknown field, one-line rollback
leaves the 1000ms bump intact. The 1000ms change is zero-risk on its own.

Emotion parameter, engine=starfish, Avatar 4/5 migration, and phonetic
name spelling all parked for separate investigation — see
HEYGEN_OPTIONS_INVENTORY.md for the full roadmap.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to main.

---

## Scope summary

**IN:**
- `cwn_production.html` line 3233 — 500ms → 1000ms (one character)
- `server.js` ~line 1865 — add `dynamic_duration: true` line
- STATUS.md single row + one known-risks note
- One commit

**OUT:** Everything else. Specifically: emotion parameter, engine parameter, avatar swap, phonetic names, speed tuning, NBA/News/Shorts-specific changes, dashboard edits, intro card changes, ticker changes, any file not named above.

**Ship it. Rob is standing by for the 12-streamer real test.**
