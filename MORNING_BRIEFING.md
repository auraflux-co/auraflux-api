# Morning Briefing — 2026-04-21

**Session closed:** ~2:00 AM ET Apr 20 (Rob went to bed)
**Commit:** `02c8911` — fix(chrome): cap flag at 88px + Twitch sidebar reads segment cardData
**Branch:** `aider/test-suite`

---

## What Was Fixed Tonight

### 1. Chrome flag height (lib/chrome_overlay_ffmpeg.js)
**Bug:** 2-line titles expanded flag from 88px → 110px, covering Bobby G's face (face zone ~y=120, flag was reaching y=158).
**Fix:** Flag always stays at 88px spec max. 2-line titles use fontsize=20 instead of 28.
**Visible in:** NBA video had massive flag covering Bobby G's head.

### 2. Twitch sidebar empty (lib/assembly.js)
**Bug:** Twitch branch read sidebar data from `streamerRoster` — empty for all new pipeline jobs and synth tests.
**Fix:** First scans INTRO segments for `cardData` (same pattern NBA/News already used), falls back to `streamerRoster`.
**Visible in:** Twitch video had the sidebar panel but zero story cards inside it.

### 3. Synth test Twitch payload (test/synth_assembly_test.js)
**Bug:** `JASON_INTRO` segment had no `cardData` — the test wasn't exercising the sidebar at all.
**Fix:** Added `cardData: { title, displayName, origin, fact }` to match News/NBA pattern.

---

## Status When You Wake Up

**Synth test was still running when I committed.** Check for output:
```bash
ls -lt output/*.mp4 | head -6
# Look for news_synth / twitch_synth / nba_synth from today
```

If output files exist — open them and verify:
- Flag is flush to left edge, does NOT cover Bobby G's face (88px max)
- Sidebar cards visible on the right side for all 3 content types
- News: 3 story cards (Ceasefire / Markets / Amazon)
- Twitch: Jason card with "New York · Just hit 50k subs"
- NBA: Lakers vs Celtics card

---

## Priority Order For Today

### Must complete before Render deploy

**1. [pause]/[beat] markers being spoken by Bobby G**
Bobby G literally said "pause" on the news video. Only `CAPTION:` labels are currently stripped before HeyGen submission. Need to also strip `[pause]`, `[beat]`, `[BEAT]`, `[PAUSE]` in `lib/script_gen.js` before text is sent.
→ Sub-Agent A, quick fix, 15 min

**2. AJ portrait pillarbox not applied**
News clips are 608x1080 portrait, stretched to 1920x1080. The `pillarboxFilter` field exists on the segment object but `lib/assembly.js` never applies it. Fix: when `seg.sourceOrientation === 'portrait'` apply the filter in the FFmpeg command for that clip.
→ Sub-Agent A, same commit as #1

**3. Run synth test short-form**
`node test/synth_assembly_test.js short`
Verify: Bobby G top, clip bottom, caption at ~y=920, no chrome flag (shorts have no sidebar/flag).

**4. Re-run full synth test after fixes**
`node test/synth_assembly_test.js news twitch nba short`
All 4 pass → ready to tell Rob we're ready for Render.

### Render deploy (when synth passes, Rob says go)
- Sub-Agent A: render.yaml + server config
- Sub-Agent B: Postgres migration plan + env vars
- Remember: `TZ=UTC` in Render env vars

### Post-Render (do NOT touch now)
- YouTube test channel (10/day limit hit last night — needs a separate channel for testing)
- NBA narration accuracy — Gemini fabricates player names, needs real data source wired in
- Deprecated Puppeteer chrome functions cleanup (delete after 2 clean synth test runs)
- NR alert policies, designSpec decoupling, chrome rename

---

## How To Start Your Session

```
1. Read CLAUDE.md → STATUS.md
2. Check synth test output (ls -lt output/*.mp4 | head -6)
3. Tell me what you see on the videos
4. I'll spawn Sub-Agent A for the [pause] + pillarbox fixes
5. Re-run synth test
6. If all pass — "ready for Render?"
```

---

## Key Numbers From Last Night's Production Run
- 3 videos assembled (NBA / News / Twitch long-form)
- 0 published — YouTube 10/day rate limit hit on all 4 upload attempts
- Chrome bugs visible in all 3 assembled videos (flag too large, sidebar empty)
- HeyGen: avatar path confirmed working. Template API permanently abandoned.
- GATE_TEST_MODE is currently `false` in .env — pipeline runs end-to-end. Run synth test before any live job.
