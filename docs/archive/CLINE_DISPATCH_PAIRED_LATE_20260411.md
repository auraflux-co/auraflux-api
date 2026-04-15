# CLINE DISPATCH — Paired Ship (2026-04-11 late evening)

**Context:** Two independent handoffs. Ship back-to-back as **two separate commits** in the order below. Both are unblocking Rob's first real 12-streamer production test.

---

## Order of operations

### 1. FIRST — TV card position fix (~5 min)

**Handoff file:** `CLINE_HANDOFF_TV_CARD_520_293.md`

**What:** One-line change in `lib/config.js:55`.

**From:**
```js
OVERLAY_ZONE: { x: 1160, y: 352, w: 720, h: 405 },
```

**To:**
```js
OVERLAY_ZONE: { x: 1360, y: 60, w: 520, h: 293 },
```

Also update the inline comment per the handoff. Single commit. STATUS.md row. Push.

**Why:** Current position (`2781d8a`) overlaps Bobby G's shoulder/upper chest. New position is a smaller card in the top-right corner next to his head, honoring Rob's constraints (60px top padding, 40px right margin, broadcast over-the-shoulder style). Measurements derived from the Gemini measurement script + Rob's visual review.

### 2. SECOND — HeyGen pause unlock (~15 min)

**Handoff file:** `CLINE_HANDOFF_HEYGEN_PAUSE_UNLOCK.md`

**What:** Two surgical edits in two files, single commit.

**Edit A — `cwn_production.html:3233`:**
```js
.replace(/\[beat\]/gi, '<break time="500ms"/>')
```
→
```js
.replace(/\[beat\]/gi, '<break time="1000ms"/>')
```

**Edit B — `server.js:~1865`:**
Add `dynamic_duration: true,` to the HeyGen `requestBody` object as a sibling of `dimension`, directly above `test: false`:

```js
const requestBody = {
  title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
  video_inputs: [{...}],
  dimension: {
    width: format === 'portrait' ? 1080 : 1920,
    height: format === 'portrait' ? 1920 : 1080
  },
  dynamic_duration: true,   // ← NEW — auto-adjust video length to match audio including SSML breaks
  test: false
};
```

Single commit. STATUS.md row + a "watch during next run" known-risks note. Push.

**Why:** Rob pulled 5 HeyGen best-practices guides. Two items directly affect whether the SSML `<break>` tags shipped in `ba87ec5` actually produce audible pauses:
1. Documented break duration is 1 second, not 500ms.
2. `dynamic_duration: true` auto-adjusts video length to match actual audio including SSML breaks. Without it, HeyGen may auto-trim silence to hit a preset duration, swallowing our `<break>` tags. This is the minimum change needed to fairly test whether SSML pauses work on Rob's voice/avatar combo.

---

## Rules for both commits

1. **Two separate commits.** Not bundled. Clean rollback per fix if anything goes sideways.
2. **Touch only the files named in each handoff.** No cross-pollination.
3. **Do not touch anything outside the named files.** No opportunistic cleanup.
4. **Ship both even if Rob hasn't run the 12-streamer test yet** — these are prerequisites to that run being meaningful.
5. **STATUS.md gets TWO new "Last Agent Action" rows**, one per commit — do not combine.
6. **Handoff #2 has a known-risk note** about `dynamic_duration` — if HeyGen V2 rejects it as an unknown field, the rollback procedure is documented in the handoff: remove the one line, keep the 1000ms bump, push a second commit. Document this possibility in STATUS.md per the handoff's instructions.

---

## Verification checklist (before pushing each commit)

**Commit 1 (TV card):**
- `git diff lib/config.js` shows exactly one modified line (55) + comment update
- No other files touched

**Commit 2 (HeyGen pause unlock):**
- `grep -n 'break time="1000ms"' cwn_production.html` → 1 hit around line 3233
- `grep -n 'break time="500ms"' cwn_production.html` → 0 hits
- `grep -n 'dynamic_duration' server.js` → 1 hit around line 1865
- `node -c server.js` returns exit 0
- Nodemon restart is clean, no error on startup

---

## After both ship

Report back with:
- Both commit hashes
- Any unexpected findings during the nodemon restart after commit 2
- Confirmation STATUS.md has two new rows + the known-risks note on `dynamic_duration`

Rob will then run the 12-streamer real test:
```
jasontheween, hasanabi, adapt, stableronaldo, lacy, marlon, cinna, yonnajay, jaycinco, maya, extraemily, yourragegaming
```

---

## What's NOT in this dispatch

- ❌ Emotion parameter work (parked — needs probe script first)
- ❌ Avatar 5 migration (parked — needs HeyGen UI check for availability)
- ❌ `engine=starfish` (parked — architectural uncertainty, may require V3 endpoint)
- ❌ Phonetic name spelling (parked — Gemini prompt change, separate task)
- ❌ Per-scene speed variation (parked — waiting on 12-streamer test data first)
- ❌ Photo Avatar Motion API (post-12-test-case investigation)
- ❌ Video Agent API (post-12-test-case investigation)
- ❌ Streamer dropdown UX (Task #8, separate future work)
- ❌ Drawtext ticker replacement (Task #22)
- ❌ Cards and end screens (permanently manual per Upload-Post API limits)
- ❌ Any other pending handoff or task not listed above

**Ship both. Report back. Stand by.**
