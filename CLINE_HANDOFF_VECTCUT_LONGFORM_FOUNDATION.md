# CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md

**Author:** Claude Code (dispatched 2026-04-12 late evening)
**For:** Cline (implementation)
**Scope:** Extend the existing `VectCutClient` at `server.js:441` and `VectCutAPI/` Python endpoints to support long-form audio mixing workflows. This is Wave 1 foundation — unblocks Gap #26 (NBA voiceover rebuild) in Wave 3. Fixes Gap #46.
**Ship order:** Single atomic commit.
**Do NOT touch:** Short-form `assembleShortForm()` path, CapCut init/add-segment/finalize for split-screen, `/capcut/ticker`, `/capcut/logo`. All existing VectCutClient methods stay working — this handoff ADDS new methods for long-form audio mixing without breaking short-form.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

**Prerequisite check:** VectCutAPI server must be running on port 9001 before testing. Verify with `curl http://localhost:9001/health` or `lsof -iTCP:9001`. If not running, start with `cd VectCutAPI && ./venv-capcut/bin/python3 capcut_server.py` per CLAUDE.md.

---

## Context

The NBA voiceover branch at `server.js:4109-4164` uses FFmpeg `filter_complex` to mix avatar audio over source clip video with `-shortest` flag, which truncates the clip to the narration length. Rob specified tonight that the correct architecture is **CapCut-style draft-based audio mixing** via the VectCutAPI: (a) create a CapCut draft per game, (b) import the clip video with volume set to 0.0, (c) import Bobby G's narration audio, (d) import a background music track, (e) mix all three with proper volume levels, (f) finalize the draft and export MP4.

**This handoff does NOT rebuild the NBA voiceover** — that's Wave 3 via `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md`. This handoff builds the **foundation** in VectCutClient + Python API endpoints that the Wave 3 voiceover rebuild will call.

## Existing VectCutAPI infrastructure (reference)

### Node-side — `server.js:441-531` `VectCutClient` class

Currently supports short-form split-screen assembly via these methods:
- `orchestrateShortForm(jobId, avatarSegments, sourceClips, metadata)` at `~line 445` — orchestrates the split-screen workflow
- `healthCheck()` at `~line 517` — pings `CAPCUT_URL/health`
- Environment: `CAPCUT_URL` from `.env`, defaults to `http://localhost:9001`

Referenced from:
- Short-form assembly path
- `server.js:1191` in the `/health` endpoint's `dependencies.vectcut` field

### Python-side — `VectCutAPI/` directory

Flask server at `VectCutAPI/capcut_server.py`, port 9001. Existing endpoints (per `cat VectCutAPI/ 2>/dev/null` earlier tonight + CLAUDE.md references):
- `POST /capcut/init` — create a new draft, returns `draftId`
- `POST /capcut/add-segment` — add a video segment to draft
- `POST /capcut/ticker` — add ticker text element
- `POST /capcut/logo` — add logo overlay
- `POST /capcut/finalize` — save draft, return draft URL
- `GET /health` — server health check

**Not yet implemented (this handoff adds them):**
- `POST /capcut/add-audio-track` — add an audio track with volume control and timing
- `POST /capcut/set-clip-volume` — mute or adjust volume on a specific clip track
- `POST /capcut/export` — finalize draft AND export to MP4 file (current `finalize` returns draft URL, doesn't do FFmpeg export)

---

## The add_audio_track reference pattern Rob cited

Rob's message tonight referenced an external example from `sun-guannan/VectCutAPI` repository:

```python
from add_audio_track import add_audio_track

# Mute original video track (volume = 0.0)

# Add new audio track
add_audio_track(
    draft_id="your_draft_id",
    audio_url="path/to/new_audio.mp3",
    start=0,           # start time within the audio file (seconds)
    target_start=0,    # insertion position in the draft timeline (seconds)
    volume=1.0         # volume of new audio (0.0-1.0)
)
```

**This is the pattern to replicate.** The new VectCutAPI endpoints in this handoff should expose equivalent functionality.

---

## What to build

### Piece 1 — Python-side: `POST /capcut/add-audio-track` endpoint

**File:** `VectCutAPI/capcut_server.py` (or wherever existing endpoints live — match the existing style)

**Request body:**
```json
{
  "draft_id": "string (required) — existing CapCut draft ID from /capcut/init",
  "audio_path": "string (required) — absolute path to .mp3/.wav/.m4a file OR http(s) URL",
  "target_start": "float (required) — insertion position in draft timeline, seconds",
  "duration": "float (optional) — how long to play the audio, seconds. If omitted, plays the full clip",
  "volume": "float (optional, default 1.0) — 0.0 (silent) to 1.0 (full volume). NBA background music typically 0.15-0.25 to sit under narration",
  "track_name": "string (optional) — friendly label for the track (e.g. 'background_music', 'narration')"
}
```

**Response:**
```json
{
  "ok": true,
  "draft_id": "...",
  "track_id": "...",  // CapCut-internal track identifier
  "message": "Added audio track 'narration' at t=0s for 35.2s at volume 1.0"
}
```

**Error response:**
```json
{
  "ok": false,
  "error": "string",
  "error_code": "DRAFT_NOT_FOUND | AUDIO_NOT_READABLE | INVALID_PARAMS"
}
```

**Implementation notes:**
- If `audio_path` is a URL (`http://` or `https://`), download to a temp file in VectCutAPI's working directory first, then add to the draft. Clean up the temp file after the draft is exported (not after add-audio-track — the draft references the file until export).
- If `audio_path` is a local path, validate the file exists and is a supported audio format (mp3, wav, m4a, flac, ogg) before adding. Return `AUDIO_NOT_READABLE` if validation fails.
- Use whatever underlying CapCut/Jianying SDK is in the VectCutAPI Python venv (likely `pyJianYingDraft` or similar based on the `VectCutAPI/venv-capcut/` venv name). Match the pattern used by existing endpoints in `capcut_server.py`.
- Multiple calls to `/capcut/add-audio-track` on the same draft should stack — i.e., calling it 3 times adds 3 separate audio tracks that all play simultaneously during export. This is how NBA Wave 3 will layer narration + music + (optional) SFX.

### Piece 2 — Python-side: `POST /capcut/set-clip-volume` endpoint

**Request body:**
```json
{
  "draft_id": "string (required)",
  "segment_id": "string (optional) — if set, affects only that segment. If omitted, affects ALL video segments in the draft",
  "volume": "float (required) — 0.0 silent, 1.0 full"
}
```

**Response:** same shape as `/capcut/add-audio-track`.

**Implementation notes:**
- The common use case for NBA voiceover is "mute the ESPN highlight video's native audio so Bobby G's narration plays over it cleanly." This is a one-shot call with `volume: 0.0` and no `segment_id` (applies to all video segments in the draft).
- If CapCut's data model doesn't support per-segment volume overrides, apply the volume globally to all audio tracks that came from video segments (not audio tracks explicitly added via `/capcut/add-audio-track`).

### Piece 3 — Python-side: `POST /capcut/export` endpoint

**Current state:** `/capcut/finalize` saves the draft and returns the draft URL (for manual opening in CapCut GUI). There is no existing endpoint that actually renders/exports the draft to an MP4 file.

**This handoff adds the render step.**

**Request body:**
```json
{
  "draft_id": "string (required)",
  "output_path": "string (required) — absolute path where the exported MP4 should be written",
  "width": "int (optional, default 1920)",
  "height": "int (optional, default 1080)",
  "fps": "int (optional, default 30)",
  "bitrate": "string (optional, default '8M') — video bitrate for the export"
}
```

**Response:**
```json
{
  "ok": true,
  "draft_id": "...",
  "output_path": "/absolute/path/to/output.mp4",
  "duration_seconds": 42.5,
  "file_size_bytes": 123456789
}
```

**Implementation notes:**
- Render via the CapCut SDK's export function. If the SDK doesn't directly produce MP4, fall back to building a FFmpeg command from the draft's segment list (video file paths, audio file paths, timing, volume levels) and running FFmpeg directly. This is the tricky part and may require inspecting how the Jianying/CapCut data model stores segment timing.
- If the CapCut SDK supports a native "export to MP4" method, prefer it. If not, the fallback FFmpeg approach is documented in `sun-guannan/VectCutAPI` or similar open-source CapCut API libraries — Cline should look at the existing `/capcut/finalize` implementation for clues about how segments are stored in memory.
- Block until the export completes — this is a synchronous endpoint. NBA's voiceover rebuild will call it once per game and wait for the resulting MP4 before concatenating into the full episode.
- If export takes >120 seconds, return a 504 timeout with `{ ok: false, error: 'Export timeout' }`.

### Piece 4 — Node-side: `VectCutClient` methods

**File:** `server.js:441-531`

Add three new methods to the `VectCutClient` class:

```javascript
class VectCutClient {
  // ... existing constructor and methods ...

  /**
   * Add an audio track to an existing CapCut draft with volume and timing control.
   * Used for NBA voiceover: narration audio, background music, optional SFX.
   *
   * @param {string} draftId - from POST /capcut/init
   * @param {string} audioPath - absolute path to local audio file OR http(s) URL
   * @param {object} options
   * @param {number} options.targetStart - insertion position in draft timeline (seconds), default 0
   * @param {number} options.duration - how long to play, seconds (omit for full length)
   * @param {number} options.volume - 0.0 silent to 1.0 full, default 1.0
   * @param {string} options.trackName - friendly label
   * @returns {Promise<{ok, draft_id, track_id}>}
   */
  async addAudioTrack(draftId, audioPath, options = {}) {
    const {
      targetStart = 0,
      duration = null,
      volume = 1.0,
      trackName = 'audio'
    } = options;

    const body = {
      draft_id: draftId,
      audio_path: audioPath,
      target_start: targetStart,
      volume,
      track_name: trackName
    };
    if (duration !== null) body.duration = duration;

    try {
      const resp = await axios.post(`${this.baseUrl}/capcut/add-audio-track`, body, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`[VectCut] addAudioTrack draft=${draftId} track=${trackName} vol=${volume} → ${resp.data.track_id || 'ok'}`);
      return resp.data;
    } catch (e) {
      console.error(`[VectCut] addAudioTrack failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Set the volume on video clip audio tracks in a draft.
   * Primary use case: mute clip native audio (volume=0) so added narration plays cleanly over it.
   *
   * @param {string} draftId
   * @param {number} volume - 0.0 silent, 1.0 full
   * @param {string} [segmentId] - optional specific segment, omit for all video segments
   * @returns {Promise<{ok, draft_id}>}
   */
  async setClipVolume(draftId, volume, segmentId = null) {
    const body = { draft_id: draftId, volume };
    if (segmentId) body.segment_id = segmentId;

    try {
      const resp = await axios.post(`${this.baseUrl}/capcut/set-clip-volume`, body, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`[VectCut] setClipVolume draft=${draftId} vol=${volume} segment=${segmentId || 'ALL'}`);
      return resp.data;
    } catch (e) {
      console.error(`[VectCut] setClipVolume failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Finalize the draft and render to MP4.
   * Synchronous — blocks until export completes.
   *
   * @param {string} draftId
   * @param {string} outputPath - absolute path to output MP4
   * @param {object} [options] - {width, height, fps, bitrate}
   * @returns {Promise<{ok, output_path, duration_seconds, file_size_bytes}>}
   */
  async exportDraft(draftId, outputPath, options = {}) {
    const {
      width = 1920,
      height = 1080,
      fps = 30,
      bitrate = '8M'
    } = options;

    const body = {
      draft_id: draftId,
      output_path: outputPath,
      width, height, fps, bitrate
    };

    try {
      console.log(`[VectCut] exportDraft draft=${draftId} → ${outputPath}`);
      const resp = await axios.post(`${this.baseUrl}/capcut/export`, body, {
        timeout: 180000,  // 3 min — exports can be slow
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`[VectCut] exportDraft success: ${resp.data.duration_seconds}s, ${(resp.data.file_size_bytes/1024/1024).toFixed(1)}MB`);
      return resp.data;
    } catch (e) {
      console.error(`[VectCut] exportDraft failed: ${e.message}`);
      throw e;
    }
  }
}
```

**None of these methods are called from anywhere yet.** They're foundation for Wave 3's NBA voiceover rebuild. Wave 3 handoff (`CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md`) will import them and orchestrate the full draft-based flow.

---

## Verification

### Python-side endpoint tests (run after VectCutAPI server restart)

**Test /capcut/add-audio-track:**
```bash
# 1. Create a draft
DRAFT_ID=$(curl -s -X POST http://localhost:9001/capcut/init -H "Content-Type: application/json" -d '{"format":"landscape","width":1920,"height":1080}' | python3 -c "import sys, json; print(json.loads(sys.stdin.read())['draft_id'])")
echo "Draft: $DRAFT_ID"

# 2. Add a test audio track (use any .mp3 you have, or generate one)
curl -X POST http://localhost:9001/capcut/add-audio-track \
  -H "Content-Type: application/json" \
  -d "{\"draft_id\":\"$DRAFT_ID\",\"audio_path\":\"/path/to/test.mp3\",\"target_start\":0,\"volume\":0.5,\"track_name\":\"test\"}"

# Expected: {"ok": true, "draft_id": "...", "track_id": "...", "message": "Added audio track 'test' ..."}
```

**Test /capcut/set-clip-volume:**
```bash
curl -X POST http://localhost:9001/capcut/set-clip-volume \
  -H "Content-Type: application/json" \
  -d "{\"draft_id\":\"$DRAFT_ID\",\"volume\":0.0}"

# Expected: {"ok": true, "draft_id": "..."}
```

**Test /capcut/export (end-to-end):**
```bash
# Add at least one video segment + one audio track first via existing endpoints
curl -X POST http://localhost:9001/capcut/add-segment \
  -H "Content-Type: application/json" \
  -d "{\"draft_id\":\"$DRAFT_ID\",\"video_path\":\"/path/to/test.mp4\",\"start\":0,\"duration\":5}"

curl -X POST http://localhost:9001/capcut/export \
  -H "Content-Type: application/json" \
  -d "{\"draft_id\":\"$DRAFT_ID\",\"output_path\":\"/tmp/vectcut_test_export.mp4\"}"

# Expected: {"ok": true, "output_path": "/tmp/vectcut_test_export.mp4", "duration_seconds": 5.0, "file_size_bytes": ...}
# Verify file exists:
ls -la /tmp/vectcut_test_export.mp4
ffprobe -v error -show_entries format=duration /tmp/vectcut_test_export.mp4
```

### Node-side client tests

```javascript
// Quick inline test (not committed)
const { VectCutClient } = require('./server.js'); // if exported, or inline
const client = new VectCutClient();

(async () => {
  const health = await client.healthCheck();
  console.log('Health:', health);

  // Assuming draftId from a prior /capcut/init
  const result = await client.addAudioTrack('test_draft_id', '/path/to/test.mp3', {
    targetStart: 0,
    volume: 0.5,
    trackName: 'test'
  });
  console.log('Added:', result);
})();
```

### Syntax and startup checks

```bash
node -c server.js
# Exit 0 expected

cd VectCutAPI && ./venv-capcut/bin/python3 -c "import capcut_server"
# No import errors expected
```

---

## Commit strategy

```
feat(vectcut): add audio-track + clip-volume + export endpoints for long-form (Wave 1 foundation)

Extends the existing VectCutClient (server.js:441) and VectCutAPI Python
server (VectCutAPI/capcut_server.py) to support audio mixing workflows
required by NBA voiceover rebuild in Wave 3 (see CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md).

This handoff builds foundation only — no existing content-type behavior
changes. Short-form split-screen path is untouched.

New endpoints (Python):
- POST /capcut/add-audio-track — add narration/music/sfx tracks with volume
- POST /capcut/set-clip-volume — mute video clip native audio (volume 0.0)
- POST /capcut/export — synchronous render of draft to MP4 file

New client methods (Node):
- VectCutClient.addAudioTrack(draftId, audioPath, {targetStart, duration, volume, trackName})
- VectCutClient.setClipVolume(draftId, volume, segmentId?)
- VectCutClient.exportDraft(draftId, outputPath, {width, height, fps, bitrate})

Verification:
- /capcut/add-audio-track tested with test.mp3 → returns track_id
- /capcut/set-clip-volume tested with vol=0 → applies to all segments
- /capcut/export tested with add-segment → produces playable MP4, ffprobe confirms duration

References: CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md (Wave 3 consumer),
gap audit Gap #46, Rob's tonight directive to use VectCutAPI add_audio_track
pattern instead of FFmpeg filter_complex voiceover.
```

Per `COMMIT_CHECKLIST.md`:
1. Atomic staging: `git add server.js VectCutAPI/capcut_server.py STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push`
2. STATUS.md Last Agent Action row
3. LONGFORM_FIX_ROTATION.md — move Gap #46 from Dispatched → Shipped

---

## Rollback plan

If the new endpoints cause VectCutAPI server to fail starting or existing short-form calls to break:

```bash
git revert HEAD && git push
```

Short-form behavior is fully isolated from this change — rollback restores previous working state.

**Python-side risk:** if the CapCut SDK doesn't support one of the required operations (audio track add, volume override, MP4 export), document what's missing in the commit message and SKIP that piece. Partial implementation is OK as long as:
1. All existing endpoints still work
2. The missing endpoint returns a clean error (`{ok: false, error: 'Not implemented', error_code: 'NOT_IMPLEMENTED'}`) instead of crashing
3. The gap is flagged in STATUS.md so Wave 3 knows what to work around

---

## What this fix does NOT solve

1. **NBA voiceover rebuild itself** — that's Wave 3, separate handoff. This handoff just makes the tools available.
2. **Background music tracks** — Rob is providing these separately. Path will be `assets/audio/nba/`. Wave 3 will read from there.
3. **Short-form audio handling** — untouched. Short-form continues using whatever audio flow exists today.
4. **Music track rotation logic** — Wave 3 picks a track per episode (random or sequential). Not in scope here.

---

## Why this matters (teaching section)

The current NBA voiceover at `server.js:4109-4164` uses FFmpeg filter_complex which has two structural problems: (a) `-shortest` flag truncates the clip to narration length when narration is shorter than the clip, and (b) there's no natural place to mix in a background music track without building a 3-input filter graph that gets brittle fast.

The draft-based approach Rob specified (CapCut / VectCutAPI / Jianying internal format) treats audio as first-class track objects that can be independently added, volume-controlled, and timed. This matches how professional NLE (non-linear editing) software works — instead of one big FFmpeg filter_complex, you have a timeline with multiple tracks and each track has its own properties.

Wave 3's NBA voiceover will use these new endpoints roughly like this:
```javascript
// Per NBA game:
const draft = await vectCutClient.initDraft({format: 'landscape'});
await vectCutClient.addSegment(draft.draft_id, espnClipPath, {start: 0});
await vectCutClient.setClipVolume(draft.draft_id, 0.0);  // mute native clip audio
await vectCutClient.addAudioTrack(draft.draft_id, bobbyGNarrationPath, {volume: 1.0, trackName: 'narration'});
await vectCutClient.addAudioTrack(draft.draft_id, musicTrackPath, {volume: 0.2, trackName: 'music_bed'});
const result = await vectCutClient.exportDraft(draft.draft_id, outputMp4Path);
// result.output_path is now a fully-mixed game segment ready for concat into the full episode
```

**This handoff makes that Wave 3 orchestration possible by building the underlying endpoints.** Without this handoff, Wave 3 cannot ship.

---

## Checklist for Cline

- [ ] VectCutAPI server running on port 9001 (verify with curl before starting)
- [ ] Python `/capcut/add-audio-track` endpoint implemented
- [ ] Python `/capcut/set-clip-volume` endpoint implemented
- [ ] Python `/capcut/export` endpoint implemented (synchronous)
- [ ] Node `VectCutClient.addAudioTrack()` method added
- [ ] Node `VectCutClient.setClipVolume()` method added
- [ ] Node `VectCutClient.exportDraft()` method added
- [ ] Python endpoint tests pass via curl (add-audio-track, set-clip-volume, export)
- [ ] End-to-end test: init → add-segment → set-clip-volume 0 → add-audio-track → export → MP4 file exists and plays
- [ ] `node -c server.js` exit 0
- [ ] Python server restarts cleanly, all 3 new endpoints reachable
- [ ] Existing short-form endpoints still work (regression check)
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated
- [ ] Atomic commit via chained `git add && git commit && git push`
