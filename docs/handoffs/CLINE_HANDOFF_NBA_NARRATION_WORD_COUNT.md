# CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md

**Author:** Claude Code (dispatched 2026-04-12 late evening)
**For:** Cline (implementation)
**Scope:** NBA long-form — tighten the NBA Gemini prompt's NARRATION word count target to match per-clip duration, using the `clipDuration` data added in the previous handoff. Fixes Gap #22. **Wave 2-NBA — BLOCKED until both `CLINE_HANDOFF_NBA_PROMPT_REWRITE.md` (Wave 1-NBA Gap #21) AND `CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md` (Wave 2-NBA Gap #23) have shipped.**
**Ship order:** Single atomic commit. Small change.
**Do NOT touch:** News Gemini prompt, Twitch Gemini prompt, any assembly code, scene header construction, Gate 1 core validation logic (scene count / clip count math stays the same).
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Dependency order

**MUST ship after both:**
1. `CLINE_HANDOFF_NBA_PROMPT_REWRITE.md` (Wave 1-NBA, Gap #21) — scene structure renamed to NARRATION
2. `CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md` (Wave 2-NBA, Gap #23) — clipDuration fed into prompt context

**Pre-ship verification:**
```bash
grep -n "ESPN highlight clip duration" server.js
# Should return a hit in the NBA prompt (from Gap #23 handoff)
grep -n "CLIP DURATION GUIDANCE" server.js
# Should return a hit in the NBA prompt (from Gap #23 handoff)
grep -n "NARRATION scenes" server.js
# Should return a hit in the NBA prompt (from Gap #21 handoff)
```

If any of these return 0 hits, the upstream handoffs haven't shipped yet. Do NOT proceed.

---

## Context

The previous handoff (Gap #23) fed `clipDuration` into the NBA Gemini prompt context and added a CLIP DURATION GUIDANCE paragraph describing how to size NARRATION word count. But that guidance is descriptive, not enforced — Gemini can ignore it. This handoff adds the formal validation:

1. **Strengthens the validation checklist** so the prompt explicitly requires NARRATION word count to match clip duration at Bobby G's speaking pace (~2.5 words/second at speed 0.85)
2. **Adds per-game word count range display** in the prompt so Gemini sees the target for each specific game, not a generic rule

---

## The changes

### Change 1 — `server.js:~6706` (after Gap #23 lands, this line exists)

The Gap #23 handoff adds this line to the `items.map` GAME DATA template:

```javascript
ESPN highlight clip duration: ${g.clipDuration ? Math.round(g.clipDuration) + ' seconds' : 'unknown'}
```

**This handoff extends that line** to ALSO compute and display the NARRATION word count target inline:

```javascript
ESPN highlight clip duration: ${g.clipDuration ? Math.round(g.clipDuration) + ' seconds' : 'unknown'}
NARRATION word count target for this game: ${g.clipDuration ? Math.round(g.clipDuration * 2.5) + '-' + Math.round(g.clipDuration * 3) + ' words' : '70-90 words (default)'}
```

**Why the 2.5-3.0 multiplier:** Bobby G speaks at `HEYGEN_SPEAK_SPEED=0.85` (per CLAUDE.md). Normal English speech is ~150 words per minute = 2.5 words per second. Slightly slowed to 0.85 speed = effective ~2.5-3.0 words per second of rendered video. The narration needs to cover the full clip without feeling rushed, so target the UPPER bound of that range to leave margin for pauses.

For a 25-second clip: `25 * 2.5 = 62 words` to `25 * 3 = 75 words`. Gemini targets that range.

### Change 2 — `server.js:~6720` SCENE LENGTH RULES section

After Wave 1-NBA shipped, the NARRATION rule currently reads:

```
- [GAME]_[TEAMS]_NARRATION scenes: 4-8 sentences — this is the audio track that plays OVER the ESPN highlight video. ...
```

**Update the NARRATION rule to reference per-game word counts instead of a blanket sentence range:**

```
- [GAME]_[TEAMS]_NARRATION scenes: play-by-play calling the clip from the broadcast booth, sized to cover the full clip duration. See GAME DATA above for per-game target word counts — use the upper end of the range to guarantee narration covers the full clip. Write in present tense. If the clip is very short (<15 seconds), target ~35-40 words. If very long (>60 seconds), split into 2-3 short sentences instead of one long run-on.
```

### Change 3 — `server.js:~6753` VALIDATION CHECKLIST section

After Wave 1-NBA shipped, the validation checklist currently reads:

```
✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each NARRATION scene: 4-8 sentences, play-by-play in present tense, contains [beat] + [CLIP PLAYS HERE] + [beat] after the narration text
- Each REACTION scene: EXACTLY 1 sentence (deadpan take, no recap)
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never recap the play in REACTION — NARRATION already called the action.
- Never mention "watch this" or "check this out" in INTRO/NARRATION — just call the game like a broadcaster.

Use Gemini video analysis AND box score data for specific, accurate content. Include player names, jersey numbers, shot types, and game situation.
Target: 100-140 words spoken per game segment including INTRO + NARRATION + REACTION. NARRATION portion sized to cover the full clip duration.
```

**Update it to reference per-game word count targets and add a per-game word count validation rule:**

```
✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each NARRATION scene: word count matches "NARRATION word count target for this game" in the GAME DATA section. Tolerance: ±15% around the upper bound. Contains [beat] + [CLIP PLAYS HERE] + [beat] after the narration text.
- Each REACTION scene: EXACTLY 1 sentence (deadpan take, no recap)
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never recap the play in REACTION — NARRATION already called the action.
- Never mention "watch this" or "check this out" in INTRO/NARRATION — just call the game like a broadcaster.
- Play-by-play must be present-tense, specific (player names, jersey numbers, shot types), and cover the full clip duration without dead air.

Use Gemini video analysis AND box score data for specific, accurate content.
Total script target: INTRO (~25 words) + per-game (INTRO ~25 + NARRATION [per GAME DATA] + REACTION ~15) + OUTRO (~25 words).
```

### Change 4 (optional, polish) — `server.js:~6715` CLIP DURATION GUIDANCE paragraph

The Gap #23 handoff added a CLIP DURATION GUIDANCE paragraph with the rule-of-thumb table:
```
- 15-second clip → ~38-45 words of NARRATION
- 20-second clip → ~50-60 words of NARRATION
- ...
```

**If Gap #23's handoff placed that guidance BEFORE the SCENE STRUCTURE section, this handoff can remove it now** since the per-game word count target is embedded directly in the GAME DATA block and is more specific. Delete the CLIP DURATION GUIDANCE section entirely — the per-game line in GAME DATA replaces it.

If Gap #23's handoff placed the guidance elsewhere, leave it — belt-and-suspenders is fine.

---

## Verification

### Grep checks

```bash
grep -n "NARRATION word count target for this game" server.js
# Should return a hit in the items.map NBA prompt block (NEW from this handoff)

grep -n "word count matches.*NARRATION word count target" server.js
# Should return a hit in the validation checklist (NEW from this handoff)

grep -n "Tolerance.*±15%" server.js
# Should return a hit in the validation checklist (NEW from this handoff)
```

### Syntax check

```bash
node -c server.js
# Exit 0
```

### End-to-end smoke test (optional but recommended)

If you have time, run a dashboard-driven NBA script generation with 2 games where one game has a 20s clip and one has a 35s clip. Verify:
1. Prompt text sent to Gemini contains two different word count targets (e.g., `50-60 words` and `88-105 words`)
2. Gemini's output NARRATION for game 1 is ~50-60 words, game 2 is ~88-105 words (±15% tolerance)
3. Gate 1 Claude QA either passes or does not hard-fail on word count mismatch (claudeScriptQA doesn't explicitly check NARRATION word count against targets yet — it's soft guidance for Gemini, not a hard validation)

**Note:** Adding a HARD validation for NARRATION word count in `claudeScriptQA()` at `server.js:2242` is out of scope for this handoff. If you want, flag it as a future follow-up. For now, Gemini is encouraged by the prompt to hit the target and Claude's QA will catch wildly-off scripts through the existing "CLIP MATCH" check.

---

## Commit strategy

```
feat(nba): tune NARRATION word count per-game to match clip duration (Wave 2-NBA Gap #22)

Uses clipDuration (plumbed in Gap #23 handoff) to calculate per-game NARRATION
word count targets and embed them directly in the NBA Gemini prompt's GAME DATA
block. Updates validation checklist to enforce the per-game targets with ±15%
tolerance.

Bobby G speaks at HEYGEN_SPEAK_SPEED=0.85, which at ~2.5-3.0 effective words per
second means:
- 15s clip → 38-45 words
- 20s clip → 50-60 words
- 30s clip → 75-90 words
- 45s clip → 113-135 words

Depends on:
- CLINE_HANDOFF_NBA_PROMPT_REWRITE.md (Wave 1, Gap #21) — NARRATION scene type
- CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md (Wave 2, Gap #23) — clipDuration in prompt

Without both upstream handoffs shipped, this handoff has nothing to build on.

Changes:
- server.js:~6706 — items.map GAME DATA: add "NARRATION word count target" line per game
- server.js:~6720 — NARRATION scene length rule references per-game targets
- server.js:~6753 — validation checklist requires NARRATION word count match with ±15% tolerance
- server.js:~6715 — optionally remove CLIP DURATION GUIDANCE paragraph (now redundant)

No Gate 1 core validation changes. Gate 1 still validates scene count + clip
count. NARRATION word count is enforced via prompt instructions, not as a
hard-fail check in claudeScriptQA (future follow-up if needed).

References: LONGFORM_FIX_ROTATION.md NBA Wave 2, gap audit Gap #22
```

Per `COMMIT_CHECKLIST.md`:
1. Atomic staging: `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push`
2. STATUS.md Last Agent Action row
3. LONGFORM_FIX_ROTATION.md — move Gap #22 from Dispatched → Shipped

---

## Rollback plan

```bash
git revert HEAD && git push
```

Zero downstream risk — prompt text only, no code flow changes.

---

## What this fix does NOT solve

1. **Voiceover architecture** — Gap #26, Wave 3. The existing FFmpeg `-shortest` voiceover still truncates if narration is shorter than clip. Even with perfect word count, the old voiceover branch may still produce wrong output. Wave 3 replaces that branch with VectCutAPI-based audio pipeline.
2. **Hard word count validation in Gate 1** — Out of scope. `claudeScriptQA()` at `server.js:2242` does not currently check NARRATION word count against clipDuration-derived targets. If this becomes a recurring failure mode, add it as a follow-up.
3. **Background music integration** — Gap #31 (Rob's tracks) + Gap #26 (Wave 3 voiceover rebuild). Not in this handoff.

---

## Checklist for Cline

- [ ] Wave 1-NBA shipped (scene structure uses NARRATION)
- [ ] Wave 2-NBA Gap #23 shipped (clipDuration in GAME DATA block)
- [ ] `server.js:~6706` GAME DATA template includes per-game word count target line
- [ ] `server.js:~6720` NARRATION scene length rule references per-game targets from GAME DATA
- [ ] `server.js:~6753` validation checklist includes NARRATION word count match with ±15% tolerance
- [ ] Optional: `server.js:~6715` CLIP DURATION GUIDANCE paragraph removed (now redundant)
- [ ] Grep checks for new strings pass
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated (Gap #22 Dispatched → Shipped)
- [ ] Atomic commit via chained `git add && git commit && git push`
