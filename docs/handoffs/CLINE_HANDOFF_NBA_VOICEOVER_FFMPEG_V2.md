# CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md

**Author:** Claude Code (dispatched 2026-04-13 very early morning)
**For:** Cline (implementation)
**Scope:** NBA long-form — rebuild the voiceover step at `server.js:4109-4164` using FFmpeg `amix` filter with 3 audio inputs (muted clip video + Bobby G narration at full volume + background music bed at reduced volume) and explicit duration control that covers the full clip length. Replaces the broken `-shortest` flag approach. Fixes Gap #26. **This handoff SUPERSEDES `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md` and `CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md` — both parked tonight after Cline surfaced that VectCutAPI is a CapCut draft builder, not a headless renderer.**
**Ship order:** Single atomic commit. Medium-size change — ~200-300 lines of server.js touched.
**Do NOT touch:** News assembly branch, Twitch assembly branch, short-form code paths, NBA TV card burn at `server.js:3968-4038`, NBA Gemini prompt (Wave 1+2 already shipped in `6801b5d`). This handoff only replaces the voiceover audio mix step inside the NBA assembly flow.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update. Music tracks must be present in `assets/audio/` before this handoff can be verified end-to-end.

**Rob's directive:** *"pick whats best for long term no shortcuts and no bandaids"* — applies. The path chosen here (FFmpeg `amix` done correctly with explicit duration control) is NOT a bandaid — it's the standard professional audio mixing pattern used in every serious FFmpeg-based video pipeline. The previous `-shortest` implementation was the bandaid because it used a duration-truncation hack instead of proper mixing.

---

## Why this handoff supersedes Handoffs 3 and 6

Cline investigated the VectCutAPI path earlier tonight (per `CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md`) and discovered an architectural limitation: the Python VectCutAPI is a **CapCut draft builder**, not a headless renderer. It creates `.zip` CapCut project files that the CapCut GUI app opens and renders manually. There is no API surface for automated MP4 export — the `/capcut/export` endpoint specified in the foundation handoff cannot exist because CapCut's rendering engine has no programmatic access.

**The VectCutAPI path would have required a hybrid workflow** — server builds draft, Rob opens in CapCut GUI, renders manually, drops MP4 in an inbox folder, dashboard picks up the rendered file, assembly concats it. That's a permanent manual render step per NBA game per episode (~5-10 renders per episode) which contradicts your "unlimited scale, whitelisted, reusable across episodes" goal.

**Path Y — FFmpeg `amix` filter done correctly** — avoids the VectCutAPI detour entirely and solves the original problems without any manual render step:

**Problems with the OLD FFmpeg voiceover (the `-shortest` bandaid):**
1. `-shortest` truncates the output when the avatar audio stream ends — clip video gets cut off if it's longer than narration
2. No background music track
3. No volume control (clip native audio silently dropped by not mapping it)
4. 2-input filter graph that's hard to extend

**How Path Y solves all four:**
1. **No `-shortest`.** Use explicit `-t ${clipDuration}` to set the output duration to the clip's length. If narration is shorter, the remaining clip plays with just music bed (narration ends naturally). If narration is longer (shouldn't happen per Wave 2's word count targets, but defensive): truncate narration at clip end, not clip at narration end.
2. **3-input `amix` filter** mixes: (a) clip video with native audio at volume 0 (muted but present for timing), (b) narration audio at volume 1.0, (c) music bed at volume 0.20. Music bed loops if shorter than clip duration via `aloop`.
3. **Per-track volume control** is first-class in `amix`'s `weights` parameter. No more "drop by not mapping" hack.
4. **Extensible** — adding a fourth track (SFX, stinger, ambient) is just another `-i` input and another weight in `amix`. Standard FFmpeg pattern that pros use.

**VectCutAPI stays short-form-only.** This handoff does NOT touch `VectCutClient` or the short-form split-screen orchestration. Short-form continues working exactly as it does today.

---

## Dependency chain

**MUST have shipped before this handoff starts:**

1. **`CLINE_HANDOFF_NBA_PROMPT_REWRITE.md`** (NBA Wave 1, Gap #21) — NARRATION scene rename ✅ already shipped in `6801b5d`
2. **`CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md`** (NBA Wave 2, Gap #23) — clipDuration in GAME DATA ✅ already shipped in `6801b5d`
3. **`CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md`** (NBA Wave 2, Gap #22) — word count matches clip duration ✅ already shipped in `6801b5d`
4. **Rob must have dropped music tracks into `assets/audio/`.** This is a non-code blocker for end-to-end verification. If the directory is empty, you can still ship the code (with `pickNBAMusicTrack()` returning null gracefully), but verification requires at least one track.

**Pre-ship verification commands:**
```bash
# Wave 1+2 NBA shipped
grep -n "NARRATION scenes\|NARRATION word count target" server.js
# Should have hits

# Music tracks check
ls assets/audio/*.mp3 assets/audio/*.wav assets/audio/*.m4a 2>/dev/null
# Optional — may be empty, code handles it gracefully

# Current broken voiceover is still in place
grep -n "shortest\|NBA voiceover mode" server.js
# Should have hits in the existing voiceover branch at ~4109
```

---

## Current broken code to replace

### `server.js:4105-4164` — the existing `-shortest` voiceover branch

This entire block gets replaced by the new implementation below. Read it first for context on the surrounding integration points (`tsFiles`, `segTypes`, `voiceoverFiles`, `execFile`, etc.):

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
          const args = [
            '-i', clipTs,      // input 0: clip video + audio
            '-i', avatarTs,    // input 1: avatar audio
            '-filter_complex',
            '[0:v]copy[vout];[1:a]apad[aout]',
            '-map', '[vout]', '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2',
            '-shortest',       // ← THE PROBLEM — truncates to shorter stream
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

  // Rebuild tsFiles without nulls
  const voicedFiles = voiceoverFiles.filter(f => f !== null);
  const voicedTypes = segTypes.filter((_, i) => voiceoverFiles[i] !== null);
  tsFiles.length = 0; voicedFiles.forEach(f => tsFiles.push(f));
  segTypes.length = 0; voicedTypes.forEach(t => segTypes.push(t));
  log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after mixing`);
}
```

**Replace the entire `if (contentType === 'nba' && tsFiles.length > 0) { ... }` block** with the new implementation below.

---

## New implementation — FFmpeg 3-track `amix` voiceover

### Piece 1 — Helper function: `pickNBAMusicTrack()`

Add near other helper functions (e.g., near `downloadFile` at `server.js:~1470` or near `captureTicker` at `server.js:~5180` — wherever content-type-specific asset helpers live):

```javascript
/**
 * Pick a background music track for an NBA episode.
 * Reads from assets/audio/ — supports .mp3, .wav, .m4a, .flac, .ogg.
 * Initially random selection; future: episode-based rotation, metadata-aware.
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

### Piece 2 — Helper function: `probeDuration()`

If this helper doesn't already exist, add it. (There may already be a `probeDuration` at `server.js:~4096` — grep for it. If present, reuse. If not, add this version.)

```javascript
/**
 * Get duration of a media file in seconds via ffprobe.
 * @param {string} filePath
 * @returns {Promise<number>} duration in seconds
 */
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath];
    execFile(ffprobePath(), args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const dur = parseFloat((stdout || '').trim());
      if (isNaN(dur)) return reject(new Error(`Could not parse duration from: ${stdout}`));
      resolve(dur);
    });
  });
}
```

### Piece 3 — Helper function: `mixNBAVoiceoverFFmpeg()`

This is the core of the fix. Place near other FFmpeg helpers or inline in the assembly function — wherever makes the code read most naturally. Probably near the existing voiceover branch at `server.js:~4100` as a private helper.

```javascript
/**
 * Mix NBA voiceover: clip video + muted clip audio + Bobby G narration + background music bed.
 * Uses FFmpeg amix filter with 3 audio inputs + explicit duration control (no -shortest hack).
 *
 * Output duration = clip video duration. If narration is shorter, silence fills the gap
 * with just music bed continuing. If narration is longer (shouldn't happen per Wave 2 word
 * counts), narration gets truncated at clip end.
 *
 * @param {string} avatarTsPath - path to avatar TS file (Bobby G NARRATION audio extracted from this)
 * @param {string} clipTsPath - path to ESPN highlight TS file (video kept, audio muted)
 * @param {string} outputTsPath - where to write the mixed output
 * @param {object} options
 * @param {string|null} options.musicTrackPath - absolute path to .mp3/.wav music track, or null for no music
 * @param {number} options.musicVolume - 0.0 silent to 1.0 full, default 0.20 for background bed
 * @param {number} options.narrationVolume - 0.0 to 1.0, default 1.0 full
 * @returns {Promise<void>} resolves when mix complete
 */
async function mixNBAVoiceoverFFmpeg(avatarTsPath, clipTsPath, outputTsPath, options = {}) {
  const {
    musicTrackPath = null,
    musicVolume = 0.20,
    narrationVolume = 1.0
  } = options;

  // Step 1: probe clip duration — this is the authoritative output length
  const clipDuration = await probeDuration(clipTsPath);
  if (!clipDuration || clipDuration <= 0) {
    throw new Error(`Invalid clip duration: ${clipDuration}`);
  }
  console.log(`[nba-voiceover] Clip duration: ${clipDuration.toFixed(2)}s`);

  // Step 2: build FFmpeg args — different filter graph depending on whether music exists
  const hasMusic = musicTrackPath && fs.existsSync(musicTrackPath);
  let args;

  if (hasMusic) {
    // 3-input mix: clip video + muted clip audio + narration + music bed
    // Filter graph:
    //   [0:v]        — clip video → output video
    //   [1:a]        — narration audio → trim/pad to clipDuration
    //   [2:a]        — music track → loop + trim to clipDuration
    //   amix with weights=[narrationVolume, musicVolume]
    //
    // Music handling:
    //   aloop=loop=-1:size=2147483647 — loop infinitely
    //   atrim=duration=clipDuration — trim to exact output length
    //
    // Narration handling:
    //   apad — pad with silence if shorter than clipDuration
    //   atrim=duration=clipDuration — trim if longer (defensive)
    args = [
      '-i', clipTsPath,         // input 0: clip video + audio
      '-i', avatarTsPath,       // input 1: narration (avatar TS)
      '-stream_loop', '-1',     // loop music forever (gets trimmed below)
      '-i', musicTrackPath,     // input 2: background music track
      '-filter_complex',
      [
        // Clip video passthrough
        `[0:v]copy[vout]`,
        // Narration: pad with silence if short, trim to clipDuration
        `[1:a]apad,atrim=duration=${clipDuration},asetpts=PTS-STARTPTS[narr]`,
        // Music: loop input (already via stream_loop), trim to clipDuration, resample to match
        `[2:a]atrim=duration=${clipDuration},asetpts=PTS-STARTPTS,aresample=44100[music]`,
        // Mix narration + music with per-track weights
        // weights expects a space-separated string of floats
        `[narr][music]amix=inputs=2:duration=first:weights=${narrationVolume} ${musicVolume}[aout]`
      ].join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'copy',           // clip video stream passed through unchanged
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-t', clipDuration.toFixed(3),  // explicit duration — NO -shortest
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts',
      '-y', outputTsPath
    ];
  } else {
    // 2-input mix: clip video + narration only (no music track available)
    // Narration padded with silence if shorter than clip, clip audio muted
    args = [
      '-i', clipTsPath,
      '-i', avatarTsPath,
      '-filter_complex',
      [
        `[0:v]copy[vout]`,
        `[1:a]apad,atrim=duration=${clipDuration},asetpts=PTS-STARTPTS,volume=${narrationVolume}[aout]`
      ].join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-t', clipDuration.toFixed(3),
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts',
      '-y', outputTsPath
    ];
  }

  // Step 3: run FFmpeg
  await new Promise((resolve, reject) => {
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
    let stderr = '';
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        const reason = stderr.slice(-500).replace(/\n/g, ' ').trim();
        reject(new Error(`FFmpeg exit ${code}: ${reason}`));
      }
    });
    proc.on('error', reject);
  });

  // Step 4: verify output exists and is valid
  if (!fs.existsSync(outputTsPath) || fs.statSync(outputTsPath).size < 10000) {
    throw new Error(`Output file invalid or too small: ${outputTsPath}`);
  }

  const outDuration = await probeDuration(outputTsPath);
  console.log(`[nba-voiceover] Output duration: ${outDuration.toFixed(2)}s (target: ${clipDuration.toFixed(2)}s, narration${hasMusic ? ' + music bed' : ' only'})`);

  // Sanity check — output should be close to clip duration (±0.5s tolerance)
  if (Math.abs(outDuration - clipDuration) > 0.5) {
    console.warn(`[nba-voiceover] ⚠️ Output duration drift: ${outDuration.toFixed(2)}s vs target ${clipDuration.toFixed(2)}s`);
  }
}
```

### Piece 4 — Replace the existing voiceover branch at `server.js:4105-4164`

**Replace the entire `if (contentType === 'nba' && tsFiles.length > 0) { ... }` block with:**

```javascript
// ── NBA Voiceover Step (FFmpeg 3-track amix) ──────────────────
// For NBA compilations: mix Bobby G narration OVER the ESPN highlight clip
// video with a background music bed. Clip's native audio is muted.
// Uses explicit duration control (no -shortest truncation bug).
if (contentType === 'nba' && tsFiles.length > 0) {
  log(asmId, `  🎙 NBA voiceover mode — FFmpeg 3-track amix (narration + music bed + muted clip)`);

  // Pick one music track for the entire episode (consistent across all games)
  const musicTrackPath = pickNBAMusicTrack();
  if (musicTrackPath) {
    log(asmId, `  🎵 Music track: ${path.basename(musicTrackPath)}`);
  } else {
    log(asmId, `  ⚠️  No NBA music tracks in assets/audio/ — narration-only mix`);
  }

  const voiceoverFiles = [...tsFiles];

  for (let i = 0; i < tsFiles.length - 1; i++) {
    const currType = segTypes[i]   || 'avatar';
    const nextType = segTypes[i+1] || 'avatar';

    // Find avatar segment immediately followed by source_clip — that's a NARRATION → clip pair
    if (currType === 'avatar' && nextType === 'source_clip') {
      const avatarTs = tsFiles[i];
      const clipTs   = tsFiles[i+1];
      const mixedTs  = clipTs.replace('.ts', '_voiced.ts');

      try {
        await mixNBAVoiceoverFFmpeg(avatarTs, clipTs, mixedTs, {
          musicTrackPath,
          musicVolume: 0.20,
          narrationVolume: 1.0
        });

        // Replace the clip segment with the voiced version, drop the avatar segment
        // (its audio is now inside the voiced clip, its video is no longer shown)
        voiceoverFiles[i]   = null;    // drop avatar segment — audio used, video not needed
        voiceoverFiles[i+1] = mixedTs; // replace clip with voiced version
        log(asmId, `  🎙 Voiced clip ${i+1}→${i+2}: ${path.basename(mixedTs)}`);
      } catch(e) {
        log(asmId, `  ⚠️  NBA voiceover failed for clip ${i+1}: ${e.message} — using original clip + original avatar segment`);
        // Leave voiceoverFiles[i] and voiceoverFiles[i+1] untouched — original clip plays with native audio,
        // original avatar segment plays separately before it. Not ideal but not broken.
      }
    }
  }

  // Rebuild tsFiles without nulls (dropped avatar segments after voiceover)
  const voicedFiles = voiceoverFiles.filter(f => f !== null);
  const voicedTypes = segTypes.filter((_, i) => voiceoverFiles[i] !== null);
  tsFiles.length = 0; voicedFiles.forEach(f => tsFiles.push(f));
  segTypes.length = 0; voicedTypes.forEach(t => segTypes.push(t));
  log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after FFmpeg amix`);
}
```

---

## Why this implementation is correct (teaching section)

**The core insight:** the old voiceover used `-shortest` as a duration control mechanism, which is backwards. `-shortest` truncates output to the shortest input stream, which punishes the clip (cut short by narration length). The correct approach is `-t ${clipDuration}` which explicitly sets output duration to exactly the clip's length, with narration padded or trimmed to match.

**Why `apad,atrim=duration=X`:**
- `apad` adds infinite silence to the end of the audio stream
- `atrim=duration=X` trims it back to exactly `X` seconds
- Combined: if narration is shorter than X, the gap is filled with silence. If narration is longer, it gets cut at X. Result: narration always exactly matches clip duration.

**Why `-stream_loop -1` for music:**
- Music tracks may be shorter than the clip (typical music track = 2-3 minutes, clip = 20-45 seconds, so music usually fits — but defensive programming)
- `-stream_loop -1` tells FFmpeg to loop the input infinitely on the decoder side
- `atrim=duration=X` in the filter graph then trims the infinite loop to the exact needed length
- No visible seam in the music because it loops at the source's natural end point, not a hard cut

**Why `amix=inputs=2:duration=first:weights=X Y`:**
- `amix` is the standard FFmpeg audio mixing filter
- `inputs=2` tells it we're mixing 2 audio streams (narration + music, the clip's audio isn't mapped into this mix at all)
- `duration=first` tells it to match the first input's duration (which we've already trimmed to clipDuration, so this is implicit)
- `weights=X Y` is the per-input volume in space-separated form. `1.0 0.20` = narration at full, music at 20%
- Result: professional 2-track audio mix with per-track volume, matching standard NLE behavior

**Why the clip's native audio is not mapped:**
- By not mapping `[0:a]` (the clip's audio stream) anywhere in the filter graph, it's silently dropped — the equivalent of setting its volume to 0
- No need for a separate mute step
- The clip's video stream `[0:v]` is still mapped via `[vout]`

**Why `-c:v copy` for video:**
- The clip video stream is passed through unchanged — no re-encoding
- Faster, lossless, preserves whatever encoding ESPN returned
- Only the audio streams get re-encoded to AAC for mixing

**Why `-bsf:v h264_mp4toannexb` and `-f mpegts`:**
- Output is `.ts` (MPEG Transport Stream) because the concat demuxer downstream uses `.ts` files
- `h264_mp4toannexb` bitstream filter is required when copying h264 video streams into a TS container
- Matches the existing TS file conventions in the assembly pipeline

**Why the 3-input `amix` graph isn't brittle:**
- It's the standard FFmpeg audio mixing pattern used across thousands of production video pipelines
- Every edge case (narration too short, narration too long, music too short, music too long) is handled by explicit filters (`apad`, `atrim`, `stream_loop`)
- Adding a fourth input (SFX, stinger) is a copy-paste of the music pattern with a new `[3:a]` input
- The per-track volume weights in `amix` scale to any number of inputs

**This is the durable solution.** Not a bandaid. Ships without VectCutAPI dependency, without manual render steps, without external API keys. Pure FFmpeg, standard filters, documented patterns.

---

## Verification

### Pre-commit smoke tests

**Test 1 — Function in isolation (optional but recommended)**

Create a test script to verify `mixNBAVoiceoverFFmpeg()` works against synthetic inputs:

```bash
# Generate a 30-second silent test clip video
ffmpeg -f lavfi -i "color=c=red:s=1920x1080:d=30" -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx264 -c:a aac -bsf:v h264_mp4toannexb -f mpegts -y /tmp/test_clip.ts

# Generate a 10-second "narration" audio TS (shorter than clip — tests silence padding)
ffmpeg -f lavfi -i "color=c=blue:s=1920x1080:d=10" -f lavfi -i "sine=frequency=880:duration=10" \
  -c:v libx264 -c:a aac -bsf:v h264_mp4toannexb -f mpegts -y /tmp/test_avatar.ts

# Call the helper (requires exposing it from server.js or inline Node test)
# Expected output: /tmp/test_mixed.ts with duration ~30s (not 10s)
```

Then probe the output duration:
```bash
ffprobe -v error -show_entries format=duration /tmp/test_mixed.ts
# Expected: 30.0 (matches clip, NOT 10 from narration)
```

If the output is 30 seconds, the `-shortest` bug is fixed.

**Test 2 — Full NBA smoke test (required)**

After committing and nodemon restart, run a 2-game NBA long-form test via the dashboard. Watch the assembly log for:

- `🎙 NBA voiceover mode — FFmpeg 3-track amix (narration + music bed + muted clip)`
- `🎵 Music track: ${filename}` (or `⚠️ No NBA music tracks` if directory empty)
- `[nba-voiceover] Clip duration: Xs` (one per game)
- `[nba-voiceover] Output duration: Xs (target: Xs, narration + music bed)`
- `🎙 Voiced clip N→N+1: ...` (one per game)
- `✅ NBA voiceover complete — N segments after FFmpeg amix`

Open the final assembled MP4 and play each game segment. Verify:

1. **Bobby G's narration plays cleanly over the clip** — audible, not clipped
2. **Clip's native audio is MUTED** — no ESPN commentators audible underneath
3. **Background music is audible but quiet** — sits under narration, doesn't compete
4. **Clip plays for its FULL duration** — not truncated to narration length. If the clip is 25 seconds and narration is 18 seconds, you should hear narration for 18s then music-only for the final 7s, for a total of 25s of clip video.
5. **Transitions between voiced clips and subsequent avatar segments are smooth** — no audio glitches at boundaries

### Grep checks

```bash
# Old -shortest voiceover code removed
grep -n "shortest" server.js | grep -i nba
# Should return 0 hits (may still have -shortest in other content types, that's fine)

# New helper functions present
grep -n "mixNBAVoiceoverFFmpeg\|pickNBAMusicTrack" server.js
# Should return 2+ hits (definitions + callers)

# amix filter used
grep -n "amix=inputs=2" server.js
# Should have a hit in the new helper
```

### Syntax + startup checks

```bash
node -c server.js   # exit 0
# Nodemon auto-restarts, watch for clean boot
```

---

## Commit strategy

```
fix(nba): rebuild voiceover with FFmpeg 3-track amix + explicit duration control (Gap #26)

Replaces the broken -shortest voiceover at server.js:4109-4164 with a
proper FFmpeg amix-based implementation. Supersedes the parked VectCutAPI
approach (CapCut is a draft builder, not a headless renderer — cannot
automate MP4 export without manual CapCut GUI render step).

Path Y per Rob's architectural decision: FFmpeg done correctly is not
a bandaid when implemented with proper duration control (no -shortest),
proper per-track volume (amix weights), and background music bed support.

New helpers:
- pickNBAMusicTrack() — reads assets/audio/*.mp3/.wav/.m4a/.flac/.ogg,
  picks one per episode (random initially, rotation logic later)
- mixNBAVoiceoverFFmpeg(avatarTs, clipTs, outputTs, options) — 3-input
  FFmpeg amix:
    [0:v] clip video → [vout]
    [1:a] narration → apad + atrim(clipDuration) → weight 1.0
    [2:a] music → stream_loop + atrim(clipDuration) → weight 0.20
    amix=inputs=2:duration=first:weights=1.0 0.20 → [aout]
  Output duration = clip duration (explicit -t, no -shortest).
  Clip's native audio NOT mapped → dropped (muted).

Assembly branch replacement (server.js:4105-4164):
- Per avatar→source_clip pair, call mixNBAVoiceoverFFmpeg()
- On success: drop avatar segment, replace clip with voiced version
- On failure: leave both segments untouched (degraded fallback, still runs)
- Consistent music track across all games in the episode

Fallback behavior:
- No music tracks in assets/audio/: narration-only 2-input mix,
  silent background over muted clip (still works)
- probeDuration fails on clip: throw, caller catches, per-game fallback
- FFmpeg error: caught, logged, per-game fallback

Does NOT touch VectCutClient or short-form split-screen code paths.

Depends on:
- CLINE_HANDOFF_NBA_PROMPT_REWRITE.md (Wave 1-NBA) ✅ shipped in 6801b5d
- CLINE_HANDOFF_NBA_PROMPT_CLIP_DURATION.md (Wave 2-NBA) ✅ shipped in 6801b5d
- CLINE_HANDOFF_NBA_NARRATION_WORD_COUNT.md (Wave 2-NBA) ✅ shipped in 6801b5d
- assets/audio/ music tracks (optional — handles null gracefully)

Verification:
- node -c server.js exit 0
- Synthetic test with 30s clip + 10s narration: output duration 30s
  (previously would be 10s due to -shortest bug)
- 2-game NBA smoke test: voiceover markers present, final MP4 plays
  with full clip duration + narration + music bed + muted native clip audio

Supersedes:
- CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md (VectCutAPI can't render)
- CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md (depends on the above)

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

Restores the old `-shortest` FFmpeg voiceover which is known-degraded but functional. Not ideal but safe.

**If the FFmpeg 3-track amix fails during testing:**
- Check FFmpeg version — `amix`, `apad`, `atrim`, `stream_loop` all require FFmpeg 4+. Per cursor.md, the installed FFmpeg is v8.1 so this should be fine.
- Check the filter graph syntax — common mistakes: missing semicolons between filter chains, wrong pad labels, mismatched input counts
- Test the FFmpeg command directly in terminal before iterating code:
  ```bash
  ffmpeg -i test_clip.ts -i test_avatar.ts -stream_loop -1 -i test_music.mp3 \
    -filter_complex "[0:v]copy[vout];[1:a]apad,atrim=duration=30,asetpts=PTS-STARTPTS[narr];[2:a]atrim=duration=30,asetpts=PTS-STARTPTS,aresample=44100[music];[narr][music]amix=inputs=2:duration=first:weights=1.0 0.20[aout]" \
    -map "[vout]" -map "[aout]" -c:v copy -c:a aac -b:a 192k -t 30 -bsf:v h264_mp4toannexb -f mpegts -y out.ts
  ```

**Do NOT fall back to the old `-shortest` approach.** If FFmpeg amix has a bug, fix it. Don't regress to the bandaid.

---

## What this fix does NOT solve

1. **NBA full newscast chrome layer** — Gap #27, parked post-test shared-template rebrand. NBA continues to have only the top-right TV card during game intros, no full chrome during game body.
2. **Background music ducking** — the music plays at a fixed 0.20 volume throughout. A pro mix would duck the music when Bobby G talks and un-duck during silence. FFmpeg has a `sidechaincompress` filter that can do this but it adds complexity. Not in scope for this handoff. If needed later, add it as a follow-up in the same helper function.
3. **Loudness normalization across music tracks** — different source files have different baseline loudness. For now, manually tune each track to consistent level before dropping in `assets/audio/`. FFmpeg `loudnorm` filter can normalize but adds render time. Future follow-up.
4. **Music track rotation** — `pickNBAMusicTrack()` picks randomly per episode. Future: track metadata, episode-based rotation, avoid-repeat logic, mood-matching.

---

## Checklist for Cline

- [ ] All Wave 1+2 NBA handoffs shipped (verified via grep check in Dependency chain section)
- [ ] `pickNBAMusicTrack()` helper function added
- [ ] `probeDuration()` helper exists or added
- [ ] `mixNBAVoiceoverFFmpeg()` helper function added with both 2-input (no music) and 3-input (with music) filter graphs
- [ ] Existing `-shortest` voiceover block at `server.js:4105-4164` replaced entirely
- [ ] Grep: 0 hits for `-shortest` in NBA voiceover block (may still exist elsewhere in server.js, that's OK)
- [ ] Grep: `amix=inputs=2` hit in the new helper
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] Synthetic test (optional): 30s clip + 10s narration → output is 30s, not 10s
- [ ] 2-game NBA smoke test: voiceover log markers present, final MP4 plays with full clip duration + narration + music (if tracks present)
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated (Gap #26 Dispatched → Shipped)
- [ ] Atomic commit via chained `git add && git commit && git push`
