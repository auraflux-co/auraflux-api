# CLINE_HANDOFF_NBA_BACKGROUND_MUSIC.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-16
**Size:** M — `lib/assembly.js`, `lib/config.js`, `lib/script_gen.js`
**Goal:** Add a randomized background music layer to NBA episode assembly. Music plays under all audio (avatar narration + voiced clips) at low volume, loops if needed, and fades out over the last 3 seconds. Also tighten the REACTION scene rule in the NBA script prompt from "EXACTLY 1 sentence" to "1-2 sentences max."

---

## Branch prefix guard

You are Cline-A. Your branch prefix is `cline-a/`. Before your first commit, verify you are on a `cline-a/` branch:

```bash
git branch --show-current
```

If not, create one:

```bash
git checkout -b cline-a/nba-background-music
```

Do NOT commit to `main` directly.

---

## Why this is safe

- NBA long-form only. No code path for Twitch, News, or any short-form content type is touched.
- The music mix is a second FFmpeg pass that runs after `outPath` is written. If the pass fails, log a warning and continue — `outPath` already exists and the pipeline proceeds to Gate 3 unchanged.
- No gate logic changes. Gate 3 sees the music-mixed output, which is correct behavior.
- No new npm dependencies. FFmpeg `amix` filter is built-in.

---

## Files to change

| File | Tier | Edit |
|------|------|------|
| `lib/config.js` | 1 | Add `MUSIC_VOLUME` + `MUSIC_FADE_OUT_SECS` to `CONFIG.NBA` block |
| `lib/assembly.js` | 1 | Add music mix pass after concat step, NBA content type only |
| `lib/script_gen.js` | 1 | Change REACTION scene rule from "EXACTLY 1 sentence" to "1-2 sentences max" |

---

## Step 1 — Update `lib/config.js`

Locate the existing `NBA` block (line ~71):

```javascript
NBA: {
  AD_TRIM_SECONDS: 15  // ESPN pre-roll ad duration to skip at assembly time (not yet wired)
},
```

Replace with:

```javascript
NBA: {
  AD_TRIM_SECONDS: 15,    // ESPN pre-roll ad duration to skip at assembly time (not yet wired)
  MUSIC_VOLUME: 0.15,     // Background music amix weight (0.15 ≈ -16dB under voice)
  MUSIC_FADE_OUT_SECS: 3  // Fade-out duration at end of episode (seconds)
},
```

---

## Step 2 — Add background music pass to `lib/assembly.js`

### Where to insert

Find the NBA voiceover block that ends at approximately line 2262:

```javascript
        log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after mixing`);
      }
```

The music pass goes **after the entire concat/xfade block** — after `outPath` has been written and before the ffprobe validation step (line ~2591). Look for:

```javascript
      // Step 6.5: ffprobe validation — scan for corrupt frames or codec issues
```

Insert the following block **immediately before** that comment:

```javascript
      // ── NBA Background Music Step ──────────────────────────────────────────────
      // Adds a randomized instrumental track under all audio (avatar + voiced clips).
      // Music volume is low (CONFIG.NBA.MUSIC_VOLUME ≈ -16dB) so Bobby G's voice stays primary.
      // Track loops if shorter than episode. Fades out over last CONFIG.NBA.MUSIC_FADE_OUT_SECS seconds.
      // Failure is non-fatal — logs a warning and leaves outPath unchanged.
      if (contentType === 'nba' && fs.existsSync(outPath)) {
        const musicDir = path.join(__dirname, '..', 'assets', 'audio');
        let musicFiles = [];
        try {
          musicFiles = fs.readdirSync(musicDir)
            .filter(f => f.endsWith('.mp3'))
            .map(f => path.join(musicDir, f));
        } catch (e) {
          log(asmId, `  ⚠️  NBA music: could not read assets/audio/ — ${e.message}`);
        }

        if (musicFiles.length > 0) {
          const selectedTrack = musicFiles[Math.floor(Math.random() * musicFiles.length)];
          log(asmId, `  🎵 NBA background music: ${path.basename(selectedTrack)}`);

          const musicOutPath = outPath.replace(/\.mp4$/, '_music.mp4');
          const musicWeight  = CONFIG.NBA.MUSIC_VOLUME;
          const fadeSecs     = CONFIG.NBA.MUSIC_FADE_OUT_SECS;

          // Probe episode duration for the fade-out offset
          let episodeDuration = 0;
          try {
            episodeDuration = await probeDuration(outPath);
          } catch (e) {
            log(asmId, `  ⚠️  NBA music: probeDuration failed — ${e.message}. Fade-out disabled.`);
          }

          const fadeOffset = episodeDuration > fadeSecs ? (episodeDuration - fadeSecs).toFixed(3) : '0';

          // amix filter:
          //   [0:a] = episode audio (weight 1)
          //   [1:a] = music track (weight MUSIC_VOLUME, looped to match video duration, faded at end)
          //   duration=first — music stops when video stream ends
          const amixFilter = episodeDuration > 0
            ? `[1:a]aloop=loop=-1:size=2e+09,afade=t=out:st=${fadeOffset}:d=${fadeSecs}[music];[0:a][music]amix=inputs=2:duration=first:weights=1 ${musicWeight}[aout]`
            : `[1:a]aloop=loop=-1:size=2e+09[music];[0:a][music]amix=inputs=2:duration=first:weights=1 ${musicWeight}[aout]`;

          try {
            await new Promise((res, rej) => {
              const args = [
                '-i', outPath,
                '-i', selectedTrack,
                '-filter_complex', amixFilter,
                '-map', '0:v',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                '-movflags', '+faststart',
                '-y', musicOutPath
              ];
              const ff = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              ff.on('close', code => {
                if (code === 0) {
                  try { fs.unlinkSync(outPath); } catch (e) {}
                  fs.renameSync(musicOutPath, outPath);
                  log(asmId, `  ✅ NBA background music mixed (weight ${musicWeight}, fade ${fadeSecs}s)`);
                  res();
                } else {
                  log(asmId, `  ⚠️  NBA music mix failed (code ${code}) — continuing without music`);
                  try { fs.unlinkSync(musicOutPath); } catch (e) {}
                  res();
                }
              });
              ff.on('error', e => {
                log(asmId, `  ⚠️  NBA music mix error: ${e.message} — continuing without music`);
                try { fs.unlinkSync(musicOutPath); } catch (e) {}
                res();
              });
            });
          } catch (musicErr) {
            log(asmId, `  ⚠️  NBA music step threw: ${musicErr.message} — continuing without music`);
          }
        } else {
          log(asmId, `  ℹ️  NBA background music: no MP3s found in assets/audio/ — skipped`);
        }
      }
```

### Key design notes

**Why `aloop=-1`?** The `aloop` filter with `loop=-1` loops the audio stream indefinitely. `amix duration=first` then stops it when the video (input 0) ends. This handles episodes longer than any single track without pre-computing the loop count.

**Why `-c:v copy`?** The video stream is untouched — only the audio stream is reprocessed. This is a fast operation even on large files (no video re-encode).

**Why `size=2e+09` in aloop?** That is the FFmpeg aloop `size` parameter in samples. At 44100 Hz a value of 2×10⁹ is ~12 hours — effectively infinite. It prevents the loop filter from capping the loop duration on long tracks.

**Fade-out logic:** `afade=t=out:st=OFFSET:d=FADE_SECS` tapers the music to silence over the last `MUSIC_FADE_OUT_SECS` seconds. If `probeDuration` fails (returns 0), the fade is skipped and music simply cuts when the video ends — still acceptable.

---

## Step 3 — Update `lib/script_gen.js` REACTION scene rule

Locate line ~1639:

```
- [GAME]_[TEAMS]_REACTION scenes: EXACTLY 1 sentence. Bobby G is back on screen after the clip ends. Deadpan take on the play. Do NOT recap what happened — the narration already covered it. Just the take.
```

Replace with:

```
- [GAME]_[TEAMS]_REACTION scenes: 1-2 sentences max. Deadpan take on the play. Do NOT recap what happened — the narration already covered it. Just the take.
```

Also update the inline scene template at line ~1657:

```
[EXACTLY 1 sentence. Bobby G back on screen after the clip ends. Deadpan take on the play — what it means, what it tells us about the team, the season, the moment. Do NOT recap the play — NARRATION already called it. Just the take.]
```

Replace with:

```
[1-2 sentences max. Bobby G back on screen after the clip ends. Deadpan take on the play — what it means, what it tells us about the team, the season, the moment. Do NOT recap the play — NARRATION already called it. Just the take.]
```

---

## Blast radius check

| Content type / form | Affected? | Reason |
|---|---|---|
| NBA long-form | YES — intended | Music pass runs for `contentType === 'nba'` only |
| Twitch long-form | No | Content type guard prevents entry |
| News long-form | No | Content type guard prevents entry |
| NBA short-form | No | `isShortContent` check in assembly; NBA shorts use a separate short-form path that does not reach the concat-then-music step |
| Twitch short-form | No | Different content type |
| News short-form | No | Different content type |
| Gate 1 (script QA) | No | No changes to QA scoring logic |
| Gate 2 (HeyGen QA) | No | Music is added post-assembly, after Gate 2 |
| Gate 3 (assembly QA) | Minimal — expected | Gemini sees the music-mixed video, which is the intended output. Music at -16dB is inaudible to QA scoring; no freeze or pacing impact. |
| Gate 4 (publish) | No | No changes to publish logic |

---

## Testing checklist

1. Start a test NBA assembly (can be a 2-game short run).
2. Confirm log line: `🎵 NBA background music: ES_XXXX.mp3`
3. Confirm log line: `✅ NBA background music mixed (weight 0.15, fade 3s)`
4. Play the final MP4 — music should be audible but clearly behind Bobby G's voice.
5. Seek to the last 3 seconds — music should fade to silence; video audio continues normally.
6. Confirm a Twitch assembly produces no music-related log lines.
7. If `assets/audio/` is temporarily empty, confirm log line: `ℹ️  NBA background music: no MP3s found in assets/audio/ — skipped` and assembly completes normally.

---

## Commit message

```
feat(nba): background music layer — randomized instrumental mixed under all audio

Adds a second FFmpeg pass after NBA concat that:
- Picks a random MP3 from assets/audio/ (10 instrumental tracks)
- Loops the track to cover full episode duration via aloop=-1
- Mixes at weight 0.15 (≈ -16dB) so Bobby G's voice stays primary
- Fades music out over last 3s (CONFIG.NBA.MUSIC_FADE_OUT_SECS)
- Non-fatal — warns and continues if music pass fails

CONFIG.NBA gains MUSIC_VOLUME and MUSIC_FADE_OUT_SECS constants.
lib/script_gen.js: REACTION rule relaxed to 1-2 sentences (was exactly 1).
NBA long-form only — no impact on Twitch, News, or any short-form path.
```

---

## Files touched

- `lib/config.js` — add `MUSIC_VOLUME`, `MUSIC_FADE_OUT_SECS` to `CONFIG.NBA`
- `lib/assembly.js` — insert NBA music pass block before Step 6.5 ffprobe validation
- `lib/script_gen.js` — update REACTION rule at lines ~1639 and ~1657

After committing, run `touch server.js` to force nodemon restart if `server.js` imports any changed lib file.
