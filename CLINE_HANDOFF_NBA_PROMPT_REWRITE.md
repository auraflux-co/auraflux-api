# CLINE_HANDOFF_NBA_PROMPT_REWRITE.md

**Author:** Claude Code (dispatched 2026-04-12 late evening)
**For:** Cline (implementation)
**Scope:** NBA long-form — rewrite the Gemini prompt at `server.js:6710-6764` to eliminate the CLIP_REACTION PIP fiction, same pattern as News Fix 6 shipped tonight as commit `9a4fcc6`. This is Wave 1-NBA blocker — unblocks Gap #22 and #23 in Wave 2.
**Ship order:** Single atomic commit.
**Do NOT touch:** News Gemini prompt (Fix 6 already shipped), Twitch Gemini prompt (working as-is), any assembly code, heygen-poller, Gate 1 validation logic.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Context

NBA long-form's current Gemini prompt at `server.js:6710-6764` has the same structural flaw News had before Fix 6 shipped as commit `9a4fcc6`: the `CLIP_REACTION` scene type is labeled as *"picture-in-picture with the clip"* which is a design mode that does not exist in the assembly pipeline. Picture-in-picture was never implemented. The CLIP_REACTION scene gets rendered as a standalone avatar segment AFTER the clip ends, producing a 1-sentence quip followed immediately by another 1-sentence REACTION quip with no structural differentiation — same redundancy Rob flagged on News smoke tests before Fix 6.

## Current state (what's in the code today)

### `server.js:6684-6697` — NBA scene headers construction

```javascript
// Generate scene headers for NBA (4 scenes per game: intro + setup + clip_reaction + reaction)
const sceneHeaders = ['=== INTRO ==='];
items.forEach((g, i) => {
  const gameLabel = `GAME${i+1}`;
  const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
  const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
  const teams = `${awayClean}_${homeClean}`;
  sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_SETUP ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_CLIP_REACTION ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_REACTION ===`);
});
sceneHeaders.push('=== OUTRO ===');
const expectedScenes = sceneHeaders.length;
```

### `server.js:6720-6763` — the problematic prompt section

```
⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- [GAME]_[TEAMS]_INTRO scenes: 2-3 sentences (introduce game/matchup)
- [GAME]_[TEAMS]_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- [GAME]_[TEAMS]_CLIP_REACTION scenes: EXACTLY 1 sentence (Bobby reacting WHILE clip plays — this will be overlaid on clip in editing)
- [GAME]_[TEAMS]_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan reaction AFTER clip)
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== GAME#_[TEAMS]_INTRO ===
[2-3 sentences. Introduce the matchup. Build anticipation.]

=== GAME#_[TEAMS]_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about the game. Second sentence: specific setup for the highlight clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_CLIP_REACTION ===
[EXACTLY 1 sentence. Bobby's live reaction WHILE watching the clip. This will be picture-in-picture with the clip.]

=== GAME#_[TEAMS]_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. Final take AFTER the clip.]

=== OUTRO ===
[1-2 sentences. Sign-off.]

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each CLIP_REACTION scene: EXACTLY 1 sentence (live reaction during clip)
- Each REACTION scene: EXACTLY 1 sentence (deadpan take after clip)
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never explain the take in reactions. Never recap what just happened.

Use Gemini video analysis AND box score data for specific, accurate content.
Target: 120-150 words spoken per game segment (90 seconds of delivery).
```

## Problems with the current prompt

1. **CLIP_REACTION's "picture-in-picture" framing is a fiction.** PIP is not implemented in the NBA assembly branch at `server.js:3968-4038` or the NBA voiceover branch at `server.js:4109-4164`. The CLIP_REACTION scene is rendered as a standalone avatar segment, same as any other avatar beat.

2. **CLIP_REACTION and REACTION are redundant one-liners.** Both are 1-sentence with no structural differentiation ("live reaction" vs "deadpan reaction AFTER clip" — nothing in the visual pipeline makes these different to the viewer). Same redundancy Rob flagged on News.

3. **SETUP's "2 sentences" target is too short for the voiceover architecture.** NBA uses the voiceover branch at `server.js:4109` where SETUP's audio gets mixed OVER the clip's video. SETUP at 2 sentences = ~6-10 seconds of narration, but ESPN highlights are typically 20-45 seconds, so the clip gets truncated to narration length by the FFmpeg `-shortest` flag. **Gap #22 in Wave 2 will fix the word count, but the scene structure must change first (this handoff) so Wave 2 has something to build on.**

## The fix — mirror Fix 6's pattern for NBA

Fix 6 for News (commit `9a4fcc6`) renamed `CLIP_REACTION` → `SUMMARY` and gave each scene a structurally distinct job. NBA needs the same treatment with NBA-specific role assignments.

**Critical difference from News Fix 6:** News's new flow is `INTRO → SETUP → [clip] → SUMMARY → REACTION` where Bobby G is on screen for every avatar segment and the clip plays between SETUP and SUMMARY. **NBA is different** — NBA uses the voiceover branch where Bobby G's SETUP audio plays OVER the clip video (avatar hidden during the clip). So NBA's scene roles are:

- **INTRO** (cold open) — Bobby G episode intro, unchanged
- **GAME#_INTRO** — Bobby G on screen, introduces the matchup, TV card with game info in top-right OVERLAY_ZONE
- **GAME#_NARRATION** — Bobby G's audio mixed over the ESPN highlight video (avatar hidden). This is the scene whose audio gets voiceovered. Must be long enough to cover the clip duration. (Gap #22 in Wave 2 will feed `clipDuration` into the target word count; this handoff just locks the scene structure.)
- **GAME#_REACTION** — Bobby G back on screen AFTER the clip ends, 1-sentence deadpan take. Not a recap — the NARRATION already described what happened during the clip.
- **OUTRO** — Bobby G sign-off, unchanged

**Renaming:**
- `GAME#_[TEAMS]_SETUP` → `GAME#_[TEAMS]_NARRATION` (this is the audio track that plays over the clip)
- `GAME#_[TEAMS]_CLIP_REACTION` → DELETED entirely (PIP fiction goes away)
- `GAME#_[TEAMS]_INTRO` → stays
- `GAME#_[TEAMS]_REACTION` → stays

**Scene count changes:**
- Old: 4 scenes per game = `1 + items.length * 4 + 1`
- New: 3 scenes per game = `1 + items.length * 3 + 1`

For 5 NBA games: old = 22 scenes, new = 17 scenes. Fewer HeyGen renders per episode. Cost savings as a side effect.

**`[CLIP PLAYS HERE]` marker count** stays at `items.length` (one per game) — the marker still exists structurally, but NARRATION's audio is what plays over it via the voiceover branch.

---

## Change 1 — `server.js:6684-6697` scene headers construction

**From:**
```javascript
const sceneHeaders = ['=== INTRO ==='];
items.forEach((g, i) => {
  const gameLabel = `GAME${i+1}`;
  const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
  const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
  const teams = `${awayClean}_${homeClean}`;
  sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_SETUP ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_CLIP_REACTION ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_REACTION ===`);
});
sceneHeaders.push('=== OUTRO ===');
const expectedScenes = sceneHeaders.length;
```

**To:**
```javascript
const sceneHeaders = ['=== INTRO ==='];
items.forEach((g, i) => {
  const gameLabel = `GAME${i+1}`;
  const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
  const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
  const teams = `${awayClean}_${homeClean}`;
  sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_NARRATION ===`);
  sceneHeaders.push(`=== ${gameLabel}_${teams}_REACTION ===`);
});
sceneHeaders.push('=== OUTRO ===');
const expectedScenes = sceneHeaders.length;
```

## Change 2 — `server.js:6720-6728` scene length rules

**From:**
```
⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- [GAME]_[TEAMS]_INTRO scenes: 2-3 sentences (introduce game/matchup)
- [GAME]_[TEAMS]_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- [GAME]_[TEAMS]_CLIP_REACTION scenes: EXACTLY 1 sentence (Bobby reacting WHILE clip plays — this will be overlaid on clip in editing)
- [GAME]_[TEAMS]_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan reaction AFTER clip)
- OUTRO scene: 1-2 sentences (sign-off)
```

**To:**
```
⚠️ SCENE LENGTH RULES:
- INTRO scene: 2-3 sentences (episode intro)
- [GAME]_[TEAMS]_INTRO scenes: 2-3 sentences (introduce the matchup, teams, stakes). Bobby G is on screen during this scene with the game's TV card in the top-right corner.
- [GAME]_[TEAMS]_NARRATION scenes: 4-8 sentences — this is the audio track that plays OVER the ESPN highlight video. Bobby G's voice narrates what the viewer is seeing on screen in real time. Avatar is NOT on screen during the clip — only the narration audio. Length must be sized to cover the full clip playback. Describe the action play-by-play as if you were calling the game from the booth. Do NOT explain or recap AFTER — the viewer sees the clip as you speak. Keep it factual, present-tense, play-by-play.
- [GAME]_[TEAMS]_REACTION scenes: EXACTLY 1 sentence. Bobby G is back on screen after the clip ends. Deadpan take on the play. Do NOT recap what happened — the narration already covered it. Just the take.
- OUTRO scene: 1-2 sentences (sign-off)
```

## Change 3 — `server.js:6730-6751` per-scene content structure

**From:**
```
📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== GAME#_[TEAMS]_INTRO ===
[2-3 sentences. Introduce the matchup. Build anticipation.]

=== GAME#_[TEAMS]_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about the game. Second sentence: specific setup for the highlight clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_CLIP_REACTION ===
[EXACTLY 1 sentence. Bobby's live reaction WHILE watching the clip. This will be picture-in-picture with the clip.]

=== GAME#_[TEAMS]_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. Final take AFTER the clip.]

=== OUTRO ===
[1-2 sentences. Sign-off.]
```

**To:**
```
📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone. Bobby G on screen.]

=== GAME#_[TEAMS]_INTRO ===
[2-3 sentences. Introduce the matchup — teams, stakes, storyline. Do NOT describe specific plays; save that for NARRATION. Bobby G on screen with the game's TV card visible in the top-right corner.]

=== GAME#_[TEAMS]_NARRATION ===
[4-8 sentences of play-by-play narration covering the ESPN highlight clip. Bobby G's audio plays OVER the clip video — avatar is NOT on screen during this scene, only the narration. Write in present tense as if you are calling the game from the booth. Describe the action visible in the clip (from Gemini's video analysis) with specific player names, numbers, outcomes. Length must cover the full clip duration — Gemini analysis field will include clip duration in seconds for reference.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_REACTION ===
[EXACTLY 1 sentence. Bobby G back on screen after the clip ends. Deadpan take on the play — what it means, what it tells us about the team, the season, the moment. Do NOT recap the play — NARRATION already called it. Just the take.]

=== OUTRO ===
[1-2 sentences. Sign-off.]
```

## Change 4 — `server.js:6753-6763` validation checklist + word count target

**From:**
```
✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each CLIP_REACTION scene: EXACTLY 1 sentence (live reaction during clip)
- Each REACTION scene: EXACTLY 1 sentence (deadpan take after clip)
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never explain the take in reactions. Never recap what just happened.

Use Gemini video analysis AND box score data for specific, accurate content.
Target: 120-150 words spoken per game segment (90 seconds of delivery).
```

**To:**
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

**Note on word count target:** the target is now lower (100-140 total vs 120-150) because the CLIP_REACTION scene is gone. NARRATION gets most of the word budget (~70-100 words for a 20-30s clip), INTRO gets ~20-30 words, REACTION gets ~10-15 words. **Gap #22 in Wave 2 will tune this further based on per-game clipDuration. This handoff just locks the scene structure and initial word count guidance.**

## Change 5 — Gate 1 Claude QA checklist update at `server.js:2281` and `server.js:2287` and `server.js:2622`

The Gate 1 QA checklist currently references CLIP_REACTION by name. Update those references:

**`server.js:2281` comment:**
```javascript
// BEFORE
//   - Remember: STORY1_INTRO, STORY1_SETUP, STORY1_CLIP_REACTION, STORY1_REACTION are 4 SEPARATE scenes

// AFTER — add NBA variant
//   - NBA: GAME1_TEAMS_INTRO, GAME1_TEAMS_NARRATION, GAME1_TEAMS_REACTION are 3 SEPARATE scenes
//   - News: STORY1_INTRO, STORY1_SETUP, STORY1_SUMMARY, STORY1_REACTION are 4 SEPARATE scenes (Fix 6)
```

**`server.js:2287` and `server.js:2622`** — NBA-specific checklist items. Search for `STORY SETUP` or similar in the NBA branch of `claudeScriptQA()` at `server.js:2242+` and update to reference NARRATION instead of SETUP/CLIP_REACTION.

**Grep check after edits:**
```bash
grep -n "CLIP_REACTION\|GAME.*SETUP" server.js
```

Expected:
- 0 hits inside the NBA prompt block (`server.js:6710-6764`)
- News still has `STORY#_SUMMARY` from Fix 6 — untouched
- Twitch still has its own CLIP_REACTION references (Twitch uses the pattern legitimately for PIP-less setup/reaction) — untouched

## What stays the same

- `INTRO` cold open scene — unchanged
- `OUTRO` sign-off scene — unchanged
- NBA scene count math formula `1 + items.length * N + 1` — just N changes from 4 to 3
- `[CLIP PLAYS HERE]` marker count — still `items.length` (one per game)
- `parseSegments_v2` segment parser — no changes needed (regex already handles any `=== HEADER ===` pattern)
- Heygen-poller clip insertion logic at `server.js:219` — no changes (NARRATION is just another avatar scene label, gets interleaved same as SETUP did)
- NBA voiceover branch at `server.js:4109-4164` — no changes yet (will be replaced in Wave 3 by VectCutAPI-based voiceover per `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md`, but until then the existing FFmpeg voiceover uses whichever scene label comes right before the source_clip in segTypes — it was SETUP before, will be NARRATION now, auto-works)
- NBA TV card burn at `server.js:3968-4038` — no changes
- Gate 2 / Gate 3 QA — no changes

---

## Verification

### Grep checks

```bash
# NBA prompt should have no CLIP_REACTION references
grep -n "CLIP_REACTION" server.js | grep -v "^.*Twitch\|STORY\|News" | head

# NBA prompt should have NARRATION references
grep -n "NARRATION" server.js | head

# Scene count math — should still be dynamic
grep -n "expectedScenes" server.js | head
```

Expected:
- 0 hits for CLIP_REACTION in the NBA prompt block
- 3+ hits for NARRATION in the NBA prompt block (header push + length rule + content structure)
- Scene count math unchanged (just different multiplier)

### Syntax check

```bash
node -c server.js
```

Exit 0.

### Test script gen without assembly (fast feedback)

If possible, run a dashboard-driven NBA script generation for 2 games without sending to HeyGen. Verify:
- Gate 1 Claude QA scores the script (pass or manual review, not hard fail)
- Generated script has `=== GAME1_TEAMS_NARRATION ===` headers, NOT `GAME1_TEAMS_SETUP` or `GAME1_TEAMS_CLIP_REACTION`
- Scene count matches formula: `1 + 2*3 + 1 = 8 scenes` for 2 games
- `[CLIP PLAYS HERE]` count = 2
- NARRATION scenes contain play-by-play present-tense language

---

## Commit strategy

```
fix(nba): rewrite Gemini prompt to eliminate CLIP_REACTION PIP fiction (Wave 1-NBA)

Same pattern as News Fix 6 (commit 9a4fcc6). NBA's GAME#_CLIP_REACTION scene
was labeled as "picture-in-picture with the clip" but PIP is not implemented
in the assembly pipeline. The scene renders as a standalone 1-sentence quip
followed immediately by REACTION's 1-sentence quip — same back-to-back
redundancy Rob flagged on News before Fix 6.

This rewrite:
- Renames SETUP → NARRATION (the audio track that plays OVER the clip via
  the voiceover branch at server.js:4109)
- Deletes CLIP_REACTION entirely (PIP fiction goes away)
- Tightens REACTION to 1-sentence deadpan, no recap
- Reduces scene count from 4 per game to 3 per game (22 → 17 scenes for 5 games)
- Updates word count target from 120-150 → 100-140 per game (NARRATION carries
  most of the word budget now)

Wave 2 will feed clipDuration into the prompt (Gap #23) and tune NARRATION
word count to match clip duration (Gap #22). This handoff locks the scene
structure so Wave 2 has something to build against.

Changes:
- server.js:6684-6697 — scene headers: 4 → 3 per game
- server.js:6720-6728 — length rules rewritten for NARRATION semantics
- server.js:6730-6751 — per-scene content structure: NARRATION is play-by-play
- server.js:6753-6763 — validation checklist + word count target
- server.js:2281 — Gate 1 QA comment mentions NBA's new 3-scene pattern
- server.js:~2287 or ~2622 — Gate 1 NBA checklist updated (grep for CLIP_REACTION)

Unchanged:
- INTRO / OUTRO scenes
- Scene count formula (1 + N*items + 1, just N=3 now)
- parseSegments_v2 regex
- heygen-poller clip insertion logic
- NBA TV card burn at server.js:3968
- NBA voiceover branch at server.js:4109 (Wave 3 will replace with VectCutAPI)
- News Fix 6 SUMMARY scene type (not touched)
- Twitch prompt (not touched)

References: LONGFORM_FIX_ROTATION.md NBA Wave 1, gap audit Gap #21
```

Per `COMMIT_CHECKLIST.md`:
1. Atomic staging: `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push`
2. STATUS.md Last Agent Action row
3. LONGFORM_FIX_ROTATION.md — move Gap #21 from Dispatched → Shipped with commit hash

---

## Rollback plan

If the new prompt causes Gemini to fail or Gate 1 to hard-fail unexpectedly:

```bash
git revert HEAD && git push
```

Zero downstream risk — change is entirely inside the NBA Gemini prompt template. No code flow changes.

---

## What this fix does NOT solve

1. **Gap #23 — `clipDuration` not fed into NBA Gemini prompt.** Wave 2 handoff covers this. Without it, Gemini writes NARRATION at a default target word count (100-140) which may not match the actual ESPN clip duration. Voiceover mix via existing FFmpeg `-shortest` flag will still truncate if NARRATION audio is shorter than clip video.
2. **Gap #22 — NARRATION word count target.** Wave 2 handoff tunes this per-clip based on clipDuration. This handoff uses a reasonable default (100-140 total, ~70-100 for NARRATION).
3. **Gap #26 — voiceover architecture.** The existing FFmpeg voiceover branch at `server.js:4109-4164` still truncates clips to narration length via `-shortest`. Wave 3 replaces this with VectCutAPI-based audio pipeline (draft creation + volume 0 on clip + narration + background music mix). Until Wave 3 ships, NBA clips may still appear truncated even with correct NARRATION word count.
4. **NBA full newscast chrome.** NBA does NOT get the News-style full chrome layer in this handoff. That's Gap #27, part of the post-test shared-template rebrand.

---

## Why this works (teaching section)

**The PIP fiction was the root of the redundancy.** When Gemini is told "CLIP_REACTION is live reaction while clip plays," it writes a 1-sentence hot-take. Then REACTION is also 1-sentence. With no visual differentiation in the assembly, these collapse into two unconnected quips back-to-back — the viewer hears ten 1-sentence one-liners in a row across a 5-game episode and the delivery feels shallow.

**Renaming to NARRATION gives the scene a structurally distinct job:** it's no longer "reacting to" the clip, it's "calling" the clip. The voiceover branch takes that audio and plays it over the clip video — exactly what a real sports broadcast does. NARRATION at 4-8 sentences fills ~20-40 seconds of speech (enough to cover most ESPN highlights) and the viewer hears play-by-play calling the action in real time rather than a hot-take reacting to footage they're about to see.

**Removing CLIP_REACTION as a separate scene** means the pipeline has one less HeyGen render per game, one less segment boundary to concat, and one less redundancy point for the viewer. Ship cost goes down, quality goes up.

**The word count target is intentionally loose in this handoff (100-140)** because Wave 2's clipDuration-aware tuning will tighten it per-game. Writing a per-clip target requires Wave 2's `clipDuration` context which isn't in the prompt yet. For this handoff, the 100-140 range gives Gemini enough flexibility to produce workable NARRATION without over-constraining it before we have per-clip data.

---

## Checklist for Cline

- [ ] `server.js:6684-6697` scene headers: push `NARRATION` not `SETUP` or `CLIP_REACTION`
- [ ] `server.js:6720-6728` length rules: NARRATION = 4-8 sentences play-by-play, REACTION = 1 sentence deadpan
- [ ] `server.js:6730-6751` content structure: NARRATION section rewritten with play-by-play guidance
- [ ] `server.js:6753-6763` validation checklist + word count target (100-140)
- [ ] `server.js:2281` comment update for NBA's new 3-scene pattern
- [ ] `server.js:~2287/~2622` Gate 1 NBA checklist items updated (grep for CLIP_REACTION in NBA branch)
- [ ] Grep: 0 hits for CLIP_REACTION in NBA prompt block
- [ ] Grep: 3+ hits for NARRATION in NBA prompt block
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated
- [ ] Atomic commit via chained `git add && git commit && git push`
