# CLINE DISPATCH — Triple Ship (2026-04-11 evening)

**Context:** Three independent handoffs, all unblocking Rob's first real 12-streamer production test. Ship them back-to-back as **three separate commits**, in the order below.

---

## Order of operations

### 1. FIRST — TV card y=352 (trivial, ~5 min)

**Handoff file:** `CLINE_HANDOFF_TV_CARD_HEIGHT_HALFWAY.md`

- Single-line config change: `lib/config.js:55` `y: 100` → `y: 352`
- Update the inline comment per handoff
- Commit message in handoff
- STATUS.md row in handoff
- Push
- **Do not bundle with #2**

### 2. SECOND — 12-streamer silent-drop visibility (~25 min)

**Handoff file:** `CLINE_HANDOFF_TWITCH_12_STREAMER_DROP_VISIBILITY.md`

- Three changes in `cwn_production.html` only:
  - Line 3094: 24h window → 7d window
  - Lines 3114–3118: add `extraemily` + `yourragegaming` to DISPLAY_NAMES
  - Drop-tracking code (3a–3e per handoff). Part **3f is optional** — skip it if `callFullScriptServer`'s signature looks risky
- Verification steps per handoff (grep + syntax)
- Commit message in handoff
- STATUS.md row in handoff
- Push

### 3. THIRD — Auto-publish thumbnail + pinned comment + chapters (~40 min)

**Handoff file:** `CLINE_HANDOFF_AUTO_PUBLISH_THUMB_AND_COMMENT.md`

- `server.js` only — ~70 lines across 4 locations in the Gate 6 auto-publish block
- Part 1: hardcoded `PINNED_COMMENT_TEMPLATES` constant + usage in autonomous publish call
- Part 2: thumbnail Drive upload right after main MP4 upload + forward as `thumbnailUrl`
- Part 3: server-side `buildYouTubeChapters()` helper + append to description as `descriptionWithChapters`
- Verification steps per handoff (grep + syntax + nodemon restart)
- Commit message in handoff
- STATUS.md row in handoff
- Push

---

## Rules for all three

1. **Three separate commits.** Not bundled. Clean rollback per fix if anything goes sideways.
2. **Touch only the files named in each handoff.** No cross-pollination between handoffs.
3. **Do not touch anything outside the named files.** No opportunistic cleanup, no "while I'm here" edits.
4. **Ship all three even if Rob hasn't run the test yet.** Rob is waiting on all three to unblock the 12-streamer real-content run.
5. **STATUS.md gets THREE new "Last Agent Action" rows**, one per commit — do not combine.
6. **If any handoff hits a snag** (syntax error, unexpected code shape, etc): ship the others anyway, write a short "blocked" note in STATUS.md for the one that failed.
7. **Handoff #3 is the biggest** — give it a full nodemon restart + syntax check before pushing. If `node -c server.js` fails, fix the specific block that broke and re-check before committing.

---

## After all three ship

Report back with:
- All three commit hashes
- Whether Part 3f of handoff #2 was included or skipped
- Any unexpected findings during handoff #3 nodemon restart

Rob will immediately paste the 12-streamer list into the textarea and run GENERATE TWITCH VIDEO:
```
jasontheween, hasanabi, adapt, stableronaldo, lacy, marlon, cinna, yonnajay, jaycinco, maya, extraemily, yourragegaming
```

---

## What's NOT in this dispatch

- ❌ Gate 1 report restructure (existing report is correct)
- ❌ Real streamer dropdown UI (Task #8, separate future work)
- ❌ Drawtext ticker replacement (Task #22)
- ❌ YouTube cards or end screens (permanently manual per Rob — Upload-Post API does not support)
- ❌ Short-form auto-publish enhancements (handoff #3 is long-form focused; Shorts changes are additive and harmless but not the target)
- ❌ Any other pending handoff or task not listed above

**Ship all three. Report back. Stand by.**
