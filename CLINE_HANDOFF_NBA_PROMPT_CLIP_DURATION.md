# CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md

**Author:** Claude Code (dispatched 2026-04-12 late evening)
**For:** Cline (implementation)
**Scope:** NBA long-form — feed `clipDuration` (from ESPN scraper) into the NBA Gemini prompt context so Gemini can size NARRATION word count to match actual clip length. Fixes Gap #23. **Wave 2-NBA — BLOCKED until `CLINE_HANDOFF_NBA_PROMPT_REWRITE.md` (Wave 1-NBA) ships first.** Required before `CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md` can ship.
**Ship order:** Single atomic commit. Small change.
**Do NOT touch:** News Gemini prompt, Twitch Gemini prompt, any assembly code, scene header construction (Wave 1-NBA already handled scene structure).
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Dependency order

**MUST ship after:** `CLINE_HANDOFF_NBA_PROMPT_REWRITE.md` (Wave 1-NBA). That handoff renames `CLIP_REACTION → NARRATION` and locks the scene structure. This handoff feeds data into the NEW scene structure.

**Wave 1-NBA ship verification before proceeding with this handoff:**
```bash
grep -n "GAME#_\[TEAMS\]_NARRATION\|GAME_NARRATION\|NARRATION scenes" server.js
# Should return hits in the NBA prompt block
grep -n "CLIP_REACTION" server.js | grep -i nba
# Should return 0 hits
```

If Wave 1-NBA has NOT shipped, do NOT proceed with this handoff. Wait.

**MUST ship before:** `CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md` (Wave 2-NBA next). That handoff uses `clipDuration` in the prompt to calculate per-clip word count targets. Without this handoff's data plumbing, the next handoff has nothing to read.

---

## Context

ESPN's game summary API at `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}` returns per-video `duration` in seconds. The NBA scraper at `server.js:5314 /nba/scrape-game-highlight` already extracts this:

```javascript
// server.js:5374
const result = {
  ok: true,
  gameId,
  videoUrl,
  thumbnail,
  title: highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights',
  description: highestDurationVideo.description || '',
  duration: maxDuration,   // ← already here
  videoCount: videos.length
};
```

And the dashboard at `cwn_production.html:4507` already stores it on the game entry:

```javascript
// cwn_production.html:4507
gameEntry.clipDuration = result.duration || null;
```

And `nbaUseSelected()` at line 4576 propagates it via `CURRENT_META.clipUrls`:

```javascript
selected.forEach(function(gm){
  clipUrls[gm.id] = { url: gm.clipUrl||'', duration: gm.clipDuration||null, title: gm.highlightTitle||'Game Highlights' };
});
```

And `generateNBA()` at `cwn_production.html:2972` hoists it onto the game item before sending to the server:

```javascript
// cwn_production.html:2972
games.forEach(function(gm){
  var cu=clipUrlsMap[gm.gameId];
  if(cu){ gm.clipUrl=cu.url; gm.clipDuration=cu.duration; }
});
```

**So `item.clipDuration` (in seconds) arrives at `server.js /generate-full-script` for NBA — but the NBA Gemini prompt at `server.js:6710+` never references it.** Gemini writes NARRATION without knowing how long the clip is, which leads to mismatched narration length (Gap #22, next handoff).

This handoff is the minimal change to feed `clipDuration` into the prompt context.

---

## The change

### Single edit at `server.js:6701-6713` (NBA prompt user-block's GAME DATA section)

**Current (after Wave 1-NBA ships):**
```javascript
userPrompt = `Write the COMPLETE Other Side of the Pillow NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total. ${items.length} [CLIP PLAYS HERE] markers required (one per game).

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
Gemini video analysis: ${analyses[i] || 'No analysis — use box score data only'}
`).join('')}
```

**New — add clip duration line right before the Gemini analysis line:**
```javascript
userPrompt = `Write the COMPLETE Other Side of the Pillow NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total. ${items.length} [CLIP PLAYS HERE] markers required (one per game).

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
ESPN highlight clip duration: ${g.clipDuration ? Math.round(g.clipDuration) + ' seconds' : 'unknown'}
Gemini video analysis: ${analyses[i] || 'No analysis — use box score data only'}
`).join('')}
```

### Add a note in the prompt body explaining how to use the duration

After the GAME DATA block but before the SCENE STRUCTURE section, add a paragraph explaining that NARRATION should be sized to cover the clip duration.

**Find this line in the current prompt (should be around `server.js:6715` after Wave 1-NBA):**
```
🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
```

**Add a new paragraph IMMEDIATELY BEFORE it:**
```
⏱ CLIP DURATION GUIDANCE:
Each game has an "ESPN highlight clip duration" in seconds. The NARRATION scene for that game
is the audio track that plays OVER the highlight video (via the voiceover branch at assembly time).
NARRATION word count must be long enough to cover the full clip duration at Bobby G's normal
speaking pace (roughly 150 words per minute, or ~2.5 words per second). This means:
- 15-second clip → ~38-45 words of NARRATION
- 20-second clip → ~50-60 words of NARRATION
- 30-second clip → ~75-90 words of NARRATION
- 45-second clip → ~110-130 words of NARRATION
If clip duration is "unknown", target ~70 words of NARRATION as a reasonable default.
If the clip is longer than 60 seconds, split the action into 2-3 sentences of present-tense
play-by-play instead of one long run-on sentence.

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
```

**That's the entire change.** No other code touched. No downstream logic changes. No Gate 1 validation updates (scene count and clip count are unchanged from Wave 1-NBA).

---

## Verification

### Grep checks

```bash
grep -n "clipDuration\|ESPN highlight clip duration\|CLIP DURATION GUIDANCE" server.js
```

Expected:
- `clipDuration` appears in the NBA prompt's `items.map` block (NEW)
- `ESPN highlight clip duration` appears once in the GAME DATA template (NEW)
- `CLIP DURATION GUIDANCE` appears once as a section header (NEW)

### Syntax check

```bash
node -c server.js
# Exit 0
```

### End-to-end smoke test (optional but recommended)

If you want to verify the prompt renders correctly before Cline ships, manually call `/generate-full-script` with a 1-game NBA payload that includes `clipDuration: 25` and confirm:
1. The rendered prompt sent to Gemini contains the string `ESPN highlight clip duration: 25 seconds`
2. Gemini's output script has a `GAME1_[TEAMS]_NARRATION` scene roughly 50-65 words long (within the guidance for a 25-second clip)

Not a hard requirement — Wave 2's next handoff (`CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md`) will add formal validation. For this handoff, Gemini just needs to see the duration data.

---

## Commit strategy

```
feat(nba): feed ESPN clipDuration into NBA Gemini prompt context (Wave 2-NBA Gap #23)

Adds the per-game ESPN highlight clip duration (already scraped by
/nba/scrape-game-highlight at server.js:5314) into the NBA Gemini prompt's
GAME DATA section, plus a CLIP DURATION GUIDANCE paragraph explaining how
to size NARRATION word count to cover the clip.

This handoff is plumbing-only — it feeds data into the prompt without
changing scene structure or validation. The NBA narration word count
tuning that actually uses this data lives in the next handoff
(CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md, Gap #22).

Depends on CLINE_HANDOFF_NBA_PROMPT_REWRITE.md (Wave 1-NBA, Gap #21)
having shipped first so the NARRATION scene type exists.

Changes:
- server.js:6706 — items.map GAME DATA template: add "ESPN highlight clip duration: Xs" line
- server.js:~6715 — new CLIP DURATION GUIDANCE paragraph before SCENE STRUCTURE section

No downstream changes. Gate 1 validation, scene count math, heygen-poller,
assembly code all unchanged.

References: LONGFORM_FIX_ROTATION.md NBA Wave 2, gap audit Gap #23
```

Per `COMMIT_CHECKLIST.md`:
1. Atomic staging: `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push`
2. STATUS.md Last Agent Action row
3. LONGFORM_FIX_ROTATION.md — move Gap #23 from Dispatched → Shipped

---

## Rollback plan

```bash
git revert HEAD && git push
```

Zero downstream risk — this is prompt text only, no code flow changes.

---

## What this fix does NOT solve

1. **NARRATION word count tuning** — Gap #22, next handoff. Gemini now SEES the clip duration but isn't yet REQUIRED to match narration length to it. Next handoff adds the hard validation.
2. **Voiceover architecture** — Gap #26, Wave 3. The existing FFmpeg `-shortest` voiceover still truncates if narration is shorter than clip. Wave 3 replaces with VectCutAPI.
3. **Per-scene word count within the game** — the guidance is total narration per game, not per individual sentence. Finer-grained tuning can happen later if needed.

---

## Checklist for Cline

- [ ] Wave 1-NBA (`CLINE_HANDOFF_NBA_PROMPT_REWRITE.md`) has shipped and been verified (grep check above)
- [ ] `server.js:~6706` GAME DATA template includes `ESPN highlight clip duration` line
- [ ] `server.js:~6715` CLIP DURATION GUIDANCE paragraph added before SCENE STRUCTURE
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated (Gap #23 Dispatched → Shipped)
- [ ] Atomic commit via chained `git add && git commit && git push`
