# CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md

**Author:** Claude Code (dispatched 2026-04-12 late evening)
**For:** Cline (implementation)
**Scope:** NBA long-form — replace the existing FFmpeg `-shortest` voiceover branch at `server.js:4109-4164` with a VectCutAPI-based audio pipeline that mutes the clip's native audio, mixes Bobby G's narration at full volume, and layers a background music track at reduced volume. **Wave 3-NBA — BLOCKED until multiple upstream handoffs have shipped AND Rob has dropped music tracks into `assets/audio/`.** Fixes Gap #26.
**Ship order:** Single atomic commit. Biggest handoff in the series — ~2-4 hours Cline work.
**Do NOT touch:** News Gemini prompt or assembly branches, Twitch assembly branch, short-form split-screen path (VectCutClient short-form methods stay working). The existing NBA TV card burn at `server.js:3968-4038` stays as-is — this handoff only replaces the voiceover mix step.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

**Rob's directive:** *"pick whats best for long term no shortcuts and no bandaids"* — applies to this handoff too. VectCutAPI is the durable architecture per Rob's tonight message. Do not fall back to FFmpeg filter_complex if VectCutAPI integration is tricky — iterate on VectCutAPI until it works correctly.

---

## Dependency chain

**MUST have shipped before this handoff starts:**

1. **`CLINE_HANDOFF_NBA_PROMPT_REWRITE.md`** (Wave 1-NBA, Gap #21) — scene structure renamed to NARRATION
2. **`CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md`** (Wave 2-NBA, Gap #23) — clipDuration in prompt
3. **`CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md`** (Wave 2-NBA, Gap #22) — narration word count matches clip duration
4. **`CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md`** (Wave 1, Gap #46) — VectCutClient.addAudioTrack / setClipVolume / exportDraft methods exist
5. **Rob must have dropped music tracks into `assets/audio/`.** This is a non-code blocker. Verify by running `ls assets/audio/*.mp3 assets/audio/*.wav 2>/dev/null` before starting — if the directory is empty or doesn't exist, pause and ask Rob.

**Pre-ship grep/ls verification:**
```bash
# Wave 1-NBA check
grep -n "NARRATION scenes" server.js
grep -n "CLIP_REACTION" server.js | grep -v -i "twitch\|news\|story"
# First should have hits, second should have 0 hits

# Wave 2-NBA Gap #23 check
grep -n "ESPN highlight clip duration" server.js
# Should have a hit

# Wave 2-NBA Gap #22 check
grep -n "NARRATION word count target" server.js
# Should have a hit

# Wave 1 VectCut foundation check
grep -n "addAudioTrack\|setClipVolume\|exportDraft" server.js
# Should have 3+ hits in VectCutClient class

# Music tracks available
ls assets/audio/*.mp3 assets/audio/*.wav 2>/dev/null | wc -l
# Should be ≥1
```

If ANY of these fail, the dependency chain isn't ready. Stop and ask Rob.

---

## Context — what's wrong with the current voiceover

### Current code at `server.js:4109-4164`

```javascript
// ── NBA Voiceover Step ────────────────────────────────────────
// For NBA compilations: mix avatar audio OVER the source clip video
// Avatar talks while the highlight plays — classic voiceover style
// This replaces the clip's audio with the avatar's commentary
if (contentType === 'nba' && tsFiles.length > 0) {
  log(asmId, `  🎙 NBA voiceover mode — mixing avatar audio over highlight clips...`);
  const voiceoverFiles = [...tsFiles];

  for (let i = 0; i < tsFiles.length - 1; i++) {
    const currType = segTypes[i]   || 'avatar';
    const nextType = segTypes[i+1] || 'avatar';

    // When we find an avatar segment followed immediately by a source_clip:
    // Mix the avatar's audio track over the clip's video track
    if (currType === 'avatar' && nextType === 'source_clip') {
      const avatarTs = tsFiles[i];
      const clipTs   = tsFiles[i+1];
      const mixedTs  = clipTs.replace('.ts', '_voiced.ts');

      try {
        await new Promise((res, rej) => {
          // Take video from clip, audio from avatar, match duration to clip
          const args = [
            '-i', clipTs,      // input 0: clip video + audio
            '-i', avatarTs,    // input 1: avatar audio
            '-filter_complex',
            '[0:v]copy[vout];[1:a]apad[aout]',
            '-map', '[vout]', '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2',
            '-shortest',       // stop when clip ends
            '-bsf:v', 'h264_mp4toannexb',
            '-f', 'mpegts', '-y', mixedTs
          ];
          // ... exec ...
        });
      } catch(e) {
        log(asmId, `  ⚠️  Voiceover mix failed for clip ${i+1}: ${e.message} — using original`);
      }
    }
  }
  // ... rebuild tsFiles without nulls ...
}
```

### Problems

1. **`-shortest` truncates the clip to narration length.** If NARRATION is 15 seconds and clip is 25 seconds, viewer sees only the first 15 seconds of the clip. The remaining 10 seconds of game action is dropped on the floor.
2. **No background music.** The avatar audio is the entire audio track. When Bobby G stops talking mid-clip, viewer gets dead silence over continuing video.
3. **No volume control.** Clip audio is silently dropped by not being mapped. There's no way to duck it to 10% or mix it with narration at different levels.
4. **No three-track mixing.** Can't add sound effects, stingers, or other audio elements without rewriting the filter graph.
5. **Filter graph is brittle.** Adding a third input or modifying timing requires rebuilding the entire `filter_complex` expression. VectCutAPI's track-based model is cleaner for per-track operations.

---

## What to build

Replace the entire `if (contentType === 'nba' && tsFiles.length > 0)` block at `server.js:4109-4164` with a new function that orchestrates the VectCutAPI-based voiceover per game. Keep the replacement bounded to the same branch — nothing outside NBA should notice.

### New function — `orchestrateNBAVoiceoverVectCut()`

Place near `VectCutClient` class at `server.js:441` or as a standalone helper function. The function processes one `avatar → source_clip` pair at a time and produces a `.ts` file containing the clip with mixed audio.

**Signature:**
```javascript
/**
 * Orchestrate NBA voiceover for a single avatar → source_clip pair using VectCutAPI.
 * Mutes the clip's native audio, adds Bobby G's narration at full volume,
 * adds a background music track at reduced volume. Exports to .ts for concat.
 *
 * @param {string} avatarTsPath - path to the avatar TS file (Bobby G's rendered NARRATION audio)
 * @param {string} clipTsPath - path to the source clip TS file (ESPN highlight video)
 * @param {string} outputTsPath - where to write the mixed output
 * @param {object} options
 * @param {number} options.musicVolume - 0.0 silent to 1.0 full, default 0.20 for background bed
 * @param {number} options.narrationVolume - 0.0 to 1.0, default 1.0 full
 * @param {string} options.musicTrackPath - absolute path to the .mp3/.wav music track
 * @returns {Promise<string>} - path to the output TS file on success
 * @throws on any VectCutAPI failure — caller should catch and fall back to original clip
 */
async function orchestrateNBAVoiceoverVectCut(avatarTsPath, clipTsPath, outputTsPath, options = {}) {
  const {
    musicVolume = 0.20,
    narrationVolume = 1.0,
    musicTrackPath
  } = options;

  if (!musicTrackPath || !fs.existsSync(musicTrackPath)) {
    throw new Error(`Music track not found: ${musicTrackPath}`);
  }

  // Step 1: extract avatar audio from the avatar TS file to a temp WAV/MP3
  // (VectCutAPI needs a standalone audio file, not a mixed TS)
  const tmpAvatarAudio = avatarTsPath.replace('.ts', '_narration.m4a');
  await new Promise((res, rej) => {
    const args = [
      '-i', avatarTsPath,
      '-vn',                    // no video
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y', tmpAvatarAudio
    ];
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024 });
    proc.on('close', code => code === 0 ? res() : rej(new Error(`Audio extract failed: ${code}`)));
    proc.on('error', rej);
  });

  // Step 2: init a CapCut draft for this game
  const draftInit = await axios.post(`${CAPCUT_URL}/capcut/init`, {
    format: 'landscape',
    width: 1920,
    height: 1080
  }, { timeout: 15000 });
  const draftId = draftInit.data.draft_id;

  try {
    // Step 3: add the clip video segment
    await axios.post(`${CAPCUT_URL}/capcut/add-segment`, {
      draft_id: draftId,
      video_path: clipTsPath,
      start: 0
    }, { timeout: 15000 });

    // Step 4: mute the clip's native audio
    await vectCutClient.setClipVolume(draftId, 0.0);

    // Step 5: add the narration audio track at full volume
    await vectCutClient.addAudioTrack(draftId, tmpAvatarAudio, {
      targetStart: 0,
      volume: narrationVolume,
      trackName: 'narration'
    });

    // Step 6: add the background music track at reduced volume
    await vectCutClient.addAudioTrack(draftId, musicTrackPath, {
      targetStart: 0,
      volume: musicVolume,
      trackName: 'music_bed'
    });

    // Step 7: export the draft as MP4 first (VectCut exports MP4)
    const tmpMp4 = outputTsPath.replace('.ts', '_mixed.mp4');
    await vectCutClient.exportDraft(draftId, tmpMp4, {
      width: 1920,
      height: 1080,
      fps: 30
    });

    // Step 8: convert MP4 to TS for concat compatibility
    await new Promise((res, rej) => {
      const args = [
        '-i', tmpMp4,
        '-c', 'copy',
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'mpegts', '-y', outputTsPath
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024 });
      proc.on('close', code => code === 0 ? res() : rej(new Error(`MP4→TS conversion failed: ${code}`)));
      proc.on('error', rej);
    });

    // Cleanup temp files
    try { fs.unlinkSync(tmpAvatarAudio); } catch(e) {}
    try { fs.unlinkSync(tmpMp4); } catch(e) {}

    return outputTsPath;
  } catch (e) {
    // If anything fails mid-flow, log and bubble up the error
    console.error(`[nba-voiceover-vectcut] Draft ${draftId} failed: ${e.message}`);
    try { fs.unlinkSync(tmpAvatarAudio); } catch(e) {}
    throw e;
  }
}
```

### Music track selection helper

Pick a music track from `assets/audio/` per episode. Simple random selection initially; track rotation logic can evolve later.

```javascript
/**
 * Pick a background music track for an NBA episode.
 * Initially random selection. Future: episode-based rotation, track metadata, etc.
 *
 * @returns {string|null} - absolute path to a music track, or null if no tracks available
 */
function pickNBAMusicTrack() {
  const audioDir = path.join(__dirname, 'assets', 'audio', 'nba');
  if (!fs.existsSync(audioDir)) {
    console.warn(`[nba-music] Directory not found: ${audioDir}`);
    return null;
  }

  const tracks = fs.readdirSync(audioDir)
    .filter(f => /\.(mp3|wav|m4a|flac|ogg)$/i.test(f))
    .map(f => path.join(audioDir, f));

  if (tracks.length === 0) {
    console.warn(`[nba-music] No audio tracks found in ${audioDir}`);
    return null;
  }

  const pick = tracks[Math.floor(Math.random() * tracks.length)];
  console.log(`[nba-music] Selected track (${tracks.length} available): ${path.basename(pick)}`);
  return pick;
}
```

### Replace the existing voiceover branch at `server.js:4109-4164`

**From (the existing 55 lines of filter_complex voiceover):**
```javascript
if (contentType === 'nba' && tsFiles.length > 0) {
  log(asmId, `  🎙 NBA voiceover mode — mixing avatar audio over highlight clips...`);
  const voiceoverFiles = [...tsFiles];

  for (let i = 0; i < tsFiles.length - 1; i++) {
    // ... existing FFmpeg filter_complex logic ...
  }

  // Rebuild tsFiles without nulls (dropped avatar segments after voiceover)
  const voicedFiles = voiceoverFiles.filter(f => f !== null);
  const voicedTypes = segTypes.filter((_, i) => voiceoverFiles[i] !== null);
  tsFiles.length = 0; voicedFiles.forEach(f => tsFiles.push(f));
  segTypes.length = 0; voicedTypes.forEach(t => segTypes.push(t));
  log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after mixing`);
}
```

**To:**
```javascript
if (contentType === 'nba' && tsFiles.length > 0) {
  log(asmId, `  🎙 NBA voiceover mode — VectCutAPI audio pipeline (narration + music bed)`);

  // Pick a music track for this episode (same track used across all games in the episode for consistency)
  const musicTrackPath = pickNBAMusicTrack();
  if (!musicTrackPath) {
    log(asmId, `  ⚠️  No NBA music tracks in assets/audio/ — falling back to narration-only voiceover`);
    // Continue without music; narration-only mix will still work via VectCutAPI
  }

  const voiceoverFiles = [...tsFiles];

  for (let i = 0; i < tsFiles.length - 1; i++) {
    const currType = segTypes[i]   || 'avatar';
    const nextType = segTypes[i+1] || 'avatar';

    if (currType === 'avatar' && nextType === 'source_clip') {
      const avatarTs = tsFiles[i];
      const clipTs   = tsFiles[i+1];
      const mixedTs  = clipTs.replace('.ts', '_voiced.ts');

      try {
        await orchestrateNBAVoiceoverVectCut(avatarTs, clipTs, mixedTs, {
          musicTrackPath: musicTrackPath,  // may be null — handle gracefully inside
          musicVolume: 0.20,               // background bed at 20%
          narrationVolume: 1.0             // narration full volume
        });
        voiceoverFiles[i]   = null;        // drop avatar segment (audio used, video not needed)
        voiceoverFiles[i+1] = mixedTs;     // replace clip with voiced version
        log(asmId, `  🎙 Voiced clip ${i+1}→${i+2}: ${path.basename(mixedTs)} (narration + music bed)`);
      } catch(e) {
        log(asmId, `  ⚠️  VectCut voiceover failed for clip ${i+1}: ${e.message} — using original clip`);
        // Leave voiceoverFiles[i] and voiceoverFiles[i+1] untouched → original clip + original avatar
      }
    }
  }

  // Rebuild tsFiles without nulls
  const voicedFiles = voiceoverFiles.filter(f => f !== null);
  const voicedTypes = segTypes.filter((_, i) => voiceoverFiles[i] !== null);
  tsFiles.length = 0; voicedFiles.forEach(f => tsFiles.push(f));
  segTypes.length = 0; voicedTypes.forEach(t => segTypes.push(t));
  log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after VectCut mixing`);
}
```

### Handle the null music track case inside `orchestrateNBAVoiceoverVectCut()`

If `musicTrackPath` is null/missing, SKIP the music bed add step but still do narration-over-muted-clip:

```javascript
// Step 6: add the background music track (if available)
if (musicTrackPath && fs.existsSync(musicTrackPath)) {
  await vectCutClient.addAudioTrack(draftId, musicTrackPath, {
    targetStart: 0,
    volume: musicVolume,
    trackName: 'music_bed'
  });
} else {
  // No music — narration-only mix, silent background over muted clip
  console.log(`[nba-voiceover-vectcut] No music track, narration-only mix`);
}
```

This means the pipeline works even if Rob hasn't dropped music tracks yet. The video will have silent dead-air under Bobby G's voice instead of background music, but it'll still produce a valid MP4 instead of failing.

---

## Error handling + fallback

**If VectCutAPI fails mid-mix for a specific game**, the catch block in the main loop logs the error and SKIPS the voiceover for that game. The clip remains in its original form with its original audio — same behavior as the current code's fallback when FFmpeg filter_complex fails.

**If VectCutAPI is entirely unreachable** (server down, port 9001 not responding), the first call to `axios.post(${CAPCUT_URL}/capcut/init)` throws. Every voiceover attempt in the loop fails, every game falls back to original clip, and the NBA episode still assembles — just without any voiceover.

**If `pickNBAMusicTrack()` returns null** (no tracks in `assets/audio/`), the voiceover still runs but without music. Narration plays over muted clip, dead silence where music would have been.

**All three failure modes are non-fatal.** NBA assembly completes; the worst case is a degraded output, not a broken run.

---

## Testing requirements

### Pre-commit smoke test

Before committing, you must verify end-to-end with a real NBA run. Process:

1. **Verify VectCutAPI server is up:**
   ```bash
   curl http://localhost:9001/health
   ```
2. **Verify music tracks exist:**
   ```bash
   ls assets/audio/*.mp3 assets/audio/*.wav 2>/dev/null
   ```
3. **Run a 2-game NBA smoke test** via the dashboard (or call the `/generate-full-script` endpoint directly with a 2-game payload).
4. **Watch the assembly log for:**
   - `🎙 NBA voiceover mode — VectCutAPI audio pipeline`
   - `[nba-music] Selected track (N available): <filename>`
   - `[VectCut] setClipVolume draft=... vol=0`
   - `[VectCut] addAudioTrack draft=... track=narration`
   - `[VectCut] addAudioTrack draft=... track=music_bed`
   - `[VectCut] exportDraft ... → ...`
   - `🎙 Voiced clip N→N+1: ... (narration + music bed)`
   - `✅ NBA voiceover complete — N segments after VectCut mixing`
5. **Open the final assembled MP4** and play each game segment. Verify:
   - Bobby G's narration plays cleanly over the clip
   - The clip's native audio is MUTED (no ESPN commentators audible underneath)
   - Background music is audible but quiet (sitting under the narration, not competing)
   - The clip plays for its FULL duration — not truncated to narration length
   - Transitions between voiced clips and subsequent avatar segments are smooth

### Syntax + restart checks

```bash
node -c server.js  # exit 0
# Nodemon auto-restarts; watch for clean boot
# VectCutAPI server should still be running (not touched by this handoff)
```

---

## Commit strategy

```
feat(nba): rebuild voiceover using VectCutAPI draft-based audio pipeline (Wave 3 Gap #26)

Replaces the existing FFmpeg filter_complex voiceover at server.js:4109-4164
with a VectCutAPI-based audio pipeline that properly supports multi-track
mixing with per-track volume control. Uses VectCutClient.setClipVolume(),
addAudioTrack(), and exportDraft() methods added in Wave 1
(CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md, Gap #46).

Previous voiceover problems (filter_complex + -shortest):
- Clip truncated to narration length (-shortest flag)
- No background music track (only 2 audio inputs: clip + avatar)
- No volume control (clip audio dropped by not being mapped)
- Brittle filter graph, hard to extend

New voiceover flow per game:
1. Extract avatar audio from avatar TS file to m4a
2. Init CapCut draft, add clip as video segment
3. setClipVolume(0.0) — mute clip native audio
4. addAudioTrack(narration, volume=1.0) — Bobby G full volume
5. addAudioTrack(music_bed, volume=0.20) — background music low volume
6. exportDraft → MP4
7. Convert MP4 to TS for concat compatibility
8. Replace original clip in tsFiles[] with voiced TS

Music tracks loaded from assets/audio/ (Rob drops .mp3/.wav files).
pickNBAMusicTrack() picks randomly per episode. Track rotation + episode
tagging can evolve later.

Fallback behavior:
- No music tracks: narration-only mix, silent background (still works)
- VectCutAPI unreachable: all voiceover calls fail, original clip used (degraded
  but not broken — same as current fallback when FFmpeg fails)
- Partial mix failure: that specific game keeps original clip + original avatar,
  other games still get voiceover

Depends on:
- CLINE_HANDOFF_NBA_PROMPT_REWRITE.md (Wave 1-NBA Gap #21) — NARRATION scene type
- CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md (Wave 2-NBA Gap #23) — clipDuration in prompt
- CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md (Wave 2-NBA Gap #22) — narration sized to clip
- CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md (Wave 1 Gap #46) — VectCutClient methods
- assets/audio/ folder populated by Rob

Changes:
- server.js — new orchestrateNBAVoiceoverVectCut() function (placed near VectCutClient class)
- server.js — new pickNBAMusicTrack() helper
- server.js:4109-4164 — replace FFmpeg filter_complex voiceover block with VectCutAPI loop
- No dashboard changes, no Gemini prompt changes (Wave 2 already tuned word counts)
- No Gate validation changes

Verification:
- 2-game NBA smoke test: voiceover log markers present, final MP4 plays with
  narration + music + muted clip audio + full clip duration
- VectCutAPI health check before commit
- assets/audio/ directory verified populated before commit

References: LONGFORM_FIX_ROTATION.md NBA Wave 3, gap audit Gap #26
```

Per `COMMIT_CHECKLIST.md`:
1. Atomic staging: `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push`
2. STATUS.md Last Agent Action row
3. LONGFORM_FIX_ROTATION.md — move Gap #26 from Dispatched → Shipped

---

## Rollback plan

```bash
git revert HEAD && git push
```

Revert restores the FFmpeg `-shortest` voiceover, which is the known-degraded but functional state NBA was in before this handoff. Not ideal but safe.

**If VectCutAPI integration fails repeatedly** during testing:
- Verify VectCutAPI server health with curl
- Check VectCutAPI Python logs for errors
- Confirm all Wave 1 foundation methods (addAudioTrack, setClipVolume, exportDraft) are working in isolation via their test curl commands from `CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md`
- If any foundation method is broken, fix Wave 1 first; do NOT workaround in Wave 3

**Do NOT fall back to FFmpeg filter_complex as a workaround.** Rob's directive is no shortcuts, no bandaids. If VectCutAPI has a bug, fix VectCutAPI; if the architectural approach is wrong, flag it and stop; do not ship a degraded FFmpeg solution that claims to be the VectCut rebuild.

---

## What this fix does NOT solve

1. **NBA full newscast chrome layer** — Gap #27, parked post-test shared-template rebrand. NBA continues to have only the top-right TV card, no full chrome during game body.
2. **ESPN video selection criterion** — Gap #20 in Wave 0. Longest-duration video from ESPN may still be a press conference or player interview instead of actual game action. Separate quality improvement.
3. **Background music track rotation logic** — `pickNBAMusicTrack()` just picks randomly. Future improvements: avoid repeats within N episodes, match music mood to game stakes, etc. Out of scope here.
4. **Audio ducking between narration and music** — the music plays at a fixed 0.20 volume throughout. A professional mix would duck the music down when Bobby G is talking and up when he's silent. VectCutAPI may or may not support ducking — not in scope here. If Rob wants ducking later, it's a follow-up feature in this same voiceover function.
5. **Normalization across different music tracks** — different source files may have different baseline loudness. For now, manually tune each track to a consistent level before dropping in `assets/audio/`. Loudness normalization is a future feature.

---

## Why this matters (teaching section)

The existing FFmpeg filter_complex voiceover is a textbook case of "a hack that works until it doesn't." It handles the simplest case (mix 2 audio sources with matching lengths) and breaks on every edge: different lengths trigger `-shortest` truncation, adding a third source requires a full rewrite, per-track volume requires a new filter graph, and debugging is painful because filter_complex error messages are cryptic.

VectCutAPI's track-based model solves all of these at the architectural level. Each audio source is a first-class track with its own properties. Adding, removing, or adjusting a track is a single API call. The export step handles the mixing with whatever fidelity the underlying CapCut/Jianying library supports.

**The tradeoff is complexity:** VectCutAPI is a separate process (port 9001) that has to be running, with its own Python venv and dependencies. If VectCutAPI is down, NBA voiceover fails. The current FFmpeg approach has no external dependencies beyond FFmpeg itself.

**Rob's directive is durability over simplicity** — "pick whats best for long term." VectCutAPI is more complex to run but more maintainable long-term because the track model scales to future features (sound effects, audio ducking, per-game music selection, stinger audio on transitions). The filter_complex approach would require a rewrite for each of those features.

**This handoff is the first long-form consumer of VectCutAPI.** Short-form split-screen already uses it for video orchestration. NBA voiceover brings audio mixing into the VectCutAPI layer. Over time, other content types may adopt it too (News image-as-clip with Ken Burns + narration, Twitch multi-clip transitions with music stingers, etc.). The foundation built in Wave 1 (`CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md`) is explicitly designed to be generic — any content type can use it.

---

## Checklist for Cline

- [ ] All dependency handoffs shipped (grep checks in "Dependency chain" section pass)
- [ ] `assets/audio/` directory exists and contains ≥1 music track
- [ ] VectCutAPI server running on port 9001 (`curl http://localhost:9001/health` returns 200)
- [ ] `pickNBAMusicTrack()` helper function added
- [ ] `orchestrateNBAVoiceoverVectCut()` function added
- [ ] Existing FFmpeg voiceover block at `server.js:4109-4164` replaced with VectCutAPI loop
- [ ] Null music track fallback handled inside `orchestrateNBAVoiceoverVectCut()`
- [ ] Per-game failure caught, falls back to original clip + original avatar
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] 2-game NBA smoke test produces a playable MP4 with narration + music + muted clip audio
- [ ] Each game's clip plays for FULL duration (not truncated)
- [ ] Background music is audible but quiet (not competing with narration)
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated (Gap #26 Dispatched → Shipped)
- [ ] Atomic commit via chained `git add && git commit && git push`
